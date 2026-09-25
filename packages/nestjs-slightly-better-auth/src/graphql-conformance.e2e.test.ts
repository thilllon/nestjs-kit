import type { OutgoingHttpHeaders } from "node:http";
import { ApolloDriver, ApolloFederationDriver } from "@nestjs/apollo";
import {
  type ExecutionContext,
  Inject,
  type INestApplication,
  type LoggerService,
  Module,
  type Type,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import {
  Args,
  type CustomScalar,
  Directive,
  Field,
  GraphQLModule,
  Mutation,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  ResolveReference,
  Resolver,
  Scalar,
  Subscription,
} from "@nestjs/graphql";
import { MercuriusDriver, MercuriusFederationDriver } from "@nestjs/mercurius";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { type ValueNode, valueFromASTUntyped } from "graphql";
import { type Client, createClient } from "graphql-ws";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type {
  AuthTransport,
  BrowserExposure,
  ExtensionRef,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import { ACCEPT_PRINCIPALS_METADATA, ROUTE_PLANNER } from "./auth-tokens.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { BetterAuthService } from "./auth-service.js";
import {
  runConformance,
  sendRaw,
  setCookieLines,
} from "./conformance-fixtures.js";
import type { PolicyDelivery } from "./conformance-policy-harness.js";
import {
  type FixtureHandler,
  type GraphFixtures,
  type GraphqlContextShape,
  type GraphResult,
  type GraphSelection,
  type InvocationShape,
  type TransportConformanceOptions,
  type TransportFixtures,
  type TransportInvocationResult,
  transportConformance,
} from "./conformance-transport.js";
import { expressPlatform } from "./express.js";
import { RequestScope } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import { fastifyPlatform } from "./fastify.js";
import {
  apolloTransport,
  type GraphqlTransportOptions,
  mercuriusSubscriptionContext,
  mercuriusTransport,
} from "./graphql.js";
import {
  adminPolicyOptions,
  organizationPolicyOptions,
  policyDeliveryCases,
} from "./policy-kit-fixtures.js";

type FixtureName = Exclude<keyof TransportFixtures, "graph">;
type GraphField = keyof GraphFixtures["fields"];
type Driver = "apollo-express" | "apollo-fastify" | "mercurius";

const REPLY_TIMEOUT_MS = 5000;
/** The longest timer delay: close() disposes the client before it elapses. */
const KEEP_OPEN_MS = 2 ** 31 - 1;
/** The kit's named inputs, exposed as nullable String arguments of every fixture field. */
const INPUTS = ["orgId", "email", "password", "cookie"] as const;

/** The type of free-form JSON results: the kit reads handler results as it reads HTTP bodies. */
class KitJson {}

/**
 * The KitJSON scalar. Nest creates it with its own graphql module instance, which a GraphQLScalarType constructed
 * here would not share: test files resolve graphql's ESM entry, Nest resolves its CommonJS main.
 */
@Scalar("KitJSON", () => KitJson)
class KitJsonScalar implements CustomScalar<unknown, unknown> {
  description = "Free-form JSON";

  parseValue(value: unknown): unknown {
    return value;
  }

  serialize(value: unknown): unknown {
    return value;
  }

  parseLiteral(ast: ValueNode): unknown {
    return valueFromASTUntyped(ast);
  }
}

/**
 * The graph fixtures' object type. Nest generates the types of all process-wide object type metadata for each
 * code-first schema and adds every object type that a field references, so two FixtureNode classes would collide in
 * every schema. One class serves all boots: federation boots read its entity key, and the other schemas carry the
 * directive without defining it.
 */
@ObjectType("FixtureNode")
@Directive('@key(fields: "id")')
class FixtureNode {
  @Field(() => String) id!: string;
  @Field(() => KitJson, { nullable: true }) principal?: unknown;
  @Field(() => String, { nullable: true }) plain?: string;
  @Field(() => FixtureNode, { nullable: true }) publicNested?: FixtureNode;
  @Field(() => KitJson, { nullable: true }) reader?: unknown;
  @Field(() => FixtureNode, { nullable: true }) guarded?: FixtureNode;
  @Field(() => KitJson, { nullable: true }) nestedReader?: unknown;
  @Field(() => String, { nullable: true }) sessionReader?: string;
  @Field(() => String, { nullable: true }) forwarding?: string;
  @Field(() => String, { nullable: true }) organizationReader?: string;
  @Field(() => String, { nullable: true }) serviceSession?: string;
}

/** Selection of each FixtureNode field. */
const FIELD_SELECTIONS: Readonly<Record<GraphField, string>> = {
  plain: "plain",
  publicNested: "publicNested { id reader }",
  reader: "reader",
  guarded: "guarded { id principal nestedReader }",
  nestedReader: "nestedReader",
  sessionReader: "sessionReader",
  forwarding: "forwarding",
  organizationReader: "organizationReader",
  serviceSession: "serviceSession",
};
/** Field resolvers returning a String; the others return FixtureNode (nested selections) or KitJSON. */
const STRING_FIELDS: ReadonlySet<GraphField> = new Set([
  "plain",
  "sessionReader",
  "forwarding",
  "organizationReader",
  "serviceSession",
]);

/** Schema names of the graph roots, which share names with non-graph fixtures; invokeGraph aliases them back. */
const GRAPH_ROOTS: Readonly<Record<keyof GraphFixtures["roots"], string>> = {
  public: "graphPublic",
  sessionOnly: "graphSessionOnly",
  mixed: "graphMixed",
  items: "graphItems",
};

/** The subscription field serving the `org` fixture (invokeTwice shape 'subscriptions'). */
const ORG_SUBSCRIPTION = "orgEvents";

function flatten(fixtures: TransportFixtures): Map<string, FixtureHandler> {
  const handlers = new Map<string, FixtureHandler>();
  for (const [name, value] of Object.entries(fixtures)) {
    if (name === "graph") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        handlers.set(`${name}${index}`, item);
      }
    } else {
      handlers.set(name, value as FixtureHandler);
    }
  }
  return handlers;
}

interface Host {
  readonly service: BetterAuthService;
}

/**
 * Defines `name` on `target.prototype` as a resolver method with the fixture's parameter decorators, then `extra`, and
 * the method decorators as if written above the method in the given order. Code-first GraphQL reads parameter and
 * return types from explicit type functions; `design:paramtypes` only has to exist.
 */
function defineHandler(
  target: { prototype: object },
  name: string,
  fixture: FixtureHandler,
  extra: readonly ParameterDecorator[],
  decorators: readonly MethodDecorator[],
  body: (this: Host, args: unknown[]) => unknown,
): void {
  const method = function (this: Host, ...args: unknown[]) {
    return body.call(this, args);
  };
  Object.defineProperty(method, "name", { value: name });
  Object.defineProperty(target.prototype, name, {
    value: method,
    writable: true,
    configurable: true,
  });
  const params = [...fixture.params, ...extra];
  Reflect.defineMetadata(
    "design:paramtypes",
    params.map(() => Object),
    target.prototype,
    name,
  );
  for (const [index, param] of params.entries()) {
    param(target.prototype, name, index);
  }
  const descriptor = Object.getOwnPropertyDescriptor(target.prototype, name)!;
  for (const decorator of [...decorators].reverse()) {
    decorator(target.prototype, name, descriptor);
  }
}

/** The kit's input from the trailing named arguments, without the absent ones. */
function inputOf(values: readonly unknown[]): Record<string, unknown> {
  return Object.fromEntries(
    INPUTS.flatMap((name, index) =>
      values[index] === undefined || values[index] === null
        ? []
        : [[name, values[index]]],
    ),
  );
}

const inputArgs = (): ParameterDecorator[] =>
  INPUTS.map((name) => Args(name, { type: () => String, nullable: true }));

/**
 * One root field per kit fixture, named after it: a query for 'read' handlers, a mutation for 'unsafe' ones, with the
 * kit's inputs as arguments. `subscriptions` also serves the `org` fixture as a subscription field.
 */
function fixtureResolver(
  handlers: Map<string, FixtureHandler>,
  subscriptions: boolean,
) {
  @Resolver()
  class KitResolver {
    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  for (const [name, fixture] of handlers) {
    const count = fixture.params.length;
    const root = fixture.operation === "unsafe" ? Mutation : Query;
    defineHandler(
      KitResolver,
      name,
      fixture,
      inputArgs(),
      [root(() => KitJson, { name, nullable: true }), ...fixture.decorators],
      function (args) {
        return fixture.handle(
          args.slice(0, count),
          inputOf(args.slice(count)),
          {
            service: this.service,
          },
        );
      },
    );
  }
  const org = handlers.get("org");
  if (subscriptions && org) {
    const count = org.params.length;
    defineHandler(
      KitResolver,
      ORG_SUBSCRIPTION,
      org,
      inputArgs(),
      [
        Subscription(() => KitJson, { name: ORG_SUBSCRIPTION, nullable: true }),
        ...org.decorators,
      ],
      async function* (this: Host, args: unknown[]) {
        yield {
          [ORG_SUBSCRIPTION]: await org.handle(
            args.slice(0, count),
            inputOf(args.slice(count)),
            { service: this.service },
          ),
        };
      } as (this: Host, args: unknown[]) => unknown,
    );
  }
  return KitResolver;
}

/** The graph fixtures: three roots returning FixtureNode, its field resolvers and, in federation, its reference resolver. */
function graphResolver(graph: GraphFixtures, federation: boolean) {
  @Resolver(() => FixtureNode)
  class GraphResolver {
    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  const call = (fixture: FixtureHandler) =>
    function (this: Host, args: unknown[]) {
      return fixture.handle(args, {}, { service: this.service });
    };
  for (const [root, fixture] of Object.entries(graph.roots)) {
    if (!fixture) {
      continue;
    }
    const name = GRAPH_ROOTS[root as keyof GraphFixtures["roots"]];
    // The items root returns a list of FixtureNode.
    const type = root === "items" ? () => [FixtureNode] : () => FixtureNode;
    defineHandler(
      GraphResolver,
      name,
      fixture,
      [],
      [Query(type, { name }), ...fixture.decorators],
      call(fixture),
    );
  }
  for (const [field, fixture] of Object.entries(graph.fields)) {
    if (!fixture) {
      continue;
    }
    const type = FIELD_SELECTIONS[field as GraphField].includes("{")
      ? () => FixtureNode
      : STRING_FIELDS.has(field as GraphField)
        ? () => String
        : () => KitJson;
    defineHandler(
      GraphResolver,
      field,
      fixture,
      [],
      [ResolveField(field, type, { nullable: true }), ...fixture.decorators],
      call(fixture),
    );
  }
  for (const decorator of graph.classDecorators ?? []) {
    decorator(GraphResolver);
  }
  const reference = graph.reference;
  if (federation && reference) {
    defineHandler(
      GraphResolver,
      "resolveReference",
      reference,
      [Parent()],
      [ResolveReference(), ...reference.decorators],
      function (this: Host, args: unknown[]) {
        return reference.handle(
          [],
          args[reference.params.length] as Record<string, unknown>,
          { service: this.service },
        );
      },
    );
  }
  return GraphResolver;
}

interface GraphqlError {
  message?: string;
  path?: readonly (string | number)[];
  extensions?: Record<string, unknown>;
}

interface GraphqlResponse {
  data?: Record<string, unknown> | null;
  errors?: readonly GraphqlError[];
}

interface Reply {
  readonly result: GraphqlResponse;
  readonly setCookies: string[];
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function errorOf(error: GraphqlError): TransportInvocationResult["error"] {
  const extensions = error.extensions ?? {};
  return {
    statusCode:
      typeof extensions.statusCode === "number"
        ? extensions.statusCode
        : undefined,
    code: text(extensions.code),
    reason: text(extensions.reason),
    message: text(error.message),
  };
}

/** The outcome of `fields` of one operation result: the first failure, otherwise the first field's value. */
function outcomeOf(
  reply: Reply,
  fields: readonly string[],
): TransportInvocationResult {
  for (const field of fields) {
    const error = reply.result.errors?.find(
      (value) => value.path === undefined || value.path[0] === field,
    );
    if (error) {
      return { ok: false, error: errorOf(error), setCookies: reply.setCookies };
    }
  }
  return {
    ok: true,
    body: reply.result.data?.[fields[0]!],
    setCookies: reply.setCookies,
  };
}

function graphResult(result: GraphqlResponse): GraphResult {
  return {
    data: result.data ?? null,
    errors: (result.errors ?? []).map((error) => ({
      path: error.path ?? [],
      code: text(error.extensions?.code),
      reason: text(error.extensions?.reason),
      message: text(error.message),
    })),
  };
}

interface Operation {
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}

/** The root fields of a fixture: `triple` and `tripleMixed` are three fields, selected together by one operation. */
function fieldsOf(handler: FixtureName): string[] {
  return handler === "triple" || handler === "tripleMixed"
    ? [0, 1, 2].map((index) => `${handler}${index}`)
    : [handler];
}

/** One operation selecting fixture root fields of one operation type, with the kit's inputs as variables. */
function fixtureOperation(
  handlers: Map<string, FixtureHandler>,
  fields: readonly string[],
  input: Record<string, unknown>,
): Operation {
  const kind =
    handlers.get(fields[0]!)?.operation === "unsafe" ? "mutation" : "query";
  const variables = INPUTS.map((name) => `$${name}: String`).join(", ");
  const args = INPUTS.map((name) => `${name}: $${name}`).join(", ");
  return {
    query: `${kind} (${variables}) { ${fields.map((field) => `${field}(${args})`).join(" ")} }`,
    variables: input,
  };
}

function graphOperation(selection: readonly GraphSelection[]): Operation {
  const roots = selection.map(
    ({ root, fields }) =>
      `${root}: ${GRAPH_ROOTS[root]} { id principal ${fields.map((field) => FIELD_SELECTIONS[field]).join(" ")} }`,
  );
  return { query: `query { ${roots.join(" ")} }` };
}

function entitiesOperation(
  representations: readonly Record<string, unknown>[],
  fields: readonly GraphField[],
): Operation {
  return {
    query: `query ($representations: [_Any!]!) { _entities(representations: $representations) { ... on FixtureNode { id ${fields.map((field) => FIELD_SELECTIONS[field]).join(" ")} } } }`,
    variables: { representations },
  };
}

/** A running app: its URL, fixture handlers and graphql-ws connection_init form. */
interface Booted {
  readonly url: string;
  readonly handlers: Map<string, FixtureHandler>;
  readonly omitEmptyConnectionParams: boolean;
}

const apps = new WeakMap<object, Booted>();

/** One HTTP POST of `body` to the GraphQL endpoint, with the kit's headers as given (including Host). */
async function post(
  app: INestApplication,
  body: unknown,
  headers: HeadersInit,
): Promise<{ json: unknown; setCookies: string[] }> {
  const { url } = apps.get(app)!;
  const payload = JSON.stringify(body);
  const response = await sendRaw(`${url}/graphql`, {
    method: "POST",
    headers: {
      ...(Object.fromEntries(new Headers(headers)) as OutgoingHttpHeaders),
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
  });
  const text = response.body.toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`GraphQL HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return { json, setCookies: setCookieLines(response.headers) };
}

async function httpOperation(
  app: INestApplication,
  operation: Operation,
  headers: HeadersInit,
): Promise<Reply> {
  const { json, setCookies } = await post(app, operation, headers);
  return { result: json as GraphqlResponse, setCookies };
}

/** The handshake headers, with a bearer token moved to where browser graphql-ws clients put it: connectionParams. */
function handshake(headers: HeadersInit): {
  headers: Record<string, string>;
  connectionParams: Record<string, string>;
} {
  const values: Record<string, string> = {};
  const connectionParams: Record<string, string> = {};
  for (const [name, value] of new Headers(headers)) {
    if (name === "authorization") {
      connectionParams.authorization = value;
    } else {
      values[name] = value;
    }
  }
  return { headers: values, connectionParams };
}

interface Connection {
  execute(operation: Operation): Promise<GraphqlResponse>;
  close(): Promise<void>;
}

function connect(
  app: INestApplication,
  headers: HeadersInit,
  params?: Readonly<Record<string, string>>,
): Connection {
  const { url, omitEmptyConnectionParams } = apps.get(app)!;
  const { headers: upgrade, connectionParams: moved } = handshake(headers);
  const connectionParams = { ...moved, ...params };
  class HandshakeSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { headers: upgrade });
    }
  }
  const client: Client = createClient({
    url: `${url.replace(/^http/, "ws")}/graphql`,
    webSocketImpl: HandshakeSocket,
    // Without connectionParams, graphql-ws sends connection_init without a payload.
    ...(omitEmptyConnectionParams && Object.keys(connectionParams).length === 0
      ? {}
      : { connectionParams }),
    retryAttempts: 0,
    lazy: true,
    // One socket for every operation of the connection: a lazy client otherwise closes it after each completed one.
    lazyCloseTimeout: KEEP_OPEN_MS,
  });
  let socketOpen = false;
  client.on("opened", () => {
    socketOpen = true;
  });
  client.on("closed", () => {
    socketOpen = false;
  });
  return {
    execute: (operation) =>
      new Promise((resolve, reject) => {
        let result: GraphqlResponse | undefined;
        let dispose = () => {};
        const timer = setTimeout(() => {
          dispose();
          reject(new Error(`graphql-ws: no reply to ${operation.query}`));
        }, REPLY_TIMEOUT_MS);
        dispose = client.subscribe(operation, {
          next(value) {
            result ??= value as GraphqlResponse;
            clearTimeout(timer);
            resolve(result);
            queueMicrotask(() => dispose());
          },
          error(error) {
            clearTimeout(timer);
            if (Array.isArray(error)) {
              resolve({ errors: error as GraphqlError[] });
            } else {
              reject(error);
            }
          },
          complete() {
            clearTimeout(timer);
            if (result) {
              resolve(result);
            } else {
              reject(new Error("graphql-ws: completed without a result"));
            }
          },
        });
      }),
    // The client's close event follows the server's close frame, so the server has observed the close by then.
    async close() {
      if (!socketOpen) {
        await client.dispose();
        return;
      }
      const closed = new Promise<void>((resolve) => {
        const off = client.on("closed", () => {
          off();
          resolve();
        });
      });
      await client.dispose();
      await closed;
    },
  };
}

async function onConnection<T>(
  app: INestApplication,
  headers: HeadersInit,
  run: (connection: Connection) => Promise<T>,
  params?: Readonly<Record<string, string>>,
): Promise<T> {
  const connection = connect(app, headers, params);
  try {
    return await run(connection);
  } finally {
    await connection.close();
  }
}

/** The cookie header of what a GraphQL driver passes a context function: an HTTP request or a graphql-ws context. */
function cookieOf(value: unknown): string {
  const record = value as {
    req?: { headers?: Record<string, unknown> };
    extra?: { request?: { headers?: Record<string, unknown> } };
  } | null;
  return String(
    record?.req?.headers?.cookie ??
      record?.extra?.request?.headers?.cookie ??
      "",
  );
}

/** The GraphQL module's `context` option of a boot (GraphqlContextShape); Mercurius passes (request, reply). */
function contextOption(
  shape: GraphqlContextShape | undefined,
  mercurius: boolean,
): { context?: unknown } {
  let cached: object | undefined;
  switch (shape) {
    case undefined:
      return {};
    case "static":
      return { context: {} };
    case "fresh":
      return {
        context: mercurius
          ? (request: object, reply: object) => ({ req: request, reply })
          : (value: object) => ({ ...value }),
      };
    case "plain-request":
      return {
        context: (value: unknown) => ({
          req: { headers: { cookie: cookieOf(value) } },
        }),
      };
    case "cached":
      return {
        context: mercurius
          ? (request: object, reply: object) =>
              (cached ??= { req: request, reply })
          : (value: object) => (cached ??= { ...value }),
      };
  }
}

interface HarnessOptions {
  readonly driver: Driver;
  /** 'socket' sends every operation over graphql-ws; its browser leg is the connection's handshake. */
  readonly channel: "http" | "socket";
  readonly transport?: GraphqlTransportOptions;
  /** Mercurius sockets: register mercuriusSubscriptionContext(). */
  readonly subscriptionContext?: boolean;
  /**
   * 'socket': a handshake that moves no credential into connectionParams sends connection_init without a payload,
   * as a browser graphql-ws client without connectionParams does.
   */
  readonly omitEmptyConnectionParams?: boolean;
  /** The Apollo Federation version of federation boots (default 2). */
  readonly federationVersion?: 1 | 2;
  /** A transport unit to run instead of the driver's production transport (mutation tests). */
  readonly unit?: AuthTransport;
}

/** The driver's batching and, over graphql-ws, its subscription server options. */
function serverOptions(harness: HarnessOptions): Record<string, unknown> {
  const socket = harness.channel === "socket";
  return harness.driver === "mercurius"
    ? {
        allowBatchedQueries: true,
        ...(socket
          ? {
              subscription: {
                fullWsTransport: true,
                ...(harness.subscriptionContext
                  ? { context: mercuriusSubscriptionContext() }
                  : {}),
              },
            }
          : {}),
      }
    : {
        allowBatchedHttpRequests: true,
        ...(socket ? { subscriptions: { "graphql-ws": true } } : {}),
      };
}

/** Compiles `builder` on the driver's platform, listens on an ephemeral port and records the running app. */
async function listen(
  harness: HarnessOptions,
  builder: TestingModuleBuilder,
  handlers: Map<string, FixtureHandler>,
  logger: LoggerService | false,
): Promise<INestApplication> {
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication(
    harness.driver === "apollo-express"
      ? new ExpressAdapter()
      : new FastifyAdapter(),
    { logger },
  );
  try {
    await app.init();
    await app.listen(0, "127.0.0.1");
  } catch (error) {
    await app.close();
    throw error;
  }
  apps.set(app, {
    url: await app.getUrl(),
    handlers,
    omitEmptyConnectionParams: harness.omitEmptyConnectionParams ?? false,
  });
  return app;
}

/**
 * A built-in GraphQL transport, exposed through a real GraphQL server on a listening app: one root field per kit
 * fixture, and the graph fixtures as FixtureNode roots and fields in the boots of the GraphQL cases, which pass
 * `fieldResolverEnhancers` or `federation` (FixtureNode is then an entity). The other boots serve the root fields only:
 * their fixture variants, such as `@UseBetterAuth()` on every handler, apply to the kit's fixture handlers alone.
 */
function graphqlHarness(harness: HarnessOptions): TransportConformanceOptions {
  const mercurius = harness.driver === "mercurius";
  const fastify = harness.driver !== "apollo-express";
  const socket = harness.channel === "socket";
  const transport: ExtensionRef<AuthTransport> =
    harness.unit ??
    (mercurius
      ? mercuriusTransport(harness.transport)
      : apolloTransport(harness.transport));
  const operation = (
    app: INestApplication,
    value: Operation,
    headers: HeadersInit,
  ): Promise<Reply> =>
    socket
      ? onConnection(app, headers, async (connection) => ({
          result: await connection.execute(value),
          setCookies: [],
        }))
      : httpOperation(app, value, headers);
  const shapes: InvocationShape[] = socket
    ? ["aliases", "messages", "subscriptions"]
    : ["aliases", "batched"];
  return {
    transport,
    expectCookieCapable: !socket,
    expectBrowserLeg: true,
    invocationShapes: shapes,
    graphqlContexts: mercurius
      ? ["static", "cached", "fresh"]
      : ["static", "cached", "fresh", "plain-request"],
    async createApp(fixtures, auth, options) {
      const handlers = flatten(fixtures);
      const graph =
        options.fieldResolverEnhancers !== undefined || !!options.federation;
      // A boot with its own field resolver coverage registers its own unit of the driver's transport.
      const unit: ExtensionRef<AuthTransport> =
        options.fieldResolverCoverage && !harness.unit
          ? (mercurius ? mercuriusTransport : apolloTransport)({
              ...harness.transport,
              fieldResolverCoverage: options.fieldResolverCoverage,
            })
          : transport;
      const federation = !!options.federation;
      const driver = mercurius
        ? federation
          ? MercuriusFederationDriver
          : MercuriusDriver
        : federation
          ? ApolloFederationDriver
          : ApolloDriver;
      @Module({
        imports: [
          GraphQLModule.forRoot({
            driver,
            autoSchemaFile: federation
              ? { federation: harness.federationVersion ?? 2 }
              : true,
            fieldResolverEnhancers: [...(options.fieldResolverEnhancers ?? [])],
            ...contextOption(options.graphqlContext, mercurius),
            ...serverOptions(harness),
          } as never),
          BetterAuthModule.forRoot({
            auth,
            platforms: [fastify ? fastifyPlatform() : expressPlatform()],
            transports: [unit],
            ...(options.forwardDirectCalls
              ? { cookies: { forwardDirectCalls: true } }
              : {}),
            globalGuard: options.globalGuard,
            principals: options.principals,
            ...(options.defaultRequirements
              ? { defaultRequirements: options.defaultRequirements }
              : {}),
            ...(options.globalScope === undefined
              ? {}
              : { globalScope: options.globalScope }),
            logSummary: options.logSummary ?? false,
          } as never),
        ],
        providers: [
          KitJsonScalar,
          fixtureResolver(handlers, socket),
          ...(graph ? [graphResolver(fixtures.graph, federation)] : []),
          ...(options.appEnhancers
            ? [
                { provide: APP_GUARD, useClass: BetterAuthGuard },
                {
                  provide: APP_INTERCEPTOR,
                  useClass: BetterAuthScopeInterceptor,
                },
              ]
            : []),
        ],
      })
      class GraphqlFixtureModule {}
      let builder = Test.createTestingModule({
        imports: [GraphqlFixtureModule],
      });
      if (options.override) {
        builder = options.override(builder);
      }
      return listen(harness, builder, handlers, options.logger ?? false);
    },
    async invoke(app, handler, headers, input = {}) {
      const fields = fieldsOf(handler);
      const reply = await operation(
        app,
        fixtureOperation(apps.get(app)!.handlers, fields, input),
        headers,
      );
      return outcomeOf(reply, fields);
    },
    async invokeTwice(app, shape, [first, second], headers) {
      const { handlers } = apps.get(app)!;
      const two = (
        results: TransportInvocationResult[],
      ): [TransportInvocationResult, TransportInvocationResult] => [
        results[0]!,
        results[1]!,
      ];
      switch (shape) {
        case "aliases": {
          const reply = await operation(
            app,
            {
              query:
                "query ($first: String, $second: String) { first: org(orgId: $first) second: org(orgId: $second) }",
              variables: { first: first.orgId, second: second.orgId },
            },
            headers,
          );
          return two([
            outcomeOf(reply, ["first"]),
            outcomeOf(reply, ["second"]),
          ]);
        }
        case "batched": {
          const { json, setCookies } = await post(
            app,
            [first, second].map((input) =>
              fixtureOperation(handlers, ["org"], input),
            ),
            headers,
          );
          return two(
            (json as GraphqlResponse[]).map((result) =>
              outcomeOf({ result, setCookies }, ["org"]),
            ),
          );
        }
        case "messages":
        case "subscriptions":
          return onConnection(app, headers, async (connection) => {
            const results: TransportInvocationResult[] = [];
            for (const input of [first, second]) {
              const value =
                shape === "messages"
                  ? fixtureOperation(handlers, ["org"], input)
                  : {
                      query: `subscription ($orgId: String) { ${ORG_SUBSCRIPTION}(orgId: $orgId) }`,
                      variables: input,
                    };
              results.push(
                outcomeOf(
                  { result: await connection.execute(value), setCookies: [] },
                  [shape === "messages" ? "org" : ORG_SUBSCRIPTION],
                ),
              );
            }
            return two(results);
          });
      }
    },
    async invokeGraph(app, selection, headers) {
      return graphResult(
        (await operation(app, graphOperation(selection), headers)).result,
      );
    },
    async invokeEntities(app, representations, fields, headers) {
      return graphResult(
        (
          await operation(
            app,
            entitiesOperation(representations, fields),
            headers,
          )
        ).result,
      );
    },
    ...(socket
      ? {
          invokeConnection: (app, handlers, headers, options) =>
            onConnection(
              app,
              headers,
              async (connection) => {
                const { handlers: fixtures } = apps.get(app)!;
                const results: TransportInvocationResult[] = [];
                for (const handler of handlers) {
                  const fields = fieldsOf(handler);
                  results.push(
                    outcomeOf(
                      {
                        result: await connection.execute(
                          fixtureOperation(fixtures, fields, {}),
                        ),
                        setCookies: [],
                      },
                      fields,
                    ),
                  );
                }
                return results;
              },
              options?.connectionParams,
            ),
        }
      : {}),
  };
}

/** The subscription field serving a policy handler over graphql-ws. */
const policySubscription = (handler: string) => `${handler}Events`;

/**
 * The policy kit's handlers: a query field per handler whose `orgId` argument is the KitJSON scalar, so the kit's value
 * arrives with its JSON type, and over graphql-ws a subscription field per handler with the same argument.
 */
function policyResolver(
  handlers: Readonly<Record<string, FixtureHandler>>,
  subscriptions: boolean,
) {
  @Resolver()
  class PolicyKitResolver {
    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  const orgIdArg = () => [
    Args("orgId", { type: () => KitJson, nullable: true }),
  ];
  const inputOf = (args: unknown[]) =>
    args[0] === undefined || args[0] === null ? {} : { orgId: args[0] };
  for (const [name, fixture] of Object.entries(handlers)) {
    defineHandler(
      PolicyKitResolver,
      name,
      fixture,
      orgIdArg(),
      [Query(() => KitJson, { name, nullable: true }), ...fixture.decorators],
      function (args) {
        return fixture.handle([], inputOf(args), { service: this.service });
      },
    );
    if (!subscriptions) {
      continue;
    }
    const field = policySubscription(name);
    defineHandler(
      PolicyKitResolver,
      field,
      fixture,
      orgIdArg(),
      [
        Subscription(() => KitJson, { name: field, nullable: true }),
        ...fixture.decorators,
      ],
      async function* (this: Host, args: unknown[]) {
        yield {
          [field]: await fixture.handle([], inputOf(args), {
            service: this.service,
          }),
        };
      } as (this: Host, args: unknown[]) => unknown,
    );
  }
  return PolicyKitResolver;
}

function policyOperation(
  kind: "query" | "subscription",
  field: string,
  input: Record<string, unknown>,
): Operation {
  return {
    query: `${kind} ($orgId: KitJSON) { ${field}(orgId: $orgId) }`,
    variables: input,
  };
}

/** The principal TTL of the policy deliveries' graphql-ws connections (design v7 §14.1 Z-admin-banned: 300 s). */
const DELIVERY_TTL_MS = 300_000;

/**
 * The policy kit's delivery over a built-in GraphQL transport: the kit's handlers as query fields with a JSON-scalar
 * `orgId` argument, over HTTP or over graphql-ws. Over graphql-ws the transport reuses a connection's principal for
 * 300 s, and a connection sends each handler as a subscription operation.
 */
function graphqlDelivery(
  name: string,
  harness: Omit<HarnessOptions, "transport">,
): PolicyDelivery {
  const socket = harness.channel === "socket";
  const mercurius = harness.driver === "mercurius";
  const transportOptions: GraphqlTransportOptions = socket
    ? { subscriptionPrincipalTtlMs: DELIVERY_TTL_MS }
    : {};
  const transport =
    harness.unit ??
    (mercurius ? mercuriusTransport : apolloTransport)(transportOptions);
  return {
    name,
    ...(socket ? { connectionPrincipalTtlMs: DELIVERY_TTL_MS } : {}),
    async createApp(handlers, auth, options) {
      @Module({
        imports: [
          GraphQLModule.forRoot({
            driver: mercurius ? MercuriusDriver : ApolloDriver,
            autoSchemaFile: true,
            ...serverOptions(harness),
          } as never),
          BetterAuthModule.forRoot({
            auth,
            platforms: [
              harness.driver === "apollo-express"
                ? expressPlatform()
                : fastifyPlatform(),
            ],
            transports: [transport],
            globalGuard: true,
            principals: options.principals,
            logSummary: false,
          } as never),
        ],
        providers: [KitJsonScalar, policyResolver(handlers, socket)],
      })
      class PolicyDeliveryModule {}
      return listen(
        harness,
        Test.createTestingModule({ imports: [PolicyDeliveryModule] }),
        new Map(Object.entries(handlers)),
        options.logger,
      );
    },
    async invoke(app, handler, headers, input = {}) {
      const operation = policyOperation("query", handler, input);
      const result = socket
        ? await onConnection(app, headers, (connection) =>
            connection.execute(operation),
          )
        : (await httpOperation(app, operation, headers)).result;
      return outcomeOf({ result, setCookies: [] }, [handler]);
    },
    ...(socket
      ? {
          async connect(app: INestApplication, headers: HeadersInit) {
            const connection = connect(app, headers);
            return {
              async invoke(handler: string, input = {}) {
                const field = policySubscription(handler);
                return outcomeOf(
                  {
                    result: await connection.execute(
                      policyOperation("subscription", field, input),
                    ),
                    setCookies: [],
                  },
                  [field],
                );
              },
              close: () => connection.close(),
            };
          },
        }
      : {}),
  };
}

const drivers: readonly [Driver, string][] = [
  ["apollo-express", "Apollo transport with Express"],
  ["apollo-fastify", "Apollo transport with Fastify"],
  ["mercurius", "Mercurius transport"],
];

for (const [driver, label] of drivers) {
  describe(`transport kit on the built-in ${label} over HTTP`, () => {
    runConformance(
      transportConformance(graphqlHarness({ driver, channel: "http" })),
      { describe, it },
    );
  });

  describe(`transport kit on the built-in ${label} over HTTP with federation 1`, () => {
    runConformance(
      transportConformance(
        graphqlHarness({ driver, channel: "http", federationVersion: 1 }),
      ).filter((item) => item.id === "T-reference-resolver"),
      { describe, it },
    );
  });

  describe(`transport kit on the built-in ${label} over graphql-ws`, () => {
    runConformance(
      transportConformance(
        graphqlHarness({
          driver,
          channel: "socket",
          subscriptionContext: driver === "mercurius",
        }),
      ),
      { describe, it },
    );
  });

  describe(`transport kit on the built-in ${label} over graphql-ws omitting empty connection_init payloads`, () => {
    runConformance(
      transportConformance(
        graphqlHarness({
          driver,
          channel: "socket",
          subscriptionContext: driver === "mercurius",
          omitEmptyConnectionParams: true,
        }),
      ),
      { describe, it },
    );
  });

  describe(`transport kit on the built-in ${label} over graphql-ws with a principal TTL`, () => {
    runConformance(
      transportConformance(
        graphqlHarness({
          driver,
          channel: "socket",
          subscriptionContext: driver === "mercurius",
          transport: { subscriptionPrincipalTtlMs: 60_000 },
        }),
      ),
      { describe, it },
    );
  });
}

describe("transport kit on the built-in Mercurius transport over graphql-ws without its subscription context", () => {
  runConformance(
    transportConformance(
      graphqlHarness({ driver: "mercurius", channel: "socket" }),
    ),
    { describe, it },
  );
});

describe("transport kit on the built-in Mercurius transport over graphql-ws without its subscription context, omitting empty connection_init payloads", () => {
  runConformance(
    transportConformance(
      graphqlHarness({
        driver: "mercurius",
        channel: "socket",
        omitEmptyConnectionParams: true,
      }),
    ),
    { describe, it },
  );
});

/** The production Apollo transport with `overrides` layered over it; its own members keep running on the result. */
function faultyApollo(
  overrides: (real: AuthTransport) => Partial<AuthTransport>,
): AuthTransport {
  const real = apolloTransport() as AuthTransport;
  return Object.assign(Object.create(real) as AuthTransport, overrides(real));
}

/** `call` with `invocation` and `browser` replaced, every other member kept, getters kept lazy. */
function withCall(
  call: TransportCall,
  change: {
    invocation?: object;
    browser?: (leg: BrowserExposure | undefined) => BrowserExposure | undefined;
  },
): TransportCall {
  return {
    key: call.key,
    invocation: change.invocation ?? call.invocation,
    connection: call.connection,
    principalTtlMs: call.principalTtlMs,
    lineage: call.lineage,
    headers: () => call.headers(),
    param: (name) => call.param(name),
    get clientIp() {
      return call.clientIp;
    },
    get cookies() {
      return call.cookies;
    },
    get request() {
      return call.request;
    },
    get browser() {
      return change.browser ? change.browser(call.browser) : call.browser;
    },
  };
}

/** A harness whose apps plan requests through `change`, a faulty planner, from the first request on. */
function withPlans(
  harness: TransportConformanceOptions,
  change: (plan: RoutePlan, target: Type, method: string) => RoutePlan,
): TransportConformanceOptions {
  return {
    ...harness,
    async createApp(fixtures, auth, options) {
      const app = await harness.createApp(fixtures, auth, options);
      const planner = app.get<RoutePlanner>(ROUTE_PLANNER, { strict: false });
      const plan = planner.plan.bind(planner);
      planner.plan = (target, method) =>
        change(plan(target, method), target, method);
      return app;
    },
  };
}

/** `extra` with its graphql-ws socket reporting WebSocket.OPEN, or `extra` itself without a socket. */
function openedExtra(extra: unknown): unknown {
  const value = extra as { socket?: object } | undefined;
  return value?.socket
    ? {
        ...value,
        socket: new Proxy(value.socket, {
          get: (target, key) =>
            key === "readyState" ? 1 : Reflect.get(target, key),
        }),
      }
    : extra;
}

/**
 * A view of `context` whose GraphQL context reports every graphql-ws socket as open. One view per context object keeps
 * the carrier's lineage state, which the view inherits.
 */
function withOpenSockets(
  views: WeakMap<object, object>,
  context: ExecutionContext,
): ExecutionContext {
  const args = [...context.getArgs()];
  const index = args.length === 3 ? 1 : 2;
  const carrier = args[index] as
    | { extra?: { socket?: object }; req?: { extra?: { socket?: object } } }
    | undefined;
  if (!carrier?.extra?.socket && !carrier?.req?.extra?.socket) {
    return context;
  }
  let view = views.get(carrier);
  if (!view) {
    const req = carrier.req?.extra?.socket
      ? Object.create(carrier.req, {
          extra: { value: openedExtra(carrier.req.extra) },
        })
      : carrier.req;
    view = Object.create(carrier, {
      extra: { value: openedExtra(carrier.extra) },
      req: { value: req },
    }) as object;
    views.set(carrier, view);
  }
  args[index] = view;
  return Object.create(context, {
    getArgs: { value: () => args },
    getArgByIndex: { value: (position: number) => args[position] },
  }) as ExecutionContext;
}

/** The connectionParams of a graphql-ws operation served under Apollo's default context. */
function connectionParamsOf(
  context: ExecutionContext,
): Record<string, unknown> | undefined {
  return (
    context.getArgs()[2] as
      | { req?: { connectionParams?: Record<string, unknown> } }
      | undefined
  )?.req?.connectionParams;
}

describe("GraphQL transport kit mutations", () => {
  const apollo = (options: Partial<HarnessOptions> = {}) =>
    graphqlHarness({ driver: "apollo-express", channel: "http", ...options });
  const caseOf = (options: TransportConformanceOptions, id: string) =>
    transportConformance(options).find((item) => item.id === id)!;

  it("fails T-invocation-decisions for a transport whose aliases share the operation as their invocation", async () => {
    const shared = faultyApollo((real) => ({
      describe: (context, kit) => {
        const call = real.describe.call(shared, context, kit);
        return withCall(call, { invocation: call.key });
      },
    }));
    await expect(
      caseOf(apollo({ unit: shared }), "T-invocation-decisions").run(),
    ).rejects.toThrow(
      /aliases: the second invocation was not decided independently/,
    );
  });

  it("fails T-stamp-per-plan for a transport whose lineage gives every field of an operation one position", async () => {
    const flat = faultyApollo((real) => ({
      lineage: (context) => {
        const lineage = real.lineage!.call(flat, context)!;
        return {
          ...lineage,
          position: "operation",
          *enclosing() {
            yield "operation";
          },
        };
      },
    }));
    await expect(
      caseOf(apollo({ unit: flat }), "T-stamp-per-plan").run(),
    ).rejects.toThrow(/reader under (sessionOnly|mixed|public)/);
  });

  it("fails T-inherit-no-lookup for a transport whose field resolvers do not inherit their root's access", async () => {
    // Without inheritance, a principal reader under a public root is a protected field that no guard covers.
    const uninherited = faultyApollo(() => ({ defaultAccessFor: undefined }));
    await expect(
      caseOf(apollo({ unit: uninherited }), "T-inherit-no-lookup").run(),
    ).rejects.toThrow(/\[FIELD_RESOLVER_UNGUARDED\] GraphResolver\.reader /);
  });

  it("fails T-reference-resolver for a transport that serves reference resolvers without field guards", async () => {
    await expect(
      caseOf(
        apollo({ transport: { federationCoverage: "off" } }),
        "T-reference-resolver",
      ).run(),
    ).rejects.toThrow(
      /expected REFERENCE_RESOLVER_UNGUARDED or FEDERATION_FIELD_GUARDS_REQUIRED, got AUTH_BOOT_FAILED, FIELD_RESOLVER_UNGUARDED:/,
    );
  });

  it("fails T-stale-context for a transport that treats a completed request as live", async () => {
    const live = faultyApollo((real) => ({
      describe: (context, kit) =>
        real.describe.call(live, context, {
          ...kit,
          http:
            kit.http &&
            Object.create(kit.http, { isLive: { value: () => true } }),
        }),
    }));
    await expect(
      caseOf(apollo({ unit: live }), "T-stale-context").run(),
    ).rejects.toThrow(
      /a later caller of required did not read its own principal/,
    );
  });

  it("fails T-stale-context for a transport that ignores the graphql-ws socket's state at operation start", async () => {
    const views = new WeakMap<object, object>();
    const ignoring = faultyApollo((real) => ({
      describe: (context, kit) =>
        real.describe.call(ignoring, withOpenSockets(views, context), kit),
      lineage: (context) =>
        real.lineage!.call(ignoring, withOpenSockets(views, context)),
    }));
    await expect(
      caseOf(
        apollo({ channel: "socket", unit: ignoring }),
        "T-stale-context",
      ).run(),
    ).rejects.toThrow(
      /a later caller of required did not read its own principal/,
    );
  });

  it("fails T-subscription-credentials for a transport that ignores connectionParams credentials", async () => {
    await expect(
      caseOf(
        apollo({
          channel: "socket",
          transport: { connectionParamHeaders: [] },
        }),
        "T-subscription-credentials",
      ).run(),
    ).rejects.toThrow(
      /a connectionParams bearer token did not authenticate its subscriptions/,
    );
  });

  it("fails T-subscription-origin for a transport that treats socket operations as safe reads", async () => {
    const lenient = faultyApollo((real) => ({
      describe: (context, kit) =>
        withCall(real.describe.call(lenient, context, kit), {
          browser: (leg) => leg && { ...leg, enforce: false },
        }),
    }));
    await expect(
      caseOf(
        apollo({ channel: "socket", unit: lenient }),
        "T-subscription-origin",
      ).run(),
    ).rejects.toThrow(
      /the driver's context: an untrusted Origin, subscription 1/,
    );
  });

  it("fails T-subscription-origin-junk-connection-params for a transport that exempts connectionParams tokens", async () => {
    const exempting = faultyApollo((real) => ({
      describe: (context, kit) => {
        const call = real.describe.call(exempting, context, kit);
        return connectionParamsOf(context)?.authorization
          ? withCall(call, { browser: () => undefined })
          : call;
      },
    }));
    await expect(
      caseOf(
        apollo({ channel: "socket", unit: exempting }),
        "T-subscription-origin-junk-connection-params",
      ).run(),
    ).rejects.toThrow(/a junk connectionParams bearer token, subscription 1/);
  });

  it("fails T-csrf-login-proxy for a transport that serves inherited forwarding fields without field guards", async () => {
    await expect(
      caseOf(
        apollo({ transport: { fieldResolverCoverage: "off" } }),
        "T-csrf-login-proxy",
      ).run(),
    ).rejects.toThrow(/the boot variant booted/);
  });

  it("fails the forwardDirectCalls boot of T-stamp-per-plan when a form-mode public field records a reading", async () => {
    // Only form-mode plans change, so every other boot of the case passes.
    const recording = withPlans(apollo(), (plan) =>
      plan.nested && plan.access === "public" && plan.originCheck === "form"
        ? { ...plan, nested: false }
        : plan,
    );
    await expect(caseOf(recording, "T-stamp-per-plan").run()).rejects.toThrow(
      /cookies\.forwardDirectCalls, \[guards, interceptors\]: reader under publicNested under sessionOnly/,
    );
  });

  it("fails T-inherit-no-lookup for a transport that does not warn about inheriting fields", async () => {
    const quiet = faultyApollo((real) => ({
      advise: async (context) =>
        (await real.advise!.call(quiet, context)).filter(
          (advice) => advice.code !== "W_FIELD_RESOLVER_INHERITS",
        ),
    }));
    await expect(
      caseOf(apollo({ unit: quiet }), "T-inherit-no-lookup").run(),
    ).rejects.toThrow(/\[\]: boot did not warn W_FIELD_RESOLVER_INHERITS/);
  });

  it("fails T-inherit-no-lookup for a planner that applies class-level acceptance to field resolvers", async () => {
    const widening = withPlans(apollo(), (plan, target) =>
      plan.access === "inherit" &&
      Reflect.getMetadata(ACCEPT_PRINCIPALS_METADATA, target)
        ? { ...plan, access: "required" }
        : plan,
    );
    await expect(caseOf(widening, "T-inherit-no-lookup").run()).rejects.toThrow(
      /class-level @AcceptPrincipals, \[\]: the plain field resolver lost its inherit plan/,
    );
  });

  it("fails T-reference-resolver for a transport that does not report class metadata reaching reference resolvers", async () => {
    const quiet = faultyApollo((real) => ({
      advise: async (context) =>
        (await real.advise!.call(quiet, context)).filter(
          (advice) => advice.code !== "I_CLASS_METADATA_OPERATIONS_ONLY",
        ),
    }));
    await expect(
      caseOf(apollo({ unit: quiet }), "T-reference-resolver").run(),
    ).rejects.toThrow(/I_CLASS_METADATA_OPERATIONS_ONLY does not name/);
  });

  it("fails the gated GraphQL cases for a harness that omits their helpers", async () => {
    const cases = transportConformance({
      ...apollo(),
      invokeGraph: undefined,
      invokeEntities: undefined,
    });
    for (const id of ["T-inherit-no-lookup", "T-stamp-per-plan"]) {
      await expect(cases.find((item) => item.id === id)!.run()).rejects.toThrow(
        /nests handlers \(defaultAccessFor\), so invokeGraph is required/,
      );
    }
    await expect(
      cases.find((item) => item.id === "T-reference-resolver")!.run(),
    ).rejects.toThrow(
      /claims the federation reference resolver, so invokeEntities is required/,
    );
    await expect(
      caseOf(
        {
          ...graphqlHarness({ driver: "apollo-express", channel: "socket" }),
          invokeConnection: undefined,
        },
        "T-ws-origin-untrusted",
      ).run(),
    ).rejects.toThrow(/so invokeConnection is required/);
  });

  it("fails T-selection for a harness that declares no browser leg, reading the leg while each request runs", async () => {
    for (const channel of ["http", "socket"] as const) {
      await expect(
        caseOf(
          { ...apollo({ channel }), expectBrowserLeg: false },
          "T-selection",
        ).run(),
      ).rejects.toThrow(
        /describes a browser leg, so expectBrowserLeg must be true/,
      );
    }
  });
});

for (const [driver, label] of drivers) {
  for (const channel of ["http", "socket"] as const) {
    const name = `${label} over ${channel === "http" ? "HTTP" : "graphql-ws"}`;
    const delivery = () =>
      graphqlDelivery(name, {
        driver,
        channel,
        subscriptionContext: driver === "mercurius",
      });
    describe(`policy kit admin rows over the built-in ${name}`, async () => {
      runConformance(
        policyDeliveryCases(await adminPolicyOptions(), delivery()),
        { describe, it },
      );
    });

    describe(`policy kit organization rows over the built-in ${name}`, async () => {
      runConformance(
        policyDeliveryCases(await organizationPolicyOptions(), delivery()),
        { describe, it },
      );
    });
  }
}

describe("GraphQL policy delivery mutations", () => {
  const delivery = () =>
    graphqlDelivery("Apollo transport with Express over graphql-ws", {
      driver: "apollo-express",
      channel: "socket",
    });
  const bannedCase = async (value: PolicyDelivery) =>
    policyDeliveryCases(await adminPolicyOptions(), value).find(
      (item) => item.id === "Z-admin-banned",
    )!;

  it("fails Z-admin-banned over graphql-ws when authoritative operations reuse the connection's principal", async () => {
    const memo = RequestScope.prototype.memoPrincipal;
    const spy = vi
      .spyOn(RequestScope.prototype, "memoPrincipal")
      .mockImplementation(function (this: RequestScope, call, input, compute) {
        return memo.call(
          this,
          call,
          { ...input, freshness: "default" },
          compute,
        );
      });
    try {
      await expect((await bannedCase(delivery())).run()).rejects.toThrow(
        /an authoritative handler reused the connection's principal after sign-out: allowed/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("fails Z-admin-banned for a graphql-ws delivery that opens a new socket for each operation", async () => {
    const perOperation = delivery();
    const reconnecting: PolicyDelivery = {
      ...perOperation,
      async connect(app, headers) {
        return {
          invoke: (handler, input = {}) =>
            onConnection(app, headers, async (connection) =>
              outcomeOf(
                {
                  result: await connection.execute(
                    policyOperation(
                      "subscription",
                      policySubscription(handler),
                      input,
                    ),
                  ),
                  setCookies: [],
                },
                [policySubscription(handler)],
              ),
            ),
          close: async () => undefined,
        };
      },
    };
    await expect((await bannedCase(reconnecting)).run()).rejects.toThrow(
      /the connection did not reuse its principal within its declared 300000 ms TTL: 401/,
    );
  });
});
