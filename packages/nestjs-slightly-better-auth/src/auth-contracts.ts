import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type {
  ExecutionContext,
  InjectionToken,
  LoggerService,
  ModuleMetadata,
  OptionalFactoryDependency,
  Provider,
  Type,
} from "@nestjs/common";
import type {
  AbstractHttpAdapter,
  DiscoveryService,
  ModuleRef,
  Reflector,
} from "@nestjs/core";
import type {
  AuthFailure,
  BetterAuthConfigurationError,
  BetterAuthInfrastructureError,
  ErrorMappingOptions,
} from "./auth-errors.js";
import type {
  AdminPermissions,
  AuthHookContext,
  AuthLike,
  AuthPrincipal,
  DatabaseHookMethod,
  HasUserId,
  IsRegistered,
  PrincipalKind,
  RegisteredAuth,
  SessionOf,
} from "./auth-types.js";
import type {
  EXTENSION_DEFINITION,
  UPGRADE_REQUEST,
} from "./bridge-protocol.js";

export interface BetterAuthAppOptions {
  /** HTTP platforms. Exactly one must support the running HTTP adapter when the app has one. Default []. */
  platforms?: readonly ExtensionRef<HttpPlatform>[];
  /** Transports, consulted in order BEFORE the built-in httpTransport(). Default []. */
  transports?: readonly ExtensionRef<AuthTransport>[];
}
export type NoAppOptions = {
  readonly platforms?: never;
  readonly transports?: never;
};

/** Instance-shape options: they decide which providers exist, so they are fixed at definition time. [A][B][C] */
export interface BetterAuthStaticOptions {
  /** Instance name. Default 'default'. Named instances get their own tokens and mount (§5.5). */
  name?: string;
  /** Register the module as global. Default true. */
  isGlobal?: boolean;
  /**
   * Register BetterAuthGuard as APP_GUARD (via useExisting). Default true for the default instance, false for named instances.
   * Since v6 this no longer controls APP_INTERCEPTOR: see globalScope.
   */
  globalGuard?: boolean;
  /**
   * Register BetterAuthScopeInterceptor as APP_INTERCEPTOR (via useExisting). Default true for the DEFAULT instance, whatever
   * globalGuard says; named instances never register it (one scope opener per app). The interceptor denies nothing: it opens the
   * scope that carries the cookie sink, refresh suppression and the caller-session check (§7.5, ADR-70). Setting it false is an
   * explicit opt-out, printed in the boot summary and warned about (W_NO_GLOBAL_SCOPE, §5.4 B31). [§17 Q38]
   */
  globalScope?: boolean;
  /** Principal sources of this instance, tried in order BEFORE the built-in session source, filtered per route by the kinds it accepts (§7.6). Default []. */
  principals?: readonly ExtensionRef<PrincipalSource>[];
}

/** Runtime options: read by providers after DI resolution, so they may come from useFactory. */
export type BetterAuthRuntimeOptions<A extends AuthLike = RegisteredAuth> = {
  /** The object returned by betterAuth(). Never wrapped, cloned or mutated. */
  auth: A;
  /** Access for handlers without an access decorator, unless a transport supplies the default (field resolvers inherit, §7.6). Default 'authenticated'. [C] */
  defaultAccess?: "authenticated" | "public";
  /**
   * Requirements every 'required' plan of this instance carries, ahead of its class and method requirements: a company-wide
   * rule such as orgMember(). Compiled into the plan, so boot validation, coverage, the guard and the decorators see one plan.
   * Replaces v2's protected BetterAuthGuard.planFor seam (§7.6). A handler or controller opts out visibly with
   * @SkipDefaultRequirements() (counted in the boot summary), and a plan whose AND-ed requirements admit no common principal kind
   * fails boot (B15 UNSATISFIABLE_PRINCIPAL_KINDS). Default [].
   */
  defaultRequirements?: readonly RequirementExpr[];
  /** HTTP mount options for this instance. */
  http?: HttpMountOptions;
  /** Set-Cookie forwarding for application-level direct auth.api calls (§7.5). */
  cookies?: CookieForwardingOptions;
  /** better-auth's origin rule on cookie-carrying app operations, and its form-CSRF rule on handlers that forward auth cookies (§7.10). */
  originCheck?: OriginCheckOptions;
  /** Per-instance override of transport error objects for this instance's plans, and error logging (§13.5). */
  errors?: ErrorMappingOptions;
  /** Bounds on the authorization work one logical request can cause (§8.1). */
  limits?: AuthorizationLimits;
  /** Log the one-line boot summary. Default true. */
  logSummary?: boolean;
} & SessionOption<A>;

export interface AuthorizationLimits {
  /**
   * Distinct better-auth calls that policies may make through AuthorizationContext.memo for one logical request (memo hits do
   * not count). Past it, a requirement denies 429 TOO_MANY_AUTHORIZATION_CHECKS instead of calling better-auth, so N aliased
   * GraphQL fields with N different organizations cannot exhaust the connection pool. false disables the bound. Default 100.
   */
  maxAuthorizationCallsPerRequest?: number | false;
}

export interface CookieForwardingOptions {
  /**
   * Forward Set-Cookie produced by direct auth.api.* calls that application code makes inside a handler, when the call
   * carries the caller's own credential or none. Default false, which is better-auth's server-call semantics
   * (a server call never touches the browser unless you ask). Per handler: @ForwardAuthCookies(). The library's own calls
   * (principal sources and policies) always forward. Handlers with forwarding on enforce better-auth's form-CSRF origin rule on EVERY
   * method and operation kind, including safe cookie-free GET/query calls (§7.10), so turning this on instance-wide applies it everywhere. v3's per-call-site opt-in is gone: it forwarded
   * without the form check (§7.5).
   */
  forwardDirectCalls?: boolean;
}

export interface OriginCheckOptions {
  /**
   * 'cookie' (default): an unsafe operation whose browser leg carries a cookie must come from a trusted origin, whatever credential
   * authenticated it, exactly as on better-auth's routes (§7.10). 'off': disabled (B19 warns in production).
   */
  mode?: "cookie" | "off";
  /**
   * A cookie-authenticated unsafe operation without Origin or Referer.
   * 'reject' (default): 403 MISSING_OR_NULL_ORIGIN, exactly as better-auth's own routes answer (LEAD-V16).
   * 'allow-non-browser': allowed when Origin, Referer and Sec-Fetch-Site are all absent (no browser sends such a request cross-site).
   * Native clients that send the session cookie themselves (better-auth's Expo client on your own routes, SSR servers) send none of
   * them; under 'reject' they need an Origin header. See §17 Q15.
   */
  missingOrigin?: "reject" | "allow-non-browser";
}

/** `session` is REQUIRED (with userId) when the session shape lacks user.id, i.e. customSession (§11.5). [C] */
export type SessionOption<A extends AuthLike> =
  HasUserId<SessionOf<A>> extends true
    ? { session?: SessionPrincipalOptions<SessionOf<A>> | false }
    : {
        session:
          | (SessionPrincipalOptions<SessionOf<A>> & {
              userId: (s: SessionOf<A>) => string | null;
            })
          | false;
      };

export interface SessionPrincipalOptions<S> {
  /** Map a (possibly customSession-shaped) session to its user id. Default s => s.user?.id ?? null. */
  userId?: (session: S) => string | null;
  /** Default freshness of identity reads; per route: @RequireAuth({ authoritative: true }). Default 'default'. */
  freshness?: "default" | "authoritative";
  /**
   * Does any apiKey() configuration of this instance set enableSessionForAPIKeys? The api-key plugin object does not expose
   * its configuration, so no unit can read it (§8.3.1). Unset (default): when the api-key plugin is present, the session
   * unit's boot advice W_API_KEY_FULL_SESSION / W_API_KEY_SESSION_MULTIPLIER is worded conditionally. false: you assert
   * that none does, and the advice is dropped. true: the advice is worded as a fact.
   */
  apiKeySessions?: boolean;
}

export interface HttpMountOptions {
  /** Mount better-auth routes on the platform. Default true. false = guard-only service. */
  mount?: boolean;
  /** Maximum auth-route request body. Default 1_048_576 (1 MiB). 413 above. */
  bodyLimit?: number | `${number}${"b" | "kb" | "mb"}`;
  /** Wrap every auth-route exchange (ORM request context, tracing). Outermost first. [A][C] */
  around?: readonly AuthHandlerInterceptor[];
  /** Allow a mount path of '/'. Default false (a root mount captures every unmatched route). [A] */
  allowRootMount?: boolean;
  /**
   * Allow an unset baseURL in production (production = NODE_ENV is not development, dev or test, §5.4). better-auth then derives
   * the base URL, token links and a trusted origin from each request's Host header. Default false: boot fails with UNSAFE_BASE_URL
   * (B23).
   */
  allowRequestDerivedBaseURL?: boolean;
  /** Log each auth path better-auth answers 404 for once, with a "did you mean" (capped at 100 paths). Default: true outside production. */
  diagnostics?: boolean;
}

export type AuthHandlerInterceptor = (
  call: {
    readonly request: Request;
    readonly platformRequest: unknown;
    readonly instance: string;
  },
  next: (request?: Request) => Promise<Response>,
) => Promise<Response>;

export type BetterAuthModuleOptions<A extends AuthLike> =
  BetterAuthStaticOptions & BetterAuthRuntimeOptions<A>;

export interface BetterAuthModuleAsyncOptions<A extends AuthLike>
  extends BetterAuthStaticOptions {
  imports?: ModuleMetadata["imports"];
  inject?: readonly (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (
    ...args: any[]
  ) => BetterAuthFactoryResult<A> | Promise<BetterAuthFactoryResult<A>>;
}

/** A static or app-level key returned from useFactory is a compile error with a readable message (EXP-C9). [C] */
export type BetterAuthFactoryResult<A extends AuthLike> =
  BetterAuthRuntimeOptions<A> & {
    [K in keyof (BetterAuthStaticOptions &
      BetterAuthAppOptions)]?: StaticOptionMustBePassedToForRootAsync<K>;
  };
export interface StaticOptionMustBePassedToForRootAsync<K extends string> {
  readonly __error: `'${K}' is a static option: pass it to forRootAsync() next to useFactory, not in its result`;
}
/** Rejects a different instance than the registered one for the default instance (EXP-C2). [C] */
export type DefaultInstanceCheck<A> = IsRegistered extends true
  ? A extends RegisteredAuth
    ? unknown
    : { auth: RegisteredAuth }
  : unknown;

// ── Extension registration (§4) [A][B] ────────────────────────────────────
/** A class (DI-constructed), a ready instance, or a definition that brings its own providers. */
export type ExtensionRef<T> = Type<T> | T | ExtensionDefinition<T>;
export interface ExtensionDefinition<T> {
  readonly [EXTENSION_DEFINITION]: true; // Symbol.for brand, set by defineExtension
  readonly use:
    | { readonly useClass: Type<T> }
    | {
        readonly useFactory: (...deps: any[]) => T | Promise<T>;
        readonly inject?: readonly InjectionToken[];
      }
    | { readonly useExisting: InjectionToken<T> };
  readonly providers?: readonly Provider[]; // e.g. the extension's own options provider
  readonly imports?: ModuleMetadata["imports"];
  /** Tokens (from `providers`) the forRoot module re-exports, globally when isGlobal: helper services for users. */
  readonly exports?: readonly InjectionToken[];
}

export interface RoutePlan {
  readonly instance: string;
  /**
   * 'inherit': a handler a transport declares as reached only through an already authorized operation (GraphQL field resolvers
   * without method-level access, acceptance or requirement metadata; class-level metadata never applies to them, §7.6 step 3). The
   * guard performs no principal I/O: it checks the enclosing reading and also enforces form mode when forwarding is declared; readers take the nearest
   * enclosing invocation's reading (§7.8).
   */
  readonly access: "public" | "optional" | "required" | "inherit";
  /** A transport's defaultAccessFor answered 'inherit' for the handler (a nested handler, §7.6 step 3), whatever its effective access. */
  readonly nested: boolean;
  /**
   * defaultRequirements first (unless @SkipDefaultRequirements() applies), then class requirements (base first; not for handlers a
   * transport nests), then method requirements; empty unless access is 'required'.
   */
  readonly requirements: readonly RequirementExpr[];
  /** @SkipDefaultRequirements() removed the instance's defaultRequirements from this plan (counted in the boot summary, B22). */
  readonly skipsDefaultRequirements: boolean;
  /**
   * The handler declares something in B16's sense (§5.4), computed with the same scoping as the plan: method-level metadata, class-level
   * metadata unless a transport nests the handler, and direct-call forwarding (@ForwardAuthCookies() or cookies.forwardDirectCalls).
   * The other instance-wide defaults (defaultAccess, the default kinds, defaultRequirements) never count.
   */
  readonly declares: boolean;
  /** 'authoritative' when the route asks for it, session.freshness says so, or a requirement demands fresh identity. */
  readonly freshness: "default" | "authoritative";
  /** Principal kinds admitted on the route (§7.6): @AcceptPrincipals or the instance's default kinds, plus kinds requirements name. */
  readonly accepts: ReadonlySet<string>;
  /** Kind constraints contributed by param decorators (e.g. @CurrentSession() → { kind: 'session', reason: 'SESSION_REQUIRED' }); checked at boot (B15). */
  readonly principalParams: readonly {
    readonly kind: string;
    readonly reason: string;
  }[];
  /**
   * The origin check (§7.10). 'cookie': better-auth's rule when the browser leg carries a cookie. 'form': better-auth's
   * form-CSRF rule, enforcing on every method/operation even without an inbound cookie (handlers declaring cookie forwarding).
   * 'off': @SkipOriginCheck() or originCheck.mode 'off'.
   */
  readonly originCheck: "cookie" | "form" | "off";
  /** Content key of the sources this plan consults (ordered source indexes, interned per instance); part of the principal memo key (§7.2). */
  readonly sourceSet: string;
  /** Set-Cookie of application direct calls is forwarded (§7.5). */
  readonly forwardDirectCalls: boolean;
  readonly site: string; // 'ProjectsController.remove'
  // v3's routeParams is gone: the named inputs of a handler (route params, GraphQL @Args names) come from the transports' claims
  // (ClaimOptions.inputs), so core reads no transport metadata for them (§4.2.1, BootAdviceContext.handlers).
}

export type PrincipalReading = (
  | PrincipalResult
  | { readonly outcome: "no-identity" }
) & { readonly instance: string };

/**
 * The resolver port the guard uses. Default: ChainPrincipalResolver. Readers never call it: they read the results the guard
 * recorded (§7.8), so v3's peek() is gone. [B]
 */
export interface PrincipalResolver {
  resolve(
    call: TransportCall,
    request: ResolutionRequest,
  ): Promise<PrincipalResult>;
}
export interface ResolutionRequest {
  readonly auth: AuthHandle;
  readonly freshness: "default" | "authoritative";
  /** Kinds the route accepts; sources producing none of them are not consulted (§7.6). */
  readonly accepts: ReadonlySet<string>;
  /** The plan's content key of those sources (RoutePlan.sourceSet). */
  readonly sourceSet: string;
  /**
   * The re-classification read of a generic 401 a policy call met (§8.1): resolve again through the one source that produced the
   * principal (its id), which must declare sessionBacked, bypassing the principal memo. The evaluator shares one such read per logical
   * request (§7.2).
   */
  readonly reclassify?: { readonly sourceId: string };
}

/** The port the evaluator calls a policy through. Default: policy.evaluate(params, context). Tests substitute it (overrideDecisions, §14.8). */
export interface PolicyInvoker {
  invoke<P>(
    policy: AuthorizationPolicy<P, any>,
    params: P,
    context: AuthorizationContext,
  ): Promise<AuthorizationDecision>;
}

export interface RequirementOptions {
  readonly label?: string;
  /** Overrides policy.requires.principals for this requirement. */
  readonly principals?: readonly PrincipalKind[];
  /** Overrides policy.requires.freshIdentity for this requirement. */
  readonly freshIdentity?: boolean;
}

export interface HookOptions {
  /** 'http' = requests routed by auth.handler; 'server' = direct auth.api calls. Default 'all'. */
  calls?: "all" | "http" | "server";
  /** Skip calls this library makes (guard getSession, policy checks). Default false (better-auth semantics). */
  skipInternal?: boolean;
  /** Ascending order among Nest hooks; ties keep discovery order. Default 0. */
  order?: number;
  /** Named instance the hook binds to. Default 'default'. */
  instance?: string;
}
export interface DbHookOptions {
  order?: number;
  instance?: string;
}
export type HookPredicate = (ctx: AuthHookContext) => boolean;
/**
 * The decorated method type M is inferred and constrained rather than fixed: TypedPropertyDescriptor is invariant, so a fixed
 * descriptor type would reject sound methods that declare fewer parameters or return a narrower result.
 */
export type HookMethodDecorator<P extends string> = <
  M extends (ctx: AuthHookContext<P>) => unknown,
>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;
/** Constrains the decorated method like HookMethodDecorator; the SDK's payload, context and result types still apply. */
export type DbHookMethodDecorator<
  E extends DatabaseHookTarget,
  Ph extends "before" | "after",
> = <M extends DatabaseHookMethod<E, Ph>>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<M>,
) => void;
export type DatabaseHookTarget =
  `${"user" | "session" | "account" | "verification"}.${"create" | "update" | "delete"}`;

export interface CorsOriginOptions {
  /** Also honor wildcard (`https://*.vercel.app`) and custom-scheme trusted origins for credentialed CORS. Default false: exact origins only. */
  allowPatterns?: boolean;
}

export interface NestjsPluginOptions {
  /**
   * Header better-auth reads the client IP from, contributed to advanced.ipAddress.ipAddressHeaders as a default
   * (user values win and come first). Default: a random name per plugin instance (per nestjs() call), `x-nsba-ip-<32 hex chars>`, generated with
   * globalThis.crypto.randomUUID(); it never leaves the process and clients cannot guess it. A string pins a fixed name
   * (for a trusted sidecar that calls auth.handler itself); false contributes nothing (configure advanced.ipAddress yourself).
   */
  clientIpHeader?: string | false;
}

export interface ExpressPlatformOptions {
  /** Client IP for better-auth's rate limiter. Default req.ip (honors Express `trust proxy`). */
  clientIp?: (req: IncomingMessage & { ip?: string }) => string | null;
}

export interface FastifyPlatformOptions {
  /** Default request.ip (honors Fastify `trustProxy`). */
  clientIp?: (request: { ip?: string; raw: IncomingMessage }) => string | null;
}

export interface GraphqlTransportOptions {
  /** connectionParams keys copied into the credentials of operations over a WebSocket (case-insensitive). Default ['authorization', 'cookie']. [A]
   *  A copied key REPLACES the same-named upgrade header in the credentials. The browser leg of the origin check stays the upgrade
   *  request's own headers, so connectionParams can never switch the check off (§7.10). */
  connectionParamHeaders?: readonly string[];
  /**
   * Full override of credential extraction for operations over a WebSocket. The upgrade request's `host`, `x-forwarded-host` and
   * `x-forwarded-proto` are copied into the result unless it sets them: they describe the leg, not a credential, and better-auth needs
   * them to resolve a dynamic base URL (§9.2). [B][C]
   */
  subscriptionCredentials?: (
    connectionContext: unknown,
  ) => HeadersInit | undefined;
  /** Reuse a WebSocket connection's principal for this long (subscriptions, and queries and mutations sent over the socket). Default 0 (resolve per operation). Plans with authoritative freshness never reuse it (§7.2). */
  subscriptionPrincipalTtlMs?: number;
  /** Coverage of @ResolveField handlers that carry method-level access, acceptance or requirement metadata while fieldResolverEnhancers lacks 'guards' (§9.2). Default 'error'. */
  fieldResolverCoverage?: "error" | "warn" | "off";
  /**
   * Federation entry points (§9.2): @ResolveReference() handlers that no guard reaches (REFERENCE_RESOLVER_UNGUARDED), and a federation
   * subgraph with field or reference resolvers whose fieldResolverEnhancers lacks 'guards' (FEDERATION_FIELD_GUARDS_REQUIRED). 'warn' suits
   * a subgraph that only an authenticating router can reach. Default 'error'.
   * Requiring 'guards' attaches EVERY application global guard and interceptor to every field-resolver invocation and disables the fast
   * field-resolver path app-wide; boot names the affected enhancers (W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS, §9.2).
   */
  federationCoverage?: "error" | "warn" | "off";
}

export interface WsTransportOptions<C> {
  /**
   * Map socket credentials to headers, e.g. handshake.auth.token → authorization: Bearer …. The mapping feeds the principal sources
   * only; the origin check always reads the handshake's own headers (§7.10).
   */
  credentials?: (client: C) => HeadersInit | undefined;
  /** Reuse a connection's principal for this long. Default 0 = resolve per message (secure default). Authoritative plans never reuse it (§7.2). */
  principalTtlMs?: number;
  /** Coverage severity of gateway handlers: every gateway needs @UseBetterAuth() or @Public(), on every Nest major (§5.4 B16, §9.3). Default 'error'. */
  gatewayCoverage?: "error" | "warn" | "off";
}

export interface SocketIoClientLike {
  readonly handshake: {
    readonly headers: IncomingHttpHeaders;
    readonly auth?: Record<string, unknown>;
    readonly address?: string;
    readonly url?: string;
    readonly secure?: boolean;
  };
}

export interface WsClientLike {
  readonly [UPGRADE_REQUEST]?: {
    readonly headers: Headers;
    readonly url?: string;
    readonly remoteAddress?: string;
    readonly encrypted?: boolean;
  };
}

export interface WsAdapterLike {
  bindClientConnect(
    server: unknown,
    callback: (...args: any[]) => void,
  ): unknown;
}

export interface RpcCredentialCarrier {
  readonly id: string;
  matches(context: ExecutionContext): boolean;
  headers(context: ExecutionContext): HeadersInit | undefined;
  /** Optional transport-specific error (e.g. gRPC numeric status). */
  toException?(failure: AuthFailure, context: ExecutionContext): unknown;
}

export interface RpcTransportOptions {
  carriers?: readonly RpcCredentialCarrier[];
  /**
   * Coverage severity in hybrid apps (an HTTP adapter plus connectMicroservice): message and event handlers must carry
   * @UseBetterAuth() or @Public() unless `inheritAppConfig` is asserted (§5.4 B16, §9.4). Default 'error'.
   */
  hybridCoverage?: "error" | "warn" | "off";
  /** Assert that every connectMicroservice() call passes { inheritAppConfig: true }, so the global guard reaches message handlers. */
  inheritAppConfig?: boolean;
}

export interface PermissionOptions {
  /**
   * Principal kinds this requirement admits. Default ['session']. A delegated kind (e.g. 'api-key') is allowed only if the owner is
   * not banned (an active ban denies 401 USER_BANNED), the owner's stored role allows the permissions, AND the credential's own grant
   * (principal.delegation) allows them (Z5).
   */
  principals?: readonly PrincipalKind[];
}

export interface AdminPermissionParams {
  readonly permissions: AdminPermissions;
}

export interface OrganizationRef {
  (ctx: AuthorizationContext): unknown | Promise<unknown>;
  /** Denial reason when the ref determines no organization. Default 'ORGANIZATION_REQUIRED'. */
  readonly missingReason?: string;
}

export interface ApiKeyPrincipal extends AuthPrincipalBase {
  readonly kind: "api-key";
  readonly keyId: string;
  readonly configId: string | null;
  readonly referenceId: string;
  /** The owning user when the key references a user; null for organization-owned keys. */
  readonly userId: string | null;
  /** The owning organization when the key references an organization; else null. */
  readonly organizationId: string | null;
  readonly permissions: Readonly<Record<string, readonly string[]>> | null;
  /** The key's own grant: role(permissions).authorize(p) (better-auth/plugins/access). A key without permissions allows nothing. */
  readonly delegation: PrincipalDelegation;
}

export interface ApiKeyPrincipalOptions {
  /** Header carrying the key. Default 'x-api-key' (declared as the source's credentialHeaders). */
  header?: string;
  /** api-key configuration id to verify against. */
  configId?: string;
  /** What referenceId points at. Default 'user' (the plugin's default). A function decides per key configuration. */
  references?:
    | "user"
    | "organization"
    | ((key: { readonly configId: string | null }) => "user" | "organization");
  /**
   * verifyApiKey reports a storage failure as INVALID_API_KEY (LEAD-V20), including a store that reads but cannot write, because
   * every verification writes. On that result the source classifies (§8.3.1):
   *   - slow: the call took longer than slowMs (a lock or statement timeout on the key's own row; a miss takes about a millisecond) → 5xx.
   *     Set slowMs below the smallest lock_timeout or statement_timeout of the pool: a timeout shorter than slowMs makes the row-level
   *     failure fast, and the probe below then sees a healthy store (401);
   *   - otherwise probe storage with one read and one no-op write keyed on the `key` column with a random UUID (type-safe under every
   *     generateId mode), at most once per second per instance; a failure of either → 5xx.
   * true = { slowMs: 500 }; false disables both; slowMs: false keeps only the probe. Default true.
   */
  outageProbe?: boolean | { readonly slowMs?: number | false };
  /** 'explicit' (default): only routes that name 'api-key' (@AcceptPrincipals or a requirement) admit keys. */
  acceptance?: "default" | "explicit";
}

export interface ConformanceCase {
  readonly id: string;
  readonly title: string;
  /** Why the case does not apply, when that is known before it runs. */
  readonly skip?: string;
  /**
   * Runs the case. It resolves with a ConformanceSkip when the case finds at run time that it does not apply, for
   * example because a unit registered through defineExtension() lacks an optional capability.
   */
  run(): Promise<ConformanceOutcome>;
}

/** A case that found at run time that it does not apply. */
export interface ConformanceSkip {
  readonly skipped: string;
}

/** What a case's run() resolves with: nothing when it passed, a ConformanceSkip when it does not apply. */
// biome-ignore lint/suspicious/noConfusingVoidType: cases written as `async () => {}` resolve to void.
export type ConformanceOutcome = void | ConformanceSkip;

export interface ConformanceRunner {
  describe(name: string, fn: () => void): void;
  /**
   * Registers a test. runConformance passes a function without declared parameters; when the runner hands it a test
   * context with skip(note) (Vitest, node:test), a case that skips at run time is reported as skipped.
   */
  it(name: string, fn: (context?: unknown) => Promise<void>): void;
}

export interface BootAdvice {
  readonly level: "warn" | "info";
  /** Stable code, e.g. 'W_API_KEY_SESSION_MULTIPLIER'. */
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}
export interface BootAdviceContext {
  readonly instance: string;
  readonly auth: AuthHandle;
  /** Awaited $context (post-init options, plugins, sessionConfig, authCookies). */
  readonly context: AuthContextView;
  /** true unless NODE_ENV is 'development', 'dev' or 'test' (an unset NODE_ENV counts as production, §5.4). */
  readonly production: boolean;
  readonly hasHttpAdapter: boolean;
  /** The instance's effective origin-check options (the session unit's W_ORIGIN_CHECK_NATIVE_CLIENTS reads missingOrigin). */
  readonly originCheck: {
    readonly mode: "cookie" | "off";
    readonly missingOrigin: "reject" | "allow-non-browser";
  };
  /** Every compiled handler of this instance (controllers, resolvers, gateways, message handlers) with what transports claimed for it. */
  readonly handlers: readonly AdvisedHandler[];
  readonly transports: readonly {
    readonly id: string;
    readonly connectionTtlMs?: number;
  }[];
  readonly sources: readonly Pick<
    PrincipalSource,
    "id" | "kinds" | "acceptance" | "effects"
  >[];
  /** Policies referenced by any plan (resolved instances, §4.4.3), with their declared requirements. */
  readonly policies: readonly Pick<AuthorizationPolicy, "id" | "requires">[];
}
export interface AdvisedHandler {
  readonly plan: RoutePlan;
  /** Ids of the transports that claimed the handler; empty when none did. */
  readonly transports: readonly string[];
  /** Named inputs the claiming transports reported (ClaimOptions.inputs): HTTP route params, GraphQL @Args names. Empty when unknown. */
  readonly inputs: readonly string[];
}

export interface HttpPlatform {
  /** Diagnostic id ('express', 'fastify', 'hono'…). Core prints it and never compares it. */
  readonly id: string;
  /**
   * Capabilities. http2: the conformance kit exercises HTTP/2. prepareAtInit: prepare() may also run from the core module's
   * onModuleInit, because nothing it installs has to precede Nest's init(); core then prepares a second application's adapter on the
   * same container instead of failing with APP_ADAPTER_CHANGED (§5.7).
   */
  readonly capabilities?: {
    readonly http2?: boolean;
    readonly prepareAtInit?: boolean;
  };
  /** Does this platform drive the running Nest HTTP adapter? Adapter-owned predicate. Never called with a null adapter. */
  supports(adapter: AbstractHttpAdapter): boolean;
  /**
   * Phase 1, optional, synchronous. Called once, as soon as BOTH the running adapter (HttpAdapterHost.init$) and the app's
   * platform list are known, whichever arrives last (§5.7, LEAD-EXP-3):
   *   NestFactory     → inside NestFactory.create(), before it resolves: before main.ts code and before init() registers parsers;
   *   @nestjs/testing → inside createNestApplication(), before it returns.
   * Use it only for work that must precede body parsing (Express raw capture) or per-request bookkeeping
   * (Fastify request→reply map). Mount paths are not resolved yet: call ctx.route(pathname) per request.
   */
  prepare?(ctx: PlatformPrepareContext): void;
  /**
   * Phase 2, required. Called once per auth instance from onModuleInit, after parsers, main.ts middleware/CORS,
   * MiddlewareConsumer middleware and controller routes are registered, and before Nest's 404/error handlers.
   * Route every method for binding.basePath and binding.basePath/* to binding.handle(). May be async. Failures of
   * handle() must reach the host's error pipeline at REQUEST time (H8), even if routes are registered eagerly.
   */
  mount(ctx: PlatformMountContext): void | Promise<void>;
  /** Per-request access for transports running on this platform (HTTP controllers, GraphQL over HTTP). */
  readonly requests: HttpRequestAccessor;
  /** How the platform resolves the client IP behind proxies (boot summary, W_PROXY_* warnings; §6.8). */
  proxyTrust?(adapter: AbstractHttpAdapter): ProxyTrust;
  /** Optional boot-time checks (throw BetterAuthConfigurationError to fail fast). */
  validate?(adapter: AbstractHttpAdapter): void;
  /**
   * Native controller routes and resolved auth bindings. Called after Nest has registered routes and auth mounts are resolved,
   * before the application starts accepting requests. Platforms own route-grammar matching for controller precedence.
   */
  applicationRoutes?(
    routes: readonly ApplicationRouteDescriptor[],
    bindings: readonly AuthRouteBinding[],
  ): void;
  /** Optional boot advice (§4). */
  advise?(
    ctx: BootAdviceContext,
  ): readonly BootAdvice[] | Promise<readonly BootAdvice[]>;
}

export interface ApplicationRouteDescriptor {
  /** Nest RequestMethod name (GET, POST, ALL, ...). */
  readonly method: string;
  /** Paths resolved by Nest's RoutePathFactory, including module/global prefixes and URI versions. */
  readonly paths: readonly string[];
  /** Conditions evaluated inside the selected controller route after Express body parsing. */
  readonly conditions: readonly ("host" | "version")[];
  /** Controller and method name for boot diagnostics. */
  readonly source: string;
}

export interface ProxyTrust {
  /**
   * 'none': the socket address is the client IP (behind a proxy, every client shares the proxy's IP);
   * 'all': every forwarded hop is trusted (clients can choose their IP); 'partial': hop count, subnet list or function;
   * 'unknown': the platform cannot tell.
   */
  readonly mode: "none" | "all" | "partial" | "unknown";
  readonly detail: string; // e.g. "trust proxy = 1"
}

export interface PlatformPrepareContext {
  readonly adapter: AbstractHttpAdapter;
  readonly logger: LoggerService;
  /** The binding whose base path matches this raw (undecoded, query-less) pathname; undefined before mount or if none. */
  route(pathname: string): AuthRouteBinding | undefined;
}

export interface PlatformMountContext {
  readonly adapter: AbstractHttpAdapter;
  readonly logger: LoggerService;
  readonly binding: AuthRouteBinding;
}

export interface AuthRouteBinding {
  readonly instance: string;
  /** Normalized mount path: no trailing slash; never '/' unless allowRootMount. */
  readonly basePath: string;
  readonly bodyLimit: number;
  /** Static baseURL origin (e.g. 'https://api.example.com'), or undefined for unset/dynamic baseURL. */
  readonly staticOrigin: string | undefined;
  /** pathname === basePath || pathname.startsWith(basePath + '/'), on the raw pathname. */
  matches(pathname: string): boolean;
  /**
   * Core exchange (§6.3). Resolves a Response for every better-auth outcome; rejects with BetterAuthInfrastructureError,
   * or with the original APIError when the instance sets onAPIError.throw (§6.10).
   */
  handle(inbound: InboundAuthRequest): Promise<Response>;
  /** Canonical 413: better-auth's error shape { code: 'PAYLOAD_TOO_LARGE', message }. */
  payloadTooLarge(): Response;
}

export interface InboundAuthRequest {
  readonly method: string;
  /** Absolute URL: platform trust-proxy-aware origin + the ORIGINAL path and query (never a rewritten req.url). */
  readonly url: string;
  /** Original headers as Web Headers (toWebHeaders drops pseudo-headers); never rewritten by the platform. */
  readonly headers: Headers;
  /** Exact bytes (<= bodyLimit), or a stream core buffers up to bodyLimit, or null when there is no body. */
  readonly body: Uint8Array | ReadableStream<Uint8Array> | null;
  /** Client IP from the platform's own trust-proxy resolution; never read from a raw header by core. */
  readonly clientIp: string | null;
  /** Opaque; passed to AuthHandlerInterceptor. */
  readonly platformRequest: unknown;
  /** Aborted on client disconnect. */
  readonly signal?: AbortSignal;
}

export interface HttpRequestAccessor {
  /**
   * Is `value` this platform's request object, as frameworks layered on HTTP hand it on (Express: an IncomingMessage carrying `res`;
   * Fastify: a request whose `raw` is an IncomingMessage)? A WebSocket upgrade request, or an object a user's GraphQL context built,
   * is not. GraphQL transports take the HTTP branch only on a positive answer (§9.2).
   */
  isRequest(value: unknown): boolean;
  /**
   * REQUIRED since v6: is the response to this request still unsent (Express: !req.res.writableEnded; Fastify: the reply of request.raw
   * is not sent; a Web-native platform: !c.finalized)? GraphQL transports refuse a context whose request already finished, which a context
   * object or a caching context function shared across requests carries (§9.2). It was optional in v5, so a third-party platform silently
   * lost the runtime half of that defense with no boot or runtime signal — including this document's own Hono sketch, which omitted it.
   * It is a security defense, not a convenience, and two lines on every platform.
   */
  isLive(req: unknown): boolean;
  /** Stable identity of one request for guards, pipes, interceptors and GraphQL (Fastify: request.raw). */
  key(req: unknown): object;
  /** Request headers as Web Headers (pseudo-headers dropped). */
  headers(req: unknown): Headers;
  /** Method and absolute URL (trust-proxy-aware origin, original path). DPoP-bound tokens and the origin check need both. */
  request(req: unknown): { readonly method: string; readonly url: string };
  /** Trust-proxy-aware client IP, or null. */
  clientIp(req: unknown): string | null;
  /** Route param. */
  param(req: unknown, name: string): string | undefined;
  /** Sink writing Set-Cookie onto the native response; null if unreachable. */
  cookieSink(req: unknown, res: unknown): CookieSink | null;
  /** Locate the native response for a request when a framework dropped it (Apollo on Fastify, LEAD-V8). */
  responseFor?(req: unknown): unknown | undefined;
}

export interface CookieSink {
  /** Append each value as its own Set-Cookie header. Returns false (and writes nothing) if headers were already sent. */
  append(setCookies: readonly string[]): boolean;
}

export interface AuthTransport {
  /** Diagnostics only. */
  readonly id: string;
  /**
   * Adapter-owned, side-effect free predicate (e.g. ctx.getType() === 'graphql' plus shape probes). It must not depend on the
   * presence of credentials: a context without credentials is still this transport's (T1).
   */
  handles(context: ExecutionContext): boolean;
  /**
   * Build a synchronous, side-effect-free envelope whenever handles() accepted the context; never throw merely because credentials,
   * an upgrade request or a live platform request cannot be extracted. key/invocation/lineage are structural. Deferred request-dependent
   * getters (headers, browser, cookies, request, clientIp) throw the original configuration error only when consumed.
   */
  describe(context: ExecutionContext, kit: TransportKit): TransportCall;
  /** Turn a denial into what this transport's runtime delivers correctly (thrown by the guard). */
  toException(failure: AuthFailure, context: ExecutionContext): unknown;
  /**
   * Optional: what to throw for a request-time infrastructure or configuration error. Default: the error itself (HTTP, WS
   * and RPC runtimes already answer a generic 500 / "Internal server error"). GraphQL returns a generic error with
   * extensions, because drivers expose error messages to clients. `repeated` is true when an earlier invocation of the same logical
   * request already surfaced this error: return something the runtime delivers identically but does not log (an IntrinsicException),
   * so one outage costs one ERROR line per request, not one per aliased field (§13.4).
   */
  toInternalException?(
    error: BetterAuthInfrastructureError | BetterAuthConfigurationError,
    context: ExecutionContext,
    info: { readonly repeated: boolean },
  ): unknown;
  /**
   * Optional boot step: claim every handler this transport serves, with how BetterAuthGuard reaches it (ctx.claim). Core applies
   * one coverage rule to the claims (§5.4 B16). A transport may also throw BetterAuthConfigurationError for its own prerequisites.
   */
  validate?(ctx: TransportValidationContext): void | Promise<void>;
  /**
   * Optional: 'inherit' marks a NESTED handler, one that runs only inside an operation this transport already authorized (GraphQL field
   * resolvers). For a nested handler the planner ignores class-level access, acceptance and requirement metadata; method-level metadata
   * gives it a real plan, and without any it inherits (§7.6 step 3). An entry point of an operation (a GraphQL root field, a federation
   * reference resolver) is never nested. The planner asks every registered transport; the first answer wins.
   *
   */
  // biome-ignore lint/complexity/noBannedTypes: Nest metadata accepts class and function targets.
  defaultAccessFor?(target: Function, method: string): "inherit" | undefined;
  /**
   * Optional, synchronous, side-effect free: the lineage of this invocation (TransportCall.lineage) without building the whole call.
   * The guard asks for it on public plans, which select no transport otherwise, to record "no identity" for the invocations nested in
   * a public operation, and on inherit plans, to check that an enclosing invocation recorded a reading (§7.1, §7.8). Transports without
   * nesting omit it.
   */
  lineage?(context: ExecutionContext): InvocationLineage | undefined;
  /** better-auth prerequisites. hostlessCalls: this transport's calls carry no Host header (RPC), so a dynamic baseURL needs a fallback (B20). */
  readonly requires?: { readonly hostlessCalls?: boolean };
  /** Optional boot advice (§4). */
  advise?(
    ctx: BootAdviceContext,
  ): readonly BootAdvice[] | Promise<readonly BootAdvice[]>;
}

export interface TransportCall {
  /**
   * Identity of ONE logical request: the HTTP request (GraphQL queries and mutations over HTTP share it), a GraphQL operation carried by a WebSocket,
   * a WS message, an RPC message. Scope of the principal memo and of policies' I/O memo.
   */
  readonly key: object;
  /**
   * Identity of ONE handler invocation, chosen by the transport: the finest object that is distinct for each invocation of the
   * handler, including invocations the transport reaches in parallel from one entry point, for which an operation-level object
   * would be shared. Built-in choices: HTTP = the request; GraphQL = the field's `info` object (distinct per root field, alias
   * and batched operation), except where one `info` serves several parallel invocations, where it is the per-invocation input
   * the transport passes instead (the GraphQL units use the representation, gql.getRoot(), for federation reference resolvers,
   * §9.2, T7); WS = the per-message args array; RPC = the message context. Scope of authorization decisions and per-invocation
   * values. Never a connection.
   */
  readonly invocation: object;
  /** Connection identity for principal reuse (WS socket, subscription connection); used only when principalTtlMs > 0. */
  readonly connection?: object;
  /** Reuse an authenticated/absent principal on `connection` for this long, for plans whose freshness is not 'authoritative' (§7.2). Default 0. */
  readonly principalTtlMs?: number;
  /**
   * Where this invocation sits inside an enclosing operation (GraphQL fields), so that readers of a nested invocation take the reading of
   * the nearest enclosing invocation whose guard decided (§7.8). Replaces v3's carrier, whose map by memo key let a field read a
   * sibling root field's principal. Absent for transports whose invocations do not nest (HTTP, WS, RPC).
   */
  readonly lineage?: InvocationLineage;
  /**
   * Credentials as Web Headers, plus the leg's `host`, `x-forwarded-host` and `x-forwarded-proto` when the transport has a request or an
   * upgrade request (better-auth resolves a dynamic base URL from them, even where a user mapping replaced the credentials). Core then
   * strips any inbound client-IP header and sets it from clientIp. Throws a request-time configuration error when extraction is unavailable; public scope creation never calls it.
   */
  headers(): Headers;
  /** Trust-proxy-aware client IP when the transport knows it (HTTP); null otherwise. */
  readonly clientIp: string | null;
  /** null = this transport cannot deliver Set-Cookie: core suppresses session refresh (§7.4). */
  readonly cookies: CookieSink | null;
  /** Method and URL when the transport has them (DPoP-bound tokens need both). */
  readonly request?: { readonly method: string; readonly url: string };
  /** Named input for policies: route param, GraphQL arg, WS/RPC payload field. */
  param(name: string): unknown;
  /** The browser leg of this operation, for the origin check (§7.10). Absent when no browser can reach it (RPC). */
  readonly browser?: BrowserExposure;
}

export interface BrowserExposure {
  /**
   * Cookie-mode enforcement classification only (form mode always enforces, regardless of this value). The operation is unsafe: HTTP methods other than GET/HEAD/OPTIONS, GraphQL mutations over HTTP, and EVERY
   * operation carried by a WebSocket (messages; GraphQL subscriptions, queries and mutations over graphql-ws), because a cross-site
   * socket can read replies.
   */
  readonly enforce: boolean;
  /**
   * The headers the browser itself sent on this leg: the request, or the WebSocket upgrade / handshake request. Never values a
   * transport copied from handshake.auth, connectionParams, _connectionInit, payloads or query strings.
   */
  headers(): Headers;
  /** Absolute URL of the leg (scheme://host/path; WebSocket transports use upgradeRequestUrl). */
  readonly url: string;
  /** Identity of the leg (the HTTP request, the socket, the upgrade request): the origin verdict is computed once per leg. */
  readonly key: object;
}

/** Where an invocation sits inside an operation, for readers of nested invocations (§7.8). */
export interface InvocationLineage {
  /** One of ctx.getArgs(), shared by every invocation of the operation (the GraphQL context). Readings are recorded on it under a Symbol.for slot. */
  readonly carrier: object;
  /**
   * This invocation's position, a string the transport derives from the invocation's own args. GraphQL: an id of `info.operation`
   * (batched operations can share a context) plus the serialized response path of `info.path`, list indexes included, e.g.
   * `'1:reports.0.owner'`. Aliases give distinct paths. Federation reference resolvers, whose representations share the `_entities`
   * field's `info`, take `'<op>:_entities#<__typename>'`: invocations of one handler plan in one request, whose readings are identical
   * (§9.2).
   */
  readonly position: string;
  /**
   * Positions of the invocations that enclose the invocation whose args are given, nearest first (GraphQL: walking `info.path.prev`).
   * It is a function of the args alone, so the guard can record it on the carrier and param factories, which have no DI access, can
   * walk the lineage too. Every enclosing invocation completes its guard run before a nested one starts: GraphQL resolves a field
   * before it executes the field's selections.
   */
  readonly enclosing: (args: readonly unknown[]) => Iterable<string>;
  /**
   * Optional transport-owned validation before exposing an authenticated reading from this lineage. Structural lineage() never
   * runs it. GraphQL units provide the current invocation's request-liveness check; readers without DI obtain the callback from
   * the recorded carrier metadata, supplying their own args (never a closure over a sibling/finished request).
   */
  readonly assertReadable?: (args: readonly unknown[]) => void;
}

export interface TransportKit {
  /** Accessor of the running app's HTTP platform (for transports layered on HTTP, e.g. GraphQL); null without one. */
  readonly http: HttpRequestAccessor | null;
}

export interface TransportValidationContext {
  readonly discovery: DiscoveryService;
  readonly reflector: Reflector;
  readonly moduleRef: ModuleRef;
  readonly hasHttpAdapter: boolean; // false for createMicroservice / createApplicationContext
  /** Compiled plan of a handler (class + method). */
  // biome-ignore lint/complexity/noBannedTypes: Nest metadata accepts class and function targets.
  readonly planOf: (target: Function, method: string) => RoutePlan;
  /**
   * Declare a handler this transport serves and how BetterAuthGuard reaches it. `method` undefined claims a class whose handlers the
   * transport could not enumerate (a class-level decorator is then required). Core decides coverage (§5.4 B16).
   */
  claim(
    // biome-ignore lint/complexity/noBannedTypes: Nest metadata accepts class and function targets.
    target: Function,
    method: string | undefined,
    reach: GuardReach,
    options: ClaimOptions,
  ): void;
  readonly logger: LoggerService;
}
/**
 * 'global': the app's global guards reach the handler: covered when they include BetterAuthGuard, however registered or overridden.
 * BetterAuthScopeInterceptor is not part of global coverage; absence is B31's warning, including globalScope: false. (§5.4 B16)
 *
 * 'explicit': @UseBetterAuth(), or BOTH @UseGuards(BetterAuthGuard) and @UseInterceptors(BetterAuthScopeInterceptor), must apply locally.
 * 'none': no guard ever runs for it (GraphQL field resolvers without fieldResolverEnhancers: ['guards']).
 */
export type GuardReach = "global" | "explicit" | "none";
export interface ClaimOptions {
  /** Stable code of the coverage report, e.g. 'GATEWAY_UNGUARDED'. */
  readonly code: string;
  /** Copy-paste fix, e.g. 'Add @UseBetterAuth() (or @Public() to opt out); global guards do not reach gateways on NestJS 11.' */
  readonly hint: string;
  /** Severity when the handler is not covered. Default 'error'. */
  readonly coverage?: "error" | "warn" | "off";
  /** true: every handler needs coverage, even one without library metadata (gateways, hybrid message handlers). false: only handlers that declare something (§5.4 B16). Default false. */
  readonly everyHandler?: boolean;
  /**
   * Names of the handler's inputs that ctx.param(name) can read, as far as the transport knows them statically: HTTP route params,
   * GraphQL @Args names. Core passes them to boot advice (AdvisedHandler.inputs) and never interprets them. Default [].
   */
  readonly inputs?: readonly string[];
}

export interface AuthPrincipalBase {
  readonly kind: string;
  /** PrincipalSource.id that produced it. */
  readonly source: string;
  /** The better-auth user this principal acts for; null for machine or organization principals. */
  readonly userId: string | null;
  /**
   * Present when the principal acts with a NARROWER grant than its owner's rights (API key, OAuth token). Built-in policies
   * AND it with the owner's rights (Z5); a policy that does not name the principal's kind never receives it.
   */
  readonly delegation?: PrincipalDelegation;
}

export interface PrincipalDelegation {
  /** Does the credential's own grant include these permissions? (api-key: role(key.permissions).authorize) */
  allows(permissions: Readonly<Record<string, readonly string[]>>): boolean;
  /** Diagnostics, e.g. 'api-key permissions', 'oauth scopes'. */
  readonly description: string;
}

export interface PrincipalSource<P extends AuthPrincipalBase = AuthPrincipal> {
  readonly id: string;
  /** The principal kinds this source produces. Data: core compares them with the route's accepted kinds (§7.6). */
  readonly kinds: readonly P["kind"][];
  /**
   * 'default': accepted on every authenticated route of the instance. 'explicit': only where a route (@AcceptPrincipals) or a
   * requirement's policy names one of its kinds. Default 'explicit', so a new source never widens existing routes.
   */
  readonly acceptance?: "default" | "explicit";
  /**
   * Request headers this source reads credentials from (e.g. ['x-api-key']). The cookie bridge compares them (§7.5), and their
   * values are redacted from error causes (§13.4). They play no part in the origin check (§7.10).
   */
  readonly credentialHeaders?: readonly string[];
  /** Side effects of one resolution (drive boot advice, e.g. quota consumption per WS message). */
  readonly effects?: {
    readonly consumesQuota?: boolean;
    readonly writes?: boolean;
  };
  /**
   * The principal IS better-auth's session read of the request's headers (auth.api.getSession). Only then does a generic "no session"
   * 401 that a policy's later better-auth call meets contradict the principal, and only then does the evaluator re-read through this
   * source to tell a lost session from a swallowed storage failure (§8.1). The built-in session source sets it; a source that
   * authenticates by other means (API keys, OAuth tokens) must not. Default false.
   */
  readonly sessionBacked?: boolean;
  /**
   * The principals this source produces carry `delegation` (API keys, OAuth tokens). Data for B15: a requirement whose policy names no kinds
   * judges only non-delegated principals (§8.1), so at boot it admits exactly the kinds of the instance's sources that do not delegate.
   * S-delegation checks the declaration against the principals the source produces. Default false.
   */
  readonly delegates?: boolean;
  /**
   * better-auth plugins this source needs, checked at boot with $context.hasPlugin (B13); hostlessCalls: some of its auth.api calls
   * carry no Host header whatever the transport, so a dynamic baseURL needs a fallback (B20).
   */
  readonly requires?: {
    readonly plugins?: readonly string[];
    readonly hostlessCalls?: boolean;
  };
  /** Cheap synchronous sniffing (e.g. a header is present). false = skip without I/O. Default: true. */
  appliesTo?(request: PrincipalRequest): boolean;
  /**
   * Denials are values: return authenticated(p), absent() (no credential this source understands) or
   * rejected(failure) (a credential was presented and is invalid). A throw means infrastructure (5xx).
   */
  resolve(request: PrincipalRequest): Promise<PrincipalResult<P>>;
  /** Optional boot advice (§4). */
  advise?(
    ctx: BootAdviceContext,
  ): readonly BootAdvice[] | Promise<readonly BootAdvice[]>;
}

export type PrincipalResult<P extends AuthPrincipalBase = AuthPrincipal> =
  | { readonly outcome: "authenticated"; readonly principal: P }
  | { readonly outcome: "absent" }
  | { readonly outcome: "rejected"; readonly failure: AuthFailure };

export interface PrincipalRequest {
  readonly headers: Headers; // hygiene applied (pseudo-headers dropped, client-IP header set)
  readonly cookies: CookieSink | null; // null on cookie-less transports
  readonly transport: string; // TransportCall owner id, informational only
  readonly request?: { readonly method: string; readonly url: string };
  readonly freshness: "default" | "authoritative";
  readonly auth: AuthHandle;
  /** Memo per logical request (e.g. one verifyApiKey per request: it consumes quota). */
  memo<T>(key: string | object | symbol, compute: () => Promise<T>): Promise<T>;
}

/** What extensions receive instead of the raw instance. [A][C] */
export interface AuthHandle<A extends AuthLike = AuthLike> {
  readonly name: string;
  readonly instance: A;
  readonly api: A["api"];
  context(): Promise<AuthContextView>;
  hasPlugin(id: string): Promise<boolean>;
  /** Run auth.api calls inside a scope: cookie capability, forwarding mode, internal flag (§7.4, §7.5, §10.4). */
  run<T>(init: ScopeInit, fn: () => Promise<T>): Promise<T>;
  /** Origin/form rule for a browser leg (§7.10): null on pass/nonapplication, else denial; memoized per leg. browser.enforce gates cookie mode only; false never bypasses form mode. */
  checkOrigin(
    browser: BrowserExposure,
    mode: "cookie" | "form",
  ): Promise<AuthFailure | null>;
  /**
   * Did a better-auth endpoint itself produce `value` in a dispatch the plugin observed while bound, as opposed to a before-hook
   * short-circuit (LEAD-V37, LEAD-EXP-8)? Authoritative identity reads accept only such sessions (§7.3).
   */
  producedByEndpoint(value: unknown): boolean;
  /** Is `origin` trusted by this instance (post-init set; function-valued trustedOrigins get `request`)? (§6.9) */
  isTrustedOrigin(origin: string, request?: Request): Promise<boolean>;
}
export interface ScopeInit {
  /** null = cannot write cookies → the plugin suppresses session refresh for every call in fn. */
  readonly cookies: CookieSink | null;
  /**
   * Set-Cookie forwarding through the plugin's bridge for calls in fn. 'same-credential' (default): only calls that carry the
   * scope's credential (see `inbound`) or none; 'any': every call; 'none': no forwarding.
   */
  readonly forward?: "none" | "same-credential" | "any";
  /** The inbound request's headers, the credential 'same-credential' compares against. */
  readonly inbound?: () => Headers;
  /** Mark calls as library-internal (HookOptions.skipInternal). Default false. */
  readonly internal?: boolean;
}
/** The subset of better-auth's AuthContext the library reads (structural: any version in range fits). [C] */
export interface AuthContextView {
  readonly baseURL: string;
  readonly trustedOrigins: readonly string[];
  readonly skipCSRFCheck: boolean;
  readonly skipOriginCheck: boolean | readonly string[];
  /** The resolved signing secret; B29 compares it with better-auth's public default (LEAD-V48). */
  readonly secret: string;
  /** better-auth's resolved rate limiter; B30 reports it off in production (LEAD-V52). */
  readonly rateLimit: { readonly enabled: boolean };
  readonly options: {
    readonly baseURL?: unknown;
    readonly basePath?: string;
    readonly database?: unknown;
    readonly secondaryStorage?: unknown;
    /** `enabled` is undefined unless the user set it (B30 tells an explicit false from better-auth's NODE_ENV default). */
    readonly rateLimit?: { readonly enabled?: boolean };
    readonly trustedOrigins?:
      | readonly string[]
      | ((request?: Request) => unknown);
    readonly plugins?: readonly {
      readonly id: string;
      readonly hooks?: { readonly after?: readonly unknown[] };
    }[];
    readonly onAPIError?: { readonly throw?: boolean };
    readonly advanced?: {
      readonly ipAddress?: {
        readonly ipAddressHeaders?: readonly string[];
        readonly trustedProxies?: readonly string[];
      };
      readonly disableOriginCheck?: boolean;
      readonly disableCSRFCheck?: boolean;
      readonly cookiePrefix?: string;
    };
  };
  /** The admin policy's owner-row read for delegated principals (the ban rule), the call userHasPermission itself makes (LEAD-V45). */
  readonly internalAdapter: {
    findUserById(userId: string): Promise<{
      readonly id: string;
      readonly role?: string | null;
      readonly banned?: boolean | null;
      readonly banExpires?: Date | string | null;
    } | null>;
  };
  readonly authCookies: Readonly<
    Record<
      "sessionToken" | "sessionData" | "dontRememberToken" | "accountData",
      {
        readonly name: string;
        readonly attributes: {
          readonly domain?: string;
          readonly path?: string;
        };
      }
    >
  >;
  readonly sessionConfig: {
    readonly freshAge: number;
    readonly updateAge: number;
    readonly expiresIn: number;
  };
  readonly adapter: {
    findOne(input: {
      model: string;
      where: readonly { field: string; value: unknown }[];
    }): Promise<unknown>;
    updateMany(input: {
      model: string;
      where: readonly { field: string; value: unknown }[];
      update: Record<string, unknown>;
    }): Promise<number>;
  };
  hasPlugin(id: string): boolean;
  getPlugin(id: string): unknown;
  isTrustedOrigin(
    url: string,
    settings?: { allowRelativePaths: boolean },
  ): boolean;
}

export interface AuthorizationPolicy<
  Params = unknown,
  P extends AuthPrincipalBase = AuthPrincipal,
> {
  /** Diagnostic id ('better-auth:admin/permission'); never used for dispatch. */
  readonly id: string;
  readonly requires?: {
    /** better-auth plugin ids validated at boot through $context.hasPlugin (B13). */
    readonly plugins?: readonly string[];
    /**
     * Principal kinds this policy can judge; others are denied 403 PRINCIPAL_NOT_SUPPORTED (data-driven, no core branch).
     * Naming a kind also ADMITS it on routes that use the policy (§7.6). Omitted: any kind WITHOUT `delegation`; delegated
     * principals are denied 403 PRINCIPAL_NOT_SUPPORTED, so a policy must opt in to judging them (Z5). At boot such a policy admits
     * exactly the kinds of the instance's sources that do not declare `delegates` (B15).
     */
    readonly principals?: readonly P["kind"][];
    /** The decision needs an identity read that bypasses the cookie cache (admin-grade decisions): raises the route's freshness (§8.4). */
    readonly freshIdentity?: boolean;
    /** The policy calls better-auth with the request's credential headers, so credential hooks re-run per call (api-key quota). Boot advice only. */
    readonly presentsCredentials?: boolean;
    /** Some of the policy's auth.api calls carry no Host header (e.g. userHasPermission without headers), so a dynamic baseURL needs a fallback (B20). */
    readonly hostlessCalls?: boolean;
  };
  /** Denials are values. Throw only for infrastructure faults (they become 5xx, never 403). */
  evaluate(
    params: Params,
    context: AuthorizationContext<P>,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
  /** Optional boot validation of params (e.g. empty permission maps). Throw BetterAuthConfigurationError. */
  validate?(params: Params, boot: PolicyBootContext): void | Promise<void>;
  /** Optional boot advice (§4). */
  advise?(
    ctx: BootAdviceContext,
  ): readonly BootAdvice[] | Promise<readonly BootAdvice[]>;
}

/**
 * A policy value, or a provider class/token resolved through ModuleRef (for DI-backed policies). Whatever the ref, the planner, the
 * evaluator and B14 see the same resolved instance (U19), so `requires` declared as an instance field reaches the plan.
 */
export type PolicyRef<Params> =
  | AuthorizationPolicy<Params, any>
  | Type<AuthorizationPolicy<Params, any>>
  | InjectionToken;

export interface Requirement<Params = unknown> {
  readonly policy: PolicyRef<Params>;
  readonly params: Params;
  readonly label?: string; // diagnostics and anyOf messages
  /** Overrides policy.requires.principals for this requirement (e.g. permission(p, { principals })). */
  readonly principals?: readonly string[];
  /** Overrides policy.requires.freshIdentity for this requirement. */
  readonly freshIdentity?: boolean;
}
export type RequirementExpr =
  | Requirement
  | { readonly anyOf: readonly RequirementExpr[] }
  | { readonly allOf: readonly RequirementExpr[] };

export type AuthorizationDecision =
  | { readonly effect: "allow" }
  | {
      readonly effect: "deny";
      readonly status?: 401 | 403;
      readonly reason: string;
      readonly message?: string;
      readonly challenge?: string;
    };

export interface AuthorizationContext<
  P extends AuthPrincipalBase = AuthPrincipal,
> {
  readonly principal: P; // never null: requirements apply only to 'required' access (§7.6)
  readonly instance: string;
  readonly transport: string; // informational only
  readonly headers: Headers;
  readonly cookies: CookieSink | null;
  readonly request?: { readonly method: string; readonly url: string };
  param(name: string): unknown;
  readonly handler: { readonly class: Type; readonly method: string };
  readonly auth: AuthHandle;
  /**
   * Memo per LOGICAL REQUEST (HTTP request, WS message, …), never per connection: dedupe better-auth I/O by concrete inputs,
   * serialized as a tuple, e.g. `JSON.stringify(['org:hasPermission', orgId, stablePermissions])`, so no input can collide with another key's sentinel. Decisions themselves are never shared across invocations.
   */
  memo<T>(key: string | object | symbol, compute: () => Promise<T>): Promise<T>;
  /** Publish a per-invocation value for defineInvocationParam decorators (e.g. the resolved organization id). */
  provide(slot: symbol, value: unknown): void;
  readonly execution: ExecutionContext; // escape hatch; prefer the fields above
}

export interface PolicyBootContext {
  readonly auth: AuthHandle;
  readonly context: AuthContextView; // awaited $context: hasPlugin, sessionConfig, options
  readonly site: string; // 'ProjectsController.remove'
}
