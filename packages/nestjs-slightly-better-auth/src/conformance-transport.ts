import assert from "node:assert/strict";
import {
  type ExecutionContext,
  type INestApplication,
  type LoggerService,
  SetMetadata,
  type Type,
  UseGuards,
} from "@nestjs/common";
import { DiscoveryService, ModuleRef, Reflector } from "@nestjs/core";
import type { TestingModuleBuilder } from "@nestjs/testing";
import type {
  AuthorizationPolicy,
  AuthPrincipalBase,
  AuthTransport,
  ClaimOptions,
  ExtensionRef,
  GuardReach,
  PrincipalSource,
  RequirementExpr,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import {
  AcceptPrincipals,
  CurrentPrincipal,
  ForwardAuthCookies,
  OptionalAuth,
  Public,
  Require,
  RequireAuth,
  requirement,
  SkipDefaultRequirements,
  UseBetterAuth,
} from "./auth-decorators.js";
import { AuthFailures, BetterAuthConfigurationError } from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import type { BetterAuthService } from "./auth-service.js";
import {
  MOUNT_COORDINATOR,
  ROUTE_PLANNER,
  TRANSPORT_REGISTRY,
} from "./auth-tokens.js";
import type { AuthLike, AuthPrincipal, PrincipalKind } from "./auth-types.js";
import { allow, deny } from "./authorization-evaluator.js";
import { EXTENSION_DEFINITION } from "./bridge-protocol.js";
import {
  bootIssueCodes,
  CapturingLogger,
  type ConformanceCase,
  conformanceCase,
  conformanceSkip,
  type ConformanceOutcome,
  type ConformanceSkip,
  createConformanceAuth,
  kitIdentity,
  type KitIdentity,
  PROBE_TRUSTED_ORIGIN,
  KIT_BASE_URL,
  probeOf,
  type ProbeState,
  settle,
  UNTRUSTED_ORIGIN,
} from "./conformance-fixtures.js";
import {
  ACTIVE_ORGANIZATION_ID,
  ActiveOrganizationId,
} from "./organization.js";
import { absent, authenticated, rejected } from "./principal-resolver.js";
import { CurrentSession } from "./session-principal.js";
import type { MountCoordinator } from "./mount-coordinator.js";
import type { RoutePlanner } from "./route-planner.js";
import { overrideAuthGuard } from "./testing.js";
import type { TransportRegistry } from "./transport-registry.js";

export type InvocationShape =
  | "aliases"
  | "batched"
  | "messages"
  | "subscriptions";

/** One fixture handler the kit supplies; the harness exposes it as a controller route, resolver field, gateway message or message pattern. */
export interface FixtureHandler {
  /** Method decorators to apply, in order (access, acceptance, requirements). */
  readonly decorators: readonly MethodDecorator[];
  /** Parameter decorators by parameter index, e.g. [CurrentSession()]. */
  readonly params: readonly ParameterDecorator[];
  /** 'read': HTTP GET, GraphQL query, RPC request. 'unsafe': HTTP POST, GraphQL mutation. WS messages are always enforced. */
  readonly operation: "read" | "unsafe";
  /** Handler body: receives the decorated parameter values, the invocation input and the harness context; its result is the response. */
  handle(
    params: readonly unknown[],
    input: Record<string, unknown>,
    context: FixtureContext,
  ): unknown;
}

/** What the harness hands every fixture handler. */
export interface FixtureContext {
  /** The default instance's service (BETTER_AUTH_SERVICE). */
  readonly service: BetterAuthService;
}

/** GraphQL shapes only: one object type FixtureNode, returned by three root fields and carrying the field resolvers below. */
export interface GraphFixtures {
  readonly roots: {
    readonly public: FixtureHandler;
    readonly sessionOnly: FixtureHandler;
    readonly mixed: FixtureHandler;
  };
  readonly fields: {
    readonly plain: FixtureHandler;
    readonly publicNested: FixtureHandler;
    readonly reader: FixtureHandler;
    readonly guarded?: FixtureHandler;
    readonly nestedReader?: FixtureHandler;
    readonly sessionReader: FixtureHandler;
  };
  /** Federation shapes only: @ResolveReference() of FixtureNode, with the kit's per-representation requirement on `orgId`. */
  readonly reference?: FixtureHandler;
}

export interface GraphSelection {
  readonly root: keyof GraphFixtures["roots"];
  readonly fields: readonly (keyof GraphFixtures["fields"])[];
}

/**
 * The fixture handlers of transportConformance, by name (the `handler` argument of invoke()). Harnesses expose each
 * input field as the transport's named input, so ctx.param(name) reads input[name] (HTTP: route param or query).
 * `triple` and `tripleMixed` are three distinct handler methods; invoke() runs all three in one logical request when
 * the transport can, otherwise the first one.
 */
export interface TransportFixtures {
  readonly required: FixtureHandler;
  readonly optional: FixtureHandler;
  readonly public: FixtureHandler;
  readonly forbidden: FixtureHandler;
  readonly triple: readonly [FixtureHandler, FixtureHandler, FixtureHandler];
  readonly tripleMixed: readonly [
    FixtureHandler,
    FixtureHandler,
    FixtureHandler,
  ];
  readonly readsSession: FixtureHandler;
  /** @AcceptPrincipals('session', 'api-key'), returns service.getSession() (T-reads-session). */
  readonly readsSessionService: FixtureHandler;
  readonly unsafe: FixtureHandler;
  readonly loginProxy: FixtureHandler;
  /** @Public() @ForwardAuthCookies(), operation 'read' (HTTP GET), calls service.api.signInEmail (T-csrf-login-proxy, T-csrf-safe-methods). */
  readonly loginProxyRead: FixtureHandler;
  readonly loginProxyService: FixtureHandler;
  readonly publicService: FixtureHandler;
  readonly acceptsApiKey: FixtureHandler;
  readonly org: FixtureHandler;
  readonly inherited: FixtureHandler;
  readonly unguarded: FixtureHandler;
  /** GraphQL shapes only; other harnesses ignore it. */
  readonly graph: GraphFixtures;
}

export interface TransportInvocationResult {
  ok: boolean;
  body?: unknown;
  error?: {
    code?: string;
    statusCode?: number;
    reason?: string;
    message?: string;
  };
  setCookies: string[];
}

export interface GraphResult {
  /** The operation's data, keyed like the selection: data[root][field]. */
  data: unknown;
  errors: readonly {
    path: readonly (string | number)[];
    code?: string;
    reason?: string;
    message?: string;
  }[];
}

export interface TransportConformanceOptions {
  transport: ExtensionRef<AuthTransport>;
  /**
   * Boots an app exposing the kit's fixture handlers in the transport's shape, with BetterAuthModule's globalGuard as
   * given. Pass `principals` to BetterAuthModule (the kit's API-key source), and `defaultRequirements` and
   * `globalScope` when set. With `override`, boot through Test.createTestingModule() and pass the builder through it
   * before compile(). Apply every fixture decorator the kit supplies, including its SetMetadata() marker. The app is
   * closed by the kit.
   */
  createApp(
    fixtures: TransportFixtures,
    auth: AuthLike,
    options: {
      globalGuard: boolean;
      override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
      defaultRequirements?: readonly RequirementExpr[];
      /** GraphQL shapes: the fieldResolverEnhancers to serve 'graph' with; the kit boots GraphQL cases with [] and ['guards', 'interceptors']. */
      fieldResolverEnhancers?: readonly ("guards" | "interceptors")[];
      /** GraphQL shapes: serve 'graph' from a federation subgraph (FixtureNode an entity keyed by id, with GraphFixtures.reference when given). */
      federation?: boolean;
      /** Principal sources for BetterAuthModule's `principals`: the kit's API-key source. */
      principals?: readonly ExtensionRef<PrincipalSource>[];
      /** BetterAuthModule's globalScope; unset keeps the module default (T-coverage-claims). */
      globalScope?: boolean;
      /** Register BetterAuthGuard as APP_GUARD and BetterAuthScopeInterceptor as APP_INTERCEPTOR yourself (with globalGuard: false; T-coverage-claims). */
      appEnhancers?: boolean;
      /** The logger the app uses from boot on (e.g. createNestApplication(adapter, { logger }) or moduleRef.useLogger(logger)): cases assert boot warnings. */
      logger?: LoggerService;
    },
  ): Promise<INestApplication>;
  /** Invokes a fixture handler with given credentials and browser headers; returns the transport-native outcome. */
  invoke(
    app: INestApplication,
    handler: Exclude<keyof TransportFixtures, "graph">,
    headers: HeadersInit,
    input?: Record<string, unknown>,
  ): Promise<TransportInvocationResult>;
  /**
   * Two invocations of the 'org' fixture in ONE logical request or connection, with different inputs. Required when
   * the transport has a lineage: the multiple-invocation cases then fail without it, and are skipped with a reason
   * for other transports.
   */
  invokeTwice?(
    app: INestApplication,
    shape: InvocationShape,
    inputs: [Record<string, unknown>, Record<string, unknown>],
    headers: HeadersInit,
  ): Promise<
    [
      { ok: boolean; error?: { reason?: string } },
      { ok: boolean; error?: { reason?: string } },
    ]
  >;
  /** Shapes invokeTwice can produce; required with it. */
  invocationShapes?: readonly InvocationShape[];
  /**
   * GraphQL shapes: one operation over HTTP selecting the given root fields of fixtures.graph, each with the given
   * FixtureNode fields. `delays` states the order in which the kit's session and API-key sources settle; the kit
   * applies it to its own sources, so a harness may ignore it. Required when the transport nests handlers
   * (defaultAccessFor): the GraphQL cases then fail without it, and are skipped with a reason for other transports.
   */
  invokeGraph?(
    app: INestApplication,
    selection: readonly GraphSelection[],
    headers: HeadersInit,
    options?: {
      delays?: { readonly session: number; readonly apiKey: number };
    },
  ): Promise<GraphResult>;
  /**
   * Federation shapes only: one `_entities` query for the given representations of FixtureNode. Required when the
   * transport claims the kit's reference resolver in a federation boot: T-reference-resolver then fails without it,
   * and is skipped with a reason for other transports.
   */
  invokeEntities?(
    app: INestApplication,
    representations: readonly Record<string, unknown>[],
    fields: readonly (keyof GraphFixtures["fields"])[],
    headers: HeadersInit,
  ): Promise<GraphResult>;
  expectCookieCapable: boolean;
  /** Whether the transport has a browser leg (false for RPC): enables the T-csrf-* cases. */
  expectBrowserLeg: boolean;
}

const KEY_SOURCE_ID = "nestjs-slightly-better-auth:conformance-api-key";
const ALLOWED_ORGS = new Set(["org-a", "org-a2"]);
const SESSION_KIND = "session" as PrincipalKind;
const API_KEY_KIND = "api-key" as PrincipalKind;

interface KitKeys {
  readonly valid: string;
  readonly limited: string;
  verifications: number;
  /** The user the valid key acts for. */
  owner: string;
  /** Milliseconds the source waits before answering (T-stamp-per-plan settle order). */
  delayMs: number;
}

function keySource(keys: KitKeys): PrincipalSource<AuthPrincipalBase> {
  return {
    id: KEY_SOURCE_ID,
    kinds: [API_KEY_KIND],
    acceptance: "explicit",
    delegates: true,
    credentialHeaders: ["x-api-key"],
    appliesTo: (request) => request.headers.has("x-api-key"),
    async resolve(request) {
      const value = request.headers.get("x-api-key");
      if (!value) {
        return absent();
      }
      keys.verifications++;
      if (keys.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, keys.delayMs));
      }
      if (value === keys.limited) {
        return rejected(
          AuthFailures.rejected({
            status: 429,
            reason: "RATE_LIMITED",
            retryAfterSeconds: 7,
          }),
        );
      }
      if (value !== keys.valid) {
        return rejected(
          AuthFailures.rejected({ status: 401, reason: "INVALID_API_KEY" }),
        );
      }
      return authenticated({
        kind: API_KEY_KIND,
        source: KEY_SOURCE_ID,
        userId: keys.owner,
        delegation: {
          description: "conformance key grant",
          allows: () => false,
        },
      });
    },
  };
}

const denyPolicy: AuthorizationPolicy<Record<string, never>> = {
  id: "nestjs-slightly-better-auth:conformance/deny",
  evaluate: () => deny({ reason: "CONFORMANCE_DENIED" }),
};
// The kit's own organization policy, not orgPermission(): it decides from the invocation's orgId input alone, so
// every transport can run T-invocation-decisions without the organization plugin and its data.
const orgPolicy: AuthorizationPolicy<Record<string, never>> = {
  id: "nestjs-slightly-better-auth:conformance/organization",
  requires: { principals: [SESSION_KIND] },
  async evaluate(_params, context) {
    const organization = context.param("orgId");
    if (typeof organization !== "string" || !organization) {
      return deny({ reason: "ORGANIZATION_REQUIRED" });
    }
    if (!ALLOWED_ORGS.has(organization)) {
      return deny({ reason: "MISSING_PERMISSION" });
    }
    context.provide(ACTIVE_ORGANIZATION_ID, organization);
    return allow();
  },
};
const kindsPolicy = (
  id: string,
  principals: readonly PrincipalKind[] | undefined,
): AuthorizationPolicy<Record<string, never>> => ({
  id: `nestjs-slightly-better-auth:conformance/${id}`,
  ...(principals ? { requires: { principals } } : {}),
  evaluate: () => allow(),
});
const sessionOnly = requirement(
  kindsPolicy("session-only", [SESSION_KIND]),
  {},
);
const apiKeyOnly = requirement(kindsPolicy("api-key-only", [API_KEY_KIND]), {});
const sessionOrKey = requirement(
  kindsPolicy("session-or-key", [SESSION_KIND, API_KEY_KIND]),
  {},
);
const unnamedKinds = requirement(kindsPolicy("unnamed-kinds", undefined), {});

function view(principal: unknown): unknown {
  const value = principal as AuthPrincipal | null | undefined;
  return value ? { kind: value.kind, userId: value.userId } : null;
}

function handler(
  decorators: readonly MethodDecorator[],
  params: readonly ParameterDecorator[],
  operation: "read" | "unsafe",
  handle: FixtureHandler["handle"],
): FixtureHandler {
  return { decorators, params, operation, handle };
}

async function signIn(
  service: BetterAuthService,
  input: Record<string, unknown>,
): Promise<void> {
  await (
    service.api as unknown as {
      signInEmail(input: {
        body: { email: string; password: string };
      }): Promise<unknown>;
    }
  ).signInEmail({
    body: { email: String(input.email), password: String(input.password) },
  });
}

function principalHandler(
  decorators: readonly MethodDecorator[] = [],
  operation: "read" | "unsafe" = "read",
): FixtureHandler {
  return handler(
    decorators,
    [CurrentPrincipal()],
    operation,
    ([principal]) => ({
      principal: view(principal),
    }),
  );
}

/** Marks each fixture handler with its fixture name, so the kit can map claims and boot reports to fixtures. */
const FIXTURE_METADATA = "nestjs-slightly-better-auth:conformance-fixture";

type FixtureName = Exclude<keyof TransportFixtures, "graph">;

interface GraphBoot {
  /** Include `guarded` and `nestedReader` (the ['guards', 'interceptors'] boots only). */
  readonly guarded?: boolean;
  /** Include the federation `reference` fixture. */
  readonly reference?: boolean;
}

/**
 * The kit's fixture handlers; `extra` appends decorators to named handlers and `everyHandler` to all of them for boot
 * variants. `graph` selects the GraphQL fixtures a boot may serve: `guarded` fails a [] boot (FIELD_RESOLVER_UNGUARDED)
 * and `reference` belongs to federation boots, so both are left out unless asked for.
 */
function kitFixtures(
  extra: Partial<Record<FixtureName, MethodDecorator[]>> = {},
  everyHandler: MethodDecorator[] = [],
  graph: GraphBoot = {},
): TransportFixtures {
  const withExtra = (
    name: FixtureName,
    fixture: FixtureHandler,
    marker: string = name,
  ): FixtureHandler => ({
    ...fixture,
    decorators: [
      SetMetadata(FIXTURE_METADATA, marker),
      ...fixture.decorators,
      ...(extra[name] ?? []),
      ...everyHandler,
    ],
  });
  const plain = () => handler([], [], "read", () => ({ ok: true }));
  const reader = handler([], [CurrentPrincipal()], "read", ([principal]) => ({
    principal: view(principal),
  }));
  const loginProxy = (operation: "read" | "unsafe") =>
    handler(
      [Public(), ForwardAuthCookies()],
      [],
      operation,
      async (_params, input, { service }) => {
        await signIn(service, input);
        return { signedIn: true };
      },
    );
  return {
    required: withExtra("required", principalHandler()),
    optional: withExtra("optional", principalHandler([OptionalAuth()])),
    public: withExtra(
      "public",
      handler([Public()], [], "read", () => ({ public: true })),
    ),
    forbidden: withExtra(
      "forbidden",
      handler([Require(requirement(denyPolicy, {}))], [], "read", () => ({
        reached: true,
      })),
    ),
    triple: [
      withExtra("triple", plain(), "triple0"),
      withExtra("triple", plain(), "triple1"),
      withExtra("triple", plain(), "triple2"),
    ],
    tripleMixed: [
      withExtra("tripleMixed", plain(), "tripleMixed0"),
      withExtra(
        "tripleMixed",
        handler(
          [AcceptPrincipals(SESSION_KIND, API_KEY_KIND)],
          [],
          "read",
          () => ({
            ok: true,
          }),
        ),
        "tripleMixed1",
      ),
      withExtra("tripleMixed", plain(), "tripleMixed2"),
    ],
    readsSession: withExtra(
      "readsSession",
      handler(
        [],
        [CurrentSession()],
        "read",
        async ([session], _input, { service }) => ({
          userId:
            (session as { user?: { id?: string } } | null)?.user?.id ?? null,
          service: (await service.getPrincipal())?.userId ?? null,
        }),
      ),
    ),
    readsSessionService: withExtra(
      "readsSessionService",
      handler(
        [AcceptPrincipals(SESSION_KIND, API_KEY_KIND)],
        [],
        "read",
        async (_params, _input, { service }) => ({
          userId:
            (
              (await service.getSession()) as {
                user?: { id?: string };
              } | null
            )?.user?.id ?? null,
        }),
      ),
    ),
    unsafe: withExtra("unsafe", principalHandler([], "unsafe")),
    loginProxy: withExtra("loginProxy", loginProxy("unsafe")),
    loginProxyRead: withExtra("loginProxyRead", loginProxy("read")),
    loginProxyService: withExtra(
      "loginProxyService",
      handler([Public()], [], "unsafe", async (_params, input, { service }) => {
        await service.forwardForeignCookies(() => signIn(service, input));
        return { signedIn: true };
      }),
    ),
    publicService: withExtra(
      "publicService",
      handler(
        [Public()],
        [],
        "unsafe",
        async (_params, _input, { service }) => ({
          session: await service.getSession(),
        }),
      ),
    ),
    acceptsApiKey: withExtra(
      "acceptsApiKey",
      principalHandler([AcceptPrincipals(SESSION_KIND, API_KEY_KIND)]),
    ),
    org: withExtra(
      "org",
      handler(
        [Require(requirement(orgPolicy, {}))],
        [ActiveOrganizationId()],
        "read",
        ([organization], input) => {
          if (organization !== input.orgId) {
            throw new Error(
              `ActiveOrganizationId answered ${String(organization)} for ${String(input.orgId)}`,
            );
          }
          return { organization };
        },
      ),
    ),
    inherited: withExtra("inherited", plain()),
    unguarded: withExtra(
      "unguarded",
      handler([], [CurrentSession(), ActiveOrganizationId()], "read", () => ({
        reached: true,
      })),
    ),
    graph: {
      roots: {
        public: handler([Public()], [], "read", () => ({ id: "public" })),
        sessionOnly: handler([], [CurrentPrincipal()], "read", ([p]) => ({
          id: "session",
          principal: view(p),
        })),
        mixed: handler(
          [AcceptPrincipals(SESSION_KIND, API_KEY_KIND)],
          [CurrentPrincipal()],
          "read",
          ([p]) => ({ id: "mixed", principal: view(p) }),
        ),
      },
      fields: {
        plain: handler([], [], "read", () => "plain"),
        publicNested: handler([Public()], [], "read", () => ({
          id: "nested",
        })),
        reader,
        ...(graph.guarded
          ? {
              guarded: handler(
                [RequireAuth()],
                [CurrentPrincipal()],
                "read",
                ([p]) => ({ id: "guarded", principal: view(p) }),
              ),
              nestedReader: reader,
            }
          : {}),
        sessionReader: handler(
          [],
          [CurrentSession()],
          "read",
          ([session]) =>
            (session as { user?: { id?: string } } | null)?.user?.id ?? null,
        ),
      },
      ...(graph.reference
        ? {
            reference: handler(
              [
                SetMetadata(FIXTURE_METADATA, "reference"),
                Require(requirement(orgPolicy, {})),
              ],
              [],
              "read",
              (_params, input) => ({ id: input.id, orgId: input.orgId }),
            ),
          }
        : {}),
    },
  };
}

interface Instrumentation {
  readonly consumed: string[];
  readonly contexts: ExecutionContext[];
  unavailable: boolean;
}

/** Wraps the registry's describe() so request-dependent getters are counted and can be made unavailable. */
function instrument(app: INestApplication): Instrumentation {
  const registry = app.get<TransportRegistry>(TRANSPORT_REGISTRY, {
    strict: false,
  });
  const state: Instrumentation = {
    consumed: [],
    contexts: [],
    unavailable: false,
  };
  const original = registry.describe.bind(registry);
  registry.describe = (context, transport) => {
    const call = original(context, transport);
    state.contexts.push(context);
    const read = <T>(name: string, get: () => T): T => {
      state.consumed.push(name);
      if (state.unavailable) {
        throw BetterAuthConfigurationError.atRequest(
          "CONFORMANCE_EXTRACTION_UNAVAILABLE",
          "The conformance kit made request extraction unavailable",
        );
      }
      return get();
    };
    const wrapped: TransportCall = {
      key: call.key,
      invocation: call.invocation,
      connection: call.connection,
      principalTtlMs: call.principalTtlMs,
      lineage: call.lineage,
      param: (name) => call.param(name),
      headers: () => read("headers", () => call.headers()),
      get clientIp() {
        return read("clientIp", () => call.clientIp);
      },
      get cookies() {
        return read("cookies", () => call.cookies);
      },
      get request() {
        return read("request", () => call.request);
      },
      get browser() {
        return read("browser", () => call.browser);
      },
    };
    return wrapped;
  };
  return state;
}

function resolvedTransport(
  app: INestApplication,
  ref: ExtensionRef<AuthTransport>,
): AuthTransport {
  const list = app
    .get<TransportRegistry>(TRANSPORT_REGISTRY, { strict: false })
    .list();
  const id =
    ref && typeof ref === "object" && !(EXTENSION_DEFINITION in ref)
      ? (ref as AuthTransport).id
      : undefined;
  // Harnesses register the transport first; core appends the HTTP transport.
  const found =
    list.find((transport) => transport === ref) ??
    (typeof ref === "function"
      ? list.find((transport) => transport instanceof ref)
      : undefined) ??
    (id === undefined
      ? undefined
      : list.find((transport) => transport.id === id)) ??
    list[0];
  assert.ok(found, "no transport is registered");
  return found;
}

/**
 * Whether a transport member is known without booting: a transport object answers for itself, a class only when its
 * prototype defines the member (instance fields are unknown), and a definition never. Undefined means unknown.
 */
function staticMember(
  ref: ExtensionRef<AuthTransport>,
  name: keyof AuthTransport,
): boolean | undefined {
  if (typeof ref === "function") {
    return typeof Reflect.get(ref.prototype as object, name) === "function"
      ? true
      : undefined;
  }
  if (ref && typeof ref === "object" && !(EXTENSION_DEFINITION in ref)) {
    return typeof Reflect.get(ref, name) === "function";
  }
  return undefined;
}

interface KitEnv {
  readonly auth: AuthLike;
  readonly probe: ProbeState;
  readonly keys: KitKeys;
  readonly identity: KitIdentity;
  readonly source: PrincipalSource<AuthPrincipalBase>;
  sessionCookieName(): Promise<string>;
}

async function environment(): Promise<KitEnv> {
  const auth = createConformanceAuth();
  const probe = await probeOf(auth);
  const identity = await kitIdentity(auth);
  const keys: KitKeys = {
    valid: `key-${globalThis.crypto.randomUUID()}`,
    limited: `limited-${globalThis.crypto.randomUUID()}`,
    verifications: 0,
    owner: identity.userId,
    delayMs: 0,
  };
  return {
    auth,
    probe,
    keys,
    identity,
    source: keySource(keys),
    async sessionCookieName() {
      const context = (await auth.$context) as {
        authCookies: { sessionToken: { name: string } };
      };
      return context.authCookies.sessionToken.name;
    },
  };
}

interface Booted {
  readonly app: INestApplication;
  /** Everything the app logged, from boot on when the harness applies the `logger` option. */
  readonly logger: CapturingLogger;
  readonly instrumentation: Instrumentation;
}

type GraphEnhancers = readonly ("guards" | "interceptors")[];

interface BootOptions {
  fixtures?: TransportFixtures;
  globalGuard?: boolean;
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  defaultRequirements?: readonly RequirementExpr[];
  fieldResolverEnhancers?: GraphEnhancers;
  federation?: boolean;
  globalScope?: boolean;
  appEnhancers?: boolean;
}

async function withApp(
  options: TransportConformanceOptions,
  env: KitEnv,
  fn: (booted: Booted) => Promise<void>,
  boot: BootOptions = {},
  logger = new CapturingLogger(),
): Promise<void> {
  const app = await options.createApp(
    boot.fixtures ?? kitFixtures(),
    env.auth,
    {
      globalGuard: boot.globalGuard ?? true,
      principals: [env.source as unknown as PrincipalSource],
      logger,
      ...(boot.override ? { override: boot.override } : {}),
      ...(boot.defaultRequirements
        ? { defaultRequirements: boot.defaultRequirements }
        : {}),
      ...(boot.fieldResolverEnhancers
        ? { fieldResolverEnhancers: boot.fieldResolverEnhancers }
        : {}),
      ...(boot.federation ? { federation: true } : {}),
      ...(boot.globalScope === undefined
        ? {}
        : { globalScope: boot.globalScope }),
      ...(boot.appEnhancers ? { appEnhancers: true } : {}),
    },
  );
  app.useLogger(logger);
  try {
    await fn({ app, logger, instrumentation: instrument(app) });
  } finally {
    await app.close();
  }
}

async function bootFailure(
  options: TransportConformanceOptions,
  env: KitEnv,
  boot: BootOptions,
): Promise<unknown> {
  const result = await settle(() =>
    withApp(options, env, async () => undefined, boot),
  );
  assert.equal(result.ok, false, "the boot variant booted");
  return !result.ok && result.error;
}

async function expectBootFailure(
  options: TransportConformanceOptions,
  env: KitEnv,
  boot: BootOptions,
  code: string | readonly string[],
): Promise<void> {
  const expected = typeof code === "string" ? [code] : code;
  const error = await bootFailure(options, env, boot);
  const codes = bootIssueCodes(error);
  assert.ok(
    expected.some(
      (value) => codes.includes(value) || String(error).includes(value),
    ),
    `expected ${expected.join(" or ")}, got ${codes.join(", ")}: ${String(error)}`,
  );
}

/** Stable codes of the WARN entries a logger captured (`CODE: message`). */
function warningCodes(logger: CapturingLogger): Set<string> {
  return new Set(
    logger.entries
      .filter((entry) => entry.level === "warn")
      .map((entry) => /^([A-Z][A-Z0-9_]+):/.exec(entry.text)?.[1])
      .filter((code): code is string => code !== undefined),
  );
}

interface RecordedClaim {
  // biome-ignore lint/complexity/noBannedTypes: Nest metadata accepts class and function targets.
  readonly target: Function;
  readonly method: string | undefined;
  readonly reach: GuardReach;
  readonly options: ClaimOptions;
  /** The kit fixture the claimed handler serves, from its SetMetadata() marker. */
  readonly fixture: string | undefined;
}

/** The claims the transport makes for a booted app, recorded by running its validate() once more. */
async function recordClaims(
  app: INestApplication,
  ref: ExtensionRef<AuthTransport>,
): Promise<RecordedClaim[]> {
  const transport = resolvedTransport(app, ref);
  const claims: RecordedClaim[] = [];
  const planner = app.get<RoutePlanner>(ROUTE_PLANNER, { strict: false });
  await transport.validate?.({
    discovery: app.get(DiscoveryService, { strict: false }),
    reflector: app.get(Reflector, { strict: false }),
    moduleRef: app.get(ModuleRef, { strict: false }),
    hasHttpAdapter:
      app.get<MountCoordinator>(MOUNT_COORDINATOR, { strict: false })
        .adapter !== null,
    planOf: (target, method) => planner.plan(target as Type, method),
    claim: (target, method, reach, options) => {
      const handler: unknown =
        method === undefined
          ? undefined
          : Reflect.get(target.prototype as object, method);
      const fixture =
        typeof handler === "function"
          ? (Reflect.getMetadata(FIXTURE_METADATA, handler) as
              | string
              | undefined)
          : undefined;
      claims.push({ target, method, reach, options, fixture });
    },
    logger: new CapturingLogger(),
  });
  return claims;
}

/**
 * Whether the transport has a member, resolved through one boot when a class or definition leaves it unknown. The
 * kit's multiple-invocation and GraphQL cases apply to transports with `lineage` and `defaultAccessFor`.
 */
async function transportHas(
  options: TransportConformanceOptions,
  env: KitEnv,
  member: "lineage" | "defaultAccessFor",
): Promise<boolean> {
  const known = staticMember(options.transport, member);
  if (known !== undefined) {
    return known;
  }
  let found = false;
  await withApp(options, env, async ({ app }) => {
    found =
      typeof resolvedTransport(app, options.transport)[member] === "function";
  });
  return found;
}

function sessionReads(probe: ProbeState, from: number): number {
  return probe.calls.slice(from).filter((path) => path === "/get-session")
    .length;
}

function denied(
  result: TransportInvocationResult,
  status: number,
  reason?: string,
): void {
  assert.equal(
    result.ok,
    false,
    `expected a ${status} denial, got success: ${JSON.stringify(result.body)}`,
  );
  assert.equal(
    result.error?.statusCode,
    status,
    `expected ${status}, got ${JSON.stringify(result.error)}`,
  );
  if (reason !== undefined) {
    assert.equal(result.error?.reason, reason, JSON.stringify(result.error));
  }
}

function internal(result: TransportInvocationResult): void {
  assert.equal(result.ok, false, "expected a generic internal error");
  const status = result.error?.statusCode;
  assert.ok(
    status === undefined || status >= 500,
    `expected a 5xx, got ${JSON.stringify(result.error)}`,
  );
}

function succeeded(result: TransportInvocationResult, label = ""): void {
  assert.equal(
    result.ok,
    true,
    `${label ? `${label}: ` : ""}expected success, got ${JSON.stringify(result.error)}`,
  );
}

function principalOf(result: TransportInvocationResult) {
  return (result.body as { principal?: { kind?: string; userId?: string } })
    ?.principal;
}

const foreignContext = {
  getType: () => "nestjs-slightly-better-auth:conformance-foreign",
  getArgs: () => [{}],
  getArgByIndex: () => ({}),
  getClass: () => Object,
  getHandler: () => function foreign() {},
  switchToHttp: () => ({
    getRequest: () => ({}),
    getResponse: () => ({}),
    getNext: () => undefined,
  }),
  switchToRpc: () => ({ getData: () => ({}), getContext: () => ({}) }),
  switchToWs: () => ({
    getData: () => ({}),
    getClient: () => ({}),
    getPattern: () => "",
  }),
} as unknown as ExecutionContext;

/**
 * The transport kit (invariants T1–T11 and the core behavior every transport exposes). The kit owns the Better Auth
 * instance, a kit API-key source (passed as `principals`), kit policies and the fixture handlers; the harness exposes
 * the fixtures in its transport's shape. Applicability comes from the transport, not from the helpers a harness
 * passes: a transport with a lineage needs invokeTwice, one that nests handlers (defaultAccessFor) needs invokeGraph,
 * and one that claims the kit's federation reference resolver needs invokeEntities. The kit reads those members from
 * a transport object directly and boots once for a class or a definition.
 */
export function transportConformance(
  options: TransportConformanceOptions,
): ConformanceCase[] {
  const cases: ConformanceCase[] = [];
  const add = (
    id: string,
    title: string,
    run: (env: KitEnv) => Promise<ConformanceOutcome>,
    skip?: string,
  ) =>
    cases.push(
      conformanceCase(id, title, async () => run(await environment()), skip),
    );
  const noBrowser = options.expectBrowserLeg
    ? undefined
    : "the transport declares no browser leg";
  const noLineage = "the transport has no lineage and gives no invokeTwice";
  const noNesting = "the transport nests no handlers and gives no invokeGraph";
  const twiceSkip =
    !options.invokeTwice && staticMember(options.transport, "lineage") === false
      ? noLineage
      : undefined;
  const graphSkip =
    !options.invokeGraph &&
    staticMember(options.transport, "defaultAccessFor") === false
      ? noNesting
      : undefined;
  /** Undefined when invokeTwice is given; fails when the transport has a lineage without it. */
  const twiceReady = async (
    env: KitEnv,
  ): Promise<ConformanceSkip | undefined> => {
    if (options.invokeTwice) {
      assert.ok(
        options.invocationShapes?.length,
        "invokeTwice requires invocationShapes",
      );
      return undefined;
    }
    assert.equal(
      await transportHas(options, env, "lineage"),
      false,
      "the transport has a lineage, so invokeTwice and invocationShapes are required",
    );
    return conformanceSkip(noLineage);
  };
  /** Undefined when invokeGraph is given; fails when the transport nests handlers without it. */
  const graphReady = async (
    env: KitEnv,
  ): Promise<ConformanceSkip | undefined> => {
    if (options.invokeGraph) {
      return undefined;
    }
    assert.equal(
      await transportHas(options, env, "defaultAccessFor"),
      false,
      "the transport nests handlers (defaultAccessFor), so invokeGraph is required",
    );
    return conformanceSkip(noNesting);
  };
  const enhancerBoots: readonly GraphEnhancers[] = [
    [],
    ["guards", "interceptors"],
  ];
  const cookie = (env: KitEnv) => ({ cookie: env.identity.cookie });

  add(
    "T-selection",
    "handles() accepts its contexts with and without credentials and rejects foreign ones",
    (env) =>
      withApp(options, env, async ({ app, instrumentation }) => {
        succeeded(await options.invoke(app, "optional", {}));
        succeeded(await options.invoke(app, "optional", cookie(env)));
        assert.ok(
          instrumentation.contexts.length >= 2,
          "the guard described no invocation",
        );
        const transport = resolvedTransport(app, options.transport);
        const registry = app.get<TransportRegistry>(TRANSPORT_REGISTRY, {
          strict: false,
        });
        for (const context of instrumentation.contexts) {
          assert.equal(transport.handles(context), true);
          assert.equal(
            registry.find(context),
            transport,
            "another registered transport claimed the context first",
          );
        }
        assert.equal(transport.handles(foreignContext), false);
      }),
  );
  add(
    "T-no-credentials",
    "missing credentials answer 401 UNAUTHENTICATED without throwing from headers()",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const result = await options.invoke(app, "required", {});
        denied(result, 401);
        assert.equal(result.error?.code, "UNAUTHENTICATED");
        succeeded(await options.invoke(app, "public", {}));
      }),
  );
  add(
    "T-credentials",
    "cookie, bearer and x-api-key credentials are extracted",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const byCookie = await options.invoke(app, "required", cookie(env));
        succeeded(byCookie);
        assert.deepEqual(principalOf(byCookie), {
          kind: "session",
          userId: env.identity.userId,
        });
        const byBearer = await options.invoke(app, "required", {
          authorization: `Bearer ${env.identity.token}`,
        });
        succeeded(byBearer);
        assert.equal(principalOf(byBearer)?.userId, env.identity.userId);
        const byKey = await options.invoke(app, "acceptsApiKey", {
          "x-api-key": env.keys.valid,
        });
        succeeded(byKey);
        assert.equal(principalOf(byKey)?.kind, "api-key");
      }),
  );
  add(
    "T-memo-once",
    "one logical request resolves each accepted-kind set at most once",
    (env) =>
      withApp(options, env, async ({ app }) => {
        let from = env.probe.calls.length;
        succeeded(await options.invoke(app, "triple", cookie(env)));
        assert.ok(
          sessionReads(env.probe, from) <= 1,
          `triple read the session ${sessionReads(env.probe, from)} times`,
        );
        from = env.probe.calls.length;
        succeeded(await options.invoke(app, "tripleMixed", cookie(env)));
        assert.ok(sessionReads(env.probe, from) <= 2);
        for (const shape of options.invocationShapes ?? []) {
          if (shape !== "aliases" && shape !== "batched") {
            continue;
          }
          from = env.probe.calls.length;
          await options.invokeTwice!(
            app,
            shape,
            [{ orgId: "org-a" }, { orgId: "org-a2" }],
            cookie(env),
          );
          assert.equal(
            sessionReads(env.probe, from),
            1,
            `two ${shape} invocations of one request resolved the principal ${sessionReads(env.probe, from)} times`,
          );
        }
      }),
  );
  add(
    "T-invocation-decisions",
    "two invocations in one request or connection are decided and valued independently",
    async (env) =>
      (await twiceReady(env)) ??
      withApp(options, env, async ({ app }) => {
        for (const shape of options.invocationShapes!) {
          const [first, second] = await options.invokeTwice!(
            app,
            shape,
            [{ orgId: "org-a" }, { orgId: "org-b" }],
            cookie(env),
          );
          assert.equal(first.ok, true, `${shape}: the allowed org was denied`);
          assert.equal(
            second.error?.reason,
            "MISSING_PERMISSION",
            `${shape}: the second invocation was not decided independently (${JSON.stringify(second)})`,
          );
          const [deniedFirst, allowedSecond] = await options.invokeTwice!(
            app,
            shape,
            [{ orgId: "org-b" }, { orgId: "org-a" }],
            cookie(env),
          );
          assert.equal(deniedFirst.error?.reason, "MISSING_PERMISSION");
          assert.equal(
            allowedSecond.ok,
            true,
            `${shape}: the second invocation was not decided independently (${JSON.stringify(allowedSecond)})`,
          );
          const values = await options.invokeTwice!(
            app,
            shape,
            [{ orgId: "org-a" }, { orgId: "org-a2" }],
            cookie(env),
          );
          assert.deepEqual(
            values.map((value) => value.ok),
            [true, true],
            `${shape}: @ActiveOrganizationId() did not return each invocation's own organization`,
          );
        }
      }),
    twiceSkip,
  );
  add(
    "T-acceptance",
    "an x-api-key on a route that does not accept api keys is never verified",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const withCookie = await options.invoke(app, "required", {
          ...cookie(env),
          "x-api-key": env.keys.valid,
        });
        succeeded(withCookie);
        assert.equal(principalOf(withCookie)?.kind, "session");
        denied(
          await options.invoke(app, "required", {
            "x-api-key": env.keys.valid,
          }),
          401,
        );
        assert.equal(env.keys.verifications, 0, "the key was verified");
        succeeded(
          await options.invoke(app, "acceptsApiKey", {
            "x-api-key": env.keys.valid,
          }),
        );
        assert.equal(env.keys.verifications, 1);
      }),
  );
  add(
    "T-cookie-forwarded",
    "a refreshed session cookie is forwarded exactly once",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const name = await env.sessionCookieName();
        const result = await options.invoke(app, "required", cookie(env));
        succeeded(result);
        const lines = result.setCookies.filter((line) =>
          line.startsWith(`${name}=`),
        );
        assert.equal(
          lines.length,
          1,
          `refresh cookies: ${result.setCookies.join(" | ")}`,
        );
      }),
    options.expectCookieCapable
      ? undefined
      : "the transport cannot deliver Set-Cookie (see T-refresh-suppressed)",
  );
  add(
    "T-refresh-suppressed",
    "a cookie-less transport moves no session expiry and writes no cookie",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const context = (await env.auth.$context) as {
          internalAdapter: {
            findSession(token: string): Promise<{
              session: { expiresAt: Date };
            } | null>;
          };
        };
        const before = await context.internalAdapter.findSession(
          env.identity.token,
        );
        const writes = env.probe.writes.length;
        const result = await options.invoke(app, "required", cookie(env));
        succeeded(result);
        const after = await context.internalAdapter.findSession(
          env.identity.token,
        );
        assert.deepEqual(result.setCookies, []);
        assert.equal(
          new Date(after!.session.expiresAt).getTime(),
          new Date(before!.session.expiresAt).getTime(),
          "the session expiry moved",
        );
        assert.ok(
          !env.probe.writes.slice(writes).includes("session.update"),
          "the session row was refreshed",
        );
        assert.ok(
          env.probe.refresh
            .filter((entry) => entry.path === "/get-session")
            .slice(-1)
            .every((entry) => entry.skip),
          "getShouldSkipSessionRefresh() was not true inside the scope",
        );
      }),
    options.expectCookieCapable
      ? "the transport delivers Set-Cookie (see T-cookie-forwarded)"
      : undefined,
  );
  add(
    "T-csrf-http-unsafe",
    "an unsafe cookie operation needs a trusted origin, checked before any session read",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const from = env.probe.calls.length;
        denied(
          await options.invoke(app, "unsafe", {
            ...cookie(env),
            origin: UNTRUSTED_ORIGIN,
          }),
          403,
          "INVALID_ORIGIN",
        );
        assert.equal(sessionReads(env.probe, from), 0, "the session was read");
        denied(
          await options.invoke(app, "unsafe", cookie(env)),
          403,
          "MISSING_OR_NULL_ORIGIN",
        );
        for (const origin of [PROBE_TRUSTED_ORIGIN, KIT_BASE_URL]) {
          succeeded(
            await options.invoke(app, "unsafe", { ...cookie(env), origin }),
            `trusted origin ${origin}`,
          );
        }
        succeeded(
          await options.invoke(app, "unsafe", {
            ...cookie(env),
            // A same-origin page of the trusted base URL: the leg's own host is that origin.
            host: new URL(KIT_BASE_URL).host,
            origin: "null",
            "sec-fetch-site": "same-origin",
          }),
          "Origin: null with Sec-Fetch-Site: same-origin",
        );
        succeeded(
          await options.invoke(app, "unsafe", {
            authorization: `Bearer ${env.identity.token}`,
            origin: UNTRUSTED_ORIGIN,
          }),
          "a bearer token without a cookie",
        );
      }),
    noBrowser,
  );
  add(
    "T-csrf-http-cookie-plus-token",
    "a cookie plus a bearer token from an untrusted origin is still denied",
    (env) =>
      withApp(options, env, async ({ app }) => {
        for (const token of ["a.b", env.identity.token]) {
          denied(
            await options.invoke(app, "unsafe", {
              ...cookie(env),
              authorization: `Bearer ${token}`,
              origin: UNTRUSTED_ORIGIN,
            }),
            403,
            "INVALID_ORIGIN",
          );
        }
      }),
    noBrowser,
  );
  add(
    "T-csrf-login-proxy",
    "a forwarding login proxy follows Better Auth's form rule, and service forwarding needs a declaration",
    async (env) => {
      const user = await kitIdentity(env.auth, { password: true });
      const credentials = { email: user.email, password: user.password };
      await withApp(options, env, async ({ app }) => {
        const name = await env.sessionCookieName();
        let signIns = env.probe.calls.filter(
          (path) => path === "/sign-in/email",
        ).length;
        const navigation = await options.invoke(
          app,
          "loginProxy",
          {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
          credentials,
        );
        denied(navigation, 403, "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED");
        assert.deepEqual(navigation.setCookies, []);
        assert.equal(
          env.probe.calls.filter((path) => path === "/sign-in/email").length,
          signIns,
          "the proxy called Better Auth before the form check",
        );
        denied(
          await options.invoke(
            app,
            "loginProxy",
            {
              origin: UNTRUSTED_ORIGIN,
              "sec-fetch-site": "cross-site",
              "sec-fetch-mode": "cors",
            },
            credentials,
          ),
          403,
          "INVALID_ORIGIN",
        );
        const trusted = await options.invoke(
          app,
          "loginProxy",
          { origin: KIT_BASE_URL },
          credentials,
        );
        succeeded(trusted);
        assert.ok(
          trusted.setCookies.some((line) => line.startsWith(`${name}=`)),
          "the trusted sign-in forwarded no session cookie",
        );
        succeeded(await options.invoke(app, "loginProxy", {}, credentials));
        // A public forwarding proxy on a safe operation (HTTP GET) is in form mode too: cross-site input causes no
        // Better Auth call, no session write and no cookie. [R7:SEC-r7-01]
        signIns = env.probe.calls.filter(
          (path) => path === "/sign-in/email",
        ).length;
        const writes = env.probe.writes.length;
        const readNavigation = await options.invoke(
          app,
          "loginProxyRead",
          {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          },
          credentials,
        );
        denied(readNavigation, 403, "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED");
        assert.deepEqual(readNavigation.setCookies, []);
        assert.equal(
          env.probe.calls.filter((path) => path === "/sign-in/email").length,
          signIns,
          "a cross-site navigation reached Better Auth through the safe forwarding proxy",
        );
        assert.deepEqual(
          env.probe.writes.slice(writes),
          [],
          "a cross-site navigation wrote a session through the safe forwarding proxy",
        );
        const trustedRead = await options.invoke(
          app,
          "loginProxyRead",
          { origin: KIT_BASE_URL },
          credentials,
        );
        succeeded(trustedRead, "a trusted fetch of the safe forwarding proxy");
        assert.ok(
          trustedRead.setCookies.some((line) => line.startsWith(`${name}=`)),
          "the trusted safe forwarding proxy forwarded no session cookie",
        );
        succeeded(
          await options.invoke(app, "loginProxyRead", {}, credentials),
          "a headerless non-browser call of the safe forwarding proxy",
        );
        signIns = env.probe.calls.filter(
          (path) => path === "/sign-in/email",
        ).length;
        const attempts: Record<string, string>[] = [
          { origin: KIT_BASE_URL },
          { origin: UNTRUSTED_ORIGIN, "sec-fetch-site": "cross-site" },
        ];
        for (const headers of attempts) {
          const result = await options.invoke(
            app,
            "loginProxyService",
            headers,
            credentials,
          );
          internal(result);
          assert.deepEqual(result.setCookies, []);
        }
        assert.equal(
          env.probe.calls.filter((path) => path === "/sign-in/email").length,
          signIns,
          "forwardForeignCookies ran its callback without a declaration",
        );
      });
    },
    noBrowser,
  );
  add(
    "T-csrf-safe-methods",
    "safe cookie reads are not denied by origin validation, while forwarding enforces form mode without cookies",
    async (env) => {
      const user = await kitIdentity(env.auth, { password: true });
      await withApp(options, env, async ({ app }) => {
        for (const headers of [
          { ...cookie(env), origin: UNTRUSTED_ORIGIN },
          cookie(env),
        ]) {
          const result = await options.invoke(app, "readsSession", headers);
          succeeded(result);
          assert.equal(
            (result.body as { userId?: string }).userId,
            env.identity.userId,
          );
        }
        const signIns = env.probe.calls.filter(
          (path) => path === "/sign-in/email",
        ).length;
        const result = await options.invoke(
          app,
          "loginProxyRead",
          {
            origin: UNTRUSTED_ORIGIN,
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "cors",
          },
          { email: user.email, password: user.password },
        );
        denied(result, 403, "INVALID_ORIGIN");
        assert.deepEqual(result.setCookies, []);
        assert.equal(
          env.probe.calls.filter((path) => path === "/sign-in/email").length,
          signIns,
          "a cross-site safe operation of a forwarding handler reached Better Auth",
        );
      });
    },
    noBrowser,
  );
  add("T-error-shape", "401, 403 and 429 carry code and reason", (env) =>
    withApp(options, env, async ({ app }) => {
      const unauthenticated = await options.invoke(app, "required", {});
      denied(unauthenticated, 401);
      assert.equal(unauthenticated.error?.code, "UNAUTHENTICATED");
      const forbidden = await options.invoke(app, "forbidden", cookie(env));
      denied(forbidden, 403, "CONFORMANCE_DENIED");
      assert.equal(forbidden.error?.code, "FORBIDDEN");
      const limited = await options.invoke(app, "acceptsApiKey", {
        "x-api-key": env.keys.limited,
      });
      denied(limited, 429, "RATE_LIMITED");
      assert.equal(limited.error?.code, "RATE_LIMITED");
      const invalid = await options.invoke(app, "acceptsApiKey", {
        "x-api-key": "unknown",
      });
      denied(invalid, 401, "INVALID_API_KEY");
    }),
  );
  add("T-no-error-log", "denials are not logged at ERROR", (env) =>
    withApp(options, env, async ({ app, logger }) => {
      await options.invoke(app, "required", {});
      await options.invoke(app, "forbidden", cookie(env));
      await options.invoke(app, "acceptsApiKey", {
        "x-api-key": env.keys.limited,
      });
      assert.deepEqual(
        logger.errors().map((entry) => entry.text.slice(0, 200)),
        [],
      );
    }),
  );
  add(
    "T-infra-5xx",
    "a failing session store answers 5xx on protected handlers",
    (env) =>
      withApp(options, env, async ({ app }) => {
        env.probe.storageFault = () => new Error("conformance outage");
        const result = await options.invoke(app, "required", cookie(env));
        env.probe.storageFault = undefined;
        internal(result);
        assert.notEqual(result.error?.statusCode, 401);
        assert.notEqual(result.error?.statusCode, 403);
      }),
  );
  add(
    "T-internal-error-generic",
    "infrastructure and reader misconfiguration reach the client without detail",
    async (env) => {
      await withApp(options, env, async ({ app, logger }) => {
        const secret = `outage-${globalThis.crypto.randomUUID()}`;
        env.probe.fault = (path) =>
          path === "/get-session" ? new Error(secret) : undefined;
        const result = await options.invoke(app, "required", cookie(env));
        internal(result);
        assert.ok(
          !JSON.stringify(result.error).includes(secret),
          "the client saw the infrastructure detail",
        );
        assert.ok(logger.errors().length > 0, "nothing was logged at ERROR");
      });
      env.probe.fault = undefined;
      await withApp(
        options,
        env,
        async ({ app, logger }) => {
          const result = await options.invoke(app, "unguarded", cookie(env));
          internal(result);
          const client = JSON.stringify(result.error ?? {});
          assert.ok(!client.includes("unguarded"), `client saw ${client}`);
          assert.ok(!client.includes("stampPrincipal"), `client saw ${client}`);
          assert.match(logger.text(), /NO_AUTH_RESULT/);
        },
        {
          override: (builder) =>
            overrideAuthGuard(builder, { canActivate: () => true }),
        },
      );
    },
  );
  add(
    "T-internal-error-logged-once",
    "one failing logical request logs one ERROR entry for all its invocations",
    async (env) =>
      (await twiceReady(env)) ??
      withApp(options, env, async ({ app, logger }) => {
        const shapes = (options.invocationShapes ?? []).filter(
          (shape) => shape === "aliases" || shape === "batched",
        );
        for (const shape of shapes) {
          const errors = logger.errors().length;
          env.probe.fault = (path) =>
            path === "/get-session"
              ? new Error("conformance outage")
              : undefined;
          const results = await options.invokeTwice!(
            app,
            shape,
            [{ orgId: "org-a" }, { orgId: "org-a2" }],
            cookie(env),
          );
          env.probe.fault = undefined;
          assert.deepEqual(
            results.map((value) => value.ok),
            [false, false],
          );
          assert.equal(
            logger.errors().length - errors,
            1,
            `${shape}: ${logger.errors().length - errors} ERROR entries for one request`,
          );
        }
      }),
    twiceSkip &&
      "the transport has no lineage, so each error is logged once by construction",
  );
  add("T-public-no-lookup", "public handlers never read the session", (env) =>
    withApp(options, env, async ({ app }) => {
      const from = env.probe.calls.length;
      succeeded(await options.invoke(app, "public", cookie(env)));
      assert.equal(sessionReads(env.probe, from), 0);
    }),
  );
  add(
    "T-reads-session",
    "session readers return the session, mixed-kind service reads throw SESSION_REQUIRED, and mixed-kind boots fail PRINCIPAL_PARAM_CONFLICT",
    async (env) => {
      await withApp(options, env, async ({ app, logger }) => {
        const result = await options.invoke(app, "readsSession", cookie(env));
        succeeded(result);
        assert.equal(
          (result.body as { userId?: string }).userId,
          env.identity.userId,
        );
        // Boot cannot see a service getSession() call in a mixed-kind handler: it warns, and the read throws.
        assert.ok(
          warningCodes(logger).has("W_MIXED_KIND_SESSION_READER"),
          `boot did not warn W_MIXED_KIND_SESSION_READER: ${logger.text().slice(0, 500)}`,
        );
        const session = await options.invoke(
          app,
          "readsSessionService",
          cookie(env),
        );
        succeeded(session, "a session caller of a mixed-kind getSession()");
        assert.equal(
          (session.body as { userId?: string }).userId,
          env.identity.userId,
        );
        const key = await options.invoke(app, "readsSessionService", {
          "x-api-key": env.keys.valid,
        });
        internal(key);
        assert.match(logger.text(), /SESSION_REQUIRED/);
      });
      await expectBootFailure(
        options,
        env,
        {
          fixtures: kitFixtures({
            readsSession: [AcceptPrincipals(SESSION_KIND, API_KEY_KIND)],
          }),
        },
        "PRINCIPAL_PARAM_CONFLICT",
      );
      await expectBootFailure(
        options,
        env,
        { defaultRequirements: [sessionOrKey] },
        "PRINCIPAL_PARAM_CONFLICT",
      );
    },
  );
  add(
    "T-scope",
    "param decorators and the service see the same reading",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const result = await options.invoke(app, "readsSession", cookie(env));
        succeeded(result);
        assert.deepEqual(result.body, {
          userId: env.identity.userId,
          service: env.identity.userId,
        });
      }),
  );
  add(
    "T-coverage-claims",
    "unguarded boots report exactly the claimed fixtures, and explicit enhancers, app enhancers, global stand-ins and globalScope: false boot",
    async (env) => {
      let claims: RecordedClaim[] = [];
      const expected = new Map<string, string>();
      const defaults = new CapturingLogger();
      await withApp(
        options,
        env,
        async ({ app }) => {
          claims = await recordClaims(app, options.transport);
          const planner = app.get<RoutePlanner>(ROUTE_PLANNER, {
            strict: false,
          });
          for (const claim of claims) {
            if (
              !claim.fixture ||
              claim.method === undefined ||
              (claim.options.coverage ?? "error") !== "error"
            ) {
              continue;
            }
            const plan: RoutePlan = planner.plan(
              claim.target as Type,
              claim.method,
            );
            const accessCovered =
              (plan.access === "public" || plan.access === "inherit") &&
              plan.originCheck !== "form";
            if (
              !accessCovered &&
              (claim.options.everyHandler || plan.declares)
            ) {
              expected.set(claim.fixture, claim.options.code);
            }
          }
        },
        {},
        defaults,
      );
      assert.ok(
        claims.some((claim) => claim.fixture),
        "the transport claimed none of the kit's fixture handlers",
      );
      // Boot 3: the bare fixtures fail with exactly the handlers B16 reports, each with its claim's code, and boot
      // when no claim calls for a report.
      const bare = await settle(() =>
        withApp(options, env, async () => undefined, { globalGuard: false }),
      );
      assert.equal(
        bare.ok,
        expected.size === 0,
        bare.ok
          ? `the bare fixtures booted, but the claims call for reports of ${JSON.stringify([...expected])}`
          : `no claim calls for a coverage report, but boot failed: ${String(bare.error)}`,
      );
      const issues = ((!bare.ok &&
        (bare.error as { issues?: unknown } | undefined)?.issues) ||
        []) as readonly { code?: string; detail?: string }[];
      const reported = new Map<string, string>();
      for (const claim of claims) {
        if (!claim.fixture || claim.method === undefined) {
          continue;
        }
        const site = `${claim.target.name}.${claim.method} `;
        const issue = issues.find((value) =>
          String(value.detail ?? "").startsWith(site),
        );
        if (issue?.code) {
          reported.set(claim.fixture, issue.code);
        }
      }
      assert.deepEqual(
        [...reported].sort(),
        [...expected].sort(),
        `B16 reported ${JSON.stringify([...reported])}, the claims call for ${JSON.stringify([...expected])}`,
      );
      if (
        claims.some(
          (claim) =>
            claim.fixture === "loginProxy" &&
            (claim.options.coverage ?? "error") === "error",
        )
      ) {
        assert.ok(
          reported.has("loginProxy"),
          "@Public() must not cover a form-mode forwarding handler",
        );
      }
      for (const name of ["public", "publicService"]) {
        assert.ok(!reported.has(name), `${name} was reported`);
      }
      if (claims.some((claim) => claim.fixture && claim.reach === "explicit")) {
        await expectBootFailure(
          options,
          env,
          {
            globalGuard: false,
            fixtures: kitFixtures({}, [UseGuards(BetterAuthGuard)]),
          },
          "AUTH_BOOT_FAILED",
        );
      }
      await withApp(options, env, async () => undefined, {
        globalGuard: false,
        fixtures: kitFixtures({}, [UseBetterAuth()]),
      });
      const global = claims.some(
        (claim) => claim.fixture && claim.reach === "global",
      );
      if (global) {
        await withApp(options, env, async () => undefined, {
          globalGuard: false,
          appEnhancers: true,
        });
      }
      // Boot 4: a replaced global guard is still the global guard.
      const standIn = { canActivate: async () => true };
      await withApp(options, env, async () => undefined, {
        override: (builder) =>
          builder.overrideProvider(BetterAuthGuard).useValue(standIn),
      });
      class StandInGuard {
        canActivate(): boolean {
          return true;
        }
      }
      await withApp(options, env, async () => undefined, {
        override: (builder) =>
          builder.overrideProvider(BetterAuthGuard).useClass(StandInGuard),
      });
      if (global) {
        const unscoped = new CapturingLogger();
        await withApp(
          options,
          env,
          async () => undefined,
          { globalScope: false },
          unscoped,
        );
        const added = [...warningCodes(unscoped)].filter(
          (code) => !warningCodes(defaults).has(code),
        );
        assert.deepEqual(
          added,
          ["W_NO_GLOBAL_SCOPE"],
          `globalScope: false must boot global claims with W_NO_GLOBAL_SCOPE only (pass the logger option to the app): ${unscoped.text().slice(0, 500)}`,
        );
      }
    },
  );
  add(
    "T-unsatisfiable-kinds",
    "default requirements that admit no common kind fail boot unless skipped",
    async (env) => {
      await expectBootFailure(
        options,
        env,
        {
          defaultRequirements: [sessionOnly],
          fixtures: kitFixtures({ acceptsApiKey: [Require(apiKeyOnly)] }),
        },
        "UNSATISFIABLE_PRINCIPAL_KINDS",
      );
      await expectBootFailure(
        options,
        env,
        {
          defaultRequirements: [unnamedKinds],
          fixtures: kitFixtures({ acceptsApiKey: [Require(apiKeyOnly)] }),
        },
        "UNSATISFIABLE_PRINCIPAL_KINDS",
      );
      await withApp(
        options,
        env,
        async ({ app }) => {
          const result = await options.invoke(app, "acceptsApiKey", {
            "x-api-key": env.keys.valid,
          });
          succeeded(result);
          assert.equal(principalOf(result)?.kind, "api-key");
        },
        {
          defaultRequirements: [sessionOnly],
          fixtures: kitFixtures({
            acceptsApiKey: [Require(apiKeyOnly), SkipDefaultRequirements()],
          }),
        },
      );
    },
  );
  add(
    "T-public-service-null",
    "a public unsafe handler's service reads null without a session read",
    (env) =>
      withApp(options, env, async ({ app }) => {
        const from = env.probe.calls.length;
        const result = await options.invoke(app, "publicService", {
          ...cookie(env),
          origin: UNTRUSTED_ORIGIN,
        });
        succeeded(result);
        assert.deepEqual(result.body, { session: null });
        assert.equal(sessionReads(env.probe, from), 0);
      }),
  );
  add(
    "T-public-direct-invalid-context",
    "public work runs without extraction; guarded and forwarding work fails closed before side effects",
    async (env) => {
      const user = await kitIdentity(env.auth, { password: true });
      await withApp(options, env, async ({ app, instrumentation }) => {
        instrumentation.consumed.length = 0;
        succeeded(await options.invoke(app, "public", cookie(env)));
        succeeded(await options.invoke(app, "publicService", cookie(env)));
        assert.deepEqual(
          instrumentation.consumed,
          [],
          "public scope construction consumed request-dependent capabilities",
        );
        instrumentation.unavailable = true;
        succeeded(await options.invoke(app, "public", cookie(env)));
        const guarded = await options.invoke(app, "required", cookie(env));
        internal(guarded);
        const signIns = env.probe.calls.filter(
          (path) => path === "/sign-in/email",
        ).length;
        const proxy = await options.invoke(
          app,
          "loginProxy",
          { origin: KIT_BASE_URL },
          { email: user.email, password: user.password },
        );
        internal(proxy);
        assert.deepEqual(proxy.setCookies, []);
        assert.equal(
          env.probe.calls.filter((path) => path === "/sign-in/email").length,
          signIns,
          "a forwarding handler reached Better Auth without extraction",
        );
      });
    },
  );
  const graphOf = (result: GraphResult, root: string, field?: string) => {
    const node = (result.data as Record<string, unknown> | null | undefined)?.[
      root
    ] as Record<string, unknown> | null | undefined;
    return field === undefined ? node : node?.[field];
  };
  const userOf = (value: unknown) =>
    (value as { principal?: { userId?: string } | null } | null | undefined)
      ?.principal?.userId ?? null;
  add(
    "T-inherit-no-lookup",
    "an anonymous public operation with an inheriting field reads no session, and a guarded field is still enforced",
    async (env) => {
      const skip = await graphReady(env);
      if (skip) {
        return skip;
      }
      for (const enhancers of enhancerBoots) {
        const guarded = enhancers.length > 0;
        await withApp(
          options,
          env,
          async ({ app }) => {
            const from = env.probe.calls.length;
            const result = await options.invokeGraph!(
              app,
              [{ root: "public", fields: ["plain"] }],
              {},
            );
            assert.deepEqual(
              result.errors,
              [],
              `[${enhancers.join(", ")}]: ${JSON.stringify(result.errors)}`,
            );
            assert.equal(
              sessionReads(env.probe, from),
              0,
              `[${enhancers.join(", ")}]: an inheriting field read the session`,
            );
            if (guarded) {
              const field = await options.invokeGraph!(
                app,
                [{ root: "public", fields: ["guarded"] }],
                {},
              );
              assert.ok(
                field.errors.length > 0 &&
                  field.errors.every(
                    (error) => error.code === "UNAUTHENTICATED",
                  ),
                `a guarded field under a public root was not denied: ${JSON.stringify(field.errors)}`,
              );
            }
          },
          {
            fieldResolverEnhancers: enhancers,
            fixtures: kitFixtures({}, [], { guarded }),
          },
        );
      }
    },
    graphSkip,
  );
  add(
    "T-stamp-per-plan",
    "a nested reader reads its own enclosing root field's reading, whichever source settles first",
    async (env) => {
      const skip = await graphReady(env);
      if (skip) {
        return skip;
      }
      // User Y's cookie and user X's key in one operation.
      env.keys.owner = (await kitIdentity(env.auth)).userId;
      const headers = { ...cookie(env), "x-api-key": env.keys.valid };
      for (const enhancers of enhancerBoots) {
        await withApp(
          options,
          env,
          async ({ app }) => {
            for (const delays of [
              { session: 0, apiKey: 30 },
              { session: 30, apiKey: 0 },
            ]) {
              env.probe.delay = (path) =>
                path === "/get-session" ? delays.session : undefined;
              env.keys.delayMs = delays.apiKey;
              const label = `[${enhancers.join(", ")}] session ${delays.session} ms, key ${delays.apiKey} ms`;
              try {
                const result = await options.invokeGraph!(
                  app,
                  [
                    { root: "sessionOnly", fields: ["reader"] },
                    { root: "mixed", fields: ["reader"] },
                    { root: "public", fields: ["reader"] },
                  ],
                  headers,
                  { delays },
                );
                assert.ok(
                  result.errors.every(
                    (error) => error.reason !== "NO_AUTH_RESULT",
                  ),
                  `${label}: ${JSON.stringify(result.errors)}`,
                );
                assert.deepEqual(
                  result.errors,
                  [],
                  `${label}: ${JSON.stringify(result.errors)}`,
                );
                assert.equal(
                  userOf(graphOf(result, "sessionOnly", "reader")),
                  env.identity.userId,
                  `${label}: reader under sessionOnly`,
                );
                assert.equal(
                  userOf(graphOf(result, "mixed", "reader")),
                  userOf(graphOf(result, "mixed")),
                  `${label}: reader under mixed must read mixed's own principal`,
                );
                assert.equal(
                  userOf(graphOf(result, "public", "reader")),
                  null,
                  `${label}: reader under public`,
                );
              } finally {
                env.probe.delay = undefined;
                env.keys.delayMs = 0;
              }
            }
          },
          {
            fieldResolverEnhancers: enhancers,
            fixtures: kitFixtures({}, [], { guarded: enhancers.length > 0 }),
          },
        );
      }
    },
    graphSkip,
  );
  const federation: BootOptions = {
    federation: true,
    fieldResolverEnhancers: ["guards", "interceptors"],
    fixtures: kitFixtures({}, [], { guarded: true, reference: true }),
  };
  add(
    "T-reference-resolver",
    "federation reference resolvers need field guards and decide each entity",
    async (env) => {
      if (!options.invokeEntities) {
        if (!(await transportHas(options, env, "defaultAccessFor"))) {
          return conformanceSkip(
            "the transport nests no handlers, so it serves no federation reference resolvers",
          );
        }
        let claimed = false;
        await withApp(
          options,
          env,
          async ({ app }) => {
            claimed = (await recordClaims(app, options.transport)).some(
              (claim) => claim.fixture === "reference",
            );
          },
          federation,
        );
        assert.equal(
          claimed,
          false,
          "the transport claims the federation reference resolver, so invokeEntities is required",
        );
        return conformanceSkip(
          "the transport claims no reference resolver and gives no invokeEntities",
        );
      }
      await expectBootFailure(
        options,
        env,
        { ...federation, fieldResolverEnhancers: undefined },
        ["REFERENCE_RESOLVER_UNGUARDED", "FEDERATION_FIELD_GUARDS_REQUIRED"],
      );
      await withApp(
        options,
        env,
        async ({ app }) => {
          const representations = [
            { __typename: "FixtureNode", id: "1", orgId: "org-a" },
            { __typename: "FixtureNode", id: "2", orgId: "org-b" },
          ];
          const anonymous = await options.invokeEntities!(
            app,
            representations,
            ["plain"],
            {},
          );
          assert.ok(
            anonymous.errors.length >= 2 &&
              anonymous.errors.every(
                (error) => error.code === "UNAUTHENTICATED",
              ),
            JSON.stringify(anonymous.errors),
          );
          const decided = await options.invokeEntities!(
            app,
            representations,
            ["plain"],
            cookie(env),
          );
          assert.equal(
            decided.errors.length,
            1,
            `two representations were not decided independently: ${JSON.stringify(decided.errors)}`,
          );
          assert.equal(decided.errors[0]!.reason, "MISSING_PERMISSION");
          assert.ok(
            decided.errors[0]!.path.includes(1),
            JSON.stringify(decided.errors),
          );
        },
        federation,
      );
    },
    staticMember(options.transport, "defaultAccessFor") === false &&
      !options.invokeEntities
      ? "the transport nests no handlers, so it serves no federation reference resolvers"
      : undefined,
  );
  return cases;
}
