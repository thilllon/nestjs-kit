---
reviewer: BA
round: 5
reviewed: design-v5.md
verdict: approve
blockers: 0
majors: 0
minors: 3
prior_unresolved: []
---

# Round 5 review: BA (better-auth fidelity)

Input: `design-v5.md`. Verdict: **approve** (0 blockers, 0 majors, 3 minors).

Experiments: `/tmp/nsba/tmp-r5-review-BA/`. `v174/` is an npm tree with better-auth 1.7.4, @better-auth/api-key 1.7.4
and jose 6.2.12; `v170/` is the same tree at better-auth 1.7.0 / @better-auth/api-key 1.7.0 (the D4 floor). Scripts:
`exp1-jwt-issuer.mjs`, `exp2-admin-and-orgcache.mjs`, `exp3.mjs` (the combined run, executed in both trees),
`rl.mjs` (one process per `NODE_ENV`), `exp4-env-snapshot.mjs`. Every result below is **identical on 1.7.0 and 1.7.4**.
Source citations are against `/tmp/nsba/better-auth` at 1.7.4 unless a dist file is named.

## Summary

v5 closes every round-4 BA finding for the failure scenario it reported, and I could not break any of the five fixes.
Re-verified against the source and at runtime on both peer-range ends:

- **BA-r4-01 (admin role).** `userHasPermission`'s handler is `getAuthoritativeSessionFromCtx` → `!session && (ctx.request || ctx.headers)`
  → `session?.user || (body.role ? … : null) || (body.userId ? findUserById(body.userId) : null)` → `hasPermission({ userId, role })`
  (`BA/plugins/admin/routes.ts:1858-1899`), and the endpoint carries no `requireHeaders` (`:1804-1808`), so v5's headerless
  `userId`-only call is legal and lands on better-auth's own `input.role || defaultRole || 'user'` and `adminUserIds` rules
  (`BA/plugins/admin/has-permission.ts:8-30`). EXP-3, both versions: a NULL stored role gives v4's call
  `400 VALIDATION_ERROR` (`[body.role] Invalid input: expected string, received null`) and v5's call `{"error":null,"success":false}`;
  a deleted user gives `400 {"message":"user not found"}` with **no** `body.code`, exactly as §8.3, §13.2 and LEAD-V51 state.
- **BA-r4-02 (rate limiter).** `rateLimit: { …, enabled: options.rateLimit?.enabled ?? isProduction }`
  (`BA/context/create-context.ts:354-360`). `rl.mjs`, one process per environment, both versions: `NODE_ENV` unset → `false`,
  `staging` → `false`, `production` → `true`, `staging` + `rateLimit: { enabled: true }` → `true` with
  `$context.options.rateLimit = {"enabled":true}`. `$context.rateLimit` and `$context.options.rateLimit` both exist at the
  1.7.0 floor, so `AuthContextView.rateLimit` is safe. B30 reads the **resolved** value rather than `NODE_ENV`, which is the
  right pattern (see BA-r5-02 for what its _message_ still gets wrong).
- **BA-r4-03 (host-less overrides).** Invariant T5 now requires `host`/`x-forwarded-host`/`x-forwarded-proto` on every
  credential mapping of a transport without `requires.hostlessCalls`, §9.2 applies it to `subscriptionCredentials`, and B20
  states that the GraphQL and WS units declare no host-less calls. The scenario cannot occur any more.
- **BA-r4-04 (JWT sketch).** The sketch no longer uses `verifyJWT`; a `getJwks` failure now propagates (5xx). The
  replacement carries a different defect, reported as BA-r5-01.
- **BA-r4-05 (shared plugin object).** B03 fails boot when two instances resolve the same handle, and `bind()` throws
  `PLUGIN_SHARED_BETWEEN_INSTANCES` for a second instance from the same owner (§10.2).

I also re-checked the mechanisms v5 leans on hardest and found them faithful:

- **Hook pipeline.** `runBeforeHooks` / `runAfterHooks` / `getHooks` / the short-circuit return
  (`BA/api/dispatch.ts:137-220, 222-262, 269-305, 383-393, 429-437`) behave exactly as §10.2 and §10.5 describe: user `options.hooks` first,
  then plugin hooks in plugin order; a short-circuit returns `{ headers: responseHeaders, response }` with
  `responseHeaders` `undefined` unless a hook set one, and skips every after-hook (so the endpoint-result observer records
  nothing for it); an after-hook's value replaces `ctx.context.returned` for later hooks and for the caller. No official
  1.7.x plugin replaces `returned` on `/get-session` — the jwt plugin's after-hook only sets headers
  (`BA/plugins/jwt/index.ts:348-381`) — so a mis-ordered `nestjs()` cannot silently break authoritative reads through that
  route; B05 covers the rest.
- **DB hooks.** `createWithHooks` passes the **chained** `actualData`, `updateWithHooks`/`updateManyWithHooks` pass the
  **original** `data` and only accumulate returned `{ data }` (`BA/db/with-hooks.ts:40-66, 111-145, 191-217`), and
  `BaseModelNames` is still exactly `user | account | session | verification` (`CORE/db/type.ts:9`). §10.6's dispatcher is
  byte-for-byte equivalent to N native plugins.
- **Origin rule.** `validateOrigin`'s skip order, the `useCookies` trigger, the `Origin: null` + `Sec-Fetch-Site: same-origin`
  inference and the trusted-origin merge (`BA/api/middlewares/origin-check.ts:15-50, 216-295`) match §7.10 step by step,
  including the deliberate, stricter divergence on path-array `skipOriginCheck`. `isTrustedOrigin` is a method that reads
  `this.trustedOrigins` (`BA/context/create-context.ts:298-307`), so `§7.10`'s `.call({ trustedOrigins: merged }, origin)` is
  sound, and the merged set equals what the router recomputes per request (`runPluginInit` folds plugin origins into
  `options.trustedOrigins`, `BA/context/helpers.ts:62-83`; `BA/auth/base.ts:97-100`).
- **Refresh suppression.** The stateless refresh-cache branch still checks only `getShouldSkipSessionRefresh()`
  (`BA/api/routes/session.ts:201-204`) while `query.disableRefresh` returns early later (`:308`), and
  `to-auth-endpoints.ts:110-113` reuses an existing request-state store for nested calls and creates a fresh `WeakMap` per
  top-level `auth.api.*` call, so the skip flag cannot leak between the guard's calls.
- **`kAPIErrorHeaderSymbol`** is `Symbol.for('better-call:api-error-headers')` (verified at runtime in `v174`), so §6.10 and
  §7.3 reading it by registered key is dual-package safe.
- **Policy 4xx surface.** The org endpoints answer a bogus `organizationId` with 401 `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`
  (`BA/plugins/organization/organization.ts:268-276`; EXP-3), and `getActiveMemberRole` with 403
  `YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION` (`routes/crud-members.ts:1118-1125`). No attacker-supplied input drives a
  built-in policy into Z2's "another 4xx → 500" branch.

No earlier BA finding regressed. The three new findings are all minor and all about documentation that states a
better-auth fact incorrectly: one third-party sketch that would answer 401 to every valid token, one boot message that
misdiagnoses a common NestJS setup, and one rejected-alternative rationale that is factually wrong.

| Id       | Sev   | Title                                                                                                                                                                                                                           |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA-r5-01 | minor | The §4.3.4 JWT sketch verifies with `issuer`/`audience` = the baseURL **with its basePath**; better-auth mints `iss`/`aud` as the baseURL **origin**, so every valid token answers 401 `INVALID_JWT`                            |
| BA-r5-02 | minor | better-auth's `isProduction` is a module-load snapshot of `NODE_ENV`, not a live read: with `NODE_ENV` loaded from `.env` by `@nestjs/config`, B30's diagnosis and first hint are wrong and the boot summary contradicts itself |
| BA-r5-03 | minor | §8.3 and §17 Q9 reject the pure org `hasPermission` export because it "writes to an unbounded process-global role cache"; the endpoint the shipped policy calls writes to that same `cacheAllRoles` Map on every call           |

## Prior findings

### Round 4 (BA)

| Id       | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA-r4-01 | resolved | §8.3's session path is `userHasPermission({ body: { userId, permissions } })` without headers or role, which is legal (no `requireHeaders`, `routes.ts:1804-1808`) and makes better-auth apply its own NULL-role, `defaultRole` and `adminUserIds` handling. EXP-3 on 1.7.0 and 1.7.4: NULL role → `success:false` (v4's call → `400 VALIDATION_ERROR`); deleted user → `400 {"message":"user not found"}` with no body code, which §8.3 and §13.2 match by status + message and map to 401 `USER_NOT_FOUND`. The delegated path keeps its own row read for the ban rule and passes `role` only for a non-empty string, so the same endpoint read happens for NULL and `''`. LEAD-EXP-11's claim is corrected in place, §13.2 records the v4 regression, and `Z-admin-null-role` pins it. |
| BA-r4-02 | resolved | `AuthContextView.rateLimit` plus `options.rateLimit`, B30 `W_RATE_LIMIT_DISABLED`, the B22 summary line, and B18/B27/`W_PROXY_UNTRUSTED` rewording. The check reads `$context.rateLimit.enabled`, not `NODE_ENV`, so it is right even when the two disagree; both fields exist at 1.7.0. Q35's recommended option (a) is applied. The message's wording is BA-r5-02.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| BA-r4-03 | resolved | T5 requires the leg's `host`/`x-forwarded-*` on every credential mapping including `subscriptionCredentials`, §9.2 and the §9.2 table say so, B20 records that the GraphQL and WS units declare no host-less calls, and `T-dynamic-base-url` plus a GraphQL matrix row pin it. The rejected alternative (declaring `hostlessCalls` when an override is set) was rejected for the right reason.                                                                                                                                                                                                                                                                                                                                                                                            |
| BA-r4-04 | resolved | §4.3.4 states that `verifyJWT` reports storage failures as `payload: null` and no longer uses it; the jose sketch lets a `getJwks` throw propagate (5xx) and maps only jose verification codes to `rejected`. RK18's upstream proposal names `verifyJWT`. The original failure scenario is gone; the replacement sketch's claim check is BA-r5-01.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| BA-r4-05 | resolved | B03 fails boot with `PLUGIN_SHARED_BETWEEN_INSTANCES` when two instances resolve the same `Symbol.for(…:bridge)` handle, `BridgeBinding.instance` exists, and `bind()`'s same-owner branch throws for a different instance instead of returning a no-op registration (§10.2). §5.5, §10.6 and migration step 3 state the one-`nestjs()`-per-instance rule, and B04 bumps the protocol to 4.                                                                                                                                                                                                                                                                                                                                                                                               |

### Earlier rounds

BA-r1-01 to BA-r1-11, BA-r2-01 to BA-r2-09 and BA-r3-01 to BA-r3-05 still hold as fixed. The ones v5 touched were
re-checked: BA-r1-10's 401 `USER_NOT_FOUND` mapping survives the BA-r4-01 rewrite (§8.3 deny column, §13.2 item 4);
BA-r2-06's endpoint-result observer is unchanged and still cannot see a before-hook short-circuit; BA-r3-01's
"coded 401 denies 403, generic 401 re-reads only for a `sessionBacked` source" survives the SEC-r4-04 memoization, which
only shares the re-read across the request; BA-r3-02's stored role is now read by better-auth itself, which is strictly
closer to `adminMiddleware`; BA-r3-05's `customSession` caveat is repeated at §8.1, §7.7 RK2 and §11.5.

## New findings

### BA-r5-01 (minor): The §4.3.4 JWT sketch verifies against `this.baseURL`, but better-auth mints `iss`/`aud` as the baseURL **origin**, so every valid token is rejected 401

- **Section:** §4.3.4, the JWT-plugin sketch (`jwtVerify(token, createLocalJWKSet(jwks), { issuer: this.baseURL, audience: this.baseURL })`),
  and the sentence after it about `createRemoteJWKSet`. Introduced in v5 as the fix for BA-r4-04.
- **Failure scenario:**
  1. A team follows §4.3.4 to build a JWT principal source. The only `baseURL` the design ever names is
     `(await auth.$context).baseURL` — §6.2 resolves the mount from `new URL((await auth.$context).baseURL).pathname`, and
     §2.2 exposes it as `AuthContextView.baseURL`. So `this.baseURL` is naturally `http://localhost:3000/api/auth`.
  2. better-auth's JWT plugin signs with `iss = options?.jwt?.issuer ?? baseURLOrigin` and
     `aud = options?.jwt?.audience ?? baseURLOrigin`, where `baseURLOrigin` is `ctx.context.options.baseURL`
     (`BA/plugins/jwt/sign.ts:289-302`) — and `$context.options.baseURL` is `new URL(baseURL).origin`
     (`BA/context/create-context.ts:192-196`), i.e. `http://localhost:3000`, **without** the basePath.
  3. jose's claim check therefore fails for every well-formed, unexpired, correctly signed token with
     `ERR_JWT_CLAIM_VALIDATION_FAILED`, which the sketch's `REJECT` set contains
     (`'ERR_JWT_CLAIM_VALIDATION_FAILED'`), so the source returns `rejected(401 INVALID_JWT)`.
  4. Every machine client authenticating with a better-auth-issued JWT gets 401 on every request, and the design's own
     guidance tells them the token is invalid. It fails closed, but the source is unusable as written, and the failure looks
     like a signing problem rather than a claim mismatch. `verifyJWT`, which the sketch replaced, used
     `options?.jwt?.issuer ?? baseURLOrigin` too (`BA/plugins/jwt/verify.ts:52-58`), so it never had this mismatch.
- **Evidence:** EXP-1 / EXP-3 (`exp1-jwt-issuer.mjs`, `exp3.mjs`), identical on 1.7.4 and 1.7.0:
  ```
  $context.baseURL = http://localhost:3000/api/auth | $context.options.baseURL = http://localhost:3000
  token iss/aud = "http://localhost:3000" "http://localhost:3000"
    jwtVerify(iss=aud=http://localhost:3000/api/auth) -> ERR_JWT_CLAIM_VALIDATION_FAILED: unexpected "iss" claim value
    jwtVerify(iss=aud=http://localhost:3000) -> OK
  ```
  Source: `BA/plugins/jwt/sign.ts:289-302`; `BA/context/create-context.ts:192-196, 285`.
- **Suggested fix:**
  - In the sketch, verify against the **origin**: `const iss = new URL(ctx.baseURL).origin` (or `ctx.options.baseURL`, which
    better-auth already normalizes to the origin), and say in one clause that better-auth's JWT plugin defaults `iss` and
    `aud` to the baseURL origin, not to `$context.baseURL`, and that `jwt: { issuer, audience }` overrides both.
  - Keep the `createRemoteJWKSet` note but point it at `new URL('/api/auth/jwks', <origin>)` derived the same way.
  - Add the claim to the lead-verification list next to LEAD-V53, and cover it in whatever fixture exercises §4.3.4
    (a valid token must verify; a token minted with a different `jwt.issuer` must be `rejected`, not a 5xx).

### BA-r5-02 (minor): better-auth's `isProduction` is a module-load snapshot of `NODE_ENV`; with `NODE_ENV` supplied by `@nestjs/config`, B30 misdiagnoses and the boot summary contradicts itself

- **Section:** §5.4's definition of "in production" ("better-auth keys its own production defaults on `NODE_ENV === 'production'`,
  the default secret check and **the rate limiter** among them"), B30's message, B22's `rate limit: off (NODE_ENV unset; …)`
  summary field, §15.1 step 9, LEAD-V48 and LEAD-V52, and the `LIB-environment` rows. This finding keeps Q33's and Q35's
  decisions; it reports a defect under them.
- **Failure scenario:** `@better-auth/core/env` computes

  ```ts
  export const nodeENV = env.NODE_ENV ?? "";
  export const isProduction = nodeENV === "production";
  ```

  (`CORE/env/env-impl.ts:47-52`). `nodeENV` and `isProduction` are **module-load-time constants**, unlike the sibling
  `isTest()` and `isDevelopment()`, which are functions. Whatever `NODE_ENV` is when `auth.ts` first imports `better-auth`
  is what better-auth uses for the rest of the process.

  A NestJS application that follows Nest's own documented configuration pattern:
  1. `app.module.ts` has `import { auth } from './auth'` and `ConfigModule.forRoot({ envFilePath: '.env' })`, with
     `NODE_ENV=production` in `.env` and nothing in the container's process environment. ES imports are evaluated before the
     `@Module` decorator runs, so `auth.ts` — and with it `@better-auth/core/env` — is loaded while `NODE_ENV` is still unset.
  2. `ConfigModule.forRoot()` then sets `process.env.NODE_ENV = 'production'`, before any `onModuleInit`.
  3. better-auth's rate limiter is off and its default-secret guard is disarmed, although `process.env.NODE_ENV` reads
     `production` everywhere the library looks.

  What the operator sees at boot:
  - `environment: production (NODE_ENV=production)` — the library reads `process.env.NODE_ENV` at `onModuleInit`;
  - `rate limit: off (…)` — B22 has only two reason templates, "`NODE_ENV unset`" and "`rateLimit.enabled: false`", and
    neither is true here;
  - `W_RATE_LIMIT_DISABLED`: "Set `NODE_ENV=production` or `rateLimit: { enabled: true }`" — the first option is already
    done, in the file the team considers authoritative, and doing it again changes nothing. Only the second works, and
    nothing tells the operator why.

  §5.4's statement of better-auth's rule ("`NODE_ENV === 'production'`") and migration step 9's advice ("should set
  `NODE_ENV=production`") are both incomplete for the same reason. B29 is unaffected because it compares the _resolved_
  `$context.secret` rather than the environment — that is the pattern B30 already follows for the check itself, and only its
  wording lags.

- **Evidence:** EXP-4 `exp4-env-snapshot.mjs`, identical on 1.7.4 and 1.7.0:
  ```
  at import time NODE_ENV = undefined
  at betterAuth() time NODE_ENV = "production"
  $context.rateLimit.enabled = false
  $context.options.rateLimit = undefined
  $context.secret is better-auth default = true          <- validateSecret did not throw
  library "production" (NODE_ENV not development/dev/test) = true
  ```
  Contrast `rl.mjs`, where `NODE_ENV` is in the process environment from the start: `production` → `rateLimit.enabled=true`.
  Source: `CORE/env/env-impl.ts:44-59`; `BA/context/create-context.ts:66-72, 354-360`.
- **Suggested fix:**
  - Record the snapshot as a fact next to LEAD-V48/LEAD-V52: better-auth's `isProduction` is `NODE_ENV` **as it was when
    `@better-auth/core/env` was first imported**; `isTest()` and `isDevelopment()` are re-evaluated, `isProduction` is not.
  - Reword `W_RATE_LIMIT_DISABLED` so it leads with what is observed and what always works: "better-auth resolved
    `rateLimit.enabled = false`. It enables the limiter only when `NODE_ENV=production` is set **in the process environment
    before `auth.ts` is imported** — a value loaded later by `@nestjs/config` or dotenv comes too late. Set it in the process
    environment (Dockerfile, systemd unit, platform config), or set `rateLimit: { enabled: true }`."
  - Give B22 a third reason template for "the limiter is off while `process.env.NODE_ENV` says production", so the summary
    line never contradicts its own `environment:` field, and say the same in §5.4 and in migration step 9.
  - Add a `LIB-environment` row that sets `NODE_ENV` after importing better-auth and asserts `W_RATE_LIMIT_DISABLED` with
    the new wording; the same row documents why B29 compares `$context.secret` instead of the environment.

### BA-r5-03 (minor): The org policy's endpoint populates the very `cacheAllRoles` Map that §8.3 and Q9 give as the reason for not using the pure export

- **Section:** §8.3 "Deliberately not shipped" ("The pure (in-process) org `hasPermission` export. It saves the session read
  but writes to an unbounded process-global role cache (R:ba-authz pitfalls). Revisit after measuring (§17 Q9)"), and §17 Q9
  ("**Endpoint in 1.0.** It has exact semantics, including dynamic access control, and avoids the unbounded process-global
  `cacheAllRoles`"). Related: §7.9's cost model and §17.2's risk register, which mention neither.
- **Failure scenario:**
  1. `cacheAllRoles` is a module-level `new Map()` with no eviction (`BA/plugins/organization/permission.ts:33-38`;
     1.7.4 dist `plugins/organization/permission.mjs:12`).
  2. The organization plugin's `hasPermission` helper ends with an **unconditional**
     `cacheAllRoles.set(input.organizationId, acRoles)` — outside the `useMemoryCache` branch and outside the
     `dynamicAccessControl` branch (`BA/plugins/organization/has-permission.ts:75`).
  3. `/organization/has-permission`, the endpoint `orgPermission()` / `@RequireOrgPermission` calls on every check, goes
     through that helper (`BA/plugins/organization/organization.ts:278-284`). So does `hasPermission` reached any other way.
  4. In a multi-tenant deployment with N organizations, N entries accumulate in a process-global Map over the life of the
     process, each holding the organization's `Role` objects (with `dynamicAccessControl.enabled`, the roles loaded from
     `organizationRole` for that organization). RSS grows monotonically and never shrinks; a restart is the only reclaim.

  The consequences for the design are two: the reason §8.3 and Q9 give for rejecting the pure export does not distinguish
  the two options at all — both populate the same Map — so the recorded trade-off is wrong; and the growth the design
  attributes to the road not taken is a property of the road it did take, recorded nowhere (not in §7.9's cost list, not in
  §17.2's risks, not in RK1's list of better-auth internals the library depends on). An operator reading §8.3 concludes the
  library avoided it.

  The exposure is bounded by membership, not by attacker input: a non-member organization id throws
  `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` before the helper runs, so a caller cannot inflate the Map with random ids.
  That is why this is minor rather than an availability finding.

- **Evidence:** EXP-2 / EXP-3, identical on 1.7.4 and 1.7.0. Three real organizations, each checked once through
  `auth.api.hasPermission` (no `dynamicAccessControl`, no `useMemoryCache`):
  ```
  cacheAllRoles before = 0
  cacheAllRoles after 3 orgs = 3
  ```
  and with three non-member ids in the same run:
  ```
  bogus org -> APIError 401 {"message":"User is not a member of the organization","code":"USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION"}   (x3)
  cacheAllRoles size after = 1        <- only the organization the caller belongs to
  ```
  Source: `BA/plugins/organization/permission.ts:33-38`; `BA/plugins/organization/has-permission.ts:26-76`;
  `BA/plugins/organization/organization.ts:252-290`.
- **Suggested fix:**
  - Correct §8.3's bullet and Q9's answer: the endpoint is kept for **exact semantics** (`orgSessionMiddleware`, dynamic
    access control, `creatorRole`, comma-separated roles) and for not reimplementing the member lookup — not because it
    avoids `cacheAllRoles`, which it populates on every call exactly as the pure export does. Keep the decision (endpoint in
    1.0); only the rationale changes.
  - Add the Map to RK1's list of better-auth internals the design's behavior depends on, and a one-line risk in §17.2: one
    never-evicted entry per organization the application authorizes against, per process. Note the mitigation available
    today (bound the number of distinct organizations per process, or restart policy) and add it to the upstream proposal
    list next to the `verifyApiKey` and `getSessionFromCtx` items: `cacheAllRoles` should be bounded (LRU) or keyed to the
    request.
  - If §7.9 keeps a per-requirement cost table, note that `orgPermission()` also costs one Map insertion, so a later
    measurement of Q9 compares like with like.

## Product questions proposed

None. BA-r5-01 and BA-r5-03 are corrections, not trade-offs. BA-r5-02 is a defect under the existing Q33 and Q35
decisions and its fix keeps both: B30 still warns rather than failing (Q35 option (a)), and "production unless `NODE_ENV`
says otherwise" (Q33) is unchanged — only the library's account of _better-auth's_ own rule and the wording of one warning
need correcting.
