---
reviewer: BA
round: 6
reviewed: design-v6.md
verdict: reject
blockers: 0
majors: 1
minors: 2
prior_unresolved: []
---

# Round 6 review: BA (better-auth fidelity)

Input: `design-v6.md`. Verdict: **reject** (0 blockers, 1 major, 2 minors).

Experiments: `/tmp/nsba/tmp-r6-review-BA/`. The root tree reuses the round-5 npm tree at better-auth 1.7.4 /
@better-auth/api-key 1.7.4 / jose 6.2.12; `v170/` is the same set of scripts against better-auth 1.7.0, the D4 floor.
Scripts: `exp1-beforehook-cookies.mjs`, `exp2-origin-flags.mjs`, `exp3-shortcircuit-cookies.mjs`. **Every result below is
identical on 1.7.0 and 1.7.4.** Source citations are against `/tmp/nsba/better-auth` at 1.7.4 unless a dist file is named.

## Summary

All three round-5 BA findings are resolved, and the fixes introduced no new problems: the §4.3.4 JWT sketch now derives
`iss`/`aud` from the baseURL **origin** and states the `jwt: { issuer, audience }` escape for dynamic configurations;
LEAD-V58 records the `NODE_ENV` import-time snapshot and B30/B22/§5.4/migration step 9 all lead with the resolved value;
§8.3, §17 Q9, RK37 and §7.9 now attribute `cacheAllRoles` to the road taken. I re-verified the load-bearing mechanisms
against the source and at runtime and found them faithful: the hook pipeline and `getHooks` ordering
(`BA/api/dispatch.ts:137-220, 222-262, 269-305`), the short-circuit return shape (`:386-393`), `producedByEndpoint`'s
premise that after-hooks never run for a short-circuit, `getAuthoritativeSessionFromCtx`'s stateful/stateless split
(`BA/api/routes/session.ts:519-539`), the headerless `userHasPermission` path (`BA/plugins/admin/routes.ts:1862-1899`,
including `$Infer.body` being the source of `AdminPermissions`), `getActiveMemberRole`'s 403
`YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION` (`routes/crud-members.ts:1083-1130`), `getIP`'s `ipAddressHeaders` +
`trustedProxies` handling (`CORE/utils/ip.ts:287-383`), the `defu(options, restOpts)` plugin-option merge
(`BA/context/helpers.ts:52`, user array first, ours appended), `getTrustedOrigins` being recomputed per request on the
handler's context clone (`BA/auth/base.ts:96-100`), `freshSessionMiddleware`'s `freshAge` rule
(`api/routes/session.ts:598-616`), the bearer plugin being a `hooks.before` (so `auth.api` calls do see it,
`BA/plugins/bearer/index.ts:44-113`), and `kAPIErrorHeaderSymbol` = `Symbol.for("better-call:api-error-headers")`
(`better-call@1.4.0 dist/error.mjs:134`). I also confirmed every `better-auth/api`, `better-auth/cookies` and
`better-auth/plugins/access` symbol the plugin imports exists at the 1.7.0 floor.

The three new findings are all about the _mirror_ of better-auth's behaviour rather than about the library's own
machinery:

| Id       | Sev   | Title                                                                                                                                                                                                                                                                                                                                      |
| -------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BA-r6-01 | major | `skipOriginCheck === true` disables `validateOrigin` **unconditionally**, not only when `disableCSRFCheck` is `undefined`: with `{ disableOriginCheck: true, disableCSRFCheck: false }` better-auth's own unsafe routes are unprotected, the kernel still checks app routes, B19 is silent and `LIB-origin-differential` has no row for it |
| BA-r6-02 | minor | §10.5 documents cookie loss only for a _throwing_ before-hook; a non-throwing before-hook's `ctx.setCookie`/`setHeader` are discarded too whenever the endpoint runs, and survive only when a later hook short-circuits                                                                                                                    |
| BA-r6-03 | minor | The §4.3.4 JWT sketch's `new URL((await r.auth.$context).baseURL).origin` throws `TypeError: Invalid URL` for an **unset** `baseURL`, where `$context.baseURL` is `''` — the fix text covers only the dynamic `{ allowedHosts }` case                                                                                                      |

## Prior findings

### Round 5 (BA)

| Id       | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BA-r5-01 | resolved | §4.3.4 line 2300 derives the issuer as `this.options.issuer ?? new URL((await r.auth.$context).baseURL).origin`, the paragraph at 2314 states better-auth's rule with `BA/plugins/jwt/sign.ts:289-302` and `BA/context/create-context.ts:190-196`, LEAD-V57 records it, `S-jwt-claims` (§14.1) asserts that a `signJWT` token verifies, that a token minted under a different `jwt.issuer` is `rejected` and that a failing `jwks` read is 5xx, and RK1 lists the surface. Verified against `create-context.ts:188-196`: `options.baseURL = baseURL ? new URL(baseURL).origin : ""`, while `ctx.baseURL = baseURL \|\| ""` carries the basePath. The remaining gap is the **unset**-baseURL case, reported as BA-r6-03. |
| BA-r5-02 | resolved | LEAD-V58 states the snapshot exactly as `CORE/env/env-impl.ts:48-58` implements it (`nodeENV` and `isProduction` are module-load constants; `isDevelopment()`/`isTest()` compare the same frozen `nodeENV`; only `toBoolean(env.TEST)` is live). §5.4's new _What/When_ split, B22's third reason template, B30's import-time wording, migration step 9 and the `LIB-environment` late-`NODE_ENV` row all follow, and B29/B30 keep comparing `$context.secret` / `$context.rateLimit.enabled` rather than the environment. The original contradiction (an `environment: production` line next to a `rate limit: off (NODE_ENV unset)` line and a hint to set a variable already set in `.env`) cannot occur any more.   |
| BA-r5-03 | resolved | §8.3's bullet now says "**This is not a memory trade-off**" and attributes the unconditional `cacheAllRoles.set` to the shipped endpoint path; §17 Q9's rationale is corrected while keeping the decision; RK37 and §7.9's "Process memory, not per request" bullet record the growth; RK1 lists the `Map`; the upstream proposal asks for an LRU. LEAD-V59 matches `BA/plugins/organization/has-permission.ts:75` and `permission.ts:33-38`.                                                                                                                                                                                                                                                                           |

### Earlier rounds

BA-r1-01 to BA-r1-11, BA-r2-01 to BA-r2-09, BA-r3-01 to BA-r3-05 and BA-r4-01 to BA-r4-05 still hold as fixed; none was
broken by v6. The ones v6's edits came closest to were re-checked:

- **BA-r2-01** (short-circuited `/get-session` returns no `Headers`). `dispatch.ts:386-393` still returns
  `{ headers: responseHeaders, response: before }` with `responseHeaders` `undefined` unless a hook set one; §7.3 line
  3119 still guards with `result.headers?.getSetCookie() ?? []`. Confirmed at runtime in `exp3` (short-circuit row).
- **BA-r2-06 / BA-r4-01** (authoritative reads and the admin call). `getAuthoritativeSessionFromCtx` and the headerless
  `userHasPermission` path are unchanged in 1.7.4, and the v6 text is unchanged.
- **BA-r1-02 / SEC-r1-03** (credential-matched forwarding). Entry 6's `sameCredential` still reads
  `ctx.context.authCookies.sessionToken.name`, which `getCookies` builds **with** the `__Secure-` prefix
  (`BA/cookies/index.ts:74-105`), so the comparison uses the name the browser actually sends.
- **BA-r4-05** (one plugin object per instance). B03 and `bind()`'s `PLUGIN_SHARED_BETWEEN_INSTANCES` branch are
  unchanged.

One observation that is **not** a finding: §7.3 applies the `producedByEndpoint` gate on authoritative reads
unconditionally, while better-auth's `getAuthoritativeSessionFromCtx` accepts a hook-supplied `ctx.context.session` on a
**stateless** deployment (`api/routes/session.ts:526-539`: the `!isStateful(ctx)` branch calls `getSessionFromCtx(ctx)`,
which returns `ctx.context.session` when a hook set it). The design is therefore stricter there than the parity sentence
in §7.3 claims. I did not raise it because the case is unreachable in practice: a DB-less, secondary-storage-less
deployment has no `apikey` table and no `findUserById`, so neither the api-key session mock nor `@RequirePermission` can
exist there, and only a hand-written `@BeforeAuth` hook that returns `{ context: { context: { session } } }` could
produce the divergence — in the safe direction.

## New findings

### BA-r6-01 (major): `skipOriginCheck === true` skips `validateOrigin` whatever `disableCSRFCheck` says, so `{ disableOriginCheck: true, disableCSRFCheck: false }` leaves better-auth's own routes unchecked while the kernel keeps checking app routes, with no B19 warning and no differential row

- **Section:** §7.10 "When it applies" step 4; §7.5's caller-session bullet ("better-auth's own flags switch the origin
  check off (`skipCSRFCheck`, `skipOriginCheck`)"); B19 (§5.4); LEAD-V16 and LEAD-V18; `LIB-origin-differential`
  (§14.5) and `T-csrf-http-unsafe` (§14.1).
- **What the design says.** §7.10 step 4: "`$context.skipCSRFCheck` (`advanced.disableCSRFCheck`), and the
  backward-compatible `skipOriginCheck === true && disableCSRFCheck === undefined`, turn it off **exactly as on
  better-auth's routes** (LEAD-V18). … Path-array `skipOriginCheck` entries name auth-route paths and are ignored here."
  B19 warns for exactly those two conditions and states "Both better-auth's routes and this library's origin check are
  then off (§7.10 step 4)."
- **What better-auth does.** `validateOrigin` has **three** independent early returns, in this order
  (`BA/api/middlewares/origin-check.ts:231-245`):

  ```ts
  if (ctx.context.skipCSRFCheck) return;                  // advanced.disableCSRFCheck
  if (shouldSkipCSRFForBackwardCompat(ctx)) { … return; } // skipOriginCheck === true && disableCSRFCheck === undefined
  if (shouldSkipOriginCheck(ctx)) return;                 // skipOriginCheck === true  — UNCONDITIONAL — or a path-array match
  ```

  `shouldSkipOriginCheck` (`:26-49`) returns `true` for `skipOriginCheck === true` **whatever `disableCSRFCheck` is**.
  The design's mirror folds better-auth's second and third returns into one and therefore misses the combination
  `skipOriginCheck === true` **with** `disableCSRFCheck` defined as `false`. `validateFormCsrf` inherits the same skip,
  because it delegates to `validateOrigin` (`:334, 361, 370`); only its `Sec-Fetch-Site: cross-site` +
  `Sec-Fetch-Mode: navigate` block still fires.

- **Failure scenario.** A team reads better-auth's own deprecation warning — "_disableOriginCheck: true currently also
  disables CSRF checks. In a future version, disableOriginCheck will ONLY disable URL validation. To keep CSRF disabled,
  add disableCSRFCheck: true to your config_" (`origin-check.ts:56-61`, logged on every boot with
  `disableOriginCheck: true`) — and, wanting the opposite of what the hint offers, writes
  `advanced: { disableOriginCheck: true, disableCSRFCheck: false }` to keep CSRF **on** while dropping URL validation.
  On better-auth 1.7.0 through 1.7.4:

  1. `POST /api/auth/update-user` with the victim's cookie and `Origin: https://evil.example` answers **200**
     `{"status":true}` through the mount. So do `/change-password`, `/delete-user`, `/sign-out` and every other unsafe
     better-auth route. The user believes CSRF is on.
  2. **B19 says nothing.** `$context.skipCSRFCheck` is `false` (`!!false`), and the backward-compatible condition is
     false because `disableCSRFCheck !== undefined`. Neither of B19's two bullets matches, so the single boot check whose
     stated purpose is "_warn … when an origin check is effectively off, naming the cause_" stays silent in a
     configuration where better-auth's own credential routes have no origin check at all. The boot summary prints
     `origin check: cookie/reject`, which is true of the library and false of better-auth.
  3. **The library diverges in the opposite direction on its own surface.** The plan's `originCheck` stays `'cookie'`,
     so every unsafe app route, GraphQL mutation and WebSocket message that carries a cookie is still validated: the
     same browser that just succeeded against `/api/auth/update-user` gets 403 `INVALID_ORIGIN` from
     `POST /reports`. §7.10 promises "better-auth's own rules, and only those" and "no exemption better-auth does not
     make"; here the kernel makes a _restriction_ better-auth does not make, and §7.10's denial log tells the operator to
     add the origin to `trustedOrigins` — advice that contradicts the flag they deliberately set.
  4. **§7.5 and §7.10 disagree about the same flag.** `ScopeView.checkCallerSession` passes when "better-auth's own
     flags switch the origin check off (`skipCSRFCheck`, `skipOriginCheck`)" — `skipOriginCheck` unqualified. So in this
     configuration the caller-session check treats the origin rule as off while the guard treats it as on. Two parts of
     one mechanism read one flag two ways; that is the kind of split NEST-r5-05 was raised for on the public-plan rule.
  5. **The drift detector cannot catch it.** `LIB-origin-differential` (§14.5) is the differential that exists to prove
     the mirror matches `validateOrigin`/`validateFormCsrf`, and its case list is "`disableCSRFCheck`, the
     backward-compatible `disableOriginCheck` skip" — the two cases the design already models. The third skip has no
     row, so the divergence survives every future refactor. `T-csrf-http-unsafe` has the same gap
     (`advanced.disableCSRFCheck` only).

- **Evidence:** `exp2-origin-flags.mjs`, run in the 1.7.4 tree and in `v170/`, identical output (POST `/update-user`
  with the session cookie and `Origin: https://evil.example`, `TEST=false` so `isTest()` does not interfere):

  ```
  (none)                                             | skipCSRFCheck= false skipOriginCheck= false | status 403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}
  disableOriginCheck: true                           | skipCSRFCheck= false skipOriginCheck= true  | status 200 {"status":true}
  disableOriginCheck: true + disableCSRFCheck: false | skipCSRFCheck= false skipOriginCheck= true  | status 200 {"status":true}
  disableCSRFCheck: true                             | skipCSRFCheck= true  skipOriginCheck= false | status 200 {"status":true}
  ```

  Row 3 is the one neither §7.10 step 4 nor B19 models. Source: `BA/api/middlewares/origin-check.ts:15-49, 222-245,
316-372`; `BA/context/create-context.ts:396-403`.

- **Suggested fix:**
  - Correct **LEAD-V16/LEAD-V18** to list better-auth's three skips separately: `skipCSRFCheck`; the
    backward-compatible skip; and `shouldSkipOriginCheck`, which is `skipOriginCheck === true` **unconditionally** or a
    path-array match on the request path.
  - **B19** (this is the part that must change whatever §7.10 decides): fire whenever
    `$context.skipCSRFCheck || $context.skipOriginCheck === true`, and add the third cause to the message —
    "`advanced.disableOriginCheck: true` disables better-auth's own origin and form-CSRF validation on every auth route
    whatever `disableCSRFCheck` says; `disableCSRFCheck: false` does not re-enable it." Add a non-empty path-array
    `skipOriginCheck` as an _info_ line for the same reason, naming the auth paths it exempts.
  - **§7.10 step 4 and §7.5**: state one rule in one place and have both refer to it. My recommendation is the
    proposed Q39 below: keep the kernel's check **on** for `skipOriginCheck === true` with `disableCSRFCheck` defined
    (it is the stricter direction, and the design already takes it for path-array skips), record it in §7.10 as a
    second **deliberate, documented divergence** next to the path-array one, and have B19's message name both halves so
    the operator can see why auth routes and app routes answer differently. Whichever option is taken, §7.5's bullet
    must be rewritten to the same predicate.
  - Add the row to `LIB-origin-differential` as an **expected divergence** (router allows, kernel denies), and to
    `T-csrf-http-unsafe`, so the combination is pinned rather than unmodelled. Add a `LIB-environment` assertion that
    B19 warns for `{ disableOriginCheck: true, disableCSRFCheck: false }`.

### BA-r6-02 (minor): §10.5 records cookie loss only for a _throwing_ before-hook; better-auth discards a non-throwing before-hook's `ctx.setCookie`/`setHeader` too whenever the endpoint runs

- **Section:** §10.5's semantics table (rows `before → undefined`, `before → { context }`, `before → throws`) and its
  closing paragraph: "Nothing is re-wrapped, so `ctx.setCookie`, `ctx.json` and `ctx.redirect` behave as in native
  hooks." Also §10.2's entry-order bullet, which states the cookie-bridge guarantee only for _after_-hooks.
- **Failure scenario.**
  1. A team writes a Nest hook `@BeforeAuth('/sign-in/email') stampDevice(ctx: AuthHookContext<'/sign-in/email'>) {
ctx.setCookie('device_id', id, { path: '/', httpOnly: true }); }` — a shape the design invites, because §10.5
     promises `ctx.setCookie` behaves as in a native hook and §11.4 types `AuthHookContext` for exactly this.
  2. The hook runs, `ctx.setCookie` appends to the hook endpoint's own `responseHeaders`, and `runBeforeHooks` merges
     them into the dispatch accumulator with `mergeResponseHeaders(context.context, result?.headers)`
     (`BA/api/dispatch.ts:193`).
  3. The endpoint then runs, and the dispatch **overwrites** the accumulator with the endpoint's own headers:
     `internalContext.context.responseHeaders = result.headers ?? undefined` (`dispatch.ts:427`). better-call builds a
     fresh `const headers = new Headers()` per endpoint invocation (`better-call@1.4.0 dist/context.mjs:8, 78`), so the
     before-hook's cookie is gone. It is gone for the HTTP response, for the `auth.api` caller's `returnHeaders`, for
     every after-hook, and therefore for the design's own cookie bridge (entry 6) and for
     `apiErrorSetCookies`. The same is true of `ctx.setHeader`.
  4. The loss is **silent and order-dependent in a way the design does surface elsewhere**: the identical hook's cookie
     _is_ delivered when a later before-hook short-circuits, because that path returns
     `{ headers: context.responseHeaders, response: before }` (`dispatch.ts:386-393`). So the hook works in the one case
     §10.5 documents as lossy (a short-circuit is the only thing that keeps it) and fails in the two cases §10.5
     documents as normal. A team debugging this reads §10.5, finds only "before → throws … cookies set in that hook are
     lost", and concludes their non-throwing hook should work.
- **Evidence:** `exp1-beforehook-cookies.mjs` and `exp3-shortcircuit-cookies.mjs`, identical on 1.7.4 and 1.7.0. A
  plugin before-hook on `/get-session` and `/sign-up/email` calls `c.setCookie('before_hook_cookie','yes')` and
  `c.setHeader('x-before-hook','1')`:

  ```
  --- sign-up (endpoint runs) ---
    [after-hook] ctx.context.responseHeaders set-cookie = ["better-auth.session_token=…"] | x-before-hook = null
    returned headers set-cookie = ["better-auth.session_token=…"]        <- the hook's cookie is absent
  --- get-session (endpoint runs) ---
    [after-hook] ctx.context.responseHeaders set-cookie = [] | x-before-hook = null
    returned headers set-cookie = []
  --- via router (HTTP) ---
    router set-cookie = []   router x-before-hook = null
  ```

  and the short-circuit control:

  ```
  shortCircuit = false | set-cookie = []                       | response = null
  shortCircuit = true  | set-cookie = ["hook_cookie=1; Path=/"] | response = {"shortCircuited":true}
  ```

  Source: `BA/api/dispatch.ts:85-99, 193, 386-393, 426-427`; `better-call@1.4.0 dist/context.mjs:8, 50-58, 78`.

- **Suggested fix:**
  - Add a row to §10.5: "before → `undefined` or `{ context }`, having called `ctx.setCookie`/`ctx.setHeader` → the
    endpoint's own response headers replace the accumulator, so those cookies and headers are **dropped**; they survive
    only when a later before-hook short-circuits (`dispatch.ts:427` vs `:386-393`)." Mark it UNVERIFIED-free with this
    experiment's citation.
  - Qualify the closing paragraph: `ctx.setCookie` behaves as in a native hook, and in a _before_-hook that means it has
    no effect on a dispatch that reaches the endpoint. Point users at `@AfterAuth`, whose cookies the bridge does
    forward (§10.2 entry 6), or at `{ context: { headers } }` for _request_-header rewrites, which is the one before-hook
    mutation better-auth does apply (`dispatch.ts:368-381`).
  - Add the case to `LIB-dispatcher-parity` (§14.5): a hook that sets a cookie must produce the same observable result
    as the same function registered as a native plugin, in both the endpoint-runs and the short-circuit paths — which is
    the property that keeps the documented table honest across minors.
  - Put `ctx.context.responseHeaders` being replaced by the endpoint's headers into RK1's list next to
    "`ctx.context.responseHeaders`/`returned` in after-hooks"; today that entry reads as if the accumulator were
    cumulative.

### BA-r6-03 (minor): the §4.3.4 JWT sketch throws `TypeError: Invalid URL` when `baseURL` is unset, the design's own documented `$context.baseURL === ''` case

- **Section:** §4.3.4, line 2300 (`this.issuer ??= this.options.issuer ?? new URL((await r.auth.$context).baseURL).origin`)
  and the two consequence bullets at 2316-2317, which name only the dynamic `{ allowedHosts }` case. Introduced in v6 as
  the fix for BA-r5-01.
- **Failure scenario.**
  1. `$context.baseURL` is `baseURL || ""` (`BA/context/create-context.ts:285`), and `baseURL` is `undefined` both for a
     dynamic config and when no `baseURL`/`BETTER_AUTH_URL` is set (`:144-149`). §6.2's own comment states this:
     "unset or dynamic `{ allowedHosts }`: `ctx.baseURL === ''`".
  2. An unset `baseURL` is the **default development configuration** — B23 fails boot for it only in production, and
     §6.2 calls it "a development-only configuration", not an impossible one.
  3. A team follows §4.3.4 to build a JWT principal source and runs it locally. `new URL('')` throws
     `TypeError: Invalid URL`. The throw happens in `resolve()`, so §4.3.4's own error rule sends it on as
     infrastructure: `BetterAuthInfrastructureError` → 5xx, ERROR-logged, on **every** request that carries a Bearer
     token, before any verification is attempted. The symptom ("Invalid URL" in a JWT source) points nowhere near the
     cause.
  4. The bullet that would have warned them covers only "under a **dynamic** `baseURL` … `$context.options.baseURL` is
     not a string, so better-auth signs `iss`/`aud` = `''`". The unset case has the same consequence for better-auth's
     signing (`options.baseURL = baseURL ? new URL(baseURL).origin : ""` → `iss = aud = ''`) **and**, unlike the dynamic
     case, makes the sketch's own expression throw.
- **Evidence:** `exp3-shortcircuit-cookies.mjs` last line, both trees: `new URL("") -> TypeError: Invalid URL`.
  Source: `BA/context/create-context.ts:144-149, 188-196, 285`; `BA/plugins/jwt/sign.ts:289-302`; §6.2 line 2769 of the
  design.
- **Suggested fix:**
  - Make the sketch's derivation total, e.g.
    `this.issuer ??= this.options.issuer ?? ((b) => (b ? new URL(b).origin : null))((await r.auth.$context).baseURL)`,
    and fail with a `BetterAuthConfigurationError` naming the option to set when it is `null`, rather than letting a
    `TypeError` surface as an unexplained 5xx.
  - Widen the second consequence bullet from "under a **dynamic** `baseURL`" to "whenever `$context.baseURL` is empty —
    a dynamic `{ allowedHosts }` config **or an unset `baseURL`** (§6.2) — better-auth signs `iss`/`aud` as `''`, so the
    deployment must set `jwt: { issuer, audience }` and pass the same values to the source."
  - Add an `S-jwt-claims` row that boots the sketch with no `baseURL` and asserts the configuration error (or a working
    source once `jwt: { issuer }` is set), not a 5xx.

## Product questions proposed

**Q39. When better-auth's `advanced.disableOriginCheck: true` is combined with an explicit `disableCSRFCheck: false`,
does the kernel's origin check on app routes follow better-auth (off) or stay on?** (raised by BA-r6-01; B19's fix is
required either way and is not part of this question)

| Option                                           | What it means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) **Follow better-auth exactly**               | Treat `$context.skipOriginCheck === true` as switching the kernel check off whatever `disableCSRFCheck` says, matching `shouldSkipOriginCheck`. The library and better-auth then always agree, and `LIB-origin-differential` needs no divergence row. Cost: an app that wrote `disableCSRFCheck: false` intending to _keep_ CSRF on loses the kernel's check on app routes too, silently doubling the blast radius of a better-auth quirk the upstream deprecation notice says will be removed.                                                                                                                                                                                                                                                                   |
| (b) **Keep the kernel's check on** (recommended) | The kernel honours only `skipCSRFCheck` and the backward-compatible skip, exactly as §7.10 step 4 already says, and the combination becomes a **second documented, deliberate divergence** alongside path-array `skipOriginCheck` — recorded in §7.10, pinned in `LIB-origin-differential` as an expected divergence, and named in B19's message so the operator sees why auth routes and app routes answer differently. It is the stricter direction, it survives better-auth fixing `shouldSkipOriginCheck` to respect an explicit `disableCSRFCheck: false` (which the deprecation notice foreshadows), and it matches the precedent the design already set for path-array skips. Cost: one more divergence to document and to keep in the differential table. |

**Recommendation: (b).** The design already accepts being stricter than `validateOrigin` where better-auth's skip is
scoped to auth-route paths, for the same reason: the kernel's surfaces are not better-auth's routes, and a skip aimed at
better-auth's callback-URL validation should not silently disable CSRF on the application's own mutations. Option (b)
also degrades gracefully when better-auth changes `shouldSkipOriginCheck`, whereas (a) would have to change with it.
Whichever option is decided, §7.5's caller-session bullet and §7.10 step 4 must state the _same_ predicate, and B19 must
warn for `skipOriginCheck === true` whatever `disableCSRFCheck` says, because in that state better-auth's own credential
routes are unprotected and today nothing says so.
