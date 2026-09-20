import type { HookEndpointContext } from "better-auth";
import type { CookieSink, DatabaseHookTarget } from "./auth-contracts.js";
import type { DatabaseHookMethod } from "./auth-types.js";

export const BRIDGE_HANDLE = Symbol.for("nestjs-slightly-better-auth:bridge");
export const EXTENSION_DEFINITION = Symbol.for(
  "nestjs-slightly-better-auth:extension",
);
export const UPGRADE_REQUEST = Symbol.for(
  "nestjs-slightly-better-auth:upgrade-request",
);

export interface BridgeHandle {
  readonly protocol: 4; // checked by core (B04); v5: binding state and instance, the caller-session check
  readonly clientIpHeader: string | null; // single source of truth for the header name (§6.8)
  /** 'unbound' until the first bind(); 'bound' while an application's hooks are registered; 'closed' after its shutdown, hooks still registered. */
  readonly state: "unbound" | "bound" | "closed";
  /** Endpoint dispatches and database-hook dispatches (writes) seen before the first binding, reset by every bind() (B26). */
  readonly unboundDispatches: number;
  /**
   * Registers the application's hooks and returns close(), which the kernel calls in onApplicationShutdown: a closed binding keeps
   * dispatching until another application binds (§10.6). A second bind() from the same owner for the same instance is a no-op that
   * returns the existing registration (NestMicroservice.init() runs lifecycle hooks twice); from the same owner for another instance it
   * throws PLUGIN_SHARED_BETWEEN_INSTANCES (B03). Throws INSTANCE_ALREADY_BOUND if another bootstrapped application is bound; takes over
   * a never-bootstrapped one (reported, B06) and a closed one (silently).
   */
  bind(binding: BridgeBinding): { close(): void; tookOverFrom?: string };
  /** true when an endpoint returned `value` (an object) in a non-router dispatch observed while bound; false for before-hook short-circuits (LEAD-V37). */
  producedByEndpoint(value: unknown): boolean;
}
export interface BridgeBinding {
  /** The application: compared by identity for the same-owner no-op; `description` goes into the B06 message. */
  readonly owner: { readonly description: string };
  /** The instance this plugin object serves; one plugin object serves one instance (B03). */
  readonly instance: string;
  /** 'initialized' at bind; the kernel sets 'bootstrapped' in onApplicationBootstrap; close() sets 'closed'. */
  state: "initialized" | "bootstrapped" | "closed";
  /** View of the kernel's RequestScope; the plugin never owns an AsyncLocalStorage. [C] */
  current(): ScopeView | undefined;
  /** Credential header names declared by the instance's principal sources (credential matching, §7.5). */
  readonly credentialHeaders: readonly string[];
  readonly before: readonly CompiledHook[]; // sorted by order, then discovery order
  readonly after: readonly CompiledHook[];
  readonly database: Readonly<{
    [E in DatabaseHookTarget]: {
      readonly before: readonly DatabaseHookMethod<E, "before">[];
      readonly after: readonly DatabaseHookMethod<E, "after">[];
    };
  }>;
  /** Debug log when the bridge drops a direct call's cookies because its credential is foreign. */
  onDropped(path: string): void;
}
export interface ScopeView {
  /** Cookie-capable forwarding handlers have already passed the enforcing form check on every method/operation (§7.10). */
  readonly cookies: CookieSink | null;
  readonly forward: "none" | "same-credential" | "any";
  readonly inbound: (() => Headers) | undefined;
  readonly internal: boolean;
  /**
   * Present in EVERY handler scope whose transport exposes a browser leg, unless the plan's origin check is 'off' — enforcing or not,
   * so safe methods and GraphQL queries are covered too (§7.5). Returns when this leg has a passing origin verdict for `instance`, or
   * the single kernel disable predicate (§7.10 item 4) holds; a guard run without a passing verdict is insufficient. Otherwise throws the kernel's
   * BetterAuthConfigurationError PUBLIC_HANDLER_USED_CALLER_SESSION.
   */
  readonly checkCallerSession?: (path: string, instance: string) => void;
  /** The browser leg's OWN headers (TransportCall.browser.headers()), before any transport credential mapping replaced them; undefined
   * when the transport exposes no browser leg. Entry 2 recognizes an ambiently carried session cookie with it. */
  readonly browserHeaders: (() => Headers) | undefined;
}
export interface CompiledHook {
  /**
   * Evaluate the user predicate once and let it throw. The dispatcher logs and
   * converts before-hook matcher failures to APIError 500; after-hook matcher
   * failures cross the next fixed SDK matcher boundary unchanged, so the SDK
   * cannot recover them as handler APIErrors. Never swallow a failure as a
   * non-match or evaluate the predicate again in run().
   */
  matches(ctx: HookEndpointContext, scope: ScopeView | undefined): boolean;
  run(ctx: HookEndpointContext): Promise<unknown>;
}
