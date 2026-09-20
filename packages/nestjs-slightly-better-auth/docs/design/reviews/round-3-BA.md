# Round 3 review: BA (better-auth fidelity)

Input: `design-v3.md`. Verdict: **reject** (0 blockers, 3 major, 2 minor).

Experiments: `scratchpad/tmp-r3-review-BA/exp/` (scripts and captured `.out` files). Each ran against better-auth
**1.7.4** with @better-auth/api-key 1.7.4 (`tmp-r3-review-BA/v174`, npm) and **1.7.0** with @better-auth/api-key 1.7.0
(`tmp-r3-review-BA/pnpm170`, pnpm 10.33). The 1.7.0 runs use pnpm on purpose: an npm install of `better-auth@1.7.0` +
`@better-auth/api-key@1.7.0` resolves the api-key plugin and the adapters against `@better-auth/core@1.7.5` (their
`@better-auth/core: ^1.7.0` peer), while pnpm resolves one `@better-auth/core@1.7.0`, which is the tree the design's
floor job (pnpm, R5) gets. Postgres runs use PGlite 0.4 with better-auth's kysely adapter and `getMigrations`.
Every experiment gave identical results on both versions (timestamps aside).

## Summary

v3 closes every round-2 BA finding for the failure scenario it reported, and the new mechanisms hold up against the
1.7.x source:

- **Endpoint-produced sessions (ADR-54).** `runBeforeHooks` returns the first non-`{ context }` object and
  `dispatchAuthEndpoint` returns it before `runAfterHooks` runs (`BA/api/dispatch.ts:137-220, 373-383`), so the
  observer never records the api-key mock (`AK/index.ts:242-268`) or any other short-circuit, and records the final
  `returned` (`dispatch.ts:222-262, 421-436`). I found no first-party plugin whose after-hook replaces `/get-session`'s
  result (jwt, bearer, multi-session, custom-session, one-time-token, last-login-method, anonymous, oauth-proxy,
  oauth-popup, expo, sso, oauth-provider checked), so `W_PLUGIN_NOT_LAST` remains the right severity for that case.
- **Short-circuit headers, DB update accumulation, IP header vs `trustedProxies`, `@AfterAuth` scope, drift CI**: fixed
  as proposed.
- **The origin rules** still mirror `validateOrigin`/`validateFormCsrf` exactly at 1.7.4, and the only 1.7.0 difference
  is the `Origin: null` inference already recorded as LEAD-V33. The init-time `ctx.trustedOrigins` already expands a
  dynamic config's `allowedHosts` (`BA/context/create-context.ts:192, 280`; `BA/context/helpers.ts:108-140`), so the
  kernel's trusted set matches the router's for dynamic configs too.
- **Surfaces at the floor.** Every runtime specifier the plugin and `./api-key` import, and every type the declarations
  import from `better-auth`, exists at 1.7.0 (checked by import and by `tsc`).

What fails is new code that reads better-auth's semantics too broadly:

- **Major.**
  - ADR-59's safety net treats **every** 401 as a possibly swallowed session read. Several better-auth endpoints use
    401 for authorization denials of an authenticated caller. A third-party policy's "not a member" therefore
    becomes an ERROR-logged 5xx (BA-r3-01).
  - The admin policy passes `user.role` from the **`customSession` shape**. better-auth's `adminMiddleware` evaluates
    the base session's role. A shape that normalizes roles to an array turns every `@RequirePermission` route into a
    500, and a shape that carries an effective role grants what `listUsers` denies (BA-r3-02).
  - The API-key outage probe keys its no-op statements on a **random `id`**. With better-auth's
    `generateId: "serial"` a healthy Postgres rejects that statement, so every invalid, revoked or unknown key answers
    5xx (BA-r3-03).
- **Minor.**
  - The BA-r2-05 fix sends `verifyApiKey` only `Host`. Behind a proxy that better-auth is told to trust
    (`trustedProxyHeaders`), a dynamic `baseURL` resolves from `X-Forwarded-Host`, so every key request answers 500
    (BA-r3-04).
  - In `customSession` apps the ADR-59 re-read is itself swallowed, so the round-2 outage scenario answers 401, not
    5xx, while RK2 and §15.4 say policy paths are fixed (BA-r3-05).

| Id       | Sev   | Title                                                                                                               |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| BA-r3-01 | major | Z2/ADR-59 turn better-auth's coded 401 denials into 5xx for authenticated principals                                |
| BA-r3-02 | major | Admin policy judges the `customSession` shape's `user.role`, not the role `adminMiddleware` evaluates               |
| BA-r3-03 | major | API-key outage probe on a random `id` throws on healthy stores with `generateId: "serial"`: invalid keys answer 5xx |
| BA-r3-04 | minor | `apiKeyPrincipal()` sends only `Host`: dynamic `baseURL` behind a trusted proxy answers 500 for every key           |
| BA-r3-05 | minor | In `customSession` apps the ADR-59 re-read swallows the outage too: policy outages still answer 401                 |

## Prior findings (round 2, BA)

| Id       | Status            | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA-r2-06 | resolved          | The key-session scenario now ends in `absent` → 401 on every transport: the api-key hook short-circuits `/get-session` (`AK/index.ts:262-264`), short-circuits skip after-hooks (`dispatch.ts:373-383`), so `producedByEndpoint` is false; authoritative plans never use connection entries. `'role'`/`'cached'` modes are gone. On stateless deployments better-auth's `getAuthoritativeSessionFromCtx` falls back to `getSessionFromCtx` and would accept a hook-set `ctx.context.session` (`BA/api/routes/session.ts:527-539`); the kernel is stricter there, which is harmless (no store, so no api-key plugin).                                                                                                                                                                                           |
| BA-r2-01 | resolved          | `result.headers?.getSetCookie() ?? []`, `GetSessionWithHeaders`, `S-short-circuit-session`, and `Z-apikey-quota-per-request` over HTTP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| BA-r2-03 | resolved          | For the reported setup (no `customSession`) the re-read throws `FAILED_TO_GET_SESSION` during the outage → 5xx (EXP-4, first block). Two follow-ups: the fix is broader than the scenario, so it misclassifies coded 401 denials (BA-r3-01), and it does not reach `customSession` apps (BA-r3-05).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| BA-r2-05 | resolved          | Admin policy and `rpcTransport()` declare host-less calls, and B20 fails boot. `apiKeyPrincipal()` forwards `Host`. The reported scenario (no proxy headers) is closed; the trusted-proxy variant is BA-r3-04.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| BA-r2-02 | resolved          | The dispatcher accumulates only returned data; `create` still chains. That matches `BA/db/with-hooks.ts:40-66, 115-141`, and LEAD-EXP-10 covers a modifying plugin in front.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| BA-r2-04 | resolved          | §6.8 documents the re-application; B18 warns for `trustedProxies` + plugin header + `proxyTrust()` `'none'`; item 6 and `W_PROXY_UNTRUSTED` corrected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| BA-r2-07 | resolved          | §10.4 scopes `@AfterAuth('/get-session')` rules to Nest routes and names what holds everywhere; `LIB-hook-bearer-client` pins it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| BA-r2-08 | rebuttal-accepted | Refs now always send a validated ID, so the "slug sent as ID" denial and the missing `customSession` ID are both gone (`getActiveMember` returns `organizationId`, `crud-members.ts:800-862`). Declining `fromSlugParam` is acceptable, but ADR-63's reason is only half right: `getFullOrganization` does clear the active organization for non-members (`crud-org.ts:797-806`), yet `listOrganizations` (`crud-org.ts:964-999`) is a side-effect-free, session-scoped lookup that returns id and slug, and `getActiveMemberRole` accepts `organizationSlug` natively (`crud-members.ts:1083-1110`). The `:orgSlug` hint should map the slug through `auth.api.listOrganizations({ headers })` rather than "the application's own organization table", which reads better-auth's table past its adapter (R1). |
| BA-r2-09 | resolved          | The nightly job resolves the newest version inside `>=1.7.0 <2` including pre-releases, plus `main`; RK1, RK4, RK20 updated.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

No earlier BA finding regressed: BA-r1-01 through BA-r1-11 still hold as fixed in v2. BA-r1-04's result table still
covers every code the 1.7.4 verification path produces (`AK/routes/verify-api-key.ts:51-373`).

## New findings

### BA-r3-01 (major): Z2/ADR-59 re-classify every 401 as a possibly swallowed session read, so better-auth's coded 401 denials become 5xx for authenticated principals

- **Section:** §4.4.2 Z2, §8.1 (Errors), §7.7 row "A policy's better-auth call answers 401", ADR-59, §17 Q22, §15.4
  ("Authorization infrastructure failures are now 5xx").
- **Failure scenario:**
  1. A team writes a third-party policy the way §8.1 describes the built-ins: a thin adapter that calls
     `ctx.auth.api.hasPermission({ headers: ctx.headers, body: { organizationId: <team's org>, permissions } })`, maps
     `success: false` to `deny`, and "lets every other `APIError` escape to the net". It could equally call
     `listInvitations`, `removeMember`, `linkSocialAccount` or `createApiKey`.
  2. An authenticated user who is **not** a member of that organization calls the route. Storage is healthy.
  3. better-auth answers 401 `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` (`BA/plugins/organization/organization.ts:272-276`).
  4. Z2 re-resolves the principal authoritatively. The session exists, so the answer is "authenticated", and the net
     returns `BetterAuthInfrastructureError`: 5xx, logged at ERROR with the `APIError` as cause.

  Any authenticated caller can produce ERROR-logged 5xx at will by naming organizations they do not belong to. S6 is
  inverted: a denial surfaces as an infrastructure failure. Clients retry instead of showing "no access", and alerting
  fires. v2's net answered 403 here; the regression comes from generalizing BA-r2-03's fix from "the session
  middleware's 401" to "any 401".

  better-auth uses 401 with a specific code for authorization or credential outcomes of an **authenticated** caller in
  several places:
  - `YOU_ARE_NOT_ALLOWED_TO_DELETE_THIS_MEMBER` (`crud-members.ts:410-413`);
  - `LINKING_NOT_ALLOWED` and `LINKING_DIFFERENT_EMAILS_NOT_ALLOWED` (`BA/api/routes/account.ts:375-389`);
  - `INVALID_TOKEN` (`account.ts:288`);
  - `USER_BANNED` (`AK/routes/delete-api-key.ts:93-94`);
  - `KEY_DISABLED` and `KEY_EXPIRED` raised by the api-key session hook through `validateApiKey` (`AK/index.ts:204-211`; `AK/routes/verify-api-key.ts:73-112`).

  The shapes that mean "the session read came back empty" are different: `code: 'UNAUTHORIZED'`
  (`session.ts:547-603`), or no code at all (`APIError.fromStatus('UNAUTHORIZED')`, body `undefined`, e.g.
  `crud-org.ts:104-114, 427`, `admin/routes.ts:36`).

  A second path to the same outcome needs no coded 401. The principal comes from a non-session source the route
  accepts, such as the §4.3.4 OAuth access-token source. A third-party policy calls a session-middleware endpoint
  with the request headers, which carry no session, and gets 401 `UNAUTHORIZED`. The re-resolution authenticates the
  OAuth principal again, so the net answers 5xx for a request that simply has no better-auth session.

- **Evidence:** EXP `exp2-policy-401-and-custom-role.mjs` part (a), identical on 1.7.4 and 1.7.0 (`exp2.v174.out`,
  `exp2.v170.out`):
  ```
  third-party policy: hasPermission({ organizationId: Acme }) as non-member -> APIError 401 code=USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION
    Z2 re-resolution: authenticated=true -> design answer: 5xx BetterAuthInfrastructureError (logged ERROR)
  ```
  `APIError.fromStatus('UNAUTHORIZED')` and `new APIError('UNAUTHORIZED')` have `body === undefined` (checked at runtime
  on 1.7.4). The design's own built-in org policy maps this exact code to 403 (§8.3) because it knows the code, which
  shows the net's default is wrong for anyone who does not.
- **Suggested fix:** Keep ADR-59's re-read, but only let it produce 5xx where the 401 can actually be a swallowed read:
  - The re-classification applies only to the generic shapes: `body.code` absent or `'UNAUTHORIZED'`. Any other 401
    `code` for an authenticated principal is a denial carrying better-auth's code as `reason`. It is 403 by default,
    as v2 and the built-in org policy answer; better-auth's 401 is the alternative (see the proposed user decision).
  - The "still authenticated → 5xx" branch applies only when the re-resolved principal comes from a source whose
    identity is better-auth's session read. Mark this as data on the source, for example
    `PrincipalSource.sessionBacked: true` set by `sessionPrincipal()`, so core still names no kind. For any other
    source, a generic 401 is a denial: 401 `UNAUTHENTICATED`, with better-auth's code as `reason`.
  - Add `Z-apierror-mapping` rows: a policy that calls `hasPermission` for a non-member (expect 403, not 5xx), and a
    non-session principal whose policy calls a session-middleware endpoint (expect 401, not 5xx). Correct §15.4 and
    Q22's wording to "the session middleware's generic 401".

### BA-r3-02 (major): The admin policy judges the `customSession` shape's `user.role`, while better-auth's `adminMiddleware` evaluates the base session's role

- **Section:** §8.3 admin row ("`userHasPermission({ body: { userId, role: session.user.role, permissions } })`",
  "That is better-auth's `adminMiddleware`, at one read"), §11.5 ("The admin policy passes `session.user.role` when the
  shape has it"), §2.2.15 `PermissionOptions` doc, ADR-36, ADR-54, §17 Q21, §15.3 `hasRole` recipe.
- **Failure scenario:** The session source stores whatever `getSession` returned, and with `customSession` that is the
  callback's shape (`BA/plugins/custom-session/index.ts:100-126`). better-auth's own admin evaluation never sees that
  shape. `adminMiddleware` → `getAuthoritativeSessionFromCtx` → `getSessionFromCtx` calls the core `getSession()` as a
  plain function (`BA/api/routes/session.ts:453-518, 527-539`; `BA/plugins/admin/routes.ts:33-45`), and
  `userHasPermission` with a session uses `session.user` from that base read (`admin/routes.ts:1864-1896`). Three
  ordinary `customSession` callbacks break the claimed parity:
  1. **Roles as an array for the frontend:** `({ user: { ...user, role: user.role.split(',') }, session })`. The
     policy sends `role: ['admin']`. `userHasPermission`'s body schema is `role: z.string().optional()`
     (`admin/routes.ts:1753-1771`), so better-auth answers 400 `VALIDATION_ERROR`, which Z2 maps to a configuration
     error. **Every `@RequirePermission` route answers 500**, for admins and non-admins alike.
  2. **A display label:** `role: user.role === 'admin' ? 'Administrator' : 'Member'`. Every real admin is denied 403
     `MISSING_PERMISSION` on `@RequirePermission` routes, while better-auth's `listUsers` lets the same admin through.
  3. **An effective role from app data:** `role: isSupportStaff(user) ? 'admin' : user.role`. A user whose stored role
     is `user` passes `@RequirePermission({ user: ['list'] })`, while better-auth's own `listUsers` for the same
     cookie answers 403 `YOU_ARE_NOT_ALLOWED_TO_LIST_USERS`. The Nest admin surface and better-auth's admin
     endpoints now disagree about who is an admin. This is the divergence ADR-36 and ADR-54 exist to prevent.

  The `producedByEndpoint` check does not help: the custom endpoint produced these objects.

- **Evidence:** EXP `exp2-policy-401-and-custom-role.mjs` part (b), identical on 1.7.4 and 1.7.0 (a real `admin` user
  and a `user` user, the design's observer plugin placed last, authoritative `getSession`, then the design's call):
  ```
  --- (b) customSession: roles as array (frontend convenience)
    better-auth listUsers (DB role admin) -> ok {"users":[...
    design admin policy (DB role admin; produced=true; role=["admin"]) -> APIError 400 code=VALIDATION_ERROR
  --- (b) customSession: display label
    better-auth listUsers (DB role admin) -> ok {"users":[...
    design admin policy (DB role admin; produced=true; role="Administrator") -> ok {"error":null,"success":false}
  --- (b) customSession: effective role from app data
    better-auth listUsers (DB role user (support@)) -> APIError 403 code=YOU_ARE_NOT_ALLOWED_TO_LIST_USERS
    design admin policy (DB role user (support@); produced=true; role="admin") -> ok {"error":null,"success":true}
  ```
- **Suggested fix:** Never take the role from a shape better-auth's admin evaluation does not read:
  - When `$context.hasPlugin('custom-session')` (checked once at boot), the admin policy sends
    `userHasPermission({ body: { userId: principal.userId, permissions } })`. With only `userId`, the endpoint reads
    the stored role itself (`findUserById`, one read on admin routes of `customSession` apps). Without
    `customSession`, keep today's one-read path: the base shape is better-auth's own.
  - Remove "the admin policy passes `session.user.role` when the shape has it" from §11.5 and the cost column. Say in
    §15.3 that the `hasRole` recipe reads the app's session shape, which is better-auth's stored role only without
    `customSession`.
  - Add `Z-admin-custom-session-role`: the three shapes above give the same verdict as `listUsers` for the same cookie.

### BA-r3-03 (major): The API-key outage probe keys its statements on a random `id`, which a healthy Postgres rejects under better-auth's `generateId: "serial"`: every invalid, revoked or unknown key answers 5xx

- **Section:** §8.3.1 (outage probe steps 1–2, "a write that matches no row … never throws for zero matches"),
  §2.2.15 `ApiKeyPrincipalOptions.outageProbe`, §0.2 P6 row, LEAD-V41, LEAD-EXP-9, ADR-42, RK18.
- **Failure scenario:** better-auth documents `advanced.database.generateId: "serial"` for numeric primary keys, and
  its migrations then create `apikey.id` as `integer`. `apiKeyPrincipal()` runs with the default `outageProbe: true`.
  1. A client sends a revoked, mistyped or scanned key. `verifyApiKey` answers `INVALID_API_KEY` (LEAD-V20).
  2. The probe runs `adapter.findOne({ model: 'apikey', where: [{ field: 'id', value: <random> }] })`.
  3. For id fields under `serial`, better-auth's adapter factory converts the value with `Number(value)`
     (`CORE/db/adapter/factory.ts:540-552`), giving `NaN`, and Postgres rejects the statement with
     `invalid input syntax for type integer: "NaN"`.
  4. The probe reports an outage, and the source throws `BetterAuthInfrastructureError`. Every request with a bad key
     now answers 5xx with an ERROR log, instead of 401. Concurrent callers share the failed probe, and the
     once-per-second throttle only repeats the failure.

  Machine clients treat their rejected key as a transient server error and retry, monitoring pages on-call for every
  scanner, and a revoked key never reads as revoked. The same class of error hits any store whose id column is not
  text when the random value does not parse as that type (for example a non-UUID string against a `uuid` column).
  LEAD-EXP-9 ran only the memory adapter, which compares ids as strings.

- **Evidence:** EXP `exp1-probe-id-format.mjs` (PGlite Postgres, kysely adapter, `getMigrations`), identical on
  1.7.4 and 1.7.0 (`exp1.v174.out`, `exp1.v170.out`):
  ```
  generateId default (text id), uuid probe id  id column=text    | valid key -> true | unknown key -> INVALID_API_KEY | probe -> ok (count 0)
  generateId: "serial", uuid probe id          id column=integer | valid key -> true | unknown key -> INVALID_API_KEY | probe -> THROWS invalid input syntax for type integer: "NaN"
  generateId: "serial", hex probe id           id column=integer | valid key -> true | unknown key -> INVALID_API_KEY | probe -> THROWS invalid input syntax for type integer: "NaN"
  generateId: "uuid", uuid probe id            id column=uuid    | valid key -> true | unknown key -> INVALID_API_KEY | probe -> ok (count 0)
  generateId default  probe on key column -> ok (count 0)
  generateId serial   probe on key column -> ok (count 0)
  generateId uuid     probe on key column -> ok (count 0)
  ```
- **Suggested fix:** Key both probe statements on the column the verification itself looks up: `field: 'key'` (the
  hashed key, `type: 'string'`, indexed, `AK/schema.ts:56-63`; `AK/adapter.ts:381-428`). Use a random value no stored
  hash can equal, for example a random UUID, which is not base64url-shaped like the plugin's hashes. That statement
  is type-safe under every `generateId` mode and every adapter, and it exercises the same index `verifyApiKey` uses.
  Correct LEAD-V41/§8.3.1 to say the no-match guarantee holds only for a type-compatible value. Add a Postgres-backed
  (PGlite is enough) `S-apikey-probe-id-modes` case over `generateId` default, `"uuid"` and `"serial"`, expecting 401
  for an unknown key.

### BA-r3-04 (minor): `apiKeyPrincipal()` forwards only `Host`, so under a dynamic `baseURL` behind a proxy better-auth trusts, every key request answers 500

- **Section:** §8.3.1 ("`headers` holds only the request's `Host` when it has one"), ADR-60 ("`apiKeyPrincipal()`
  passes the request's `Host` and declares nothing"), §5.4 B20.
- **Failure scenario:** `baseURL: { allowedHosts: ['api.example.com'] }` without `fallback`, and
  `advanced.trustedProxyHeaders: true`, which better-auth requires when the public host arrives in `X-Forwarded-Host`
  (`BA/context/helpers.ts:198-209`). The proxy (an API gateway, a Next.js rewrite, `http-proxy` with `changeOrigin`)
  sends `Host: nest-app:3000` and `X-Forwarded-Host: api.example.com`.
  1. The guard's `getSession` gets the full headers. better-auth takes the host from `X-Forwarded-Host`
     (`BA/utils/url.ts:273-300`), and the session resolves.
  2. `apiKeyPrincipal()` calls `verifyApiKey({ headers: { host: 'nest-app:3000' } })`.
  3. `resolveDynamicBaseURL` rejects `nest-app:3000` (`url.ts:398-446`), and the `auth.api` wrapper turns that into
     `APIError 500` before dispatch (`BA/api/to-auth-endpoints.ts:36-67`). `verifyApiKey`'s own catch never sees it,
     and the source maps ≥ 500 to infrastructure.

  Every API-key request answers 5xx while cookie and bearer traffic works. B20 stays silent, because the source no
  longer declares host-less calls.

- **Evidence:** EXP `exp3-apikey-host-only-proxy.mjs`, identical on 1.7.4 and 1.7.0 (timestamps aside):
  ```
  --- dynamic baseURL, trustedProxyHeaders: true, fallback: none
  guard getSession({ headers: full inbound headers + session cookie })   -> ok {"session":...
  design apiKeyPrincipal: verifyApiKey({ headers: { host } })            -> APIError 500: Host "nest-app:3000" is not in the allowed hosts list. ...
  alt: verifyApiKey({ headers: { host, x-forwarded-host, x-forwarded-proto } }) -> ok {"valid":true,...
  ```
- **Suggested fix:** Copy the headers better-auth itself reads to resolve a direct call's base URL: `host`,
  `x-forwarded-host` and `x-forwarded-proto` (`pickSource`, `getHostFromSource`, `getProtocolFromSource`). None of them
  matches a credential hook. Pin it with an `S-dynamic-base-url` variant that sets `trustedProxyHeaders` and sends the
  public host in `X-Forwarded-Host` only.

### BA-r3-05 (minor): In `customSession` apps the ADR-59 re-read is swallowed as well, so the round-2 outage scenario still answers 401, not 5xx

- **Section:** ADR-59, §8.1 (Errors, 401 branch), §7.7 RK2 note, §17.2 RK2 mitigation ("policy calls are re-classified by
  an authoritative re-resolution"), §15.4 ("Authorization infrastructure failures are now 5xx … including the ones
  better-auth's session middleware reports as 401").
- **Failure scenario:** The BA-r2-03 setup plus `customSession(...)`: the guard's read succeeds, then storage fails
  before `@RequireOrgPermission`'s `hasPermission`.
  1. `hasPermission` answers 401 `UNAUTHORIZED`, as before.
  2. ADR-59 re-reads with `getSession({ query: { disableCookieCache: true } })`. That endpoint is now `customSession`'s,
     which wraps the inner read in `.catch(() => null)` and returns `null` (`BA/plugins/custom-session/index.ts:100-110`).
  3. The resolver returns `absent`, and the net answers **401 `UNAUTHENTICATED`**.

  Frontends sign the user out during an outage, and 5xx alerting sees nothing: the same symptom BA-r2-03 described,
  now only for `customSession` apps. The documents say the policy path is fixed. RK2 only admits the guard's own read.

- **Evidence:** EXP `exp4-reclassify-customsession-outage.mjs` (the round-2 flaky adapter), identical on 1.7.4 and 1.7.0:
  ```
  --- customSession: false; guard getSession ok = true
    org hasPermission during outage -> APIError 401 UNAUTHORIZED
    ADR-59 re-read (getSession, disableCookieCache) -> throws APIError 500 FAILED_TO_GET_SESSION -> design: 5xx
  --- customSession: true; guard getSession ok = true
    org hasPermission during outage -> APIError 401 UNAUTHORIZED
    ADR-59 re-read (getSession, disableCookieCache) -> null -> design: absent -> 401 UNAUTHENTICATED
  ```
- **Suggested fix:** No better-auth API reads the base session without swallowing errors once `customSession` replaces
  `/get-session`, so fix the claims rather than add a mechanism:
  - RK2 and ADR-59 state that in `customSession` apps the re-classification read is swallowed too, so a policy-path
    outage answers 401 exactly like the guard's own read.
  - §15.4 limits its "now 5xx" sentence to apps without `customSession`.
  - `Z-policy-session-lost` gets a `customSession` variant that expects the documented 401.
  - The upstream proposal names `customSession`'s catch explicitly.

## Proposed user decisions

- **When a better-auth call in a policy answers a coded 401 for an authenticated principal (e.g.
  `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`), what status should the safety net return (BA-r3-01)?**
  - Option (a): 403 with better-auth's code as `reason`. That is what v2's net and v3's built-in org policy answer,
    and it is semantically "authenticated but not allowed", so clients do not sign the user out.
  - Option (b): better-auth's own 401 with its code as `reason`. That is literal fidelity to better-auth's status
    choice, but many clients treat 401 as "session gone" and sign the user out.
  - Recommendation: **(a)**. The kernel already knows the principal is authenticated, and the built-in org policy has
    made the same call. Keep 401 for the generic session-middleware shapes, which ADR-59 re-classifies.

- **Where should the admin policy take the role from when `customSession` is installed (BA-r3-02)?**
  - Option (a): send only `userId`, so better-auth reads the stored role (one extra read on admin routes of
    `customSession` apps, parity by construction).
  - Option (b): add a required `session.role` mapper, like `session.userId`, that maps the custom shape back to the
    stored role. That costs no read, but the app must keep the mapper faithful to better-auth's stored value, and the
    library cannot check it.
  - Recommendation: **(a)**. The admin surface is exactly where the design promised to evaluate what better-auth
    evaluates, and a mapper reintroduces an app-controlled role.
