# Round 2 review: SEC (security / SRE)

Input: `design-v2.md`. Verdict: **reject**.

Experiments: `scratchpad/tmp-r2-review-SEC/`. They use better-auth 1.7.4, @better-auth/api-key 1.7.4, socket.io 4 and graphql-ws 6.2.2. Tarballs of @nestjs/graphql 13.2.4 and 14.0.0, @nestjs/apollo 13.2.4 and mercurius 16.10.0 were read under `gql/`. Probe outputs are saved as `*.out` next to each script.

## Summary

v2 fixes most of what round 1 found:

- per-route principal acceptance and delegation;
- credential-matched cookie forwarding;
- authoritative admin identity;
- the API-key result table;
- proxy-trust reporting;
- B23 and B24;
- redacted causes;
- fail-closed coverage checks;
- generic GraphQL internal errors.

18 of the 19 round-1 SEC findings are resolved; SEC-r1-01 is not.

The CSRF defense that SEC-r1-01 asked for is still bypassable, and that is a blocker. §7.10 skips the origin check whenever the request _carries_ something that looks like an explicit credential: an `authorization` Bearer or DPoP header, or any source's `credentialHeaders`. It does not ask whether that credential authenticated the request. On socket.io and graphql-ws those headers are built from in-band data the attacking page chooses (`handshake.auth.token`, `connectionParams`), and no CORS preflight governs that data. So a cross-site page sends `auth: { token: 'junk.x' }`, the check is skipped, better-auth's `bearer()` ignores the bad token, and the victim's cookie authenticates the socket. A probe shows each step. better-auth's own router validates whenever _any_ cookie is present, so the design is looser than the rule it claims to mirror. Its own differential test (§14.5) would catch the mismatch.

Three majors:

1. **API-key outage probe.** The probe is a read. `verifyApiKey` writes on every call, so a read-only or write-failing store (failover, disk full, lock timeouts) still answers 401 `INVALID_API_KEY` for every valid key. S6 is violated again in a partial-outage form (probe).
2. **GraphQL over graphql-ws.** Queries and mutations sent over the graphql-ws socket are classified by operation kind. Nest's graphql-ws server executes them (source), so queries on a hijackable socket are never origin-checked, and the principal memo can become connection-lifetime.
3. **Service calls on public routes.** `BetterAuthService.getPrincipal()`/`getSession()`, documented for `@Public()` handlers, returns a cookie-authenticated identity with no origin check.

Five minors:

- WebSocket browser-leg URLs are relative;
- `fromParam()` passes non-strings, which turns attacker input into logged 500s (probe);
- WebSocket and subscription TTLs silently cancel `freshIdentity`;
- `@ForwardAuthCookies()` login proxies have no CSRF primitive;
- field resolvers that rely on `defaultAccess` are unguarded, and nothing warns.

## Prior findings (round 1, SEC)

| Id        | Status         | Note                                                                                                                                                                                                                                                                                                   |
| --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-r1-01 | **unresolved** | HTTP unsafe methods and GraphQL-over-HTTP mutations are covered. For WebSockets and subscriptions, the original attacker controls the page and defeats the fix by adding one in-band field (`auth.token` / `connectionParams.authorization`). See SEC-r2-01; SEC-r2-03 covers queries over graphql-ws. |
| SEC-r1-02 | resolved       | Sources declare `kinds`/`acceptance`, routes filter the chain, the evaluator's delegation gate is data-driven, and Z5 holds. I found no widening path through `anyOf`, class/method acceptance or `planFor`. RK24 (`enableSessionForAPIKeys`) is better-auth's semantics and is warned.                |
| SEC-r1-03 | resolved       | The triple (session-token cookie, `authorization`, declared headers) stops the service-account and foreign sign-up cases; forwarding is off by default.                                                                                                                                                |
| SEC-r1-04 | resolved       | `requires.freshIdentity` plus the authoritative default restores `adminMiddleware` parity on HTTP. SEC-r2-07 covers the TTL paths on WebSockets and subscriptions.                                                                                                                                     |
| SEC-r1-05 | resolved       | The original scenario (`findOne` throwing ECONNREFUSED) now gives 5xx, and RATE_LIMITED gives 429 with Retry-After. A partial outage still gives 401; see SEC-r2-02.                                                                                                                                   |
| SEC-r1-06 | resolved       | `proxyTrust()`, B27 and `W_PROXY_UNTRUSTED`.                                                                                                                                                                                                                                                           |
| SEC-r1-07 | resolved       | B23 `UNSAFE_BASE_URL` with an explicit escape hatch.                                                                                                                                                                                                                                                   |
| SEC-r1-08 | resolved       | The cause is rebuilt from an allow-list and keeps the first line only (LEAD-EXP-6); the residual is honestly rated as RK23.                                                                                                                                                                            |
| SEC-r1-09 | resolved       | `hybridCoverage: 'error'`; the assertion risk is RK22.                                                                                                                                                                                                                                                 |
| SEC-r1-10 | resolved       | `FIELD_RESOLVER_UNGUARDED` for field resolvers that carry requirements. SEC-r2-09 covers the adjacent default-access gap.                                                                                                                                                                              |
| SEC-r1-11 | resolved       | B24 compares `authCookies` names and scope.                                                                                                                                                                                                                                                            |
| SEC-r1-12 | resolved       | The probe is removed; every gateway needs `@UseBetterAuth()`/`@Public()`.                                                                                                                                                                                                                              |
| SEC-r1-13 | resolved       | Connection entries hold only `authenticated`/`absent`, and an infrastructure failure evicts them.                                                                                                                                                                                                      |
| SEC-r1-14 | resolved       | `effects` and `W_QUOTA_PER_MESSAGE`; the wording is corrected.                                                                                                                                                                                                                                         |
| SEC-r1-15 | resolved       | `initTestApp` closes the previous app, and never-bootstrapped bindings are taken over.                                                                                                                                                                                                                 |
| SEC-r1-16 | resolved       | 404 diagnostics are capped and never change the response.                                                                                                                                                                                                                                              |
| SEC-r1-17 | resolved       | Exact origins by default; the lead's change to keep exact `http:` origins for development is accepted.                                                                                                                                                                                                 |
| SEC-r1-18 | resolved       | Random header per plugin instance; core strips `x-nsba-ip-*`.                                                                                                                                                                                                                                          |
| SEC-r1-19 | resolved       | `atRequest` errors are generic as thrown, and GraphQL uses `toInternalException` (LEAD-EXP-7).                                                                                                                                                                                                         |

## Findings

### SEC-r2-01 (blocker): The origin check is skipped when an "explicit" credential header is present, even if that credential did not authenticate. In-band WebSocket/graphql-ws data lets a cross-site page skip it while the victim's cookie authenticates

- **Section:** §7.10 "When it applies" step 3; §2.2.1 `OriginCheckOptions.explicitCredentialHeaders`; §2.2.12 `connectionParamHeaders`; §2.2.13 `WsTransportOptions.credentials`; §9.2 and §9.3 (credential mapping); §3.4 walkthrough C step 2; §4.2.2 T8; §14.1 `T-ws-origin-untrusted`/`T-subscription-origin`; §14.5 differential origin test; ADR-34.
- **Failure scenario:** The app uses better-auth's documented cross-domain cookies (`sameSite: 'none'`), or the attacker controls a sibling subdomain. It runs a `@UseBetterAuth()` gateway on the default `socketIoTransport()`.
  1. The attacker page runs `io('wss://api.example.com', { transports: ['websocket'], auth: { token: 'junk.x' } })`.
  2. The browser attaches the victim's session cookie to the upgrade. `handshake.auth` is part of the socket.io CONNECT packet, so CORS does not govern it.
  3. The transport's default mapping (§9.3) copies `handshake.auth.token` into `authorization: Bearer junk.x`. The handshake cookie survives, so `call.headers()` holds both.
  4. §7.10 step 3 sees a Bearer `authorization`, calls the credential explicit and skips the check.
  5. The session source calls `getSession` with both headers. `bearer()` fails the HMAC on the dotted token and returns without touching the cookie; without the plugin the header is ignored anyway. The victim's cookie authenticates.
  6. Every message on the hijacked socket passes the guard, and the page reads the replies. `WsConnectionAuth` uses the same rule (`checkOrigin(browser, { explicitCredential })`), so connect-time authentication is bypassed too.

  Identical variants:
  - graphql-ws with `connectionParams: { authorization: 'Bearer junk.x' }`, copied by the default `connectionParamHeaders`;
  - Mercurius `_connectionInit`;
  - a ws `credentials()` that reads a `?token=` query parameter, a common pattern because browsers cannot set WebSocket headers;
  - any mapping that places attacker-chosen data in `x-api-key`. On a route that does not accept `'api-key'`, that source is never consulted (§4.3.3), yet its header still counts as explicit.

  On HTTP the exemption shrinks the check to the host's CORS policy. Migration step 4 recommends a separate CORS allow-list for app routes. With the `cors` package's default `allowedHeaders`, which reflects the requested headers, any origin on that list can add `Authorization: Bearer junk.x` to a credentialed unsafe request and pass. Without the header, the origin check would reject that origin, because better-auth does not trust it.

  Walkthrough §3.4 C step 2 even defines `ambientCookie` as false whenever `credentials(client)` supplied a credential, which bypasses the check by construction.

- **Evidence:**
  - `probe-origin-bearer-exempt.mjs` (NODE_ENV=production; output in `.out`):
    - `[with bearer()] getSession(cookie + authorization="Bearer junk.notasignature") -> session for victim@x.io`;
    - `[without bearer()] getSession(cookie + authorization="Bearer x") -> session for victim@x.io`;
    - the socket.io server received `origin = https://evil.example | has cookie = true | auth = {"token":"junk.notasignature"}`;
    - applying §9.3's default mapping and §7.10 step 3 gave `explicit credential present -> true => origin check SKIPPED` and `guard getSession on that socket -> session for victim@x.io`;
    - the router, given the same cookie, junk bearer and evil Origin on `POST /update-user`, answered `403 {"code":"INVALID_ORIGIN"}`.
  - `BA/plugins/bearer/index.ts:75-100`: a dotted token that fails `createHMAC(...).verify` returns `undefined`, so the request cookie stays.
  - `BA/api/middlewares/origin-check.ts:229-251`: `const useCookies = headers.has("cookie")`, and validation runs whenever a cookie is present, regardless of `authorization`. The design's rule is looser than the rule §0.2, §7.10 ("mirrors `validateOrigin`") and ADR-34 claim to mirror.
  - ADR-34 says the library "knows which credential authenticated the call". It does not: `getSession` receives every header, and the kernel infers from header presence.
  - §14.5's differential test lists "explicit credential headers" among its cases and requires the router's and the kernel's verdicts to agree. For cookie + bearer + untrusted Origin they disagree (403 vs allow), so the design contradicts its own test.
  - The conformance cases only cover a token _instead of_ the cookie (`T-csrf-http-unsafe`: "the same request with a bearer token or `x-api-key` instead of the cookie"; `T-ws-origin-untrusted`: "a token-authenticated socket"). No case covers a token _added to_ the cookie.
- **Suggested fix:**
  1. Adopt better-auth's rule: enforce whenever the browser leg carried any `cookie` header, whatever other credentials are present (subject to `enforce`, better-auth's skip flags and `@SkipOriginCheck()`). This costs browsers almost nothing: a cross-origin client that sends cookies needs credentialed CORS anyway, so its origin is already on an allow-list and can be added to `trustedOrigins`.
  2. If an HTTP exemption is kept (see the proposed user decision), make it sound:
     - only real request headers of the browser leg may qualify, never values a transport copied from `handshake.auth`, `connectionParams`, `_connectionInit`, payloads or query strings;
     - when the exemption applies, the resolver removes the instance's better-auth cookies (`$context.authCookies.*.name`) from the headers it gives every source, so an invalid explicit credential ends as `rejected`/`absent` and never as cookie-authenticated.
  3. Replace `explicitCredential` in `AuthHandle.checkOrigin` and fix §3.4 C, §9.2, §9.3, T8 and ADR-34 to one definition.
  4. Add conformance cases:
     - `T-ws-origin-junk-token`: socket.io `auth.token: 'a.b'` plus cookie plus untrusted Origin gives a denial on every message and in `WsConnectionAuth`;
     - `T-subscription-origin-junk-connection-params`;
     - `T-csrf-http-cookie-plus-token`: cookie plus junk `Authorization` plus an untrusted Origin that CORS allows gives 403;
     - a matching row in the §14.5 differential table.

### SEC-r2-02 (major): The API-key outage probe is a read, but `verifyApiKey` writes on every call. A store that reads but cannot write (read-only failover, disk full, lock or statement timeouts, a revoked UPDATE grant) still answers 401 `INVALID_API_KEY` for every valid key

- **Section:** §8.3.1 (result table, "Outage probe"), §7.7 RK18, §13.1, `S-apikey-outage`, ADR-42.
- **Failure scenario:** Postgres fails over and, for 30–120 s, the endpoint is a read-only replica: Aurora or RDS failover, or `default_transaction_read_only` during maintenance. A MySQL `innodb_lock_wait_timeout` storm under load, or a full disk, looks the same.
  1. A machine client sends a valid `x-api-key` to a route that accepts keys.
  2. `validateApiKey` reads the key and then runs `claimUsageInDatabase`, which always performs guarded `incrementOne` writes and a final `update({ updatedAt })`.
  3. The write throws a non-`APIError`, and `verifyApiKey`'s catch returns `{ valid: false, error: { code: 'INVALID_API_KEY' } }`.
  4. The design's probe runs `adapter.findOne({ model: 'apikey', where: [{ field: 'id', value: <random> }] })`. It succeeds on the read-only store, so the source answers **401 INVALID_API_KEY**.

  Every API-key client is told its key is invalid for the whole incident: integrations rotate or disable keys, and monitoring sees 4xx, not 5xx. This is SEC-r1-05's failure again, in the partial-outage form that failovers actually produce. better-auth also logs `Failed to validate API key:` at ERROR once per request (RK19).

- **Evidence:**
  - `probe-apikey-readonly-db.mjs` wraps the memory adapter so that writes throw `cannot execute UPDATE in a read-only transaction`. Output:
    - `healthy storage -> valid = true`;
    - `read-only storage -> valid = false | error.code = INVALID_API_KEY`;
    - `design outage probe -> read succeeded -> storage "reachable" -> 401 INVALID_API_KEY`;
    - `unknown key (same mode)-> … INVALID_API_KEY (indistinguishable)`.
  - `AK/routes/verify-api-key.ts:169-221` (`claimUsageInDatabase`: `consumeRemaining`/`consumeRateLimit` `incrementOne`, then `adapter.update({ updatedAt })`) runs on every verification regardless of `deferUpdates`. The catch at `:573-595` maps any non-`APIError` to `INVALID_API_KEY`.
- **Suggested fix:**
  - Make the probe exercise the path that failed. After the read, run a no-op write that cannot change data: `adapter.update({ model: 'apikey', where: [{ field: 'id', value: <random id> }], update: { updatedAt: new Date() } })`. It matches no row, and read-only or permission failures still throw. Treat a throw from either step as infrastructure.
  - Where the source can compute the stored form (default hashing, or an `apiKeyPrincipal({ keyHasher })` option), add an existence check: `INVALID_API_KEY` for a key whose hashed form exists, is enabled and has not expired cannot be a validation outcome, so answer 5xx.
  - Throttle both checks as the probe is throttled today. Add `S-apikey-write-outage` (writes throw, reads succeed → 5xx), extend RK18 to name the write path, and include it in the upstream proposal.

### SEC-r2-03 (major): GraphQL operations executed over the graphql-ws connection are classified by operation kind. Queries on a hijackable socket are never origin-checked, and their principal memo can live as long as the connection

- **Section:** §9.0 (Apollo and Mercurius rows), §9.2 ("The operation kind comes from `gql.getInfo().operation.operation`"; "Queries and mutations share the HTTP request's principal"; browser leg: "queries and mutations use the HTTP request, with `enforce` for mutations only"), §7.2 memo table, §7.10 step 2 ("queries are read-only and a cross-site page cannot read their response"), T8, `T-subscription-origin`.
- **Failure scenario:** The app uses Apollo with `subscriptions: { 'graphql-ws': true }`, the only protocol §9.2 supports, and the common context factory `context: ({ req, extra }) => ({ req: req ?? extra?.request })`, which exposes headers to subscription code.
  1. A cross-site page opens `new WebSocket('wss://api.example.com/graphql', 'graphql-transport-ws')`, which carries the victim's cookie.
  2. It sends `connection_init`, then `{ type: 'subscribe', payload: { query: '{ me { email invoices { total } } }' } }`, a **query**.
  3. graphql-ws executes non-subscription operations over the socket with `execute`, and Nest passes `execute` to `useServer`.
  4. The transport sees `operation === 'query'` and takes the query/mutation branch. The key is `kit.http.key(gql.getContext().req)`, which is the upgrade `IncomingMessage`. The credentials are its headers (the victim's cookie). The browser leg is "the HTTP request" with `enforce: false` for a query.
  5. The query resolves as the victim, and the page reads the result over the socket. §7.10 skips queries because CORS stops cross-site reads, but CORS does not apply here.

  Two further effects:
  - **Stale authorization.** The key is the upgrade request, which lives as long as the connection, so the principal promise, a memoized rejection included, is reused for the connection's lifetime with no TTL. A revoked session keeps answering queries on that socket.
  - **Refresh drift.** The cookie sink falls back to `req.res`/`responseFor`, which do not exist here, so refresh suppression depends on an accident.

  With Nest's default context (`req` = the graphql-ws context object, which has no `headers`), the same operations resolve as absent. Queries that require authentication then fail over WebSocket (401), and the principal is still memoized on a connection-lifetime object. The same holds for Mercurius with `subscription: { fullWsTransport: true }`.

- **Evidence:**
  - graphql-ws 6.2.2 `dist/server-DHPI7HHW.js:210-215`: `if (operationAST.operation === "subscription") … subscribe(execArgs) else … execute(execArgs)`.
  - @nestjs/graphql 13.2.4 `dist/services/gql-subscription.service.js:31-36` and 14.0.0 `:17-26`: `useServer({ schema, execute, subscribe, context: this.options.context, … })`.
  - @nestjs/apollo 13.2.4 `apollo-base.driver.js:196-228`: the user's `ctx.req` is kept when it is an object; otherwise `req` becomes the graphql-ws context.
  - mercurius 16.10.0 `lib/subscription-connection.js:247-266`: queries and mutations run over WebSocket when `fullWsTransport === true`.
- **Suggested fix:**
  - Make the discriminator the carrier, not the operation kind. Any operation whose context comes from a WebSocket connection gets the subscription treatment: graphql-ws context (`connectionParams`/`extra`), a context carrying `extra.request` or a raw upgrade `IncomingMessage` as `req`, or a Mercurius `_connectionInit`. That means credentials from the upgrade request and allow-listed `connectionParams`, `cookies: null`, `enforce: true`, and a per-operation key with `connection` used only under a TTL.
  - Specify how the transport recognizes the WebSocket carrier under the default and the common custom context shapes.
  - Extend `T-subscription-origin` and `T-memo-once` with a query and a mutation sent over the graphql-ws socket and over Mercurius `fullWsTransport`, under both context shapes. Add RK3's "UNVERIFIED" note to this path until they pass.

### SEC-r2-04 (major): `BetterAuthService.getPrincipal()`/`getSession()` in `@Public()` handlers, which the design documents, returns a cookie-authenticated identity without the origin check

- **Section:** §7.6 ("`BetterAuthService.getSession()` remains available to public handlers that explicitly ask for it"), §7.8 "Services", §7.5 (the scope interceptor opens a scope for every handler a transport handles), §7.10 ("Where it runs": only in the guard), B15.
- **Failure scenario:** `@Public() @Post('cart/checkout')` or `@Public() @Post('newsletter/subscribe')` calls `this.auth.getSession()` to act for the signed-in user when there is one. That is the documented escape hatch; B15 blocks only principal param decorators on public handlers.
  1. A cross-site form auto-posts to the route with the victim's `sameSite: 'none'` cookie.
  2. The guard returns early for `public` (§7.1) and never reaches the origin check.
  3. The scope interceptor still opens the handler scope, and `getSession()` resolves the victim's session from the cookie "lazily through the same memo".
  4. The handler performs the unsafe operation as the victim.

  The same applies to a `@Public()` gateway on Nest 12, where the global interceptor opens a scope: a hijacked socket gets the victim's principal through the service. This reopens SEC-r1-01's cross-site form-post class on a documented API path.

- **Evidence:** §7.1: `if plan.access === 'public': stamp(...); return true` happens before `plan.originCheck && call.browser?.enforce`. §7.5 step 2: the interceptor opens `RequestScope.run(...)` whenever `scopes.forExecution(ctx)` finds a transport, with no access condition. §7.8: "Inside a scope these resolve lazily through the same memo". Nothing in §7.8, §2.2.2 or §7.10 applies `checkOrigin` to service-initiated resolution.
- **Suggested fix:** Resolution that starts outside the guard (service `getPrincipal()`/`getSession()`, or any lazy path) applies the same `OriginCheck` when `call.browser?.enforce` and the plan's origin check is on. On failure it returns `null` (anonymous) and logs at debug, because the handler asked optionally. Add `T-public-service-origin`: a public unsafe handler calling `getSession()` with a cookie and an untrusted Origin gets `null`. The alternative, `null` on every `@Public()` route, is listed below as a user decision.

### SEC-r2-05 (minor): WebSocket browser legs have relative URLs, so the origin check throws or misjudges wherever it needs the URL

- **Section:** §4.2.1 `BrowserExposure.url` ("Absolute URL"), §7.10 rule steps 1 and 3, §9.3 (socket.io `handshake.url`; ws `recordUpgradeRequest` `url`), §9.2 (graphql-ws `extra.request`), §2.2.13.
- **Failure scenario:** The URL is needed in three cases:
  - function-valued `trustedOrigins` (a documented better-auth feature);
  - a dynamic `baseURL: { allowedHosts }` in production, which B23 allows and where `ctx.baseURL === ''`, so "∪ the browser leg's own origin" applies;
  - `Origin: null` with `Sec-Fetch-Site: same-origin`.

  In each case the kernel builds `new Request(browser.url, …)` or an origin from `browser.url`. For socket.io that URL is `/socket.io/?EIO=4&transport=websocket`, and for ws and graphql-ws it is `req.url`, also a bare path. `new Request` throws `TypeError: Failed to parse URL`. The error is neither a library error nor an `APIError`, so every cookie-authenticated message answers "Internal server error", and `BaseWsExceptionFilter` logs it at ERROR once per message. Any client can trigger that log line. If the implementation instead skips the missing origin, same-origin deployments with a dynamic `baseURL` are denied on every message. Function-valued `trustedOrigins` are also evaluated per message, which can mean a database lookup per message, although the handshake Origin cannot change during a connection.

- **Evidence:**
  - `probe-origin-bearer-exempt.mjs` prints `url = /socket.io/?EIO=4&transport=websocket`.
  - `node -e "new Request('/socket.io/?EIO=4&transport=websocket')"` throws `TypeError Failed to parse URL … ERR_INVALID_URL`.
  - §9.3 names `handshake.url` and the recorded upgrade `url` as the leg's URL.
- **Suggested fix:**
  - WebSocket transports build an absolute URL from the handshake: scheme from `socket.encrypted` or the app's platform `proxyTrust()`, host from `Host`, plus the path.
  - Pin the result with `T-ws-origin-dynamic-baseurl` and `T-ws-origin-function-trusted-origins`.
  - Evaluate the handshake verdict once per connection and cache it on the connection (the Origin is immutable). A throw is an infrastructure error with a generic message.

### SEC-r2-06 (minor): `fromParam()` passes attacker-typed payload values to the org endpoints, which turns client input into configuration-error 500s logged at ERROR; the default ref's memo key collides with the literal `"active"`

- **Section:** §8.3 (organization refs; `fromParam` reads "WS/RPC payload field"; memo keys `org:hasPermission:<org or 'active'>:<permissions>`), §2.2.15 `OrganizationRef` (typed `string | null | undefined`, while `call.param` returns `unknown`), §13.2 (`BETTER_AUTH_REJECTED_CALL`).
- **Failure scenario:**
  - An authenticated socket.io client sends `{ orgId: { "$ne": null } }`, `123` or `["a"]` to a `@RequireOrgPermission(p, { organization: fromParam('orgId') })` message handler.
  - The policy calls `hasPermission({ body: { organizationId: <object> } })`. better-auth's body schema rejects it with 400 `VALIDATION_ERROR`, and `normalizeThrown` maps "another 4xx" to `BetterAuthConfigurationError` `BETTER_AUTH_REJECTED_CALL`.
  - Every such message becomes a 500 plus an ERROR log line: attacker-controlled log volume and 5xx alert noise, while the design says such 4xx "means our own call was malformed". RPC payloads and JSON-scalar GraphQL args behave the same way.
  - An empty string `""` passes the ref as "determined", and better-auth then silently checks the **active** organization instead (`organizationId || activeOrganizationId`).
  - A literal `orgId: "active"` produces the same I/O memo key as `activeOrganization()` in the same logical request.
- **Evidence:** `probe-org-param-type.mjs`:
  - `{"$ne":null} -> throws APIError 400 VALIDATION_ERROR`;
  - `123 -> … 400 VALIDATION_ERROR`;
  - `["a"] -> … 400 VALIDATION_ERROR`;
  - `"" -> throws APIError 400 NO_ACTIVE_ORGANIZATION` (with an active organization set it would check that one).

  Source: `BA/plugins/organization/organization.ts:167-170` (`organizationId: z.string().optional()`) and `:258-266` (`ctx.body.organizationId || …activeOrganizationId`).

- **Suggested fix:**
  - `fromParam`/`fromHeader` return a non-empty string or `undefined`; anything else is 403 `ORGANIZATION_REQUIRED`, logged at debug.
  - The evaluator validates every `OrganizationRef` result the same way, for custom refs too.
  - Build memo keys from a tuple or a symbol for the default ref, e.g. `JSON.stringify(['org:hasPermission', orgId ?? null, perms])`, never a sentinel string.
  - Add `Z-org-ref-types`.

### SEC-r2-07 (minor): WebSocket and subscription principal TTLs cancel `freshIdentity`: a banned or demoted admin keeps passing `@RequirePermission` on a socket for the whole TTL

- **Section:** §7.2 (connection entries keyed `(call.connection, …)` with `principalTtlMs > 0`), §8.4, §8.3 admin row (`role: session.user.role` from the resolved session), §9.3 (`WsConnectionAuth` caches for `principalTtlMs`), §2.2.12 `subscriptionPrincipalTtlMs`.
- **Failure scenario:** A chat or admin gateway sets `principalTtlMs: 300_000`, the documented setting for chat traffic, and a message handler carries `@RequirePermission({ user: ['ban'] })`.
  1. Admin A is banned, so all sessions are deleted, or A is demoted with `setRole`.
  2. For up to 5 minutes, every message on A's socket reuses the cached authoritative principal and its `session.user.role`.
  3. `userHasPermission` receives the stale role and allows.

  §8.4 promises "a banned admin is locked out on the next request", and `Z-admin-banned` tests that only over HTTP. The TTL docs describe revocation lag generally, but nothing tells the author that admin-grade requirements are affected, and the boot advice is silent.

- **Evidence:** §7.2: the principal memo key includes freshness, and "`(call.connection, …)` instead when `principalTtlMs > 0`"; connection entries store settled `authenticated` results with `expiresAt`. §8.3: the authoritative admin check passes `role: session.user.role` "from that session" (0 extra reads).
- **Suggested fix:**
  - Plans whose freshness is `'authoritative'` bypass connection entries: resolve per message, or per subscription start.
  - Alternatively, the WebSocket and GraphQL units' `advise()` emits `W_TTL_FRESH_IDENTITY`, naming the handlers.
  - Add a WebSocket variant of `Z-admin-banned` with a TTL.

### SEC-r2-08 (minor): The only handlers that deliberately forward credential cookies, `@ForwardAuthCookies()` login and sign-up proxies, cannot get CSRF protection, because the origin check needs an authenticated principal

- **Section:** §7.5 ("Direct credential endpoints bypass better-auth's router protections … should apply the app's own throttling"), §7.10 "When it applies" step 1 (not public, a principal authenticated), RK14.
- **Failure scenario:** `@Public() @ForwardAuthCookies() @Post('login')` proxies `auth.api.signInEmail({ body, headers })` for a custom login form.
  1. A cross-site page auto-submits the attacker's own credentials to that route (login CSRF).
  2. There is no principal, so §7.10 does not apply.
  3. The call carries no credential, so the bridge forwards its `Set-Cookie` (§10.2 `sameCredential`: `NO_CREDENTIAL`).
  4. The victim's browser is now signed in to the attacker's account, and anything the victim saves or uploads lands there.

  better-auth blocks this on its own `/sign-in/*` routes. Its `formCsrfMiddleware` rejects a cross-site navigation (`Sec-Fetch-Site: cross-site` with `Sec-Fetch-Mode: navigate`), and it validates the origin whenever cookies are present. The design names the bypass but offers no way to close it besides writing custom middleware.

- **Evidence:** `BA/api/middlewares/origin-check.ts:303-360` (`formCsrfMiddleware`/`validateFormCsrf`); §7.10 step 1; §10.2 `sameCredential` returns true for `NO_CREDENTIAL`.
- **Suggested fix:** Add `@RequireTrustedOrigin()`, or make `@ForwardAuthCookies()` imply it on unsafe methods. It runs the §7.10 rule with better-auth's `forceValidate` semantics and the fetch-metadata login check, whether or not a principal authenticated. Update RK14 and the docs, and add `T-csrf-login-proxy`.

### SEC-r2-09 (minor): GraphQL field resolvers that rely on `defaultAccess: 'authenticated'` go unguarded without `fieldResolverEnhancers`, and B16 does not flag them

- **Section:** §9.2 "Field-resolver coverage" (the check covers only methods with requirements or their own access/acceptance decorator), §0.2 P8 ("secure by default"), B22 (handler counts by access).
- **Failure scenario:** The schema has a public root field, `@Public() @Query(() => [Post]) posts()`. `@ResolveField(() => User) author(@Parent() p)` returns the author row with its email, and its class has no decorators. With `defaultAccess: 'authenticated'`, the default, the author believes undecorated handlers require authentication. `fieldResolverEnhancers` is unset, so no guard runs on `author`. Anonymous callers read every author's email through `posts { author { email } }`. B16 passes because the field resolver carries no requirement and no access decorator, and B22 probably counts it as a "required" handler, which reinforces the misunderstanding.
- **Evidence:** §9.2: "fails boot … for every method carrying `RESOLVER_PROPERTY_METADATA` that either has an effective plan with requirements … or has its own access or acceptance decorator other than `@Public()`". LEAD-V30: field resolvers get guards only with `'guards'` in `fieldResolverEnhancers`.
- **Suggested fix:**
  - When `fieldResolverEnhancers` lacks `'guards'`, the GraphQL units' `advise()` warns (`W_FIELD_RESOLVER_DEFAULT_ACCESS`) and lists the field resolvers whose effective access comes from `defaultAccess`. Upgrade to `'error'` when any root field of the schema is `@Public()` or `@OptionalAuth()`.
  - B22 counts such handlers as "unguarded", not "required".
  - The hint is `fieldResolverEnhancers: ['guards']` or an explicit `@Public()` on the field resolver.

## Proposed user decisions

- **Should the origin check keep any exemption for requests that carry an explicit credential (Bearer/DPoP `authorization`, `x-api-key`) alongside a cookie? (Fix of SEC-r2-01.)**
  - Option: No exemption, which is exact better-auth parity. Any cookie on an unsafe or WebSocket browser leg needs a trusted `Origin`, whatever other headers are present.
  - Option: Keep an exemption for real HTTP request headers only, never in-band WebSocket or subscription data. When it applies, strip the better-auth cookies from what the sources see, so only the explicit credential can authenticate and an invalid one never falls back to the cookie.
  - Recommendation: Take the first option. It is the rule better-auth applies on its own routes and the rule the §14.5 differential test already assumes. Browsers pay nothing, because a cross-origin client that sends cookies already needs credentialed CORS, so its origin is known and belongs in `trustedOrigins`. The second option is defensible for APIs whose bearer clients also hold API-domain cookies, but it adds a second code path and changes better-auth's credential precedence.

- **What should `BetterAuthService.getPrincipal()`/`getSession()` return on `@Public()` routes? (Fix of SEC-r2-04.)**
  - Option: Resolve lazily as today, but apply the origin check on enforced operations and return `null` when it fails, which keeps the lazy, pay-only-when-asked behavior.
  - Option: Always return `null` on `@Public()` routes, so public means no identity; handlers that want one use `@OptionalAuth()`. This matches B15's stance for param decorators and §7.6's "zero auth I/O".
  - Recommendation: Take the first option. The escape hatch has a real use: a public handler that looks up the session only on some code paths avoids a `getSession` on every request, which `@OptionalAuth()` would cost. The origin check makes it safe. Choose the second if a smaller surface matters more than that saving.
