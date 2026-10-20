# Round 3 review: NEST (NestJS correctness, packaging, SOLID)

Input: `design-v3.md`. Verdict: **reject**.

Experiments: `scratchpad/tmp-r3-review-NEST/` (Nest 11.1.17 with @nestjs/graphql 13.2.4 + @nestjs/apollo 13.2.4; Nest 12.0.1 with @nestjs/graphql 14.0.0 + @nestjs/apollo 14.0.0; @apollo/server 5.5.1; Node 24.14.1). Each script lives at the top of that directory and was copied into `n11/` and `n12/` and run in both. Outputs of exp2 and exp3 are saved next to the scripts (`exp2-output.txt`, `exp3-output.txt`).

## Summary

Most round-2 fixes hold. The plan cache per (class, handler), public-first guard order, the core coverage rule, `inherit` for undecorated field resolvers, idempotent lifecycle, `LATE_HTTP_ADAPTER`, DB-write counting, guard-plus-interceptor coverage, the pinned message-mapping key, the removed scheme list, the removed decorator `instance` option, `overrideDecisions` and the content-keyed source set all stop their original failure scenarios. I re-checked each against v3.

Two fixes do not fully stop their original scenarios, and four mechanisms added in v3 bring new failures. I found 6 majors and 4 minors and no blocker.

- **Inheriting field resolvers read an arbitrary sibling's result (major, NEST-r3-01; NEST-r2-06 unresolved).** The "exactly one carrier entry" rule and the interceptor's `peek()` under the inherit plan's default memo key are not tied to the root field that reached the field resolver. exp2 shows on both majors that, in one operation, the reader under whichever root field settles first succeeds and the other throws `NO_AUTH_RESULT`, and swapping the resolution delays swaps them. With `fieldResolverEnhancers: ['guards', 'interceptors']`, which is the kit's own configuration, a reader under an API-key-accepting root field returns the sibling root field's **session** principal. `T-stamp-per-plan`'s expected result is not what the design's lookup order produces.
- **`principalFor()` is `undefined` in app-wide guards (major, NEST-r3-02; NEST-r2-07 unresolved).** An `APP_GUARD` declared in `AppModule`, where Nest documents `ThrottlerGuard`, runs **before** the `APP_GUARD` that `BetterAuthModule.forRoot()` contributes (exp1, both majors and both bootstraps). `undefined` also means "public". The natural workaround (`globalGuard: false` plus ordered `APP_GUARD`s in `AppModule`) fails B16.
- **A reused compiled `TestingModule` silently loses auth (major, NEST-r3-03).** Lifecycle state lives on a container singleton, and `init$` completes after its first emission. A second `createNestApplication()` from one `TestingModule` therefore skips binding and mounting. Auth routes answer 404, Nest hooks are unbound, and every authoritative route answers 401 (exp3).
- **The planner cannot read `requires` of DI policies (major, NEST-r3-04).** Accepted kinds and freshness come from `policy.requires`, but a class or token reference is only resolved by the evaluator and B14. `freshIdentity` on a DI policy is silently dropped, so a key-mocked session reaches it, the BA-r2-06 bypass. Kinds the policy names are not admitted either.
- **Class-level metadata on resolver classes (major, NEST-r3-05).** It gives every field resolver of the class a real plan. That fails boot by default. Following the hint makes class-level `fromParam(...)` requirements deny every field (403 per list item), and there is no explicit "inherit" opt-out.
- **`defaultRequirements` can make routes unsatisfiable (major, NEST-r3-06).** A company-wide `orgMember()` ANDs into every API-key route, so each one answers 403 `PRINCIPAL_NOT_SUPPORTED`. There is no per-route opt-out that B15 allows, and no boot check.
- Minors:
  - B16's `UNGUARDED_AUTH_METADATA` wording catches hook providers (NEST-r3-07).
  - Push-only gateways trip the class-claim heuristic (NEST-r3-08).
  - Apollo's `handles()` rejects contexts that expose `reply` (NEST-r3-09).
  - `RoutePlan.routeParams` is HTTP-only data compiled by core (NEST-r3-10).

On SOLID: the kernel stays name-free, and the claims model is a sound OCP shape. The weak spot is principal _reading_. v3 now has six lookup paths: the scope, `peek` under the plan key, the invocation stamp, the carrier map with its exactly-one rule, the test stamp, and `principalFor`. They answer differently for the same invocation. NEST-r3-01 recommends **removing** the carrier memo-key map, the exactly-one rule and the inherit-plan `peek`, and replacing them with one ancestor-path lookup, rather than patching them.

## Prior findings

### Round 2 (NEST-r2-*)

| Id         | Status         | Note                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEST-r2-01 | resolved       | `WeakMap<Type, WeakMap<Function, RoutePlan>>` (§7.6 step 0), boot scan by (class, method), and `T-inherited-handler`. Decorators and `principalFor` read by (`getClass()`, `getHandler()`).                                                                                                                                                                                                        |
| NEST-r2-02 | resolved       | Coverage is one core rule over transport claims. All three original cases fail boot: (a) `UNGUARDED_AUTH_METADATA`, (b) `UNGUARDED_AUTH_METADATA`, (c) `ROUTE_UNGUARDED`. The trigger's wording is too broad (NEST-r3-07).                                                                                                                                                                         |
| NEST-r2-03 | resolved       | The plan comes first, and `public`/`inherit` plans return before selection. RPC handles every `'rpc'` context. Undecorated handlers in unclaimed contexts that the global guard reaches (Nest 12 gateways without a WS transport, `'rmq'` consumers) still answer 500 `NO_TRANSPORT` at runtime while boot passes. That is fail-closed by design, and the docs should say so for Nest 12 upgrades. |
| NEST-r2-04 | resolved       | Undecorated field resolvers inherit (`defaultAccessFor`). Class-level metadata still forces real plans, which is a new problem (NEST-r3-05).                                                                                                                                                                                                                                                       |
| NEST-r2-05 | resolved       | Lifecycle state on `InstanceRegistry`, and same-owner `bind()` is a no-op. The state is per container, not per application, which is a new problem (NEST-r3-03).                                                                                                                                                                                                                                   |
| NEST-r2-06 | **unresolved** | The kind escalation under a session-only root field is fixed. The original scenario also had readers failing on an allowed request depending on promise scheduling ("tests are flaky rather than red"), and that persists. With `'interceptors'`, a new cross-root read appears. See NEST-r3-01 (exp2).                                                                                            |
| NEST-r2-07 | **unresolved** | Resolved for controller-level and method-level guards. The original scenario's `ThrottlerGuard` subclass is registered as `APP_GUARD` in `AppModule` per Nest's docs. It runs before `BetterAuthGuard`, so `principalFor()` is `undefined` and every user shares the IP bucket. See NEST-r3-02 (exp1).                                                                                             |
| NEST-r2-08 | resolved       | `planFor` is gone, and `defaultRequirements` is compiled into every plan. How it composes with other requirements is a new problem (NEST-r3-06).                                                                                                                                                                                                                                                   |
| NEST-r2-09 | resolved       | `httpAdapter ?? null` at `onModuleInit`, plus `LATE_HTTP_ADAPTER` and `H-late-adapter`.                                                                                                                                                                                                                                                                                                            |
| NEST-r2-10 | resolved       | The DB dispatchers count writes while unbound, and the B26 wording is updated.                                                                                                                                                                                                                                                                                                                     |
| NEST-r2-11 | resolved       | `'explicit'` claims need `@UseBetterAuth()`, or guard and interceptor, and `'__interceptors__'` is pinned.                                                                                                                                                                                                                                                                                         |
| NEST-r2-12 | resolved       | The key is pinned, and a gateway with no discovered handlers is claimed at class level. The heuristic misfires for push-only gateways (NEST-r3-08).                                                                                                                                                                                                                                                |
| NEST-r2-13 | resolved       | The exemption is removed, and core holds no scheme list.                                                                                                                                                                                                                                                                                                                                           |
| NEST-r2-14 | resolved       | The decorators take no `instance` option and read the plan's instance.                                                                                                                                                                                                                                                                                                                             |
| NEST-r2-15 | resolved       | `POLICY_INVOKER` and `overrideDecisions` exist, and org policies under `overridePrincipal` deny 401, never 5xx.                                                                                                                                                                                                                                                                                    |
| NEST-r2-16 | resolved       | `RoutePlan.sourceSet` is a content key, with `triple`/`tripleMixed` fixtures.                                                                                                                                                                                                                                                                                                                      |

### Round 1

No NEST-r1 finding was marked unresolved in round 2. None was broken again by v3. NEST-r1-01 (per-invocation decisions), NEST-r1-03 (the last-arrival coordinator) and NEST-r1-08 (test stamps) still hold.

## New findings

### NEST-r3-01 (major): Inheriting field resolvers read whichever root field's result a request-wide lookup finds first, not their own root field's, so the answer depends on sibling selections, on `fieldResolverEnhancers` and on promise scheduling

- **Section:** §7.8 items 1–2 (scope filled by `peek()` "under the plan's memo key", then "a single carrier entry"); §7.5 step 2; §7.6 steps 5 and 7 (an `inherit` plan has the default kinds and default freshness, so its memo key is the default key); §9.2 "Stamps"; §14.1 `T-stamp-per-plan`; ADR-30, ADR-37.
- **Failure scenario:**

  ```ts
  @Resolver() class DashboardResolver {
    @Query(() => User) me(@CurrentSession() s: AuthSession) { … }                        // default kinds
    @AcceptPrincipals('session', 'api-key') @Query(() => [Report]) reports() { … }      // mixed
  }
  @Resolver(() => Report) class ReportResolver {
    @ResolveField() canEdit(@Parent() r: Report, @CurrentPrincipal() p: AuthPrincipal | null) { return r.ownerId === p?.userId; } // inherit
  }
  ```

  A client sends `{ me { id } reports { id canEdit } }` with a session cookie (user Y) and an `x-api-key` owned by user X.
  - **`fieldResolverEnhancers` unset (Nest's default):** `canEdit` reads the carrier. If `me`'s cookie-cache read settled before `reports`' key verification, there are two entries, so it throws `NO_AUTH_RESULT` (500) on every item. If it settled after, there is one entry and it reads X. The same query succeeds or fails depending on storage latency.
  - **`['guards', 'interceptors']`** (what the kit and B16's hint use): the scope interceptor fills the scope from `peek()` under the inherit plan's memo key, which is the default-kind key of `me`. `canEdit` under `reports` therefore judges ownership as **Y** while `reports` authorized X. Remove `me` from the query and the same field sees X.
  - **An authoritative sibling:** `{ adminStats { … } me { posts { canEdit } } }` (`@RequirePermission` on `adminStats`) makes `canEdit` throw or succeed depending on which guard settled first.

  The design says a reader "takes an entry only when the instance has exactly one", but the map is still being filled by concurrently running root guards when children execute. `T-stamp-per-plan` expects "`reader` under either one throws `NO_AUTH_RESULT`". Under the design's own rules the first-settled root field's reader succeeds, and with `'interceptors'` neither throws.

- **Evidence:** exp2-inherit-reader.mjs models §7.8 literally: guard stamps `Map<memoKey, result>` on the GraphQL context, and the interceptor fills from `peek` under the plan key, else a single carrier entry. Output is identical on 11.1.17/13.2.4 and 12.0.1/14.0.0:
  - `['guards']`, session root 5 ms, mixed root 30 ms: `sessionOnly: carrier(1) -> session:Y`, `mixed: NO_AUTH_RESULT (carrier entries: 2)`. With the delays swapped: `sessionOnly: NO_AUTH_RESULT (2)`, `mixed: carrier(1) -> api-key:X`.
  - `['guards','interceptors']`, 5/30 ms: `mixed: scope -> session:Y(cookie)`. With 30/5 ms: `mixed: scope -> api-key:X`. With only `mixed` selected: `api-key:X`.

  Design lines 2913, 2916, 2804, 2857-2861, 3207, 4288.

- **Suggested fix:** Remove the memo-key carrier map, the exactly-one rule and the inherit-plan `peek`, and use one ancestor lookup instead:
  - Every guard run that resolves (root fields and field resolvers with real plans) stamps its result on the operation carrier under its **response path**. The key is `info.path` serialized, list indexes included, qualified by `info.operation` for batched documents.
  - An `inherit` reader (decorators, the interceptor's scope fill, `principalFor`) walks `info.path.prev` to the nearest ancestor with a stamp and takes exactly that entry. Ancestors always complete before descendants run, so the result is deterministic.
  - A `public` root field stamps an explicit "no identity" entry, so readers under it get `null` from `@CurrentPrincipal()`, or `NO_AUTH_RESULT` for kind-constrained params, independent of siblings.
  - Rewrite `T-stamp-per-plan`: every reader returns its own ancestor's principal in both orders and with both enhancer settings, and a reader under `public` behaves the same with and without a guarded sibling. Add a delay-swapped variant.

### NEST-r3-02 (major): `principalFor(ctx)` returns `undefined` in any `APP_GUARD` declared in `AppModule`, because those run before the forRoot module's `APP_GUARD`; `undefined` also means "public", and the workaround of ordering both guards in `AppModule` fails B16

- **Section:** §2.2.2 `principalFor`; §7.8 "Guards and interceptors" and the `SubscriptionActiveGuard` recipe ("BetterAuthGuard (global or @UseBetterAuth()) ran first"); §15.1 step 13; §15.2 `request.user` row; §5.4 B16 (a `'global'` claim is covered when "some `forRoot` registers the global guard"); `LIB-principal-for`; ADR-57.
- **Failure scenario:**

  ```ts
  @Module({
    imports: [
      BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] }),
    ],
    providers: [
      { provide: APP_GUARD, useClass: UserThrottlerGuard }, // Nest docs: ThrottlerGuard as APP_GUARD in AppModule
      { provide: APP_GUARD, useClass: SubscriptionActiveGuard },
    ],
  }) // §7.8 recipe, registered app-wide
  export class AppModule {}
  ```

  Nest applies `AppModule`'s own `APP_GUARD`s before the one the imported forRoot module contributes.
  - `UserThrottlerGuard` keys by `principalFor(ctx)?.principal.userId ?? ip`. It always gets `undefined`, so every user of an office NAT shares one bucket, which is exactly NEST-r2-07's scenario.
  - `SubscriptionActiveGuard` returns `false` for every request, so Nest throws `ForbiddenException` on public routes too.
  - Neither guard can tell "BetterAuthGuard has not run yet" from "public plan", because both are `undefined`.
  - The workaround, `globalGuard: false` with `{ provide: APP_GUARD, useExisting: BetterAuthGuard }` listed first in `AppModule`, runs correctly but fails boot: B16 counts a `'global'` claim as covered only when a `forRoot` registers the guard, and the scope interceptor is gone too.

  The design's only tested position is a controller-level guard (`LIB-principal-for`).

- **Evidence:**
  - exp1-app-guard-order.mjs, identical on 11.1.17 and 12.0.1 under `NestFactory` and `@nestjs/testing`: `order: ["UserGuard(AppModule APP_GUARD)", "LibGuard(BetterAuthGuard stand-in)", "FeatureGuard(feature module imported AFTER forRoot)"]`.
  - exp1b-global-guards-visible.mjs: at `onModuleInit`, an injected `ApplicationConfig.getGlobalGuards()` already lists `["UserGuard","LibGuard"]` in effective order, on both majors and bootstraps.
  - Design lines 517-522, 2936-2946 (line 2943 comment), 4436, 4541, 2257.
- **Suggested fix:**
  - At boot, read `ApplicationConfig.getGlobalGuards()`/`getGlobalRequestGuards()`:
    - treat `BetterAuthGuard` found there as global reach, whoever registered it (B16), and require the scope interceptor in `getGlobalInterceptors()` likewise;
    - emit `W_GLOBAL_GUARD_BEFORE_AUTH` listing global guards ahead of it, with the hint to register them in a module imported after `BetterAuthModule.forRoot()` or at controller level.
  - Make `principalFor` total:
    - return a distinct `{ outcome: 'no-identity' }` for `public`/`inherit` plans;
    - throw `BetterAuthConfigurationError.atRequest('PRINCIPAL_READ_BEFORE_GUARD')` when the plan needs a resolution and none has started for the call key.
  - Document the ordering rule in §7.8 and §15.1 step 13.
  - Add `LIB-principal-for` cases for an `AppModule` `APP_GUARD` (warning plus error) and for a feature-module `APP_GUARD` (works).

### NEST-r3-03 (major): Lifecycle state is per container, and `init$` completes after its first emission, so the second application created from one compiled `TestingModule` is never prepared, bound or mounted, silently

- **Section:** §5.7 steps 1–3 ("InstanceRegistry holds the application's lifecycle state"; "a repeated onModuleInit … returns at once"; prepare "exactly once"; `LATE_HTTP_ADAPTER` only "if init$ later emits"); U14; ADR-62; §14.8 `initTestApp`; §14.2 bootstraps.
- **Failure scenario:** A common speed-up of e2e suites:

  ```ts
  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  });
  beforeEach(async () => {
    app = await initTestApp(moduleRef.createNestApplication());
  });
  afterEach(() => app.close());
  ```

  The first test works. For the second application, Nest re-runs `onModuleInit` on the same singletons with a new adapter, but:
  - `InstanceRegistry` still says `bootstrapped`, so the core module "returns at once": no `bind()`, no `mount()`, no B-checks;
  - `HttpAdapterHost.init$` does not emit for the new adapter, because the subject completed, so `prepare()` (Express raw capture, the Fastify request→reply map) never runs and `LATE_HTTP_ADAPTER` never fires.

  The first app's `onApplicationShutdown` unbound the plugin. In the second app:
  - `/api/auth/*` answers 404;
  - Nest hooks and refresh suppression are off;
  - the endpoint-result observer's matcher requires a binding, so `producedByEndpoint()` is false and every `@RequirePermission` / `@RequireAuth({ authoritative: true })` route answers 401;
  - B26 never runs, because it is read at bind.

  Boot and `initTestApp` succeed. A hybrid app with `connectMicroservice(…, { deferInitialization: true })` also runs the core module's hooks from `NestMicroservice.listen()` → `registerModules()` before `app.init()`. That is another container hosting two lifecycle sequences (code reading: `nest-microservice.js:69-81, 175-178`; `nest-application.js:125-139`).

- **Evidence:**
  - exp3-reused-testing-module.mjs models the design's container-scoped state and prepare-once. The output is identical on 11.1.17 and 12.0.1: `init$ emitted (adapter#1)` only once; `onModuleInit (host.httpAdapter=adapter#2, state=bootstrapped) -> repeated lifecycle call: return at once`; `round 1: GET /x -> 200; GET /api/auth/ok -> 200`; `round 2: GET /x -> 200; GET /api/auth/ok -> 404`. Nest itself serves the second app's controller route.
  - `@nestjs/core` `helpers/http-adapter-host.js:28-32` (11.1.17), `:24-28` (12.0.1): `set httpAdapter` → `next()` then `complete()`.
  - `@nestjs/testing` `testing-module.js:21-29` (11.1.17): `setHttpAdapter` per `createNestApplication()`.
  - Design lines 2342-2352, 1162, 5277-5281.
- **Suggested fix:**
  - Key the lifecycle state by application, not container: record the adapter identity (`host.httpAdapter ?? null`) with the state, and reset it in `onApplicationShutdown` after unbinding.
  - At `onModuleInit`, compare `host.httpAdapter` with the adapter `prepare()` ran for. If it differs and the platform cannot prepare late (Express phase A must precede the parsers `init()` already registered), fail with `BetterAuthConfigurationError('APP_ADAPTER_CHANGED', hint: 'compile a new TestingModule per application')` instead of skipping. A platform that can prepare late (Fastify before `ready()`) may re-prepare.
  - `initTestApp` should detect the reuse and give the same hint.
  - Add `H-reused-testing-module` (two apps from one compiled module, under both platforms) and a lifecycle unit test for shutdown-then-init.

### NEST-r3-04 (major): The planner derives accepted kinds, source set and freshness from `policy.requires`, but class and token policy references are only resolved by the evaluator and B14, so a DI policy's `freshIdentity` and `principals` never reach the plan

- **Section:** §7.6 steps 5 and 7; U9 (`RoutePlanner` depends on `Reflector` only); §4.4.1 `PolicyRef` (value, class or token); §4.4.3 (the evaluator resolves class refs with `ModuleRef`); §4.4.4 (the DI policy recipe: "the policy names the kind … `requires: { principals: ['session', 'api-key'] }`"); Z5; §7.3.
- **Failure scenario:**

  ```ts
  @Injectable() export class ProjectOwnerPolicy implements AuthorizationPolicy<{ param: string }> {
    readonly id = 'acme:project-owner';
    readonly requires = { principals: ['session', 'api-key'], freshIdentity: true } as const;   // instance data
    constructor(@Inject(ProjectsRepo) private readonly projects: ProjectsRepo) {}
    async evaluate(…) { … }
  }
  @Require(requirement(ProjectOwnerPolicy, { param: 'id' })) @Delete('projects/:id') remove() {}
  ```

  The planner reads `requirement.principals ?? policy.requires.principals` and `freshIdentity` from `requirement.policy`, which is the **class**. `ProjectOwnerPolicy.requires` is `undefined` (an instance field), and for a string or symbol token there is no object at all. The plan therefore has `accepts = {session}`, a source set without the API-key source, and default freshness:
  - an API key is never verified on the route, so the §4.4.4 recipe answers 401;
  - under `apiKey({ enableSessionForAPIKeys: true })`, the key's mocked session (kind `'session'`, no delegation) passes the default-freshness read. The evaluator then resolves the instance and runs a policy that declared `freshIdentity` precisely so that hook-supplied sessions never reach it (Z5, §7.3). A narrow key acts as its owner. That is BA-r2-06's bypass, reopened for every DI-backed policy.

  The evaluator resolving the instance later does not help, because resolution already used the plan.

- **Evidence:** Design lines 1157 (U9 depends on `Reflector`), 2073 (only the evaluator and B14 use `moduleRef.get`), 2857 and 2861 (the planner reads `policy.requires`), 2093 (the recipe), 2066 (Z5), 2010-2011 (`PolicyRef` includes `Type` and `InjectionToken`). No section says the planner resolves references.
- **Suggested fix:**
  - Introduce one `PolicyResolver` (core, `ModuleRef.get(ref, { strict: false })`, cached) used by the planner, the evaluator and B14, and state normatively that plans read `requires` from the resolved instance. The boot scan resolves every reference before compiling plans, and lazily compiled plans resolve synchronously.
  - Alternatively, forbid instance-level `requires` for class and token refs and require `requirement(Class, params, { principals, freshIdentity })`, with B14 failing when a resolved instance declares `requires` the requirement does not carry.
  - Add planner unit tests for class and token refs, and `Z-class-policy-requires`: a DI policy naming `'api-key'` admits keys, and one declaring `freshIdentity` rejects a key session.

### NEST-r3-05 (major): Class-level access, acceptance or requirement metadata on a resolver class gives every field resolver of that class a real plan, so the common class-level pattern fails boot by default, and following the boot hint makes param-based class requirements deny every field

- **Section:** §9.2 "Field resolvers inherit" ("or whose class does, gets a real plan and is enforced per field") and "Field-resolver coverage"; §9.2 `param(name)` ("reads the resolver args first, then the route params"); §2.2.2 `RoutePlan.access` `'inherit'`; B15 `PUBLIC_READS_PRINCIPAL`; ADR-56; §17 Q23.
- **Failure scenario:**

  ```ts
  @Resolver(() => Project)
  @RequireOrgMember({ organization: fromParam('orgId') })
  export class ProjectResolver {
    @Query(() => [Project]) projects(@Args('orgId') orgId: string) { … }
    @ResolveField(() => [Task]) tasks(@Parent() p: Project, @CurrentPrincipal() viewer: AuthPrincipal | null) { … }
  }
  ```
  1. With `fieldResolverEnhancers` unset (the default), `tasks` has a class-level requirement, so its plan is `required`. It is claimed `'none'`, and boot fails `FIELD_RESOLVER_UNGUARDED`.
  2. The hint is `fieldResolverEnhancers: ['guards', 'interceptors']`. Following it, the guard runs for `tasks` once per project item, and `fromParam('orgId')` reads `tasks`' own args (none), then route params (none). The ref yields no organization, so each item answers 403 `ORGANIZATION_REQUIRED`, and the list comes back with `null` tasks and N errors.
  3. The remaining escapes both fail:
     - `@Public()` on `tasks` fails B15 `PUBLIC_READS_PRINCIPAL`, because it reads `@CurrentPrincipal()`;
     - `@OptionalAuth()` is a real plan again, and step 1 applies.

  There is no way to say "inherit" explicitly. The same holds for class-level `@AcceptPrincipals('session', 'api-key')`, the usual way to open a resolver to API keys: every field resolver of the class then needs app-wide field guards, and a guard run per field per list item. Class-level guards on resolvers are the standard Nest idiom (`@Resolver() @UseGuards(GqlAuthGuard)`), so migrating apps hit this first.

- **Evidence:**
  - Design lines 3221 (class-level metadata means a real plan), 3226 (coverage fails boot), 3208 (`param` reads the field's args), 1590-1593 (`defaultAccessFor` only for handlers without class-level metadata), 2256 (B15).
  - `@nestjs/graphql` 13.2.4 `services/resolvers-explorer.service.js:95-102`: field resolvers get guards and interceptors only with `fieldResolverEnhancers`.
  - REV2-NEST:`exp2-field-resolver-default-access.mjs` shows the per-item guard runs.
- **Suggested fix:** See user decision 1.
  - Either apply class-level access, acceptance and requirement metadata to a resolver class's **operation** handlers only, so field resolvers inherit unless they carry method-level metadata (`defaultAccessFor` answers before class metadata for field resolvers; `W_FIELD_RESOLVER_INHERITS` already covers reachability from public roots);
  - or keep class propagation, add a method-level `@InheritAuth()` that yields an `inherit` plan (allowed with principal params, counted by B22), and make B15 fail at boot for a class-level requirement whose ref reads `param()` on a field resolver that cannot supply it.
  - Add a GraphQL job case with the class above.

### NEST-r3-06 (major): `defaultRequirements` is AND-ed into plans whose other requirements admit disjoint principal kinds, so a company-wide `orgMember()` turns every API-key route into 403 `PRINCIPAL_NOT_SUPPORTED`, with no per-route opt-out B15 allows and no boot check

- **Section:** §2.2.1 `defaultRequirements`; §7.6 steps 4–5; §8.1 "Principal-kind and delegation gate"; B15 (`@Public()`/`@OptionalAuth()` with requirements at the same level is a boot error); §15.1 step 14 (recommends `defaultRequirements: [orgMember()]`); ADR-58; §17 Q25.
- **Failure scenario:** Following migration step 14 with `defaultRequirements: [orgMember()]`:
  - The §7.6 example route `@RequireApiKeyPermission({ reports: ['read'] }) @Get('feed')` compiles to requirements `[orgMember(), apiKeyPermission]` and accepts `{session, api-key}`.
    - An API-key request authenticates as `'api-key'`, and the gate of `orgMember` (`requires.principals: ['session']`) denies 403 `PRINCIPAL_NOT_SUPPORTED`.
    - A session request passes `orgMember` and is denied by `apiKeyPermission` (`['api-key']`).
    - The route can never succeed.
  - Every RPC or WS handler that a service account calls with a bearer session and no active organization answers 403 `NO_ACTIVE_ORGANIZATION`.
  - The only opt-outs are access decorators. Method-level `@Public()`/`@OptionalAuth()` next to `@RequireApiKeyPermission` fails B15, and they would also drop the key requirement.
  - B15 checks param kinds against accepted kinds, but not whether the AND-ed requirements admit any common kind.

  The company-wide mechanism v3 recommends therefore breaks every machine route, and the user's only fix is to delete it.

- **Evidence:** Design lines 328, 2854-2857, 3020-3022, 3070 (`apiKeyPermission` principal `['api-key']`), 3069 (`orgMember` principal `['session']`), 2256, 4542, 5252-5256.
- **Suggested fix:**
  - Add a B15 check `UNSATISFIABLE_PRINCIPAL_KINDS`: for each `required` plan, intersect the admitted kinds of every AND-ed requirement (the union inside `anyOf`) with `plan.accepts`. An empty set fails boot, naming each requirement's origin (`defaultRequirements`, class, method).
  - Give `defaultRequirements` a visible scope (user decision 2). Either a per-handler `@SkipDefaultRequirements()` (class or method; counted in B22 like public handlers), or entries that apply only to principals whose kind their policy admits (`{ requirement, kinds }`).
  - Add planner tests and a `T-reads-session`-style boot case.

### NEST-r3-07 (minor): As written, B16's `UNGUARDED_AUTH_METADATA` fires for every hook provider, because hook decorators are library metadata that no transport claims

- **Section:** §5.4 B16 last bullet ("a scanned method whose own decorators or params are library metadata other than `@Public()` and `@SkipOriginCheck()`, and that no transport claims"); §2.3 metadata keys (`hook`, `db-hook`, `auth-instance`); `LIB-coverage-rule`; ADR-40 revision.
- **Failure scenario:** `@Injectable() class SignupHooks { @BeforeAuth('/sign-up/email') normalize(ctx) {} }` (§4.5, §15.2). The boot scan covers "every provider's methods" (§5.4). `normalize` carries `Symbol.for('…:hook')`, which is neither `@Public()` nor `@SkipOriginCheck()`, and no transport claims a hook method. Boot fails with `UNGUARDED_AUTH_METADATA`, and the same happens for `@BeforeDatabase`. An implementer who follows the text breaks every app with hooks; one who does not has no normative list of which keys count.
- **Evidence:** Design lines 2257 (trigger wording), 1111 (`hook`, `db-hook` are library metadata keys), 4425 ("an unclaimed method with method metadata … give `UNGUARDED_AUTH_METADATA`"), 5057.
- **Suggested fix:** Define the trigger by the same list as "declares something" (access other than `@Public()`, `@AcceptPrincipals`, requirements, principal or invocation params, `@ForwardAuthCookies()`), plus `@UseAuthInstance`, and state that `hook`, `db-hook`, `skip-origin-check` and `@Public()` never count. Add a hook-provider case to `LIB-coverage-rule`.

### NEST-r3-08 (minor): The "gateway with methods but no discovered handlers" heuristic fails boot for push-only gateways; a canary check on the pinned keys would be exact

- **Section:** §9.3 item 2, "A gateway without discovered handlers"; RK9; §12.9 step 7.
- **Failure scenario:** An app authenticates its chat gateway and also has a server-push gateway:
  ```ts
  @WebSocketGateway({ namespace: "notifications" })
  export class NotificationsGateway {
    @WebSocketServer() server: Server;
    notifyUser(userId: string, payload: unknown) {
      this.server.to(userId).emit("notification", payload);
    }
  }
  ```
  It has a non-lifecycle method (`notifyUser`) and zero `@SubscribeMessage` handlers. The WS unit therefore claims the **class** `'explicit'` with `everyHandler`, and boot fails with `GATEWAY_UNGUARDED` and a hint about global guards not reaching gateways. That hint is wrong for a class that serves no message. The workaround, class-level `@Public()`, is misleading and inflates B22's public count.
- **Evidence:** Design lines 3272-3274, 5343 (RK9). `MetadataScanner.getAllMethodNames` returns every prototype method, and `@WebSocketServer()` is a property.
- **Suggested fix:** Replace the heuristic with a boot-time canary. Each unit that holds a Nest literal applies the real Nest decorator to a private probe class and asserts that the literal reads it back:
  - `SubscribeMessage` → `'websockets:message_mapping'`;
  - `MessagePattern` → `'microservices:pattern'`;
  - `Get` → `'path'`/`'method'`;
  - `UseGuards`/`UseInterceptors` → `'__guards__'`/`'__interceptors__'`.

  A failing canary fails boot with `NEST_METADATA_KEY_CHANGED` for that unit. A passing one means zero handlers really is zero handlers, so no class claim is needed. This also turns RK9's CI-only pin into a check on the user's installed Nest.

### NEST-r3-09 (minor): Apollo's `handles()` rejects GraphQL contexts that contain `reply`, so Apollo on Fastify with a custom `(request, reply)` context answers 500 `NO_TRANSPORT` for every non-public resolver

- **Section:** §9.0 Apollo row ("`getType() === 'graphql'` and the context has no Mercurius `reply`/`_connectionInit`"); §4.2.2 T1.
- **Failure scenario:** On Fastify, Nest's Apollo driver passes the user's `context` to `@as-integrations/fastify`, which calls it as `(request, reply)`. A user exposes the reply for their own cookies: `GraphQLModule.forRoot({ driver: ApolloDriver, context: (request, reply) => ({ req: request, reply }) })` with `transports: [apolloTransport()]`.
  - `apolloTransport.handles()` is false because the context has `reply`, and no Mercurius transport is registered.
  - The guard throws `NO_TRANSPORT` on every non-public operation.
  - Boot passes, because B16 claims come from metadata, not from contexts.

  The negative probe exists only to keep two GraphQL transports apart, but an app has one GraphQL driver.

- **Evidence:** `@nestjs/apollo` 13.2.4 `dist/drivers/apollo-base.driver.js:138-139` (`fastifyApolloHandler(server, { context: options.context })`) and `:205-210` (a user context receives `...args` and keeps its own `req`); design line 3161.
- **Suggested fix:** Decide the driver at boot, not per request from user-shaped objects. Each GraphQL unit's `validate()` reads `GqlModuleOptions.driver` (the unit may name its own framework) and fails with `GRAPHQL_DRIVER_MISMATCH` when registered for the other driver; `handles()` is then `getType() === 'graphql'`. Add a `T-selection` case with an Apollo context that carries `reply`.

### NEST-r3-10 (minor): `RoutePlan.routeParams` is HTTP route data that core compiles from Nest's `'path'` metadata, so the organization IDOR advice cannot cover GraphQL args or WS/RPC payload fields without editing core

- **Section:** §2.2.2 `RoutePlan.routeParams` ("HTTP controllers; read from Nest's path metadata"); §8.3 `W_ORG_PARAM_IGNORED`; §12.4 (the `'path'` literal belongs to `httpTransport()`); §3.2 rules 1 and 5.
- **Failure scenario:** `@Mutation() @RequireOrgPermission({ project: ['delete'] }) deleteProject(@Args('orgId') orgId: string, @Args('id') id: string)` checks the **active** organization while it deletes in `orgId`, the IDOR §8.3 warns about. `W_ORG_PARAM_IGNORED` reads `plan.routeParams`, which the core planner fills only from HTTP path metadata, so the mutation (and any WS or RPC handler reading `data.orgId`) gets no warning. Covering them requires the planner, which is core, to learn GraphQL's `@Args` metadata or payload conventions. That is the OCP edit R4 forbids. Core reading `'path'` also contradicts §12.4, which gives that literal to the HTTP unit.
- **Evidence:** Design lines 483-484, 3087, 3901, 1204, 1208.
- **Suggested fix:** Let transports supply named inputs in their claims (`ClaimOptions.inputs?: readonly string[]`):
  - HTTP: route params;
  - GraphQL: `@Args` names;
  - WS and RPC: none, or a documented convention.

  Core copies them into the plan data given to `advise()` as `inputs`. Remove `routeParams` from `RoutePlan`, and extend the org unit's advice and its case to a GraphQL mutation.

## Proposed user decisions

1. **Should class-level access, acceptance and requirement metadata on a GraphQL resolver class apply to its field resolvers?** (NEST-r3-05)
   - Option A: No. It applies to the class's operation handlers (queries, mutations, subscriptions) only. Field resolvers inherit unless they carry method-level metadata, and `W_FIELD_RESOLVER_INHERITS` keeps pointing at field resolvers reachable from public roots.
   - Option B: Yes, as in v3, plus a method-level `@InheritAuth()` opt-out and a boot check for class-level refs that read `param()`.
   - Recommendation: A. It matches how Nest users read a class-level guard on a resolver, avoids a guard run per field per list item, and needs no new decorator. B is safer for field resolvers reachable from public roots but makes every class-level requirement a boot error or a per-item cost.

2. **How should `defaultRequirements` treat routes whose own requirements admit other principal kinds?** (NEST-r3-06)
   - Option A: Always AND, with a visible per-handler opt-out (`@SkipDefaultRequirements()`, counted in the boot summary) and a boot error for unsatisfiable kind sets.
   - Option B: Each default entry applies only to principals whose kind its policy admits (for example `orgMember()` is skipped for API-key principals), with no opt-out decorator.
   - Recommendation: A. It keeps the company rule explicit and auditable, as Q3 does for class requirements. B silently exempts delegated credentials from a rule the user wrote as "every request".

3. **How should app-wide guards read the principal?** (NEST-r3-02)
   - Option A: Keep the synchronous, read-only `principalFor(ctx)`. Make it total (a distinct "no identity" result, and an error when read before the guard), warn at boot about global guards ahead of `BetterAuthGuard`, and recognize a user-registered `APP_GUARD` for `BetterAuthGuard` in B16.
   - Option B: Add an async `authenticate(ctx)` that runs the guard's own plan, origin check, resolution and acceptance steps with the same memos, so user guards work in any order and `BetterAuthGuard` later is a memo hit.
   - Recommendation: A for 1.0. It keeps Q27's single resolution path, and the boot warning plus the error make the order visible. B is better DX but is a second entry into the resolver that the security review would need to re-audit.
