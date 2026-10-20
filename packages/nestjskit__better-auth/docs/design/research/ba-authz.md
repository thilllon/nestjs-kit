# Research: authorization, principals and session typing (better-auth 1.7.4)

Research phase for `nestjs-slightly-better-auth`. Topic: how a NestJS guard layer should **delegate** to better-auth instead of reimplementing it.

Everything below comes from reading source, docs and running probes. Claims I could not verify are marked **UNVERIFIED**. Where docs and source disagree, I say so and trust the source.

## Path legend

All paths are relative to the scratchpad root
`/private/tmp/claude-502/-Users-thilllon-git-nestjs-slightly-better-auth/d03cce33-4991-442c-88b5-c314fe7f3223/scratchpad/`.

| Alias     | Path                                                                                                                                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `BA/`     | `better-auth/packages/better-auth/src/` (better-auth 1.7.4, commit 8d37cc3)                                                            |
| `CORE/`   | `better-auth/packages/core/src/`                                                                                                       |
| `APIKEY/` | `better-auth/packages/api-key/src/` (`@better-auth/api-key` 1.7.4)                                                                     |
| `OAP/`    | `better-auth/packages/oauth-provider/src/` (`@better-auth/oauth-provider` 1.7.4)                                                       |
| `MCP/`    | `better-auth/packages/mcp/src/` (`@better-auth/mcp` 1.7.4)                                                                             |
| `DOCS/`   | `better-auth/docs/content/docs/`                                                                                                       |
| `REF/`    | `ref/` (`@thallesp/nestjs-better-auth` 2.8.0, commit 99d4a94)                                                                          |
| `PROBE/`  | `tmp-ba-authz/` (my probe scripts; npm `better-auth@1.7.4`, `@better-auth/api-key@1.7.4`, `typescript@5.9.3`, `@nestjs/common@12.0.1`) |

Rerun a probe with `cd PROBE && node <file>.mjs`. Rerun the type probes with `npx tsc -p tsconfig.json` and `npx tsc -p decl/tsconfig.json`.

---

## 0. Headline facts

1. **Every plugin-visible authentication path goes through `auth.api.getSession({ headers })`.** `auth.api.*` calls run the full before/after hook pipeline (`BA/api/to-auth-endpoints.ts:88-113`, `BA/api/dispatch.ts:323-483`). That is how bearer, api-key (when `enableSessionForAPIKeys` is on), jwt and multi-session change `getSession` on the server.
2. **Some principals never go through `getSession`.** JWT-plugin tokens, OAuth-provider / MCP access tokens, and API keys used purely as credentials (`verifyApiKey`) all have their own verification APIs. `getSession` returns `null` for them (probe-principals: `getSession with Bearer <jwt> -> null`).
3. **Permission checks live in plugin endpoints, not in core.**
   - `auth.api.userHasPermission` (admin plugin)
   - `auth.api.hasPermission` (organization plugin)
   - `auth.api.verifyApiKey({ permissions })` (api-key plugin)
   - the pure primitive `role(statements).authorize()` (`better-auth/plugins/access`)

   Their cost, header requirements and failure modes differ a lot (section 2).

4. **A guard-side `getSession` silently drops `Set-Cookie`** (session refresh, cookie-cache refresh) unless you pass `returnHeaders: true` (probe-setcookie).
5. **Cookie cache makes guard-side role checks stale.** Promoted or demoted roles and revoked sessions stay visible for up to `cookieCache.maxAge` (default 300 s) (probe-admin section 4 and section 5). better-auth's own admin endpoints bypass the cookie cache for authorization, using `getAuthoritativeSessionFromCtx` (`BA/api/routes/session.ts:520-539`).
6. **`customSession` replaces both `auth.api.getSession` and `$Infer.Session` with an arbitrary shape.** Core code must not assume the shape `{ user, session }` (probe-principals, `PROBE/types/infer.ts` `_custom`).
7. **A NestJS param decorator cannot carry a type to its parameter.** `createParamDecorator(...)` returns `(...) => ParameterDecorator` (`@nestjs/common@12.0.1` `create-route-param-metadata.decorator.d.ts:14`). Typing always works by the user annotating the parameter with a type the library exports. I tsc-verified three ways to export that type (section 3.6).
8. **The reference library reimplements role logic and misuses `userHasPermission`.**
   - Its `@UserHasPermission({ userId, role })` options are ignored: better-auth uses the session user whenever `headers` are passed (probe-admin section 1).
   - Its role parsing differs from better-auth's: it trims around commas and ignores `adminUserIds` (probe-admin sections 2 and 3).
   - It calls `getSession` before checking `@AllowAnonymous()`.
   - It swallows plugin errors and returns 403.
9. **Both better-auth 1.7.4 and NestJS 12.0.1 (npm `latest`, published) are ESM-only.** Node 22.22 loaded both through `require()` without errors (require(esm)); see section 5.8.

---

## 1. Principal sources, plugin by plugin

### 1.0 How core `getSession` works (baseline for every row below)

**Call shape.** `auth.api.getSession({ headers, query?: { disableCookieCache?, disableRefresh? }, returnHeaders?, asResponse? })`.

- Query schema: `BA/cookies/session-store.ts:281-301`.
- Typed overload: `BA/types/api.ts:19-51`.
- A plain header record also works. At runtime `dispatch.ts:349` does `new Headers(input.headers)`. At the type level the better-call endpoint signature is intersected in, so `{ cookie: "..." }` type-checks (`PROBE/types/infer.ts` item 9; tsc exit 0).
- It is GET-only unless `session.deferSessionRefresh` is set (`session.ts:79-84`).

**Algorithm** (`BA/api/routes/session.ts:86-426`):

1. Read the signed `session_token` cookie. If it is missing, return `null`.
2. If `session.cookieCache.enabled` and a valid `session_data` cookie exists, and the query does not set `disableCookieCache`, return it **with zero storage reads** (lines 114-285).
3. Otherwise call `internalAdapter.findSession(token)`. That is one KV `get` if `secondaryStorage` is configured, or one DB `findOne` on `session` joined to `user` (`BA/db/internal-adapter.ts:602-669`).
4. If more than `updateAge` has passed, write the new expiry to the DB and emit `Set-Cookie` (lines 324-412).
5. Write the cookie cache, which also emits `Set-Cookie` (line 413).

**Failure modes.**

- It returns `null` for no, invalid or expired sessions.
- It throws only when a **hook** throws (for example api-key) or on an internal error, which is wrapped as a 500 (lines 427-436).

**Set-Cookie is dropped.** Without `returnHeaders: true` the refresh and cache cookies are lost. Probe-setcookie with `updateAge: 0`: `set-cookie names: ['better-auth.session_token','better-auth.session_data']` when `returnHeaders: true`; a plain call just returns `{session,user}`. The docs require forwarding in the stateless case: "server-side integrations must forward the returned `Set-Cookie` header" (`DOCS/concepts/session-management.mdx:430`).

**Cookie names** (`BA/cookies/index.ts:95-131`): `<prefix>.session_token`, `<prefix>.session_data`, `<prefix>.dont_remember`. The prefix defaults to `better-auth` (`advanced.cookiePrefix`). A `__Secure-` variant is used on HTTPS (`index.ts:579-586`).

**Hook order.** Plugin hooks run after user hooks (`dispatch.ts:269-306`). A before-hook can:

- rewrite request headers (bearer), or
- short-circuit the endpoint by returning a value (api-key on `/get-session`, `dispatch.ts:385-394`).

**Rate limiting.** The global IP rate limiter runs in the HTTP router's `onRequest` (`BA/api/index.ts:297-312`), so direct `auth.api.*` calls from a guard skip it. This is inferred from source; **UNVERIFIED at runtime**.

**Caching the session per request.** No public API injects an already-resolved session into a later `auth.api.*` call. Each dispatch starts with `session: null`: "A fresh dispatch (shared context) has no session" (`dispatch.ts:341-346`). So every plugin endpoint that uses `sessionMiddleware` resolves the session **again**.

**Stateful vs stateless.** `isStateful(ctx)` is exported from `better-auth/api`. It returns `!!options.database || !!options.secondaryStorage` (`BA/context/store-capabilities.ts:3-5`, `session.ts:450-451`). better-auth's own authoritative read disables the cookie cache **only when stateful**, because in stateless mode the cookie _is_ the session (`session.ts:520-539`).

### 1.1 Summary table

"DB" means one storage round-trip: a DB query or a KV get. Numbers are for the default configuration.

| Plugin                                        | How the server gets the principal                                                                                                                                                                                                                                                                                           | Credentials on the wire                                                                         | Principal shape                                                                                                | Storage cost per request                                                                                                                                                                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core                                          | `auth.api.getSession({headers})`                                                                                                                                                                                                                                                                                            | `Cookie: better-auth.session_token` (+ `session_data` cache)                                    | `{session,user}`                                                                                               | 0 on cookie-cache hit; otherwise 1 (findSession) + 1 write when refresh is due                                                                                                                                                               |
| **admin**                                     | same as core                                                                                                                                                                                                                                                                                                                | same; impersonation adds an `admin_session` cookie (`BA/plugins/admin/routes.ts:1300,1367`)     | `user.role/banned/banReason/banExpires`, `session.impersonatedBy` (`admin/schema.ts`)                          | same as core                                                                                                                                                                                                                                 |
| **organization**                              | same as core; org role is **not** on the session                                                                                                                                                                                                                                                                            | same                                                                                            | adds `session.activeOrganizationId` (+ `activeTeamId` with teams) (`organization/organization.ts:1256-1296`)   | same as core, plus **1 member read per org role/permission check**, plus 1 `organizationRole` read with dynamic AC                                                                                                                           |
| **access**                                    | n/a (pure library)                                                                                                                                                                                                                                                                                                          | n/a                                                                                             | n/a                                                                                                            | 0 (sync)                                                                                                                                                                                                                                     |
| **api-key** (`enableSessionForAPIKeys: true`) | `auth.api.getSession({headers})`; a before-hook mocks the session                                                                                                                                                                                                                                                           | `x-api-key` (configurable `apiKeyHeaders`, `customAPIKeyGetter`) (`APIKEY/index.ts:74,133-157`) | mock `{session:{id: apiKey.id, token: <raw key>, userId,...}, user: <raw DB row>}` (`APIKEY/index.ts:241-260`) | 1 key read + guarded usage/rate-limit writes (1-3) + 1 `updatedAt` write + 1 user read (`APIKEY/routes/verify-api-key.ts:45-223`, `index.ts:233`) + expired-key cleanup at most every 10 s (`APIKEY/routes/index.ts:98-111`)                 |
| **api-key** (as credential)                   | `auth.api.verifyApiKey({ body:{ key, permissions?, configId? } })`, server-only (`verify-api-key.ts:502-631`)                                                                                                                                                                                                               | any header you choose                                                                           | `{ valid, error, key: Omit<ApiKey,"key"> }` (includes `permissions`, `referenceId`)                            | same key read + usage writes; **no user read**                                                                                                                                                                                               |
| **bearer**                                    | `auth.api.getSession({headers})`; a before-hook turns the bearer token into a cookie (`BA/plugins/bearer/index.ts:47-116`)                                                                                                                                                                                                  | `Authorization: Bearer <session token>`                                                         | core                                                                                                           | 1 findSession (a bearer request has no `session_data` cookie); a random non-dotted token still costs 1 lookup unless `requireSignature: true` (probe-bearer-cost)                                                                            |
| **jwt**                                       | not via `getSession` (`Bearer <jwt>` → `null`). Use `auth.api.verifyJWT({ body:{ token, issuer? } })` (`jwt/index.ts:310-348`), or jose with remote/local JWKS (`DOCS/plugins/jwt.mdx:138-220`)                                                                                                                             | `Authorization: Bearer <jwt>` (app-defined)                                                     | JWT claims (default: whole user + `sub`, `iss`, `aud`, `exp`)                                                  | `verifyJWT`: 1 `jwks` findMany per call, uncached (`jwt/verify.ts:33-35`, `jwt/adapter.ts:14-22`); local jose: 0                                                                                                                             |
| **jwt** (side effect)                         | `getSession` after-hook signs a JWT into `set-auth-jwt` **on every call** (`jwt/index.ts:350-383`)                                                                                                                                                                                                                          | n/a                                                                                             | n/a                                                                                                            | +1 `jwks` findMany + 1 signing per `getSession` (probe-jwt-cost: 21 findMany over 20 calls vs 0 with `disableSettingJwtHeader: true`)                                                                                                        |
| **multi-session**                             | same as core; the active principal is still the main `session_token`                                                                                                                                                                                                                                                        | extra signed cookies `<session_token>_multi-<token>` (`multi-session/index.ts:58,141-207`)      | core                                                                                                           | same as core                                                                                                                                                                                                                                 |
| **anonymous**                                 | same as core                                                                                                                                                                                                                                                                                                                | same                                                                                            | `user.isAnonymous: boolean` (`anonymous/schema.ts`)                                                            | same as core                                                                                                                                                                                                                                 |
| **customSession**                             | `auth.api.getSession` **replaced** by the plugin endpoint (`custom-session/index.ts:66-128`)                                                                                                                                                                                                                                | same as core                                                                                    | **whatever the callback returns** (probe: `{"principal":{"uid":...},"roles":["x"]}`)                           | core + the user callback on **every** call, never cached (`DOCS/concepts/session-management.mdx:582`)                                                                                                                                        |
| **one-time-token**                            | not a per-request principal. `auth.api.verifyOneTimeToken({ body:{ token } })` consumes the token and returns the session, setting the cookie unless `disableSetSessionCookie` (`one-time-token/index.ts:170-210`)                                                                                                          | token in body                                                                                   | `{session,user}`                                                                                               | 1 consume + 1 findSession (exchange only)                                                                                                                                                                                                    |
| **device-authorization**                      | alone: `/device/token` returns `access_token = <better-auth session token>`, `token_type: "Bearer"` (`device-authorization/routes.ts:751-781`), so you need the bearer plugin and then `getSession`. Composed with oauth-provider: JWT access tokens from `/oauth2/token` (`DOCS/plugins/device-authorization.mdx:195-223`) | `Authorization: Bearer ...`                                                                     | core, or OAuth claims                                                                                          | as bearer, or as oauth-provider                                                                                                                                                                                                              |
| **oauth-provider**                            | not via `getSession`. Use `verifyAccessTokenRequest(requestToResourceInput(req), opts)` from `better-auth/oauth2` (`CORE/oauth2/verify.ts:619-667`; `DOCS/plugins/oauth-provider.mdx:859-915`)                                                                                                                              | `Authorization: Bearer\|DPoP <at>` + `DPoP` proof                                               | JWT claims (`sub`, `scope`, `aud`, `azp`→`client_id`) (`verify.ts:268-270`)                                    | JWT: 0 DB; JWKS fetched **over HTTP by URL** and cached 5 min (`verify.ts:64-77,108-121`). Opaque: 1 HTTP introspection that needs client credentials (`verify.ts:134-161`). DPoP replay store is in-memory by default (`verify.ts:185-199`) |
| **mcp**                                       | `requireMcpAuth(auth, handler, opts)` wraps a Fetch `(Request)=>Response` handler (`MCP/require-mcp-auth.ts:78-130`), built on `createMcpProtectedRequestHandler` → `verifyAccessTokenRequest` (`MCP/handler.ts:127-172`)                                                                                                   | same as oauth-provider                                                                          | "verified access-token claims ... not as a database record" (`DOCS/plugins/mcp.mdx:225`)                       | same as oauth-provider; DPoP replay store is DB-backed by default (`require-mcp-auth.ts:120-126`)                                                                                                                                            |

### 1.2 Details that matter for a guard

#### admin

- **Impersonation.** `impersonateUser` creates a session for the target with `impersonatedBy = <admin id>` (`admin/routes.ts:1273-1285`) and moves the admin's own session into an `admin_session` cookie (`routes.ts:1300`). `getSession` then returns the **impersonated** user. The only signal is `session.session.impersonatedBy`.
- **Bans.**
  - Enforced when a session is created (`admin/admin.ts:90-121`, database hook `session.create.before`).
  - `banUser` deletes all the user's sessions (`routes.ts:1159`).
  - A session already cached in a cookie keeps validating until the cache expires (section 1.3).
- **Roles.**
  - Stored as a comma-joined string: `parseRoles` does `roles.join(",")` (`routes.ts:47-49`); docs: "Multiple roles are stored as string separated by comma" (`DOCS/plugins/admin.mdx:448`).
  - The inferred type is `string | null | undefined`, never an array (`PROBE/types/infer.ts` `_role`).
- **Who counts as admin.** "An admin is any user assigned the `admin` role or any user whose ID is included in the `adminUserIds` option" (`DOCS/plugins/admin.mdx:72`).
- **Freshness.** Admin endpoints read the session **authoritatively** (`adminMiddleware` → `getAuthoritativeSessionFromCtx`, `routes.ts:33-46`).

#### organization

- **How the active org gets set.**
  - `setActiveOrganization`.
  - `createOrganization`, for the creator's session, unless `keepCurrentActiveOrganization` (`routes/crud-org.ts:273-284`).
  - A user-written `databaseHooks.session.create.before` (`DOCS/plugins/organization.mdx:647-668`).

  Otherwise it is `null`.

- **Docs endorse keeping the active org client-side:** "multiple tabs can have different active organizations" (`organization.mdx:615-619`). An org context taken from the request (route param or header) is therefore a legitimate need.
- **`activeOrganizationId` can be stale.** `removeMember` only clears it when members remove themselves (`routes/crud-members.ts:448-458`). Probe-principals: the removed member's session still had `activeOrganizationId === org.id`. `hasPermission` then threw `401 USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`. So the ID being **present** proves nothing about membership.
- **Membership is a DB read.** `findMemberByOrgId` does a `findOne` on `member` joined to `user` (`organization/adapter.ts:377-410`).
- **Teams** have no roles or permissions of their own: "Teams follow the organization's permission system" (`organization.mdx:1986-1997`). `teamMember` has only `teamId`, `userId`, `membershipKey`, `createdAt` (`organization/schema.ts:84-110`).
- **Dynamic AC.**
  - Per-org roles live in the `organizationRole` table and are merged into the static roles on every check (`organization/has-permission.ts:31-68`).
  - The client-side `checkRolePermission` ignores dynamic roles (`organization.mdx:1519-1520`).

#### access

- **API.** `createAccessControl(statements)` returns `{ newRole, statements }`. `role(statements).authorize(request, connector = "AND")` returns `{success:true}` or `{success:false, error}` (`BA/plugins/access/access.ts:113-181`).
- **Per-resource OR/AND.** You can pass `{ actions, connector }` per resource (`access/types.ts`, `RoleAuthorizeRequest`). Probe-org: `member.authorize({project:{actions:["read","delete"],connector:"OR"}})` → `{"success":true}`; with an array → `success:false`.
- **The OR form is not reachable through the endpoints.** The admin and org endpoint body schemas only accept `Record<string, string[]>` (`admin/routes.ts:1753-1771`, `organization/organization.ts:167-180`).
- **Public exports:** `createAccessControl`, `role` (probe export listing).

#### api-key

- **Session mocking is off by default** and documented as "not recommended for production use" (`APIKEY/types.ts:197-203`). The docs warn "A leaked api key can be used to impersonate a user" (`DOCS/plugins/api-key/advanced.mdx:11-13`).
- **Only user-owned keys can mock sessions.** `references !== "user"` → 401 (`APIKEY/index.ts:225-231`).
- **Default rate limit is 10 requests per day**, enabled (`APIKEY/index.ts:84-91`; column default `rateLimitEnabled: true`, `APIKEY/schema.ts:100-105`). Every `getSession` counts. Probe-principals: the 9th `getSession` returned `429 RATE_LIMITED` (after 1 `getSession` and 1 successful verify). The docs confirm both the counting and the double increment when `verifyApiKey` is combined with `getSession` (`advanced.mdx:19-22,556-566`).
- **An invalid key makes `getSession` THROW; it does not return `null`.** A short key gives `403 INVALID_API_KEY`; an unknown 64-char key gives `401 INVALID_API_KEY` (probe-principals).
- **The api-key header beats the cookie.** With both present, the hook runs first and its error wins (probe-principals: 429 despite a valid cookie).
- **The mocked session leaks data** (probe-principals, probe-apikey-returned):
  - `session.token` equals the raw API key.
  - `session.id` equals `apiKey.id`.
  - There is no `activeOrganizationId`.
  - `user` is the raw row from `findUserById` (`BA/db/internal-adapter.ts:1060-1072`), so fields marked `returned: false` are present at runtime: `api-key session has secretNote: true TOP-SECRET`. The static type excludes them.
- **The mocked session does not carry key permissions.** There is no side-effect-free public API to read them: `getApiKey` requires a session (`APIKEY/routes/get-api-key.ts:40-45`), and calling it with the `x-api-key` header would run the hook and consume usage again. The only permission API is `verifyApiKey`, which consumes usage. Internally it evaluates with the same `role()` primitive: `role(apiKeyPermissions).authorize(permissions)` (`verify-api-key.ts:116-131`).
- **`verifyApiKey` failures don't throw.** It returns `{valid:false, error:{code}}` and logs at ERROR level (`verify-api-key.ts:573-595`; probe output shows an `ERROR [Better Auth]: Failed to validate API key` line).
- **Org-owned keys** manage permissions through the org AC with `allowCreatorAllPermissions: true` (`APIKEY/org-authorization.ts:118-145`).

#### bearer

- **Scheme** is matched case-insensitively (`bearer/index.ts:28-29,62-67`).
- **Dotted tokens** are treated as already signed and HMAC-verified.
- **Non-dotted tokens** are signed with the server secret and then verified. That always passes, so the token reaches `findSession` unless `requireSignature: true` (`index.ts:75-100`; probe-bearer-cost: `findSession calls: 1` vs `0`).
- **Response header.** The after-hook exposes `set-auth-token` (`index.ts:119-157`).

#### jwt

- The docs say "not meant as a replacement for the session" and point to bearer for token auth (`jwt.mdx:9-11`).
- `getToken` requires a session (`jwt/index.ts:249-285`).
- The exported `verifyJWT` function needs an endpoint context (`getCurrentAuthEndpointContext()`, `jwt/verify.ts:17`). Outside an endpoint, go through `auth.api.verifyJWT`.
- **Defaults:** issuer and audience are the base URL, expiry is 15 minutes, and the payload is the whole user unless `definePayload` is set (`jwt.mdx:514-548`).
- `sessionCookieCache: true` makes the cookie-cache JWT verifiable through JWKS. It requires `cookieCache.strategy = "jwt"` (`jwt/index.ts:72-106`).

#### customSession

- **What changes.**
  - The plugin registers its own `/get-session` endpoint.
  - `$Infer.Session` becomes `Awaited<ReturnType<fn>>` (`custom-session/index.ts:130-132`).
  - Internal plugin endpoints still use the **base** session: `listOrganizations` worked in the probe.
- **Plugin fields in the callback.** The `session` passed to the callback lacks plugin fields unless you pass the options (`session-management.mdx:550-580`).
- **Method.** GET only (`custom-session/index.ts:74`).

#### oauth-provider / mcp

- **Recommended verifier.** `verifyAccessTokenRequest` handles DPoP too (`oauth-provider.mdx:865`). `verifyBearerToken` rejects DPoP-bound tokens (`CORE/oauth2/verify.ts:595-610`).
- **Options:** `verifyOptions` (issuer and audience required), `requiredScopes`, `isScopeSatisfied`, `jwksUrl`, `remoteVerify`, `dpop` (`verify.ts:163-200`).
- **`verifyAccessTokenRequest` only takes `jwksUrl` (a string)**, so a monolith that hosts both the auth server and the API fetches its own `/jwks` over HTTP.
- **In-process JWKS alternative.** The lower-level export `verifyJwsAccessToken(token, { jwksFetch: string | () => Promise<JWKS>, jwksCacheKey?, verifyOptions })` accepts a function source (`verify.ts:235-277`).
- **Insufficient scope.** `createInsufficientScopeError(requiredScopes)` produces a 403 with an RFC 6750 `insufficient_scope` challenge (`verify.ts:527-552`). MCP clients rely on this to step up (`mcp.mdx:223`).
- **Scopes vs permissions.** The docs explicitly leave the scope-to-permission mapping to the resource server (`oauth-provider.mdx:955-1000`).

#### Other sign-in plugins

Other sign-in plugins (username, email-otp, magic-link, passkey, phone-number, siwe, sso, two-factor) end in an ordinary session, so the guard needs no changes. **UNVERIFIED** plugin by plugin.

### 1.3 Staleness and revocation (empirical, probe-admin)

Configuration: `cookieCache: { enabled: true, maxAge: 300 }`.

| Step                                             | Result                                                          |
| ------------------------------------------------ | --------------------------------------------------------------- |
| promote A to admin in DB; default `getSession`   | `role: user`, `findSession calls: 0` (served from cookie cache) |
| same with `query:{disableCookieCache:true}`      | `role: admin`, `findSession calls: 1`                           |
| `userHasPermission({headers})` after promote     | `success:true` (authoritative read, `findSession calls: 1`)     |
| delete all of A's sessions; default `getSession` | **still returns a session**                                     |
| same with `disableCookieCache:true`              | `null`                                                          |

The docs confirm: "revoked sessions may remain active on other devices until the cookie cache expires" (`session-management.mdx:235-249`). Updating a user refreshes secondary-storage copies (`refreshUserSessions`, `internal-adapter.ts:108-137`) but cannot touch client cookies.

---

## 2. Server-side permission-checking APIs

| API                                                | Signature                                                                                                                                                                                           | Session source                                                                          | Storage cost                                                                     | Failure mode                                                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.api.userHasPermission` (admin)               | `{ headers?, body: { permissions, userId?, role? } }` (`admin/routes.ts:1753-1901`)                                                                                                                 | if `headers` is passed: **authoritative** session (cookie cache bypassed when stateful) | with headers: 1 findSession; `body.userId` only: 1 user read; `body.role`: 0     | `{error:null, success}`; `400` without `permissions`; `401` if headers are passed but there is no session                                           |
| `auth.api.hasPermission` (org)                     | `{ headers (required), body: { permissions, organizationId? } }` (`organization/organization.ts:182-293`)                                                                                           | `sessionMiddleware` (cookie cache allowed)                                              | measured: 1 findSession + 1 member read + 1 `organizationRole` read (dynamic AC) | `{error:null, success}`; `400 NO_ACTIVE_ORGANIZATION`; `401 USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`; `400 VALIDATION_ERROR "Headers is required"` |
| `hasPermission(input, ctx)` (org, **pure export**) | `({ role, options, permissions, organizationId, useMemoryCache?, allowCreatorAllPermissions? }, ctx)`; ctx needs `context.adapter` + `logger`; `{ context: await auth.$context }` works (probe-org) | none                                                                                    | static: 0; dynamic AC: 1 findMany; `useMemoryCache`: 0                           | `boolean`                                                                                                                                           |
| `auth.api.getActiveMemberRole` (org)               | `{ headers, query?: { organizationId?, organizationSlug?, userId? } }` (`crud-members.ts:1057-1150`)                                                                                                | `sessionMiddleware`                                                                     | measured: 1 findSession + 1 member (+1 org by slug; +1 per extra `userId`)       | `{ role }`; 400 or 403                                                                                                                              |
| `auth.api.getActiveMember` (org)                   | `{ headers }`, **active org only** (`crud-members.ts:800-860`)                                                                                                                                      | `sessionMiddleware`                                                                     | 1 + 1                                                                            | member; 400                                                                                                                                         |
| `auth.api.verifyApiKey`                            | `{ body: { key, permissions?, configId? } }`, server-only (`APIKEY/routes/verify-api-key.ts:502-631`)                                                                                               | none                                                                                    | key read + usage/rate-limit writes                                               | `{valid, error, key}`; never throws for a bad key                                                                                                   |
| `role(stmts).authorize(req, connector?)`           | pure (`access/access.ts:113-167`)                                                                                                                                                                   | none                                                                                    | 0                                                                                | `{success, error?}`                                                                                                                                 |
| `auth.api.verifyJWT`                               | `{ body: { token, issuer? } }`, server-only                                                                                                                                                         | none                                                                                    | 1 `jwks` read                                                                    | `{ payload \| null }`                                                                                                                               |
| `verifyAccessTokenRequest`                         | `(ResourceRequestInput, VerifyAccessTokenRequestOptions)`                                                                                                                                           | none                                                                                    | HTTP JWKS (cached) / introspection                                               | throws `APIError` with `WWW-Authenticate` semantics                                                                                                 |

### 2.1 Semantics a guard must not get wrong

**`userHasPermission` with headers ignores `body.userId` and `body.role`.** The code is `const user = session?.user || (ctx.body.role ? {...} : null) || (ctx.body.userId ? findUserById(...) : null)` (`admin/routes.ts:1864-1883`). Probe-admin section 1:

- `A(user) headers + body.role=admin` → `success:false`
- `A(user) headers + body.userId=B(admin)` → `success:false`
- `no headers, body.userId=B(admin)` → `success:true`
- `no headers, body.role=admin` → `success:true`
- `empty headers object + body.role=admin` → **401**. Passing `headers` at all switches to session mode.

**`role` plus `userId` without headers.** The role is evaluated, and `userId` is used only for the `adminUserIds` shortcut (`routes.ts:1876-1878,1889-1894`).

**Version change.** better-auth 1.5.5 (installed in the current repo's `node_modules`) used `getSessionFromCtx`, which can be served from cookie cache (`dist/plugins/admin/routes.mjs:824`). 1.7.4 uses the authoritative read.

**Role evaluation, admin** (`admin/has-permission.ts:8-30`):

1. `adminUserIds.includes(userId)` → allow.
2. Roles are `(role || defaultRole || "user").split(",")`, with **no trimming**.
3. Access is granted if **any single role** satisfies **all** requested permissions.

**Role evaluation, org** (`organization/permission.ts:3-26`): the same split with no trim, plus a `creatorRole` shortcut that only applies when `allowCreatorAllPermissions` is set. The `hasPermission` **endpoint never sets it** (`organization.ts:278-286`), so `owner` is subject to the AC. Probe results:

- `'user, admin'` → false; `'user,admin'` → true
- org `'member, admin'` → false
- multi-role `'a,b'` asking for `{project:[create], sale:[create]}` where each role grants only one → false (grants are not unioned)
- unknown role → false

**Deprecated singular `permission` key: docs and source disagree.** The admin docs list `permission?` as valid (`DOCS/plugins/admin.mdx:593-610`). In source:

- admin endpoint → `400 "invalid permission check. no permission(s) were passed."` (`routes.ts:1859-1863`; probe)
- org endpoint → **silently** `success:false`, because `hasPermissionFn` returns false when `permissions` is undefined (`permission.ts:10`; probe-org)

**The org `hasPermission` endpoint's permission body is typed from the statements.** An unknown resource or action is a compile error when `ac` is configured (`organization.ts:182-206`; `PROBE/types/infer.ts` `@ts-expect-error` lines pass).

**The admin pure `hasPermission` is not exported.** `better-auth/plugins/admin` exports only `admin` (probe export listing). The org pure `hasPermission` and `getOrgAdapter` are exported (`organization.ts:80`; probe).

**`cacheAllRoles` is a module-level `Map` keyed by organizationId** (`permission.ts:33-38`). Every `hasPermission` call does `set` on it (`has-permission.ts:75`), so it is shared across auth instances in the process and grows with the number of orgs. `useMemoryCache: true` reads from it and skips the DB (`has-permission.ts:72-74`).

**No server API answers "does this user have role X".** Any role decorator is library logic, and it must reproduce better-auth's parsing (comma split without trim, `defaultRole`, `adminUserIds`, `creatorRole`) or it will diverge.

**Freshness policy inputs.** better-auth's `freshSessionMiddleware` compares `session.createdAt` with `sessionConfig.freshAge` (`session.ts:598-616`). A guard can read that value from `(await auth.$context).sessionConfig.freshAge` (`CORE/types/context.ts:435-440`).

**Plugin detection.** Use `(await auth.$context).hasPlugin(id)` or `getPlugin(id)` (`context.ts:312-344`), or `auth.options.plugins`, instead of duck-typing `typeof auth.api.x === "function"`.

---

## 3. Session type inference

### 3.1 The chain

**`Auth<Options>`** (`BA/types/auth.ts:8-31`):

```ts
$Infer: InferPluginTypes<Options> extends { Session: any }
  ? InferPluginTypes<Options>                      // a plugin (customSession) overrides Session
  : { Session: { session: Session<Options["session"], Options["plugins"]>;
                 user:    User<Options["user"],    Options["plugins"]> } } & InferPluginTypes<Options>;
```

**`Session` and `User`** (`CORE/db/schema/session.ts:22-30`, `CORE/db/schema/user.ts:24-32`):

```ts
Prettify<
  z.infer<typeof sessionSchema> &
    InferDBFieldsFromOptions<DBOptions> &
    InferDBFieldsFromPlugins<"session", Plugins>
>;
```

**`additionalFields`** go through `InferDBFieldsFromOptions` (`CORE/db/type.ts:107-120`).

**Plugin `schema.<model>.fields`** go through `InferDBFieldsFromPlugins` (`type.ts:142-162`). This walks a **tuple** (`Plugins extends [infer P, ...infer Rest]`) and has no array fallback. `InferPluginTypes` does have an array fallback (`BA/types/models.ts:21-26`).

**Why inline literals keep their plugin fields.** `plugins?: ([] | BetterAuthPlugin[])` (`CORE/types/init-options.ts:923`) makes TS infer array literals as tuples.

**Output rules** (`type.ts:36-106`):

- `returned: false` → removed.
- `required: false` → optional and `| null | undefined`.
- A field with a `defaultValue` keeps its key but the type includes `null | undefined`. Emitted example: `banned: boolean | null | undefined` alongside `role?: string | null | undefined` (`PROBE/decl/out/factory.d.ts`).

**Typed `getSession` return** (`BA/types/api.ts:19-51`): `PrettifyDeep<Awaited<ReturnType<E>>> | null`. With `returnHeaders: true` it becomes `{ headers, response }`.

### 3.2 Assertions verified with tsc (`PROBE/types/infer.ts`, TS 5.9.3, `strict`; `tsc exit: 0`)

```ts
export const auth = betterAuth({
  plugins: [
    admin(),
    organization({ teams: { enabled: true } }),
    anonymous(),
    apiKey(),
  ],
  user: {
    additionalFields: {
      tenantId: { type: "string", required: true, input: false },
      secretNote: { type: "string", returned: false },
    },
  },
  session: {
    additionalFields: { deviceLabel: { type: "string", required: false } },
  },
});
type S = typeof auth.$Infer.Session;
Expect<Equal<S["user"]["role"], string | null | undefined>>; // admin
Expect<Equal<S["user"]["isAnonymous"], boolean | null | undefined>>; // anonymous
Expect<Equal<S["user"]["tenantId"], string>>; // additionalFields
Expect<Equal<S["session"]["activeOrganizationId"], string | null | undefined>>; // organization
Expect<Equal<S["session"]["activeTeamId"], string | null | undefined>>; // teams
Expect<Equal<S["session"]["impersonatedBy"], string | null | undefined>>; // admin
Expect<Equal<"secretNote" extends keyof S["user"] ? true : false, false>>; // returned:false dropped
Expect<
  Equal<
    NonNullable<
      Awaited<ReturnType<typeof auth.api.getSession>>
    >["user"]["tenantId"],
    string
  >
>;

const widened: BetterAuthPlugin[] = [admin(), organization()];
const auth2 = betterAuth({ plugins: widened }); // plugin fields LOST
Expect<
  Equal<
    "role" extends keyof (typeof auth2.$Infer.Session)["user"] ? true : false,
    false
  >
>;

const options = {
  plugins: [admin(), organization()],
} satisfies BetterAuthOptions;
const auth3 = betterAuth(options); // tuple KEPT
Expect<
  Equal<
    (typeof auth3.$Infer.Session)["user"]["role"],
    string | null | undefined
  >
>;

const auth4 = betterAuth({
  plugins: [
    organization(),
    customSession(async ({ user }) => ({
      principal: { uid: user.id },
      roles: ["x"] as string[],
    })),
  ],
});
Expect<
  Equal<
    typeof auth4.$Infer.Session,
    { principal: { uid: string }; roles: string[] }
  >
>; // replaced
```

**Runtime vs type mismatch.** Normal session paths strip `returned: false` fields at runtime via `parseSessionOutput` and `parseUserOutput` (`session.ts:179-189,311-316`). The api-key mocked session does not (section 1.2), so its runtime value does not match `S`.

### 3.3 Helper types that exist

**Server side:** there are no exported `InferSession` or `InferUser` helpers (grep over `BA/types`, `CORE/types`). The documented server idiom is `typeof auth.$Infer.Session` (`DOCS/concepts/typescript.mdx:62-65`). The Hono integration docs type middleware variables the same way: `session: typeof auth.$Infer.Session | null` (`DOCS/integrations/hono.mdx:115-117`).

**Client side:** `InferSessionFromClient` and `InferUserFromClient` (`BA/client/types.ts:105-113`).

**Idioms better-auth itself uses to pass the Auth type around:**

- **Generic Auth type parameter on a factory:** `inferAdditionalFields<typeof auth>()` and `customSessionClient<typeof auth>()` (`DOCS/concepts/typescript.mdx:124-131`, `session-management.mdx:537-541`).
- **Module augmentation of a registry interface:** every plugin does `declare module "@better-auth/core" { interface BetterAuthPluginRegistry<AuthOptions, Options> { bearer: { creator: typeof bearer } } }` (`bearer/index.ts:9-15`, `APIKEY/index.ts:19-25`). `getPlugin` and `hasPlugin` return types come from it (`context.ts:312-344`).

**TypeScript config warning in the docs:** strict mode is required, and inference can "exceed maximum length the compiler will serialize" with `declaration` or `composite` (`typescript.mdx:36-38`).

### 3.4 Accepting the auth instance while keeping precision (tsc-verified)

```ts
export type SessionOf<A> = A extends { $Infer: { Session: infer X } }
  ? X
  : never;

function acceptsAuth<A extends Auth<any>>(a: A): SessionOf<A>; // precise (== S)
type MinimalAuth = {
  api: { getSession: (ctx: { headers: Headers }) => Promise<unknown> };
  $Infer: { Session: unknown };
};
function acceptsMinimal<A extends MinimalAuth>(a: A): SessionOf<A>; // precise for auth AND auth4 (customSession)
```

A structural minimum avoids depending on the whole `Auth<any>` type from `better-auth`.

### 3.5 The reference library's typing

- `export type Auth = any` (`REF/src/auth-module.ts:74`). Every `auth.api` call in the guard is then untyped (`auth-guard.ts:285, 367, 450` cast to `any`).
- `UserSession<T = unknown>` resolves `T["$Infer"]["Session"]` when given `typeof auth`. Its fallback hand-writes `role?: string | string[]` and `activeOrganizationId?: string` (`auth-guard.ts:44-55`). That does not match the real inferred `string | null | undefined` and implies arrays, which better-auth never stores.
- `AuthService<T extends { api: T["api"] } = Auth>` (`REF/src/auth-service.ts:12`) is the generic-type-parameter pattern.

### 3.6 NestJS param decorator: three ways to expose the type (tsc-verified with `@nestjs/common@12.0.1`)

**Constraint.** `createParamDecorator<FactoryData, FactoryOutput>(...)` returns `(...dataOrPipes) => ParameterDecorator` (`node_modules/@nestjs/common/decorators/http/create-route-param-metadata.decorator.d.ts:14`). `FactoryOutput` never reaches the parameter's type. `PROBE/types/decorators.ts` class `A.wrong(@Session() s: number)` **compiles**. So the library can only offer a type to annotate with.

Files: `PROBE/types/fake-lib/index.ts` (library stand-in), `PROBE/types/decorators.ts` (consumer). tsc exit 0.

```ts
// (a) generic helper; the user writes typeof auth at each site
right(@Session() s: SessionOf<typeof auth>) { return s.user.role; }

// (b) module augmentation (the better-auth registry idiom); non-generic alias afterwards
// library:  export interface Register {}
//           type RegisteredAuth = Register extends { auth: infer A } ? A : undefined;
//           export type AuthSession = RegisteredAuth extends undefined ? Fallback : SessionOf<RegisteredAuth>;
declare module "./fake-lib/index.js" { interface Register { auth: typeof auth } }
m(@Session() s: AuthSession) { return s.session.activeOrganizationId; }   // Expect<Equal<AuthSession, S>> passes

// (c) typed factory; types travel on the returned object
const d = createAuthDecorators<typeof auth>();      // { Session, $types: { Session: SessionOf<A> } }
m(@d.Session() s: typeof d.$types.Session) { return s.user.tenantId; }
```

**Declaration emit** (`PROBE/decl/`, `declaration: true`, admin + organization; no TS7056 error):

- Factory: the consumer's `.d.ts` inlines the fully expanded session type (`factory.d.ts` 1293 bytes).
- Augmentation: emits only a `typeof auth` reference (`augment.d.ts` 138 bytes).
- The user's own `auth.d.ts` is 55,574 bytes either way.

---

## 4. The reference library (`REF/src/decorators.ts`, `REF/src/auth-guard.ts`)

### 4.1 What each decorator does

All metadata keys are plain strings.

| Decorator                                                       | Metadata key                                     | Guard behavior                                                                                                                              | Delegates to better-auth?                     |
| --------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `@AllowAnonymous()` / `@Public()`                               | `"PUBLIC"` (`decorators.ts:22-23,160`)           | returns true, **after** already calling `getSession` (`auth-guard.ts:142-156`)                                                              | —                                             |
| `@OptionalAuth()` / `@Optional()`                               | `"OPTIONAL"` (`:30-31,165`)                      | passes if there is no session (`:158-163`)                                                                                                  | —                                             |
| `@RequireActiveOrg()`                                           | `"REQUIRE_ACTIVE_ORG"` (`:37-38`)                | checks that `session.session.activeOrganizationId` is present, else 403 (`auth-guard.ts:172-181`)                                           | no; presence only                             |
| `@Roles(string[])`                                              | `"ROLES"` (`:53-54`)                             | `session.user.role.split(",").some(r => required.includes(r.trim()))` (`auth-guard.ts:257-272,309-314`)                                     | **no; reimplemented**                         |
| `@OrgRoles(string[])`                                           | `"ORG_ROLES"` plus `RequireActiveOrg` (`:69-70`) | `auth.api.getActiveMemberRole({headers})`, falling back to `getActiveMember`, then the same trim-matching (`auth-guard.ts:280-300,325-344`) | fetches the role, matches it itself           |
| `@UserHasPermission({permission\|permissions, userId?, role?})` | `"USER_HAS_PERMISSION"` (`:113-122`)             | `auth.api.userHasPermission({ body:{ userId: opt.userId ?? session.user.id, role?, permissions }, headers })` (`auth-guard.ts:355-423`)     | yes, but the options are ineffective (4.2 #1) |
| `@MemberHasPermission({permissions})`                           | `"MEMBER_HAS_PERMISSION"` (`:148-155`)           | needs an active org, then `auth.api.hasPermission({ body:{ permissions }, headers })` (`auth-guard.ts:435-488`)                             | yes; active org only, no `organizationId`     |
| `@Session()`                                                    | —                                                | `createParamDecorator(... => request.session)` (`:172-178`)                                                                                 | —                                             |

The guard looks up each key with `getAllAndOverride` (handler over class). There is no AND/OR composition, and the policy list is hard-coded in `canActivate`, so adding a policy means editing the guard (Open-Closed is violated).

### 4.2 Pitfalls, with evidence

1. **`@UserHasPermission({ role, userId })` are silently ignored.** The guard always passes `headers`, so better-auth uses the session user (section 2.1; probe-admin section 1). The README claims "`role` (server-only): Check permissions for a specific role" and "`userId` (optional): Check permissions for a specific user" (`REF/README.md:350-352`). The ref's own test `role-permission-check` (`REF/tests/e2e/user-has-permission.e2e.test.ts:100-106, 398-451`) passes only because the session user's role happens to match. A `projectEditor` user is refused even though the decorator says `role: "projectAdmin"`.
2. **Role parsing diverges from better-auth.** The ref trims (`r.trim()`, `auth-guard.ts:268`); better-auth does not (`admin/has-permission.ts:21`, `organization/permission.ts:12`). With a stored role of `"user, admin"`, `@Roles(['admin'])` allows but `userHasPermission` denies (probe-admin section 2). The ref's type also admits `string[]` (`auth-guard.ts:50`), which better-auth never stores.
3. **`@Roles` ignores `adminUserIds` and `defaultRole`.** A user listed in `adminUserIds` with role `user` gets `success:true` from `userHasPermission`, but the session role (what `@Roles` sees) is `user` (probe-admin section 3). A user with `role = null` is treated as `defaultRole` by better-auth but fails `@Roles(['user'])` in the ref (`matchesRequiredRole` returns false when the role is missing, `auth-guard.ts:261`).
4. **Stale cookie cache.** `@Roles` reads `session.user.role` from `getSession`, which the cookie cache can serve. Demotions, bans and revocations take up to `cookieCache.maxAge` to be seen (section 1.3). better-auth's own admin authorization bypasses the cache (`routes.ts:33-46`).
5. **`getSession` runs before the public check** (`auth-guard.ts:142-156`):
   - (a) Every `@AllowAnonymous()` request pays a session lookup, plus JWT signing if the jwt plugin is installed (section 1.1).
   - (b) With `enableSessionForAPIKeys`, a bad `x-api-key` on a **public** route makes `getSession` throw, and the public route fails. Nest's `BaseExceptionFilter` duck-types better-auth's `APIError` as an http-error (`statusCode` + `message`) and replies with its status (401, 403 or 429), logging it as an error. It drops the error `code` (`node_modules/@nestjs/core/exceptions/base-exception-filter.js:13-17,34-66`; APIError shape `{statusCode:403,status:'FORBIDDEN',message,body:{code}}`, probe). The GraphQL, WS and RPC paths are **UNVERIFIED**.
   - (c) It also consumes API-key rate limit on public routes.
6. **Set-Cookie from the guard's `getSession` is never forwarded.** There is no `returnHeaders` anywhere in `REF/src` (grep). Session refresh and cookie-cache cookies are lost on requests that only reach Nest routes (probe-setcookie).
7. **Missing or stale active org.**
   - `@OrgRoles` and `@MemberHasPermission` can only use the session's active org. They cannot target `/orgs/:orgId/...` even though `hasPermission` accepts `organizationId` and `getActiveMemberRole` accepts `organizationId` / `organizationSlug`.
   - Mocked API-key sessions never have an active org (probe-principals), so org decorators always return 403 for API-key callers.
   - `@RequireActiveOrg()` alone passes for **removed** members whose session still carries the old ID (probe-principals).
8. **Duplicate session resolution per request.** Every org or permission decorator calls another `auth.api.*` endpoint, which resolves the session again (section 1.0). `userHasPermission` with headers is an **authoritative** read (probe-admin: `findSession calls inside userHasPermission: 1`). `hasPermission` and `getActiveMemberRole` each measured 1 findSession + 1 member read (probe-org).
9. **Errors become 403.** `checkOrgRole`, `checkUserPermission` and `checkMemberPermission` catch everything, `console.error`, and return false (`auth-guard.ts:338-343, 413-422, 478-487`). Misconfiguration (plugin missing: `typeof authApi.x !== "function"` → `console.error` + false, `auth-guard.ts:370-375, 453-458`), DB outages and `NO_ACTIVE_ORGANIZATION` all look like "forbidden".
10. **Metadata keys are bare strings** (`"PUBLIC"`, `"ROLES"`, ...). They can collide with other libraries' or apps' `SetMetadata('ROLES', ...)`. NestJS's `Reflector.createDecorator` generates unique keys (default `uid(21)`) with typed values (`@nestjs/core@11.1.17 services/reflector.service.d.ts:5-39`).
11. **`request.session` and `request.user` as storage slots** (`auth-guard.ts:148-149`) are the same slots express-session / @fastify/session and passport use (ecosystem convention; **UNVERIFIED** in-session).
12. **Naming.** `@AllowAnonymous` means "public route", which is easy to confuse with the better-auth anonymous plugin (`user.isAnonymous`).
13. **customSession breaks the guard.** It assumes `session.user` / `session.session` exist (`auth-guard.ts:149, 177, 313`). With customSession, `getSession` may return a different shape (probe-principals).
14. **API-key session leaks.** `request.session` for API-key callers contains the raw key (`session.token`) and `returned:false` user fields (probe-apikey-returned). Returning `@Session()` from a controller exposes them.

The current repo (`/Users/thilllon/git/nestjs-slightly-better-auth/src/auth-guard.ts`) is an older copy with the same `Roles`/`OrgRoles` logic (lines 176-196, 208-288). It also calls `require('graphql')` and `require('@nestjs/websockets')` inside a `"type": "module"` package (lines 19, 55). Whether the tsdown ESM output shims `require` is **UNVERIFIED**.

### 4.3 Reimplementation vs delegation

| Concern                   | better-auth API that already does it                                                            | Ref                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| admin role and permission | `userHasPermission` (handles `adminUserIds`, `defaultRole`, custom `roles`, authoritative read) | reimplements role matching; uses `userHasPermission` with ineffective options |
| org role                  | no "has role" API; `getActiveMemberRole` / `hasPermission`                                      | reimplements matching                                                         |
| org permission            | `hasPermission` (+ `organizationId`)                                                            | delegates, active org only                                                    |
| API-key scopes            | `verifyApiKey({permissions})` / `role(key.permissions).authorize()`                             | not supported                                                                 |
| JWT / OAuth scopes        | `verifyAccessTokenRequest({requiredScopes})`                                                    | not supported                                                                 |

---

## 5. Implications for an Open-Closed authorization-policy extension point

These are constraints the facts impose. They are not a design.

### 5.1 Two separate extension points: authentication and authorization

Principal sources differ in API, shape and error semantics (section 1.1):

- sessions: cookie, bearer, api-key-mock (and customSession-shaped)
- JWT claims
- OAuth / MCP access-token claims
- verified API-key records

Adding a source must not require editing the policies, and the other way round. That implies:

- a **principal resolver** contract, `(ctx) => Promise<Principal | null>`, producing a **discriminated union** (for example `kind: "session" | "jwt" | "oauth-access-token" | "api-key"`) so policies can narrow;
- a separate **policy** contract that consumes a principal.

### 5.2 Minimal policy interface the facts support

Illustrative only:

```ts
interface AuthorizationPolicy<Requirement, P extends Principal = Principal> {
  readonly kind: string | symbol; // matches the requirement metadata
  supports?(principal: Principal): principal is P; // e.g. only "session" principals
  evaluate(
    req: Requirement,
    principal: P,
    ctx: AuthzContext,
  ): Promise<Decision>;
}
type Decision =
  | { effect: "allow" }
  | {
      effect: "deny";
      status: 401 | 403;
      code?: string;
      message?: string;
      challenge?: string; /* WWW-Authenticate value (OAuth/MCP insufficient_scope) */
    };
```

Why each part:

- **`Promise<Decision>` returned, not thrown.** Checks are async and may hit the DB. better-auth mixes three failure styles:
  - boolean results (`{success:false}`)
  - thrown `APIError` (`NO_ACTIVE_ORGANIZATION`, `USER_IS_NOT_A_MEMBER...`)
  - `{valid:false}` (`verifyApiKey`)

  Policies must normalize these (section 2). Infrastructure errors (5xx) should propagate as errors, not be swallowed into 403 (section 4.2 #9).

- **`challenge`.** OAuth and MCP resource servers must return RFC 6750 `WWW-Authenticate` challenges (`CORE/oauth2/verify.ts:527-552`; `DOCS/plugins/mcp.mdx:223`). A bare 403 cannot express that.
- **`status: 401 | 403`.** better-auth itself returns 401 for "not a member" (probe-org), so policies need control over the mapping.

### 5.3 `AuthzContext` must be transport-neutral and memoized per request

- **Transport-neutral.** It needs `headers: Headers` (every `auth.api` call needs it; org `hasPermission` _requires_ it, section 2), plus request-derived inputs such as route params, GraphQL args or a header for the org ID (section 1.2, organization). Raw `ExecutionContext` access can be an escape hatch.
- **Memoized.** One per-request cache (for example keyed on the request object) so that:
  - the session is resolved **once**;
  - `verifyApiKey` runs **at most once**, because it consumes quota (section 1.2, api-key);
  - org member lookups are shared between policies.

  better-auth provides no way to hand a resolved session to a later `auth.api` call (section 1.0), so this dedup belongs to the integration.

### 5.4 Requirements declared via typed metadata, dispatched by registry

- Declare requirements with `Reflector.createDecorator<Req>()`: unique keys and typed `reflector.get` (section 4.2 #10).
- Dispatch to a policy through a registry keyed by `kind`, populated via DI (a multi-provider or discovery). A new policy is then a new provider plus a new decorator; core does not change.
- Decide composition semantics explicitly: `getAllAndMerge` (class AND method) vs `getAllAndOverride` (the ref overrides).

### 5.5 Built-in policies should be thin adapters over better-auth

| Policy                    | Delegate to                                                                                                                                                                                                                   | Cost / freshness trade-off                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| system (admin) permission | `auth.api.userHasPermission({ body: { userId: principal.user.id, permissions } })` **without headers**                                                                                                                        | 1 user read, fresh role, handles `adminUserIds`/`defaultRole`; avoids a second session read. With `headers`: authoritative session read (+1). With `{ userId, role: principal.user.role }`: 0 DB but the role may be cookie-cache stale |
| org permission            | `auth.api.hasPermission({ headers, body: { organizationId, permissions } })`                                                                                                                                                  | 1 session (can use cookie cache) + 1 member (+1 dynamic roles). Or the exported pure `hasPermission(input, { context: await auth.$context })` once the member role is known (0-1 DB; needs `getPlugin("organization").options`)         |
| org context               | an **org-ID resolver** extension (route param / header / `session.activeOrganizationId`)                                                                                                                                      | the active org can be absent or stale; the docs endorse client-side active org (section 1.2)                                                                                                                                            |
| API-key scopes            | the api-key principal resolver calls `verifyApiKey` **once** and keeps `key.permissions`; the policy evaluates `role(key.permissions).authorize(required)` (the same primitive better-auth uses, `verify-api-key.ts:126-128`) | avoids the documented double increment (`advanced.mdx:563-566`); user lookup would need `(await auth.$context).internalAdapter.findUserById`                                                                                            |
| JWT / OAuth scopes        | `verifyAccessTokenRequest(..., { requiredScopes })` at resolve time, or check the `scope` claim; emit `createInsufficientScopeError`                                                                                          | JWKS over HTTP by URL (cached 5 min); in-process needs `verifyJwsAccessToken` with a function source (section 1.2)                                                                                                                      |
| roles                     | no better-auth API exists; if offered, it must mirror comma split without trim, `defaultRole`, `adminUserIds`, `creatorRole`, or be documented as different                                                                   | section 2.1                                                                                                                                                                                                                             |
| freshness / authoritative | request `getSession({ query: { disableCookieCache: true } })` **only when** `auth.options.database \|\| auth.options.secondaryStorage` (mirrors `isStateful`); `freshAge` from `$context.sessionConfig`                       | stateless mode must not bypass the cookie (`session.ts:520-539`)                                                                                                                                                                        |

### 5.6 Capability checks at bootstrap

Policies should declare which plugin they need (`"admin"`, `"organization"`, `"api-key"`, `"jwt"`). Fail module initialization when it is missing, using `auth.options.plugins` or `$context.hasPlugin`. That is better than the ref's per-request `typeof ... === "function"` + `console.error` + 403 (section 4.2 #9).

### 5.7 The session principal resolver must

- call `getSession` with `returnHeaders: true` and hand `Set-Cookie` (and optionally `set-auth-token` / `set-auth-jwt`) to the **HTTP platform adapter** for forwarding. There is no cookie channel on WS or GraphQL subscriptions, so the platform adapter must be able to decline;
- tolerate customSession: either require `SessionOf<A> extends { user: { id: string } }` at the type level, or accept a user-supplied normalizer;
- decide whether public routes skip resolution (saves DB and avoids api-key throws, section 4.2 #5) while `@OptionalAuth` resolves;
- keep bearer, api-key and jwt behavior in better-auth's hooks rather than re-parsing headers in the resolver, since the hooks already run inside `auth.api.getSession`;
- account for the api-key mock session exposing the raw key and `returned:false` fields when storing or serializing the principal.

### 5.8 Typing of the extension point

- Policies and resolvers need the principal type. `SessionOf<A>` plus a registry (augmentation) or a generic `A` (factory) gives typed principals without `any` (section 3.6).
- Permission requirements can be typed from the user's statements the same way better-auth types them. `userHasPermission` derives `PermissionType` from `O["ac"] extends AccessControl<infer S>` (`admin/routes.ts:1788-1802`), and the org endpoint does the same (`organization.ts:182-195`). Section 3.2 verified that bad resources and actions fail to compile.

**ESM/CJS note** (affects how policies import better-auth helpers such as `role`):

- `better-auth` 1.7.4 and `@better-auth/api-key` 1.7.4 publish ESM only: `"type":"module"`, exports `{types, default: *.mjs}`, no `.cjs` (probe: `node -e require("./node_modules/better-auth/package.json")`).
- `@nestjs/common@12.0.1` (npm `latest`) is also `"type":"module"`.
- On Node 22.22.0, `require("better-auth")`, `require("better-auth/plugins/access")`, `require("better-auth/plugins/organization")`, `require("better-auth/node")` and `require("@nestjs/common")` all worked through require(esm) (`PROBE/req-test.cjs`).
- Node 20.x behavior is **UNVERIFIED** in this session.
- Delegating through the user's `auth` instance (`auth.api.*`, `auth.$context`) keeps runtime imports of better-auth in core small.

---

## 6. Open questions and UNVERIFIED items

- Behavior of each individual sign-in plugin (two-factor, passkey, sso, siwe, ...) with the guard: expected to be an ordinary session, not individually verified.
- Whether direct `auth.api.*` calls bypass the IP rate limiter at runtime (inferred from `BA/api/index.ts:297-312`).
- How GraphQL, WS and RPC surface a thrown better-auth `APIError`.
- `disableCookieCache: true` in a stateless (no-DB) deployment: inferred to log the user out (`findSession` finds nothing), not run.
- Node 20.x `require(esm)` for the CJS build.
- Whether module augmentation causes circularity errors (TS7022) when the user's `auth.ts` itself imports types that depend on `Register`. Not tested.

---

## Appendix A: probe files and key output lines

| File                                                    | What it shows                                                                                   | Key output                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PROBE/probe-admin.mjs`                                 | `userHasPermission` semantics, role parsing, `adminUserIds`, cookie-cache staleness, revocation | `A(user) headers + body.role=admin ... success:false`; `B role='user, admin' (space) ... success:false`; `C in adminUserIds ... success:true` / `C session.user.role ... user`; `A role after DB promote, default getSession: user findSession calls: 0`; `after revoke, default getSession returns session? true` |
| `PROBE/probe-org.mjs`                                   | org `hasPermission`, dynamic AC, pure fn, cost                                                  | `M no active org ... 400 NO_ACTIVE_ORGANIZATION`; `storage calls: {"findSession":1,"findOne":2,"findMany":1}`; `deprecated singular permission key ... success:false`; `role 'member, admin' (space) ... false`                                                                                                    |
| `PROBE/probe-principals.mjs`                            | api-key mock, bearer, jwt, customSession, stale active org                                      | `session.token === raw key: true`; `short/invalid x-api-key: THREW ... FORBIDDEN`; `rate limit hit via getSession: iteration 8 ... 429`; `getSession with Bearer <jwt> -> null`; `custom getSession result: {"principal":...}`; `removed M session.activeOrganizationId: <org id>`                                 |
| `PROBE/probe-apikey-returned.mjs`                       | `returned:false` leak                                                                           | `cookie session has secretNote: false \| api-key session has secretNote: true TOP-SECRET`                                                                                                                                                                                                                          |
| `PROBE/probe-jwt-cost.mjs`                              | jwt after-hook cost                                                                             | `disableSettingJwtHeader=false: ... "findMany":21`; `=true: ... "findMany":0`                                                                                                                                                                                                                                      |
| `PROBE/probe-bearer-cost.mjs`                           | foreign bearer tokens hit storage                                                               | `requireSignature=false ... findSession calls: 1`; `=true ... 0`                                                                                                                                                                                                                                                   |
| `PROBE/probe-setcookie.mjs`                             | guard-side Set-Cookie                                                                           | `set-cookie names: ['better-auth.session_token','better-auth.session_data']`                                                                                                                                                                                                                                       |
| `PROBE/probe-multirole.mjs`                             | no union across roles                                                                           | `role='a,b': project+sale -> false \| sale only -> true`                                                                                                                                                                                                                                                           |
| `PROBE/types/infer.ts`                                  | `$Infer` flow, tuple vs array, customSession, `SessionOf`, statement-typed permissions          | `tsc exit: 0`                                                                                                                                                                                                                                                                                                      |
| `PROBE/types/decorators.ts` + `types/fake-lib/index.ts` | three typing patterns; the param decorator does not enforce the type                            | `tsc exit: 0`                                                                                                                                                                                                                                                                                                      |
| `PROBE/decl/*`                                          | declaration emit: factory vs augmentation                                                       | `factory.d.ts` 1293 B (inlined type), `augment.d.ts` 138 B                                                                                                                                                                                                                                                         |
| `PROBE/req-test.cjs`                                    | require(esm) on Node 22.22                                                                      | `require(esm) ok: function function function function function`                                                                                                                                                                                                                                                    |
