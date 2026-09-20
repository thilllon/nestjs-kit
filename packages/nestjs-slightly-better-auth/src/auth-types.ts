import type {
  AuthPrincipalBase,
  DatabaseHookTarget,
} from "./auth-contracts.js";

/** Structural minimum; accepts any betterAuth() result incl. plugins and customSession (EXP-C2, EXP-A:types/). */
export interface AuthLike {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(ctx: {
      headers: Headers;
      query?: { disableCookieCache?: boolean; disableRefresh?: boolean };
      returnHeaders?: boolean;
    }): Promise<unknown>; // with returnHeaders: GetSessionWithHeaders
  };
  $context: Promise<unknown>;
}
/** What getSession({ returnHeaders: true }) resolves to. `headers` is undefined when a before-hook short-circuited the call (LEAD-V37). */
export interface GetSessionWithHeaders {
  readonly headers?: Headers | null;
  readonly response: unknown;
}

/** Augment this interface with the application auth instance and named instances. */
// biome-ignore lint/suspicious/noEmptyInterface: Public module augmentation point must remain an interface.
export interface Register {}
export type IsRegistered = Register extends { auth: AuthLike } ? true : false;
export type RegisteredAuth = Register extends { auth: infer A extends AuthLike }
  ? A
  : AuthLike;
export type RegisteredInstances = Register extends {
  instances: infer I extends Record<string, AuthLike>;
}
  ? I
  : Record<never, never>;
export type AuthOf<N extends string = "default"> = N extends "default"
  ? RegisteredAuth
  : N extends keyof RegisteredInstances
    ? RegisteredInstances[N]
    : AuthLike;

/** Unregistered fallback = better-auth's default core shape (Session/User are exported by better-auth, EXP-C11). */
type DefaultSession = {
  session: import("better-auth").Session;
  user: import("better-auth").User;
};
export type SessionOf<A> = A extends { $Infer: { Session: infer S } }
  ? NonNullable<S>
  : DefaultSession;
export type UserOf<A> = SessionOf<A> extends { user: infer U } ? U : never;
export type AuthSession<N extends string = "default"> = SessionOf<AuthOf<N>>;
export type AuthUser<N extends string = "default"> = UserOf<AuthOf<N>>; // never for customSession shapes without `user`
export type HasUserId<S> = S extends { user: { id: string } } ? true : false;

// Permissions: derived from the plugin endpoints' body types, which better-auth computes from `ac` statements [A][C]
type BodyOf<F> = F extends (ctx: infer C) => unknown
  ? [NonNullable<C>] extends [{ body?: infer B }]
    ? NonNullable<B>
    : never
  : never;
type PermissionsOf<A, K extends string> = A extends {
  api: { [k in K]: infer F };
}
  ? BodyOf<F> extends { permissions?: infer P }
    ? NonNullable<P>
    : never
  : never;
export type AdminPermissions<N extends string = "default"> =
  IsRegistered extends true
    ? PermissionsOf<AuthOf<N>, "userHasPermission">
    : Record<string, readonly string[]>;
export type OrgPermissions<N extends string = "default"> =
  IsRegistered extends true
    ? PermissionsOf<AuthOf<N>, "hasPermission">
    : Record<string, readonly string[]>;
// Builders are generic in the instance for named instances: permission<'admin'>({ … }), orgPermission<'admin'>({ … }).

// Endpoint paths and typed hook contexts (EXP-C9) [C]
type ApiOf<A> = A extends { api: infer Api } ? Api : never;
export type EndpointPath<A = RegisteredAuth> = {
  [K in keyof ApiOf<A>]: ApiOf<A>[K] extends { path: infer P extends string }
    ? P
    : never;
}[keyof ApiOf<A>];
type EndpointAt<P extends string, A = RegisteredAuth> = {
  [K in keyof ApiOf<A>]: ApiOf<A>[K] extends { path: P } ? ApiOf<A>[K] : never;
}[keyof ApiOf<A>];
type BodyAt<P extends string> = [EndpointAt<P>] extends [never]
  ? unknown
  : BodyOf<EndpointAt<P>>;
/**
 * The RAW body a hook sees: the endpoint's schema has not run yet (before-hooks) or ran on the same raw input (after-hooks).
 * Known keys autocomplete; every value is `unknown` until the hook checks it.
 */
export type UnvalidatedBody<B> = [B] extends [never]
  ? unknown
  : B extends object
    ? { readonly [K in keyof B]?: unknown } & Readonly<Record<string, unknown>>
    : unknown;
export type AuthHookContext<P extends string = string> = Omit<
  import("better-auth").HookEndpointContext,
  "path" | "body"
> & { path: P; body: string extends P ? unknown : UnvalidatedBody<BodyAt<P>> };
export type AuthAfterHookContext<P extends string = string> =
  AuthHookContext<P>; // context.returned / newSession / responseHeaders populated

// Database hooks: derived from better-auth's own option types, so Partial<> on update and the delete return type track
// better-auth across minors (LEAD-V22)
type DbHooks = NonNullable<
  import("better-auth").BetterAuthOptions["databaseHooks"]
>;
type DbHookFn<
  E extends DatabaseHookTarget,
  Ph extends "before" | "after",
> = E extends `${infer M extends keyof DbHooks & string}.${infer O extends "create" | "update" | "delete"}`
  ? NonNullable<NonNullable<NonNullable<DbHooks[M]>[O]>[Ph]>
  : never;
/** Best effort: the registered instance's additional user/session fields, Partial for updates; nothing when not derivable. */
type RegisteredRow<M> = M extends "user"
  ? UserOf<RegisteredAuth>
  : M extends "session"
    ? SessionOf<RegisteredAuth> extends { session: infer S }
      ? S
      : never
    : never;
type ExtraFields<E extends DatabaseHookTarget> =
  E extends `${infer M}.${infer O}`
    ? [RegisteredRow<M>] extends [never]
      ? Record<never, never>
      : O extends "update"
        ? Partial<RegisteredRow<M>>
        : RegisteredRow<M>
    : Record<never, never>;
/** The payload better-auth passes: e.g. update.before → Partial<User> & Record<string, unknown>. */
export type DatabaseHookData<
  E extends DatabaseHookTarget,
  Ph extends "before" | "after" = "before",
> = Parameters<DbHookFn<E, Ph>>[0] & ExtraFields<E>;
/** What better-auth accepts back: create/update.before → boolean | void | { data }; delete.before → boolean | void; after → void. */
export type DatabaseHookResult<
  E extends DatabaseHookTarget,
  Ph extends "before" | "after",
> = Awaited<ReturnType<DbHookFn<E, Ph>>>;
export type DatabaseHookMethod<
  E extends DatabaseHookTarget,
  Ph extends "before" | "after",
> = (
  data: DatabaseHookData<E, Ph>,
  ctx: import("better-auth").GenericEndpointContext | null | undefined,
) => DatabaseHookResult<E, Ph> | Promise<DatabaseHookResult<E, Ph>>;

/** Guard-established invariant helper (reference #163). Prefer @ActiveOrganizationId() (§8.3). */
export type WithActiveOrganization<S> = S & {
  session: { activeOrganizationId: string };
};

// Principals (§4.3) [A][B][C]
export interface PrincipalKinds {
  session: SessionPrincipal;
} // augmentable
export type PrincipalKind = keyof PrincipalKinds & string;
export type AuthPrincipal = PrincipalKinds[PrincipalKind];
export type PrincipalOfKind<K extends PrincipalKind> = PrincipalKinds[K];
export interface SessionPrincipal<S = AuthSession> extends AuthPrincipalBase {
  readonly kind: "session";
  readonly session: S;
}
