---
reviewer: NEST
round: 5
reviewed: design-v5.md
verdict: reject
blockers: 0
majors: 4
minors: 1
prior_unresolved: []
---

# Round 5 review: NEST (NestJS correctness, packaging, SOLID)

Input: `design-v5.md`. Verdict: **reject** (4 majors, 1 minor; no blocker).

Experiments: `/tmp/nsba/tmp-r5-review-NEST/`.

- `n12/`: Nest 12.0.x (`@nestjs/core` 12.x), `@nestjs/graphql` 14.0.0, `@nestjs/apollo` 14, `@apollo/server` 5.5.1, `@apollo/subgraph` 2.15.1, `graphql` 16.14.2, Node 22.22.2. Scripts: `exp2-path.mjs`, `exp3-global.ts`, `exp4-override.ts`, `exp5-both.ts` (compiled into `build/`).
- `n11/`: `@nestjs/core` 11.2.5, `@nestjs/testing` 11, `@nestjs/platform-express` 11. Script: `exp5.js`.

## Summary

Every round-4 finding of mine stops its original failure scenario in v5, and I re-verified the two mechanisms the fixes rest on:

- **Reference resolvers (NEST-r4-01).** `GqlExecutionContext.create` really does normalize @apollo/subgraph's three-argument call to `[root, undefined, ctx, info]` (`@nestjs/graphql` 14 `utils/normalize-resolver-args.js`), so `gql.getRoot()` is the representation and `param()` can read it. `exp2-path.mjs` confirms the position rule: `__resolveReference` sees `info.path = [_entities(Query)]` for **every** representation (so a per-representation position can only come from `__typename`), while a field under `_entities.N` has `path = [_entities(Query), N(no typename), field(typename=<EntityType>)]`, which is exactly the "typename of the path entry below the list index" the design derives `'<op>:_entities#<__typename>'` from — also for deeper nesting. It also confirms the `NO_ENCLOSING_DECISION` case: a `@key` type **without** `__resolveReference` still runs its field resolvers, with the attacker-supplied representation as `@Parent()`.
- **Guard identity (NEST-r4-02).** `exp4-override.ts`: `overrideProvider(LibGuard).useValue(mock)` and `.useClass(Mock)` both put an object into `ApplicationConfig.getGlobalGuards()` that is `===` `moduleRef.get(LibGuard, { strict: false })`. B16's identity rule works, and `overrideGuard` alone leaves the branded real guard in place, which the brand fallback covers.

I found 4 majors and 1 minor, and no blocker.

- **`overrideAuthGuard` cannot do what §14.8 says it does (major, NEST-r5-01).** `TestingModuleBuilder.overloadsMap` is a `Map` keyed by the token alone, so `overrideProvider(X)` and `overrideGuard(X)` **overwrite each other**. Verified on Nest 11.2.5 and 12.x: calling both, in either order, gives exactly the result of the last call. NEST-r1-08's guarantee ("`overrideAuthGuard` works wherever the guard applies") is therefore still not met, by a different mechanism than NEST-r4-02.
- **Class-level requirements now reach federation reference resolvers (major, NEST-r5-02).** Making reference resolvers entry points (NEST-r4-01's fix) means a class-level `@RequireOrgPermission(..., { organization: fromParam('orgId') })` is compiled into them, and a representation has no `orgId`: every entity of that type answers 403 across the whole supergraph. §9.2's own heading still says "Class-level metadata reaches the operations only", and neither `I_CLASS_METADATA_OPERATIONS_ONLY` nor `W_ORG_PARAM_IGNORED` reports it. This is NEST-r3-05's failure, reintroduced for the new entry-point class.
- **Kind-constrained param decorators on `inherit` plans get the enclosing kind (major, NEST-r5-03).** §7.6 step 6 claims "no principal of a rejected kind reaches such a decorator", but a nested handler's `accepts` is the instance's default kinds, while its reading comes from the enclosing operation, whose `accepts` may be wider. `@CurrentSession()` on a field resolver under an `@AcceptPrincipals('session','api-key')` query receives an `ApiKeyPrincipal`, so `project: (p) => p.session` yields `undefined` typed `AuthSession`. v5's NEST-r4-03 fix ("whatever its instance") widened the reach of this hole.
- **Requiring `fieldResolverEnhancers: ['guards']` multiplies every other global guard (major, NEST-r5-04).** `exp3-global.ts`: with `['guards']`, an application `APP_GUARD` runs once per field-resolver invocation, i.e. once per list item. `FEDERATION_FIELD_GUARDS_REQUIRED` (default `'error'`) makes that setting mandatory for federation subgraphs, and `FIELD_RESOLVER_UNGUARDED`'s hint recommends it elsewhere. A `ThrottlerGuard` registered as `APP_GUARD` — the setup the design itself names in §5.4, §7.8 and B22 — then counts one hit per field per item.
- Minor: the guard flow's second `public` branch records "no identity" without the `!plan.nested` test the first branch has, so a nested `@Public()` field resolver in `'form'` origin mode still records, contradicting §7.8 and NEST-r4-03's rule (NEST-r5-05).

**SOLID.** The kernel stayed name-free. v5's only core addition, "an `inherit` plan with a lineage and no enclosing reading throws `NO_ENCLOSING_DECISION`", is a rule over data the transport supplies and introduces no branch on a transport, a kind or a policy (§7.1, §4.2.3). `PrincipalSource.delegates` (NEST-r4-04) is static data an extension declares, and B15 consumes it generically. Federation lives entirely inside the GraphQL units; the only leakage is into contract _prose_ (`TransportCall.invocation` and T6 both spell out "federation reference resolver"), which costs nothing at runtime but should be reworded generically ("an entry point a transport reaches in parallel"). No mechanism added in v5 needs to be removed. NEST-r5-01 is the one place where a mechanism should be **replaced** rather than patched: `overrideAuthGuard` cannot be fixed by calling more override methods, because the collision is in Nest's own map; the guard needs a replaceable collaborator provider instead.

**Testability for consumers** is the weakest area of v5: NEST-r5-01 makes the headline testing helper unusable as specified, and `LIB-testing-stamp-mock-guard`, `LIB-testing-override-principal` and `T-internal-error-generic` boot 2 are all written against it.

## Prior findings

### Round 4 (NEST-r4-*)

| Id         | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEST-r4-01 | resolved | Reference resolvers are entry points (`RESOLVER_REFERENCE_METADATA`, claimed with `everyHandler`, `REFERENCE_RESOLVER_UNGUARDED`), the representation is the invocation, positions are `'<op>:_entities#<__typename>'`, and `NO_ENCLOSING_DECISION` closes a `@key` type with no reference resolver. I re-verified all three mechanical premises (`exp2-path.mjs`, `normalize-resolver-args.js`, `resolvers-explorer.service.js:98-112`): the normalization, the `__typename`-only position source, and the fact that field resolvers of a reference-less entity run against the raw representation. Two consequences of making reference resolvers entry points are new findings: NEST-r5-02 and NEST-r5-04. |
| NEST-r4-02 | resolved | B16 recognizes a global enhancer by identity with `moduleRef.get(BetterAuthGuard, { strict: false })`, with the brand as fallback. `exp4-override.ts` on Nest 12: no override `identical=1 branded=1`; `overrideProvider(...).useValue(mock)` `identical=1 branded=0`; `.useClass(Mock)` `identical=1 branded=0`; `overrideGuard(...).useValue(mock)` `identical=1 branded=1`. The `ROUTE_UNGUARDED` boot failure is gone in all four. (`overrideAuthGuard` itself is broken for an unrelated reason: NEST-r5-01.)                                                                                                                                                                                            |
| NEST-r4-03 | resolved | `RoutePlan.nested`; inherit plans take the nearest enclosing reading whatever its instance, and report it in `PrincipalReading.instance`; a nested public plan records nothing. Both my scenarios (a field resolver shared by two instances' operations; a nested `@Public()` with a reader below it) now give one answer under both `fieldResolverEnhancers` settings. One branch of the guard flow was not updated with it (NEST-r5-05), and the "whatever its instance" rule makes NEST-r5-03 easier to reach.                                                                                                                                                                                             |
| NEST-r4-04 | resolved | `PrincipalSource.delegates` (invariant P5, `S-delegation`), true on `apiKeyPrincipal()` and the OAuth sketch; B15 counts a kind-less requirement as admitting exactly the non-delegating sources' kinds, with "a kind produced by a delegating and a non-delegating source counts as non-delegated". My `tenantActive()` + `@RequireApiKeyPermission` scenario now fails boot with `UNSATISFIABLE_PRINCIPAL_KINDS`.                                                                                                                                                                                                                                                                                           |
| NEST-r4-05 | resolved | §2.2.16 and §14.8 list the admin policy among the policies that need real data; `LIB-testing-override-decisions` pins 401 `USER_NOT_FOUND` without a stored row and the stored role's verdict for a seeded user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Earlier findings marked unresolved

None were outstanding entering round 5. One earlier guarantee is still not met, for a new reason: **NEST-r1-08** ("`overrideAuthGuard` works wherever the guard applies, and B16 still passes"). B16 now passes (NEST-r4-02 resolved), but the override itself reaches only half the call sites. Reported as NEST-r5-01.

## New findings

### NEST-r5-01 (major): `overrideAuthGuard` calls `overrideProvider(BetterAuthGuard)` and `overrideGuard(BetterAuthGuard)`, but `TestingModuleBuilder` keys its overrides by token alone, so the second call silently discards the first and the real `BetterAuthGuard` keeps running on half the call sites

- **Section:** §14.8 first bullet ("`overrideAuthGuard` calls both `overrideProvider(BetterAuthGuard)` … and `overrideGuard(BetterAuthGuard)` …. Either one alone misses a set of call sites"); §5.7 "Guard registration and overriding" ("The testing helper `overrideAuthGuard` therefore does both, for the guard and the interceptor"); §2.2.16 `overrideAuthGuard` ("Replace the guard everywhere: overrideProvider (the APP_GUARD alias) AND overrideGuard (@UseBetterAuth()/@UseGuards sites), and the scope interceptor likewise"); §14.8 cases `LIB-testing-override-principal`, `LIB-testing-stamp-mock-guard`; §14.1 `T-internal-error-generic` boot 2; §7.8 item 4 and §14.8 "Where a replaced guard publishes the principal"; ADR-51.
- **Failure scenario:** the design's own `LIB-testing-override-principal`, run "on a socket.io gateway and a ws gateway that carry `@UseBetterAuth()` … and on an HTTP controller with `globalGuard: true`":

  ```ts
  const moduleRef = await overrideAuthGuard(
    Test.createTestingModule({ imports: [AppModule] }),
    { principal: testUser },
  ).compile();
  ```

  `overrideAuthGuard` must call `builder.overrideProvider(BetterAuthGuard).useValue(standIn)` (for the `APP_GUARD` `useExisting` alias) and `builder.overrideGuard(BetterAuthGuard).useValue(standIn)` (for the injectables `@UseBetterAuth()` creates). Both calls write to the same `Map` entry, so only the last survives:
  - **`overrideGuard` last** — the `APP_GUARD` alias still resolves to the **real** `BetterAuthGuard`. The HTTP controller's request runs real principal resolution: a real `auth.api.getSession` against the test's better-auth instance, so the assertion "performs no better-auth call (adapter call counter)" fails, and the route answers 401 instead of serving `testUser`. On a gateway the stand-in does apply, but the real global guard also ran first on Nest 12.
  - **`overrideProvider` last** — the `@UseBetterAuth()` gateways and every `@UseGuards(BetterAuthGuard)` site run the **real** guard. `LIB-testing-stamp-mock-guard`'s `MockGuard`, which calls `stampPrincipal(ctx, user)`, is never installed there, so the real guard resolves against better-auth; and in `T-internal-error-generic` boot 2 the `passThrough` guard does not pass anything through.

  Either way the helper cannot deliver "replace the guard everywhere", and a consumer who follows §14.8 gets a test that either hits the database or fails with the real guard's 401 — in the one helper whose whole purpose is to avoid that. The same collision applies to the scope interceptor (`overrideProvider` + `overrideInterceptor` on `BetterAuthScopeInterceptor`), so `overrideAuthGuard`'s "the stand-in interceptor opens the same scope the real one does … on every transport" is also only half true.

- **Evidence:**
  - `@nestjs/testing` `testing-module.builder.js` (12.x lines 32-48, 79-84; 11.2.5 the same lines): `overridePipe`, `overrideFilter`, `overrideGuard`, `overrideInterceptor` are all `this.override(typeOrToken, false)` and `overrideProvider` is `this.override(typeOrToken, true)`; `override` does `this.overloadsMap.set(typeOrToken, { ...options, isProvider })` — one entry per token. `applyOverloadsMap` then calls `container.replace(item, options)`, and `Module.replace` acts on providers when `isProvider` is true and on injectables when it is false, never both.
  - `exp5-both.ts` (Nest 12) and `exp5.js` (Nest 11.2.5), one app with `{ provide: APP_GUARD, useExisting: LibGuard }` and a `@UseGuards(LibGuard)` controller, printing which guard instance ran on each route. Identical on both majors:

    | builder calls                                         | global-only route | `@UseGuards` route |
    | ----------------------------------------------------- | ----------------- | ------------------ |
    | none                                                  | `REAL`            | `REAL, REAL`       |
    | `overrideProvider(LibGuard).useValue(mock)`           | `MOCK`            | `MOCK, REAL`       |
    | `overrideGuard(LibGuard).useValue(mock)`              | `REAL`            | `REAL, MOCK`       |
    | `overrideProvider(...)` **then** `overrideGuard(...)` | `REAL`            | `REAL, MOCK`       |
    | `overrideGuard(...)` **then** `overrideProvider(...)` | `MOCK`            | `MOCK, REAL`       |

    Chaining both is indistinguishable from the last call alone.

  - `exp4-override.ts` corroborates from the container side: after `overrideGuard(LibGuard).useValue(mock)`, `moduleRef.get(LibGuard, { strict: false })` still returns the real `LibGuard` and the global list still holds it.
  - Design lines: §14.8 bullet 1 and its `core/injector/module.js:344-356` citation (which explains why one call is not enough, but not that two calls cannot coexist); §5.7 "Guard registration and overriding"; §2.2.16.
- **Suggested fix:** replace the mechanism rather than patch it — no combination of `TestingModuleBuilder` calls can reach both collections for one token.
  - Give `BetterAuthGuard` an injected collaborator, e.g. `GUARD_CORE` (`Symbol.for('nestjs-slightly-better-auth:guard-core')`), that holds `canActivate`'s whole body; `BetterAuthGuard` and `BetterAuthScopeInterceptor` become thin delegates. Both the `APP_GUARD` alias instance and every `@UseGuards(BetterAuthGuard)` injectable instance resolve `GUARD_CORE` from the same module providers, so `overrideAuthGuard` becomes a single `overrideProvider(GUARD_CORE).useValue(...)` that reaches every call site at once. The same for the interceptor's scope opener.
  - Keep `overrideProvider(BetterAuthGuard)` working as documented for users who only need the global alias, and state in §5.7 and §14.8 that `overrideProvider` and `overrideGuard` for the **same** token cannot be combined, so third parties do not copy the pattern.
  - Add a `LIB-coverage-rule` / `LIB-testing-*` case that asserts the stand-in ran on **both** a `globalGuard: true` HTTP route and a `@UseBetterAuth()` gateway in one compiled module, with the real resolver's call counter at 0. The current `LIB-testing-override-principal` wording ("on a socket.io gateway and a ws gateway … and on an HTTP controller") already implies this, but only separate apps would pass today.

### NEST-r5-02 (major): making `@ResolveReference()` an entry point compiles class-level requirements into it, so a resolver class whose operations take an `orgId` argument denies every federated entity of that type 403, while §9.2 still promises "class-level metadata reaches the operations only" and no advice reports it

- **Section:** §9.2 "Federation entry points" ("A method with `RESOLVER_REFERENCE_METADATA` … is never nested: `defaultAccessFor` does not answer `'inherit'` for it, so class-level access, acceptance and requirements and `defaultAccess` apply"); §9.2 "Class-level metadata reaches the operations only" and `I_CLASS_METADATA_OPERATIONS_ONLY`; §7.6 step 3 and step 4; §8.3 `W_ORG_PARAM_IGNORED`; §4.2.1 `ClaimOptions.inputs`; ADR-66, ADR-69.
- **Failure scenario:** a federation subgraph written the way §9.2's own example recommends, with `federationCoverage: 'error'` (the default) satisfied by `fieldResolverEnhancers: ['guards']`:

  ```ts
  @Resolver(() => Project)
  @RequireOrgPermission({ project: ['read'] }, { organization: fromParam('orgId') })
  export class ProjectResolver {
    @Query(() => Project) project(@Args('orgId') orgId: string, @Args('id') id: string) { … }
    @ResolveReference() resolveReference(ref: { __typename: 'Project'; id: string }) { … }
    @ResolveField(() => [Task]) tasks(@Parent() p: Project) { … }
  }
  ```
  - `project` works: the class requirement reads `param('orgId')` from its `@Args`.
  - `tasks` is nested and inherits — NEST-r3-05's fix, correct.
  - `resolveReference` is an **entry point**, so the class requirement applies to it, and `param(name)` for a reference resolver "reads the representation's fields" (§9.2). The router sends `{ __typename: 'Project', id: 'p1' }` — federation keys are `@key(fields: "id")`, they do not carry the parent organization — so the ref determines no organization and the policy denies 403 `ORGANIZATION_REQUIRED` (§8.3, "A result that is not a non-empty string … means 'no organization': 403 with `missingReason`, logged at debug").
  - Every `Project` reference in the supergraph resolves to `null` for every caller, including the subgraph's own users, while the subgraph's own `project` query works. Nothing reports it:
    - `I_CLASS_METADATA_OPERATIONS_ONLY` fires for classes "that carry class-level … requirements and also **field resolvers** without method-level metadata" — it is about field resolvers, and its text asserts the opposite of what now happens;
    - `W_ORG_PARAM_IGNORED` fires only when an org requirement uses `activeOrganization()` while the handler _has_ an org-shaped input; here the ref is `fromParam` and the handler has no inputs at all;
    - the reference resolver's claimed `inputs` are `[]` (it carries no `@Args`, so `PARAM_ARGS_METADATA` is empty), and §9.2 explicitly rejects boot-time `@key` detection, so boot cannot know the representation's fields either.

  This is NEST-r3-05's failure mode ("following the hint made every item answer 403, because a field resolver has no `orgId` argument") moved to the handler class v5 created.

- **Evidence:**
  - `exp2-path.mjs` (`@apollo/subgraph` 2.15.1, graphql 16.14.2): `User.__resolveReference ref= {"__typename":"User","id":"1"} argc= 3` — the representation carries only `__typename` and the `@key` fields.
  - `@nestjs/graphql` 14 `utils/extract-metadata.util.js:4-20`: a `@ResolveReference()` method's `resolverType` comes from the **class** (`Reflect.getMetadata(RESOLVER_TYPE_METADATA, instance.constructor)`), i.e. the entity type name, so nothing distinguishes it from the class's other declarations at metadata level either.
  - Design lines: §9.2 "Federation entry points" bullet 1 and bullet 3; §9.2 "Class-level metadata reaches the operations only"; §8.3 "The default ref and IDOR" (`W_ORG_PARAM_IGNORED` scope); §5.4 B21.
- **Suggested fix:** everything stays inside the GraphQL and organization units.
  - Correct §9.2's heading and `I_CLASS_METADATA_OPERATIONS_ONLY`: class-level metadata reaches operations **and federation entry points**, not field resolvers. Print the affected reference resolvers in that advice, by name.
  - Generalize the organization unit's `advise()` so it also warns the other way round: an org requirement whose ref is `fromParam(n)` on a handler whose claimed `inputs` do not contain `n` (a `W_ORG_PARAM_MISSING`). For a reference resolver, whose `inputs` are empty by construction, have the GraphQL unit claim `inputs: []` explicitly and let the organization unit raise this at `'warn'` with the hint to override the ref at method level (`@RequireOrgPermission(p, { organization: organizationRef(ctx => …) })` reading the representation, or `@SkipDefaultRequirements()` / a method-level requirement on the reference resolver). The same advice catches `fromParam` typos on ordinary HTTP and GraphQL handlers, which nothing reports today.
  - Add a `T-reference-resolver` case: a resolver class with a class-level `fromParam` requirement and a `@ResolveReference()` boots with the warning, and the case documents whether the entity resolves or denies, so the behavior is pinned rather than discovered in production.

### NEST-r5-03 (major): a kind-constrained param decorator on an `inherit` plan receives the _enclosing_ invocation's principal, whose kind the plan never accepted, so `@CurrentSession()` in a field resolver under an `@AcceptPrincipals('session','api-key')` query yields `undefined` typed `AuthSession` — B15 cannot see it, and v5's "whatever its instance" rule widened the reach

- **Section:** §7.6 step 6 ("Every plan comes from the planner … so **no principal of a rejected kind reaches such a decorator**, and the guard carries no runtime comparison for it"); §7.6 step 5 (accepted kinds); §7.8 item 2 and "What each decorator returns" ("In an inheriting field resolver it returns the enclosing reading's session"); §2.2.3 `definePrincipalParam`; §2.2.2 `RoutePlan.principalParams`; §5.4 B15 `PRINCIPAL_PARAM_CONFLICT`; §14.1 `T-reads-session`; §9.2 "Field resolvers are nested and inherit"; ADR-29, ADR-41, ADR-64.
- **Failure scenario:** the two patterns the design documents side by side — a root field that admits API keys (§7.6's own `ReportsController` example, transposed to GraphQL) and a field resolver that reads the session (§9.2's "`@CurrentSession()` in an inheriting field resolver reads its enclosing field's reading"):
  ```ts
  @Resolver(() => Report)
  export class ReportResolver {
    @AcceptPrincipals('session', 'api-key')
    @Query(() => [Report]) reports() { … }

    @ResolveField(() => Boolean)
    canEdit(@Parent() r: Report, @CurrentSession() s: AuthSession) { return s.user.id === r.ownerId; }
  }
  ```
  - `canEdit` is nested, so the planner ignores class-level metadata and its effective access is `inherit`. Its **own** accepted kinds are the instance's default kinds, `{'session'}` (`apiKeyPrincipal()` defaults to `acceptance: 'explicit'`), and its `principalParams` is `[{ kind: 'session', reason: 'SESSION_REQUIRED' }]`. B15 intersects the two, finds no conflict, and boot passes.
  - A request authenticating with `x-api-key` runs `reports`, whose guard records an `ApiKeyPrincipal` at the root position.
  - `canEdit` takes that reading through the lineage (§7.8 item 2) and applies `project: (p) => p.session`. `ApiKeyPrincipal` has no `session` field (§2.2.15), so the handler receives `undefined` while its type says `AuthSession`. `s.user.id` throws a `TypeError` once per list item, which surfaces as a non-intrinsic 500 per field — or, in the defensive variant `s?.user?.id === r.ownerId`, silently answers `canEdit: false` for every row a legitimate key owner may in fact edit. `@CurrentUser()` (`project: (p) => p.session.user`) throws inside the projection itself.
  - §7.6 step 6's stated invariant, which is why the guard has no runtime kind check for param decorators, is simply false for `inherit` plans: the plan that owns the decorator and the plan that produced the reading are different plans with different `accepts`.
  - v5's NEST-r4-03 fix makes this strictly easier to reach: item 2 now takes the enclosing reading **whatever its instance**, so a field resolver shared between a default-instance query and a named instance's query can now also receive a kind only the other instance's sources produce.
- **Evidence:**
  - Design lines: §7.6 step 6 (the invariant), step 5 (accepts for a nested handler come from the instance's default kinds because class-level `@AcceptPrincipals` does not apply to nested handlers, §7.6 step 3), §7.8 item 2 and the `@CurrentSession()` bullet, §2.2.15 `ApiKeyPrincipal` (no `session` member), §2.2.3 `definePrincipalParam` (`project` is applied unconditionally).
  - §14.1 `T-reads-session` only exercises `@AcceptPrincipals` and `defaultRequirements` **on the same handler** ("a second boot, in which the kit adds `@AcceptPrincipals('session','api-key')` to that fixture, fails with B15 `PRINCIPAL_PARAM_CONFLICT`"), so no conformance case covers a nested reader under a wider entry point.
  - `exp2-path.mjs` and `exp3-global.ts` confirm the mechanical premise that a field resolver's guard/param factories run per item under the enclosing field's path, i.e. per enclosing reading.
- **Suggested fix:**
  - Make the kind constraint a **read-time** check for `inherit` plans, where boot cannot decide it: when the inherited reading is `authenticated` and its `principal.kind` is not the decorator's `kind`, throw `BetterAuthConfigurationError.atRequest(<the spec's `reason`>, …)` with the site and the hint `@CurrentPrincipal()`, exactly as `NO_AUTH_RESULT` does (§7.8 item 5) — never `undefined`. Core compares the decorator's `kind` (data) with `principal.kind` (data), so rule 5 of §3.2 still holds.
  - Fix §7.6 step 6's wording: the boot check covers plans that resolve; nested plans are covered at read time.
  - Add boot advice from the GraphQL units (`W_NESTED_PRINCIPAL_PARAM`): nested handlers carrying a kind-constrained param decorator while the instance has more than one kind in play, with the hint to use `@CurrentPrincipal()` or to declare the field resolver's own access.
  - Extend `T-stamp-per-plan` / `T-reads-session` with a nested reader under an entry point that admits a second kind, asserting the loud error rather than `undefined`.

### NEST-r5-04 (major): `FEDERATION_FIELD_GUARDS_REQUIRED` forces `fieldResolverEnhancers: ['guards']`, which makes **every** application global guard run once per field-resolver invocation, so a global `ThrottlerGuard` counts one hit per field per list item

- **Section:** §9.2 "Federation subgraphs need field guards" (`FEDERATION_FIELD_GUARDS_REQUIRED`, severity `federationCoverage`, default `'error'`); §2.2.12 `federationCoverage`, `fieldResolverCoverage`; §9.2 "Field-resolver coverage" (hint `fieldResolverEnhancers: ['guards', 'interceptors']`); §0.4 costs ("`fieldResolverEnhancers: ['guards']` in GraphQL federation subgraphs with field or reference resolvers"); §5.4 B22 (prints the app's global guards); §7.8 "Order matters, and it is visible" (which places `ThrottlerGuard` as an `AppModule` `APP_GUARD`); §17 Q36.
- **Failure scenario:** the canonical Nest setup plus a federation subgraph:

  ```ts
  @Module({
    imports: [
      ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
      GraphQLModule.forRoot({
        driver: ApolloFederationDriver,
        autoSchemaFile: { federation: 2 },
      }),
      BetterAuthModule.forRoot({
        auth,
        platforms: [expressPlatform()],
        transports: [apolloTransport()],
      }),
    ],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  })
  export class AppModule {}
  ```
  1. Boot fails with `FEDERATION_FIELD_GUARDS_REQUIRED` because the subgraph has field and reference resolvers.
  2. The operator follows the hint and sets `fieldResolverEnhancers: ['guards']`.
  3. Every global guard — not only `BetterAuthGuard` — is now attached to every field resolver. A single query returning 50 entities with 3 field resolvers each runs `ThrottlerGuard` 150+ times for one HTTP request, so a limit of 100/min is exhausted by one query and legitimate traffic gets 429 from the throttler, not from better-auth. The boot summary (B22) prints `global guards: ThrottlerGuard → BetterAuthGuard` without saying that the list now runs per field.
  4. The same multiplication hits any global guard that does I/O (a tenant-resolution guard, a feature-flag guard), and any global guard that assumes an HTTP context but tolerated GraphQL root fields only.

  The design chose the boot error deliberately (§17 Q36 option A), and the setting really is the only way a guard can reach `_entities`' entry points — but the library is the proximate cause of a configuration change with a side effect it neither names nor measures, and `'warn'`/`'off'` is offered for reachability reasons only, not for this one.

- **Evidence:**
  - `exp3-global.ts` (Nest 12.x, `@nestjs/graphql` 14.0.0, `@nestjs/apollo` 14, Apollo Server 5, `fieldResolverEnhancers: ['guards']`, one `APP_GUARD`, query `{ posts { id title } }` over a 3-item list):
    ```
    globalGuard run #1 for PostResolver.posts
    globalGuard run #2 for PostResolver.title
    globalGuard run #3 for PostResolver.title
    globalGuard run #4 for PostResolver.title
    TOTAL global guard runs: 4
    ```
  - `@nestjs/graphql` 14 `services/resolvers-explorer.service.js:98-135`: for a property resolver `contextOptions = this.fieldResolverEnhancersLookup`, and `externalContextCreator.create(..., contextOptions, 'graphql')`; `ExternalContextCreator`'s `GuardsContextCreator` is built with the container's `ApplicationConfig`, so `getGlobalMetadata()` contributes `ApplicationConfig.getGlobalGuards()` to every field resolver. The same file (`:127-133`, `canUseFastFieldResolver` at `:245-270`) shows that enabling guards also disables the fast field-resolver path for every field resolver in the app, so the cost is not limited to guarded fields.
  - Design lines: §9.2 "Federation subgraphs need field guards"; §9.2 "Field-resolver coverage" hint; §0.4 cost list; §5.4 B22.
- **Suggested fix:** keep the decision (Q36 option A); make the consequence visible and measurable, inside the GraphQL units.
  - When the GraphQL units require or recommend `'guards'`, their `advise()` prints a warning (`W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS`) that names the application's other global guards (the same list B22 already reads from `ApplicationConfig`) and states that each of them will now run once per field-resolver invocation, with the standard escapes: `@SkipThrottle()` on the resolver class, moving the guard from `APP_GUARD` to the controllers that need it, or `fieldResolverCoverage`/`federationCoverage: 'warn'` behind an authenticating router.
  - Say it in §0.4's cost line and in the federation section of the docs, not only "`fieldResolverEnhancers: ['guards']`".
  - Add a GraphQL job case with a counting `APP_GUARD` and a list-returning query that asserts the multiplication, so the number is a pinned fact rather than a surprise.

### NEST-r5-05 (minor): the guard flow's second `public` branch records "no identity" without the `!plan.nested` test the first branch has, so a nested `@Public()` field resolver in `'form'` origin mode still records, contradicting §7.8 and NEST-r4-03's rule

- **Section:** §7.1 guard flow, the two public branches (`if plan.access === 'public' && plan.originCheck !== 'form': … lineage && !plan.nested → record(...)` versus the later `if plan.access === 'public' → record(call, NO_IDENTITY); return true`); §7.8 "What the guard records" third bullet ("A nested public plan (a `@Public()` field resolver) records nothing, so the readers below it take the same reading whether or not field guards run"); §7.6 step 3 (class-level `@ForwardAuthCookies` applies to nested handlers) and step 8; §3.1 U10; ADR-64.
- **Failure scenario:** an instance with `cookies.forwardDirectCalls: true` (B28 warns but boots), or a resolver class carrying class-level `@ForwardAuthCookies()`, and `fieldResolverCoverage: 'warn'`:

  ```ts
  @Resolver(() => Profile)
  @ForwardAuthCookies()
  export class ProfileResolver {
    @Query(() => Profile) me() { … }                                  // required
    @Public() @ResolveField(() => Social) social() { … }              // nested, public, originCheck 'form'
  }
  @Resolver(() => Social)
  export class SocialResolver {
    @ResolveField(() => Boolean) viewerFollows(@CurrentPrincipal() p: AuthPrincipal | null) { … }
  }
  ```
  - `social`'s plan is `access: 'public'`, `nested: true`, `originCheck: 'form'` (step 8: forwarding is on, so the mode is `'form'` whatever the access).
  - The first public branch is skipped because `originCheck === 'form'`, so the flow falls through to the second one, which records "no identity" at `social`'s lineage position **without** checking `plan.nested`.
  - With `fieldResolverEnhancers: ['guards']`, `viewerFollows` inherits `social`'s "no identity" and reads `null`. Without field guards, no guard runs for `social`, nothing is recorded, and `viewerFollows` walks past it to `me`'s reading and sees the signed-in principal.
  - Same query, same schema, two identities, decided by a GraphQL module option — the divergence NEST-r4-03's fix and invariant T6 rule out, and §7.8's bullet 3 states as a flat rule with no exception for the form mode.

  The window is narrow (it needs forwarding plus a relaxed coverage severity), but the two branches of one flow disagree about the same rule, which is the kind of divergence that later edits amplify.

- **Evidence:** design lines in §7.1 (the two `public` branches of the guard flow), §7.8 "What the guard records" bullet 3, §7.6 step 3 ("Class-level `@UseAuthInstance`, `@SkipOriginCheck` and `@ForwardAuthCookies` still apply to nested handlers") and step 8 ("otherwise `'form'` when direct-call forwarding is on for the handler"), §3.1 U10 ("public without the form origin check: record no identity unless nested"), which also describes only the first branch. Code reading only; the rules as written produce both outcomes.
- **Suggested fix:**
  - Apply `!plan.nested` in the second public branch too: `if plan.access === 'public' → (!plan.nested && record(call, NO_IDENTITY)); return true`. Restate the rule once in §7.8 ("a nested public plan never records, whatever its origin-check mode") and let §7.1 and §3.1 U10 refer to it, so the two branches cannot drift again.
  - Add the `publicNested` fixture variant of `T-stamp-per-plan` with `cookies.forwardDirectCalls: true`, asserting the same reading under both `fieldResolverEnhancers` settings.

## Product questions

None. The two decisions this round's findings touch (§17 Q30 class-level metadata scope, §17 Q36 federation strictness) both stay as decided: NEST-r5-02 and NEST-r5-04 keep the decided option and ask only for advice, wording and a pinned conformance case, as the owner's standing decision requires.
