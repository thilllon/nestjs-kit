# Round 4 review: BA (better-auth fidelity)

Input: `design-v4.md`. Verdict: **reject** (0 blockers, 1 major, 4 minor).

Experiments: `scratchpad/tmp-r4-review-BA/` (scripts `exp*.mjs`, captured `exp*.out`). `v174/` is an npm tree with
better-auth 1.7.4 and @better-auth/api-key 1.7.4 (@better-auth/core resolves to 1.7.5 there); `pnpm170/` is a pnpm tree
with better-auth 1.7.0, @better-auth/api-key 1.7.0 and a single @better-auth/core 1.7.0, which is the tree the floor job
gets. Postgres runs use PGlite with better-auth's kysely adapter and `getMigrations`. Every experiment gave identical
results on both versions. `tarballs/` holds the published 1.7.4 and 1.7.5 packages (better-auth, core, api-key) used for
dist diffs.

## Summary

v4 closes every round-3 BA finding for the failure scenario it reported. I re-checked the mechanisms v4 added or changed
against the 1.7.4 source and the 1.7.0 and 1.7.5 dist:

- **401 classification (ADR-59).** Only the generic shapes are re-read, and only for a `sessionBacked` source. That matches
  `sessionMiddleware` and its siblings (`{ code: 'UNAUTHORIZED' }`) and `APIError.fromStatus('UNAUTHORIZED')` in
  `adminMiddleware` (`BA/api/routes/session.ts:540-603`, `BA/plugins/admin/routes.ts:33-45`). `customSession` passes the
  caller's `query` (including `disableCookieCache`) to its inner read (`BA/plugins/custom-session/index.ts:100-108`), so
  authoritative reads stay authoritative under it.
- **API-key probe and headers.** The probe on `key` holds. The verification codes the result table maps are still the
  complete set on 1.7.0 and 1.7.4 (`AK/routes/verify-api-key.ts:44-221, 520-600`).
- **Hook pipeline.** `runBeforeHooks`, `runAfterHooks` and `getHooks` behave as §10.5 states: user hooks first, a thrown
  after-hook `APIError` becomes `returned`, after-hooks are skipped for a short-circuit or a raw `Response`
  (`BA/api/dispatch.ts:136-307, 373-450`). 1.7.0→1.7.4 differences in `dispatch`, `to-auth-endpoints`, `with-hooks`,
  `custom-session`, `organization` and the admin routes are instrumentation, schema checks and `banExpires: null`. 1.7.5
  changes only cookie-cache version checks, migrations and captcha. `runPluginInit` still merges `init().options` with
  `defu` and appends user DB hooks last (`BA/context/helpers.ts:23-98`).

What fails is new or changed code that reads better-auth's data more narrowly than better-auth does, plus three gaps where
a better-auth default or behavior was not carried through:

- **Major.** The admin policy now copies the stored row into `body.role`. `userHasPermission`'s schema rejects `null`,
  and every user that predates `admin()` has a NULL role. Those users get an ERROR-logged 500 on every `@RequirePermission`
  route, and so does an `adminUserIds` admin with a NULL role. v3 fell back to the endpoint's read for a nullish role; the
  BA-r3-02 rewrite dropped that fallback (BA-r4-01).
- **Minor.**
  - "Production" includes `NODE_ENV` unset and `staging`, where better-auth's rate limiter is off by default. No boot check
    says so, and the bucket warnings describe a limiter that does not run (BA-r4-02).
  - `subscriptionCredentials` drops `Host`, so under a dynamic `baseURL` without `fallback` every GraphQL-over-WebSocket
    operation answers 500. B20 only warns (BA-r4-03).
  - The §4.3.4 JWT-plugin source is said to work "the same way" as the OAuth sketch, but `verifyJWT` turns JWKS read
    failures into "invalid token", so an outage answers 401 (BA-r4-04).
  - One `nestjs()` object shared by two instances makes the second `bind()` a silent no-op. The default instance's Nest
    hooks then run for the other instance (BA-r4-05).

| Id       | Sev   | Title                                                                                                                                                               |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA-r4-01 | major | Admin policy sends the stored role as `body.role`: a NULL role fails `userHasPermission`'s schema, so role-less users (and NULL-role `adminUserIds` admins) get 500 |
| BA-r4-02 | minor | "Production" without `NODE_ENV=production` has better-auth's rate limiter off; no boot signal, and the bucket warnings mislead                                      |
| BA-r4-03 | minor | `subscriptionCredentials` replaces the upgrade headers wholesale: dynamic `baseURL` without `fallback` answers 500 for every WS operation                           |
| BA-r4-04 | minor | The JWT-plugin source sketch relies on `verifyJWT`, which reports JWKS storage failures as an invalid token (401)                                                   |
| BA-r4-05 | minor | A `nestjs()` plugin object shared by two instances: the second bind is a silent no-op and hooks cross instances                                                     |

## Prior findings (round 3, BA)

| Id       | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA-r3-01 | resolved | A coded 401 now denies 403, and a generic 401 is re-read only for a `sessionBacked` source. The non-member `hasPermission` scenario gives 403, and the OAuth-principal scenario gives 401 without a re-read. Observation: api-key's `UNAUTHORIZED_SESSION` (`AK/routes/create-api-key.ts:324, 342`; `update-api-key.ts:292, 296`) and passkey's `SESSION_REQUIRED` (`passkey/src/routes.ts:78`) are coded 401s that mean "no session", so they deny 403 without a re-read. That is harmless for permission-check policies and needs no change. |
| BA-r3-02 | resolved | The stored role reaches `userHasPermission` for every principal, and the three `customSession` shapes give `listUsers`' verdict. However, the rewrite dropped v3's "a nullish role falls back to the endpoint's user lookup" (design-v3 §8.3 admin row), so v4 sends `role: null` for role-less users. This fix introduced a regression; see BA-r4-01.                                                                                                                                                                                         |
| BA-r3-03 | resolved | Both probe statements are keyed on `key` with a random UUID (LEAD-V46), and `LIB-apikey-probe-id-modes` runs on PGlite under all three `generateId` modes.                                                                                                                                                                                                                                                                                                                                                                                     |
| BA-r3-04 | resolved | `verifyApiKey` gets `host`, `x-forwarded-host` and `x-forwarded-proto`, and a trusted-proxy variant of `S-dynamic-base-url` pins it. The GraphQL override path that loses `Host` altogether is a different entry point (BA-r4-03).                                                                                                                                                                                                                                                                                                             |
| BA-r3-05 | resolved | RK2, §7.7, §8.1, §11.5, §15.4 and Q22 now limit the "policy outages are 5xx" claim to apps without `customSession`, and `Z-policy-session-lost` expects 401 with it.                                                                                                                                                                                                                                                                                                                                                                           |

No earlier BA finding regressed apart from the part of BA-r3-02's fix described above. BA-r1-01 to BA-r1-11 and BA-r2-01
to BA-r2-09 still hold as fixed. BA-r2-08's rebuttal observation was applied (§8.3 now points slugs at
`listOrganizations`).

## New findings

### BA-r4-01 (major): The admin policy sends the stored role as `body.role`; a NULL role fails `userHasPermission`'s schema, so role-less users get 500 on every `@RequirePermission` route

- **Section:** §8.3 admin rows (session and delegated principals), §2.2.15 `PermissionOptions` doc, §13.2 (built-in
  mapping list: "v3 mapped the endpoint's 400 `user not found`, which cannot occur now"), ADR-36 (_Revised in v4_), §17 Q29,
  LEAD-EXP-11 ("the stored role agreed with `listUsers` in all six cases").
- **Failure scenario:** An existing app adds `admin()` and runs better-auth's migration.
  - The admin schema declares `role` as `{ type: 'string', required: false }` with no `defaultValue`
    (`BA/plugins/admin/schema.ts:6-10`). Every user that existed before the migration therefore has `role = NULL`.
  - Only users created afterwards get `defaultRole`, from the plugin's `user.create.before` hook
    (`BA/plugins/admin/admin.ts:77-87`). Users written by seed or import scripts through the adapter also keep NULL.

  Such a user calls a `@RequirePermission({ user: ['list'] })` route:
  1. The guard's authoritative read succeeds. The policy reads `findUserById(userId)` and gets `role: null`, because the
     adapter factory passes `null` through (`CORE/db/adapter/factory.ts:307-380`).
  2. The policy calls `userHasPermission({ body: { userId, role: null, permissions } })`. The body schema is
     `role: z.string().optional()` (`BA/plugins/admin/routes.ts:1753-1771`), which rejects `null`, so better-auth answers
     400 `VALIDATION_ERROR`.
  3. Z2 maps "another 4xx" to `BetterAuthConfigurationError('BETTER_AUTH_REJECTED_CALL')`: 500 `AUTH_MISCONFIGURED`,
     logged at ERROR, on every request.

  better-auth treats a missing role as `defaultRole` (`BA/plugins/admin/has-permission.ts:21`:
  `(input.role || defaultRole || 'user')`), so `listUsers` answers 403 for the same cookie. The `adminUserIds` case is
  worse. `adminUserIds` is how the admin plugin grants admin rights to specific existing users, typically ones that
  predate the plugin and so have a NULL role. Every better-auth admin endpoint lets such a user through, but every
  `@RequirePermission` route answers 500, so the Nest admin surface does not work for them. v3 did not have this defect:
  its admin row said "a nullish role falls back to the endpoint's user lookup". LEAD-EXP-11 ran the memory adapter with a
  role set on every user, so it never met a NULL role. `Z-admin-custom-session-role` has the same blind spot.

- **Evidence:** EXP-1 `exp1-admin-null-role.mjs` (PGlite + kysely + migrations; the role set to NULL with SQL), identical
  on 1.7.4 and 1.7.0 (`exp1.v174.out`, `exp1.v170.out`):
  ```
  --- legacy user, stored role NULL (column added by admin() migration)
    better-auth listUsers (cookie; adminMiddleware + hasPermission) -> APIError 403 code=YOU_ARE_NOT_ALLOWED_TO_LIST_USERS
    design admin policy: userHasPermission({ userId, role: row.role }) -> APIError 400 code=VALIDATION_ERROR
    alt: userHasPermission({ userId, role: row.role ?? undefined }) -> ok {"error":null,"success":false}
  --- legacy user, stored role NULL, listed in adminUserIds (bootstrap admin)
    better-auth listUsers (cookie; adminMiddleware + hasPermission) -> ok {"users":[{"name":"L",...
    design admin policy: userHasPermission({ userId, role: row.role }) -> APIError 400 code=VALIDATION_ERROR
    alt: userHasPermission({ userId, role: row.role ?? undefined }) -> ok {"error":null,"success":true}
  --- control: stored role "user"  -> listUsers 403, design ok success:false
  --- control: stored role "admin" -> listUsers ok,  design ok success:true
  ```
- **Suggested fix:** Stop copying the row into `body.role`, and let the endpoint make the read it already makes:
  - **Session principals:** call `userHasPermission({ body: { userId: principal.userId, permissions } })` without headers.
    - With `userId` and no `role`, the endpoint reads the stored row itself (`routes.ts:1874-1885`) and applies
      `hasPermission`'s own `defaultRole` and `adminUserIds` handling.
    - That is the same single user read v4 pays, with parity by construction. The library no longer holds a copy of
      better-auth's null handling, or of whatever role semantics a later 1.x release adds.
    - Map the endpoint's 400 `user not found` back to 401 `USER_NOT_FOUND`, as v3 did (BA-r1-10).
  - **Delegated principals:** keep the policy's own `findUserById` for the ban check. Then pass `role` only when the row's
    role is a non-empty string; otherwise make the `userId`-only call, which adds a second read for role-less owners only.
  - **Tests and records:** add `Z-admin-null-role` on a SQL store (PGlite is enough). A NULL role must give 403, like
    `listUsers`, and a NULL role listed in `adminUserIds` must be allowed, on both the session and the delegated path.
    Correct LEAD-EXP-11, §13.2 and ADR-36 to describe what they actually covered.

### BA-r4-02 (minor): "Production" includes `NODE_ENV` unset and `staging`, where better-auth's rate limiter is off by default; nothing says so, and the bucket warnings describe a limiter that does not run

- **Section:** §5.4 (definition of "in production", B18, B22 boot summary, B27), §6.3 step 7 and §6.8 item 6
  (`W_PROXY_UNTRUSTED`: "it became the rate-limit key"), §6.8 opening paragraph, §15.1 steps 8–9, LEAD-V48. This finding
  keeps the Q33 default. It reports a defect under that default.
- **Failure scenario:**
  1. A container runs without `NODE_ENV`, the deployment v4 deliberately treats as production (SEC-r3-07), or with
     `NODE_ENV=staging`. It has a static `https` `baseURL`, a real secret, and `app.set('trust proxy', 1)` set as
     migration step 8 asks.
  2. The boot summary prints `environment: production (NODE_ENV unset)`. B23 and B29 pass, and B18, B27 and
     `W_PROXY_UNTRUSTED` report on per-IP rate-limit buckets.
  3. better-auth resolves `rateLimit.enabled = options.rateLimit?.enabled ?? isProduction`, where `isProduction` means
     `NODE_ENV === 'production'` (`BA/context/create-context.ts:354-360`, `CORE/env/env-impl.ts:52`). The rate limiter is
     off.
  4. An attacker can therefore guess passwords on `/sign-in/email`, or OTP and 2FA codes, from one IP without limit: every
     attempt answers 401 and none answers 429.

  Nothing in the boot output or the logs says the limiter is off. The one IP-related runtime message, `W_PROXY_UNTRUSTED`,
  even says the socket IP "became the rate-limit key". This is the same class of divergence as B29, where better-auth
  accepts its default secret unless `NODE_ENV === 'production'`. v4 fixed that for the secret, but not for the other
  `isProduction`-keyed security default. §6.8 opens with "With no usable IP in production, rate limiting falls back to one
  shared bucket", which holds only under better-auth's definition of production, not the design's.

- **Evidence:** EXP-2 `exp2-ratelimit-node-env.mjs` (6 failed sign-ins from one IP through `auth.handler`), identical on
  1.7.4 and 1.7.0 (`exp2.out`):
  ```
  NODE_ENV=undefined    -> $context.rateLimit.enabled=false; 6 failed sign-ins from one IP -> 401,401,401,401,401,401
  NODE_ENV="staging"    -> $context.rateLimit.enabled=false; 6 failed sign-ins from one IP -> 401,401,401,401,401,401
  NODE_ENV="production" -> $context.rateLimit.enabled=true;  6 failed sign-ins from one IP -> 401,401,401,429,429,429
  ```
- **Suggested fix:**
  - Add `rateLimit: { enabled: boolean }` to `AuthContextView`, read from the resolved `$context.rateLimit`.
  - Add a boot check B30. It warns `W_RATE_LIMIT_DISABLED` in production (the design's definition) when
    `$context.rateLimit.enabled` is false and the user did not set `rateLimit.enabled` explicitly. An explicit `false`
    appears only in the summary. The hint is: "better-auth enables its rate limiter only when NODE_ENV=production; set it,
    or rateLimit: { enabled: true }". The warn-versus-fail choice is proposed as a user decision below.
  - Print `rate limit: on | off (<why>)` in the boot summary.
  - While the limiter is off, suppress B18, B27 and `W_PROXY_UNTRUSTED`, or reword them, because the IP only feeds session
    records then.
  - Correct §6.8's first paragraph. Add the fact to migration step 9 and rows to `LIB-environment`: `NODE_ENV` unset and
    `staging` give `W_RATE_LIMIT_DISABLED`; `production` gives none.

### BA-r4-03 (minor): `subscriptionCredentials` replaces the upgrade headers wholesale, so under a dynamic `baseURL` without `fallback` every GraphQL-over-WebSocket operation answers 500

- **Section:** §2.2.12 `GraphqlTransportOptions.subscriptionCredentials` ("Full override of credential extraction"), §9.2
  "Over a WebSocket" and the table row "Credentials over a WebSocket" ("… replace same-named headers, **or**
  `subscriptionCredentials(ctx)`"), §5.4 B20, ADR-60, §8.3.1 (`apiKeyPrincipal()` copies `host`/`x-forwarded-*` from the
  call's headers).
- **Failure scenario:**
  1. The app uses `baseURL: { allowedHosts: ['api.example.com'] }` without `fallback`. B20 only warns (`W_DYNAMIC_HOST`),
     because no registered unit declares host-less calls.
  2. It uses Apollo with graphql-ws and token-authenticated subscriptions, through the documented override:
     `apolloTransport({ subscriptionCredentials: (c) => ({ authorization: `Bearer ${c.connectionParams.token}` }) })`.
  3. For every subscription, and every query or mutation sent over the socket, the session source calls
     `getSession({ headers: { authorization } })`. The headers carry no `Host`, so better-auth cannot resolve the dynamic
     base URL and throws `APIError` 500 before dispatch.
  4. The source maps that to infrastructure. Each WS operation answers `INTERNAL_SERVER_ERROR` / `AUTH_UNAVAILABLE`
     with an ERROR log, while the same token works over HTTP, so the failure looks like a WebSocket outage.

  `apiKeyPrincipal()` fails the same way on such operations, because it copies `host` and `x-forwarded-*` from headers
  that do not contain them. The default `connectionParamHeaders` path keeps the upgrade request's `Host`; only the override
  loses it. BA-r2-05 and BA-r3-04 fixed the same class for the admin policy, RPC and API keys.

- **Evidence:** EXP-3 `exp3-hostless-override.mjs`, identical on 1.7.4 and 1.7.0 (`exp3.out`):
  ```
  upgrade headers (host + cookie), connectionParams merged                       -> ok session=true
  subscriptionCredentials override: { cookie } (no host)                         -> APIError 500: Dynamic baseURL could not be resolved for this direct auth.api call. …
  subscriptionCredentials override: { authorization: Bearer <token> } (no host)  -> APIError 500: Dynamic baseURL could not be resolved for this direct auth.api call. …
  ```
- **Suggested fix:** Treat the base-URL headers as facts of the leg, not as credentials:
  - The GraphQL units (or core's header hygiene in `TransportCall.headers()`) copy `host`, `x-forwarded-host` and
    `x-forwarded-proto` from the upgrade request into the credential headers whenever the override omits them. That is the
    set LEAD-V47 names and `apiKeyPrincipal()` already forwards.
  - Alternatively, the GraphQL units declare `requires.hostlessCalls` when `subscriptionCredentials` is set, so B20 fails
    boot instead.
  - Add a graphql-ws variant with `subscriptionCredentials` to `S-dynamic-base-url` or to the GraphQL job's base-URL axis.

### BA-r4-04 (minor): The §4.3.4 JWT-plugin source "works the same way", but `verifyJWT` swallows JWKS read failures into `payload: null`, so the sketch answers 401 during an outage

- **Section:** §4.3.4, last paragraph ("A JWT-plugin source works the same way. It calls
  `auth.api.verifyJWT({ body: { token } })` (server-only) and returns `rejected(… 'INVALID_JWT' …)` when the token is
  invalid").
- **Failure scenario:**
  1. A team builds the JWT principal source as §4.3.4 describes. The OAuth sketch next to it rethrows a JWKS failure
     (`// JWKS fetch failure → 5xx`).
  2. The JWT plugin's `jwks` table becomes unreachable (a database brownout), or a custom `adapter.getJwks` throws.
  3. `verifyJWT` reads the keys inside its own `try` and turns every error into `null`
     (`BA/plugins/jwt/verify.ts:13-68`; the `getAllKeys` call is at `:35`, the `catch` that returns `null` at `:65-68`).
     The endpoint answers `{ payload: null }`, which is exactly what it answers for a forged token.
  4. Following the sketch, every valid JWT then answers 401 `INVALID_JWT`. Machine clients discard or refresh tokens in a
     loop, and monitoring sees 401s instead of 5xx.

  S6 is violated by the design's own guidance, and the claim that the source "works the same way" as the OAuth sketch is
  false. RK18 records this class of problem for `verifyApiKey` only.

- **Evidence:** EXP-4 `exp4-verifyjwt-outage.mjs` (memory adapter whose `jwks` reads throw on demand), identical on 1.7.4
  and 1.7.0 (`exp4.out`):
  ```
  storage healthy: verifyJWT(valid token) -> payload present
  jwks read throws: verifyJWT(valid token) -> payload null (no throw) => sketch answers 401 INVALID_JWT
  ```
- **Suggested fix:** Rewrite the paragraph to use the verification better-auth's JWT plugin docs show for resource servers:
  - Verify with jose's `jwtVerify` against the instance's `/jwks` endpoint (`createRemoteJWKSet`), or against keys the
    source loads itself.
  - Map signature, claim and expiry errors to `rejected`, and let JWKS fetch or storage errors throw, as the OAuth sketch
    does.
  - If the sketch keeps `verifyJWT`, state next to it that `verifyJWT` reports storage failures as an invalid token, and
    add it to RK18 and to the upstream proposal: rethrow errors that are not verification failures.

### BA-r4-05 (minor): A `nestjs()` plugin object shared by two better-auth instances: the second `bind()` is a silent no-op and Nest hooks run for the wrong instance

- **Section:** §10.2 `BridgeHandle.bind` (the same-owner branch returns the existing registration), §5.7 step 2 ("The
  binding's owner is a fresh object per application"), §10.6 ("Named instances each have their own plugin instance and
  therefore their own binding"), §5.5, B03, B06.
- **Failure scenario:**
  1. An app with a named instance reuses one plugins array: `const plugins = [organization(), nestjs()]` for both `auth`
     and `adminAuth`, with distinct `basePath` and `cookiePrefix`, so B10 and B24 pass. better-auth accepts this.
  2. `$context.getPlugin('nestjs-slightly-better-auth')` returns the same object for both instances, and that object's
     `init()` contributes DB dispatchers to both, each closed over one `binding`.
  3. In `onModuleInit` the kernel binds `'default'`, then `'admin'` with the same application owner. §10.2 treats the
     second call as a repeated lifecycle call and returns success without binding.

  The results, with no boot error or warning:
  - every Nest hook declared with `instance: 'admin'` silently never runs;
  - the default instance's `@BeforeAuth`, `@AfterAuth`, `@BeforeDatabase` and `@AfterDatabase` hooks run for the admin
    instance's dispatches and writes. For example, a `@BeforeDatabase('user.create')` domain rule meant for customers
    blocks admin-instance user creation;
  - the bridge compares the default instance's credential headers.

  This is the silent-hook failure mode the design's exclusive binding exists to prevent (reference #42, ADR-07).

- **Evidence:** EXP-5 `exp5-shared-plugin-object.mjs`, with a plugin that mimics §10.2's closure binding, same-owner
  `bind()` and `init()` DB dispatchers; identical on 1.7.4 and 1.7.0 (`exp5.out`):
  ```
  both instances boot; same bridge handle object: true
  bind default -> noop=false; bind admin -> noop=true (admin tables silently dropped)
  admin instance sign-up -> 400 FAILED_TO_CREATE_USER (the DEFAULT instance's Nest DB hook rejected it)
  ```
  The same object is returned for both instances because better-auth's `getPlugin` looks the plugin up by id in the
  instance's own `options.plugins` (`BA/context/create-context.ts`, 1.7.0 dist `:125`).
- **Suggested fix:**
  - At B03, fail boot with `PLUGIN_SHARED_BETWEEN_INSTANCES` when two instances resolve the same bridge handle object.
    Hint: "call nestjs() inside each betterAuth({ plugins }); a plugin object holds one binding".
  - Make `bind()`'s no-op branch require the same owner **and** the same instance name, and throw otherwise.
  - Add a lifecycle unit-test row, and state the rule in §5.5 and §10.6.

## Proposed user decisions

- **When better-auth's rate limiter is off in a deployment the library treats as production (NODE_ENV unset or
  `staging`), should boot warn or fail (BA-r4-02)?**
  - Option (a): warn (`W_RATE_LIMIT_DISABLED`), and show an explicit `rateLimit.enabled: false` only in the summary.
    Teams that rate-limit at a gateway keep booting, and the fact is visible.
  - Option (b): fail boot like B29 (`DEFAULT_SECRET`) unless `rateLimit.enabled` is set explicitly. Brute-force
    protection cannot silently disappear, but every existing deployment without `NODE_ENV=production` must add one line
    before it boots.
  - Recommendation: **(a)**. Unlike the default secret, a disabled limiter is a legitimate configuration when an edge proxy
    or WAF limits sign-in traffic. better-auth itself makes it a default rather than an error, and the warning plus the
    summary line close the visibility gap without breaking boots.
