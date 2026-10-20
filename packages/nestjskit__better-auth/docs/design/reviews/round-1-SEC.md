# Round 1 review: SEC (security / SRE)

Input: `design-v1.md`. Verdict: **reject**.

## Summary

Security/SRE review of design v1, round 1. The HTTP body path is solid: byte-exact capture, limits with CORS-visible 413s, write-back, header hygiene and HTTP/2. Refresh suppression and S3 path resolution also hold up. Seven probes support my claims. Four ran against better-auth 1.7.4 and @better-auth/api-key 1.7.4 and are in scratchpad/tmp-review-SEC-r1: probe-bridge-foreign.mjs, probe-stale-admin.mjs, probe-apikey-infra.mjs and probe-unset-baseurl.mjs. The other three were file reads: the drizzle-orm 0.45.2 tarball, @nestjs/websockets 11 vs 12, and @nestjs/core 12's exports map.

Two blockers.

1. The design says CSRF is handled inside better-auth. better-auth's origin check is a router-only middleware, so it never protects cookie-authenticated Nest routes, GraphQL or WebSocket handshakes. In a probe, the guard's getSession accepted an evil-origin cookie request that the router rejected with 403.
2. Non-session principals are accepted on every authenticated route. The admin permission() policy judges them with the owner's user role, so a scoped API key or OAuth token escalates to the owner's full privileges.

Majors:

- The cookie bridge forwards Set-Cookie from direct auth.api calls made with foreign credentials. In a probe, a service account's session_token landed where it would be appended to the user's response.
- The admin policy reads identity from the cookie cache. A banned admin still passed @RequirePermission, while better-auth's own listUsers returned 401, which contradicts §8.4's parity claim.
- apiKeyPrincipal() sits on verifyApiKey, which turns a DB outage into INVALID_API_KEY (401) and a rate limit into a value with no Retry-After (violates S6).
- Behind a proxy with default trust-proxy settings, all clients share one rate-limit bucket, and the design silences better-auth's own warning about it.
- With no baseURL in production, the client's Host header reaches better-auth. In a probe the password-reset link pointed at the attacker's host, and there is no boot check.
- Logging infrastructure errors with their cause chain leaks session tokens: Drizzle error messages include query params.
- Hybrid RPC apps without inheritAppConfig are left fail-open.
- Requirements on GraphQL @ResolveField methods are silently not enforced.
- Named instances share cookie names, causing cross-instance logout or session acceptance.

Minors: the WS coverage probe checks the wrong package, the TTL memo caches infrastructure failures, API keys consume quota and write to the DB on every WS message, initTestApp conflicts with exclusive binding, no diagnostic for bodiless 404s, the CORS helper widens credentialed access app-wide, the client-IP header name is fixed and public, and configuration-error messages leak to GraphQL clients.

Operational note: the host disk hit ENOSPC late in this review, so Bash stopped working and later verification used file reads only. Other agents may hit the same problem.

## Findings

### SEC-r1-01 (blocker): Cookie-authenticated app routes, GraphQL and WebSocket handshakes get no origin/CSRF check; the design wrongly assigns CSRF to better-auth

- **Section:** §0.2 (P1/P2, P8), §3.3, §6.9, §7.1/§7.3, §9.2–§9.3, §14.4
- **Failure scenario:** The deployment uses better-auth's documented cross-domain cookies (`advanced.defaultCookieAttributes: { sameSite: 'none', secure: true }`), or an attacker controls a sibling subdomain (same-site, e.g. with crossSubDomainCookies). The attacker page auto-submits `<form method=POST action=https://api.example.com/projects/42/transfer enctype=application/x-www-form-urlencoded>`. The browser attaches `__Secure-better-auth.session_token`, the global BetterAuthGuard calls `auth.api.getSession({ headers })`, gets an authenticated principal, and the handler performs the state change. Likewise, a cross-site `new WebSocket('wss://api.example.com/socket.io/?EIO=4&transport=websocket')` carries the cookie in the handshake. socketIoTransport authenticates from `handshake.headers` and the attacker reads the replies, because CORS does not apply to WebSockets (Cross-Site WebSocket Hijacking). better-auth rejects the identical request on its own routes with 403 INVALID_ORIGIN.
- **Evidence:** better-auth's origin check exists only as a router middleware: `BA/api/index.ts:288-292` (`routerMiddleware: [{ path: '/**', middleware: originCheckMiddleware }]`) and `BA/api/middlewares/origin-check.ts:67-77, 221-297`. R:ba-core §3.3 says direct `auth.api` calls skip origin/CSRF. Probe `tmp-review-SEC-r1/probe-bridge-foreign.mjs` (NODE_ENV=production, disableOriginCheck:false) printed `direct getSession from evil origin -> session for victim@x.io` versus `router POST /update-user from evil origin -> 403 {"code":"INVALID_ORIGIN"}`. In the design: §0.2 (row P1/P2) and §3.3 list origin/CSRF as handled inside `auth.handler`; §6.9 configures no CORS; §9.3 never inspects the handshake Origin; §14.4 tests CSRF only on auth routes.
- **Suggested fix:** Add a kernel integrity step that transports feed (e.g. `TransportCall.method` plus browser signals). When the presented credential is the better-auth session cookie (Cookie present, no Authorization or x-api-key in use) and the operation is unsafe (HTTP non-GET/HEAD/OPTIONS, GraphQL mutation, every WS handshake), validate the origin with better-auth's own rules and matcher:
- read Origin, falling back to Referer; infer `Origin: null` + `Sec-Fetch-Site: same-origin` as validateOrigin does;
- match with `(await $context).isTrustedOrigin()`, evaluating function-valued trustedOrigins against a lightweight Request;
- honor `disableCSRFCheck`, `disableOriginCheck` and `skipOriginCheck` exactly as better-auth does;
- deny 403 with better-auth's codes (INVALID_ORIGIN, MISSING_OR_NULL_ORIGIN).

Also:

- provide a per-route opt-out `@RequireAuth({ originCheck: false })`;
- enforce the same check in WsConnectionAuth and in the ws, socket.io and graphql-ws handshakes;
- correct §0.2 and §3.3;
- add app-route and WS cases to §14.4 and a `T-csrf` transport-kit case.

### SEC-r1-02 (blocker): Non-session principals (API keys, OAuth tokens) are accepted on every authenticated route, and permission() judges them with the owner's user role, bypassing key permissions and scopes

- **Section:** §4.3.3, §2.2.15, §8.3 (admin row), §7.6, §11.6
- **Failure scenario:** The app registers `principals: [apiKeyPrincipal()]` for its /public-api routes and also has `@RequirePermission({ user: ['ban'] }) @Post('admin/users/:id/ban')`. An admin creates a CI key with `permissions: { reports: ['read'] }`, and the key leaks. The attacker sends `x-api-key: <key>` to /admin/users/123/ban. The chain returns an 'api-key' principal whose userId is the key's referenceId, following AuthPrincipalBase's definition 'the user this principal acts for'. adminPermissionPolicy accepts 'any kind with userId' and calls `userHasPermission({ body: { userId } })`, which evaluates the admin's role and allows the request. The key's own permissions are never consulted. Likewise, every route with only default 'authenticated' access that does not read @Session() accepts any key, and so does every custom policy that uses principal.userId (the §4.4.4 ProjectOwnerPolicy). The §4.3.4 OAuth access-token source gives a token scoped to 'openid' the user's full rights on all such routes.
- **Evidence:** - §4.3.3: one ordered chain per instance applies to every route; the first `authenticated` wins.
- §8.3 admin row: 'Principal: any kind with userId'.
- §2.2.15: `adminPermissionPolicy: AuthorizationPolicy<AdminPermissionParams, AuthPrincipal>` declares no requires.principals, and ApiKeyPrincipal leaves userId unspecified while exposing referenceId.
- `packages/api-key/src/schema.ts:39`: referenceId is the owning user (or org) id.
- R:_digest ref-issues pitfall: 'Combining role sources (user.role OR org role) enables privilege escalation (PR #94 review)'; the matching implication says 'never merge role sources implicitly'.
- **Suggested fix:** Make principal acceptance per route and data-driven, with no core branching on kind names:

1. Each PrincipalSource declares `acceptance: 'default' | 'explicit'`. The session source is default; the api-key and OAuth sources are explicit.
2. The planner admits explicit-kind principals only where the handler opts in (`@RequireAuth({ principals: ['api-key'] })`) or where a requirement's policy lists that kind in `requires.principals` (so `@RequireApiKeyPermission` implies it). Otherwise it returns 403 PRINCIPAL_NOT_SUPPORTED before any policy runs.
3. Give adminPermissionPolicy `requires.principals: ['session']`. If api-key support is opted into, AND the owner role with `role(principal.permissions).authorize(p)`.
4. Specify ApiKeyPrincipal.userId explicitly.
5. Add a policy-kit case: a scoped key cannot pass a user-role policy.

### SEC-r1-03 (major): The cookie bridge forwards Set-Cookie from direct auth.api calls made with other credentials, handing the end user another principal's session or logging them out

- **Section:** §7.5, §10.2 (after-hook entry 4), RK14
- **Failure scenario:** Inside user U's request (the scope interceptor sets bridge: true), a service calls `auth.api.getSession({ headers: { authorization: `Bearer ${serviceAccountToken}` } })` to act as a service account. When that session is due for refresh, better-auth puts `session_token=<service token>` into responseHeaders. Bridge entry 4 appends it to U's HTTP response, so U's browser now authenticates as the service account. If the foreign token is expired instead, deleteSessionCookie clears U's own cookie. A back-office 'create user' handler that calls `auth.api.signUpEmail({ body })` (autoSignIn is on by default) silently replaces the admin's session with the new user's.
- **Evidence:** Design §10.2 entry 4: the matcher `!isRouter(ctx) && !!s?.cookies && s.bridge` forwards `ctx.context.responseHeaders.getSetCookie()` whatever credentials the call used. `BA/api/routes/session.ts:387-396`: refresh calls setSessionCookie with the refreshed session's token. `:288-291`: deleteSessionCookie runs on an unknown or expired token. Probe `probe-bridge-foreign.mjs`: a nextCookies-style after-hook captured `__Secure-better-auth.session_token=IDHiGyz1QtY7…` (the service account's token) from a getSession called with the service bearer token.
- **Suggested fix:** The scope records a fingerprint (hash) of the inbound credential: session-cookie value, Authorization or x-api-key, taken from TransportCall.headers(). Entry 4 forwards only when the direct call carried no credential headers (login and sign-up flows) or a credential whose fingerprint matches the scope's. Otherwise it drops the cookies and logs once at debug with the endpoint path. Offer `service.withCookies(fn)` for deliberate account switching, document the admin sign-up case (`runOutsideScope`), and add a conformance case `S-bridge-foreign-credentials`.

### SEC-r1-04 (major): The admin permission policy reads the role fresh but identity from the cookie cache: a banned or revoked admin keeps admin access, contrary to the claimed parity with better-auth's admin endpoints, and a deleted user becomes a 500

- **Section:** §8.3 (admin row), §8.4, §7.3, §13.2
- **Failure scenario:** With `session.cookieCache.enabled: true` (maxAge 300), admin B bans admin A, and better-auth deletes all of A's sessions. For up to 300 s, A's requests to `@RequirePermission({ user: ['ban'] })` Nest routes still pass: the guard's getSession is served from the session_data cookie, then `userHasPermission({ userId })` reads A's unchanged role and returns success. better-auth's own listUsers rejects A immediately. If A's account is deleted instead, userHasPermission throws 400 'user not found'. §13.2 maps 'other 4xx' to BetterAuthConfigurationError, so every request until the cache expires gets a 500 and an ERROR log saying 'better-auth rejected the library's call'.
- **Evidence:** Probe `probe-stale-admin.mjs` printed:
- `session rows left for rogue: 0`
- `guard getSession (default freshness): authenticated as rogue@x.io`
- `admin policy userHasPermission(userId): {"error":null,"success":true}`
- `better-auth listUsers: 401`

Source: `BA/plugins/admin/routes.ts:33-46` (adminMiddleware uses getAuthoritativeSessionFromCtx) and `:1864-1894` (findUserById, then 400 'user not found'); `BA/api/routes/session.ts:527-539` (the authoritative read). Design §8.4 claims 'This matches better-auth's own admin endpoints'.

- **Suggested fix:** - Add a data-driven policy attribute `requires.freshIdentity: true` and declare it on adminPermissionPolicy. The planner then raises the route's freshness to 'authoritative': one disableCookieCache read when stateful, with memo semantics unchanged.
- Map the admin endpoint's 400 'user not found' to a 401/403 denial (reason USER_NOT_FOUND) rather than a configuration error.
- Correct §8.4.
- Add a policy-kit case: a banned admin with a warm cookie cache is denied.

### SEC-r1-05 (major): apiKeyPrincipal() built on verifyApiKey turns a database outage into 401 INVALID_API_KEY and a rate limit into a non-429 value (S6 violated)

- **Section:** §8.3 (API keys note), §7.7, §13.1, §14.3 item 7, invariant P1 / S-infra-throws
- **Failure scenario:** - **Database outage:** every API-key request gets 401 INVALID_API_KEY. Machine clients treat their keys as revoked (they rotate keys or disable the integration), and monitoring sees 4xx instead of 5xx.
- **Rate limit:** verifyApiKey returns `{ valid:false, error:{ code:'RATE_LIMITED', details:{ tryAgainIn } } }`. That is not an APIError and carries no headers, so §7.7's promise of '429 RATE_LIMITED, Retry-After passed through' cannot hold, and a valid:false→401 mapping tells clients their key is bad.
- **Invalid keys:** better-auth logs 'Failed to validate API key:' at ERROR for every invalid key, so attackers can flood ERROR logs, contradicting T-no-error-log.
- **Evidence:** The catch block of the verifyApiKey handler in `packages/api-key/src/routes/verify-api-key.ts` (after the validateApiKey call) turns every error, including non-APIError ones, into `{ valid:false, code:'INVALID_API_KEY' }`. consumeRateLimit (`:292-297`) throws an APIError with only `details.tryAgainIn` and no headers. Probe `probe-apikey-infra.mjs` (better-auth 1.7.4, @better-auth/api-key 1.7.4):
- (c) invalid key → INVALID_API_KEY;
- (b) third call → RATE_LIMITED, tryAgainIn 60000;
- (a) adapter findOne throwing 'connect ECONNREFUSED' → `{"valid":false,"error":{"code":"INVALID_API_KEY"}}`;
- each denial was logged `[better-auth error] Failed to validate API key:`.
- **Suggested fix:** Specify the result mapping in ./api-key:
- KEY_NOT_FOUND, INVALID_API_KEY, KEY_DISABLED, KEY_EXPIRED → rejected 401;
- RATE_LIMITED, USAGE_EXCEEDED → rejected 429 with `Retry-After = ceil(details.tryAgainIn / 1000)`;
- FAILED_TO_UPDATE_API_KEY and unknown codes → BetterAuthInfrastructureError.

INVALID_API_KEY is ambiguous. Either run a cheap infrastructure sentinel (one `$context.adapter.findOne` on the apikey model; if it throws, answer 5xx) or record it as a residual risk like RK2 and propose upstream that non-APIError exceptions be rethrown. Add S-infra-throws and S-rate-limited cases for the api-key source, and document better-auth's ERROR log per invalid key. Apply the same Retry-After derivation to the enableSessionForAPIKeys getSession path, which also sets no header.

### SEC-r1-06 (major): Behind a proxy with default trust-proxy settings, every client shares one rate-limit bucket, and the design suppresses better-auth's own warning about it

- **Section:** §6.8, B18, §15.4
- **Failure scenario:** A typical deployment sits behind an ALB or nginx, with Express `trust proxy` unset (default false) or Fastify `trustProxy: false`. For every request, `req.ip` is the proxy's socket address, and AuthExchange sets x-nsba-client-ip to it. better-auth keys all clients on that one IP, so sign-in and sign-up are limited to 3 per 10 s for the entire user base. One attacker sending 3 sign-in requests every 10 s locks every user out. better-auth's own 'falling back to a single shared per-path bucket' warning never fires because a valid IP is always supplied, and B18 checks neither condition. The opposite misconfiguration also bites: `trust proxy: true` makes req.ip the client-supplied left-most X-Forwarded-For value, so rotating that header bypasses the limit.
- **Evidence:** `BA/api/rate-limiter/index.ts:342-359` warns only when `!ip`; `:442-451` sets window 10 / max 3 for /sign-in, /sign-up, /change-password and /change-email. `CORE/utils/ip.ts:353-384`. Design §6.8 steps 1–3 and the B18 conditions (user list not first; clientIpHeader false with nothing configured). The only mention of the migration impact is one line in §15.4.
- **Suggested fix:** 1. Platforms report their trust-proxy state (Express `app.get('trust proxy')`, Fastify `initialConfig.trustProxy`) in the boot summary.

2. In production, the platform's dispatch logs a one-time WARN (W_PROXY_UNTRUSTED) when a request carries X-Forwarded-For, Forwarded or X-Real-IP while trust proxy is off, naming the socket IP that became the bucket key.
3. Warn at boot when trust proxy is `true` (trust every hop) in production.
4. Make this a numbered migration-checklist step and add a conformance case.

### SEC-r1-07 (major): With no baseURL in production, AuthExchange feeds the client's Host header into better-auth, enabling password-reset link poisoning; there is no boot check

- **Section:** §6.2, §6.3 step 2, §5.4 (B20), §14.4
- **Failure scenario:** BETTER_AUTH_URL is missing in production; better-auth only logs a warning at init. The Express platform builds the URL from `req.protocol://req.host`, which is the attacker's `Host: evil.example`. better-auth derives baseURL and a trusted origin from that request. The attacker POSTs /api/auth/request-password-reset for the victim's email with that Host header, the victim receives a reset link to https://evil.example/..., and the attacker captures the token: account takeover.
- **Evidence:** `BA/auth/base.ts` handler, no-baseURL branch (about lines 71-95): getBaseURL from the request, with trusted origins derived from it. `BA/context/create-context.ts:152-154`: a warning only. Probe `probe-unset-baseurl.mjs` printed `status: 200 | reset link mailed to victim points at: https://evil.example`. Design §6.3 step 2 keeps the platform origin when there is no static baseURL; B20 covers only allowedHosts without a fallback; §14.4 tests Host injection only with a static baseURL.
- **Suggested fix:** Add a boot check (B23): when NODE_ENV is production, `(await $context).baseURL === ''` and baseURL is not a dynamic `{ allowedHosts }` config, fail boot with UNSAFE_BASE_URL and the hint 'set baseURL / BETTER_AUTH_URL or allowedHosts'. Provide an escape hatch, `http.allowRequestDerivedBaseURL: true`, that downgrades it to a warning. Add a §14.4 case with no baseURL set.

### SEC-r1-08 (major): Logging infrastructure errors 'with their cause chain' writes bearer and session tokens to logs and error trackers

- **Section:** §2.2.6 (BetterAuthInfrastructureError), §7.7, §13.1, §13.4
- **Failure scenario:** Postgres via Drizzle times out during a guarded request. getSession's findSession(token) fails with a DrizzleQueryError whose message is `Failed query: select … where "token" = $1\nparams: <session token>`. The guard wraps it in BetterAuthInfrastructureError, whose cause is public. Nest, or pino-http / nestjs-pino serializers and Sentry's linked-errors integration, then log the cause chain. During the outage, every guarded request ships a live session token (or bearer token, via the bearer plugin) to Datadog or Sentry, although §13.4 promises tokens are never logged.
- **Evidence:** drizzle-orm 0.45.2 `errors.js:10-16` (checked in the npm tarball): `class DrizzleQueryError extends Error { constructor(query, params, cause) { super(`Failed query: ${query}\nparams: ${params}`) … } }`. Design §13.1: 'logged: yes, once, with its cause'. §13.4: 'Infrastructure failures are logged once per request with their cause chain'; 'Never logged: … bearer tokens and API keys'. §2.2.6: `readonly cause: unknown`.
- **Suggested fix:** Log a redacted cause. Before logging or attaching the cause, scrub every credential value present in the request (cookie values, bearer token, x-api-key) from the message and stack of the whole cause chain, or log only name, code, errno and a truncated first line. Keep the raw cause behind a non-enumerable symbol, available only through an explicit debug option (`errors.exposeRawCause`). Add a hygiene conformance case: an adapter that throws with the token in its message must leave no token in captured logs.

### SEC-r1-09 (major): Hybrid apps without inheritAppConfig leave every RPC handler unauthenticated, with only an info reminder

- **Section:** §9.4 (guard registration), B22, §14.2
- **Failure scenario:** The app calls `app.connectMicroservice({ transport: Transport.NATS })` (inheritAppConfig defaults to false) and registers `transports: [rpcTransport()]` with globalGuard true. APP_GUARD never runs for @MessagePattern or @EventPattern handlers, so any NATS publisher can invoke them unauthenticated, and `defaultAccess: 'authenticated'` is silently not enforced. For the equivalent WebSocket gap the design fails boot; here it only prints a B22 info line.
- **Evidence:** Design §9.4: 'Hybrid apps apply it only with connectMicroservice(options, { inheritAppConfig: true }) … The boot summary prints this reminder'. B22 is _info_. R:nest-di §3.4 and _digest: 'Hybrid apps skip global guards and filters unless inheritAppConfig is set'. ADR-18's rationale ('secure by default, fails closed') is applied only to WS.
- **Suggested fix:** Give rpcTransport a B16 validate() with `hybridCoverage: 'error' | 'warn' | 'off'` (default 'error'). When an HTTP adapter exists, every controller with microservice pattern handlers must carry @UseBetterAuth() or @Public(), unless the user asserts `rpcTransport({ inheritsAppConfig: true })`. Duplicate guard runs are memo hits, as with WS. Add the hybrid-without-inheritAppConfig case to the matrix job.

### SEC-r1-10 (major): Access and requirement decorators on GraphQL @ResolveField methods are silently not enforced

- **Section:** §9.2 (Guard coverage), §5.4 (B14/B15/B16)
- **Failure scenario:** An Employee resolver declares `@RequirePermission({ salary: ['read'] }) @ResolveField('salary')` with the default driver options (no fieldResolverEnhancers). The root query `employees` is authenticated, but the field guard never runs, so any authenticated user reads every salary. The carrier stamp still makes @Session() work inside the field resolver, which reinforces the impression that auth ran.
- **Evidence:** Design §9.2: 'Requirements on field resolvers are enforced only then, and the docs say so.' R:nest-di §3.4 / _digest: '@ResolveField resolvers skip guards unless fieldResolverEnhancers is set'. §5.4 already scans every resolver method for B14 and B15.
- **Suggested fix:** In the GraphQL transports' validate(), read the GraphQL module options (GRAPHQL_MODULE_OPTIONS / driver options). Fail boot with FIELD_RESOLVER_UNGUARDED when any @ResolveField method carries our access or requirement metadata while fieldResolverEnhancers lacks 'guards'. Provide a per-method escape hatch and add a transport-kit case.

### SEC-r1-11 (major): Named instances share better-auth's default cookie names, causing cross-instance logout and, with a shared secret and database, cross-instance session acceptance

- **Section:** §5.5, B07/B10
- **Failure scenario:** In the §5.5 example, `auth` and `adminAuth` both keep cookiePrefix 'better-auth', so both use `__Secure-better-auth.session_token` with Path=/. A customer signed in on the default instance calls a `@UseAuthInstance('admin')` route, and the admin instance's getSession reads the same cookie:
- **Same BETTER_AUTH_SECRET, different database:** findSession returns null, deleteSessionCookie runs, and the guard forwards the clearing Set-Cookie, logging the customer out of the main app.
- **Same database:** the customer's token authenticates on the admin instance, so admin routes that only require authentication accept it.

Signing in on either mount also overwrites the other instance's session.

- **Evidence:** `BA/api/routes/session.ts:89-92`: the cookie name comes from `ctx.context.authCookies.sessionToken.name`. `:288-291`: deleteSessionCookie on an unknown token. The default prefix yields `__Secure-better-auth.session_token` (probe output). Design §5.5 validates only mounts, names and the global guard (B07, B10).
- **Suggested fix:** Add a boot check (B24): for every pair of instances, compare `(await $context).authCookies` names (sessionToken, sessionData, dontRememberToken) together with their domain and path attributes. Fail boot with COOKIE_NAME_COLLISION and the hint `advanced.cookiePrefix`. Update the §5.5 example to set distinct prefixes.

### SEC-r1-12 (minor): The WS coverage probe inspects @nestjs/core, but @nestjs/websockets decides whether global enhancers reach gateways (fails open on version skew)

- **Section:** §9.3 item 3, ADR-18, LEAD-V6/LEAD-V12
- **Failure scenario:** A partial upgrade leaves @nestjs/core 12 installed with @nestjs/websockets 11. The peer mismatch is tolerated as pnpm warnings or with --legacy-peer-deps, and core 12's `"./*": "./*.js"` export lets websockets 11's deep requires resolve. The probe finds `mapException` and treats gateways as covered, so boot passes. But websockets 11 builds `GuardsContextCreator(container)` without config, so APP_GUARD never runs and every gateway is open.
- **Evidence:** - @nestjs/websockets 11.1.17 `socket-module.js:80-81`: `getContextCreator(container)` with `new GuardsContextCreator(container)`.
- @nestjs/websockets 12.0.1 `socket-module.js`: `getContextCreator(container, config, exceptionFiltersContext)` with `new GuardsContextCreator(container, config)`.
- @nestjs/core 12.0.1 package.json exports `{"./*":"./*.js"}`, and `guards/guards-context-creator.js` exists.
- Design §9.3 item 3 probes `AbstractHttpAdapter.prototype.mapException` from @nestjs/core.
- **Suggested fix:** Probe the package that decides the behavior, e.g. check `SocketModule.prototype.getContextCreator.length >= 2` in @nestjs/websockets, pinned in CI on both majors. Alternatively, drop the probe and require @UseBetterAuth() or @Public() on every gateway on all majors (A-ADR-14); the duplicate guard run is a memo hit.

### SEC-r1-13 (minor): The connection-level TTL memo also caches infrastructure failures, turning a DB blip into minutes of failures per socket

- **Section:** §7.2 (TTL entries), §9.3 (WsConnectionAuth), ADR-10
- **Failure scenario:** A chat gateway sets `principalTtlMs: 300_000`. The database fails for 2 s. The resolution promise for socket S rejects with BetterAuthInfrastructureError and is memoized on the socket key, so every message on S returns 'Internal server error' for 5 minutes after the database recovers. WsConnectionAuth.authenticate caches the same way.
- **Evidence:** §7.2: 'A rejection is memoized for the same key too' combined with 'TTL entries … the entry lives on the connection key with an expiresAt'.
- **Suggested fix:** Memoize failures only on request-scoped keys. TTL (connection) entries should store only settled authenticated, absent or rejected results and be evicted on an infrastructure error, or cap the failure TTL at about 1 s.

### SEC-r1-14 (minor): API-key principals on WebSocket messages verify, and write to the DB, per message, burning key quota; the design claims 'no writes' and B21 implies apiKeyPrincipal avoids the quota drain

- **Section:** §9.3, §7.9, B21, §8.3 (API keys note)
- **Failure scenario:** A socket.io client maps handshake.auth to x-api-key. With the default principalTtlMs of 0, verifyApiKey runs on every message, so the default key rate limit (10 per day) is exhausted after 10 messages. Each message also performs at least one DB write (incrementOne plus an updatedAt stamp).
- **Evidence:** `packages/api-key/src/index.ts:84-91`: rateLimit enabled by default, maxRequests 10 per 24 h. `routes/verify-api-key.ts:165-222`: claimUsageInDatabase always writes updatedAt, and consumeRateLimit increments. Design §9.3: 'with no writes, because refresh is suppressed'. §7.9 and B21: 'Prefer apiKeyPrincipal()', though it also consumes one unit per resolution.
- **Suggested fix:** Let sources declare that each resolution consumes quota or writes. On connection transports the resolver then memoizes such principals per connection (for example a 60 s default TTL), or boot warns when an api-key source is combined with WS transports and principalTtlMs is 0. Correct the wording in §9.3 and B21.

### SEC-r1-15 (minor): initTestApp closes apps in afterAll, so apps created per test collide with exclusive binding, and a failed app.init() leaves the instance bound

- **Section:** §2.2.16 (initTestApp), §10.6, §5.7, B06
- **Failure scenario:** A standard e2e spec builds the app in beforeEach and calls initTestApp. Test 2's init throws INSTANCE_ALREADY_BOUND because test 1's app stays bound until afterAll. If a later module's onModuleInit throws after the core module has bound the plugin, the binding stays and every following test fails with INSTANCE_ALREADY_BOUND, hiding the original error.
- **Evidence:** §2.2.16: 'registers app.close() with a global afterAll'. §10.6: exclusive binding. §5.7: bind happens in the core module's onModuleInit; unbind happens only in onApplicationShutdown.
- **Suggested fix:** When initTestApp runs inside a test or beforeEach, register close with afterEach or onTestFinished; alternatively, automatically close the previously initialized app for the same instance. In bind(), allow a takeover with a WARN when the previous owner never reached onApplicationBootstrap, tracked by a 'bootstrapped' flag on the binding.

### SEC-r1-16 (minor): There is no diagnostic for requests under the mount path that better-auth does not route: they stay bodiless 404s

- **Section:** §6.10, §6.2, B12
- **Failure scenario:** A client sets its baseURL to `https://api.example.com/api/auth/api/auth`, or calls `/api/auth/signin/email`. The platform routes it to auth.handler, better-auth answers 404 with no body, and nothing is logged. This is the biggest pain cluster in the reference library.
- **Evidence:** Design §6.10: 'better-auth Response (any status, …) verbatim'. R:_digest ref-issues cluster 1 and the implication 'return informative errors for misconfiguration instead of bodiless 404s, since ~20% of issues were misconfiguration'.
- **Suggested fix:** Outside production (or with `http.diagnostics: true`), when auth.handler returns 404 for a matched path, log once per path at WARN with the resolved basePath and a Levenshtein 'did you mean' over `auth.api[*].path`, the list B12 already builds. Never change the response.

### SEC-r1-17 (minor): The recommended app-wide `enableCors({ origin: betterAuthCorsOrigin(auth), credentials: true })` lets every better-auth trusted origin read every app route with credentials, including wildcards meant only for CSRF and redirect allow-listing

- **Section:** §6.9 (betterAuthCorsOrigin), §15.1 step 4
- **Failure scenario:** trustedOrigins contains `https://*.vercel.app` for preview deployments, or a partner origin allowed only as a callbackURL, and cookies are SameSite=None. Any page on a matching origin can run `fetch('https://api.example.com/me', { credentials: 'include' })` and read the victim's data from every Nest route, not just the auth routes.
- **Evidence:** §6.9: the helper delegates to isTrustedOrigin, including its wildcard and custom-scheme semantics and plugin-contributed origins. §15.1 step 4 recommends the helper app-wide with credentials: true.
- **Suggested fix:** By default, allow only exact https origins in the helper and reject wildcard or custom-scheme matches unless `allowPatterns: true` is set. Document that trustedOrigins then widen credentialed CORS for all routes, and in §15.1 recommend an explicit CORS allow-list or scoping the helper to the auth routes.

### SEC-r1-18 (minor): The trusted client-IP header has a fixed, public name, so any path that forwards raw client headers to better-auth lets clients choose their rate-limit bucket and recorded IP

- **Section:** §6.8, ADR-15, RK13
- **Failure scenario:** A custom controller proxies `auth.handler(new Request(url, { headers: req.headers, … }))`, or a service calls `auth.api.signInEmail({ headers: fromNodeHeaders(req.headers) })`, better-auth's documented idiom. The attacker sends a random `x-nsba-client-ip` on each request. better-auth trusts that header first (the plugin default), so every proxied request gets a fresh rate-limit bucket and session rows record a spoofed IP.
- **Evidence:** §6.8 step 2: `ipAddressHeaders: ['x-nsba-client-ip']`. RK13: 'Any other code path that calls auth.handler directly … must strip it' (mitigated by documentation only). `CORE/utils/ip.ts:363-377` walks the configured headers in order.
- **Suggested fix:** Have nestjs() generate the header name per process, e.g. `x-nsba-ip-${globalThis.crypto.randomUUID().slice(0, 8)}` (Web Crypto, so the plugin stays runtime-agnostic). The header never leaves the process, and the kernel already reads the name from the bridge handle. Use a fixed name only when clientIpHeader is set explicitly, and strip the header in headersFrom().

### SEC-r1-19 (minor): Request-time BetterAuthConfigurationError messages (handler names, instance names, better-auth error text) reach GraphQL clients verbatim

- **Section:** §13.1 (Configuration row), §7.8 item 3, §13.2, §9.2
- **Failure scenario:** A resolver raises 'No authentication result for AdminResolver.users: BetterAuthGuard did not run (globalGuard: false without @UseBetterAuth() …)', or BETTER_AUTH_REJECTED_CALL '… (400 user not found)'. Apollo and Mercurius put err.message into errors[0].message in production; only stack traces are stripped.
- **Evidence:** §13.1: the configuration row answers 500 with detailed messages (§7.8 item 3, §13.2 normalizeThrown). Only BetterAuthInfrastructureError gets a generic message and extensions (§2.2.6, §9.2 'Infrastructure').
- **Suggested fix:** On GraphQL, treat BetterAuthConfigurationError like the infrastructure error: a generic message ('Authentication is misconfigured') with `extensions: { code: 'INTERNAL_SERVER_ERROR', reason: 'AUTH_MISCONFIGURED' }`. Keep the details in the server log only.

## Proposed user decisions

- _*On app routes, what should the new origin/CSRF check (SEC-r1-01) do with cookie-bearing unsafe requests that have no Origin, Referer or Sec-Fetch-* header, for example Next.js or Nuxt SSR servers forwarding the user's cookie to the Nest API?_*
  - Option: Reject with 403 MISSING_OR_NULL_ORIGIN, matching better-auth's validateOrigin on its own routes (strict)
  - Option: Allow when there are no browser signals at all (no Origin, Referer or Sec-Fetch-*); reject when an Origin or Referer is present and untrusted, or when Sec-Fetch-Site is cross-site or same-site with an untrusted origin
  - Recommendation: Make the second option the default and offer a `strict: true` switch. Modern browsers always send Origin (and Sec-Fetch-Site) on cross-site unsafe requests, so browser CSRF is still blocked, while SSR backends that forward cookies keep working.

- **Should organization requirements keep the silent `activeOrganization()` default, or require an explicit `organization` ref?**
  - Option: Keep the default (mirrors better-auth's hasPermission) and add a boot warning when the route path declares an org-like param (:orgId, :organizationId, :organization) while the requirement uses the default ref
  - Option: Make `organization` a required option of orgPermission()/orgMember(), so every call site states which org is checked
  - Recommendation: Take the first option. The default is ergonomic and faithful to better-auth, but a handler acting on `:orgId` while authorizing against the session's active org is an IDOR, and the planner can detect that pattern cheaply at boot.

- **Should privileged policies such as admin permission() force an authoritative identity read (SEC-r1-04)? That costs one DB read per request on such routes when the cookie cache is on.**
  - Option: Authoritative by default, mirroring better-auth's adminMiddleware (revocations and bans take effect immediately), with a per-requirement opt-out such as `permission(p, { identity: 'cached' })`
  - Option: Keep cookie-cache identity (0 reads on a cache hit) and document that bans and revocations take up to cookieCache.maxAge to apply
  - Recommendation: Take the first option. It restores the parity §8.4 claims, and the extra read applies only to admin-privileged routes.
