import assert from "node:assert/strict";
import {
  type ExecutionContext,
  type INestApplication,
  type LoggerService,
  SetMetadata,
  type Type,
  UseGuards,
} from "@nestjs/common";
import {
  DiscoveryService,
  ExternalContextCreator,
  MetadataScanner,
  ModuleRef,
  Reflector,
} from "@nestjs/core";
import type { TestingModuleBuilder } from "@nestjs/testing";
import type { BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins";
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
  SkipOriginCheck,
  UseBetterAuth,
} from "./auth-decorators.js";
import { AuthFailures, BetterAuthConfigurationError } from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import type { BetterAuthService } from "./auth-service.js";
import {
  MOUNT_COORDINATOR,
  ROUTE_PLANNER,
  TRANSPORT_REGISTRY,
  WS_CONNECTION_AUTH,
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
  type ConformanceAuthSettings,
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
  fromParam,
  orgPermission,
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

/**
 * One method of an abstract base class, exposed through two subclasses that carry `subclasses.public` and
 * `subclasses.denied` as class decorators (T-inherited-handler). A harness without invokeInherited exposes it as a
 * plain handler.
 */
export interface InheritedFixture extends FixtureHandler {
  readonly subclasses: {
    readonly public: readonly ClassDecorator[];
    readonly denied: readonly ClassDecorator[];
  };
}

/**
 * GraphQL shapes only: one object type FixtureNode, returned by the root fields and carrying the field resolvers
 * below. invokeGraph selects `publicNested` as `publicNested { id reader }` and `guarded` as
 * `guarded { id principal nestedReader }`, so `reader` and `nestedReader` read the reading of their enclosing field.
 */
export interface GraphFixtures {
  readonly roots: {
    readonly public: FixtureHandler;
    readonly sessionOnly: FixtureHandler;
    readonly mixed: FixtureHandler;
    /**
     * A list root: its handler returns 20 FixtureNode items, so serve it as a list of FixtureNode (`[FixtureNode]`).
     * Given only to the reader rows of T-internal-error-logged-once.
     */
    readonly items?: FixtureHandler;
  };
  readonly fields: {
    readonly plain: FixtureHandler;
    readonly publicNested: FixtureHandler;
    readonly reader: FixtureHandler;
    readonly guarded?: FixtureHandler;
    readonly nestedReader?: FixtureHandler;
    readonly sessionReader: FixtureHandler;
    /** @ForwardAuthCookies() without access metadata: an inheriting form-mode field that signs a kit user in (T-csrf-login-proxy). */
    readonly forwarding?: FixtureHandler;
    /** A String field reading @ActiveOrganizationId() without a requirement that provides it (T-internal-error-logged-once). */
    readonly organizationReader?: FixtureHandler;
    /** A String field returning the user id of the zero-argument service.getSession() (T-internal-error-logged-once). */
    readonly serviceSession?: FixtureHandler;
  };
  /** Federation shapes only: @ResolveReference() of FixtureNode, with the kit's per-representation requirement on `orgId`. */
  readonly reference?: FixtureHandler;
  /** Class decorators of the resolver class that serves the roots, the fields and the reference resolver. */
  readonly classDecorators?: readonly ClassDecorator[];
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
  readonly inherited: InheritedFixture;
  readonly unguarded: FixtureHandler;
  /**
   * Default access, operation 'read': a direct auth.api.getSession() call presenting the invocation's `cookie` input,
   * the caller's own session cookie (T-csrf-safe-methods).
   */
  readonly callerSession: FixtureHandler;
  /** Like callerSession, with @Public(). */
  readonly publicCallerSession: FixtureHandler;
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
      /**
       * GraphQL shapes: the fieldResolverEnhancers to serve 'graph' with. The kit boots GraphQL cases with [] and
       * ['guards', 'interceptors'], and the reader rows of T-internal-error-logged-once with ['guards', 'interceptors',
       * 'filters'] and ['guards', 'filters'].
       */
      fieldResolverEnhancers?: readonly (
        | "guards"
        | "interceptors"
        | "filters"
      )[];
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
      /** BetterAuthModule's cookies.forwardDirectCalls (T-stamp-per-plan). */
      forwardDirectCalls?: boolean;
      /**
       * BetterAuthModule's logSummary. The kit passes true where it asserts the boot summary (T-coverage-claims); unset
       * leaves the harness's choice, such as false to keep other boots quiet.
       */
      logSummary?: boolean;
      /** GraphQL shapes: the fieldResolverCoverage of the transport this boot registers (T-stamp-per-plan). */
      fieldResolverCoverage?: "warn";
      /** GraphQL shapes: the GraphQL module's `context` option, one of `graphqlContexts` (T-stale-context, T-subscription-origin). */
      graphqlContext?: GraphqlContextShape;
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
  /**
   * Connection shapes (WebSocket gateways): opens ONE connection whose handshake carries `headers`, sends one message to
   * each given fixture handler on it in order, each after the previous one answered, and returns every outcome. Required
   * when the transport's browser leg is its connection's handshake: the T-ws-origin-* cases then fail without it, and
   * are skipped with a reason for other transports.
   */
  invokeConnection?(
    app: INestApplication,
    handlers: readonly Exclude<keyof TransportFixtures, "graph">[],
    headers: HeadersInit,
    options?: {
      /**
       * Values the connection sends in its init payload (graphql-ws connection_init) instead of the handshake's credential
       * headers; given only when `invocationShapes` includes 'subscriptions'.
       */
      readonly connectionParams?: Readonly<Record<string, string>>;
    },
  ): Promise<TransportInvocationResult[]>;
  /**
   * Invokes `fixtures.inherited` through the subclass that carries `subclasses[subclass]`. Without it T-inherited-handler
   * is skipped with a reason: a transport that addresses handlers by a name that one inherited method shares across
   * subclasses (an RPC pattern, a GraphQL root field) cannot expose it twice.
   */
  invokeInherited?(
    app: INestApplication,
    subclass: "public" | "denied",
    headers: HeadersInit,
  ): Promise<TransportInvocationResult>;
  /**
   * GraphQL shapes: the `graphqlContext` values createApp honours. T-stale-context needs 'static' and 'cached' and fails
   * without them when the transport nests handlers; the custom-context rows of T-subscription-origin run for 'fresh' and
   * 'plain-request' when listed.
   */
  graphqlContexts?: readonly GraphqlContextShape[];
  /**
   * Connection shapes: authenticates one connection whose handshake carries `headers` through the app's connection-time
   * authentication (WS_CONNECTION_AUTH), requiring a principal: `ok` when one authenticates, otherwise the failure
   * (401 without credentials). Required when the app provides WS_CONNECTION_AUTH: the T-ws-origin-* cases then fail
   * without it.
   */
  authenticateConnection?(
    app: INestApplication,
    headers: HeadersInit,
  ): Promise<ConnectionAuthenticationResult>;
  expectCookieCapable: boolean;
  /**
   * Whether the transport describes a browser leg (false for RPC; T-selection fails a false claim). A leg that follows each
   * operation enables the T-csrf-* cases; a leg that is the connection's handshake, shared by the connection's messages and
   * enforced on every one, enables the T-ws-origin-* cases instead. The kit reads which from the transport.
   */
  expectBrowserLeg: boolean;
}

/**
 * The GraphQL module's `context` option of a boot: 'fresh' is a function returning a new object that keeps what the driver
 * passes it (the native request, the graphql-ws context); 'plain-request' a function returning a new object whose `req` is a
 * plain object holding only the native request's cookie header; 'cached' a function returning the object it built on its
 * first call; 'static' an object.
 */
export type GraphqlContextShape =
  | "fresh"
  | "plain-request"
  | "cached"
  | "static";

/** The outcome of connection-time authentication (authenticateConnection). */
export interface ConnectionAuthenticationResult {
  ok: boolean;
  error?: TransportInvocationResult["error"];
}

const KEY_SOURCE_ID = "nestjs-slightly-better-auth:conformance-api-key";
/** An origin only a function-valued trustedOrigins returns (T-ws-origin-*). */
const FUNCTION_TRUSTED_ORIGIN = "https://function-trusted.example";
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
/**
 * The 'org' fixture's requirement: the organization unit's permission check on the invocation's orgId input. The kit
 * seeds org-a and org-a2, which the kit identity owns, and org-b, where it is a member without that permission.
 */
const orgFixturePermission = orgPermission(
  { organization: ["update"] },
  { organization: fromParam("orgId") },
);
// The kit's per-representation policy for federation reference resolvers: it decides from the representation's orgId
// alone, so reference boots need no organization data per representation.
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
  /** Include the federation `reference` fixture; 'bare' leaves out its method-level requirement. */
  readonly reference?: boolean | "bare";
  /** Include the `forwarding` field, signing in with these credentials. */
  readonly forwarding?: { readonly email: string; readonly password: string };
  /** Class decorators of the graph resolver class. */
  readonly classDecorators?: readonly ClassDecorator[];
  /** Include the `items` root and the `organizationReader` and `serviceSession` fields (T-internal-error-logged-once). */
  readonly readerErrors?: boolean;
}

/** How many FixtureNode items the `items` root returns. */
const ITEM_COUNT = 20;

/** The fixture marker of a graph handler, for claims and plans of GraphQL boots. */
const graphMarker = (name: string) => `graph.${name}`;

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
  const withExtra = <F extends FixtureHandler>(
    name: FixtureName,
    fixture: F,
    marker: string = name,
  ): F => ({
    ...fixture,
    decorators: [
      SetMetadata(FIXTURE_METADATA, marker),
      ...fixture.decorators,
      ...(extra[name] ?? []),
      ...everyHandler,
    ],
  });
  const plain = () => handler([], [], "read", () => ({ ok: true }));
  const marked = (name: string, fixture: FixtureHandler): FixtureHandler => ({
    ...fixture,
    decorators: [
      SetMetadata(FIXTURE_METADATA, graphMarker(name)),
      ...fixture.decorators,
    ],
  });
  const reader = () =>
    handler([], [CurrentPrincipal()], "read", ([principal]) => ({
      principal: view(principal),
    }));
  // A direct call presenting the caller's own session cookie, which the invocation passes as its `cookie` input.
  const callerSession = (decorators: MethodDecorator[]) =>
    handler(decorators, [], "read", async (_params, input, { service }) => {
      const session = (await (
        service.api as unknown as {
          getSession(input: { headers: Headers }): Promise<unknown>;
        }
      ).getSession({
        headers: new Headers({ cookie: String(input.cookie ?? "") }),
      })) as { user?: { id?: string } } | null;
      return { userId: session?.user?.id ?? null };
    });
  const forwarding = graph.forwarding;
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
        [Require(orgFixturePermission)],
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
    inherited: withExtra("inherited", {
      ...plain(),
      subclasses: {
        public: [Public()],
        denied: [Require(requirement(denyPolicy, {}))],
      },
    }),
    callerSession: withExtra("callerSession", callerSession([])),
    publicCallerSession: withExtra(
      "publicCallerSession",
      callerSession([Public()]),
    ),
    unguarded: withExtra(
      "unguarded",
      handler([], [CurrentSession(), ActiveOrganizationId()], "read", () => ({
        reached: true,
      })),
    ),
    graph: {
      roots: {
        public: marked(
          "public",
          handler([Public()], [], "read", () => ({ id: "public" })),
        ),
        sessionOnly: marked(
          "sessionOnly",
          handler([], [CurrentPrincipal()], "read", ([p]) => ({
            id: "session",
            principal: view(p),
          })),
        ),
        mixed: marked(
          "mixed",
          handler(
            [AcceptPrincipals(SESSION_KIND, API_KEY_KIND)],
            [CurrentPrincipal()],
            "read",
            ([p]) => ({ id: "mixed", principal: view(p) }),
          ),
        ),
        ...(graph.readerErrors
          ? {
              items: marked(
                "items",
                handler(
                  [AcceptPrincipals(SESSION_KIND, API_KEY_KIND)],
                  [],
                  "read",
                  () =>
                    Array.from({ length: ITEM_COUNT }, (_, index) => ({
                      id: `item-${index}`,
                    })),
                ),
              ),
            }
          : {}),
      },
      fields: {
        plain: marked(
          "plain",
          handler([], [], "read", () => "plain"),
        ),
        publicNested: marked(
          "publicNested",
          handler([Public()], [], "read", () => ({ id: "nested" })),
        ),
        reader: marked("reader", reader()),
        ...(graph.guarded
          ? {
              guarded: marked(
                "guarded",
                handler(
                  [RequireAuth()],
                  [CurrentPrincipal()],
                  "read",
                  ([p]) => ({ id: "guarded", principal: view(p) }),
                ),
              ),
              nestedReader: marked("nestedReader", reader()),
            }
          : {}),
        sessionReader: marked(
          "sessionReader",
          handler(
            [],
            [CurrentSession()],
            "read",
            ([session]) =>
              (session as { user?: { id?: string } } | null)?.user?.id ?? null,
          ),
        ),
        ...(graph.readerErrors
          ? {
              organizationReader: marked(
                "organizationReader",
                handler(
                  [],
                  [ActiveOrganizationId()],
                  "read",
                  ([organization]) =>
                    typeof organization === "string" ? organization : null,
                ),
              ),
              serviceSession: marked(
                "serviceSession",
                handler(
                  [],
                  [],
                  "read",
                  async (_params, _input, { service }) =>
                    (
                      (await service.getSession()) as {
                        user?: { id?: string };
                      } | null
                    )?.user?.id ?? null,
                ),
              ),
            }
          : {}),
        ...(forwarding
          ? {
              forwarding: marked(
                "forwarding",
                handler(
                  [ForwardAuthCookies()],
                  [],
                  "read",
                  async (_params, _input, { service }) => {
                    await signIn(service, forwarding);
                    return "forwarded";
                  },
                ),
              ),
            }
          : {}),
      },
      ...(graph.reference
        ? {
            reference: handler(
              [
                SetMetadata(FIXTURE_METADATA, "reference"),
                ...(graph.reference === "bare"
                  ? []
                  : [Require(requirement(orgPolicy, {}))]),
              ],
              [],
              "read",
              (_params, input) => ({ id: input.id, orgId: input.orgId }),
            ),
          }
        : {}),
      ...(graph.classDecorators
        ? { classDecorators: graph.classDecorators }
        : {}),
    },
  };
}

/** How a described call exposes its browser leg: none, one per operation, or its connection's handshake. */
type LegShape = "none" | "operation" | "connection";

interface Instrumentation {
  readonly consumed: string[];
  readonly contexts: ExecutionContext[];
  /** The leg shape of each call described while `recordLegs` is set. */
  readonly legs: LegShape[];
  unavailable: boolean;
  /**
   * Read each described call's browser leg while its invocation runs. A transport may fail closed once the logical
   * request has completed (GraphQL rejects a completed request), so the kit never reads a leg afterwards.
   */
  recordLegs: boolean;
}

/** Wraps the registry's describe() so request-dependent getters are counted and can be made unavailable. */
function instrument(app: INestApplication): Instrumentation {
  const registry = app.get<TransportRegistry>(TRANSPORT_REGISTRY, {
    strict: false,
  });
  const state: Instrumentation = {
    consumed: [],
    contexts: [],
    legs: [],
    unavailable: false,
    recordLegs: false,
  };
  const original = registry.describe.bind(registry);
  registry.describe = (context, transport) => {
    const call = original(context, transport);
    state.contexts.push(context);
    if (state.recordLegs) {
      const browser = call.browser;
      state.legs.push(
        browser === undefined
          ? "none"
          : browser.key === call.key
            ? "operation"
            : "connection",
      );
    }
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
  /**
   * The transport's browser leg is its connection's handshake: a browser always sends Origin there, so the kit's cookie
   * credential carries the trusted base URL as Origin, as a page of that origin does.
   */
  readonly connectionLeg: boolean;
  sessionCookieName(): Promise<string>;
}

/** The organizations the 'org' fixture names: the identity owns org-a and org-a2 and is a plain member of org-b. */
async function seedOrganizations(
  auth: AuthLike,
  userId: string,
): Promise<void> {
  const context = (await auth.$context) as {
    adapter: {
      create(input: {
        model: string;
        data: Record<string, unknown>;
        forceAllowId?: boolean;
      }): Promise<unknown>;
    };
  };
  for (const [id, role] of [
    ["org-a", "owner"],
    ["org-a2", "owner"],
    ["org-b", "member"],
  ] as const) {
    await context.adapter.create({
      model: "organization",
      data: {
        id,
        name: id,
        slug: `${id}-${globalThis.crypto.randomUUID()}`,
        createdAt: new Date(),
      },
      forceAllowId: true,
    });
    await context.adapter.create({
      model: "member",
      data: { organizationId: id, userId, role, createdAt: new Date() },
    });
  }
}

async function environment(
  authOptions: Omit<BetterAuthOptions, "database"> = {},
  connectionLeg = false,
  settings: ConformanceAuthSettings = {},
): Promise<KitEnv> {
  const plugins = authOptions.plugins ?? [];
  const auth = createConformanceAuth(
    {
      ...authOptions,
      plugins: plugins.some((plugin) => plugin.id === "organization")
        ? plugins
        : [...plugins, organization()],
    },
    // Only the T-csrf-http-unsafe rows pass origin-check settings.
    settings,
  );
  const probe = await probeOf(auth);
  const identity = await kitIdentity(auth);
  await seedOrganizations(auth, identity.userId);
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
    connectionLeg,
    async sessionCookieName() {
      const context = (await auth.$context) as {
        authCookies: { sessionToken: { name: string } };
      };
      return context.authCookies.sessionToken.name;
    },
  };
}

/** An organization the kit identity of `env` owns (instances with the organization plugin); returns its id. */
async function createKitOrganization(env: KitEnv): Promise<string> {
  const created = (await (
    env.auth.api as unknown as {
      createOrganization(input: {
        headers: Headers;
        body: { name: string; slug: string };
      }): Promise<{ id: string }>;
    }
  ).createOrganization({
    headers: new Headers({ cookie: env.identity.cookie }),
    body: {
      name: "Conformance",
      slug: `conformance-${globalThis.crypto.randomUUID()}`,
    },
  })) as { id: string };
  return created.id;
}

interface Booted {
  readonly app: INestApplication;
  /** Everything the app logged, from boot on when the harness applies the `logger` option. */
  readonly logger: CapturingLogger;
  readonly instrumentation: Instrumentation;
}

type GraphEnhancers = readonly ("guards" | "interceptors" | "filters")[];

interface BootOptions {
  fixtures?: TransportFixtures;
  forwardDirectCalls?: boolean;
  fieldResolverCoverage?: "warn";
  graphqlContext?: GraphqlContextShape;
  globalGuard?: boolean;
  override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  defaultRequirements?: readonly RequirementExpr[];
  fieldResolverEnhancers?: GraphEnhancers;
  federation?: boolean;
  globalScope?: boolean;
  appEnhancers?: boolean;
  logSummary?: boolean;
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
      ...(boot.forwardDirectCalls ? { forwardDirectCalls: true } : {}),
      ...(boot.fieldResolverCoverage
        ? { fieldResolverCoverage: boot.fieldResolverCoverage }
        : {}),
      ...(boot.graphqlContext ? { graphqlContext: boot.graphqlContext } : {}),
      ...(boot.logSummary ? { logSummary: true } : {}),
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

/** The default instance's boot summary line (BetterAuthModule's logSummary). */
function summaryLine(logger: CapturingLogger): string {
  const line = logger.entries.find(
    (entry) =>
      entry.level === "log" &&
      entry.text.startsWith("'default': ") &&
      entry.text.includes("; scope: "),
  )?.text;
  assert.ok(
    line,
    `boot logged no summary (pass the logSummary and logger options to the app): ${logger.text().slice(0, 500)}`,
  );
  return line;
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

/** Suffix the kit gives every Nest metadata key written while it runs validate() with renamed metadata (T-metadata-canary). */
const RENAMED_METADATA = ":nestjs-slightly-better-auth-conformance-renamed";

interface ClaimRecording {
  /** Classes the validation context's discovery lists besides the app's controllers and providers. */
  // biome-ignore lint/complexity/noBannedTypes: Nest metadata accepts class and function targets.
  readonly classes?: readonly Function[];
  /**
   * Write every string metadata key under another name while validate() runs, as if the installed Nest wrote its
   * decorators' metadata under keys the transport does not read.
   */
  readonly renameMetadata?: boolean;
}

/** The claims the transport makes for a booted app, recorded by running its validate() once more. */
async function recordClaims(
  app: INestApplication,
  ref: ExtensionRef<AuthTransport>,
  recording: ClaimRecording = {},
): Promise<RecordedClaim[]> {
  const transport = resolvedTransport(app, ref);
  const claims: RecordedClaim[] = [];
  const planner = app.get<RoutePlanner>(ROUTE_PLANNER, { strict: false });
  const discovery = app.get(DiscoveryService, { strict: false });
  const extra = (recording.classes ?? []).map(
    (metatype) =>
      ({
        metatype,
        isAlias: false,
        name: metatype.name,
      }) as unknown as ReturnType<DiscoveryService["getProviders"]>[number],
  );
  const define = Reflect.defineMetadata;
  if (recording.renameMetadata) {
    Reflect.defineMetadata = (
      key: unknown,
      value: unknown,
      target: object,
      property?: string | symbol,
    ) =>
      define(
        typeof key === "string" && !key.startsWith("design:")
          ? `${key}${RENAMED_METADATA}`
          : key,
        value,
        target,
        property as string | symbol,
      );
  }
  try {
    await transport.validate?.({
      discovery: {
        getControllers: () => [...discovery.getControllers(), ...extra],
        getProviders: () => [...discovery.getProviders(), ...extra],
      } as unknown as DiscoveryService,
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
  } finally {
    Reflect.defineMetadata = define;
  }
  return claims;
}

/** A class with the own class-level metadata of `target` and no methods: a push-only gateway, a controller without routes. */
// biome-ignore lint/complexity/noBannedTypes: Nest metadata accepts class and function targets.
function withoutHandlers(target: Function): Function {
  const clone = { [`${target.name}WithoutHandlers`]: class {} }[
    `${target.name}WithoutHandlers`
  ]!;
  for (const key of Reflect.getOwnMetadataKeys(target)) {
    Reflect.defineMetadata(key, Reflect.getOwnMetadata(key, target), clone);
  }
  return clone;
}

/** The booted instance and method name that serve a kit fixture, found by its SetMetadata() marker. */
function fixtureInstance(
  app: INestApplication,
  fixture: string,
): { instance: object; method: string } {
  const discovery = app.get(DiscoveryService, { strict: false });
  const scanner = new MetadataScanner();
  for (const wrapper of [
    ...discovery.getControllers(),
    ...discovery.getProviders(),
  ]) {
    const instance: unknown = wrapper.instance;
    if (!instance || typeof instance !== "object") {
      continue;
    }
    for (const method of scanner.getAllMethodNames(
      Object.getPrototypeOf(instance) as object,
    )) {
      const handler: unknown = Reflect.get(instance, method);
      if (
        typeof handler === "function" &&
        Reflect.getMetadata(FIXTURE_METADATA, handler) === fixture
      ) {
        return { instance, method };
      }
    }
  }
  assert.fail(`no booted controller or provider serves the ${fixture} fixture`);
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

/**
 * Whether the transport's browser leg is its connection's handshake: the leg of an anonymous `optional` (read) invocation
 * outlives the invocation's logical request, as a WebSocket's handshake does. A cross-site page reads every reply on such
 * a connection, so the T-ws-origin-* cases expect every message enforced. Other legs follow each operation (HTTP
 * requests, GraphQL over HTTP).
 */
async function connectionShaped(
  options: TransportConformanceOptions,
): Promise<boolean> {
  let shaped = false;
  await withApp(
    options,
    await environment(),
    async ({ app, instrumentation }) => {
      instrumentation.recordLegs = true;
      succeeded(
        await options.invoke(app, "optional", {}),
        "an anonymous optional invocation",
      );
      const [leg] = instrumentation.legs;
      assert.ok(leg, "the guard described no invocation");
      shaped = leg === "connection";
    },
  );
  return shaped;
}

function sessionReads(probe: ProbeState, from: number): number {
  return probe.calls.slice(from).filter((path) => path === "/get-session")
    .length;
}

function denied(
  result: Pick<TransportInvocationResult, "ok" | "body" | "error">,
  status: number,
  reason?: string,
  label = "",
): void {
  const prefix = label ? `${label}: ` : "";
  assert.equal(
    result.ok,
    false,
    `${prefix}expected a ${status} denial, got success: ${JSON.stringify(result.body)}`,
  );
  assert.equal(
    result.error?.statusCode,
    status,
    `${prefix}expected ${status}, got ${JSON.stringify(result.error)}`,
  );
  if (reason !== undefined) {
    assert.equal(
      result.error?.reason,
      reason,
      `${prefix}${JSON.stringify(result.error)}`,
    );
  }
}

function internal(
  result: Pick<TransportInvocationResult, "ok" | "error">,
  label = "",
): void {
  const prefix = label ? `${label}: ` : "";
  assert.equal(result.ok, false, `${prefix}expected a generic internal error`);
  const status = result.error?.statusCode;
  assert.ok(
    status === undefined || status >= 500,
    `${prefix}expected a 5xx, got ${JSON.stringify(result.error)}`,
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

/** A context type no built-in transport handles (T-public-unclaimed-context). */
const UNCLAIMED_CONTEXT = "nestjs-slightly-better-auth:conformance-unclaimed";

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
  let legShape: Promise<boolean> | undefined;
  /** Whether the browser leg is the connection's handshake, read once per kit from the transport. */
  const connectionLeg = async (): Promise<boolean> => {
    if (!options.expectBrowserLeg) {
      return false;
    }
    legShape ??= connectionShaped(options);
    return legShape;
  };
  const kitEnvironment = async (
    authOptions?: Omit<BetterAuthOptions, "database">,
    settings?: ConformanceAuthSettings,
  ): Promise<KitEnv> =>
    environment(authOptions, await connectionLeg(), settings);
  const addRun = (
    id: string,
    title: string,
    run: () => Promise<ConformanceOutcome>,
    skip?: string,
  ) => cases.push(conformanceCase(id, title, run, skip));
  const add = (
    id: string,
    title: string,
    run: (env: KitEnv) => Promise<ConformanceOutcome>,
    skip?: string,
  ) => addRun(id, title, async () => run(await kitEnvironment()), skip);
  const noBrowser = options.expectBrowserLeg
    ? undefined
    : "the transport declares no browser leg";
  /** Undefined when the browser leg follows each operation; a skip when it is the connection's handshake. */
  const operationLeg = async (): Promise<ConformanceSkip | undefined> =>
    (await connectionLeg())
      ? conformanceSkip(
          "the browser leg is the connection's handshake, enforced on every message (T-ws-origin-* cover it)",
        )
      : undefined;
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
  const graphOf = (result: GraphResult, root: string, field?: string) => {
    const node = (result.data as Record<string, unknown> | null | undefined)?.[
      root
    ] as Record<string, unknown> | null | undefined;
    return field === undefined ? node : node?.[field];
  };
  const userOf = (value: unknown) =>
    (value as { principal?: { userId?: string } | null } | null | undefined)
      ?.principal?.userId ?? null;
  const host = new URL(KIT_BASE_URL).host;
  const dynamicBaseURL = { allowedHosts: [host], fallback: KIT_BASE_URL };
  const cookie = (env: KitEnv) => ({
    cookie: env.identity.cookie,
    ...(env.connectionLeg ? { origin: KIT_BASE_URL } : {}),
  });

  add(
    "T-selection",
    "handles() accepts its contexts with and without credentials and rejects foreign ones",
    (env) =>
      withApp(options, env, async ({ app, instrumentation }) => {
        const transport = resolvedTransport(app, options.transport);
        const registry = app.get<TransportRegistry>(TRANSPORT_REGISTRY, {
          strict: false,
        });
        instrumentation.recordLegs = !options.expectBrowserLeg;
        succeeded(await options.invoke(app, "optional", {}));
        instrumentation.recordLegs = false;
        for (const leg of instrumentation.legs) {
          assert.equal(
            leg,
            "none",
            "the transport describes a browser leg, so expectBrowserLeg must be true",
          );
        }
        succeeded(await options.invoke(app, "optional", cookie(env)));
        assert.ok(
          instrumentation.contexts.length >= 2,
          "the guard described no invocation",
        );
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
    "T-public-unclaimed-context",
    "in a context type no registered transport handles, a public handler runs without auth work and a required one answers NO_TRANSPORT",
    (env) =>
      withApp(options, env, async ({ app, instrumentation }) => {
        const creator = app.get(ExternalContextCreator, { strict: false });
        const run = (fixture: FixtureName) => {
          const { instance, method } = fixtureInstance(app, fixture);
          const callback = Reflect.get(instance, method) as (
            ...args: unknown[]
          ) => unknown;
          const handler = creator.create(
            instance as Record<string, (...args: unknown[]) => unknown>,
            callback,
            method,
            undefined,
            undefined,
            undefined,
            undefined,
            { guards: true, interceptors: true, filters: false },
            UNCLAIMED_CONTEXT,
          );
          return settle(async () => handler({}));
        };
        const from = env.probe.calls.length;
        const described = instrumentation.contexts.length;
        const reached = await run("public");
        assert.ok(
          reached.ok,
          `the public handler did not run: ${String(!reached.ok && reached.error)}`,
        );
        assert.equal(
          instrumentation.contexts.length,
          described,
          "the guard described a context no transport handles",
        );
        assert.equal(sessionReads(env.probe, from), 0, "the session was read");
        const required = await run("required");
        assert.equal(required.ok, false, "the required handler ran");
        assert.deepEqual(
          bootIssueCodes(!required.ok && required.error),
          ["NO_TRANSPORT"],
          `expected NO_TRANSPORT, got ${String(!required.ok && required.error)}`,
        );
        assert.equal(sessionReads(env.probe, from), 0, "the session was read");
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
    "an unsafe cookie operation needs a trusted origin, checked before any session read, unless an explicit opt-out applies; Better Auth's boolean origin skip is not one",
    async (env) => {
      const skip = await operationLeg();
      if (skip) {
        return skip;
      }
      await withApp(options, env, async ({ app }) => {
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
      });
      // Explicit opt-outs: @SkipOriginCheck() on the handler, and Better Auth's own advanced.disableCSRFCheck.
      const untrusted = async (
        app: INestApplication,
        kit: KitEnv,
        label: string,
      ) => {
        const result = await options.invoke(app, "unsafe", {
          ...cookie(kit),
          origin: UNTRUSTED_ORIGIN,
        });
        succeeded(result, `${label}: a cookie from an untrusted Origin`);
        assert.equal(principalOf(result)?.userId, kit.identity.userId, label);
      };
      await withApp(
        options,
        env,
        ({ app }) => untrusted(app, env, "@SkipOriginCheck()"),
        { fixtures: kitFixtures({ unsafe: [SkipOriginCheck()] }) },
      );
      const disabled = await kitEnvironment({}, { disableCSRFCheck: true });
      await withApp(options, disabled, ({ app }) =>
        untrusted(app, disabled, "advanced.disableCSRFCheck"),
      );
      // Better Auth's boolean origin skip with an explicit disableCSRFCheck: false opens only Better Auth's own
      // routes; application operations stay checked, a deliberate divergence that B19 names. [R6:BA-r6-01]
      const sdkSkip = await kitEnvironment(
        {},
        { disableOriginCheck: true, disableCSRFCheck: false },
      );
      const skipLogger = new CapturingLogger();
      await withApp(
        options,
        sdkSkip,
        async ({ app }) => {
          const from = sdkSkip.probe.calls.length;
          denied(
            await options.invoke(app, "unsafe", {
              ...cookie(sdkSkip),
              origin: UNTRUSTED_ORIGIN,
            }),
            403,
            "INVALID_ORIGIN",
          );
          assert.equal(
            sessionReads(sdkSkip.probe, from),
            0,
            "disableOriginCheck: true with disableCSRFCheck: false: the session was read",
          );
          succeeded(
            await options.invoke(app, "unsafe", {
              ...cookie(sdkSkip),
              origin: KIT_BASE_URL,
            }),
            "disableOriginCheck: true with disableCSRFCheck: false: the trusted base URL",
          );
        },
        {},
        skipLogger,
      );
      assert.ok(
        skipLogger.entries.some(
          (entry) =>
            entry.level === "warn" &&
            entry.text.startsWith("W_ORIGIN_CHECK:") &&
            entry.text.includes("app-route checks remain on"),
        ),
        `boot did not warn W_ORIGIN_CHECK that app-route checks remain on (pass the logger option to the app): ${skipLogger.text().slice(0, 500)}`,
      );
    },
    noBrowser,
  );
  add(
    "T-csrf-http-cookie-plus-token",
    "a cookie plus a bearer token from an untrusted origin is still denied",
    async (env) =>
      (await operationLeg()) ??
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
      const skip = await operationLeg();
      if (skip) {
        return skip;
      }
      const user = await kitIdentity(env.auth, { password: true });
      const credentials = { email: user.email, password: user.password! };
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
      // An inheriting forwarding field under a safe query is in form mode: boot needs field guards to reach it, and a
      // cross-site request is denied before the field calls Better Auth. [R7:SEC-r7-01]
      if (await graphReady(env)) {
        return;
      }
      const forwarding = (guarded: boolean) =>
        kitFixtures({}, [], { guarded, forwarding: credentials });
      await expectBootFailure(
        options,
        env,
        { fieldResolverEnhancers: [], fixtures: forwarding(false) },
        "FIELD_RESOLVER_UNGUARDED",
      );
      await withApp(
        options,
        env,
        async ({ app }) => {
          const signIns = env.probe.calls.filter(
            (path) => path === "/sign-in/email",
          ).length;
          const writes = env.probe.writes.length;
          const selection: GraphSelection[] = [
            { root: "public", fields: ["forwarding", "reader"] },
          ];
          const navigation = await options.invokeGraph!(app, selection, {
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": "navigate",
            "sec-fetch-dest": "document",
          });
          assert.ok(
            navigation.errors.some(
              (error) =>
                error.path.includes("forwarding") &&
                error.reason === "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
            ),
            `a cross-site navigation reached the inherited forwarding field: ${JSON.stringify(navigation)}`,
          );
          assert.equal(
            env.probe.calls.filter((path) => path === "/sign-in/email").length,
            signIns,
            "a cross-site navigation reached Better Auth through the inherited forwarding field",
          );
          assert.deepEqual(
            env.probe.writes.slice(writes),
            [],
            "a cross-site navigation wrote a session through the inherited forwarding field",
          );
          for (const [headers, label] of [
            [{ origin: KIT_BASE_URL }, "a trusted fetch"],
            [{}, "a headerless non-browser request"],
          ] as const) {
            const result = await options.invokeGraph!(app, selection, headers);
            assert.deepEqual(
              result.errors,
              [],
              `${label} of the inherited forwarding field: ${JSON.stringify(result.errors)}`,
            );
            assert.equal(graphOf(result, "public", "forwarding"), "forwarded");
            assert.equal(
              userOf(graphOf(result, "public", "reader")),
              null,
              `${label}: the forwarding field changed the inherited reading`,
            );
          }
        },
        {
          fieldResolverEnhancers: ["guards", "interceptors"],
          fixtures: forwarding(true),
        },
      );
    },
    noBrowser,
  );
  add(
    "T-csrf-safe-methods",
    "safe cookie reads are not denied by origin validation, while forwarding enforces form mode without cookies",
    async (env) => {
      const skip = await operationLeg();
      if (skip) {
        return skip;
      }
      const user = await kitIdentity(env.auth, { password: true });
      await withApp(options, env, async ({ app, logger }) => {
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
        // A direct call presenting the caller's session needs a passing verdict for this leg: the guarded safe
        // operation computes an advisory one, a public handler none. [R5:SEC-r5-01]
        const direct = { cookie: env.identity.cookie };
        const callerSession = async (
          handler: "callerSession" | "publicCallerSession",
          origin: string | undefined,
        ) =>
          options.invoke(
            app,
            handler,
            { ...cookie(env), ...(origin === undefined ? {} : { origin }) },
            direct,
          );
        for (const origin of [UNTRUSTED_ORIGIN, undefined]) {
          const label = `a guarded safe operation's direct caller-session call ${origin ? "from an untrusted Origin" : "without Origin"}`;
          const errors = logger.errors().length;
          internal(await callerSession("callerSession", origin), label);
          assert.match(
            logger
              .errors()
              .slice(errors)
              .map((entry) => entry.text)
              .join("\n"),
            /PUBLIC_HANDLER_USED_CALLER_SESSION/,
            label,
          );
        }
        const trusted = await callerSession("callerSession", KIT_BASE_URL);
        succeeded(
          trusted,
          "a guarded safe operation's direct caller-session call from a trusted Origin",
        );
        assert.equal(
          (trusted.body as { userId?: string }).userId,
          env.identity.userId,
        );
        for (const origin of [KIT_BASE_URL, UNTRUSTED_ORIGIN]) {
          internal(
            await callerSession("publicCallerSession", origin),
            `a public handler's direct caller-session call from ${origin}`,
          );
        }
      });
    },
    noBrowser,
  );
  /** Guarded fixtures a connection case sends, one message each, on one connection. */
  const guardedMessages: readonly FixtureName[] = [
    "required",
    "optional",
    "acceptsApiKey",
  ];
  /** Undefined when the browser leg is the connection's handshake and invokeConnection is given; fails without it. */
  const connectionReady = async (): Promise<ConformanceSkip | undefined> => {
    if (!(await connectionLeg())) {
      return conformanceSkip(
        "the browser leg follows each operation (T-csrf-* cover it)",
      );
    }
    assert.ok(
      options.invokeConnection,
      "the transport's browser leg is its connection's handshake, so invokeConnection is required",
    );
    return undefined;
  };
  /** Whether the kit checks connection-time authentication: required when the app provides WS_CONNECTION_AUTH. */
  const authenticatesConnections = (app: INestApplication): boolean => {
    let provided: boolean;
    try {
      app.get(WS_CONNECTION_AUTH, { strict: false });
      provided = true;
    } catch {
      provided = false;
    }
    assert.ok(
      !provided || options.authenticateConnection,
      "the app provides WS_CONNECTION_AUTH, so authenticateConnection is required",
    );
    return options.authenticateConnection !== undefined;
  };
  /** Every guarded message of one connection, and connection-time authentication, answer the denial. */
  const deniedOnConnection = async (
    app: INestApplication,
    headers: Record<string, string>,
    status: number,
    reason: string,
    label: string,
  ) => {
    const results = await options.invokeConnection!(
      app,
      guardedMessages,
      headers,
    );
    assert.equal(results.length, guardedMessages.length, label);
    for (const [index, result] of results.entries()) {
      denied(result, status, reason, `${label}, ${guardedMessages[index]}`);
    }
    if (authenticatesConnections(app)) {
      denied(
        await options.authenticateConnection!(app, headers),
        status,
        reason,
        `${label}, connection-time authentication`,
      );
    }
  };
  /** Every guarded message of one connection reads the user, and connection-time authentication succeeds. */
  const allowedOnConnection = async (
    app: INestApplication,
    headers: Record<string, string>,
    userId: string,
    label: string,
  ) => {
    const results = await options.invokeConnection!(
      app,
      guardedMessages,
      headers,
    );
    assert.equal(results.length, guardedMessages.length, label);
    for (const [index, result] of results.entries()) {
      succeeded(result, `${label}, ${guardedMessages[index]}`);
      assert.equal(principalOf(result)?.userId, userId, label);
    }
    if (authenticatesConnections(app)) {
      const connection = await options.authenticateConnection!(app, headers);
      assert.equal(
        connection.ok,
        true,
        `${label}, connection-time authentication: ${JSON.stringify(connection.error)}`,
      );
    }
  };
  addRun(
    "T-ws-origin-untrusted",
    "a handshake with a cookie and an untrusted or missing Origin is denied on every message and at connection time, a token-only handshake is allowed, and a function-valued trustedOrigins runs once per connection",
    async () => {
      const skip = await connectionReady();
      if (skip) {
        return skip;
      }
      const requests: (Request | undefined)[] = [];
      const env = await kitEnvironment({
        trustedOrigins: (request?: Request) => {
          requests.push(request);
          return [FUNCTION_TRUSTED_ORIGIN];
        },
      });
      await withApp(options, env, async ({ app }) => {
        const session = env.identity.cookie;
        await deniedOnConnection(
          app,
          { cookie: session, origin: UNTRUSTED_ORIGIN },
          403,
          "INVALID_ORIGIN",
          "a cookie handshake from an untrusted Origin",
        );
        await deniedOnConnection(
          app,
          { cookie: session },
          403,
          "MISSING_OR_NULL_ORIGIN",
          "a cookie handshake without Origin",
        );
        for (const origin of [KIT_BASE_URL, UNTRUSTED_ORIGIN]) {
          await allowedOnConnection(
            app,
            { authorization: `Bearer ${env.identity.token}`, origin },
            env.identity.userId,
            `a token-only handshake from ${origin}`,
          );
        }
        const from = requests.length;
        const results = await options.invokeConnection!(app, guardedMessages, {
          cookie: session,
          origin: FUNCTION_TRUSTED_ORIGIN,
        });
        for (const result of results) {
          succeeded(
            result,
            "a cookie handshake from a function-trusted Origin",
          );
        }
        assert.equal(
          requests.length - from,
          1,
          `trustedOrigins() ran ${requests.length - from} times for one connection of ${guardedMessages.length} messages`,
        );
      });
    },
    noBrowser,
  );
  add(
    "T-ws-origin-junk-token",
    "a cookie plus a junk or valid bearer token from an untrusted Origin is denied on every message and at connection time",
    async (env) =>
      (await connectionReady()) ??
      withApp(options, env, async ({ app }) => {
        for (const [token, kind] of [
          ["a.b", "junk"],
          [env.identity.token, "valid"],
        ] as const) {
          await deniedOnConnection(
            app,
            {
              cookie: env.identity.cookie,
              authorization: `Bearer ${token}`,
              origin: UNTRUSTED_ORIGIN,
            },
            403,
            "INVALID_ORIGIN",
            `a cookie plus a ${kind} bearer token from an untrusted Origin`,
          );
        }
      }),
    noBrowser,
  );
  addRun(
    "T-ws-origin-dynamic-baseurl",
    "with a dynamic baseURL, a same-origin cookie handshake is allowed without a 500 and a cross-site one is denied",
    async () => {
      const skip = await connectionReady();
      if (skip) {
        return skip;
      }
      const env = await kitEnvironment({ baseURL: dynamicBaseURL });
      await withApp(options, env, async ({ app }) => {
        await allowedOnConnection(
          app,
          { cookie: env.identity.cookie, host, origin: KIT_BASE_URL },
          env.identity.userId,
          "a same-origin cookie handshake",
        );
        await deniedOnConnection(
          app,
          { cookie: env.identity.cookie, host, origin: UNTRUSTED_ORIGIN },
          403,
          "INVALID_ORIGIN",
          "a cross-site cookie handshake",
        );
      });
    },
    noBrowser,
  );
  addRun(
    "T-ws-origin-forwarded-host",
    "forwarded host and protocol headers never make an untrusted Origin the handshake's own, with a dynamic or unset baseURL and either trustedProxyHeaders",
    async () => {
      const skip = await connectionReady();
      if (skip) {
        return skip;
      }
      const spoof = {
        host,
        origin: UNTRUSTED_ORIGIN,
        "x-forwarded-host": new URL(UNTRUSTED_ORIGIN).host,
        "x-forwarded-proto": "https",
      };
      for (const baseURL of [dynamicBaseURL, undefined]) {
        for (const trustedProxyHeaders of [false, true]) {
          const env = await kitEnvironment({
            baseURL,
            advanced: { trustedProxyHeaders },
          });
          const label = `${baseURL ? "dynamic" : "unset"} baseURL, trustedProxyHeaders ${trustedProxyHeaders}`;
          await withApp(options, env, async ({ app }) => {
            await deniedOnConnection(
              app,
              { cookie: env.identity.cookie, ...spoof },
              403,
              "INVALID_ORIGIN",
              `${label}: a forwarded-host spoof`,
            );
            await allowedOnConnection(
              app,
              { cookie: env.identity.cookie, host, origin: KIT_BASE_URL },
              env.identity.userId,
              `${label}: a same-origin handshake`,
            );
          });
        }
      }
    },
    noBrowser,
  );
  addRun(
    "T-ws-origin-function-trusted-origins",
    "a function-valued trustedOrigins receives the handshake's absolute URL, and a throwing one answers the generic internal error",
    async () => {
      const skip = await connectionReady();
      if (skip) {
        return skip;
      }
      const requests: (Request | undefined)[] = [];
      let outage: Error | undefined;
      const env = await kitEnvironment({
        trustedOrigins: (request?: Request) => {
          requests.push(request);
          if (outage) {
            throw outage;
          }
          return [FUNCTION_TRUSTED_ORIGIN];
        },
      });
      await withApp(options, env, async ({ app }) => {
        const headers = {
          cookie: env.identity.cookie,
          host,
          origin: FUNCTION_TRUSTED_ORIGIN,
        };
        const from = requests.length;
        await allowedOnConnection(
          app,
          headers,
          env.identity.userId,
          "a cookie handshake from a function-trusted Origin",
        );
        const received = requests.slice(from);
        assert.ok(received.length > 0, "trustedOrigins() was not called");
        for (const request of received) {
          assert.ok(
            request instanceof Request,
            "trustedOrigins() received no Request",
          );
          assert.equal(
            new URL(request.url).origin,
            KIT_BASE_URL,
            `trustedOrigins() received ${request.url}, not the handshake's absolute URL`,
          );
        }
        const secret = `trusted-origins-outage-${globalThis.crypto.randomUUID()}`;
        outage = new Error(secret);
        try {
          const results = await options.invokeConnection!(
            app,
            guardedMessages,
            headers,
          );
          for (const [index, result] of results.entries()) {
            internal(
              result,
              `a throwing trustedOrigins(), ${guardedMessages[index]}`,
            );
            assert.ok(
              !JSON.stringify(result.error ?? {}).includes(secret),
              "the client saw the trustedOrigins() error",
            );
          }
          if (authenticatesConnections(app)) {
            const connection = await options.authenticateConnection!(
              app,
              headers,
            );
            internal(
              connection,
              "a throwing trustedOrigins(), connection-time authentication",
            );
            assert.ok(
              !JSON.stringify(connection.error ?? {}).includes(secret),
              "the client saw the trustedOrigins() error at connection time",
            );
          }
        } finally {
          outage = undefined;
        }
      });
    },
    noBrowser,
  );
  const subscriptions = options.invocationShapes?.includes("subscriptions")
    ? undefined
    : "the harness serves no subscriptions (invocationShapes lacks 'subscriptions')";
  const subscribe = (app: INestApplication, headers: HeadersInit) =>
    options.invokeTwice!(
      app,
      "subscriptions",
      [{ orgId: "org-a" }, { orgId: "org-a2" }],
      headers,
    );
  const subscriptionDenied = async (
    app: INestApplication,
    headers: Record<string, string>,
    label: string,
    connectionParams?: Record<string, string>,
  ) => {
    for (const [index, result] of (await subscribe(app, headers)).entries()) {
      assert.equal(result.ok, false, `${label}, subscription ${index + 1}`);
      assert.equal(
        result.error?.reason,
        "INVALID_ORIGIN",
        `${label}, subscription ${index + 1}: ${JSON.stringify(result.error)}`,
      );
    }
    const messages: FixtureName[] = ["required", "unsafe"];
    const results = await options.invokeConnection!(
      app,
      messages,
      headers,
      connectionParams ? { connectionParams } : undefined,
    );
    for (const [index, result] of results.entries()) {
      denied(result, 403, "INVALID_ORIGIN", `${label}, ${messages[index]}`);
    }
  };
  add(
    "T-subscription-credentials",
    "subscriptions extract credentials from the upgrade cookie and from connectionParams, and deny anonymous connections",
    async (env) => {
      assert.ok(
        options.invokeConnection,
        "the harness serves subscriptions, so invokeConnection is required",
      );
      const other = await kitIdentity(env.auth);
      await withApp(options, env, async ({ app }) => {
        for (const [headers, label] of [
          [cookie(env), "an upgrade cookie"],
          [
            { authorization: `Bearer ${env.identity.token}` },
            "a connectionParams bearer token",
          ],
        ] as const) {
          assert.deepEqual(
            (await subscribe(app, headers)).map((result) => result.ok),
            [true, true],
            `${label} did not authenticate its subscriptions`,
          );
        }
        assert.deepEqual(
          (await subscribe(app, {})).map((result) => result.ok),
          [false, false],
          "an anonymous connection's subscriptions were allowed",
        );
        // A connectionParams cookie replaces the upgrade cookie in the credentials.
        const [replaced] = await options.invokeConnection!(
          app,
          ["required"],
          cookie(env),
          { connectionParams: { cookie: other.cookie } },
        );
        succeeded(replaced!, "a connectionParams cookie");
        assert.equal(
          principalOf(replaced!)?.userId,
          other.userId,
          "the connectionParams cookie did not replace the upgrade cookie in the credentials",
        );
      });
    },
    subscriptions,
  );
  add(
    "T-subscription-origin",
    "subscriptions, queries and mutations on a socket whose upgrade carries a cookie and an untrusted Origin are denied, whatever connectionParams carry",
    async (env) => {
      assert.ok(
        options.invokeConnection,
        "the harness serves subscriptions, so invokeConnection is required",
      );
      const other = await kitIdentity(env.auth);
      const hostile = { cookie: env.identity.cookie, origin: UNTRUSTED_ORIGIN };
      const contexts = options.graphqlContexts ?? [];
      for (const graphqlContext of [
        undefined,
        ...(contexts.includes("fresh") ? (["fresh"] as const) : []),
      ]) {
        const label = graphqlContext
          ? `a ${graphqlContext} GraphQL context`
          : "the driver's context";
        await withApp(
          options,
          env,
          async ({ app }) => {
            await subscriptionDenied(
              app,
              hostile,
              `${label}: an untrusted Origin`,
            );
            // The browser leg keeps the upgrade cookie when connectionParams replace it in the credentials.
            await subscriptionDenied(
              app,
              hostile,
              `${label}: an untrusted Origin with a connectionParams cookie`,
              { cookie: other.cookie },
            );
            await allowedOnConnection(
              app,
              cookie(env),
              env.identity.userId,
              `${label}: a trusted Origin`,
            );
          },
          graphqlContext ? { graphqlContext } : {},
        );
      }
      if (contexts.includes("plain-request")) {
        await withApp(
          options,
          env,
          async ({ app, logger }) => {
            const results = await options.invokeConnection!(
              app,
              ["required", "unsafe"],
              cookie(env),
            );
            for (const result of results) {
              internal(
                result,
                "a context holding only the cookie in a plain req",
              );
            }
            assert.match(logger.text(), /GRAPHQL_CONTEXT_UNRECOGNIZED/);
          },
          { graphqlContext: "plain-request" },
        );
      }
    },
    subscriptions,
  );
  add(
    "T-subscription-origin-junk-connection-params",
    "a junk connectionParams bearer token beside the victim's upgrade cookie from an untrusted Origin is denied for subscriptions and queries",
    async (env) => {
      assert.ok(
        options.invokeConnection,
        "the harness serves subscriptions, so invokeConnection is required",
      );
      await withApp(options, env, async ({ app }) => {
        // The harness carries a bearer token of a connection in connectionParams, where graphql-ws clients put it.
        await subscriptionDenied(
          app,
          {
            cookie: env.identity.cookie,
            origin: UNTRUSTED_ORIGIN,
            authorization: "Bearer a.b",
          },
          "a junk connectionParams bearer token",
          { authorization: "Bearer a.b" },
        );
      });
    },
    subscriptions,
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
  add(
    "T-internal-error-logged-once",
    "reader configuration errors under 20 list items log one ERROR entry per request and distinct error, with field interceptors and with lineage alone",
    async (env) => {
      const skip = await graphReady(env);
      if (skip) {
        return skip;
      }
      const apiKey = { "x-api-key": env.keys.valid };
      /** One `items` operation: asserts 20 failed `field` values and returns the ERROR entries it logged. */
      const items = async (
        app: INestApplication,
        logger: CapturingLogger,
        fields: readonly (keyof GraphFixtures["fields"])[],
        headers: HeadersInit,
        label: string,
      ): Promise<string[]> => {
        const from = logger.errors().length;
        const result = await options.invokeGraph!(
          app,
          [{ root: "items", fields }],
          headers,
        );
        const list = (result.data as Record<string, unknown> | null)?.items as
          | readonly Record<string, unknown>[]
          | null
          | undefined;
        assert.equal(
          list?.length,
          ITEM_COUNT,
          `${label}: the items root did not return ${ITEM_COUNT} items: ${JSON.stringify(result).slice(0, 500)}`,
        );
        for (const field of fields) {
          const failed = result.errors.filter(
            (error) => error.path.at(-1) === field,
          );
          assert.equal(
            failed.length,
            ITEM_COUNT,
            `${label}: ${failed.length} ${field} errors instead of one per item: ${JSON.stringify(result.errors).slice(0, 500)}`,
          );
          assert.ok(
            list!.every((item) => item[field] === null),
            `${label}: a ${field} value resolved`,
          );
          for (const error of failed) {
            assert.ok(
              !/[A-Z]+_[A-Z_]+/.test(error.message ?? ""),
              `${label}: the client saw the configuration detail ${error.message}`,
            );
          }
        }
        assert.equal(
          result.errors.length,
          ITEM_COUNT * fields.length,
          `${label}: ${JSON.stringify(result.errors).slice(0, 500)}`,
        );
        return logger
          .errors()
          .slice(from)
          .map((entry) => entry.text);
      };
      const once = (entries: readonly string[], code: string, label: string) =>
        assert.ok(
          entries.length === 1 && entries[0]!.includes(code),
          `${label}: expected one ERROR entry with ${code}, got ${entries.length}: ${entries.join(" | ").slice(0, 500)}`,
        );
      // Readers throw configuration errors that share the guard's surfaced-error record. [R6:NEST-r6-02] [R7:NEST-r7-02]
      for (const enhancers of [
        ["guards", "interceptors", "filters"],
        ["guards", "filters"],
      ] as const) {
        const scoped = enhancers.includes("interceptors" as never);
        const boot = `[${enhancers.join(", ")}]`;
        await withApp(
          options,
          env,
          async ({ app, logger }) => {
            // A second request logs again: the bound is per request, not per process.
            for (const round of [1, 2]) {
              const label = `${boot}, request ${round}`;
              once(
                await items(
                  app,
                  logger,
                  ["sessionReader"],
                  apiKey,
                  `${label}: an API key's session readers`,
                ),
                "SESSION_REQUIRED",
                `${label}: an API key's session readers`,
              );
              once(
                await items(
                  app,
                  logger,
                  ["organizationReader"],
                  cookie(env),
                  `${label}: organization readers without a providing requirement`,
                ),
                "NO_INVOCATION_VALUE",
                `${label}: organization readers without a providing requirement`,
              );
              const service = await items(
                app,
                logger,
                ["serviceSession"],
                apiKey,
                `${label}: service getSession() for an API key`,
              );
              // A field scope bounds service reads by the request; without one each fresh NO_AUTH_SCOPE is logged.
              const code = scoped ? "SESSION_REQUIRED" : "NO_AUTH_SCOPE";
              assert.equal(
                service.length,
                scoped ? 1 : ITEM_COUNT,
                `${label}: service getSession() logged ${service.length} ERROR entries`,
              );
              assert.ok(
                service.every((entry) => entry.includes(code)),
                `${label}: service getSession() did not log ${code}: ${service.join(" | ").slice(0, 500)}`,
              );
            }
            // Distinct reasons of one request are not suppressed.
            const distinct = await items(
              app,
              logger,
              ["sessionReader", "organizationReader"],
              apiKey,
              `${boot}: session and organization readers together`,
            );
            assert.equal(
              distinct.length,
              2,
              `${boot}: two reasons logged ${distinct.length} ERROR entries: ${distinct.join(" | ").slice(0, 500)}`,
            );
            for (const code of ["SESSION_REQUIRED", "NO_INVOCATION_VALUE"]) {
              assert.ok(
                distinct.some((entry) => entry.includes(code)),
                `${boot}: ${code} was suppressed by another reason`,
              );
            }
          },
          {
            fieldResolverEnhancers: enhancers,
            fixtures: kitFixtures({}, [], { readerErrors: true }),
          },
        );
        // A guard that records no result leaves every nested reader without one. Without field interceptors such a
        // guard also records no lineage, so a reader has no request key to share and each fresh error is logged.
        if (!scoped) {
          continue;
        }
        await withApp(
          options,
          env,
          async ({ app, logger }) => {
            once(
              await items(
                app,
                logger,
                ["reader"],
                cookie(env),
                `${boot}: readers without an authentication result`,
              ),
              "NO_AUTH_RESULT",
              `${boot}: readers without an authentication result`,
            );
          },
          {
            fieldResolverEnhancers: enhancers,
            fixtures: kitFixtures({}, [], { readerErrors: true }),
            override: (builder) =>
              overrideAuthGuard(builder, { canActivate: () => true }),
          },
        );
      }
    },
    graphSkip,
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
    "T-carrier",
    "param decorators read the guard's reading with and without the scope interceptor, one value per invocation",
    async (env) => {
      for (const globalScope of [true, false]) {
        const label = globalScope
          ? "with the scope interceptor"
          : "with globalScope: false";
        await withApp(
          options,
          env,
          async ({ app }) => {
            const byCookie = await options.invoke(app, "required", cookie(env));
            succeeded(byCookie, `${label}: a cookie`);
            assert.deepEqual(principalOf(byCookie), {
              kind: "session",
              userId: env.identity.userId,
            });
            const byKey = await options.invoke(app, "acceptsApiKey", {
              "x-api-key": env.keys.valid,
            });
            succeeded(byKey, `${label}: an API key`);
            assert.equal(principalOf(byKey)?.kind, "api-key", label);
            const org = await options.invoke(app, "org", cookie(env), {
              orgId: "org-a",
            });
            succeeded(org, `${label}: @ActiveOrganizationId()`);
            assert.deepEqual(org.body, { organization: "org-a" }, label);
            // The org fixture fails when @ActiveOrganizationId() answers another invocation's organization.
            for (const shape of options.invocationShapes ?? []) {
              const values = await options.invokeTwice!(
                app,
                shape,
                [{ orgId: "org-a" }, { orgId: "org-a2" }],
                cookie(env),
              );
              assert.deepEqual(
                values.map((value) => value.ok),
                [true, true],
                `${label}, ${shape}: ${JSON.stringify(values)}`,
              );
            }
          },
          globalScope ? {} : { globalScope: false },
        );
      }
    },
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
        { logSummary: true },
        defaults,
      );
      assert.ok(
        claims.some((claim) => claim.fixture),
        "the transport claimed none of the kit's fixture handlers",
      );
      assert.match(
        summaryLine(defaults),
        /; scope: global;/,
        "the default boot's summary does not report the global scope interceptor",
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
          { globalScope: false, logSummary: true },
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
        // The summary reports the missing interceptor too. [R6:SEC-r6-03]
        assert.match(
          summaryLine(unscoped),
          /; scope: off — see W_NO_GLOBAL_SCOPE;/,
          "globalScope: false: the boot summary does not report scope: off",
        );
      }
    },
  );
  add(
    "T-metadata-canary",
    "validate() fails NEST_METADATA_KEY_CHANGED when Nest writes its metadata under other keys, and claims no class without handlers",
    (env) =>
      withApp(options, env, async ({ app }) => {
        // The boot ran the transport's canaries against the installed Nest.
        const claims = await recordClaims(app, options.transport);
        assert.ok(
          claims.some((claim) => claim.fixture),
          "the transport claimed none of the kit's fixture handlers",
        );
        const clones = [...new Set(claims.map((claim) => claim.target))].map(
          withoutHandlers,
        );
        const extra = await recordClaims(app, options.transport, {
          classes: clones,
        });
        assert.deepEqual(
          extra
            .filter((claim) => clones.includes(claim.target))
            .map((claim) => `${claim.target.name}.${String(claim.method)}`),
          [],
          "the transport claimed a class without handlers",
        );
        const renamed = await settle(() =>
          recordClaims(app, options.transport, { renameMetadata: true }),
        );
        assert.equal(
          renamed.ok,
          false,
          "validate() passed while Nest wrote its metadata under other keys: the transport runs no metadata canary",
        );
        assert.ok(
          bootIssueCodes(!renamed.ok && renamed.error).includes(
            "NEST_METADATA_KEY_CHANGED",
          ),
          `expected NEST_METADATA_KEY_CHANGED, got ${String(!renamed.ok && renamed.error)}`,
        );
      }),
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
  addRun(
    "T-dynamic-base-url",
    "with a dynamic baseURL without fallback, a transport with hostless calls fails boot and any other resolves every credential shape",
    async () => {
      let hostless = false;
      await withApp(
        options,
        await kitEnvironment({ baseURL: dynamicBaseURL }),
        async ({ app }) => {
          hostless =
            resolvedTransport(app, options.transport).requires
              ?.hostlessCalls === true;
        },
      );
      const env = await kitEnvironment({ baseURL: { allowedHosts: [host] } });
      if (hostless) {
        await expectBootFailure(
          options,
          env,
          {},
          "DYNAMIC_BASE_URL_WITHOUT_FALLBACK",
        );
        return;
      }
      await withApp(options, env, async ({ app }) => {
        for (const [handler, headers, kind] of [
          ["required", cookie(env), "session"],
          [
            "required",
            { authorization: `Bearer ${env.identity.token}` },
            "session",
          ],
          ["acceptsApiKey", { "x-api-key": env.keys.valid }, "api-key"],
        ] as const) {
          const result = await options.invoke(app, handler, {
            ...headers,
            host,
          });
          succeeded(result, `a ${kind} credential (${Object.keys(headers)})`);
          assert.deepEqual(principalOf(result), {
            kind,
            userId: env.identity.userId,
          });
        }
      });
    },
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
  const noInherited =
    "the harness exposes no inherited handler through two subclasses (invokeInherited)";
  addRun(
    "T-inherited-handler",
    "one inherited method answers per subclass, public then protected and the other way round",
    async () => {
      for (const order of [
        ["public", "denied"],
        ["denied", "public"],
      ] as const) {
        // A fresh boot per order: the first request of a boot fills the plan cache.
        const env = await kitEnvironment();
        await withApp(options, env, async ({ app }) => {
          for (let round = 0; round < 2; round++) {
            for (const subclass of order) {
              const label = `${order.join(" first, then ")}, round ${round + 1}: the ${subclass} subclass`;
              const result = await options.invokeInherited!(
                app,
                subclass,
                cookie(env),
              );
              if (subclass === "public") {
                succeeded(result, label);
              } else {
                denied(result, 403, "CONFORMANCE_DENIED", label);
              }
            }
          }
        });
      }
    },
    options.invokeInherited ? undefined : noInherited,
  );
  addRun(
    "T-stale-context",
    "a static GraphQL context fails boot, and a cached one never answers a later caller with an earlier caller's principal",
    async () => {
      const env = await kitEnvironment();
      if (!(await transportHas(options, env, "defaultAccessFor"))) {
        return conformanceSkip(
          "the transport nests no handlers, so it serves no GraphQL context",
        );
      }
      const contexts = options.graphqlContexts ?? [];
      assert.ok(
        contexts.includes("static") && contexts.includes("cached"),
        "the transport nests handlers, so graphqlContexts must include 'static' and 'cached'",
      );
      await expectBootFailure(
        options,
        env,
        { graphqlContext: "static" },
        "GRAPHQL_STATIC_CONTEXT",
      );
      // A cached context of a connection-shaped leg still holds a connection that may be open, so only a completed
      // per-operation request is detectable as stale.
      if (await connectionLeg()) {
        return;
      }
      const later = await kitIdentity(env.auth);
      const laterCookie = { ...cookie(env), cookie: later.cookie };
      await withApp(
        options,
        env,
        async ({ app, logger }) => {
          const first = await options.invoke(app, "required", cookie(env));
          succeeded(first, "the first caller of a cached context");
          assert.equal(principalOf(first)?.userId, env.identity.userId);
          for (const handler of ["required", "optional"] as const) {
            const result = await options.invoke(app, handler, laterCookie);
            const label = `a later caller of ${handler}`;
            // A driver that rebuilds its context around the cached object answers with the later caller's own principal.
            if (result.ok) {
              assert.equal(
                principalOf(result)?.userId,
                later.userId,
                `${label} did not read its own principal`,
              );
            } else {
              internal(result, label);
              assert.match(logger.text(), /GRAPHQL_CONTEXT_STALE_REQUEST/);
            }
          }
          // Public work reads no credential of the completed request.
          succeeded(
            await options.invoke(app, "public", laterCookie),
            "a later caller of a public handler",
          );
          const service = await options.invoke(
            app,
            "publicService",
            laterCookie,
          );
          succeeded(service, "a later caller of a public service read");
          assert.deepEqual(service.body, { session: null });
        },
        { graphqlContext: "cached" },
      );
    },
  );
  /** The claimed site of each graph fixture handler of a booted app, by fixture name. */
  const graphSites = async (app: INestApplication) => {
    const sites = new Map<string, { target: Type; method: string }>();
    for (const claim of await recordClaims(app, options.transport)) {
      if (claim.fixture?.startsWith("graph.") && claim.method !== undefined) {
        sites.set(claim.fixture.slice("graph.".length), {
          target: claim.target as Type,
          method: claim.method,
        });
      }
    }
    return sites;
  };
  const graphSite = (
    sites: Map<string, { target: Type; method: string }>,
    name: string,
  ) => {
    const site = sites.get(name);
    assert.ok(site, `the transport claimed no ${name} graph handler`);
    return site;
  };
  const planAt = (
    app: INestApplication,
    site: { target: Type; method: string },
  ): RoutePlan =>
    app
      .get<RoutePlanner>(ROUTE_PLANNER, { strict: false })
      .plan(site.target, site.method);
  /** The boot advice lines a logger captured for one code. */
  const adviceLines = (logger: CapturingLogger, code: string) =>
    logger.entries
      .map((entry) => entry.text)
      .filter((text) => text.startsWith(`${code}:`));
  add(
    "T-inherit-no-lookup",
    "an anonymous public operation with an inheriting field reads no session, a guarded field is still enforced, and class-level metadata reaches operations only",
    async (env) => {
      const skip = await graphReady(env);
      if (skip) {
        return skip;
      }
      for (const enhancers of enhancerBoots) {
        const guarded = enhancers.length > 0;
        const logger = new CapturingLogger();
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
            const sites = await graphSites(app);
            const [warning] = adviceLines(logger, "W_FIELD_RESOLVER_INHERITS");
            assert.ok(
              warning,
              `[${enhancers.join(", ")}]: boot did not warn W_FIELD_RESOLVER_INHERITS`,
            );
            const inheriting = warning.slice(
              0,
              warning.indexOf(" inherit readings"),
            );
            for (const field of ["plain", "reader"]) {
              const site = graphSite(sites, field);
              assert.ok(
                inheriting.includes(`${site.target.name}.${site.method}`),
                `W_FIELD_RESOLVER_INHERITS does not list ${field}: ${warning}`,
              );
            }
          },
          {
            fieldResolverEnhancers: enhancers,
            fixtures: kitFixtures({}, [], { guarded }),
          },
          logger,
        );
      }
      // Class-level acceptance reaches the operations of the resolver class, never its field resolvers. [R3:NEST-r3-05]
      for (const enhancers of enhancerBoots) {
        const logger = new CapturingLogger();
        const label = `class-level @AcceptPrincipals, [${enhancers.join(", ")}]`;
        await withApp(
          options,
          env,
          async ({ app }) => {
            const sites = await graphSites(app);
            for (const field of ["plain", "reader", "sessionReader"]) {
              assert.equal(
                planAt(app, graphSite(sites, field)).access,
                "inherit",
                `${label}: the ${field} field resolver lost its inherit plan`,
              );
            }
            const root = graphSite(sites, "sessionOnly");
            assert.deepEqual(
              [...planAt(app, root).accepts].sort(),
              [API_KEY_KIND, SESSION_KIND],
              `${label}: the class-level acceptance did not reach the root field`,
            );
            const from = env.probe.calls.length;
            const result = await options.invokeGraph!(
              app,
              [{ root: "public", fields: ["plain", "reader"] }],
              {},
            );
            assert.deepEqual(
              result.errors,
              [],
              `${label}: ${JSON.stringify(result.errors)}`,
            );
            assert.equal(sessionReads(env.probe, from), 0, label);
            const [info] = adviceLines(
              logger,
              "I_CLASS_METADATA_OPERATIONS_ONLY",
            );
            assert.ok(
              info?.includes(root.target.name),
              `${label}: I_CLASS_METADATA_OPERATIONS_ONLY does not name ${root.target.name}: ${info}`,
            );
            for (const field of ["plain", "reader"]) {
              assert.ok(
                info.includes(graphSite(sites, field).method),
                `${label}: I_CLASS_METADATA_OPERATIONS_ONLY does not name the ${field} field: ${info}`,
              );
            }
          },
          {
            fieldResolverEnhancers: enhancers,
            fixtures: kitFixtures({}, [], {
              guarded: enhancers.length > 0,
              classDecorators: [AcceptPrincipals(SESSION_KIND, API_KEY_KIND)],
            }),
          },
          logger,
        );
      }
    },
    graphSkip,
  );
  add(
    "T-stamp-per-plan",
    "a nested reader reads its own enclosing field's reading, whichever source settles first",
    async (env) => {
      const skip = await graphReady(env);
      if (skip) {
        return skip;
      }
      // User Y's cookie and user X's key in one operation.
      env.keys.owner = (await kitIdentity(env.auth)).userId;
      const userY = env.identity.userId;
      const headers = { ...cookie(env), "x-api-key": env.keys.valid };
      for (const enhancers of enhancerBoots) {
        const guarded = enhancers.length > 0;
        const logger = new CapturingLogger();
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
                    { root: "sessionOnly", fields: ["reader", "publicNested"] },
                    {
                      root: "mixed",
                      fields: guarded ? ["reader", "guarded"] : ["reader"],
                    },
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
                  userY,
                  `${label}: reader under sessionOnly`,
                );
                assert.equal(
                  userOf(
                    (
                      graphOf(result, "sessionOnly", "publicNested") as {
                        reader?: unknown;
                      } | null
                    )?.reader,
                  ),
                  userY,
                  `${label}: reader under publicNested under sessionOnly`,
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
                if (guarded) {
                  const node = graphOf(result, "mixed", "guarded") as {
                    principal?: { userId?: string };
                    nestedReader?: unknown;
                  } | null;
                  assert.equal(
                    node?.principal?.userId,
                    userY,
                    `${label}: guarded under mixed accepts sessions only`,
                  );
                  assert.equal(
                    userOf(node?.nestedReader),
                    userY,
                    `${label}: nestedReader under guarded must read guarded's own principal`,
                  );
                }
              } finally {
                env.probe.delay = undefined;
                env.keys.delayMs = 0;
              }
            }
            const alone = await options.invokeGraph!(
              app,
              [{ root: "public", fields: ["reader"] }],
              headers,
            );
            assert.deepEqual(alone.errors, [], JSON.stringify(alone.errors));
            assert.equal(
              userOf(graphOf(alone, "public", "reader")),
              null,
              "reader under a public root without a guarded sibling",
            );
            // A nested session reader under a root that accepts API keys. [R5:NEST-r5-03]
            const sessionReader: GraphSelection[] = [
              { root: "mixed", fields: ["sessionReader"] },
            ];
            const bySession = await options.invokeGraph!(
              app,
              sessionReader,
              cookie(env),
            );
            assert.deepEqual(
              bySession.errors,
              [],
              JSON.stringify(bySession.errors),
            );
            assert.equal(graphOf(bySession, "mixed", "sessionReader"), userY);
            const byKey = await options.invokeGraph!(app, sessionReader, {
              "x-api-key": env.keys.valid,
            });
            assert.ok(
              byKey.errors.length === 1 &&
                byKey.errors[0]!.path.includes("sessionReader"),
              `an API key's nested session read did not fail at the field: ${JSON.stringify(byKey)}`,
            );
            assert.equal(graphOf(byKey, "mixed", "sessionReader"), null);
            assert.match(logger.text(), /SESSION_REQUIRED/);
            const sessionSite = graphSite(
              await graphSites(app),
              "sessionReader",
            );
            assert.ok(
              adviceLines(logger, "W_NESTED_PRINCIPAL_PARAM").some((line) =>
                line.includes(
                  `${sessionSite.target.name}.${sessionSite.method}`,
                ),
              ),
              "boot did not list sessionReader in W_NESTED_PRINCIPAL_PARAM",
            );
          },
          {
            fieldResolverEnhancers: enhancers,
            fixtures: kitFixtures({}, [], { guarded }),
          },
          logger,
        );
      }
      // Instance-wide forwarding puts publicNested in form mode; the reading below it stays the root's. [R5:NEST-r5-05]
      for (const enhancers of enhancerBoots) {
        await withApp(
          options,
          env,
          async ({ app }) => {
            const result = await options.invokeGraph!(
              app,
              [{ root: "sessionOnly", fields: ["publicNested"] }],
              { ...cookie(env), origin: KIT_BASE_URL },
            );
            const label = `cookies.forwardDirectCalls, [${enhancers.join(", ")}]`;
            assert.deepEqual(
              result.errors,
              [],
              `${label}: ${JSON.stringify(result.errors)}`,
            );
            assert.equal(
              userOf(
                (
                  graphOf(result, "sessionOnly", "publicNested") as {
                    reader?: unknown;
                  } | null
                )?.reader,
              ),
              userY,
              `${label}: reader under publicNested under sessionOnly`,
            );
          },
          {
            fieldResolverEnhancers: enhancers,
            forwardDirectCalls: true,
            fieldResolverCoverage: "warn",
            fixtures: kitFixtures(),
          },
        );
      }
    },
    graphSkip,
  );
  const federation = (graph: GraphBoot = {}): BootOptions => ({
    federation: true,
    fieldResolverEnhancers: ["guards", "interceptors"],
    fixtures: kitFixtures({}, [], { guarded: true, reference: true, ...graph }),
  });
  add(
    "T-reference-resolver",
    "federation reference resolvers need field guards and decide each entity, and inheriting entity fields need one",
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
          federation(),
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
        { ...federation(), fieldResolverEnhancers: undefined },
        ["REFERENCE_RESOLVER_UNGUARDED", "FEDERATION_FIELD_GUARDS_REQUIRED"],
      );
      const representations = [
        { __typename: "FixtureNode", id: "1", orgId: "org-a" },
        { __typename: "FixtureNode", id: "2", orgId: "org-b" },
      ];
      await withApp(
        options,
        env,
        async ({ app }) => {
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
            ["plain", "reader"],
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
          const [entity] =
            (decided.data as { _entities?: unknown[] } | null)?._entities ?? [];
          assert.equal(
            userOf((entity as { reader?: unknown } | undefined)?.reader),
            env.identity.userId,
            `reader under _entities.0 must read the reference resolver's reading: ${JSON.stringify(decided.data)}`,
          );
        },
        federation(),
      );
      // Without a reference resolver no guard decides the entity, so its inheriting fields answer the generic 500 of
      // NO_ENCLOSING_DECISION.
      await withApp(
        options,
        env,
        async ({ app }) => {
          const result = await options.invokeEntities!(
            app,
            representations.slice(0, 1),
            ["plain", "reader"],
            cookie(env),
          );
          const [entity] = ((result.data as { _entities?: unknown[] } | null)
            ?._entities ?? []) as ({
            plain?: unknown;
            reader?: unknown;
          } | null)[];
          assert.ok(
            entity?.plain == null && entity?.reader == null,
            `an entity without a reference resolver answered data: ${JSON.stringify(result.data)}`,
          );
          for (const field of ["plain", "reader"]) {
            assert.ok(
              result.errors.some(
                (error) =>
                  error.path.includes(field) &&
                  error.code !== "UNAUTHENTICATED" &&
                  error.code !== "FORBIDDEN",
              ),
              `${field} did not answer the generic internal error: ${JSON.stringify(result.errors)}`,
            );
          }
        },
        federation({ reference: false }),
      );
      // A class-level organization requirement reaches the reference resolver, whose representation carries orgId.
      // [R5:NEST-r5-02]
      const orgEnv = await kitEnvironment({ plugins: [organization()] });
      const member = await createKitOrganization(orgEnv);
      await withApp(
        options,
        orgEnv,
        async ({ app, logger }) => {
          const reference = (await recordClaims(app, options.transport)).find(
            (claim) => claim.fixture === "reference",
          );
          assert.ok(reference, "the transport claimed no reference resolver");
          const site = `${reference.target.name}.${String(reference.method)}`;
          assert.ok(
            adviceLines(logger, "W_ORG_PARAM_MISSING").some((line) =>
              line.includes(site),
            ),
            `boot did not name ${site} in W_ORG_PARAM_MISSING: ${logger.text().slice(0, 800)}`,
          );
          const [info] = adviceLines(
            logger,
            "I_CLASS_METADATA_OPERATIONS_ONLY",
          );
          assert.ok(
            info?.includes(reference.target.name) &&
              info.includes(String(reference.method)),
            `I_CLASS_METADATA_OPERATIONS_ONLY does not name ${site} as reached: ${info}`,
          );
          const decided = await options.invokeEntities!(
            app,
            [
              { __typename: "FixtureNode", id: "1", orgId: member },
              { __typename: "FixtureNode", id: "2", orgId: "org-b" },
            ],
            ["plain"],
            cookie(orgEnv),
          );
          assert.equal(
            decided.errors.length,
            1,
            `the class-level requirement did not decide each representation: ${JSON.stringify(decided.errors)}`,
          );
          assert.equal(decided.errors[0]!.code, "FORBIDDEN");
          assert.ok(
            decided.errors[0]!.path.includes(1),
            JSON.stringify(decided.errors),
          );
          const own = await options.invokeGraph!(
            app,
            [{ root: "public", fields: ["plain"] }],
            {},
          );
          assert.deepEqual(
            own.errors,
            [],
            `the class's own public query failed: ${JSON.stringify(own.errors)}`,
          );
        },
        federation({
          reference: "bare",
          classDecorators: [
            Require(
              orgPermission(
                { member: ["create"] },
                { organization: fromParam("orgId") },
              ),
            ),
          ],
        }),
      );
    },
    staticMember(options.transport, "defaultAccessFor") === false &&
      !options.invokeEntities
      ? "the transport nests no handlers, so it serves no federation reference resolvers"
      : undefined,
  );
  return cases;
}
