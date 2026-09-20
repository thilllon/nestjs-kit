# Round 1 review: BA (better-auth fidelity)

Input: `design-v1.md`. Verdict: **reject**.

## Summary

Reviewed design v1 through a better-auth-fidelity lens and checked its claims against the better-auth 1.7.4 / better-call 1.4.0 source. I also ran experiments in tmp-review-BA-r1/: a tsc probe for the plugin's type widening, and a runtime probe of API-key quota and verifyApiKey results. Most of the load-bearing mechanisms hold:

- The before-hook refresh-suppression flag lands in the dispatch's own request state (to-auth-endpoints.ts:108-112).
- `_flag === 'router'` is set by the better-call router.
- `init().options` is merged with `defu(user, plugin)`, and `context.options` is replaced, so the rate limiter and getIP see the client-IP header.
- The dispatch.ts before/after-hook semantics match LEAD-V1.
- customSession preserves every Set-Cookie.
- The org and admin endpoint error codes are as described.
- Typing nestjs() as `BetterAuthPlugin & {id}` does NOT widen `$Infer.Session`, the `auth.api` keys, permission typing or EndpointPath (tsc experiment).

The design still fails on authorization and cookie/CSRF semantics where it goes beyond better-auth's own model:

- **Blocker:** the admin `permission()` policy grants any principal kind with a `userId` the owner's full admin role. That includes API keys from the design's own apiKeyPrincipal() and OAuth/MCP tokens, which is a scope bypass.
- **Major:**
  - The mandatory plugin's cookie bridge changes server-call semantics for every direct `auth.api` call, and there is no global opt-out.
  - WebSocket and subscription handshakes that carry cookies are authenticated without better-auth's origin check.
  - apiKeyPrincipal misreads verifyApiKey. It never throws, so rate-limited keys come out as 401 instead of 429, and org-owned keys get an org id as their userId.
  - Org policies re-send the caller's credential headers. With enableSessionForAPIKeys, each policy call spends the key's quota again (the probe counted 1, then 2, then 3).
- **Minor:** several places where the dispatcher and types diverge from better-auth (DB update hooks, matcher exceptions, unvalidated hook body types, onAPIError.throw), plus two inaccurate claims (what before-hooks can see; which origins the CORS helper covers).

Note: the disk ran full for a while during the review (ENOSPC). The checkpoint notes survived in tmp-review-BA-r1/findings-draft.txt.

## Findings

### BA-r1-01 (blocker): Admin permission() accepts every principal kind with a userId, so API keys and OAuth/MCP tokens inherit the owner's full admin role

- **Section:** §8.3 (admin permission row), §2.2.15 adminPermissionPolicy, §4.3.4, §8.1
- **Failure scenario:** An admin creates an API key for CI with key permissions { project: ['read'] }. The app uses apiKeyPrincipal() (which the design recommends in B21 and §8.3) and protects POST /admin/users/:id/ban with @RequirePermission({ user: ['ban'] }). The key leaks. The attacker sends the ban request with x-api-key:

1. apiKeyPrincipal authenticates it as kind 'api-key' with userId = the admin.
2. The admin policy accepts 'any kind with userId' and calls userHasPermission({ body: { userId: adminId, permissions } }).
3. better-auth returns success: true, because of the admin role or because the user is in adminUserIds.
4. The attacker bans users. The key's own scopes are never consulted.

The same happens with the design's §4.3.4 oauth-access-token principal (userId = claims.sub). A third-party OAuth/MCP client granted only 'openid profile' by an admin user can reach every @RequirePermission route. In better-auth's own model such a token never yields a session (getSession returns null), so admin endpoints are unreachable with it. Because PrincipalKinds is open by design (OCP), every future principal kind silently inherits full admin rights.

- **Evidence:** design-v1.md line 2206 ("Principal: any kind with userId (else 403 USER_REQUIRED)"); line 659 (adminPermissionPolicy: AuthorizationPolicy<AdminPermissionParams, AuthPrincipal>); lines 1358-1359 (OAuth principal userId = claims.sub); line 2169 (kind filtering happens only if policy.requires.principals is set). better-auth plugins/admin/routes.ts:1858-1894: without headers it looks up body.userId and evaluates that user's role. plugins/admin/has-permission.ts:15-17: any userId in adminUserIds is granted every permission. api-key verify-api-key.ts:116-131: key permissions are a separate scope, checked via role(keyPermissions).authorize.
- **Suggested fix:** Default adminPermissionPolicy.requires.principals to ['session'], so every other kind gets 403 PRINCIPAL_NOT_SUPPORTED. Add an explicit opt-in, e.g. permission(p, { principals: ['session','api-key'] }). Allow a delegated kind only when BOTH checks pass:
- the delegated credential's own scope: role(apiKey.permissions).authorize(p) for keys, or a policy-supplied scope check for OAuth tokens;
- the owner's role.

State the rule as an invariant (Z5: 'built-in policies never widen a delegated principal beyond its own scope') and add a conformance case: an api-key principal with a narrower scope is denied on a RequirePermission route.

### BA-r1-02 (major): The mandatory plugin forwards Set-Cookie from every application-level direct auth.api call, with no global opt-out

- **Section:** §7.5, §10.2 (after-hook entry 4), §0.1, RK14, ADR-02/ADR-09
- **Failure scenario:** An admin-only controller creates accounts with `return this.auth.api.signUpEmail({ body: dto })`, a common pattern without the admin plugin. autoSignIn is on by default, so better-auth creates a session for the new user and emits its session_token Set-Cookie. BetterAuthScopeInterceptor is a global APP_INTERCEPTOR by default. The nestjs() after-hook (entry 4: matcher `_flag !== 'router' && scope.cookies && scope.bridge`) appends that cookie to the admin's HTTP response. The admin's browser now holds the new user's session, and the admin's next request acts as that user.

The same thing silently creates and rotates sessions when signInEmail is used server-side to re-check a password. The design's own §7.5 example advertises `await auth.api.signInEmail({ body })` in controllers. Such endpoints also bypass better-auth's rate limiter and origin/CSRF check, which run only in the router, so the bridge makes a cookie-setting sign-in endpoint with no rate limiting and no CSRF check the easy path.

In plain better-auth, server calls never touch the browser unless the user deliberately adds a cookie plugin (nextCookies) or uses returnHeaders/asResponse. Here the plugin is mandatory (B03), and the only escape is wrapping each call in runOutsideScope().

- **Evidence:** design-v1.md lines 2070-2084 (the interceptor opens scope with bridge: true; the bridge matcher/handler), 2468-2473 (plugin entry 4), 2094 (runOutsideScope is the only opt-out), 3578 (RK14 rated low/low), 217-221 (APP_INTERCEPTOR on by default). better-auth api/routes/sign-up.ts:431-441 (server-side signUpEmail creates a session and calls setSessionCookie). integrations/next-js.ts:95-139: nextCookies is the opt-in precedent and forwards all non-router cookies only because the user added it. api/index.ts:291 (originCheckMiddleware is router-only), :310 (onRequestRateLimit is router-only). middlewares/origin-check.ts:225-228 (validateOrigin returns early when ctx.request is absent, as on api calls).
- **Suggested fix:** Split the bridge from the mandatory plugin's other duties:
- Library-internal calls (policies, WsConnectionAuth) keep forwarding.
- Forwarding for application direct calls becomes configurable: a module/runtime option `cookies: { forwardDirectCalls: boolean }`, plus per-handler `@ForwardAuthCookies()` / `@NoAuthCookies()`. Default it to better-auth's server-call semantics (off); see userDecisions.

Also:

- Document that direct credential endpoints bypass rate limiting and origin checks, and recommend proxying those flows through auth.handler.
- Rate RK14 medium/high.
- Add a conformance case: a signUpEmail call for a third party from a guarded handler must not change the caller's cookies unless opted in.

### BA-r1-03 (major): WebSocket and GraphQL-subscription handshakes carrying cookies are authenticated without better-auth's origin check (cross-site WebSocket hijacking)

- **Section:** §9.3, §9.2 (subscriptions), §7.3, §0.2 P8
- **Failure scenario:** Take a deployment using better-auth's recommended cross-domain cookie settings: `advanced.defaultCookieAttributes: { sameSite: 'none', secure: true }`, or crossSubDomainCookies with a sibling subdomain the attacker controls.

1. A malicious page opens `new WebSocket('wss://api.example.com/socket.io/?EIO=4&transport=websocket')`.
2. The browser attaches the victim's session cookie. WebSocket upgrades are not subject to CORS.
3. socketIoTransport reads client.handshake.headers (cookie included) and resolves the session via getSession. No Origin validation happens.
4. Every @SubscribeMessage handler, and WsConnectionAuth.socketIoMiddleware({ required: true }), accepts the attacker's socket as the victim.

The ws transport (withUpgradeRequest headers) and graphql-ws subscriptions (upgrade request headers, plus connectionParams 'cookie') behave the same way. better-auth validates Origin against trustedOrigins whenever a cookie authenticates a request on its own routes. The design moves those sessions onto new cookie-authenticated channels but not the protection. The same gap applies to state-changing HTTP app routes (see userDecisions).

- **Evidence:** design-v1.md line 2310 (socket.io credentials from handshake.headers, which carry cookies), 2311 (ws upgrade headers), 2302 (graphql-ws: extra.request headers plus connectionParams 'cookie'), 2345-2354 (WsConnectionAuth); a grep for Origin/CSRF/isTrustedOrigin in the design finds no WS or app-route origin validation. better-auth middlewares/origin-check.ts:225-300: validation happens when cookies are present, and a missing or untrusted Origin gets 403. It is registered only as router middleware (api/index.ts:285-292), and validateOrigin returns early without ctx.request (origin-check.ts:225-228), so auth.api.getSession calls never get it.
- **Suggested fix:** In the socket.io, ws and graphql-ws credential extraction, validate the handshake Origin with `(await auth.$context).isTrustedOrigin(origin)` (see BA-r1-11 for the trusted-origin snapshot caveat) whenever the credential is the cookie header. Fail closed with the transport's 403 INVALID_ORIGIN when Origin is missing, null or untrusted. Respect `advanced.disableOriginCheck` / `disableCSRFCheck` for parity. Expose `originCheck: 'cookie' | 'always' | 'off'` (default 'cookie') on WsTransportOptions and GraphqlTransportOptions. Add conformance cases T-ws-origin-untrusted and T-subscription-origin, plus a security e2e case in §14.4.

### BA-r1-04 (major): apiKeyPrincipal assumes verifyApiKey signals failures as 401/429 errors and that referenceId is a user id; neither holds in 1.7.4

- **Section:** §8.3 (API keys note), §2.2.15 ./api-key, §7.7, §14.3 item 7
- **Failure scenario:** (1) A key with rateLimitMax 1 is used twice. verifyApiKey does not throw. It returns `{ valid: false, error: { code: 'RATE_LIMITED', message, details: { tryAgainIn: 86400000 } } }` (verified by probe). Following the design text ("An invalid key yields rejected(401 INVALID_API_KEY)"), the client gets 401. It then treats its key as revoked, rotates it or pages on-call, instead of getting 429 with Retry-After. The §7.7 path "APIError 429 during resolution → 429 RATE_LIMITED, Retry-After passed through" cannot happen for this source: there is no APIError, no status and no headers. USAGE_EXCEEDED (remaining = 0) is misreported the same way.

(2) With apiKey({ references: 'organization' }) (supported in 1.7), the returned key's referenceId is an organization id. The plugin object exposes no configurations, so the source cannot tell users from orgs. If it sets userId = referenceId:

- permission() calls userHasPermission({ userId: orgId }), gets 400 'user not found', and Z2 turns that into BetterAuthConfigurationError 500;
- custom policies that compare principal.userId treat an org id as a user id.
- **Evidence:** packages/api-key/src/routes/verify-api-key.ts:573-595 (catch → ctx.json({ valid: false, error: {...error.body} })); :293-296 and :463-466 (RATE_LIMITED with details.tryAgainIn); :162 and :271 (USAGE_EXCEEDED as TOO_MANY_REQUESTS). Probe tmp-review-BA-r1/probe-apikey-policy.mjs output: `verify #2 = {"valid":false,"error":{"message":"Rate limit exceeded.","code":"RATE_LIMITED","details":{"tryAgainIn":86400000}}}`; bad key → `{valid:false, error:{code:'INVALID_API_KEY'}}`. api-key/src/types.ts:262-299 (references 'user' | 'organization'; configId is to be used 'to determine the reference type'); api-key/src/index.ts:166-170 (the plugin object has no options/configurations field). design-v1.md lines 679-688, 2224, 2126, 3099-3103.
- **Suggested fix:** Specify the mapping from verifyApiKey results as a table and pin it with conformance cases:
- valid: true → authenticated;
- error.code RATE_LIMITED / USAGE_EXCEEDED → rejected(429, reason = code, Retry-After = ceil(details.tryAgainIn / 1000) when present);
- INVALID_API_KEY / KEY_NOT_FOUND / KEY_DISABLED / KEY_EXPIRED → rejected(401, reason = code, challenge per scheme);
- a thrown non-APIError → infrastructure.

Add an option `references?: 'user' | 'organization' | ((key: { configId: string }) => 'user' | 'organization')` (default 'user', the plugin's default). Set userId = references === 'user' ? referenceId : null and expose organizationId for org keys. With the fix for BA-r1-01, the admin policy then never sees org keys.

### BA-r1-05 (major): Org policies re-send the caller's credential headers, so with enableSessionForAPIKeys every policy call spends the API key's quota again

- **Section:** §8.3 (org policies), §7.9 (cost), B21, §7.3 ('credential translation happens inside getSession')
- **Failure scenario:** Setup: apiKey({ enableSessionForAPIKeys: true }), the default key rate limit (10 requests/day), and a route with @RequireOrgPermission(...) plus @RequireOrgMember(). One request:

1. The session source calls getSession({ headers }) → the key is consumed once.
2. orgPermission calls auth.api.hasPermission({ headers }). The headers still carry x-api-key, so the api-key plugin's any-endpoint before-hook runs validateApiKey again → consumed a second time.
3. orgMember calls getActiveMemberRole({ headers }) → consumed a third time.

The probe measured requestCount 1 → 2 → 3. The key hits 429 after 3-4 requests instead of 10. Each extra check also costs extra DB writes. The design's cost tables (§7.9, §8.3) and B21 cover only the guard's getSession, and the only usage-count test (§14.3) covers apiKeyPrincipal.

- **Evidence:** packages/api-key/src/index.ts:170-172 (before-hook matcher: any endpoint whose ctx.headers carries a configured key header), :197-205 (validateApiKey consumes usage and rate limit), :264-268 (short-circuit only for /get-session). Probe tmp-review-BA-r1/probe-apikey-policy.mjs: `after getSession requestCount = 1`, `after hasPermission requestCount = 2`, `after getActiveMemberRole requestCount = 3`. design-v1.md lines 2208-2209 (org policies call endpoints with headers), 2151-2158, 1623, 2018.
- **Suggested fix:** Make the multiplier a documented and tested property rather than a surprise:
- Correct §7.9/§8.3.
- Promote B21 to a warning (W_API_KEY_SESSION_MULTIPLIER) when enableSessionForAPIKeys is on and any header-forwarding requirement (orgPermission/orgMember or a third-party policy flagged `presentsCredentials: true`) is referenced.
- Add a conformance case asserting key usage per request across guard and policies.
- Recommend apiKeyPrincipal() + apiKeyPermission() for key traffic. Org policies already declare principals ['session'], so they deny api-key principals without spending quota.
- Optionally memoize org endpoint calls per (request, organizationId) so orgMember and orgPermission on one route share one call.

### BA-r1-06 (minor): The hook dispatcher and its types diverge from better-auth on DB update hooks, delete returns and matcher exceptions

- **Section:** §10.2 (CompiledHook), §10.5, §10.6 dispatcher code, §4.5.1, §11.3 DatabaseHookData
- **Failure scenario:** (a) Two Nest @BeforeDatabase('user.update') hooks: hook 1 returns { data: { name: 'A' } }, hook 2 reads data.name.
- In better-auth (N native plugins), every update.before hook receives the ORIGINAL update payload.
- The design's dispatcher passes the merged `current`, so hook 2 sees 'A'.
  The §10.5 table even states "the next hook sees the merged data" as better-auth's semantics. That is only true for create.
  (b) DatabaseHookData<'user.update'> is typed as the full user, but update.before receives Partial<User> (e.g. { name, updatedAt }). `data.email.toLowerCase()` type-checks and then throws at runtime.
  (c) Returning { data } from a delete.before hook is typed as allowed but silently ignored.
  (d) A throwing user predicate that is the only candidate makes the dispatcher's matcher return false, so run() never re-throws it. The error is swallowed and the hook silently does not run. better-auth answers 500 for before-hook matcher throws, and after-hook matcher throws propagate raw.
- **Evidence:** better-auth db/with-hooks.ts:54 (create: toRun(actualData)); :129 and :204 (update and updateMany: toRun(data), the original payload, for every hook); :291 and :328 (delete: only `=== false` is honored). core/src/types/init-options.ts:1435-1445 (update.before: Partial<User>; delete.before returns boolean | void). api/dispatch.ts:146-163 (before-hook matcher exceptions → APIError 500) vs :230 (after-hook matcher not caught). design-v1.md lines 2523, 2534-2545, 1477-1478, 2651-2654, 2427-2432.
- **Suggested fix:** Mirror better-auth per operation:
- create: chain the merged data;
- update/updateMany: pass the original data to every hook and only accumulate the merge result;
- delete: honor only false and type the return as `boolean | void`.

Derive the DB hook parameter and return types from `NonNullable<BetterAuthOptions['databaseHooks']>[M][Op]` (intersected with the registered additionalFields), so Partial<> on update tracks better-auth across minors.

Make CompiledHook.matches return true on a predicate throw so run() re-throws: APIError 500 for before hooks, raw for after hooks.

Extend the §14.5 parity property test to update/updateMany/delete and to throwing predicates.

### BA-r1-07 (minor): Wrong claim that Nest before-hooks see other plugins' before-hook effects (e.g. bearer); the banned-user /get-session example fails open

- **Section:** §10.2 'Placement', §10.4 skipInternal rationale
- **Failure scenario:** Following §10.4, a team writes @BeforeAuth('/get-session') to block banned users, resolving the user from ctx.headers (e.g. getSessionFromCtx(ctx)). The design says that, because nestjs() is last, 'Nest before-hooks see the effects of other plugins' before-hooks, for example bearer() turning Authorization into a cookie'.

In fact every before-hook receives the original context. Bearer's conversion is returned as { context: { headers } } and merged only after all before-hooks have run. For bearer-token clients the hook finds no session and lets the request through.

With enableSessionForAPIKeys, the api-key plugin short-circuits /get-session before nestjs() hooks run. After-hooks are also skipped on a short-circuit, so neither a before nor an after Nest hook on /get-session ever runs for API-key callers.

- **Evidence:** better-auth api/dispatch.ts:179-182 (each hook is invoked with `{...context}`, the original), :196-214 (context results accumulate in modifiedContext), :367-384 (applied after all hooks), :385-394 (a short-circuit returns before after-hooks). plugins/bearer/index.ts:101-115 (bearer returns { context: { headers } }). api-key/src/index.ts:264-268 (/get-session short-circuit). design-v1.md lines 2483, 2509.
- **Suggested fix:** Correct §10.2: before-hooks see the original request; other plugins' { context } rewrites are invisible to them; short-circuiting plugins earlier in the list (api-key on /get-session) prevent Nest hooks from running. Replace the security example with a pattern that works for every credential type:
- an @AfterAuth('/get-session') inspecting ctx.context.returned (and documenting the api-key short-circuit), or
- better-auth's admin ban and a session.create DB hook.

Add a conformance case covering a bearer-token client.

### BA-r1-08 (minor): Hook contexts type `body` with the endpoint's validated schema, but hooks run before better-auth validates the body

- **Section:** §11.3 AuthHookContext, §11.4 (hook body row), §2.2.3 HookMethodDecorator
- **Failure scenario:** A Nest hook @BeforeAuth('/sign-up/email') normalize(ctx: AuthHookContext<'/sign-up/email'>) does ctx.body.email.toLowerCase(); the types say email: string. A client posts { "email": 123, ... }. The before-hook runs on the raw parsed body before better-auth's zod validation, throws a TypeError, and the request becomes 500 instead of better-auth's 400 VALIDATION_ERROR. For server calls the body is whatever the caller passed, also unvalidated.
- **Evidence:** better-call src/context.ts:203-219 (runValidation with the endpoint's schema happens inside createInternalContext, i.e. when the endpoint itself is invoked). better-auth api/dispatch.ts:361-366 (runBeforeHooks) precede :406 (`endpoint(internalContext)`); after-hooks receive the same unvalidated internalContext.body. design-v1.md lines 2645-2648 (`body: string extends P ? unknown : BodyAt<P>`), 2680.
- **Suggested fix:** Type hook bodies as unvalidated input, e.g. `body: DeepPartial<BodyAt<P>> | unknown` or `unknown` with an exported `isBodyOf<P>()` guard, as better-auth's own HookEndpointContext does (body: any). Keep path autocomplete. Document that validation happens after before-hooks and that after-hooks see the raw input.

### BA-r1-09 (minor): AuthExchange overrides the user's onAPIError.throw by turning thrown APIErrors back into JSON Responses

- **Section:** §6.3 step 6, §6.10, §13.1 (auth routes row)
- **Failure scenario:** A team sets betterAuth({ onAPIError: { throw: true } }) so auth-route errors reach the host's error pipeline (their Nest filter logs and reshapes them). better-auth's router rethrows the APIError out of auth.handler. AuthExchange catches it with isAPIError and builds `Response.json(e.body ?? { message }, { status: e.statusCode, headers })`. The Nest filter never sees it, and the configured behavior silently does nothing. The conversion is also a hand-written copy of better-call's toResponse.
- **Evidence:** better-auth api/index.ts:357-361 (router onError: `if (options.onAPIError?.throw) throw e;`); auth/base.ts:107-108 (the handler propagates router throws). design-v1.md lines 1762-1764 (lists onAPIError.throw as a throw source, then converts to a Response), 1925.
- **Suggested fix:** When `(await auth.$context).options.onAPIError?.throw` is true, pass a thrown APIError to the platform's host error pipeline unchanged (Express next(err), Fastify rejection), carrying its hidden better-call:api-error-headers so a filter can restore cookies. Otherwise keep the conversion for the init/dynamic-host cases. State the rule in §6.10 and add a conformance case.

### BA-r1-10 (minor): Admin policy turns better-auth's 400 'user not found' (a normal client state) into a 500 configuration error

- **Section:** §8.3 (admin row), Z2 / §13.2 normalizeThrown
- **Failure scenario:** A user is deleted while their browser still holds a cookie-cached session (cookieCache maxAge, default 300 s):

1. The guard's getSession gets a cache hit and authenticates the user.
2. @RequirePermission calls userHasPermission({ body: { userId } }).
3. better-auth throws 400 'user not found'.
4. Z2 / normalizeThrown maps 'another 4xx' to BetterAuthConfigurationError, so the client gets a 500 plus an ERROR log on every request for up to 5 minutes, instead of 401/403.

The same happens for org-owned API keys (BA-r1-04).

- **Evidence:** better-auth plugins/admin/routes.ts:1882-1888 (findUserById → 400 BAD_REQUEST 'user not found'). design-v1.md lines 1437, 2172-2176, 2943, 2949 ('A 4xx other than 401, 403 or 429 means our own call was malformed').
- **Suggested fix:** In the admin policy, map this expected outcome explicitly before the safety net sees it: 400 'user not found' becomes deny(401, reason 'USER_NOT_FOUND') so the client re-authenticates. Add a policy conformance case with a deleted user and a cached session.

### BA-r1-11 (minor): betterAuthCorsOrigin misses origins that plugins add through init(), even though the design says it keeps them

- **Section:** §6.9 betterAuthCorsOrigin, §2.2.4
- **Failure scenario:** A plugin contributes trusted origins through init(), for example expo() adding 'exp://' in development, or a custom partner-domain plugin. better-auth's own origin/CSRF check on auth routes accepts those origins, because the handler recomputes trusted origins per request from the post-init options. `(await auth.$context).isTrustedOrigin(origin)`, which the helper delegates to, reads `this.trustedOrigins`. That list was computed before runPluginInit, so the helper rejects them. Browsers then get a CORS failure on auth routes that better-auth itself would accept.
- **Evidence:** better-auth context/create-context.ts:280 (trustedOrigins computed), :298-306 (isTrustedOrigin uses this.trustedOrigins), :432 (runPluginInit runs afterwards). context/helpers.ts:44-56, 63-83, 94-95 (plugin trustedOrigins are merged only into context.options). auth/base.ts:97-100 (per-request recomputation for router calls). expo/src/index.ts:26-34. design-v1.md line 1911 ('keeps ... env origins and plugin-contributed origins').
- **Suggested fix:** Build the helper's allow-list from the post-init `(await auth.$context).options.trustedOrigins` (array case; keep throwing for the function case) in addition to `ctx.trustedOrigins`, using better-auth's matcher semantics, e.g. by calling `ctx.isTrustedOrigin.call({ trustedOrigins: merged }, origin)`. Pin it with a conformance case using a test plugin that adds an origin via init. The WS origin check proposed in BA-r1-03 should share the same resolver.

## Proposed user decisions

- _*Should the nestjs() plugin forward Set-Cookie from application-level direct auth.api.* calls (made in controllers or services under the scope interceptor) by default? Library-internal calls (guard, policies) forward either way._*
  - Option: On by default (current v1; nextCookies-like convenience; opt out per call with runOutsideScope)
  - Option: Off by default, matching better-auth's server-call semantics; opt in per handler (@ForwardAuthCookies()) or with a module option
  - Option: On by default, but with a module-level switch and a boot warning listing handlers that call credential endpoints (signUpEmail/signInEmail) directly
  - Recommendation: Off by default with explicit opt-in (option 2). In better-auth, server calls never touch the browser unless the developer deliberately adds a cookie plugin. The nestjs() plugin is mandatory for unrelated reasons, so bundling an always-on bridge into it silently changes semantics (e.g. signUpEmail for another user swaps the caller's session). It also encourages cookie-setting credential endpoints that bypass better-auth's rate limiting and origin checks.

- **Should the guard enforce better-auth's origin (CSRF) rule on state-changing HTTP app routes when the principal was authenticated by a cookie, or leave CSRF to the host? (Enforcing it on WS and subscription handshakes is recommended regardless; see BA-r1-03.)**
  - Option: Host responsibility (current v1): CORS, SameSite and custom middleware; the library does nothing on app routes
  - Option: Default on: for non-safe methods with a cookie credential, require Origin/Referer to be a better-auth trusted origin (respecting advanced.disableOriginCheck / disableCSRFCheck); opt out globally or per route
  - Option: Opt-in only: ship a requirement/decorator (e.g. @RequireSameOrigin()) and a module flag, off by default
  - Recommendation: Default on for cookie-authenticated non-safe methods (option 2), using better-auth's trusted-origin set and its disable flags. It extends better-auth's secure-by-default cookie model to the new surfaces this library creates, and bearer, API-key and RPC callers are unaffected. The trade-off is that non-browser clients sending cookies without an Origin header would need the opt-out, which should be documented.
