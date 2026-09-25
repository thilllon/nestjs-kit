import {
  Controller,
  Get,
  type ExecutionContext,
  type INestApplication,
  type LoggerService,
  type Provider,
} from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import type { BetterAuthOptions } from "better-auth";
import type {
  AuthorizationDecision,
  AuthorizationPolicy,
  AuthPrincipalBase,
  AuthTransport,
  CookieSink,
  ExtensionRef,
  PolicyInvoker,
  PrincipalResolver,
  PrincipalSource,
  Requirement,
  RequirementExpr,
  RoutePlan,
  SessionPrincipalOptions,
  TransportCall,
} from "./auth-contracts.js";
import { Require } from "./auth-decorators.js";
import {
  type AuthFailure,
  AuthFailures,
  BetterAuthConfigurationError,
} from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import {
  INSTANCE_REGISTRY,
  POLICY_INVOKER,
  POLICY_RESOLVER,
  PRINCIPAL_RESOLVER,
  REQUEST_SCOPE,
  ROUTE_PLANNER,
} from "./auth-tokens.js";
import type { AuthLike, AuthPrincipal, PrincipalKind } from "./auth-types.js";
import { AuthorizationEvaluator } from "./authorization-evaluator.js";
import {
  CapturingLogger,
  type ConformanceOutcome,
  probeOf,
  type ProbeState,
  createConformanceAuth,
  PROBE_TRUSTED_ORIGIN,
  testHelpers,
} from "./conformance-fixtures.js";
import type {
  FixtureHandler,
  TransportInvocationResult,
} from "./conformance-transport.js";
import type { InstanceRegistry } from "./instance-registry.js";
import type { PolicyResolver } from "./policy-resolver.js";
import { absent, authenticated, rejected } from "./principal-resolver.js";
import type { RequestScope } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import { authHeadersFor } from "./testing.js";

export interface PolicyConformanceOptions {
  /**
   * The requirement to judge. Its policies must be policy objects: the kit boots no application providers, so a class
   * or token reference cannot resolve. For a DI policy, pass an instance built with its dependencies (new MyPolicy(deps)).
   */
  requirement: RequirementExpr;
  /**
   * The Better Auth instance the principals belong to. It must include conformanceProbePlugin(), testUtils(), the
   * policy's plugins and nestjs(): createConformanceAuth({ plugins }) builds one. Session principals are judged with
   * real session headers for their user (testUtils().getAuthHeaders). Unit-specific cases use the instance's plugins
   * when present: session.cookieCache for the warm-cache variants, apiKey({ enableSessionForAPIKeys: true }) for the
   * API-key session and quota cases; each states the reason when it skips.
   */
  auth: AuthLike;
  allowingPrincipal(): Promise<AuthPrincipal>;
  denyingPrincipal(): Promise<AuthPrincipal>;
  delegatedPrincipal?(): Promise<AuthPrincipal>;
  /**
   * Principal sources the kit registers besides the built-in session source, for the requirement's other principal kinds
   * (e.g. apiKeyPrincipal()). Cases that send a request through the guard resolve those kinds with them; without them
   * the kit registers placeholder sources that resolve nothing.
   */
  sources?: readonly ExtensionRef<PrincipalSource>[];
  /**
   * Transports to deliver the transport-specific rows through, besides the kit's in-process request: each delivery adds
   * its own variants of Z-admin-banned (connection deliveries with a principal TTL), Z-admin-rejects-api-key-session,
   * Z-apikey-quota-per-request and Z-org-ref-types, titled with its name.
   */
  deliveries?: readonly PolicyDelivery[];
  /**
   * Builds the instances the kit needs in another configuration (adminUserIds, customSession shapes, a dynamic baseURL,
   * an instance without apiKey()) with exactly the given overrides, on the storage under test. It must add what
   * createConformanceAuth() adds (testUtils(), bearer(), conformanceProbePlugin(), nestjs(), an explicit
   * advanced.disableOriginCheck: false and session.updateAge 0) and have its schema migrated. Default:
   * createConformanceAuth(overrides), on the memory adapter.
   */
  variant?(
    overrides: Omit<BetterAuthOptions, "database">,
  ): AuthLike | Promise<AuthLike>;
}

/**
 * A transport the policy kit delivers its transport-specific rows through (design v7 §14.1). Build it from the harness
 * of a transportConformance run: it exposes the kit's handlers the way that harness exposes the transport kit's fixtures.
 */
export interface PolicyDelivery {
  /** The transport's name in case titles, e.g. 'Socket.IO'. */
  readonly name: string;
  /**
   * Boots an app with BetterAuthModule's globalGuard that exposes each handler under its name in the transport's shape:
   * a gateway message with explicit coverage, a message pattern or a GraphQL query field, plus the subscription field
   * that connect()'s operations select on a GraphQL socket. Apply the handler's decorators like transportConformance's
   * createApp does. The kit's only named input is `orgId`: pass its value through with its JSON type (a GraphQL
   * harness declares a JSON scalar argument), so ctx.param('orgId') reads it unchanged. Pass `principals` to
   * BetterAuthModule and use `logger` from boot on. The kit closes the app.
   */
  createApp(
    handlers: Readonly<Record<string, FixtureHandler>>,
    auth: AuthLike,
    options: {
      readonly principals: readonly ExtensionRef<PrincipalSource>[];
      readonly logger: LoggerService;
    },
  ): Promise<INestApplication>;
  /**
   * One logical request to a handler with the given headers: a message on its own connection, an RPC request, an
   * operation. The kit's headers carry the probe plugin's trusted Origin, as a browser on a trusted page sends it.
   */
  invoke(
    app: INestApplication,
    handler: string,
    headers: HeadersInit,
    input?: Record<string, unknown>,
  ): Promise<TransportInvocationResult>;
  /**
   * Connection deliveries (WebSocket gateways, graphql-ws): opens one connection whose handshake carries `headers`.
   * Its invoke() sends one message, or one subscription operation for GraphQL, after the previous one answered.
   */
  connect?(
    app: INestApplication,
    headers: HeadersInit,
  ): Promise<PolicyDeliveryConnection>;
  /**
   * The principal TTL of connect()'s connections: the transport's principalTtlMs or subscriptionPrincipalTtlMs. The
   * connection variant of Z-admin-banned runs when it is positive, and checks that the connection reuses its principal.
   */
  readonly connectionPrincipalTtlMs?: number;
}

/** One connection of a PolicyDelivery. */
export interface PolicyDeliveryConnection {
  invoke(
    handler: string,
    input?: Record<string, unknown>,
  ): Promise<TransportInvocationResult>;
  close(): Promise<void>;
}

/** An instance with the given overrides, built by options.variant() or createConformanceAuth(). */
export async function variantOf(
  options: Pick<PolicyConformanceOptions, "variant">,
  overrides: Omit<BetterAuthOptions, "database">,
): Promise<AuthLike> {
  return options.variant
    ? await options.variant(overrides)
    : createConformanceAuth(overrides);
}

export function requirementsOf(expression: RequirementExpr): Requirement[] {
  return "anyOf" in expression
    ? expression.anyOf.flatMap(requirementsOf)
    : "allOf" in expression
      ? expression.allOf.flatMap(requirementsOf)
      : [expression];
}

function isPolicyObject(value: unknown): value is AuthorizationPolicy<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as AuthorizationPolicy<unknown>).evaluate === "function"
  );
}

/** The policy objects of a requirement; the kit rejects class and token references up front. */
export function staticPolicies(
  expression: RequirementExpr,
): AuthorizationPolicy<unknown>[] {
  return requirementsOf(expression).map((item) => {
    if (!isPolicyObject(item.policy)) {
      throw new BetterAuthConfigurationError(
        "CONFORMANCE_POLICY_OBJECT_REQUIRED",
        `policyConformance received a requirement whose policy is a class or injection token (${String((item.policy as { name?: unknown })?.name ?? item.policy)}); the kit registers no application providers to resolve it.`,
        "Pass the policy object, e.g. requirement(new MyPolicy(dependencies), params).",
      );
    }
    return item.policy;
  });
}

export const KIT_ROUTE = "handle";

/** A controller with one method per route, each carrying the given method decorators. */
function controllerFor(
  routes: Readonly<Record<string, readonly MethodDecorator[]>>,
) {
  @Controller("nestjs-slightly-better-auth-policy-conformance")
  class PolicyConformanceController {}
  for (const [name, decorators] of Object.entries(routes)) {
    const method = function handle(): void {};
    Object.defineProperty(method, "name", { value: name });
    Object.defineProperty(PolicyConformanceController.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      PolicyConformanceController.prototype,
      name,
    )!;
    for (const decorator of [Get(name), ...decorators].reverse()) {
      decorator(PolicyConformanceController.prototype, name, descriptor);
    }
  }
  return PolicyConformanceController;
}

export const CONFORMANCE_KIND_SOURCE =
  "nestjs-slightly-better-auth:conformance-kind";

/**
 * Placeholder sources for the non-session kinds a requirement names that no given source produces, so boot validation
 * (B15) sees producers of every judged kind. They never resolve anything: the evaluator-level cases hand principals to
 * the evaluator directly.
 */
function kindSources(
  expressions: readonly RequirementExpr[],
  produced: ReadonlySet<string>,
): PrincipalSource[] {
  const kinds = new Set<string>();
  for (const item of expressions.flatMap(requirementsOf)) {
    const policy = isPolicyObject(item.policy) ? item.policy : undefined;
    for (const kind of item.principals ?? policy?.requires?.principals ?? []) {
      kinds.add(kind);
    }
  }
  kinds.delete("session");
  return [...kinds]
    .filter((kind) => !produced.has(kind))
    .map((kind) => ({
      id: `${CONFORMANCE_KIND_SOURCE}:${kind}`,
      kinds: [kind] as PrincipalSource["kinds"],
      acceptance: "explicit",
      delegates: true,
      resolve: async () => ({ outcome: "absent" }) as const,
    }));
}

function kindsOf(source: ExtensionRef<PrincipalSource>): readonly string[] {
  return typeof source === "object" &&
    source !== null &&
    Array.isArray((source as PrincipalSource).kinds)
    ? (source as PrincipalSource).kinds
    : [];
}

export interface BootOptions {
  /**
   * Routes by method name, each with its method decorators. Default: one route requiring `expression`; with routes,
   * `expression` only names the kinds that need placeholder sources.
   */
  routes?: Readonly<Record<string, readonly MethodDecorator[]>>;
  sources?: readonly ExtensionRef<PrincipalSource>[];
  providers?: readonly Provider[];
  session?: SessionPrincipalOptions<unknown> | false;
  transports?: readonly ExtensionRef<AuthTransport>[];
  logger?: CapturingLogger;
}

export interface Booted {
  readonly moduleRef: TestingModule;
  readonly controller: ReturnType<typeof controllerFor>;
  readonly logger: CapturingLogger;
}

/** Boot a TestingModule with the kit's controller and the given requirement; failures close the module. */
export async function boot(
  auth: AuthLike,
  expression: RequirementExpr | undefined,
  options: BootOptions = {},
): Promise<Booted> {
  const routes = options.routes ?? {
    [KIT_ROUTE]: expression ? [Require(expression)] : [],
  };
  const expressions = expression ? [expression] : [];
  const produced = new Set(
    (options.sources ?? []).flatMap((source) => [...kindsOf(source)]),
  );
  const sources = [
    ...(options.sources ?? []),
    ...kindSources(expressions, produced),
  ];
  const controller = controllerFor(routes);
  const logger = options.logger ?? new CapturingLogger();
  const moduleRef = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        auth,
        principals: sources,
        http: { mount: false },
        logSummary: false,
        ...(options.transports ? { transports: options.transports } : {}),
        ...(options.session === undefined ? {} : { session: options.session }),
      } as never),
    ],
    controllers: [controller],
    providers: [...(options.providers ?? [])],
  }).compile();
  moduleRef.useLogger(logger);
  try {
    await moduleRef.init();
  } catch (error) {
    await moduleRef.close().catch(() => undefined);
    throw error;
  }
  return { moduleRef, controller, logger };
}

export interface DecideCall {
  key?: object;
  invocation?: object;
  /** The request's headers; default: fresh session headers for a non-delegated principal's user, none otherwise. */
  headers?: Headers;
  /** Runs after the principal's session headers exist, right before evaluation. */
  beforeEvaluate?: () => void | Promise<void>;
}

/** The evaluator-level harness: principals go straight to the real AuthorizationEvaluator. */
export interface Harness {
  readonly auth: AuthLike;
  readonly probe: ProbeState;
  readonly invocations: { count: number };
  readonly policies: PolicyResolver;
  readonly logger: CapturingLogger;
  decide(
    principal: AuthPrincipal,
    call?: DecideCall,
  ): Promise<AuthorizationDecision>;
  close(): Promise<void>;
}

export async function harness(
  options: Pick<PolicyConformanceOptions, "auth" | "requirement" | "sources">,
): Promise<Harness> {
  const probe = await probeOf(options.auth);
  const { moduleRef, controller, logger } = await boot(
    options.auth,
    options.requirement,
    { sources: options.sources },
  );
  const real = moduleRef.get<PolicyInvoker>(POLICY_INVOKER);
  const invocations = { count: 0 };
  const counting: PolicyInvoker = {
    invoke(policy, params, context) {
      invocations.count++;
      return real.invoke(policy, params, context);
    },
  };
  const policies = moduleRef.get<PolicyResolver>(POLICY_RESOLVER);
  const evaluator = new AuthorizationEvaluator(
    policies,
    counting,
    moduleRef.get<PrincipalResolver>(PRINCIPAL_RESOLVER),
    moduleRef.get<RequestScope>(REQUEST_SCOPE),
  );
  const plan: RoutePlan = moduleRef
    .get<RoutePlanner>(ROUTE_PLANNER)
    .plan(controller, KIT_ROUTE);
  const entry = moduleRef
    .get<InstanceRegistry>(INSTANCE_REGISTRY)
    .get("default");
  const execution = {
    getClass: () => controller,
    getHandler: () => Reflect.get(controller.prototype, KIT_ROUTE),
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getType: () => "nestjs-slightly-better-auth:conformance",
  } as unknown as ExecutionContext;
  return {
    auth: options.auth,
    probe,
    invocations,
    policies,
    logger,
    async decide(principal, ids = {}) {
      const headers =
        ids.headers ??
        (principal.userId && !principal.delegation
          ? await authHeadersFor(options.auth, principal.userId)
          : new Headers());
      const key = ids.key ?? {};
      const call: TransportCall = {
        key,
        invocation: ids.invocation ?? key,
        headers: () => new Headers(headers),
        clientIp: null,
        cookies: null,
        param: () => undefined,
      };
      await ids.beforeEvaluate?.();
      return evaluator.evaluate(
        plan,
        principal,
        call,
        entry,
        execution,
        "conformance",
      );
    },
    close: () => moduleRef.close(),
  };
}

function resetFaults(probe: ProbeState): void {
  probe.fault = undefined;
  probe.storageFault = undefined;
  probe.respond = undefined;
}

export async function withHarness(
  options: Pick<PolicyConformanceOptions, "auth" | "requirement" | "sources">,
  fn: (harness: Harness) => Promise<ConformanceOutcome>,
): Promise<ConformanceOutcome> {
  const value = await harness(options);
  try {
    return await fn(value);
  } finally {
    resetFaults(value.probe);
    await value.close();
  }
}

/** Better Auth endpoints dispatched since `from`, without the session reads. */
export function betterAuthCalls(probe: ProbeState, from: number): string[] {
  return probe.calls.slice(from).filter((path) => path !== "/get-session");
}

export function sessionReads(probe: ProbeState, from: number): number {
  return probe.calls.slice(from).filter((path) => path === "/get-session")
    .length;
}

// ── Request harness: calls through the real BetterAuthGuard ─────────────────

const KIT_CONTEXT = "nestjs-slightly-better-auth:policy-conformance";

interface KitMessage {
  readonly headers: Headers;
  readonly input: Record<string, unknown>;
  readonly key: object;
  readonly invocation: object;
  readonly sink: CookieSink;
}

class KitDenial extends Error {
  constructor(readonly failure: AuthFailure) {
    super(failure.message);
  }
}

/**
 * The kit's in-process transport: one message is one logical request with one invocation. It is cookie-capable
 * (a recording sink), carries no browser leg and reads `param(name)` from the message input.
 */
class PolicyKitTransport implements AuthTransport {
  readonly id = "nestjs-slightly-better-auth:conformance/policy-request";

  handles(context: ExecutionContext): boolean {
    return context.getType<string>() === KIT_CONTEXT;
  }

  describe(context: ExecutionContext): TransportCall {
    const [message] = context.getArgs() as [KitMessage];
    return {
      key: message.key,
      invocation: message.invocation,
      headers: () => new Headers(message.headers),
      clientIp: null,
      cookies: message.sink,
      param: (name) => message.input[name],
    };
  }

  toException(failure: AuthFailure): unknown {
    return new KitDenial(failure);
  }
}

/** What one request through the guard answered: allowed, a denial with its status, or a 5xx. */
export type RequestOutcome =
  | { readonly ok: true; readonly status: 200 }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code?: string;
      readonly reason?: string;
      readonly error?: unknown;
    };

/** One connection of a connection delivery: each request is one message or operation on it. */
export interface RequestConnection {
  request(
    route: string,
    input?: Record<string, unknown>,
  ): Promise<RequestOutcome>;
  close(): Promise<void>;
}

export interface RequestHarness {
  readonly probe: ProbeState;
  readonly logger: CapturingLogger;
  request(
    route: string,
    headers: HeadersInit,
    input?: Record<string, unknown>,
  ): Promise<RequestOutcome>;
  /** Connection deliveries only. */
  connect?(headers: HeadersInit): Promise<RequestConnection>;
  close(): Promise<void>;
}

export type RequestOptions = Omit<BootOptions, "transports"> & {
  routes: Readonly<Record<string, readonly MethodDecorator[]>>;
};

export async function requestHarness(
  auth: AuthLike,
  options: RequestOptions,
): Promise<RequestHarness> {
  const probe = await probeOf(auth);
  const { moduleRef, controller, logger } = await boot(auth, undefined, {
    ...options,
    transports: [new PolicyKitTransport()],
  });
  const guard = moduleRef.get(BetterAuthGuard, { strict: false });
  return {
    probe,
    logger,
    async request(route, headers, input = {}) {
      const key = {};
      const message: KitMessage = {
        headers: new Headers(headers),
        input,
        key,
        invocation: key,
        sink: { append: () => true },
      };
      const args = [message];
      const context = {
        getClass: () => controller,
        getHandler: () => Reflect.get(controller.prototype, route),
        getArgs: () => args,
        getArgByIndex: (index: number) => args[index],
        getType: () => KIT_CONTEXT,
      } as unknown as ExecutionContext;
      try {
        await guard.canActivate(context);
        return { ok: true, status: 200 };
      } catch (error) {
        if (error instanceof KitDenial) {
          return {
            ok: false,
            status: error.failure.status,
            code: error.failure.code,
            reason: error.failure.reason,
          };
        }
        return { ok: false, status: 500, error };
      }
    },
    close: () => moduleRef.close(),
  };
}

/** A delivery's answer as a request outcome: its status code (500 when it carries none), code and reason. */
function deliveredOutcome(result: TransportInvocationResult): RequestOutcome {
  if (result.ok) {
    return { ok: true, status: 200 };
  }
  return {
    ok: false,
    status: result.error?.statusCode ?? 500,
    code: result.error?.code,
    reason: result.error?.reason,
    ...(result.error?.statusCode === undefined
      ? { error: result.error?.message }
      : {}),
  };
}

/** The kit's routes as the delivery's handlers: no parameters, a safe operation, answering `{ ok: true }`. */
function deliveryHandlers(
  routes: Readonly<Record<string, readonly MethodDecorator[]>>,
): Record<string, FixtureHandler> {
  return Object.fromEntries(
    Object.entries(routes).map(([name, decorators]) => [
      name,
      {
        decorators,
        params: [],
        operation: "read",
        handle: () => ({ ok: true }),
      } satisfies FixtureHandler,
    ]),
  );
}

/** The request harness over a PolicyDelivery's real transport. */
export async function deliveryHarness(
  delivery: PolicyDelivery,
  auth: AuthLike,
  options: RequestOptions,
): Promise<RequestHarness> {
  if (options.providers?.length || options.session !== undefined) {
    throw new BetterAuthConfigurationError(
      "CONFORMANCE_DELIVERY_OPTIONS",
      "A policy delivery boots its own application: it takes routes and principal sources only.",
    );
  }
  const probe = await probeOf(auth);
  const logger = options.logger ?? new CapturingLogger();
  const app = await delivery.createApp(deliveryHandlers(options.routes), auth, {
    principals: options.sources ?? [],
    logger,
  });
  const connect = delivery.connect?.bind(delivery);
  // A browser on a trusted page: the probe plugin's origin is trusted on every kit instance.
  const browser = (headers: HeadersInit) => {
    const values = new Headers(headers);
    if (!values.has("origin")) {
      values.set("origin", PROBE_TRUSTED_ORIGIN);
    }
    return values;
  };
  return {
    probe,
    logger,
    request: async (route, headers, input = {}) =>
      deliveredOutcome(
        await delivery.invoke(app, route, browser(headers), input),
      ),
    ...(connect
      ? {
          async connect(headers: HeadersInit): Promise<RequestConnection> {
            const connection = await connect(app, browser(headers));
            return {
              request: async (route, input = {}) =>
                deliveredOutcome(await connection.invoke(route, input)),
              close: () => connection.close(),
            };
          },
        }
      : {}),
    close: () => app.close(),
  };
}

/** Runs `fn` with requests through the in-process guard, or through `delivery`'s transport when given. */
export async function withRequests(
  auth: AuthLike,
  options: RequestOptions,
  fn: (harness: RequestHarness) => Promise<ConformanceOutcome>,
  delivery?: PolicyDelivery,
): Promise<ConformanceOutcome> {
  const value = delivery
    ? await deliveryHarness(delivery, auth, options)
    : await requestHarness(auth, options);
  try {
    return await fn(value);
  } finally {
    resetFaults(value.probe);
    await value.close();
  }
}

export function describeOutcome(outcome: RequestOutcome): string {
  return outcome.ok
    ? "allowed"
    : `${outcome.status} ${outcome.code ?? ""} ${outcome.reason ?? ""} ${outcome.error ? String(outcome.error) : ""}`.trim();
}

// ── Kit identities and credentials ─────────────────────────────────────────

const API_KEY_KIND = "api-key" as PrincipalKind;
export const KIT_KEY_HEADER = "x-conformance-key";
export const KIT_KEY_SOURCE =
  "nestjs-slightly-better-auth:conformance-policy-key";

export interface KitKeys {
  /** Key value → the user it acts for and its grant. */
  readonly keys: Map<string, { userId: string; grant: GrantMap }>;
  verifications: number;
}

type GrantMap = Readonly<Record<string, readonly string[]>>;

function grants(grant: GrantMap, requested: GrantMap): boolean {
  return Object.entries(requested).every(([resource, actions]) =>
    actions.every((action) => grant[resource]?.includes(action)),
  );
}

/** A delegated principal of the kind 'api-key' for a user, whose own grant is `grant`. */
export function kitKeyPrincipal(
  userId: string,
  grant: GrantMap,
): AuthPrincipal {
  return {
    kind: API_KEY_KIND,
    source: KIT_KEY_SOURCE,
    userId,
    delegation: {
      description: "conformance key grant",
      allows: (requested: GrantMap) => grants(grant, requested),
    },
  } as unknown as AuthPrincipal;
}

/** The kit's API-key source: header x-conformance-key, explicit acceptance, delegated principals, counted verifications. */
export function kitKeySource(keys: KitKeys): PrincipalSource {
  const source: PrincipalSource<AuthPrincipalBase> = {
    id: KIT_KEY_SOURCE,
    kinds: [API_KEY_KIND],
    acceptance: "explicit",
    delegates: true,
    credentialHeaders: [KIT_KEY_HEADER],
    appliesTo: (request) => request.headers.has(KIT_KEY_HEADER),
    async resolve(request) {
      const value = request.headers.get(KIT_KEY_HEADER);
      if (!value) {
        return absent();
      }
      keys.verifications++;
      const key = keys.keys.get(value);
      if (!key) {
        return rejected(
          AuthFailures.rejected({ status: 401, reason: "INVALID_API_KEY" }),
        );
      }
      return authenticated(
        kitKeyPrincipal(key.userId, key.grant) as unknown as AuthPrincipalBase,
      );
    },
  };
  return source as unknown as PrincipalSource;
}

interface SdkContext {
  options: {
    plugins?: readonly { id: string }[];
    session?: { cookieCache?: { enabled?: boolean } };
  };
  internalAdapter: {
    deleteUserSessions(userId: string): Promise<void>;
    deleteUser(userId: string): Promise<void>;
    updateUser(userId: string, data: Record<string, unknown>): Promise<unknown>;
  };
  adapter: {
    update(input: {
      model: string;
      where: { field: string; value: unknown }[];
      update: Record<string, unknown>;
    }): Promise<unknown>;
    findOne<T>(input: {
      model: string;
      where: { field: string; value: unknown }[];
    }): Promise<T | null>;
  };
}

export async function sdkContext(auth: AuthLike): Promise<SdkContext> {
  return (await auth.$context) as unknown as SdkContext;
}

export async function hasPlugin(auth: AuthLike, id: string): Promise<boolean> {
  return !!(await sdkContext(auth)).options.plugins?.some(
    (plugin) => plugin.id === id,
  );
}

export async function cookieCacheEnabled(auth: AuthLike): Promise<boolean> {
  return (
    (await sdkContext(auth)).options.session?.cookieCache?.enabled === true
  );
}

/** A stored user with the given fields; `id` pins the user id. */
export async function kitUser(
  auth: AuthLike,
  fields: Record<string, unknown> = {},
): Promise<string> {
  const helpers = await testHelpers(auth);
  return (
    await helpers.saveUser(
      helpers.createUser({
        email: `${globalThis.crypto.randomUUID()}@conformance.example`,
        name: "Conformance",
        ...fields,
      }),
    )
  ).id;
}

function mergeCookies(header: string, setCookies: readonly string[]): string {
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed) {
      cookies.set(trimmed.split("=", 1)[0]!, trimmed);
    }
  }
  for (const line of setCookies) {
    const pair = line.split(";", 1)[0]!.trim();
    cookies.set(pair.split("=", 1)[0]!, pair);
  }
  return [...cookies.values()].join("; ");
}

/**
 * Fresh session headers for a user. `warmCache` adds the signed cookie-cache cookie a session read issues, or returns
 * null when the instance issued none (its session.cookieCache is off).
 */
export async function sessionHeaders(
  auth: AuthLike,
  userId: string,
  options: { warmCache?: boolean } = {},
): Promise<Headers | null> {
  const headers = await authHeadersFor(auth, userId);
  if (!options.warmCache) {
    return headers;
  }
  const result = (await (
    auth.api as unknown as {
      getSession(input: {
        headers: Headers;
        returnHeaders: true;
      }): Promise<{ headers: Headers }>;
    }
  ).getSession({ headers, returnHeaders: true })) as { headers: Headers };
  const setCookies = result.headers.getSetCookie();
  if (!setCookies.some((line) => /session_data=[^;]/.test(line))) {
    return null;
  }
  headers.set("cookie", mergeCookies(headers.get("cookie") ?? "", setCookies));
  return headers;
}

/** A session principal read through Better Auth's getSession for the given headers, as the session source builds it. */
export async function sessionPrincipalOf(
  auth: AuthLike,
  headers: Headers,
): Promise<AuthPrincipal> {
  const session = (await (
    auth.api as unknown as {
      getSession(input: { headers: Headers }): Promise<{
        user: { id: string };
      } | null>;
    }
  ).getSession({ headers })) as { user: { id: string } } | null;
  if (!session) {
    throw new BetterAuthConfigurationError(
      "CONFORMANCE_SESSION_MISSING",
      "The kit could not read the session it created.",
    );
  }
  return {
    kind: "session",
    source: "better-auth:session",
    userId: session.user.id,
    session,
  } as unknown as AuthPrincipal;
}
