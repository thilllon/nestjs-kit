import type { OutgoingHttpHeaders } from "node:http";
import { ApolloDriver, ApolloFederationDriver } from "@nestjs/apollo";
import { Inject, type INestApplication, Module } from "@nestjs/common";
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
import { Test } from "@nestjs/testing";
import { type ValueNode, valueFromASTUntyped } from "graphql";
import { type Client, createClient } from "graphql-ws";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import type {
  AuthTransport,
  ExtensionRef,
  TransportCall,
} from "./auth-contracts.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { BetterAuthService } from "./auth-service.js";
import {
  runConformance,
  sendRaw,
  setCookieLines,
} from "./conformance-fixtures.js";
import {
  type FixtureHandler,
  type GraphFixtures,
  type GraphResult,
  type GraphSelection,
  type InvocationShape,
  type TransportConformanceOptions,
  type TransportFixtures,
  type TransportInvocationResult,
  transportConformance,
} from "./conformance-transport.js";
import { expressPlatform } from "./express.js";
import { fastifyPlatform } from "./fastify.js";
import {
  apolloTransport,
  type GraphqlTransportOptions,
  mercuriusSubscriptionContext,
  mercuriusTransport,
} from "./graphql.js";

type FixtureName = Exclude<keyof TransportFixtures, "graph">;
type GraphField = keyof GraphFixtures["fields"];
type Driver = "apollo-express" | "apollo-fastify" | "mercurius";

const REPLY_TIMEOUT_MS = 5000;
/** The kit's named inputs, exposed as nullable String arguments of every fixture field. */
const INPUTS = ["orgId", "email", "password"] as const;

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
}

/** Selection of each FixtureNode field. */
const FIELD_SELECTIONS: Readonly<Record<GraphField, string>> = {
  plain: "plain",
  publicNested: "publicNested { id }",
  reader: "reader",
  guarded: "guarded { id principal }",
  nestedReader: "nestedReader",
  sessionReader: "sessionReader",
};

/** Schema names of the graph roots, which share names with non-graph fixtures; invokeGraph aliases them back. */
const GRAPH_ROOTS: Readonly<Record<keyof GraphFixtures["roots"], string>> = {
  public: "graphPublic",
  sessionOnly: "graphSessionOnly",
  mixed: "graphMixed",
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
    const name = GRAPH_ROOTS[root as keyof GraphFixtures["roots"]];
    defineHandler(
      GraphResolver,
      name,
      fixture,
      [],
      [Query(() => FixtureNode, { name }), ...fixture.decorators],
      call(fixture),
    );
  }
  for (const [field, fixture] of Object.entries(graph.fields)) {
    if (!fixture) {
      continue;
    }
    const type = FIELD_SELECTIONS[field as GraphField].includes("{")
      ? () => FixtureNode
      : field === "plain" || field === "sessionReader"
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

function connect(app: INestApplication, headers: HeadersInit): Connection {
  const { url, omitEmptyConnectionParams } = apps.get(app)!;
  const { headers: upgrade, connectionParams } = handshake(headers);
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
    close: () => client.dispose() as Promise<void>,
  };
}

async function onConnection<T>(
  app: INestApplication,
  headers: HeadersInit,
  run: (connection: Connection) => Promise<T>,
): Promise<T> {
  const connection = connect(app, headers);
  try {
    return await run(connection);
  } finally {
    await connection.close();
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
    async createApp(fixtures, auth, options) {
      const handlers = flatten(fixtures);
      const graph =
        options.fieldResolverEnhancers !== undefined || !!options.federation;
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
            ...(mercurius
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
                }),
          } as never),
          BetterAuthModule.forRoot({
            auth,
            platforms: [fastify ? fastifyPlatform() : expressPlatform()],
            transports: [transport],
            globalGuard: options.globalGuard,
            principals: options.principals,
            ...(options.defaultRequirements
              ? { defaultRequirements: options.defaultRequirements }
              : {}),
            ...(options.globalScope === undefined
              ? {}
              : { globalScope: options.globalScope }),
            logSummary: false,
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
      const moduleRef = await builder.compile();
      const app = moduleRef.createNestApplication(
        fastify ? new FastifyAdapter() : new ExpressAdapter(),
        { logger: options.logger ?? false },
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
          invokeConnection: (app, handlers, headers) =>
            onConnection(app, headers, async (connection) => {
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
            }),
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

/** A call whose invocation is `invocation`, with every other member of `call`, getters kept lazy. */
function withInvocation(
  call: TransportCall,
  invocation: object,
): TransportCall {
  return {
    key: call.key,
    invocation,
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
      return call.browser;
    },
  };
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
        return withInvocation(call, call.key);
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
