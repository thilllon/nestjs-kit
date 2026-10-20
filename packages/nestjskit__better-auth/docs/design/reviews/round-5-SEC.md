---
reviewer: SEC
round: 5
reviewed: design-v5.md
verdict: reject
blockers: 0
majors: 1
minors: 2
prior_unresolved: []
---

# Round 5 review: SEC (security / SRE)

Input: `design-v5.md`. Verdict: **reject**.

Experiments: `/tmp/nsba/tmp-r5-review-SEC/` (better-auth 1.7.4, `NODE_ENV=production`, `TEST` unset, `advanced.disableOriginCheck: false`, static `baseURL`, memory adapter). Probe outputs are saved as `*.out` next to each script.

## Summary

v5 closes every round-4 SEC finding, and two of them by replacing the mechanism rather than patching it. The plugin no longer becomes inert at shutdown, so a BullMQ worker draining after `close()` still meets the Nest hooks (SEC-r4-01). A static GraphQL `context` object fails boot and a finished request is refused at runtime (SEC-r4-03). The re-classification read is one budgeted, memoized read per logical request (SEC-r4-04). Origin-denial WARN lines use an hourly window with a closing summary and log a `Referer` as its origin (SEC-r4-05). The new caller-session check (SEC-r4-02) works as described: I reproduced the mechanism against better-auth 1.7.4 and a non-`APIError` thrown by a plugin before-hook handler propagates out of `auth.api.*` unchanged, with its brand intact, and the write is blocked (`probe-beforehook-throw.out`).

One new major. The caller-session check lives in `BetterAuthScopeInterceptor`, and that interceptor is registered globally **only by a `forRoot` whose `globalGuard` is `true`** (§5.7). Under `globalGuard: false` — the configuration every `disableGlobalAuthGuard: true` app lands in when it migrates (§15.2) — a handler that declares nothing in B16's sense gets neither the guard nor the interceptor, so no scope exists, `ScopeView.checkCallerSession` is never supplied, and the exact SEC-r4-02 cross-site direct call succeeds again. Reproduced on 1.7.4: `updateUser` and `revokeSessions` succeed cross-site while the router answers 403 `INVALID_ORIGIN` (`probe-unguarded-direct-call.out`).

Two minors: the check's trigger predicate is narrower than the rule it enforces (safe methods, and a leg cookie shadowed by `connectionParams`); and `HttpRequestAccessor.isLive` is optional, so SEC-r4-03's runtime defense is silently absent on a third-party platform — the design's own Hono sketch omits it.

Checked and not raised:

- The `PUBLIC_HANDLER_USED_CALLER_SESSION` throw path: §10.5's "before → throws: propagates" row is marked "by construction"; I ran it. `auth.api.updateUser` rejects with the original error object, `name`, `code` and the `Symbol.for` brand intact, no `APIError` wrapping, and the user row unchanged (`probe-beforehook-throw.out`). `normalizeThrown`'s `isConfigurationError` pass-through therefore applies, and even if a future better-auth wrapped it as a 500 `APIError` the result would still be a 5xx, never a denial.
- Past `limits.maxAuthorizationCallsPerRequest`, a generic 401 that needs the re-classification read answers 429 `TOO_MANY_AUTHORIZATION_CHECKS` instead of a 5xx during an outage (§8.1 "Budget"). That is not an S6 violation (never 401/403), and it takes a request with more than 100 distinct policy keys, so it is a documentation note, not a defect.
- `B02` awaiting `auth.$context` does not turn a database blip into a crash loop: `getDatabaseType` is a synchronous string in `create-context.ts:98, 270`, so `$context` performs no storage I/O for the shipped adapters.
- The `x-forwarded-host` / `x-forwarded-proto` copy that T5 now requires for every credential mapping is bounded: the kernel's trusted set never uses them (`upgradeRequestUrl()`, §7.10), so the worst an attacker who sets them on a socket.io polling handshake achieves is to make **their own** socket's calls fail under a dynamic `baseURL`.

## Prior findings

| Id        | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC-r4-01 | resolved | `onApplicationShutdown` closes the binding instead of unbinding it, and a closed binding keeps dispatching (§5.7 step 4, §10.2, §10.6, B04 protocol 4, `LIB-shutdown-hooks`). Failing a call whose hook's providers are gone is the right side of the trade (RK33). One narrowing to note: B26 now counts only dispatches before the **first** binding, so in a process that runs applications sequentially, seeding that app 2 does before `BetterAuthModule` binds runs **app 1's** closed hooks and nothing reports it. That is test-only and strictly safer than v4's silent skip, so it is an observation, not a finding. |
| SEC-r4-02 | resolved | The original scenario is stopped: the scope interceptor supplies `ScopeView.checkCallerSession`, plugin before-hook entry 2 runs it before any Nest hook, and the throw propagates out of `auth.api.*` and blocks the write (`probe-beforehook-throw.out`). The mechanism's **reach** is the new major SEC-r5-01 (`globalGuard: false` leaves no scope at all) and the new minor SEC-r5-02 (the trigger predicate).                                                                                                                                                                                                            |
| SEC-r4-03 | resolved | `GRAPHQL_STATIC_CONTEXT` fails boot for a non-function `context` on both drivers, and the HTTP branch requires `isLive`. RK36 records the residual honestly. That `isLive` is optional in the accessor contract is the new minor SEC-r5-03.                                                                                                                                                                                                                                                                                                                                                                                    |
| SEC-r4-04 | resolved | The re-read goes through the policy I/O memo under `(call.key, instance, ["reclassify", sourceId])`, stored before it settles, counted against the budget, and `repeated` makes it one ERROR line per request (§7.2, §8.1, §13.4, `T-internal-error-logged-once` variant). 300 aliases now cost one read.                                                                                                                                                                                                                                                                                                                      |
| SEC-r4-05 | resolved | Hourly window, 100 new pairs per window then debug, a WARN summary of the closed window at the next denial (no timer), and a `Referer` logged as `new URL(referer).origin` (§7.10, §13.4). An attacker who keeps filling every window still produces the per-reason counts in each summary, so a misconfiguration that starts later is still visible. The security e2e row drives the window with `vi.setSystemTime`.                                                                                                                                                                                                          |

## Findings

### SEC-r5-01 (major): The caller-session check lives in the scope interceptor, which is registered only when `globalGuard: true`; under `globalGuard: false` an undecorated or `@Public()` handler has no scope at all, so SEC-r4-02's cross-site direct call succeeds again

- **Section:** §5.7 providers table (`APP_GUARD` / `APP_INTERCEPTOR` … "the `forRoot` with `globalGuard: true`") and "Guard registration and overriding"; §5.4 B16 (the definition of "declares something"); §9.1 ("A route that declares nothing stays the app's choice"); §7.5 ("The scope interceptor therefore gives every handler scope whose browser leg enforces the origin check … a caller-session check"); §10.2 `ScopeView.checkCallerSession` and before-hook entry 2 (`matcher: … !!s?.checkCallerSession …`); §15.1 step 7 and §15.2 (`disableGlobalAuthGuard: true` → `globalGuard: false`); ADR-70; §17 Q37; RK32.
- **Failure scenario:** An app migrating from `@thallesp/nestjs-better-auth` that used `disableGlobalAuthGuard: true`. §15.2 maps it to `globalGuard: false` + `@UseBetterAuth()` "where needed", and B16 defines "needed" as _declaring something_, which explicitly excludes `@Public()` and excludes a handler with no library metadata at all. The app keeps its "does its own auth" endpoint, either undecorated or with the `@Public()` the migration table suggests for handlers that read no session:

  ```ts
  @Controller("account") // globalGuard: false, no @UseBetterAuth()
  export class AccountController {
    constructor(
      @Inject(BETTER_AUTH_SERVICE) private readonly auth: BetterAuthService,
    ) {}
    @Post("email") change(@Req() req, @Body() b) {
      return this.auth.api.changeEmail({
        headers: this.auth.headersFrom(req),
        body: b,
      });
    }
  }
  ```

  1. Boot passes. The route declares nothing, so B16 reports no `ROUTE_UNGUARDED`, and `UNGUARDED_AUTH_METADATA` does not fire either (no trigger-list metadata; `@Public()` is on the never-fires list).
  2. No `APP_GUARD` and, decisively, **no `APP_INTERCEPTOR`**: §5.7 contributes both only from the `forRoot` whose `globalGuard` is `true`. `BetterAuthScopeInterceptor` is therefore not in the application's global interceptor list at all.
  3. With no scope, `binding.current()` is `undefined` inside the direct call, so `ScopeView.checkCallerSession` does not exist and plugin before-hook entry 2's matcher (`!!s?.checkCallerSession`) is false. Entry 2 never runs.
  4. A cross-site page auto-submits a form to `/account/email` with the victim's `sameSite: 'none'` cookie (or from a sibling subdomain, SEC-r1-01). `auth.api.changeEmail` runs as the victim; better-auth's own origin check is router-only (LEAD-V16). The same request through the mount answers 403 `INVALID_ORIGIN`.

  This is SEC-r4-02's failure verbatim, with the precondition `globalGuard: false` instead of `@Public()` under the global guard, and it needs **no decorator on the handler**, so it is if anything easier to reach than the case v5 fixed. `globalGuard: false` is a first-class, CI-exercised configuration (§12.9 step 7 runs an "HTTP with `globalGuard: false`" coverage job), it is the documented migration target for `disableGlobalAuthGuard`, and §7.8/§5.7 recommend a variant of it for guard ordering. The design already recognized that this configuration strips a security behavior when it made `@ForwardAuthCookies()` count as "declares something" precisely so that the form-CSRF check cannot be lost under `globalGuard: false` (§2.2.3, §5.4 B16). The caller-session check needs the same protection but cannot get it the same way, because a direct `auth.api` call is invisible to a static scan: there is nothing on the handler for B16 to see.

  The secondary loss is smaller but real: without the interceptor these handlers also get no refresh suppression and no cookie bridge. Cookie-less transports are unaffected, because gateways and hybrid RPC handlers need `@UseBetterAuth()` anyway (B16, `everyHandler`).

- **Evidence:**
  - `probe-unguarded-direct-call.mjs` / `.out` (better-auth 1.7.4, `NODE_ENV=production`, `TEST` unset, `advanced.disableOriginCheck: false`, static `baseURL`, `trustedOrigins: ['https://app.example.com']`), the same request sent two ways:
    - `[router]  POST /update-user cross-site -> 403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}`;
    - `[direct call, no scope] updateUser cross-site -> {"status":true}`, `[direct call, no scope] stored name: pwned-via-unguarded-handler`;
    - `[direct call, no scope] revokeSessions cross-site -> {"status":true} | sessions left: 0`.
  - Design text: §5.7 providers table, row `APP_GUARD` / `APP_INTERCEPTOR`, module column "the `forRoot` with `globalGuard: true`"; §5.7 "With `globalGuard: false`, `@UseBetterAuth()` applies both enhancers where needed"; §5.4 B16 "declares something" (`@Public()` is not in the list; `UNGUARDED_AUTH_METADATA` "never fires for `@Public()`"); §9.1 "A route that declares nothing stays the app's choice, even with `defaultRequirements` set"; §10.2 entry 2's matcher and the `ScopeView.checkCallerSession` doc comment ("Present in a handler scope whose browser leg enforces…"); §7.5 "Coverage gaps, documented" does not list the `globalGuard: false` case.
  - `probe-beforehook-throw.out` shows the contrast: with a scope present the same call is refused before the endpoint runs (`threw: … code = PUBLIC_HANDLER_USED_CALLER_SESSION … stored name: v`).
- **Suggested fix:**
  1. **Decouple the scope interceptor from `globalGuard`.** Register `{ provide: APP_INTERCEPTOR, useExisting: BetterAuthScopeInterceptor }` from the default instance's `forRoot` whatever `globalGuard` says. The interceptor opens a scope, it never denies, so it changes no authorization outcome; it makes `checkCallerSession`, refresh suppression and the cookie bridge exist for every handler the transports recognize. The one change it needs is that the scope's `reading` (§7.5 step 2) must be computed **lazily**: today it is taken at scope open and would throw `NO_AUTH_RESULT` for every unguarded, non-public plan. Readers already throw that error themselves (§7.8 item 5), so moving the lookup behind a getter costs nothing and keeps the current error for the current call sites. Give apps that genuinely want zero library enhancers an explicit `globalScope: false`, printed in the boot summary (B22).
  2. **Make the remaining gap visible.** When the application's global interceptors do not include `BetterAuthScopeInterceptor` (an explicit `globalScope: false`, or `globalGuard: false` if option 1 is not taken), warn at boot with a new code (`W_NO_GLOBAL_SCOPE`) naming the consequence: direct `auth.api` calls in handlers without `@UseBetterAuth()` act on the caller's ambient cookie with no origin verdict, and get no refresh suppression. B16 already reads `ApplicationConfig.getGlobalInterceptors()`, so the check costs nothing new.
  3. **Tests.** Extend `LIB-public-direct-call` (§14.5) with a `globalGuard: false` boot in which an undecorated controller and a `@Public()` controller each make the call: both must answer the generic 500, not perform the write. Extend `LIB-coverage-rule` with the new warning. Add a §14.4 row for the migrated `disableGlobalAuthGuard` app.
  4. Correct §7.5's "Coverage gaps, documented" list and §15.1 step 7 to say that under `globalGuard: false` a handler without `@UseBetterAuth()` has no scope, so §7.5's guarantee does not hold there.

### SEC-r5-02 (minor): The caller-session check's trigger is narrower than the rule it enforces: a `@Public()` handler acting on the caller's session over a safe method is untouched, and so is one whose call carries the leg's own cookie while `connectionParams` shadowed it in the scope's inbound headers

- **Section:** §7.5 ("Safe methods, cookie-less legs, calls without the caller's session cookie … are untouched"); §10.2 `carriesInboundSession` (`token === sessionTokenOf(s.inbound?.())`) and the `ScopeView.checkCallerSession` presence rule; §7.10 "When it applies" item 2 (`enforce`); §9.2 credentials over a WebSocket (`connectionParamHeaders`, default `authorization`, `cookie`, **replace** same-named headers); §14.5 `LIB-public-direct-call` ("from a GET route … is not affected"); T8 / `T-csrf-safe-methods`; §7.6 "Public means no identity".
- **Failure scenario:** The invariant §7.6 states is "public means no identity", and ADR-70 extends it to `auth.api`. The implementation keys on something else — "the browser leg enforces the origin check, carries a cookie, and the call's session token equals the **scope's inbound** one" — and the two come apart in two reachable ways.

  1. **Safe methods.** A migrated handler kept on GET, which the reference library's users commonly have for logout and link-style actions:
     ```ts
     @Public() @Get('logout') logout(@Req() req) { return this.auth.api.signOut({ headers: this.auth.headersFrom(req) }); }
     ```
     `browser.enforce` is false for GET/HEAD/OPTIONS (§7.10 item 2), so the scope has no `checkCallerSession` and the call runs as the victim. `<img src="https://api.example.com/logout">` on any page forces a logout; the same pattern with `unlinkAccount`, `acceptInvitation` or `deleteUser` on a GET route changes account state. The same holds for a `@Public()` GraphQL **query** resolver over HTTP, where `enforce` is also false. better-auth's router skips safe methods too, but better-auth exposes no state-changing endpoint over GET, while this design hands app handlers `headersFrom(req)` and lets them call any endpoint from any method. The design pins the gap rather than closing it (`LIB-public-direct-call`: "from a GET route … is not affected").
  2. **A leg cookie shadowed in the scope's inbound headers.** Over graphql-ws the default `connectionParamHeaders` is `['authorization', 'cookie']`, and those keys **replace** same-named upgrade headers in `TransportCall.headers()` (§9.2), while the browser leg keeps the upgrade request's own headers (T8). A cross-site page opens a socket that carries the victim's ambient cookie _and_ sets `connectionParams.cookie` to junk. `checkCallerSession` is present (the leg carries a cookie), but a `@Public()` handler that builds its headers from the upgrade request rather than from the transport's mapping presents the victim's token, `s.inbound?.()` holds the junk one, `carriesInboundSession` is false, and the call proceeds with no origin verdict. The attacker needs no secret: the shadowing value is theirs, the authenticating value is the ambient cookie.

- **Evidence:** §7.5 as quoted; §10.2 `carriesInboundSession(ctx, s)` = `token !== '' && token === sessionTokenOf(s.inbound?.(), ctx)`; §9.2 table row "Credentials over a WebSocket": "`connectionParams` keys in `connectionParamHeaders` (default `authorization`, `cookie`) **replace** same-named headers", against T8 "`browser.headers()` are the leg's own headers"; §14.5 `LIB-public-direct-call` records the GET case as out of scope; `probe-unguarded-direct-call.out` shows that `auth.api` with a cookie header performs the write whatever the HTTP method of the Nest handler was, because better-auth sees only the headers it is given.
- **Suggested fix:**
  1. Key the check on the plan, not on `enforce`. Supply `checkCallerSession` whenever the plan's access is `public` (or `inherit` under a public entry point), the plan's origin check is not `'off'`, and the transport exposes a browser leg at all — `enforce` or not. A public handler must never act on the caller's session; a guarded handler keeps the current verdict-based rule, so `@RequireAuth() @Get(...)` is unaffected and no new denial appears on safe methods for guarded routes.
  2. Compare the call's session token against the **union** of the scope's inbound headers and `browser.headers()`, so a value the leg carried ambiently is recognized even when a transport mapping replaced it. One extra `parseCookies` on a path that already parses one.
  3. Tests: add GET and GraphQL-query rows to `LIB-public-direct-call` and to the §14.4 public-handler row (the write must not happen), and a `T-subscription-*` row where `connectionParams.cookie` shadows an ambient upgrade cookie.

### SEC-r5-03 (minor): `HttpRequestAccessor.isLive` is optional, so SEC-r4-03's runtime defense is silently absent on a third-party platform — including the design's own worked example — with no boot or runtime signal

- **Section:** §4.1.1 `HttpRequestAccessor.isLive?` ("Without it, that defense is skipped"); §4.1.4 the Hono platform sketch, whose `requests` object implements `isRequest`, `key`, `headers`, `request`, `clientIp`, `param` and `cookieSink` and **no** `isLive`; H10 ("`requests.isLive()`, **when implemented**"); §9.2 "where the platform implements `isLive`" and the Apollo/Mercurius table row "Recognizing an HTTP operation"; RK36; ADR-61.
- **Failure scenario:** A team runs GraphQL on a third-party HTTP platform (the shipped Hono sketch, or any community platform written against §4.1.1 and validated with the conformance kit). Their `GraphQLModule` uses a context **function** that caches, which is the shape the boot check cannot see:

  ```ts
  const ctx = ({ req }) => (cached ??= { req, loaders: createLoaders() }); // or a memoized factory behind a DI singleton
  ```
  1. `GRAPHQL_STATIC_CONTEXT` does not fire: `context` is a function.
  2. Alice's request is the first. Her request object is stored in the cached object and kept, exactly as in SEC-r4-03.
  3. Bob's operation reaches the guard with `context.req === <Alice's request>`. `isRequest` answers true. The design's second line of defense is `isLive`, but the platform does not implement it, so the HTTP branch is taken unconditionally: `key` is Alice's request, whose principal promise is memoized, and `browser.headers()` are hers.
  4. Every later caller, anonymous ones included, resolves as Alice until the process restarts — the SEC-r4-03 outcome, on a platform that passed the conformance kit, because `H-accessor-is-request` only asserts `isLive` "when implemented" (H10) and the sketch declares no capability that would make it required.

  Nothing reports it: there is no boot line saying "the running platform implements no `isLive`, so a cached GraphQL context cannot be detected", and RK36 is written as if the defense always exists after the first response.

- **Evidence:** §4.1.1, the `isLive?` doc comment, verbatim: "Optional: … Without it, that defense is skipped. `[R4:SEC-r4-03]`". §4.1.4, the `requests: { … }` literal of `honoPlatform()`, which has no `isLive` member while the same sketch does implement the rest of the accessor. H10: "`requests.isLive()`, **when implemented**, is true while the handler runs and false once the response was sent", so a platform that omits it passes `H-accessor-is-request` unchanged. §9.2: the HTTP branch requires it only "where the platform implements `isLive`". REV4-SEC:`gql/probe-static-context.mjs` established the underlying runtime behavior (`session=bob -> principal=alice reqEnded=true`).
- **Suggested fix:**
  1. Make `isLive` **required** in `HttpRequestAccessor`. It is two lines on every Node-based platform (`!req.res.writableEnded`; on a Web-native platform such as Hono, `!c.finalized`, which the sketch already uses in its cookie sink), and it is a security defense, not a convenience. Update §4.1.4 and H10 accordingly, and make `H-accessor-is-request` assert it unconditionally.
  2. If it must stay optional for backward compatibility with an already-published third-party platform, the GraphQL units' `validate()` should report it: when `kit.http` is non-null and implements no `isLive`, emit a boot warning (`W_NO_STALE_CONTEXT_CHECK`) naming the platform id and the residual (a context function returning a cached object cannot be detected), so the gap is a visible deployment fact rather than a silent one. Extend RK36 to say that the runtime half of the defense depends on the platform.

## Proposed user decisions

- **Should `BetterAuthScopeInterceptor` be registered globally independently of `globalGuard`?** (Fix of SEC-r5-01.)
  - Option (a), always: the default instance's `forRoot` contributes `APP_INTERCEPTOR` whatever `globalGuard` says, with an explicit `globalScope: false` escape printed in the boot summary. Every handler a transport recognizes then has a scope, so the caller-session check, refresh suppression and the cookie bridge exist app-wide. Cost: `globalGuard: false` no longer means "no library enhancers at all", and the scope's `reading` must become lazy so that an unguarded, non-public handler does not throw `NO_AUTH_RESULT` at scope open.
  - Option (b), keep the coupling and warn: `W_NO_GLOBAL_SCOPE` at boot when the global interceptors do not include `BetterAuthScopeInterceptor`, naming the CSRF consequence, and say so in §7.5 and migration step 7. Cheaper, and it keeps `globalGuard: false` literal, but the protection then depends on someone reading a warning — which is the objection §17 Q35 records against warning instead of failing.
  - Recommendation: **(a), with (b)'s warning kept for the explicit `globalScope: false` opt-out.** The interceptor denies nothing, so making it unconditional changes no authorization outcome; it only restores the invariant ADR-70 states. `globalGuard: false` is the documented migration target for `disableGlobalAuthGuard`, so leaving the hole there aims it at exactly the population SEC-r4-02 was raised for.
