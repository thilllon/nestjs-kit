---
reviewer: NEST
round: 6
reviewed: design-v6.md
verdict: reject
blockers: 0
majors: 3
minors: 1
prior_unresolved: []
---

# Round 6 review: NEST (NestJS correctness, packaging, SOLID)

Input: `design-v6.md`. Verdict: **reject** (3 majors, 1 minor; no blocker).

Scratch directory: `/tmp/nsba/tmp-r6-review-NEST/`. No new runtime experiment was needed: every
new finding rests either on a contradiction between two normative parts of v6 itself, or on Nest
facts the design already records and verified (LEAD-V6, LEAD-V29, LEAD-V31, LEAD-V34, LEAD-EXP-1,
LEAD-EXP-13, REV5-NEST:`exp3-global.ts`).

## Summary

All five of my round-5 findings stop their original failure scenario in v6, and the two
mechanisms that were **replaced** rather than patched are the right shape:

- **`GUARD_CORE` / `SCOPE_CORE` (NEST-r5-01).** `BetterAuthGuard.canActivate` is now
  `return this.core.canActivate(ctx)` over an injected `Symbol.for` token, and `overrideAuthGuard`
  is one `overrideProvider` per token. This is the only construction that can reach both
  `TestingModuleBuilder` collections for one guard, and LEAD-EXP-13 reproduces my round-5 table on
  11.2.5 and 12.0.3 with the extra `overrideProvider(GUARD_CORE)` row (`MOCK` / `MOCK, MOCK`).
  It is also a genuine SOLID improvement rather than a patch: the guard class keeps the single
  responsibility §0.3 always claimed for it, the collaborator is a provider and not a name core
  branches on, and the token being `Symbol.for` removes the helper's last dependence on class
  identity across a dual load (§12.5).
- **Scope registration independent of `globalGuard` (SEC-r5-01, Q38).** Making the interceptor
  unconditional and the scope's `reading` lazy is correct, and `forExecution(ctx)` returning `null`
  for an unhandled context and for an already-open scope keeps it from turning into a second guard.

Three of the four new findings come from the _consequences_ of v6's own edits rather than from
anything older:

- **NEST-r6-01 (major).** v6 rewrote B16's covered-condition to key on the guard alone. That is
  right for the `'global'` reach branch (it is what `globalScope: false` needs), but v6 also dropped
  `@UseInterceptors(BetterAuthScopeInterceptor)` from the **explicit** branch, where nothing else can
  supply the interceptor. `@UseGuards(BetterAuthGuard)` alone now covers a Nest 11 gateway, which is
  exactly NEST-r2-11, resolved in v3. §9.3, §9.4, §15.1 step 7, ADR-40 and `T-coverage-claims` all
  still state the old rule, so v6 contradicts itself.
- **NEST-r6-02 (major).** §7.8 item 5's remedy for NEST-r5-03 is a request-time configuration error
  thrown by the param decorator. Such errors are outside the guard, so the `repeated` mechanism
  §13.4 built for exactly this shape (SEC-r3-08) does not apply: one API-key request to a list field
  costs one 500 and one full ERROR line **per list item**, and ordinary client traffic can drive it.
- **NEST-r6-03 (major).** Item 5 was applied only to `definePrincipalParam` decorators.
  `BetterAuthService.getSession()` still answers `null` for an authenticated principal of another
  kind, which is NEST-r5-03's "silently answers `canEdit: false` for every row a legitimate key owner
  may in fact edit" verbatim, on a reader with no B15 check and no boot advice — and reachable on an
  ordinary HTTP controller, without GraphQL.
- **NEST-r6-04 (minor).** `W_NESTED_PRINCIPAL_PARAM`'s trigger is scoped to one instance while
  §7.8 item 2 takes the enclosing reading "whatever its instance", so the cross-instance case v5
  created gets no warning before it becomes item 5's 500.

**SOLID.** The kernel stayed name-free. v6's two core additions are of the shape §3.2 rule 5 allows:
a comparison of the decorator's `kind` with `principal.kind` (both data), and a provider seam
(`GUARD_CORE`, `SCOPE_CORE`) that is a token, not a branch. `W_ORG_PARAM_MISSING` lives in the
organization unit and reads `AdvisedHandler.inputs`, which transports supply; the HTTP transport's
`inputs` are `routeParamNames(path)` and its `param()` is documented as "Route param", so the two
line up and the check does not false-positive on ordinary HTTP handlers. No mechanism added in v6
should be removed. The one place where a v6 edit made a contract _less_ coherent is B16: one
sentence ("coverage keys on the guard alone") now covers two branches that need different rules,
and it is the only normative text that says so while four other places say the opposite.

**Testability for consumers** is much better than in v5: `overrideAuthGuard` works as specified for
the first time since v1, `LIB-testing-override-everywhere` pins it in one compiled module across
both call-site sets, and the companion negative case pins the collision it replaces. The remaining
testability weakness is NEST-r6-01: a consumer who follows §9.3 and §15.1 writes
`@UseBetterAuth()`, but a consumer who follows B16 writes `@UseGuards(BetterAuthGuard)` and gets a
boot that passes and messages that throw.

## Prior findings

### Round 5 (NEST-r5-*)

| Id         | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| NEST-r5-01 | resolved | `BetterAuthGuard`/`BetterAuthScopeInterceptor` are one-line delegates over `GUARD_CORE`/`SCOPE_CORE` (§2.2.8, §2.3, §3.1 U10/U11, §5.7, §12.5, §14.8, ADR-51); `overrideAuthGuard` is one `overrideProvider` per token, and §5.7 and §14.8 warn third parties that `overrideProvider` + `overrideGuard` for one token cannot be combined. LEAD-EXP-13 reproduces my table on 11.2.5 and 12.0.3 and adds the collaborator row. `LIB-testing-override-everywhere` asserts both call-site sets in **one** compiled module with the real resolver's counter at 0, plus a negative case that pins the collision. Two leftovers, neither a finding: §12.5's "What remains" still says the helper "takes the guard class from the library build's shared chunk", which it no longer needs to, and §14.8's `LIB-testing-stamp-mock-guard` still says "B16 counts the replaced global guard by identity" although v6 no longer replaces the guard object. |
| NEST-r5-02 | resolved | §9.2's heading and `I_CLASS_METADATA_OPERATIONS_ONLY` now say "operations **and** federation entry points, not field resolvers" and print both lists by name; reference resolvers claim `inputs: []` explicitly; the organization unit gains `W_ORG_PARAM_MISSING` for any `fromParam(n)` whose handler's claimed inputs lack `n` (which also catches `fromParam` typos on ordinary handlers, as suggested); `T-reference-resolver`'s third boot pins the 403-for-every-representation behavior next to the class's still-working query; RK38 records it. The severity choice ('warn', because WS/RPC payload fields and custom param decorators are not claimable) is right.                                                                                                                                                                                                                                                                    |
| NEST-r5-03 | resolved | §7.6 step 6 is corrected (B15 proves the sets disjoint only for plans that resolve their own principal), §7.8 gains item 5 (a read-time comparison of the decorator's `kind` with `principal.kind`, throwing the spec's `reason` instead of projecting `undefined`), `@CurrentSession()`'s entry states it, `W_NESTED_PRINCIPAL_PARAM` warns at boot, and `T-reads-session` (fourth boot) and `T-stamp-per-plan` (`sessionReader`) pin "never `undefined`, never a `TypeError`, never `false`". My scenario is stopped. Three consequences of the remedy are new findings: NEST-r6-02 (its cost per invocation), NEST-r6-03 (the same defect survives in `BetterAuthService.getSession()`), NEST-r6-04 (the advice's trigger is narrower than the rule).                                                                                                                                                                                         |
| NEST-r5-04 | resolved | §9.2 "Turning field guards on multiplies every _other_ global enhancer" states both effects (every global guard **and interceptor** per field-resolver invocation, and the fast field-resolver path disabled app-wide), `W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS` names the affected enhancers from the same `ApplicationConfig` list B22 prints and lists the escapes, §0.4 records the cost, and the GraphQL job pins the multiplication with a counting `APP_GUARD`. Q36's decision is unchanged, as the owner's standing decision requires.                                                                                                                                                                                                                                                                                                                                                                                                 |
| NEST-r5-05 | resolved | §7.1's second public branch is `(!plan.nested && record(call, NO_IDENTITY))`, §7.8 "What the guard records" states the rule once ("a nested public plan never records, whatever its origin-check mode") and §7.1 and §3.1 U10 refer to it. `T-stamp-per-plan`'s third v6 boot repeats the whole `publicNested` row under `cookies.forwardDirectCalls: true` with `fieldResolverCoverage: 'warn'`, asserting the same reading under both `fieldResolverEnhancers` settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Earlier findings marked unresolved

None was outstanding entering round 6. **NEST-r1-08** ("`overrideAuthGuard` works wherever the
guard applies, and B16 still passes"), which round 5 recorded as still unmet for a new reason, is
now met: one `overrideProvider(GUARD_CORE)` reaches both call-site sets (LEAD-EXP-13), the real
`BetterAuthGuard` object stays registered so B16's identity rule is trivially satisfied, and
`LIB-testing-override-everywhere` asserts both in one application.

### An earlier fix the latest revision broke again

**NEST-r2-11** ("WS coverage accepts `@UseGuards(BetterAuthGuard)` without the scope interceptor"),
marked resolved in rounds 3, 4 and 5, is re-opened by v6's rewrite of B16. Reported as
**NEST-r6-01**.

## New findings

### NEST-r6-01 (major): v6 rewrote B16's covered-condition to "the guard alone" for **both** branches, so `@UseGuards(BetterAuthGuard)` without `@UseInterceptors(BetterAuthScopeInterceptor)` now covers an `'explicit'` claim — NEST-r2-11's exact failure on Nest 11 gateways and hybrid RPC — while §9.3, §9.4, §15.1, ADR-40 and `T-coverage-claims` still state the old rule

- **Section:** §5.4 B16, second bullet ("a claimed handler is covered when … or `@UseBetterAuth()`
  (or `@UseGuards(BetterAuthGuard)`) applies at class or method level. **Coverage keys on the guard
  alone since v6** `[R5:SEC-r5-01]`"); §9.3 design consequence 2 "Guard and interceptor"; §9.4
  "Guard registration and hybrid coverage"; §15.1 step 7; ADR-40 (_Revised in v3_); §14.1
  `T-coverage-claims`; §5.4 B31.
- **Failure scenario:** a Nest 11 application with a socket.io gateway, `globalGuard: true`
  (default), and a developer who reads B16 rather than §9.3:

  ```ts
  @WebSocketGateway()
  @UseGuards(BetterAuthGuard)                      // not @UseBetterAuth()
  export class ChatGateway {
    @SubscribeMessage('say')
    say(@CurrentSession() s: AuthSession, @MessageBody() b: { text: string }) { … }
  }
  ```
  1. The socket.io unit claims every message handler `'explicit'` with `everyHandler`
     (`GATEWAY_UNGUARDED`, §9.0 row).
  2. Under **v5**'s B16 the claim was covered only by `@UseBetterAuth()` **or by both**
     `@UseGuards(BetterAuthGuard)` **and** `@UseInterceptors(BetterAuthScopeInterceptor)`, so this
     boot failed with `GATEWAY_UNGUARDED` and the hint that names `@UseBetterAuth()`.
  3. Under **v6**'s B16 the parenthetical is "(or `@UseGuards(BetterAuthGuard)`)" and the rule is
     restated as "coverage keys on the guard alone since v6", so the claim is covered and the app
     boots.
  4. On Nest 11 no global interceptor reaches a gateway (`@nestjs/websockets` 11.1.17
     `socket-module.js:81` builds the context creators with `getContextCreator(container)`, without
     `ApplicationConfig`; LEAD-V6, LEAD-V29), and WebSockets have **no lineage** on purpose (§7.2's
     table, §7.8). So the handler runs with the guard but with no scope: the §7.8 lookup finds
     nothing at item 3 (the guard did record on the `args` array, but the reader without the
     interceptor is a param factory that sees a _fresh_ args array on WS — LEAD-V7 — and the
     interceptor is what copies the record into the scope), and `@CurrentSession()` throws
     `NO_AUTH_RESULT` on **every message**: the generic 500 `AUTH_MISCONFIGURED` for every client,
     one ERROR line each. This is NEST-r2-11's text verbatim.
  5. A direct `auth.api.*` call in the same handler additionally gets no refresh suppression on a
     cookie-less transport (S2) and no `ScopeView.checkCallerSession` (§7.5, ADR-70), because both
     live in the scope the interceptor opens.

  The same relaxation applies to the RPC unit's `'explicit'` claims in hybrid apps (§9.4: "every
  handler needs `@UseBetterAuth()` (guard and interceptor, so direct calls in the handler get
  refresh suppression)"), where `connectMicroservice` without `inheritAppConfig` also gives the
  microservice a fresh `ApplicationConfig` (LEAD-V32) and nothing else can supply the interceptor.

  v6 is self-contradictory about this, which is why it will be implemented one way and documented
  the other:
  - §9.3: "An `'explicit'` claim is covered only by `@UseBetterAuth()` or by both
    `@UseGuards(BetterAuthGuard)` and `@UseInterceptors(BetterAuthScopeInterceptor)`. v2 accepted
    `@UseGuards(BetterAuthGuard)` alone; … `@CurrentSession()` threw `NO_AUTH_RESULT` on every
    message (NEST-r2-11)."
  - §15.1 step 7: "a plain `@UseGuards(AuthGuard)` becomes `@UseBetterAuth()`, **not**
    `@UseGuards(BetterAuthGuard)`: gateways need the scope interceptor too".
  - ADR-40, _Revised in v3_: "An `'explicit'` claim is covered only by the guard **and** the scope
    interceptor." ADR-40 has no v6 revision (§18 lists ADR-41, 51, 61, 64, 66, 67, 69, 70 as the
    ones revised), so the decision log still records the v3 rule.
  - `T-coverage-claims` (§14.1): "With `@UseGuards(BetterAuthGuard)` alone added on an `'explicit'`
    claim it still fails." As written, this conformance case now fails against B16.

- **Evidence:**
  - `design-v5.md:2546` (B16, second bullet): "… or its reach is `'global'` and the application's
    global enhancers include **both** `BetterAuthGuard` and `BetterAuthScopeInterceptor`, whoever
    registered them; or `@UseBetterAuth()` (**or both** `@UseGuards(BetterAuthGuard)` **and**
    `@UseInterceptors(BetterAuthScopeInterceptor)`) applies at class or method level."
  - `design-v6.md:2610` (B16, second bullet): "… or its reach is `'global'` and the application's
    global guards include `BetterAuthGuard`, whoever registered them; or `@UseBetterAuth()` (or
    `@UseGuards(BetterAuthGuard)`) applies at class or method level. **Coverage keys on the guard
    alone since v6**". The justification given for the change concerns only the `'global'` branch
    ("under `globalScope: false` with `globalGuard: true` the old wording would have failed boot
    with `ROUTE_UNGUARDED` for **every** claimed handler"), which the explicit branch does not
    share: an `'explicit'` claim is never covered by a global enhancer in the first place.
  - `design-v6.md:3754` (§9.3), `:3792` (§9.4), `:5120` (§15.1 step 7), `:5699` (ADR-40's
    _Revised in v3_ bullet, which has no v6 successor), `:4846` (`T-coverage-claims`) — all still
    the "both" rule.
  - LEAD-V6 / LEAD-V29 for the Nest 11 gateway fact; LEAD-V7 for the fresh param-factory args
    array; §7.2's transport table ("WebSocket … `call.lineage`: none").
  - `reviews/round-2-NEST.md:179` and `ledger.md:88` for the original finding and its accepted
    resolution.
- **Suggested fix:** split the sentence, because the two branches now need different rules.
  - **Global reach:** covered when the application's global guards include `BetterAuthGuard`
    (v6's rule, correct — the missing interceptor is B31's single warning).
  - **Explicit reach:** covered by `@UseBetterAuth()`, or by **both** `@UseGuards(BetterAuthGuard)`
    and `@UseInterceptors(BetterAuthScopeInterceptor)` at class or method level — unchanged from
    v5, because on Nest 11 gateways and on a hybrid microservice without `inheritAppConfig` no
    global interceptor exists to fall back on, whatever `globalScope` says. State the reason inline
    ("an explicit claim exists precisely because no global enhancer reaches these handlers, so both
    must be declared") so the next edit cannot merge the branches again.
  - Add a v6 revision bullet to ADR-40 recording that only the global branch changed, and keep
    `T-coverage-claims`'s "`@UseGuards(BetterAuthGuard)` alone still fails" row, extending it with a
    `globalScope: false` + `globalGuard: true` boot that must **pass** for `'global'` claims and
    **fail** for `'explicit'` ones, so the asymmetry is pinned by a case rather than by prose.

### NEST-r6-02 (major): §7.8 item 5's error is thrown by the param decorator, outside the guard, so §13.4's "logged once per logical request" does not apply — one API-key request to a list field costs one 500 and one full ERROR line **per item**, driven by ordinary client traffic rather than by a first request after a bad deploy

- **Section:** §7.8 item 5 ("a logged, generic 500") and item 6 ("The decorator runs where the guard
  did not, so no transport's `toInternalException` can map this error"); §13.4 "Infrastructure
  failures are logged once per logical request"; §7.1's error footer (`repeated =
scope.surfaced(call.key, error)`); §9.2 "Infrastructure and configuration errors"
  (`BetterAuthGraphqlRepeatedInternalError`); §14.1 `T-internal-error-logged-once`,
  `T-reads-session` (fourth boot), `T-stamp-per-plan` (`sessionReader`); §9.2
  `W_NESTED_PRINCIPAL_PARAM`; ADR-41, ADR-68.
- **Failure scenario:** the design's own `sessionReader` fixture shape, in an application that boots
  with nothing but a warning:

  ```ts
  @Resolver(() => Report)
  export class ReportResolver {
    @AcceptPrincipals('session', 'api-key')
    @Query(() => [Report]) reports(@Args('first') first: number) { … }      // returns 500 rows

    @ResolveField(() => Boolean)
    canEdit(@Parent() r: Report, @CurrentSession() s: AuthSession) { return s.user.id === r.ownerId; }
  }
  ```

  with `fieldResolverEnhancers: ['guards', 'interceptors']` (which `FIELD_RESOLVER_UNGUARDED` or
  `FEDERATION_FIELD_GUARDS_REQUIRED` may have made mandatory).

  1. Boot succeeds. The only signal is `W_NESTED_PRINCIPAL_PARAM`, which §9.2 itself says is advice
     because "most listed handlers are fine" — so it is routinely left in place.
  2. A machine client sends `x-api-key` and requests `{ reports(first: 500) { id canEdit } }`. The
     entry point accepts `'api-key'`, so the guard records an `ApiKeyPrincipal`.
  3. `canEdit` is nested and inherits that reading (§7.8 item 2). Item 5 compares the decorator's
     `kind` with `principal.kind`, they differ, and it throws
     `BetterAuthConfigurationError.atRequest('SESSION_REQUIRED', …)` — **once per list item**, i.e.
     500 times for one HTTP request.
  4. Each throw escapes the resolver. The guard never saw it, so `call.key`'s `surfaced` record is
     never consulted and no transport's `toInternalException` can turn the repeats into
     `BetterAuthGraphqlRepeatedInternalError`. The error is not an `IntrinsicException`, so Nest's
     `ExternalExceptionFilter` logs it per resolver invocation (LEAD-V9, LEAD-V31, and §9.2's own
     statement "Nest's external exception handler logs every non-intrinsic error **per resolver
     invocation**, so 500 aliased root fields during an outage would write 500 ERROR entries for one
     request"). Result: 500 GraphQL errors and 500 ERROR lines — each carrying the `site`, `detail`
     and `hint` own properties `util.inspect` prints — for one request that the operator's own
     monitoring will read as an outage.
  5. Unlike `NO_AUTH_RESULT`, which appears on the **first** request after a bad deployment and is
     fixed immediately, this one is credential-dependent: the same schema and the same query behave
     perfectly for every cookie caller and blow up only for API-key callers, so it survives staging
     and can be triggered repeatedly by any key holder.

  §13.4 and ADR-68 state the rule this violates ("an infrastructure error is logged once per logical
  request … so an outage costs one read and one ERROR line per request, not one per alias"), and
  `T-internal-error-logged-once` asserts exactly "a guarded field resolver under a list of 20 items
  produces … exactly one ERROR entry". The two v6 cases that cover item 5 (`T-reads-session` fourth
  boot, `T-stamp-per-plan` `sessionReader`) assert the 500 and the logged `reason` but never bound
  the count, so nothing catches this.

- **Evidence:**
  - Design lines: §7.8 item 5 (`design-v6.md:3343`) and item 6 (`:3344`, "no transport's
    `toInternalException` can map this error"); §7.1's footer (`:3043-3047`), which is the only
    place `repeated` is computed and which only runs for errors the **guard** catches; §13.4
    (`:4592`); §9.2's `BetterAuthGraphqlRepeatedInternalError` paragraph (`:3675`); §14.1
    `T-internal-error-logged-once` (`:4839`), `T-reads-session` (`:4841`), `T-stamp-per-plan`
    (`:4843`).
  - LEAD-V9 (`ExternalExceptionFilter` logs only non-intrinsic errors), LEAD-V31 (`util.inspect`
    prints the enumerable own properties), LEAD-EXP-1 (an `IntrinsicException` subclass is not
    logged; a plain error is logged on every denial), REV5-NEST:`exp3-global.ts` (a field resolver
    under a list runs once per item, so N throws for N items).
- **Suggested fix:** give the readers the same once-per-request rule the guard already has; nothing
  in core learns a transport name.
  - The lookup in §7.8 already walks `lineage.carrier` (the GraphQL context object) for readings.
    Record "this reason was already surfaced for this carrier/invocation key" next to it, under a
    `Symbol.for(…:surfaced)` slot, and have items 5 and 6 throw the **intrinsic** twin of the error
    (the same message, `extensions` and `reason`, `IntrinsicException`-derived) on every repeat.
    Clients still get one error per field — which GraphQL requires — while Nest logs one ERROR per
    logical request, exactly as `BetterAuthGraphqlRepeatedInternalError` already does for the guard
    path. Where no carrier exists (HTTP, WS, RPC) there is at most one invocation per request
    anyway, so the rule is a no-op there.
  - When a scope is open (which since v6 is the normal case, §5.7), prefer `RequestScope`'s existing
    `surfaced(call.key, error)` record, so the two paths share one mechanism.
  - Extend `T-internal-error-logged-once` with an item-5 row: the `sessionReader` fixture under a
    20-item list with an API key must produce 20 client errors and **one** ERROR entry. Say in §13.4
    that the rule covers reader-thrown request-time configuration errors, not only infrastructure
    ones, so `NO_AUTH_RESULT` and `NO_INVOCATION_VALUE` get the same treatment.

### NEST-r6-03 (major): item 5 was applied only to `definePrincipalParam` decorators, so `BetterAuthService.getSession()` still answers `null` for an authenticated principal of another kind — NEST-r5-03's silent wrong answer, on a reader B15 never inspects, reachable on a plain HTTP controller

- **Section:** §2.2.2 `BetterAuthService.getSession()` ("The `session` field of the current principal
  when it carries one (session principals), else null. Same scope rules as `getPrincipal()`");
  §7.8 item 5 ("A `definePrincipalParam` decorator compares its own `kind` with `principal.kind`");
  §7.8 "Services"; §5.4 B15 (`PRINCIPAL_PARAM_CONFLICT` triggers on _param decorators_ only);
  §9.2 `W_NESTED_PRINCIPAL_PARAM` (nested handlers carrying a _param decorator_); §7.6 step 6.
- **Failure scenario:** no GraphQL needed. An application with `apiKeyPrincipal()` registered and the
  documented "both kinds" route from §7.6's own `ReportsController` example, whose body reads the
  session through the service rather than through a decorator — the shape §15.2 recommends to
  migrating users ("read the principal with `BetterAuthService`"):

  ```ts
  @AcceptPrincipals('session', 'api-key')
  @Get('export')
  async export() {
    const s = await this.auth.getSession();          // null for an API-key caller
    return this.reports.list({ ownerId: s?.user.id ?? null });
  }
  ```
  - A cookie caller gets their own reports.
  - An API-key caller is fully authenticated (`ApiKeyPrincipal`, delegation enforced, the route
    accepts the kind), yet `getSession()` returns `null` because an `ApiKeyPrincipal` has no
    `session` member (§2.2.15). The handler takes the anonymous branch and lists rows whose
    `ownerId` is null.
  - Nothing reports it. B15's `PRINCIPAL_PARAM_CONFLICT` fires only for `definePrincipalParam`
    decorators, and this handler has none. `W_NESTED_PRINCIPAL_PARAM` fires only for nested handlers
    carrying such a decorator. The route is not nested and carries none.
  - The GraphQL variant is my round-5 scenario, unchanged: a field resolver whose body does
    `const s = await this.auth.getSession(); return s?.user.id === r.ownerId;` under an
    `@AcceptPrincipals('session','api-key')` query "silently answers `canEdit: false` for every row a
    legitimate key owner may in fact edit" — the exact wording of NEST-r5-03, still true after v6's
    fix, because the fix lives in the decorator.
  - `null` from `getSession()` is also the value a **public** plan returns (§7.8 item 1), so the
    service reader conflates "there is no identity" with "there is an identity, of a kind I do not
    project" — the same conflation NEST-r2-07 removed for "the guard has not run" (which now throws
    `PRINCIPAL_READ_BEFORE_GUARD`) and for "outside a scope" (`NO_AUTH_SCOPE`). `getSession()` is
    the one reader left where a distinguishable state is collapsed into `null`.

- **Evidence:**
  - Design lines: `design-v6.md:632` (`getSession(): Promise<SessionOf<A> | null>`, "when it carries
    one (session principals), else null"); `:3343` (item 5, scoped to `definePrincipalParam`);
    `:3350` ("`principalFor` … runs items 1 to 4 and 6 … item 5 belongs to kind-constrained param
    decorators"); `:3359` (Services); `:2609` (B15's trigger list); `:3678`
    (`W_NESTED_PRINCIPAL_PARAM`'s trigger); `:3268`-`:3270` (§7.6 step 6, which states the invariant
    for decorators only).
  - §2.2.15's `ApiKeyPrincipal` has no `session` member, which is why the projection is empty.
  - `reviews/round-5-NEST.md` NEST-r5-03 for the identical failure text, and `ledger.md`'s entry for
    it, whose resolution names only §7.8 item 5 and the param decorators.
- **Suggested fix:** make the service reader answer the same three-valued question the decorator now
  answers, and let boot see it.
  - `getSession()` gains the same read-time rule as item 5: for an `authenticated` reading whose
    `principal.kind` is not a kind the session unit's projection applies to, throw the spec's
    `reason` (`SESSION_REQUIRED`) rather than returning `null`. `null` stays the answer for
    `no-identity` and `absent`, which is what its type promises. Because `getSession()` is the
    session unit's convenience over `getPrincipal()`, the rule is the unit's, not core's: core
    keeps comparing `kind` against `kind` (§3.2 rule 5).
  - Alternatively, if the `| null` return is to stay total, change `getSession()`'s contract to
    return `{ session } | { otherKind: string } | null` — but the throwing form matches item 5 and
    keeps one rule for both readers, which is the point of §7.8's "one lookup".
  - Extend B15: a handler whose accepted kinds include a kind the session projection rejects, in a
    **class that injects `BetterAuthService`**, cannot be decided at boot — so instead extend
    `W_NESTED_PRINCIPAL_PARAM` into a `W_MIXED_KIND_SESSION_READER` emitted by the **session unit**
    (which owns the projection) for every handler whose accepted kinds are more than
    `{'session'}`, with the hint `getPrincipal()` plus a narrowing on `p.kind`. That covers the
    non-nested HTTP case above, which no current advice reaches.
  - Add a `T-reads-session` fifth row (or an `S-` case on the session source): the `readsSession`
    fixture rewritten to use `BetterAuthService.getSession()` on an `@AcceptPrincipals('session',
'api-key')` handler must not answer `null` to an API-key caller.

### NEST-r6-04 (minor): `W_NESTED_PRINCIPAL_PARAM`'s trigger is scoped to one instance, while §7.8 item 2 takes the enclosing reading "whatever its instance", so the multi-instance case v5 created reaches item 5's 500 with no boot warning at all

- **Section:** §9.2 "Kind-constrained param decorators on nested handlers"
  (`W_NESTED_PRINCIPAL_PARAM` "lists every nested handler carrying a kind-constrained param
  decorator while **the instance** has more than one principal kind in play (more than one kind
  among its sources, or any `@AcceptPrincipals` in the schema)"); §7.8 item 2 ("takes the first
  reading recorded at one of those positions, **whatever its instance**"); §7.6 step 3 (class-level
  `@UseAuthInstance` applies to nested handlers, method-level does not reach them); §7.6 step 5
  (a requirement contributes its kinds without `@AcceptPrincipals`); §5.5.
- **Failure scenario:** two instances, the pattern §5.5 documents — `default` (session source only)
  and `machine` (session plus `apiKeyPrincipal()`) — in one GraphQL schema:

  ```ts
  @Resolver(() => Report)
  export class ReportResolver {
    @UseAuthInstance('machine')                       // METHOD level: does not reach nested handlers
    @RequireApiKeyPermission({ reports: ['read'] })   // admits 'api-key' without @AcceptPrincipals (§7.6 step 5)
    @Query(() => [Report]) reports() { … }

    @ResolveField(() => Boolean)
    canEdit(@Parent() r: Report, @CurrentSession() s: AuthSession) { … }   // instance 'default'
  }
  ```
  - `canEdit` is nested, carries no class-level `@UseAuthInstance`, so its plan's instance is
    `default`, whose sources produce exactly one kind, and the schema contains **no**
    `@AcceptPrincipals` — the wider kind arrives through `@RequireApiKeyPermission`'s
    `requires.principals`. Both halves of `W_NESTED_PRINCIPAL_PARAM`'s trigger are therefore false
    and **no warning is printed**.
  - At request time, §7.8 item 2 takes the enclosing reading "whatever its instance", so `canEdit`
    receives instance `machine`'s `ApiKeyPrincipal` and item 5 throws `SESSION_REQUIRED` — per item,
    per request, with no prior signal. §7.6 step 6 explicitly acknowledges this reach ("v5's
    'whatever its instance' rule (NEST-r4-03) widened it further to every instance's operations"),
    but the advice that is supposed to warn before the loud error does not follow it.

- **Evidence:** design lines `design-v6.md:3678` (the trigger), `:3335` (item 2, "whatever its
  instance"), `:3255` (§7.6 step 3: only **class-level** `@UseAuthInstance` reaches nested
  handlers), `:3265` (§7.6 step 5: a requirement contributes kinds), `:3270` (§7.6 step 6's
  acknowledgement of the cross-instance reach). Reading only; the rules as written produce it.
- **Suggested fix:** compute the trigger over the same population item 2 reads from. The GraphQL
  units already know every handler in the schema (they claim them), so the condition becomes: warn
  for a nested handler with a kind-constrained param decorator whenever **any handler of the same
  schema**, of any instance, has accepted kinds that are not a subset of the decorator's kind —
  taking accepted kinds from the plan (which already includes the kinds requirements name, §7.6
  step 5), not from `@AcceptPrincipals` metadata. State in §9.2 that the trigger is schema-wide and
  instance-blind **because the read is**, so the two cannot drift apart again. Add a
  `T-reads-session` variant whose entry point widens its kinds through a requirement rather than
  `@AcceptPrincipals`, and one whose entry point belongs to another instance, both asserting the
  warning.

## Product questions

None. NEST-r6-01 restores a rule the design already decided (§17 Q19 fail-closed coverage, ADR-40)
and leaves Q38's decision — the scope interceptor registered independently of `globalGuard` — fully
intact: the split I propose is precisely what Q38 needs for the `'global'` branch and what ADR-40
already decided for the `'explicit'` one. NEST-r6-02 to NEST-r6-04 ask for a de-duplication rule,
one more reader following an existing rule, and a wider advice trigger; none of them reopens a
decided question.
