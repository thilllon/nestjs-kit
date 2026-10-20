# Round 4 review: NEST (NestJS correctness, packaging, SOLID)

Input: `design-v4.md`. Verdict: **reject**.

Experiments: `scratchpad/tmp-r4-review-NEST/`. The stacks are:

- `n11/`: Nest 11.1.17, @nestjs/graphql 13.2.4, @nestjs/apollo 13.2.4, @apollo/subgraph 2.11.2;
- `n12/`: Nest 12.0.1, @nestjs/graphql 14.0.0, @nestjs/apollo 14.0.0, @apollo/subgraph 2.14.x;
- both: @apollo/server 5.5.1, @as-integrations/express5, Node 24.14.1.

Each script lives at the top of that directory and was copied into `n11/` and `n12/` and run in both. Outputs are saved next to the scripts (`exp1-output.txt`, `exp1b-output.txt`, `exp2-output.txt`).

## Summary

Every round-3 finding of mine stops its original failure scenario in v4, and so do the two round-2 findings round 3 had marked unresolved.

- **Lineage (ADR-64)** removes the scheduling dependence and the cross-root reads by construction. It is the right replacement for v3's six reader paths, and it did not need patching.
- **`principalFor`** is now total and loud.
- **Lifecycle state** is per application, with a loud failure where re-preparing is impossible.
- **Policy references** resolve before planning.
- **Class-level resolver metadata** stops at operations.
- **Unsatisfiable default requirements** fail boot for the scenario I gave.
- The **hook-provider trigger** is now a closed list.
- The **canaries** replace the gateway heuristic.
- The **GraphQL driver** is checked at boot.
- **Named inputs** come from claims.

I found 2 majors and 3 minors, and no blocker.

- **Federation entry points are invisible to the design (major, NEST-r4-01).** The GraphQL units know two kinds of handlers: root resolvers and nested field resolvers. `@ResolveReference()` is neither. It writes only `'graphql:resolve_reference'`, and Nest gives it guards only with `fieldResolverEnhancers`.
  - exp1 (both majors): a global deny-all guard stops `{ user(id: "1") }`, while `{ _entities(representations: [...]) { ... on User { email secretNote } } }` returns the data and no guard runs.
  - B16 passes, because no claim covers the reference resolver.
  - With `['guards']`, every representation's guard run shares the **same** `info` object, so `call.invocation` is identical and the per-invocation decision memo (T7, Z6) reuses the first entity's decision for the others.
- **Recognizing the guard by brand breaks every guard override (major, NEST-r4-02).** v4's B16 finds `BetterAuthGuard` among `ApplicationConfig.getGlobalGuards()` by a `Symbol.for` brand on the instance. `overrideProvider(BetterAuthGuard).useValue(mock)`, which §5.7 documents, and `overrideAuthGuard(builder, impl)` put the unbranded object into that list (exp2, both majors). The boot then fails `ROUTE_UNGUARDED` for every declaring route, which contradicts `T-internal-error-generic` boot 2, `LIB-testing-stamp-mock-guard` and ADR-51. This breaks NEST-r1-08's fix again.
- Minors:
  - Inherit readings are keyed by the nested handler's **own** instance, and a nested `@Public()` changes what readers below it see depending on `fieldResolverEnhancers` (NEST-r4-03).
  - B15's kind intersection treats a policy without `requires.principals` as admitting any kind, but the evaluator denies it delegated principals, so NEST-r3-06's scenario comes back through a kind-less company policy (NEST-r4-04).
  - §14.8 still says the admin policy "decides from the principal alone" under `overridePrincipal`. Since BA-r3-02 it reads the stored user row, so a fixed test principal answers 401 `USER_NOT_FOUND` or 403 (NEST-r4-05).

**SOLID.** The kernel is still name-free, and every v4 addition is data an extension supplies:

- `lineage`;
- `capabilities.prepareAtInit`;
- `ClaimOptions.inputs`;
- the canaries, which live in the units that hold the literals;
- `PolicyResolver`, one responsibility, shared by three readers.

No mechanism added in v4 needs to be removed. One detail should be replaced rather than patched: the B16 brand check becomes an identity check against what the class token currently resolves to, with the brand only as the dual-copy fallback (NEST-r4-02). Both majors are fixed inside extension units or in one core rule, with no core branch on a transport, so OCP holds.

## Prior findings

### Round 3 (NEST-r3-*)

| Id         | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEST-r3-01 | resolved | `TransportCall.lineage` (carrier, position, `enclosing(args)`), readings recorded on the invocation and at the position, `peek` and the memo-key map removed (§7.8, ADR-64). In `{ me { id } reports { id canEdit } }`, `canEdit` walks `info.path.prev` to `reports`, whose guard completed before `canEdit` ran, so the answer no longer depends on settle order or on `fieldResolverEnhancers`. `T-stamp-per-plan` now expects what the rules produce, in both settle orders and both enhancer settings. Two edge cases remain: the instance used for the lookup, and nested `@Public()` (NEST-r4-03). |
| NEST-r3-02 | resolved | `principalFor` returns `PrincipalReading` (`'no-identity'`) and throws `PRINCIPAL_READ_BEFORE_GUARD`; B16 counts an app-registered `BetterAuthGuard` and interceptor; the order is documented and printed. The `AppModule` throttler now fails loudly, with three working registrations. How B16 recognizes the guard is a new problem (NEST-r4-02).                                                                                                                                                                                                                                                      |
| NEST-r3-03 | resolved | Lifecycle state per application, keyed with the adapter and reset at shutdown. Fastify re-prepares at `onModuleInit` (`capabilities.prepareAtInit`), and Express fails `APP_ADAPTER_CHANGED`. I re-checked the ordering: the core module is global, so its `onModuleInit` runs before `GraphQLModule`'s, and the root `onRequest` hook is in place before Apollo's child context exists. The hybrid `deferInitialization` order is documented (RK30).                                                                                                                                                     |
| NEST-r3-04 | resolved | `PolicyResolver` (U19) is shared by the planner, the evaluator and B14; B14 resolves before plans compile; `Z-class-policy-requires` covers class and token refs.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| NEST-r3-05 | resolved | Option A (§17 Q30): a `defaultAccessFor` answer of `'inherit'` makes class-level access, acceptance and requirements not apply. The v3 scenario boots and resolves under both enhancer settings (GraphQL job). The federation reference resolver is a different handler kind that this classification does not cover (NEST-r4-01).                                                                                                                                                                                                                                                                        |
| NEST-r3-06 | resolved | `UNSATISFIABLE_PRINCIPAL_KINDS` and `@SkipDefaultRequirements()`. My `orgMember()` + `@RequireApiKeyPermission` scenario fails boot with both origins named. A kind-less policy slips past the intersection (NEST-r4-04).                                                                                                                                                                                                                                                                                                                                                                                 |
| NEST-r3-07 | resolved | Closed trigger list; hook, db-hook, `@SkipOriginCheck()`, `@SkipDefaultRequirements()` and `@Public()` never count; a hook-provider case is in `LIB-coverage-rule`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| NEST-r3-08 | resolved | Boot canaries apply the real decorators to a private probe class. None of the canaried decorators (`@Get`, `@WebSocketGateway`, `@SubscribeMessage`, `@MessagePattern`, `@UseGuards`, `@UseInterceptors`) writes to a global registry, so a probe class has no side effect. GraphQL keys are imported, so they need no canary. Push-only gateways boot.                                                                                                                                                                                                                                                   |
| NEST-r3-09 | resolved | `handles()` is `getType() === 'graphql'`, and `validate()` checks the driver class chain (`GRAPHQL_DRIVER_MISMATCH`, unknown drivers pass).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| NEST-r3-10 | resolved | `routeParams` removed; `ClaimOptions.inputs` (HTTP `:params`, GraphQL `@Args` names from the exported `PARAM_ARGS_METADATA`); `AdvisedHandler.inputs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Earlier findings marked unresolved

| Id         | Status   | Note                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEST-r2-06 | resolved | Through NEST-r3-01's lineage: a reader takes its own ancestor's reading, whatever sibling selections, settle order or enhancer setting.                                                                                                                                                                                                                                                                                                            |
| NEST-r2-07 | resolved | Through NEST-r3-02: guards and interceptors read with `principalFor`, which never answers `undefined`. Running a reader before `BetterAuthGuard` is a loud request-time error, the order is printed, and the three documented registrations work. On Nest 12 a global guard reaches gateways (LEAD-V6), and the forRoot `APP_GUARD` runs ahead of a feature module's (global guards precede class guards, `core/helpers/context-creator.js:3-12`). |

No NEST-r1 finding was marked unresolved. One earlier fix is broken again: NEST-r1-08. Its guarantee was that `overrideAuthGuard` works wherever the guard applies and still passes B16, and v4's brand check breaks that. Reported as NEST-r4-02.

## New findings

### NEST-r4-01 (major): `@ResolveReference()` handlers of a federation subgraph are neither claimed nor classified, so `_entities` serves entities with no guard and B16 passes; with field guards, every representation shares one `info`, so per-invocation decisions leak across entities

- **Section:**
  - §9.2 "Field resolvers are nested and inherit" ("runs only inside an operation whose root field the guard already authorized") and "Field-resolver coverage" (claims: root resolver methods by `RESOLVER_TYPE_METADATA`, field resolvers by `RESOLVER_PROPERTY_METADATA`);
  - §9.2 "Selection and the driver" (federation drivers are accepted);
  - §9.0 Apollo row (`invocation` = `info`);
  - §4.2.2 T7, T10;
  - §5.4 B16;
  - §7.2 decision memo;
  - ADR-40, ADR-56, ADR-66.
- **Failure scenario:** A subgraph with `GraphQLModule.forRoot({ driver: ApolloFederationDriver, autoSchemaFile: { federation: 2 } })` and `BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()], transports: [apolloTransport()] })`:
  ```ts
  @Resolver(() => User)
  @RequirePermission({ user: ['get'] })                       // or nothing: defaultAccess 'authenticated'
  export class UserResolver {
    @Query(() => User) user(@Args('id') id: string) { … }
    @ResolveReference() resolveReference(ref: { __typename: 'User'; id: string }) { return this.users.findById(ref.id); }
    @ResolveField(() => String) secretNote(@Parent() u: User, @CurrentPrincipal() p: AuthPrincipal | null) { … }
  }
  ```
  1. **Default `fieldResolverEnhancers` (`[]`).** An anonymous `{ user(id: "1") { email } }` is denied. An anonymous `{ _entities(representations: [{ __typename: "User", id: "1" }]) { ... on User { email secretNote } } }` returns the entity:
     - no guard runs for `resolveReference` or `secretNote`;
     - `resolveReference` carries neither `RESOLVER_PROPERTY_METADATA` (so `defaultAccessFor` does not mark it nested) nor a method-level `RESOLVER_TYPE_METADATA` (so it is not claimed as a root resolver);
     - its plan is `required`, but nothing reaches it, and B16 has no claim to report. `UNGUARDED_AUTH_METADATA` fires only for method-level metadata, and then with a misleading "a transport is missing" hint;
     - `secretNote` is `inherit` and covered by definition. Its `@CurrentPrincipal()` finds no reading at `_entities` and throws `NO_AUTH_RESULT` (500), while the data it was meant to protect is served without it.

     This is the "surface the guard cannot reach fails boot" promise of ADR-40, broken for a GraphQL entry point, the same class as NEST-r1-06. The design also says the Apollo unit accepts federation drivers.

  2. **`fieldResolverEnhancers: ['guards']`.** The guard runs once per representation, but every run receives the `_entities` field's `info` object, so `call.invocation` is the same for all of them:
     - decisions are memoized per `(invocation, requirement)`, so a per-entity DI policy that allowed `{ id: "mine" }` is reused for `{ id: "theirs" }` in the same `_entities` call (T7, Z6);
     - `param(name)` reads the resolver args, which reference resolvers do not have (Nest inserts `undefined`), so a class-level `fromParam('orgId')` ref denies every entity 403 `ORGANIZATION_REQUIRED`;
     - an `enclosing(args)` that reads `args[3]` finds nothing, because the raw call has 3 arguments.
- **Evidence:**
  - exp1-federation-reference.mjs, identical on 11.1.17/13.2.4 and 12.0.1/14.0.0:
    - `metadata … resolveReference {"type":null,"property":null,"reference":true}`;
    - `query user -> {"user":null} no credentials`;
    - `query _entities -> {"_entities":[{"id":"1","email":"alice@example.com","secretNote":"secret of 1"}]}`, with only `guard UserResolver.user path=user` logged;
    - with `guards`: `guard UserResolver.resolveReference path=_entities args.length=3 shape=[reference, context{req}, info]`.
  - exp1b (`guards allow`, two representations): `reference-resolver guard runs: 2 same info object: true same context: true distinct reference objects: true`; nested paths `_entities.0.secretNote`, `_entities.1.secretNote`.
  - `@nestjs/graphql` 13.2.4:
    - `decorators/resolve-reference.decorator.js:11-15` writes only `RESOLVER_REFERENCE_METADATA`;
    - `utils/extract-metadata.util.js:7-22` takes the type from the class;
    - `services/resolvers-explorer.service.js:88-104` treats every non-root type as a property resolver, with enhancers only from `fieldResolverEnhancers`;
    - `utils/normalize-resolver-args.js` shows that a reference resolver has 3 raw args.
  - `@apollo/subgraph` `dist/types.js:101-102`: `resolveReference(reference, context, info)` receives `_entities`' `info`.
  - `RESOLVER_REFERENCE_METADATA` is exported from the root of @nestjs/graphql 13 and 14 (`graphql.constants.d.ts`).
  - Design lines 3437, 3463, 3470, 1873-1874, 2441, 2880.
- **Suggested fix:** Everything below stays inside the GraphQL units; core is unchanged.
  - Treat `RESOLVER_REFERENCE_METADATA` methods as **entry points**: `defaultAccessFor` never answers `'inherit'` for them, and class-level metadata and `defaultAccess` apply.
  - Claim them `'global'` when `fieldResolverEnhancers` includes `'guards'` and `'none'` otherwise, with `everyHandler: true`, code `REFERENCE_RESOLVER_UNGUARDED`, a hint (`fieldResolverEnhancers: ['guards', 'interceptors']`, or `@Public()` on the reference resolver) and a severity option (user decision 1).
  - For a reference resolver, `describe()` uses the representation object (raw `args[0]`) as `invocation` and reads `param(name)` from it. The lineage position stays `'<op>:_entities'` (one principal per request). Read raw arguments with Nest's own normalization rule (3 raw args means a reference resolver).
  - With a federation driver, a `@key` type that has field resolvers and **no** reference resolver is served by `_entities` with no Nest handler at all. Report it at boot (`FEDERATION_ENTITY_UNGUARDED`, hint: add a guarded `@ResolveReference()`). `W_FIELD_RESOLVER_INHERITS` counts a `@Public()` reference resolver as a public root.
  - Add `T-reference-resolver` (Apollo federation, Mercurius federation marked UNVERIFIED): anonymous `_entities` is denied, or boot fails without guards; two representations get independent decisions; readers under `_entities.N` see the reference resolver's reading. Add a GraphQL job case with the subgraph above.

### NEST-r4-02 (major): B16 recognizes `BetterAuthGuard` and `BetterAuthScopeInterceptor` among the global enhancers only by a brand on the instance, so `overrideProvider(BetterAuthGuard).useValue(…)` and `overrideAuthGuard(builder, impl)` fail boot with `ROUTE_UNGUARDED` (NEST-r1-08 broken again)

- **Section:** §5.4 B16 ("recognized by their `Symbol.for` brand"); §2.3 `enhancer` brand; §12.5 item 5; §5.7 "Guard registration and overriding" (`overrideProvider(BetterAuthGuard)` replaces what `APP_GUARD` aliases); §2.2.16 and §14.8 `overrideAuthGuard` ("With a CanActivate, that guard runs"); §14.1 `T-internal-error-generic` boot 2 (`overrideAuthGuard(b, passThrough)`, "B16 sees every handler covered"); `LIB-testing-stamp-mock-guard` (HTTP controller, `globalGuard: true`, `overrideAuthGuard(builder, new MockGuard())`); ADR-51, ADR-57.
- **Failure scenario:**
  - A consumer test in the standard Nest form:
    ```ts
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BetterAuthGuard)
      .useValue({ canActivate: () => true }) // §5.7 names this as what replaces the APP_GUARD alias
      .compile();
    await moduleRef.createNestApplication().init();
    ```
    `APP_GUARD` is `useExisting: BetterAuthGuard`, so the global guard list holds the plain mock object. B16 looks for the `enhancer` brand, finds no `BetterAuthGuard`, and reports every `'global'` claim that declares something as uncovered, at severity `'error'`: HTTP routes with `@RequirePermission` or `@CurrentSession()`, such GraphQL root fields, and such standalone RPC handlers. `init()` throws `ROUTE_UNGUARDED` with the hint "Register the global guard (globalGuard: true)", although `globalGuard` is true.
  - The same happens through the library's own helper. `overrideAuthGuard(builder, new MockGuard())` "calls both `overrideProvider(BetterAuthGuard)` … and `overrideGuard`", and does the same for the interceptor, so the kit's boot 2 of `T-internal-error-generic` (every transport, third parties included) and `LIB-testing-stamp-mock-guard` cannot boot as specified. Nothing says that the `{ principal }` stand-in is branded either.
  - v3 counted a `forRoot` with `globalGuard: true`, and those boots passed.
- **Evidence:**
  - exp2-override-global-guard.mjs, identical on 11.1.17 and 12.0.1 under `@nestjs/testing`, read at `onModuleInit` from `ApplicationConfig.getGlobalGuards()`:
    - no override: `global guards=1, branded=1, identical to moduleRef.get(LibGuard)=1, entry is mock=false`;
    - `overrideProvider(LibGuard).useValue(mock)`: `branded=0, identical to moduleRef.get(LibGuard)=1, entry is mock=true`;
    - `overrideGuard(LibGuard).useValue(mock)`: `branded=1` (the global alias is untouched).
  - Design lines 2441, 1216, 4170, 2558, 1178-1185, 4402-4404, 4553, 4778, 4783.
- **Suggested fix:**
  - Recognize a global enhancer as `BetterAuthGuard` when it is `===` to `moduleRef.get(BetterAuthGuard, { strict: false })`, the instance the class token currently resolves to, overrides included. Do the same for the interceptor. Keep the brand only as the fallback for an enhancer registered from the other package copy.
  - State that `overrideAuthGuard`'s stand-ins carry the brand and that an `impl` passed to it is wrapped in a branded delegating guard.
  - Add `LIB-coverage-rule` cases for `overrideProvider(BetterAuthGuard).useValue(mock)` and `.useClass(Mock)`, which must boot clean, and for a composite user guard that delegates to `BetterAuthGuard` without being it, which must still fail under `globalGuard: false`.

### NEST-r4-03 (minor): The inherit lookup keys readings by the nested handler's own instance and by whether a nested `@Public()` guard ran, so a field resolver shared by two instances' operations throws `NO_AUTH_RESULT`, and readers under a `@Public()` field resolver see different principals depending on `fieldResolverEnhancers`

- **Section:** §7.6 step 3 ("Class-level `@UseAuthInstance` … still apply to nested handlers"); §7.8 "What the guard records" (per instance; "for a public plan: 'no identity' at its lineage position") and lookup item 2; §7.1 public path; T6 ("whatever … in whatever order … nor on `fieldResolverEnhancers`"); ADR-64.
- **Failure scenario:**
  1. **Two instances** (§5.5): `@UseAuthInstance('admin') @Resolver() class AdminQueries { @Query(() => [User]) users() }`, and a shared `@Resolver(() => User) class UserFields { @ResolveField() canManage(@Parent() u: User, @CurrentPrincipal() p: AuthPrincipal | null) }` that the default instance's `me` query also reaches.
     - `canManage`'s plan instance is `'default'` (its own class), and its reader looks for a `'default'` reading.
     - Under `users` the guard recorded only an `'admin'` reading, so every item throws `NO_AUTH_RESULT` (500).
     - Annotating `UserFields` with `'admin'` breaks `me` instead.
  2. **A nested `@Public()`:** `@Public() @ResolveField(() => Profile) publicProfile()` and, under it, an inheriting `Profile.viewerFollows(@CurrentPrincipal() p)`.
     - With `['guards']`, the public field's guard records "no identity" at its position, and `viewerFollows` reads `null`.
     - With `[]`, no guard runs and nothing is recorded, so the walk continues to the root and `viewerFollows` reads the root's principal.
     - The same query gives different identities depending on a GraphQL module option, which is what T6 rules out.
- **Evidence:** Design lines 3050, 3116-3127 (readings "for the handler plan's instance"), 3122, 2838-2841, 1873. Code reading only; the §7.8 rules produce both outcomes as written.
- **Suggested fix:**
  - For `inherit` plans, take the nearest enclosing reading **whatever its instance**, and report that instance in `PrincipalReading.instance`. A nested handler's `@UseAuthInstance` then matters only for nested handlers with real plans.
  - Record "no identity" only for public plans of non-nested handlers, so that readers below a nested `@Public()` inherit through it under both enhancer settings; alternatively, have nested public plans record nothing.
  - Add a two-instance variant and a nested-`@Public()` variant to `T-stamp-per-plan`.

### NEST-r4-04 (minor): `UNSATISFIABLE_PRINCIPAL_KINDS` counts a policy without `requires.principals` as admitting every kind, but the evaluator admits only non-delegated principals to it, so a kind-less company-wide policy makes every API-key route unsatisfiable while boot passes

- **Section:** §5.4 B15 last bullet ("the requirement's `principals`, else its resolved policy's `requires.principals`, else any kind"); §8.1 principal-kind and delegation gate; §4.4.1 `requires.principals` ("Omitted: any kind WITHOUT `delegation`"); §4.4.4 ("No requires.principals: judges any non-delegated principal"); §2.2.1 `defaultRequirements`; ADR-58; §15.1 step 14.
- **Failure scenario:** A company rule written the way §4.4.4 recommends: `defaultRequirements: [tenantActive()]`, where `tenantActive = definePolicy({ id: 'acme:tenant-active', evaluate })` has no `requires.principals`, together with `@RequireApiKeyPermission({ reports: ['read'] }) @Get('feed')`.
  - B15 intersects "any kind" with `{'api-key'}` and gets `{'api-key'}`, so boot passes.
  - An API-key request is denied 403 `PRINCIPAL_NOT_SUPPORTED` by `tenantActive`'s gate, because an `ApiKeyPrincipal` always carries `delegation`.
  - A session request is denied by `apiKeyPermission`.
  - The route can never succeed. That is NEST-r3-06's outcome, which B15 was added to catch and which the migration guide says boot reports ("boot names every route the defaults would make unsatisfiable").
- **Evidence:** Design lines 2440, 3249-3251, 2173, 2263, 1117 (`ApiKeyPrincipal.delegation` is not optional), 4828.
- **Suggested fix:**
  - Make delegation static data: `PrincipalSource.delegates?: boolean` (true for `apiKeyPrincipal()` and the §4.3.4 OAuth source), checked against the runtime `delegation` field by `S-delegation`.
  - In B15, a requirement whose policy names no kinds admits exactly the instance's kinds whose sources do not delegate.
  - Add a `T-unsatisfiable-kinds` variant with a kind-less default policy.

### NEST-r4-05 (minor): §14.8 still says the admin policy "decides from the principal alone" under `overridePrincipal`, but since v4 it reads the stored user row, so a fixed test principal on `@RequirePermission` answers 401 `USER_NOT_FOUND` or 403 instead of reaching the handler

- **Section:** §14.8 "Policies under `overridePrincipal`"; §2.2.16 `overridePrincipal` doc; `LIB-testing-override-decisions` ("a `decide` that returns `undefined` runs the real admin policy"); §8.3 admin row (BA-r3-02, "for every principal"); ADR-51.
- **Failure scenario:** A consumer following §14.8:

  ```ts
  overridePrincipal(Test.createTestingModule({ imports: [AppModule] }),
    { kind: 'session', source: 'test', userId: 'u1', session: { user: { id: 'u1', role: 'admin' }, session: … } })
  ```

  and a request to `@RequirePermission({ user: ['list'] })`:
  - the resolver answers the fixed principal;
  - the admin policy then calls `internalAdapter.findUserById('u1')`. On the test database there is no such row, so the route answers 401 `USER_NOT_FOUND`; with a seeded user whose stored role is `user`, it answers 403 `MISSING_PERMISSION`, whatever the fixed session says.

  The doc promises that this policy "work[s] unchanged", and the override-decisions case does not say which of these outcomes it expects.

- **Evidence:** Design lines 4779 (the admin policy listed among policies that decide from the principal alone), 3297 (the stored-row read for every principal), 1159-1165, 4784.
- **Suggested fix:**
  - Move the admin policy to the "needs real data" list next to the organization policies in §2.2.16 and §14.8: seed the user with `testUtils()`, or stub with `overrideDecisions`.
  - Pin the admin outcome in `LIB-testing-override-decisions`: a fixed principal without a stored row gives 401 `USER_NOT_FOUND`, never 5xx.

## Proposed user decisions

1. **How strict should boot be about federation entry points (`@ResolveReference()`, and `_entities` for `@key` types)?** (NEST-r4-01)
   - Option A: Treat them like other surfaces the guard cannot reach (ADR-40). Boot fails without `fieldResolverEnhancers: ['guards']` or `@Public()`, with a `referenceResolverCoverage: 'error' | 'warn' | 'off'` option on the GraphQL units.
   - Option B: Warn by default (`W_REFERENCE_RESOLVER_UNGUARDED`), because most subgraphs sit behind a router that authenticates and are not reachable directly, and let teams opt into `'error'`.
   - Recommendation: A. It matches §17 Q19's fail-closed stance for gateways, hybrid RPC and field resolvers, and a subgraph's reachability is a deployment fact the library cannot see. Teams with private subgraphs set `'warn'` once, visibly.
