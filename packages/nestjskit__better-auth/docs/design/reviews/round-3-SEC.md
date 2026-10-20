# Round 3 review: SEC (security / SRE)

Input: `design-v3.md`. Verdict: **reject**.

Experiments: `scratchpad/tmp-r3-review-SEC/`. better-auth 1.7.4, @better-auth/api-key 1.7.4, Postgres 15 (own container `r3sec-pg`), socket.io 4, @nestjs/core 11.1.17 (source reading). Probe outputs are saved as `*.out` next to each script.

## Summary

v3 fixes the round-2 blocker properly. The origin check now keys on a cookie in the browser leg's own headers, with no exemption for explicit credentials, and it applies to every operation a WebSocket carries. SEC-r2-01 and the long-standing SEC-r1-01 are resolved, and so are SEC-r2-03 to SEC-r2-09. The service-null decision (Q27) and field-resolver inheritance (Q23) both hold up under attack.

SEC-r2-02 is **unresolved**. The no-op write catches store-wide write failures, but it writes a random row. A lock or timeout confined to the verified key's row still answers 401 `INVALID_API_KEY`, although §8.3.1 now claims the probe covers "lock or statement timeouts". A real Postgres run shows it (SEC-r3-01).

Two further majors:

1. **SEC-r3-02, an origin-check bypass introduced by the SEC-r2-05 fix.** Under a dynamic `baseURL` the rule trusts "the browser leg's own origin", and `upgradeRequestUrl()` builds that origin from `X-Forwarded-Host` without any trust setting. A socket.io polling handshake is a preflighted XHR, so a page can set that header, then pass the check with the victim's cookie. better-auth's router rejects the same headers (probe).
2. **SEC-r3-03, the strict missing-origin default.** It breaks better-auth's own Expo integration on every unsafe app route, with nothing at boot and nothing above debug in the server log.

Five minors:

- `service.forwardCookies(fn)` reopens login CSRF on public handlers (SEC-r3-04).
- An unrecognized GraphQL-over-WebSocket context fails open to the HTTP branch (SEC-r3-05).
- A banned admin's API key keeps admin permissions through the opt-in delegated path (SEC-r3-06, probe).
- Environment detection misfires: unset `NODE_ENV` silences B23, and `TEST=true`, which vitest sets, turns the origin check off (SEC-r3-07).
- GraphQL aliases multiply outage ERROR logs and policy I/O with no bound (SEC-r3-08).

## Prior findings

| Id        | Status         | Note                                                                                                                                                                                                                                                                                                                                   |
| --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-r1-01 | resolved       | Marked unresolved in round 2. v3 enforces on the browser leg's own cookie with no exemption (SEC-r2-01) and on every operation a WebSocket carries (SEC-r2-03). The cross-site form post, cross-site mutation and CSWSH scenarios are stopped. SEC-r3-02 is a new bypass the SEC-r2-05 fix introduced, not a residual of this finding. |
| SEC-r2-01 | resolved       | `BrowserExposure.headers()` is the leg's own headers, the rule keys on a cookie there, `credentialHeaders` and `explicitCredentialHeaders` play no part, and `T-ws-origin-junk-token`, `T-subscription-origin-junk-connection-params`, `T-csrf-http-cookie-plus-token` and the differential rows pin it.                               |
| SEC-r2-02 | **unresolved** | The no-op write stops the read-only-replica and revoked-grant variants. It does not stop the "lock or statement timeouts" variant that the finding listed and that §8.3.1 now claims to cover: the probe writes a random id, the verification writes the key's own row. Reproduced on real Postgres, see SEC-r3-01.                    |
| SEC-r2-03 | resolved       | Carrier-first classification with the upgrade request as an enforced leg. Still UNVERIFIED at runtime (RK3), which the design states.                                                                                                                                                                                                  |
| SEC-r2-04 | resolved       | Modified fix (public means no identity, Q27). No service path starts a resolution; `T-public-service-null` pins it.                                                                                                                                                                                                                    |
| SEC-r2-05 | resolved       | Absolute leg URLs and one verdict per leg. The fix's use of forwarding headers opened SEC-r3-02.                                                                                                                                                                                                                                       |
| SEC-r2-06 | resolved       | Non-empty-string rule for every ref result, tuple memo keys, `Z-org-ref-types`.                                                                                                                                                                                                                                                        |
| SEC-r2-07 | resolved       | Authoritative plans never use connection entries; `Z-admin-banned` has WS and subscription variants.                                                                                                                                                                                                                                   |
| SEC-r2-08 | resolved       | `@ForwardAuthCookies()` and `cookies.forwardDirectCalls` give `'form'` mode, also on public plans, and B16 does not count such a `@Public()` as coverage. The third opt-in, `service.forwardCookies(fn)`, does not; see SEC-r3-04.                                                                                                     |
| SEC-r2-09 | resolved       | Modified fix: field resolvers inherit (Q23) and `W_FIELD_RESOLVER_INHERITS` names them next to public root fields (RK29). The suggested escalation to an error was not taken; with inheritance as the model the warning is proportionate.                                                                                              |

## Findings

### SEC-r3-01 (major): The API-key outage probe writes a random row, so failures confined to the key's own row still answer 401 `INVALID_API_KEY` to valid keys

- **Section:** §8.3.1 (outage probe), §2.2.15 `ApiKeyPrincipalOptions.outageProbe`, §7.9, RK18, `S-apikey-write-outage`, ADR-42.
- **Failure scenario:** Postgres with `lock_timeout` (or `statement_timeout`) set on the app pool, a common production guard. Something holds a row lock on one key's row: an admin transaction that updates the key (rename, re-scope, refill) and stalls, an `idle in transaction` connection, or plain contention on a hot key that a high-throughput integration calls at hundreds of requests per second (every verification updates the same row, `claimUsageInDatabase`).
  1. The integration sends its valid `x-api-key` to a route that accepts keys.
  2. `verifyApiKey` waits for the row lock, the update fails with `lock_timeout`, and the catch returns `INVALID_API_KEY` (LEAD-V20).
  3. The source runs the probe: `findOne` and `updateMany` on a random id. Neither touches the locked row, both succeed in 1 ms, so the answer is **401 `INVALID_API_KEY`**.
  4. For as long as the lock or the contention lasts, the integration is told its key is invalid; clients rotate or disable keys, and monitoring sees 4xx instead of 5xx. That is S6 violated in exactly the partial-outage form SEC-r2-02 described ("lock or statement timeouts"), and §8.3.1 now states that the probe covers it.

  The same shape applies wherever a zero-row `UPDATE` succeeds while updating a real row fails. For example, on a full data volume Postgres can still run a statement that changes no tuple and writes no WAL, while a real update needs a new heap page. That variant was reasoned from Postgres semantics, not run.

- **Evidence:** `probe-apikey-row-lock.mjs` (real Postgres 15 in the `r3sec-pg` container, better-auth 1.7.4 with @better-auth/api-key 1.7.4, pool `lock_timeout=1000`; output in `.out`):
  - `healthy, valid key -> valid=true (4 ms)`;
  - `healthy, unknown key -> valid=false code=INVALID_API_KEY (0 ms)`;
  - second session: `BEGIN; UPDATE apikey SET "updatedAt" = now() WHERE id = <key id>` (held open);
  - `row locked, valid key -> valid=false code=INVALID_API_KEY (1003 ms)`;
  - `design outage probe -> read ok, no-op write ok (count 0) (1 ms) => storage "healthy" => 401 INVALID_API_KEY`;
  - `row locked, unknown key -> valid=false code=INVALID_API_KEY (1 ms)`;
  - after release: `valid=true`.

  Source: `AK/routes/verify-api-key.ts:185-221` (`claimUsageInDatabase` always runs `adapter.update` on `row.id`), `:573-595` (every non-`APIError` becomes `INVALID_API_KEY`). The design's claim is in §8.3.1: "a store that reads but cannot write (a read-only failover replica, a full disk, lock or statement timeouts, a revoked `UPDATE` grant) fails every valid key as `INVALID_API_KEY` too ... The probe therefore runs two statements on a random id".

- **Suggested fix:**
  1. Add a latency signal, which needs no knowledge of key hashing (R1): an `INVALID_API_KEY` result that took longer than `outageProbe.slowMs` (default, for example, 500 ms; a miss on the key index takes about 1 ms in the probe above) counts as infrastructure (5xx), whatever the probe says. Timeouts are, by construction, slow.
  2. Correct §8.3.1 and RK18: the probe detects store-wide read and write failures, not failures confined to the verified key's row (row locks, per-row timeouts, and a full volume where zero-row updates still succeed). Rate the residual honestly.
  3. Add `S-apikey-row-lock`: a second connection holds the key row's lock under a pool `lock_timeout`. A valid key answers 5xx, and an unknown key still answers a fast 401. The memory adapter cannot model a row lock, so this case needs a real database job (Postgres) in the matrix.
  4. Keep the upstream proposal (rethrow non-`APIError` failures from `verifyApiKey`) as the real fix.

### SEC-r3-02 (major): Under a dynamic `baseURL`, the origin check trusts "the browser leg's own origin", and WebSocket legs take that origin from `X-Forwarded-Host`. A cross-site page can put that header on a socket.io handshake and pass the check with the victim's cookie

- **Section:** §7.10 "The rule, `'cookie'` mode" step 3 (third bullet), "Absolute leg URLs"; §2.2.10 `upgradeRequestUrl()`; §9.3; `T-ws-origin-dynamic-baseurl`; `LIB-origin-differential`; ADR-34 (revised in v3, SEC-r2-05). This problem was introduced by the SEC-r2-05 fix.
- **Failure scenario:** The app uses a dynamic `baseURL: { allowedHosts: ['api.example.com'], fallback: 'https://api.example.com' }`, which B23 accepts in production, with better-auth's cross-domain cookies (`sameSite: 'none'`) or an attacker on a sibling subdomain. A socket.io gateway runs with `@WebSocketGateway({ cors: { origin: true, credentials: true } })`, a common credentialed CORS setting. The Node process either sits behind a load balancer that passes client-sent `X-Forwarded-*` headers through, or is exposed directly.
  1. The attacker page runs `io('https://api.example.com', { withCredentials: true, extraHeaders: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } })`. socket.io's default transport list starts with HTTP long-polling, and `extraHeaders` is honored for polling in browsers (it is a documented client option).
  2. The browser preflights the custom headers. The socket.io CORS policy reflects the origin, the credentials and the requested headers, so the handshake is sent with the victim's cookie, `Origin: https://evil.example` and the forwarding headers.
  3. `upgradeRequestUrl()` takes the first `X-Forwarded-Proto` and `X-Forwarded-Host` unconditionally and builds `https://evil.example/socket.io/?…`.
  4. `ctx.baseURL` is `''` for a dynamic config, so §7.10 adds the leg's own origin, `https://evil.example`, to the trusted set, and `isTrustedOrigin` accepts the handshake `Origin`.
  5. The verdict is memoized for the socket. Every message resolves as the victim, and the page reads the replies: this is Cross-Site WebSocket Hijacking.

  better-auth's router rejects the same headers. For a dynamic config it trusts `allowedHosts` (and `fallback`), never the request's own origin. It reads `X-Forwarded-Host` only under `advanced.trustedProxyHeaders`, and it validates the host against `allowedHosts`. The design's justification, "A browser cannot set forwarding headers on an upgrade", holds for a raw WebSocket upgrade. It does not hold for socket.io's polling handshake, which is the browser leg §9.3 uses.

  An HTTP variant exists under the same dynamic config. HTTP legs take their URL from the platform (`req.protocol`/`req.host`), which honors `X-Forwarded-Host` once `trust proxy` is set, as migration step 8 instructs. An origin that the app-route CORS allow-list admits with credentials, but that is missing from `trustedOrigins`, can add the header and pass the check on unsafe routes, where the router, which trusts only `allowedHosts`, would reject it.

- **Evidence:**
  - `probe-origin-dynamic-baseurl-xfh.mjs` (better-auth 1.7.4, production mode, socket.io 4; output in `.out`):
    - `ctx.baseURL = "" | ctx.trustedOrigins = ["https://api.example.com","https://api.example.com"]`;
    - `[router] Origin evil, no forwarding headers -> 403 INVALID_ORIGIN`;
    - `[router] Origin evil + X-Forwarded-Host/Proto evil -> 403 INVALID_ORIGIN`;
    - `[socket.io preflight] status 204 | ACAO https://evil.example | ACAC true | ACAH x-forwarded-host,x-forwarded-proto`;
    - `[socket.io handshake] origin = https://evil.example | x-forwarded-host = evil.example | has cookie = true`;
    - `[kernel] upgradeRequestUrl = https://evil.example/socket.io/?EIO=4&transport=polling… -> ALLOW`;
    - the same handshake without forwarding headers gives `403 INVALID_ORIGIN`;
    - `[guard] getSession on that socket -> victim@x.io`.
  - better-auth: `BA/context/helpers.ts:108-160` (`getTrustedOrigins`: a dynamic config pushes `allowedHosts` and `fallback`, not the request origin); `BA/utils/url.ts:273-300` (`getHostFromSource` reads `x-forwarded-host` only with `trustedProxyHeaders`), `:398-440` (`resolveDynamicBaseURL` checks `allowedHosts`); `BA/auth/base.ts:55-63`.
  - Design: §2.2.10 ("first X-Forwarded-Host value, else Host … Forwarded headers are acceptable here because a browser cannot set them on an upgrade"); §7.10 step 3 ("∪ the browser leg's own origin when `ctx.baseURL` is empty (… or a dynamic `{ allowedHosts }` config …)"). `LIB-origin-differential` has no dynamic-`baseURL` or forwarding-header rows, so the divergence goes untested.
- **Suggested fix:**
  1. Derive "the leg's own origin" the way better-auth derives the request origin, and only where better-auth trusts it:
     - for a dynamic `{ allowedHosts }` config, add nothing, because `ctx.trustedOrigins` already holds the `allowedHosts` and `fallback` origins;
     - for an unset `baseURL` (development, or `allowRequestDerivedBaseURL`), use the origin the router would derive. For HTTP legs that is the platform URL `AuthExchange` builds. For WebSocket legs it is the handshake's own `Host` and TLS state, with `X-Forwarded-Host`/`X-Forwarded-Proto` only when `advanced.trustedProxyHeaders` is set (better-auth's gate) or the platform's `proxyTrust()` trusts the socket's peer.
  2. `upgradeRequestUrl()` must not read forwarding headers by default. It can take a `trustForwardedHeaders` flag that the kernel sets from `advanced.trustedProxyHeaders`, and the scheme can come from `handshake.secure` / the socket's TLS state.
  3. Add rows to `LIB-origin-differential` and a case `T-ws-origin-forwarded-host`: a dynamic config and an unset `baseURL`, each with and without `trustedProxyHeaders`; a socket.io polling handshake and an HTTP unsafe request carrying `X-Forwarded-Host` equal to the attacker's origin. Expect 403, as the router answers.

### SEC-r3-03 (major): The default origin rule rejects better-auth's documented Expo (React Native) client on every unsafe app route, and nothing at boot or in the server log says why

- **Section:** §7.10 "The rule, `'cookie'` mode" step 2 and "Non-browser clients"; §2.2.1 `OriginCheckOptions.missingOrigin`; §13.4 (denials at debug); §17 Q15 and RK21 (which name SSR servers, BFFs and scripts only); §15.1 step 12; §14.4.
- **Failure scenario:** A mobile app built with better-auth's first-party Expo integration (`expo()` on the server, `expoClient()` in the app) talks to a Nest API that migrates to this library with the defaults.
  1. For its own requests, the app follows better-auth's Expo guide, "Making Authenticated Requests to Your Server": it reads the cookie with `authClient.getCookie()` and sends it as a `Cookie` header, with `credentials: 'omit'`. The guide's tRPC example does the same for mutations, which are POSTs.
  2. React Native's `fetch` sends no `Origin`, `Referer` or `Sec-Fetch-*` headers. That is why better-auth's `expoClient` adds `expo-origin` to its own calls, and why the server's `expo()` plugin copies `expo-origin` into `Origin` in `onRequest`, a router-only hook the kernel's check never sees.
  3. Every `POST`/`PUT`/`PATCH`/`DELETE` app route and every GraphQL mutation over HTTP sees a cookie on the browser leg with no origin. Under `missingOrigin: 'reject'` each answers 403 `MISSING_OR_NULL_ORIGIN`. The app can read, but it cannot change anything.
  4. The server logs the denials at debug only (§13.4). The boot summary prints `origin check: cookie/reject` but says nothing about the `expo` plugin it can see (`$context.hasPlugin('expo')`). better-auth's own origin failure logs at ERROR with a hint to add the origin (`origin-check.ts:290-294`). RK21 says the breakage "fails loudly", but it is loud only to the mobile client.

  The same request works with plain better-auth, where app routes have no origin rule, and with the reference library. It also works under `missingOrigin: 'allow-non-browser'`, because React Native sends none of `Origin`, `Referer` or `Sec-Fetch-Site`. Q15's analysis weighs only SSR servers, so the one default that breaks better-auth's own mobile integration is not on the table the user is deciding from.

- **Evidence:**
  - `packages/expo/src/index.ts:36-57` (server plugin: "To bypass origin check from expo, we need to set the origin header to the expo-origin header", applied only when `origin` is absent);
  - `packages/expo/src/client.ts:445-490` (the client sends `cookie` and `expo-origin` on better-auth calls only);
  - `docs/content/docs/integrations/expo.mdx:424-444` (manual `Cookie` header for "your server") and `:446-470` (tRPC headers);
  - design §7.10 step 2 (`'reject'` default), §13.4 ("origin-check failures included, are logged at `debug`"), §17 Q15/RK21 (SSR servers, BFFs, scripts);
  - `BA/api/middlewares/origin-check.ts:290-294` (better-auth's ERROR log with the trusted-origin hint).
- **Suggested fix:** Whatever Q15's answer is:
  1. Emit boot advice `W_ORIGIN_CHECK_NATIVE_CLIENTS` when `context.hasPlugin('expo')` and `missingOrigin` is `'reject'`. The session unit's `advise()` may name plugins; core may not. Name the two working options: `missingOrigin: 'allow-non-browser'`, or have the app send `Origin: <scheme>://` (already in `trustedOrigins` per the Expo guide) on its own requests.
  2. Log origin denials at WARN once per distinct `(reason, origin)` per application, with the origin value sanitized and truncated, capped like the 404 diagnostics (ADR-52), so misconfigured `trustedOrigins` and native clients surface in server logs without letting attack traffic flood ERROR.
  3. Add mobile clients to Q15's trade-off, RK21 and migration step 12, and add a §14.4 case: a cookie-only unsafe request with no `Origin`, `Referer` or fetch metadata. It gets 403 plus the advice under `'reject'`, and 200 under `'allow-non-browser'`.

### SEC-r3-04 (minor): `BetterAuthService.forwardCookies(fn)`, the documented per-call-site opt-in, gives a public login proxy no form-CSRF check. The SEC-r2-08 login-CSRF path stays open through it

- **Section:** §2.2.2 `forwardCookies`; §7.5 "Opt-in forwarding" (third bullet, `service.forwardCookies(() => this.auth.api.signInEmail({ body, headers }))`); §7.6 step 8; §7.1; §7.10 `'form'` mode; §17 Q13 option (b); RK14; migration step 11.
- **Failure scenario:** A team follows the per-call-site example in §7.5 instead of the decorator:

  ```ts
  @Public() @Post('login')
  login(@Body() body) { return this.auth.forwardCookies(() => this.auth.api.signInEmail({ body })); }
  ```
  1. A cross-site page auto-submits the attacker's credentials to `/login`. No cookie is needed, and better-auth's default `SameSite=Lax` does not matter, because the attack sets a cookie rather than sending one.
  2. The plan has `forwardDirectCalls: false`, because §7.6 step 8 derives it only from `@ForwardAuthCookies` or `cookies.forwardDirectCalls`. Its origin mode is therefore `'cookie'`, and the guard returns at `plan.access === 'public' && plan.originCheck !== 'form'` with no check.
  3. The scope interceptor still opens the handler scope. `forwardCookies` switches the scope to `'same-credential'`, and the sign-in call carries no credential (`NO_CREDENTIAL`), so the bridge forwards its `Set-Cookie`.
  4. The victim's browser is signed in to the attacker's account (login CSRF), which better-auth's `formCsrfMiddleware` blocks on `/sign-in/email` (403 `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED`).

  The same holds for `@OptionalAuth()` handlers. §7.5 even says "`@ForwardAuthCookies()` is required for its cookies to reach the browser at all, so the pattern is always an explicit choice", which contradicts `forwardCookies(fn)` two paragraphs earlier.

- **Evidence:** §7.6 step 8 ("`'form'` when direct-call forwarding is on for the handler … Direct-call forwarding follows `@ForwardAuthCookies` (method over class), else `cookies.forwardDirectCalls`"); §7.1 guard flow; §2.2.2 ("Run fn with Set-Cookie forwarding enabled for direct calls inside it"); §10.2 `sameCredential` (a credential-less call always forwards); `T-csrf-login-proxy` exercises only the decorator fixture; `BA/api/middlewares/origin-check.ts:303-376` (`validateFormCsrf`).
- **Suggested fix:** One of these:
  - (a) `forwardCookies(fn)` enforces the form rule itself. When the current scope's plan is not in `'form'` mode and the scope has a browser leg with `enforce`, it runs `handle.checkOrigin(browser, 'form')` (memoized per leg) before enabling forwarding, and throws the transport's 403 on failure. The interceptor already holds `call`, so the scope can carry the leg.
  - (b) `forwardCookies(fn)` only narrows. It throws `BetterAuthConfigurationError.atRequest('FORWARDING_NOT_DECLARED')` unless the plan forwards (`@ForwardAuthCookies()` or the instance option), and `anyCredential` stays available inside such handlers.

  Either way, fix the §7.5 sentence and add a `loginProxyService` fixture to `T-csrf-login-proxy`.

### SEC-r3-05 (minor): A GraphQL operation over a WebSocket whose context the transport does not recognize falls back to the HTTP branch, so queries on a hijacked socket skip the origin check

- **Section:** §9.2 "Carrier first, operation kind second" and the recognition table; §7.10 step 2 (GraphQL over HTTP: mutations only); ADR-61; RK3; `T-subscription-origin`.
- **Failure scenario:** The app uses Apollo with `subscriptions: { 'graphql-ws': true }` and a custom context that copies what its resolvers need into a plain object:

  ```ts
  context: ({ req, extra }) => ({
    req: req ?? { headers: { cookie: extra.request.headers.cookie } },
  });
  ```
  1. Nest keeps a user-supplied object `req` as it is (`assignReqProperty`), so over the socket `context.req` is `{ headers: { cookie } }`.
  2. §9.2 recognizes a WebSocket carrier only by `context.req.connectionParams` plus `extra.request`, by an `upgrade: websocket` header on `context.req` or `context.extra?.request`, or by Mercurius markers. This object has none of them, so the transport takes the "over HTTP" branch.
  3. On that branch the credentials are `kit.http.headers(req)` (the victim's cookie), the browser leg is the same object, and `enforce` follows the operation kind: false for a query.
  4. A cross-site page opens the graphql-ws socket (the browser attaches the cookie), subscribes with a query operation, and reads the victim's data. This is the SEC-r2-03 outcome under a context shape the fix does not list. Mutations are still stopped, because the copied headers carry no `Origin`.

  The failure mode is the problem: an unrecognized shape is treated as the permissive carrier, not the strict one.

- **Evidence:**
  - @nestjs/apollo 13.2.4 `dist/drivers/apollo-base.driver.js:196-229` (`wrapContextResolver`, and `assignReqProperty`, which returns `ctx` unchanged when `ctx.req` is an object);
  - @nestjs/graphql 13.2.4 `dist/services/gql-subscription.service.js:31-36` (the same context function is passed to graphql-ws, which also executes queries, 6.2.1 `server-DHPI7HHW.js:210-215`);
  - design §9.2: "Over HTTP, the operation kind decides `enforce` (mutations)".
- **Suggested fix:**
  - Invert the default. The "over HTTP" branch applies only when `context.req` is positively the running platform's request. Add an accessor predicate, e.g. `HttpRequestAccessor.isRequest(req)`: Express `req.res` with a string `method`; Fastify a request whose `raw` is an `IncomingMessage`.
  - Any other GraphQL context gets the WebSocket treatment: `enforce: true`, `cookies: null`, a per-operation key. A misrecognized HTTP request then fails closed (a query from an untrusted origin is denied), not open.
  - Add this third context shape to `T-subscription-origin` and `T-memo-once`.

### SEC-r3-06 (minor): The opt-in delegated admin path keeps granting a banned admin's API keys admin permissions; better-auth's own admin endpoints never accept a key

- **Section:** §8.3 row `permission(p, { principals: ['session', 'api-key'] })`; §8.4 ("a banned or demoted admin is locked out on the next message"); `Z-admin-banned`; `Z-delegation-scope`; ADR-35, ADR-36.
- **Failure scenario:** An admin creates a CI key granting `{ user: ['ban', 'set-role'] }`, and an internal `@RequirePermission({ user: ['set-role'] }, { principals: ['session', 'api-key'] })` route admits it. The admin account is later found compromised, and another admin bans it through better-auth.
  1. `banUser` sets `banned: true` and deletes the user's sessions. The user's API keys remain.
  2. The attacker calls the route with the key. `verifyApiKey` does not check the owner's ban, so it answers `valid`.
  3. The delegated path calls `userHasPermission({ body: { userId, permissions } })`. That reads the user's role, not `banned`, and answers `success: true`; the key's grant allows too, so the request is allowed.
  4. The attacker keeps admin-grade access through every route that opted keys in, until someone finds and revokes the keys by hand. `Z-admin-banned` tests only session principals, and §8.4 presents the ban as immediate.

  With plain better-auth the same key reaches no admin endpoint at all (401), because admin endpoints read an authoritative session. The widening is introduced by this design's opt-in.

- **Evidence:** `probe-banned-owner-key-admin.mjs` (better-auth 1.7.4 with admin and api-key; output in `.out`):
  - `before ban: … => ALLOW`;
  - `banUser -> true | sessions left for owner: 0 | api keys left for owner: 1`;
  - `owner sign-in after ban -> 403 BANNED_USER`;
  - `after ban: verifyApiKey valid | owner userHasPermission = true | key grant = true => ALLOW`;
  - `better-auth's own /admin/set-role with the key -> 401`.

  Source: `BA/plugins/admin/routes.ts:1142-1159` (`banUser` updates the user and deletes sessions only), `:1874-1893` (`userHasPermission` with `userId` reads the role only); `AK/index.ts:233-262` and `AK/routes/verify-api-key.ts` (no ban check).

- **Suggested fix:**
  - In the delegated branch, treat a banned owner as no owner: 401 `USER_BANNED`, the api-key plugin's own code. Use a user read that returns `banned`/`banExpires` and honors an expired ban as better-auth's `session.create` hook does, which is one read the branch already pays for through `userHasPermission`.
  - Alternatively, if reading the row is judged too close to reimplementation, ship and document a hook recipe (`@AfterAuth('/admin/ban-user')` revoking the user's keys), and have the admin unit's `advise()` warn whenever a plan opts delegated kinds into `permission()`.
  - Add a delegated variant of `Z-admin-banned`.

### SEC-r3-07 (minor): Security behavior keyed on the environment misfires in two common setups: an unset `NODE_ENV` silences B23 and every production warning, and `TEST=true` (set by vitest) silently turns the origin check off

- **Section:** §5.4 B18, B19, B23, B27; §6.3 step 7 (`W_PROXY_UNTRUSTED`); §7.10 step 4 (better-auth's skip flags); §12.8 and §14.4 (the stated reason for `NODE_ENV=production`); §14.1 (`T-csrf-*`, `T-ws-origin-*`); the docs note referenced at the end of §14.8.
- **Failure scenario:**
  - **Unset `NODE_ENV` in production.** A container image or PaaS that never sets `NODE_ENV` runs without `baseURL`:
    - B23 does not fire (it requires `NODE_ENV=production`), and better-auth only warns, so password-reset links follow the attacker's `Host` header (the SEC-r1-07 scenario);
    - the production warnings of B18, B19 and B27 stay silent, and `W_PROXY_UNTRUSTED` never logs;
    - if `BETTER_AUTH_SECRET` is also missing, better-auth signs with its public default secret, because it throws for that only when `NODE_ENV === 'production'`.

    The fail-closed check exists exactly for this misconfiguration and is switched off by a second, correlated one.

  - **`TEST=true`.** better-auth's `isTest()` is `NODE_ENV === 'test' || TEST is truthy`, and `skipOriginCheck = disableOriginCheck ?? isTest()`. vitest sets `TEST=true` in the main process and in every worker, whatever `NODE_ENV` is. So:
    - in a vitest run, both better-auth's router check and the kernel's mirrored check (§7.10 step 4) are off unless `disableOriginCheck: false` is explicit;
    - §12.8's rationale ("because better-auth switches its origin checks off under `NODE_ENV=test`") and the user docs describe only `NODE_ENV`, so a team that sets `NODE_ENV=production` in its own security tests believes the check is on;
    - §14.1 never states that the transport kit's instance sets `disableOriginCheck: false`, and the same holds for third parties running the kit under vitest;
    - B19's third bullet checks `NODE_ENV=test` rather than the effective flag, so any process with a truthy `TEST` (a staging image, a leaked CI variable) runs with every origin check off and no warning.
- **Evidence:**
  - `CORE/env/env-impl.ts:52-59` (`isProduction = nodeENV === "production"`; `isTest = () => nodeENV === "test" || toBoolean(env.TEST)`);
  - `BA/context/create-context.ts:58-72` (the default secret throws only when `isProduction`), `:152-155` (unset `baseURL` is a warning), and `:397-402` (LEAD-V18);
  - vitest 5.0.1 `dist/chunks/cli-api.DcLieX4F.js:414-416` (`process.env.TEST = "true"`; `NODE_ENV ??= "test"`) and `dist/chunks/index.DzobfTyw.js:11750-11753` (worker env `TEST: "true"`);
  - design B23 ("In production (`NODE_ENV=production`)"), B19 ("`NODE_ENV=test` while `disableOriginCheck` is unset"), §12.8.
- **Suggested fix:**
  1. Decide "production" for the fail-closed checks as "not explicitly development or test": `NODE_ENV` unset counts as production for B23, B18, B19 and B27. Print the assumed mode in the boot summary. See the proposed user decision.
  2. Make B19 read the effective flags (`$context.skipCSRFCheck`, or `$context.skipOriginCheck === true` with `disableCSRFCheck` undefined) rather than `NODE_ENV`, and name the cause (`NODE_ENV=test` or `TEST`) in the message.
  3. Add a boot check (error when production is assumed) for a context secret equal to better-auth's default, using the same "not explicitly development or test" rule.
  4. State in §14.1 that every kit instance sets `advanced.disableOriginCheck: false`, fix the §12.8 rationale, and document `TEST`.

### SEC-r3-08 (minor): GraphQL aliases multiply both the ERROR logs of one outage and the policy I/O of one request, with no bound

- **Section:** §7.2 (a rejection memoized per request; decisions per invocation), §8.1 (policy I/O deduped by concrete inputs only), §9.2 `toInternalException`, §13.1 ("logged … once"), §13.4, §7.9.
- **Failure scenario:**
  - **Log amplification during an outage.** The database is down. A client sends `query { a1: me a2: me … a500: me }`. The principal promise rejects once and is memoized for the request, but the guard runs for each of the 500 root-field invocations. Each run throws a new `BetterAuthGraphqlInternalError` from `toInternalException`, which is deliberately not intrinsic. Nest's `ExternalExceptionsHandler` logs every non-intrinsic throw per resolver invocation, so one HTTP request writes 500 ERROR entries with redacted cause stacks. A handful of such requests per second floods the log pipeline exactly while operators need it. §13.1's "logged once" holds for HTTP, WS and RPC, not for GraphQL. Guarded field resolvers under a list multiply it further.
  - **I/O amplification in normal operation.** An authenticated user sends 500 aliases of a root field guarded by `@RequireOrgPermission(p, { organization: fromParam('orgId') })`, each with a different `orgId`. Decisions are per invocation and the memo keys on concrete inputs, so the evaluator makes 500 parallel `hasPermission` calls, about 1,000–1,500 storage reads (§8.3 cost column). Every one of them is spent even though the fields are denied. One request exhausts the connection pool for everyone. Query-complexity limits are the app's job, but nothing in the design names the multiplier or bounds it.
- **Evidence:**
  - @nestjs/core 11.1.17 `helpers/external-context-creator.js:71-79` (each resolver invocation wrapped with its own exception proxy), `exceptions/external-exceptions-handler.js:13-18` and `exceptions/external-exception-filter.js:5-12` (`logger.error(exception)` for every non-`IntrinsicException`);
  - design §7.2 ("A rejection is memoized for the same request key too, so every root field fails the same way"), §9.2 ("It is not intrinsic, so Nest logs it once"), §7.9, §8.3 cost column.
- **Suggested fix:**
  1. Log an infrastructure failure once per request key. The first invocation that meets a memoized rejection throws the loggable `BetterAuthGraphqlInternalError`; later ones on the same key throw an intrinsic twin with the same client payload.
  2. Add a per-request budget for distinct policy I/O keys, for example a runtime option `limits.maxPolicyCallsPerRequest` (default 50). Past it, deny with 429 `TOO_MANY_AUTHORIZATION_CHECKS` instead of calling better-auth.
  3. Document the alias multiplier next to RK11 with a pointer to GraphQL complexity limits, and add a `T-invocation-decisions` variant that asserts one ERROR log line for N aliases during an outage.

## Proposed user decisions

- **When `NODE_ENV` is unset, do the fail-closed boot checks treat the process as production?** (Fix of SEC-r3-07.)
  - Option: yes. "Production" means "not explicitly `development`, `dev` or `test`". B23 fails boot without a `baseURL`, a default secret fails boot, and the production warnings fire. Developers set `NODE_ENV=development` or `BETTER_AUTH_URL`, which better-auth's docs already ask for.
  - Option: no. Keep `NODE_ENV=production` as the only trigger, and print "environment: unset (production checks skipped)" in the boot summary.
  - Recommendation: take the first option. B23 exists to fail closed on a misconfiguration that tends to come with a missing `NODE_ENV`; the cost is one variable in development.

- **How should the opt-in delegated admin path (`permission(p, { principals: ['session', 'api-key'] })`) treat a key whose owner is banned?** (Fix of SEC-r3-06.)
  - Option: deny. The branch reads the owner's row once (it already pays one user read), answers 401 `USER_BANNED` when `banned` is set and `banExpires` has not passed, and passes that row's `role` to `userHasPermission`, so the read count stays one. That mirrors a small part of the admin plugin's ban semantics.
  - Option: no mirror. Document that bans do not revoke keys, ship a `@AfterAuth('/admin/ban-user')` recipe that deletes the user's keys, and warn at boot when a plan opts delegated kinds into `permission()`.
  - Recommendation: take the first option. better-auth offers no admin access through keys at all, so there is no parity to preserve, and "a banned admin is locked out on the next request" (§8.4) should hold for every principal the design admits to admin routes.
