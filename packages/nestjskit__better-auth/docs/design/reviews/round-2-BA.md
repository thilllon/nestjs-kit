# Round 2 review: BA (better-auth fidelity)

Input: `design-v2.md`. Verdict: **reject** (1 blocker, 3 major, 5 minor).

Experiments: `scratchpad/tmp-r2-review-BA/exp/` (scripts and captured `.out` files), run against better-auth **1.7.4** and
**1.7.0** (the D4 floor) with `@better-auth/api-key` at the same version and better-call 1.4.0, installed in
`tmp-r2-review-BA/v174` and `tmp-r2-review-BA/v170`. Every experiment gave identical results on both versions. The newest
published better-auth is 1.7.5 (`npm view better-auth dist-tags`, 2026-09-17), so there is no later 1.x minor to check yet.

## Summary

Every round-1 BA finding is fixed as far as its own failure scenario goes, and most of v2's better-auth claims hold when
checked against the 1.7.4 source and re-run at the floor:

- the hook pipeline (`BA/api/dispatch.ts`): every before-hook sees the original input, `{ context }` merging, short-circuits skip after-hooks, after-hook `APIError`s become `returned`, throwing before-hook matchers become 500 and after-hook matchers propagate, plugin hooks run after `options.hooks` and are re-read per dispatch;
- `init()` merging (`BA/context/helpers.ts:23-98`): plugin `databaseHooks` in plugin order with the user's appended last, `defu` for other options, plugin trusted origins merged into the post-init `options.trustedOrigins`;
- the router's origin rule (`BA/api/middlewares/origin-check.ts:221-297`) matches the §7.10 mirror, and the router recomputes trusted origins per request from the post-init options (`BA/auth/base.ts:48-110`);
- `returnHeaders` on a normal dispatch, the api-key result codes and `details.tryAgainIn`, the admin and organization endpoints' codes and lookups, `Symbol.for('better-call:api-error-headers')`, the `onAPIError.throw` rethrow (redirects are still converted first), and the `better-auth/api`, `/cookies`, `/oauth2`, `/plugins/access` exports at 1.7.0.

The design fails where it relies on better-auth behavior it did not run end to end:

- **Blocker.** With `apiKey({ enableSessionForAPIKeys: true })`, the design's "authoritative" identity read goes through the hook pipeline, where the api-key plugin answers `/get-session` with a mocked session of the key's owner. The admin policy then grants a narrow key its owner's full admin role. better-auth's own admin endpoints re-read the session without hooks and answer 401 for the same key (BA-r2-06). This reopens BA-r1-01's failure through the session kind and contradicts ADR-36's parity claim.
- **Major.**
  - A before-hook short-circuit of `/get-session` (the api-key plugin, or any Nest `@BeforeAuth` that returns an object) makes `getSession({ returnHeaders: true })` return `headers: undefined`, which the session source dereferences: 500 on every such request over HTTP (BA-r2-01).
  - better-auth's `sessionMiddleware` swallows storage errors into 401 `UNAUTHORIZED`; Z2 and the org table turn that into 403, so intermittent outages on org routes look like permission denials (BA-r2-03).
  - With a dynamic `baseURL` and no `fallback`, better-auth rejects direct calls that carry no host. The admin policy (by design header-less), `apiKeyPrincipal()` and every RPC carrier make exactly such calls and answer 500 on every request (BA-r2-05).
- **Minor.** The DB `update.before` dispatcher reverts earlier plugins' changes (BA-r2-02); the client-IP header defeats better-auth's own `trustedProxies` (BA-r2-04); the recommended `@AfterAuth('/get-session')` rule does not reach better-auth's endpoints (BA-r2-07); organization refs cannot express slugs, and the active-org id has no source for `customSession` shapes (BA-r2-08); the `next` dist-tag the drift job targets is a 0.8 beta (BA-r2-09).

Observation, not a finding: the bearer plugin's before-hook adds the session cookie to `ctx.headers`, so the bridge's
`sameCredential` sees a different triple than the inbound request for bearer clients and drops their `Set-Cookie`
(`BA/plugins/bearer/index.ts:100-115`, `BA/api/dispatch.ts:373-383`). That is harmless for bearer clients, but §7.5 and
ADR-09 ("the credential always matches for calls made with the request's headers") should say so, and the
`Credential matching` unit test (§14.5, "bearer-only") should expect the drop.

| Id       | Sev     | Title                                                                                                                                     |
| -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| BA-r2-06 | blocker | Key sessions (`enableSessionForAPIKeys`) pass `@RequirePermission` with the owner's admin role; better-auth's admin endpoints reject them |
| BA-r2-01 | major   | Session source dereferences `headers: undefined` when a before-hook short-circuits `/get-session`                                         |
| BA-r2-03 | major   | Org policies turn swallowed storage failures (401 `UNAUTHORIZED`) into 403                                                                |
| BA-r2-05 | major   | Dynamic `baseURL` without `fallback`: host-less library calls (admin policy, `apiKeyPrincipal`, RPC) throw 500                            |
| BA-r2-02 | minor   | DB `update.before` dispatcher reverts earlier plugins' changes                                                                            |
| BA-r2-04 | minor   | Plugin IP header defeats better-auth's `trustedProxies`: one shared rate-limit bucket                                                     |
| BA-r2-07 | minor   | `@AfterAuth('/get-session')` rules do not reach better-auth's own endpoints                                                               |
| BA-r2-08 | minor   | Organization refs: slugs sent as ids; active-org id unavailable for `customSession` shapes                                                |
| BA-r2-09 | minor   | Drift CI targets `better-auth@next` = 0.8.7-beta.5                                                                                        |

## Prior findings (round 1, BA)

| Id       | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BA-r1-01 | resolved | The round-1 scenario is closed: `apiKeyPrincipal()` is consulted only on routes that accept `'api-key'`, the admin policy admits `['session']` by default, and opted-in delegated kinds are ANDed with `delegation.allows` (Z5, `Z-delegation-scope`). The same escalation remains reachable through a different path, a key-mocked **session** principal under `enableSessionForAPIKeys`, reported as BA-r2-06.   |
| BA-r1-02 | resolved | Forwarding of application direct calls is off by default and credential-matched when on (`S-bridge-third-party-signup`); RK14 re-rated; router-only protections documented. See the bearer observation in the summary.                                                                                                                                                                                             |
| BA-r1-03 | resolved | §7.10 applies better-auth's rule to WS messages, subscriptions and `WsConnectionAuth`; the mirror matches `validateOrigin` in 1.7.4 (Origin, then Referer; `Origin: null` + `Sec-Fetch-Site`; cookie presence; `skipCSRFCheck`; the backward-compatible skip; path arrays ignored), and the differential test pins drift.                                                                                          |
| BA-r1-04 | resolved | The mapping table covers every code `validateApiKey`/`verifyApiKey` produce in 1.7.4 (`INVALID_API_KEY`, `KEY_NOT_FOUND`, `KEY_DISABLED`, `KEY_EXPIRED`, `USAGE_EXCEEDED`, `RATE_LIMITED` with `details.tryAgainIn`, `FAILED_TO_UPDATE_API_KEY`); `references`, `referenceId`, parsed `permissions` and the `apikey` model name are right. A new failure of the same source under a dynamic `baseURL` is BA-r2-05. |
| BA-r1-05 | resolved | Multiplier documented, advised by the session unit, deduped per request, and tested (`Z-apikey-quota-per-request`). That case, run over HTTP, would currently crash first (BA-r2-01).                                                                                                                                                                                                                              |
| BA-r1-06 | resolved | Per-operation semantics, types derived from `BetterAuthOptions['databaseHooks']`, `delete.before` typed `boolean \| void`, throwing matchers propagate; all four sub-scenarios are closed. The new `update` merge introduced BA-r2-02.                                                                                                                                                                             |
| BA-r1-07 | resolved | The wrong claim is corrected, the api-key short-circuit is documented and `LIB-hook-bearer-client` pins visibility. The replacement advice has a scope gap: BA-r2-07.                                                                                                                                                                                                                                              |
| BA-r1-08 | resolved | `UnvalidatedBody<…>`: known keys, `unknown` values.                                                                                                                                                                                                                                                                                                                                                                |
| BA-r1-09 | resolved | With `onAPIError.throw` the `APIError` is rethrown to the host pipeline; the router still converts `FOUND` redirects before rethrowing (`BA/api/index.ts:355-357`), so OAuth redirects are unaffected.                                                                                                                                                                                                             |
| BA-r1-10 | resolved | 400 `user not found` (message only, no `code`, `BA/plugins/admin/routes.ts:1884-1888`) maps to 401 `USER_NOT_FOUND`; unreachable in the default mode, where `body.role` skips the lookup.                                                                                                                                                                                                                          |
| BA-r1-11 | resolved | The helper and the origin check use `ctx.trustedOrigins` ∪ post-init `options.trustedOrigins`, which is where `runPluginInit` puts plugin origins (`BA/context/helpers.ts:61-83`); `LIB-cors-helper` covers it.                                                                                                                                                                                                    |

## New findings

### BA-r2-06 (blocker): With `enableSessionForAPIKeys`, a narrow API key passes `@RequirePermission` with its owner's full admin role, although better-auth's own admin endpoints reject key sessions

- **Section:** §8.3 (admin row, "exactly what better-auth's own admin endpoints evaluate"), §8.4, §8.3.1 ("better-auth's own admin and org endpoints treat it the same way"), §7.3 (`authoritative`), ADR-36, RK24, §14.4 ("a leaked narrow-scope API key cannot reach `@RequirePermission` routes")
- **Failure scenario:** `betterAuth({ plugins: [admin(), apiKey({ enableSessionForAPIKeys: true }), nestjs()] })`. An admin creates a CI key whose permissions are `{ project: ['read'] }`. `POST /admin/users/:id/ban` carries `@RequirePermission({ user: ['ban'] })` (default `freshness: 'authoritative'`). The key leaks; the attacker sends it as `x-api-key`.
  1. The route admits `'session'`; the built-in session source calls `auth.api.getSession({ headers, query: { disableCookieCache: true } })`.
  2. That goes through the hook pipeline: the api-key plugin's before-hook validates the key and short-circuits `/get-session` with a mocked session of the key's owner (`AK/index.ts:228-268`). `disableCookieCache` has no effect on it.
  3. The principal is kind `'session'`, no delegation, `session.user.role === 'admin'`. The admin policy calls `userHasPermission({ body: { userId, role: 'admin', permissions } })` → `success: true`.
  4. The attacker bans users. The key's own grant is never consulted.

  As the §7.3 code is written, BA-r2-01 makes step 1 crash (500) on cookie-capable transports, which hides the escalation on HTTP until that one-line bug is fixed. On transports whose sink is `null` (a WebSocket gateway or RPC handler carrying `@RequirePermission`, a GraphQL subscription) the escalation is reachable as written, because the session source never touches `result.headers` there.

  better-auth itself refuses this. `adminMiddleware` reads the session with `getAuthoritativeSessionFromCtx`, which discards the hook-provided `ctx.context.session` and re-reads through the plain `getSession()` endpoint function, where no hook runs, so a key alone yields no session and every admin endpoint answers 401 (`BA/plugins/admin/routes.ts:33-45`; `BA/api/routes/session.ts:527-539`). `sensitiveSessionMiddleware` behaves the same way. The design's "authoritative" read is therefore **less** strict than better-auth's for exactly the admin-grade routes ADR-36 claims parity for, and it reopens the failure scenario of BA-r1-01 through the session kind. `W_API_KEY_FULL_SESSION` describes it as better-auth's semantics, which is not true for admin endpoints, and `session.apiKeySessions: false` silences it.

- **Evidence:** EXP `exp6-apikey-session-admin.mjs`, identical on 1.7.4 and 1.7.0 (`exp6.v174.out`, `exp6.v170.out`):
  ```
  key permissions = {"project":["read"]}
  better-auth listUsers (x-api-key) -> APIError 401
  better-auth banUser (x-api-key) -> APIError 401
  better-auth userHasPermission (x-api-key headers) -> APIError 401
  design guard: getSession(disableCookieCache) principal kind=session userId= admin role= admin
  design policy: userHasPermission({ body: { userId, role } }) -> ok {"error":null,"success":true}
  ```
- **Suggested fix:** Make an authoritative identity read accept only the credentials `getAuthoritativeSessionFromCtx` accepts:
  - The session source, when `freshness === 'authoritative'`, calls `getSession` with a header set reduced to `cookie`, `authorization` (bearer's conversion still applies, as it does in the outer dispatch better-auth's middleware sees), `host` and the client-IP header, so no plugin can answer `/get-session` from another credential header; and it accepts the result only if `session.session.token` is the token of the presented session cookie or bearer credential (a mocked key session carries the raw key there). Otherwise the result is `absent` for that plan. Alternatively the admin policy's default mode calls `userHasPermission` **with** the request headers (better-auth's own evaluation, one more read), which rejects key sessions by construction.
  - The opt-down modes (`freshness: 'role' | 'cached'`) have no better-auth counterpart that accepts key sessions either, so they need the same store-backed check before judging a `'session'` principal.
  - Correct §8.3.1, RK24 and `W_API_KEY_FULL_SESSION`: key sessions reach ordinary and org routes (better-auth's `sessionMiddleware` accepts them), not admin-grade or authoritative ones.
  - Add `Z-admin-rejects-api-key-session` (the setup above → 401 on the default `permission()`, as on better-auth's admin endpoints) and the same case with `@RequireAuth({ authoritative: true })`.

### BA-r2-01 (major): The session source crashes when a before-hook short-circuits `/get-session`: `getSession({ returnHeaders: true })` then returns `headers: undefined`

- **Section:** §7.3 (session source code), §8.3.1 (`enableSessionForAPIKeys`), §10.5 (before → any other object), RK24, `Z-apikey-quota-per-request`
- **Failure scenario:** `betterAuth({ plugins: [apiKey({ enableSessionForAPIKeys: true }), nestjs()] })`, Express, a guarded controller route, a client that sends `x-api-key: <valid key>`.
  1. The session source calls `r.auth.api.getSession({ headers, returnHeaders: true, query })`.
  2. The api-key plugin's before-hook answers `/get-session` itself (`return session`, `AK/index.ts:262-268`).
  3. better-auth's dispatcher returns `{ headers: responseHeaders, response }` for a short-circuit, and `responseHeaders` is still `undefined` because no hook set a response header (`BA/api/dispatch.ts:342, 386-392`; `mergeResponseHeaders` leaves it `undefined` for an empty `Headers`, `:86-100`).
  4. `r.cookies` is the Express sink, so the source runs `result.headers.getSetCookie()` outside its `try` block: `TypeError: Cannot read properties of undefined (reading 'getSetCookie')`.
  5. The resolver classifies the throw as infrastructure: every API-key request on every guarded HTTP route answers 500 and logs an ERROR, while better-auth itself authenticates the key.

  The same crash hits any `@BeforeAuth('/get-session')` Nest hook (or any other plugin) that short-circuits `/get-session` with an object, which §10.5 documents as supported ("before → any other object: short-circuit"). It does not depend on the api-key plugin.

  The design discusses this exact configuration at length (RK24, `W_API_KEY_FULL_SESSION`, `W_API_KEY_SESSION_MULTIPLIER`, `Z-apikey-quota-per-request` "spends the key's quota as documented (3 per request)"), but as written the first `getSession` never returns a principal on a cookie-capable transport. On cookie-less transports (WS, RPC, subscriptions) `r.cookies` is `null`, so the bug is hidden there, which makes the behavior differ by transport.

- **Evidence:** EXP `exp1-apikey-returnheaders.mjs`, identical on 1.7.4 and 1.7.0:
  ```
  api-key short-circuit: typeof headers = undefined isHeaders = false response.user.id ok = true
  getSetCookie THROWS: TypeError Cannot read properties of undefined (reading 'getSetCookie')
  plugin short-circuit: typeof headers = undefined
  no credential: typeof headers = object true response = null
  ```
  Design §7.3: `result = … getSession({ headers: r.headers, returnHeaders: true, query }) as Promise<{ headers: Headers; response: unknown }>` then `const setCookie = result.headers.getSetCookie();` (the cast hides the `undefined`). `AuthLike.api.getSession` is typed `Promise<unknown>` (§11.3), so nothing catches it at compile time either.
- **Suggested fix:** Treat `headers` as optional in the source (`result.headers?.getSetCookie() ?? []`) and state in §7.3 that a short-circuited dispatch returns no `Headers`. Type the call's result as `{ headers: Headers | null | undefined; response: unknown }` in `AuthLike`. Add a conformance case to `principalSourceConformance`/the session unit: a probe before-hook that short-circuits `/get-session` on a cookie-capable transport yields `authenticated`, not 5xx; and run `Z-apikey-quota-per-request` over HTTP (it would have caught this).

### BA-r2-03 (major): Org policies turn intermittent storage failures into 403, because better-auth's `sessionMiddleware` swallows them into 401 `UNAUTHORIZED` and Z2 maps that to deny 403

- **Section:** §8.3 (org rows, deny mapping), §8.1 / Z2 (safety net: "401 or 403 becomes deny 403"), §13.2, §15.4 ("Authorization infrastructure failures are now 5xx, not 403"), §17.2 RK2
- **Failure scenario:** Postgres behind a connection pool, no cookie cache (or a `session_data` cookie that just expired). A browser calls `DELETE /orgs/:orgId/projects/:id` with `@RequireOrgPermission({ project: ['delete'] }, { organization: fromParam('orgId') })` during a brownout (pool exhaustion, failover), where some queries of a request succeed and later ones time out.
  1. The guard's `getSession` reads the session: it succeeds.
  2. The org policy calls `auth.api.hasPermission({ headers, body })`. Its `orgSessionMiddleware` → `sessionMiddleware` → `getSessionFromCtx` re-reads the session; that query times out.
  3. `getSessionFromCtx` catches **every** error of its inner `getSession` and returns `null` (`BA/api/routes/session.ts:453-494`, `.catch(() => null)` at `:491`), so `sessionMiddleware` throws `APIError 401 { code: 'UNAUTHORIZED' }` (`:544-551`).
  4. The org policy's table maps only `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` (401), `NO_ACTIVE_ORGANIZATION` and `success: false`. The generic 401 falls to Z2: "401 or 403 becomes deny 403 with the better-auth code as `reason`".
  5. The client gets `403 { code: 'FORBIDDEN', reason: 'UNAUTHORIZED' }`, logged at debug only. Frontends show "no permission", retry logic does not retry, and 5xx alerting sees nothing: exactly what S6 and §15.4 promise cannot happen. `@RequireOrgMember()` (`getActiveMemberRole`, same middleware) behaves identically.

  The same rule misclassifies a genuine race (the session was revoked between the guard's read and the policy's read): better-auth says 401 "no session", the design answers 403 "authenticated but not allowed". Any third-party policy that calls a plugin endpoint guarded by `sessionMiddleware` inherits both problems through Z2. RK2 documents the swallowing only for `customSession`; it is general to every endpoint that resolves the session through `getSessionFromCtx`.

- **Evidence:** EXP `exp3-org-outage-401.mjs` (flaky memory adapter that starts throwing `ETIMEDOUT` after the guard's read), identical on 1.7.4 and 1.7.0 (`exp3-org-outage-401.v174.out`, `.v170.out`):
  ```
  guard getSession ok = true
  hasPermission -> threw APIError status=401 code=UNAUTHORIZED
  getActiveMemberRole -> threw APIError status=401 code=UNAUTHORIZED
  getSession (direct) -> threw APIError status=500 code=FAILED_TO_GET_SESSION
  ```
  better-auth logs the underlying `ETIMEDOUT` at ERROR, but the endpoint's answer is a 401.
- **Suggested fix:** Make Z2 and the org table distinguish "the endpoint could not see a session" from "denied":
  - A 401 whose `code` is `UNAUTHORIZED` (or no code) from a policy's better-auth call, for a principal the guard already authenticated, is not a denial. Resolve it the way ADR-42 resolves `INVALID_API_KEY`: one authoritative probe through the resolver's source (`getSession` with `disableCookieCache`, which throws 500 `FAILED_TO_GET_SESSION` on an outage, as the experiment shows). A throw → `BetterAuthInfrastructureError` (5xx); `null` → 401 `UNAUTHENTICATED` (session revoked mid-request); a session → infrastructure as well (the endpoint failed to read what exists).
  - Keep 403 only for the codes that mean "authenticated but not allowed" (`USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`, `YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION`, 403s in general).
  - Generalize RK2 to every `getSessionFromCtx` consumer and fold it into the upstream proposal (do not swallow non-`APIError` failures in `getSessionFromCtx`). The design's own `Z-infra-throws` ("with the adapter throwing during evaluation") would fail against the org policies as specified; make its setup explicit (the adapter fails only after the guard's read, with and without cookie cache) so it pins this path.

### BA-r2-05 (major): With a dynamic `baseURL` and no `fallback`, the library's host-less `auth.api` calls throw 500: the admin policy, `apiKeyPrincipal()` and RPC session resolution fail on every request

- **Section:** §8.3 (admin row: `userHasPermission` "**without headers**"), §8.3.1 (`verifyApiKey({ body: { key, configId? } })`), §9.4 (carriers copy `authorization`, `cookie`, `x-api-key` only), §5.4 B20 and B23, §6.2
- **Failure scenario:** A multi-domain deployment uses better-auth's dynamic base URL, `baseURL: { allowedHosts: ['app.example.com', '*.preview.example.com'] }`, without `fallback`. B23 accepts it in production; B20 only warns that "`auth.handler` throws on a disallowed host".
  1. For every direct `auth.api.*` call on a dynamic config, better-auth resolves the base URL from the call's own `request` or `headers`, and `pickSource` accepts headers only when they carry `host` or `x-forwarded-host` (`BA/context/helpers.ts:175-189`). Without one, and without `fallback`, the `auth.api` wrapper throws `APIError 500 "Dynamic baseURL could not be resolved for this direct auth.api call"` before dispatch (`BA/api/to-auth-endpoints.ts:36-67`).
  2. `@RequirePermission(...)` (admin policy, default): `userHasPermission({ body })` carries no headers by design → 500 → infrastructure. Every admin route answers 5xx.
  3. `apiKeyPrincipal()`: `verifyApiKey({ body: { key } })` → 500. The throw happens outside the endpoint, so `verifyApiKey`'s own catch does not turn it into `{ valid: false }`; the source's safety net maps ≥ 500 to infrastructure. Every key-authenticated request answers 5xx.
  4. `rpcTransport()`: carriers build `Headers` from `authorization`/`cookie`/`x-api-key` only, so the session source's `getSession` → 500 on every message, even for valid bearer tokens.

  HTTP, GraphQL and WS resolution keep working because their headers include `host`, so the app boots, passes smoke tests on its main routes, and fails only on admin, API-key and RPC traffic. The admin policy cannot simply add a `host` header: once `ctx.headers` is set, `userHasPermission` requires a session from those headers and throws 401 without one (`BA/plugins/admin/routes.ts`, `if (!session && (ctx.request || ctx.headers)) throw UNAUTHORIZED`).

- **Evidence:** EXP `exp5-dynamic-baseurl-headerless.mjs`, identical on 1.7.4 and 1.7.0 (`exp5.v174.out`, `exp5.v170.out`):
  ```
  dynamic, no fallback | userHasPermission({ body }) [admin policy] -> APIError 500: Dynamic baseURL could not be resolved for this direct auth.api call. …
  dynamic, no fallback | verifyApiKey({ body: { key } }) [apiKeyPrincipal] -> APIError 500: …
  dynamic, no fallback | getSession({ headers: { authorization } }) [RPC carrier] -> APIError 500: …
  dynamic, no fallback | getSession({ headers: { host, authorization } }) [HTTP] -> ok
  dynamic + fallback   | (all four) -> ok
  static               | (all four) -> ok
  ```
- **Suggested fix:** Treat "direct calls need a resolvable base URL" as a better-auth contract the units declare:
  - Let a unit declare that it makes host-less calls (for example `requires: { serverCalls: true }` on the admin policy, `apiKeyPrincipal()` and `rpcTransport()`), and make B20 an **error** for a dynamic `baseURL` without `fallback` when such a unit is registered or referenced, with the hint "add `baseURL.fallback`" (better-auth's own remedy in the error text).
  - Where a host is available, pass it: `apiKeyPrincipal()` can send `headers: new Headers({ host })` from the transport call (only `host`, so the api-key session hook does not re-validate the key); RPC carriers cannot, so they depend on `fallback`.
  - Add dynamic-`baseURL` variants (with and without `fallback`) to the admin, API-key and RPC conformance jobs; `H-mount-custom-path` already boots a dynamic config but runs no policy or source.

### BA-r2-02 (minor): The DB `update.before` dispatcher returns the original payload with the Nest hooks' data, so it reverts what earlier plugins changed

- **Section:** §10.6 (dispatcher code), §10.5 (update row), §14.5 (parity property test)
- **Failure scenario:** A plugin placed before `nestjs()` (which must be last) normalizes a field in `user.update.before`, for example a third-party plugin returning `{ data: { ...data, name: data.name.trim() } }`. A Nest hook `@BeforeDatabase('user.update')` returns only a delta, `{ data: { image: 'stamped' } }`.
  1. better-auth runs the plugin first: `actualData.name = 'Padded Name'` (`BA/db/with-hooks.ts:117-141`).
  2. better-auth calls the dispatcher with the **original** payload (`toRun(data, context)`, `:129`). The dispatcher builds `merged = { ...data, ...r.data }` = `{ name: '  Padded Name  ', image }` and returns `{ data: merged }`.
  3. better-auth merges that over its accumulator (`actualData = { ...actualData, ...result.data }`, `:136-139`), so `name` goes back to the untrimmed value.

  Registered natively (as its own plugin), the same Nest hook keeps the earlier plugin's change. `updateMany` has the same code path (`:192-216`). `create` is not affected, because there better-auth passes the accumulated data. The parity property test (§14.5) cannot see it: it compares "N native plugins" with "N Nest hooks behind one dispatcher" and has no preceding plugin in either setup.

  Built-in plugins happen to mask it today (username re-normalizes through its schema `transform.input`, `BA/plugins/username/schema.ts:20-36`; phone-number adds a key the payload lacks), so the impact is third-party and custom plugins.

- **Evidence:** EXP `exp2-db-update-clobber.mjs`, identical on 1.7.4 and 1.7.0:
  ```
  native: stored name = "Padded Name", image = "stamped"
  design-dispatcher: stored name = "  Padded Name  ", image = "stamped"
  ```
- **Suggested fix:** For `update`/`updateMany`, accumulate only what hooks return (`acc = { ...acc, ...r.data }`) and return `{ data: acc }`; each hook still receives the original payload. (The same accumulation is also correct for `create`, where it is equivalent.) Extend the parity test with a fixed native plugin in front of the dispatcher in both setups, whose hook modifies a key present in the payload.

### BA-r2-04 (minor): The plugin's client-IP header silently disables better-auth's own proxy trust (`advanced.ipAddress.trustedProxies`), collapsing rate limiting into one bucket for correctly configured apps

- **Section:** §6.8 (items 1, 2 and 6), §5.4 B18, §15.1 step 8, §14.1 `H-ip-platform`
- **Failure scenario:** An existing better-auth 1.7 deployment behind a load balancer (10.0.0.5) is configured the better-auth way: `advanced.ipAddress.trustedProxies: ['10.0.0.0/8']`, no `ipAddressHeaders` (so better-auth walks `X-Forwarded-For` right to left), and no Express `trust proxy` (plain better-auth never needed it). The team migrates and adds `nestjs()`.
  1. `init()` contributes `ipAddressHeaders: ['x-nsba-ip-…']`. Because the user set no list, it becomes the **only** header better-auth reads; `x-forwarded-for` is no longer consulted (`CORE/utils/ip.ts:364-377`).
  2. `AuthExchange` fills the header from `req.ip`, which is the load balancer's address, 10.0.0.5.
  3. better-auth applies `trustedProxies` to that value too (`getIPFromHeader`, `:311-331`): 10.0.0.5 is a trusted proxy, so the chain yields `null`.
  4. With no IP, the rate limiter keys every client on one shared per-path bucket (`BA/api/rate-limiter/index.ts:342-356`): sign-in is limited to 3 per 10 s for the whole user base, and one scripted client locks everyone out. Sessions record `ipAddress: null`.

  Boot does not flag it: B18 only checks the header's position and the `clientIpHeader: false` case. At runtime better-auth's one-time "shared bucket" warning does fire (contradicting §6.8 item 6, "never fires because a valid IP is always supplied"), and `W_PROXY_UNTRUSTED` says "the socket IP became the rate-limit key", which is not what happened. §6.8 treats proxy trust as a platform-only concern ("configured once, in the platform") although better-auth has its own mechanism, and the two compose badly.

- **Evidence:** EXP `exp4-trustedproxies-header.mjs`, `NODE_ENV=production`, identical on 1.7.4 and 1.7.0:
  ```
  effective ipAddress (with plugin): {"ipAddressHeaders":["x-nsba-ip-…"],"trustedProxies":["10.0.0.0/8"]}
  plain better-auth, XFF client        -> 203.0.113.7
  with plugin, trust proxy off (LB ip) -> null
  with plugin, trust proxy on          -> 203.0.113.7
  ```
- **Suggested fix:** Make the combination explicit. B18 (production) fails or warns when the post-init options carry `advanced.ipAddress.trustedProxies` while the plugin contributes its header and the platform's `proxyTrust()` is `'none'`: "better-auth's trustedProxies cannot see X-Forwarded-For through the nestjs() header; configure the platform's trust proxy, or set `nestjs({ clientIpHeader: false })` to keep better-auth's own chain parsing". Say in §6.8 that `trustedProxies` is re-applied to the platform-resolved IP (harmless when platform trust is set, `null` when it is not), add the case to `H-ip-platform`, and correct item 6 and the `W_PROXY_UNTRUSTED` text for the `null` outcome.

### BA-r2-07 (minor): The recommended `@AfterAuth('/get-session')` rule does not reach better-auth's own endpoints, so a "suspended user" rule written that way fails open on every auth route

- **Section:** §10.4 ("Security rules belong where every credential type passes"), §15.1 guidance derived from it, `LIB-hook-bearer-client`
- **Failure scenario:** Following §10.4, a team blocks suspended users with `@AfterAuth('/get-session')` that replaces `ctx.context.returned` with `null` when the user is suspended. Nest routes now answer 401 for that user, as intended. The user's browser still holds the cookie and calls better-auth's own routes through the mount: `POST /api/auth/update-user`, `/change-email`, `/organization/create`, `/api-key/create`, and so on. Those endpoints resolve the session with `getSessionFromCtx`, which calls the `getSession` endpoint as a plain function, and "calling an endpoint as a plain function deliberately skips hooks" (`BA/api/dispatch.ts:317-318`; `BA/api/routes/session.ts:453-470`). The rule never runs there; the suspended user keeps changing their account and creating organizations and API keys.
- **Evidence:** EXP `exp7-afterhook-get-session-scope.mjs` (a native after-hook, which is exactly what a Nest hook behind the dispatcher becomes), identical on 1.7.4 and 1.7.0:
  ```
  getSession (guard path, hook applies) -> ok null
  updateUser (better-auth endpoint) -> ok {"status":true}
  createOrganization (plugin endpoint) -> ok {"name":"Acme","slug":"acme",…
  ```
- **Suggested fix:** In §10.4, scope the `@AfterAuth('/get-session')` pattern to "rules for Nest routes only" and say why (better-auth's endpoints read the session without hooks). For rules that must hold everywhere, point only at state better-auth itself consults on every path: the admin ban (which revokes sessions and blocks new ones through its `session.create` hook), revoking the user's sessions, and a `@BeforeDatabase('session.create')` hook for new sign-ins. A path-less `@BeforeAuth` is not an alternative, because before-hooks see the original request (BA-r1-07).

### BA-r2-08 (minor): Organization refs assume an organization id: slug routes and the active-org default cannot publish a correct `@ActiveOrganizationId()`

- **Section:** §8.3 (organization refs, `W_ORG_PARAM_IGNORED`, `@ActiveOrganizationId()` "never `undefined`"), §11.5 ("the org policies never read the custom shape"), §17 Q17
- **Failure scenario:**
  1. _Slugs._ A route `DELETE /orgs/:orgSlug/projects/:id` uses `@RequireOrgPermission(p)`. `W_ORG_PARAM_IGNORED` fires for `:orgSlug` and its hint names `fromParam(...)`, so the team writes `fromParam('orgSlug')`. The policy sends the slug as `organizationId`; better-auth's `hasPermission` accepts only `organizationId` (`BA/plugins/organization/organization.ts:167-180`) and looks the member up by that value (`:268-279`), finds none and answers 401 `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION`, which the design maps to 403. Every member of every organization is denied on that route, and `@ActiveOrganizationId()` would publish a slug as an id. (`getActiveMemberRole` does accept `organizationSlug`, `routes/crud-members.ts:1073-1110`, so `orgMember` and `orgPermission` also disagree.)
  2. _Default ref with `customSession`._ With `activeOrganization()` the policy omits `organizationId`, and neither `hasPermission` (`{ error, success }`) nor `getActiveMemberRole` (`{ role }`) returns the organization id. The only source is `principal.session.session.activeOrganizationId`, i.e. the custom shape §11.5 says the org policies never read. A `customSession` that does not keep `session.activeOrganizationId` leaves nothing to publish, so `@ActiveOrganizationId()` throws `NO_INVOCATION_VALUE` (500) on a request better-auth authorized.
- **Evidence:** source lines above; design §8.3 note "They are valid after an org requirement ran on the same invocation, and return a `string`, never `undefined`", and the `W_ORG_PARAM_IGNORED` rule listing `:orgSlug`.
- **Suggested fix:** Give refs a kind: `fromParam(name)` (id) and `fromSlugParam(name)` (slug). For a slug, resolve the id with better-auth before `hasPermission` (`getFullOrganization({ headers, query: { organizationSlug } })`, which also proves membership, deduped per request) and publish that id. For the default ref, state where the id comes from (the base session's `activeOrganizationId`, read through the session unit's projection or a `session.activeOrganizationId` mapper next to `session.userId`, §11.5), and fail boot with a hint when `@ActiveOrganizationId()` is used with a `customSession` shape that lacks it. Make the `:orgSlug` hint name the slug ref.

### BA-r2-09 (minor): The CI safety net against better-auth drift targets the `next` dist-tag, which is a 0.8 beta

- **Section:** §14.2 ("nightly allowed-failure job against `next`"), §17.2 RK1, RK4, RK20 (mitigations rely on "a `next` nightly")
- **Failure scenario:** The nightly job installs `better-auth@next`. On the registry today that is `0.8.7-beta.5`, outside the D4 peer range and older than every surface the design depends on, so the job either fails permanently (and gets ignored as "allowed failure") or is skipped. No job ever sees a better-auth pre-release before users do. The risks whose mitigation names this job (RK1: undocumented surfaces such as `ctx._flag`, `responseHeaders`, `getPlugin`; RK20: the mirrored origin rule; RK4: top-level await) lose that early warning, and the design reads as if they had it.
- **Evidence:** `npm view better-auth dist-tags` (2026-09-17): `{ alpha: '0.0.2-alpha.3', next: '0.8.7-beta.5', canary: '1.0.0-canary.14', 'release-1.4': '1.4.22', beta: '1.7.0-beta.10', rc: '1.7.0-rc.6', latest: '1.7.5', 'release-1.6': '1.6.33' }`. better-auth's pre-releases of a minor are published as `x.y.0-beta.N` / `x.y.0-rc.N` under `beta`/`rc`.
- **Suggested fix:** Resolve the pre-release job's version dynamically: the highest published version that satisfies `>=1.7.0 <2` including pre-releases (`npm view better-auth versions --json` filtered with semver), plus the monorepo's `main` built from source if a truly nightly signal is wanted. Update RK1, RK4 and RK20 to name that job.

## Proposed user decisions

- **How should the admin policy's default mode evaluate `@RequirePermission` (the fix for BA-r2-06)?**
  - Option (a): keep the one-read mirror (role taken from the authoritative session the guard already read) and add a store-backed credential check that rejects hook-mocked sessions. 1 storage read per admin route; the library keeps mirroring `getAuthoritativeSessionFromCtx`'s credential semantics and must track changes to them.
  - Option (b): call `userHasPermission` with the request headers, i.e. better-auth's own `adminMiddleware`-grade evaluation. 2 storage reads per admin route (and one more key validation where `enableSessionForAPIKeys` is on), but parity by construction, including future changes to better-auth's admin checks; its 401 must map to 401, not 403 (see BA-r2-03).
  - Recommendation: **(b)**. Admin routes are rare and already pay one authoritative read; the design's whole premise is not to re-derive better-auth's security decisions, and the one-read shortcut is exactly where it diverged.

- **What should a policy answer when a better-auth call reports "no session" (401 `UNAUTHORIZED`) for a principal the guard already authenticated (BA-r2-03)?**
  - Option (a): probe once (an authoritative `getSession`): a throw becomes 5xx, `null` becomes 401, a session becomes 5xx. Correct classification; one extra read on this rare path only.
  - Option (b): always 401 `UNAUTHENTICATED`. No extra I/O; outages then look like logouts (clients re-authenticate, monitoring sees 401s).
  - Option (c): always 5xx. No extra I/O; a session revoked mid-request gets a 500 instead of a 401.
  - Recommendation: **(a)**. It is the same trade the design already made for `INVALID_API_KEY` (ADR-42), and it keeps S6 true.
