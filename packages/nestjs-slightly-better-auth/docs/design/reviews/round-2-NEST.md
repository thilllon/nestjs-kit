# Round 2 review: NEST (NestJS correctness, packaging, SOLID)

Input: `design-v2.md`. Verdict: **reject**.

Experiments: `scratchpad/tmp-r2-review-NEST/` (Nest 11.1.17 with @nestjs/graphql 13.2.4 + @nestjs/apollo 13.2.4; Nest 12.0.1 with @nestjs/graphql 14.0.0 + @nestjs/apollo 14.0.0; Node 24.14.1). Each script lives at the top of that directory and was copied into `n11/` and `n12/` and run in both.

## Summary

The round-1 fixes hold. All thirteen NEST-r1 findings are resolved: invocation-scoped decisions, the last-arrival coordinator, the Fastify child error handler, fail-closed coverage checks, name-free core, the declared-once rule for app-level extensions, extension exports and the test stamp. I re-checked each original failure scenario against v2 and none of them still reproduces.

v2 also grew a lot, and the new mechanisms bring new failure modes. Four experiments confirmed them on Nest 11 and 12, and design reading found the rest. I found 1 blocker, 7 majors and 8 minors.

- **Plan cache key (blocker).** Route plans are "cached per handler". On both Nest majors, `ctx.getHandler()` is the same function for an inherited route method in every subclass controller (exp1). A generic `CrudController` base therefore shares one plan between a `@Public()` subclass and a protected one. As specified, that is an authorization bypass, of the same class as NEST-r1-01 (NEST-r2-01).
- **Coverage is not generic.** The fail-closed checks live only in the `validate()` of registered transports. Forgetting `socketIoTransport()` on Nest 11 or `rpcTransport()` in a hybrid app, or running with `globalGuard: false`, silently leaves requirements unenforced. That contradicts ADR-40 (NEST-r2-02).
- **Transport selection runs before `@Public()`.** Credential-less TCP/Redis messages, and public handlers in contexts no transport claims, answer 500 `NO_TRANSPORT`. Global guards do reach third-party context types such as `@golevelup/nestjs-rabbitmq`'s `'rmq'` (exp3) (NEST-r2-03).
- **B16's own hint breaks public GraphQL queries.** Setting `fieldResolverEnhancers: ['guards']` runs the global guard on every undecorated field resolver, and those default to `authenticated` (exp2) (NEST-r2-04).
- **`NestMicroservice.init()` runs lifecycle hooks twice.** On the second run, the design's exclusive `bind()` throws `INSTANCE_ALREADY_BOUND` against the same app, under both bootstraps and both majors (exp4c) (NEST-r2-05).
- **The GraphQL carrier stamp is last-writer-wins.** It holds one result per instance, but resolutions are per (instance, freshness, source set), so a field resolver can read a principal of a kind its root field never admitted (NEST-r2-06).
- **Guards and interceptors cannot read the principal.** There is no public way to read it from an `ExecutionContext`, and `BetterAuthService.getPrincipal()` returns `null` there. That breaks the common "custom guard reads the user" migration path (NEST-r2-07).
- **The `planFor` seam is not wired.** The protected subclass seam is not connected to `@UseBetterAuth()`, `globalGuard`, the boot scan or the coverage checks (NEST-r2-08).

## Prior findings (round 1, NEST-r1-*)

| Id         | Status   | Note                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEST-r1-01 | resolved | Decisions are keyed by `TransportCall.invocation` (GraphQL `info`, WS args array, HTTP request, RPC context), and policy I/O by concrete inputs. The connection is used only for the principal TTL (§7.2, T7, Z6). The aliased-field, batched and WS-TTL scenarios no longer share an allow. A separate stamp-sharing issue exists on the principal side (NEST-r2-06). |
| NEST-r1-02 | resolved | A `null` adapter means no HTTP: no `supports`/`prepare`/`mount`, `TransportKit.http = null`, B08 skipped, plus NestFactory adapter-less matrix jobs (§4.1.3, §5.7, `H-no-adapter`). The adjacent "init$ never emits" case under `@nestjs/testing` is NEST-r2-09.                                                                                                       |
| NEST-r1-03 | resolved | Last-arrival coordinator with self-registering platform registries. LEAD-EXP-3 shows `prepare()` before `create()` resolves, even with an async factory (`H-async-options-factory`).                                                                                                                                                                                   |
| NEST-r1-04 | resolved | A child `setErrorHandler` delegates to `root.errorHandler` at request time, plus a canonical 413 (LEAD-EXP-2; H4/H8 cases with awaited registration and a global prefix).                                                                                                                                                                                              |
| NEST-r1-05 | resolved | `rpcTransport` fails boot with `hybridCoverage: 'error'` unless `inheritAppConfig` is asserted (§9.4), so the original scenario (transport registered) now fails boot. The check exists only when the RPC transport is registered (NEST-r2-02).                                                                                                                        |
| NEST-r1-06 | resolved | The GraphQL transports' `validate()` reads `GqlModuleOptions.fieldResolverEnhancers` and fails boot (§9.2). Following the fix hint has a new side effect (NEST-r2-04).                                                                                                                                                                                                 |
| NEST-r1-07 | resolved | `definePrincipalParam` kind data, a generic `NO_TRANSPORT`, `advise()` members, and `userIdOf` moved into the session source. The literal ban holds for all four v1 violations. The residual core-owned credential-scheme knowledge is minor (NEST-r2-13).                                                                                                             |
| NEST-r1-08 | resolved | `overrideAuthGuard` overrides provider, guard and interceptor. `stampPrincipal()` writes an args-element-identity test stamp that the interceptors copy into the scope (§7.8 item 3, LEAD-V34).                                                                                                                                                                        |
| NEST-r1-09 | resolved | Platforms and transports are declared once, on the default instance: compile-time overloads plus B25.                                                                                                                                                                                                                                                                  |
| NEST-r1-10 | resolved | Renamed to `@CurrentSession()` (ADR-24).                                                                                                                                                                                                                                                                                                                               |
| NEST-r1-11 | resolved | The claim was narrowed, the plugin counts pre-bind endpoint dispatches (B26), and seeding moved to `onApplicationBootstrap`. The counter misses database-hook dispatches (NEST-r2-10).                                                                                                                                                                                 |
| NEST-r1-12 | resolved | `ExtensionDefinition.exports` exists, and `WsConnectionAuth` is provided and exported under `WS_CONNECTION_AUTH` with an `instance` option.                                                                                                                                                                                                                            |
| NEST-r1-13 | resolved | The probe was removed. Every gateway needs `@UseBetterAuth()` or `@Public()` on both majors, and the duplicate guard run is a memo hit. The method-level branch relies on an unpinned key (NEST-r2-12).                                                                                                                                                                |

## New findings

### NEST-r2-01 (blocker): The route-plan cache is keyed "per handler", but Nest hands every subclass the same inherited handler function, so controllers sharing a base method share one plan

- **Section:** §7.1 (`planner.get(ctx) // cached per handler`); §7.6 "Plan compilation (RoutePlanner, cached per handler)"; U9; §8.2 "Reading"
- **Failure scenario:** A generic base controller, a common Nest pattern:
  ```ts
  abstract class CrudController {
    @Get() list() {}
  }
  @Public()
  @Controller("posts")
  class PostsController extends CrudController {}
  @RequirePermission({ user: ["list"] })
  @Controller("users")
  class UsersController extends CrudController {}
  ```
  The planner compiles class metadata (the prototype chain, most-derived first, §7.6 step 1), but caches the result per handler. The first request after boot, `GET /posts`, compiles the plan `public` and caches it under `CrudController.prototype.list`. Every `GET /users` then hits that cache entry: public, zero auth I/O, and the admin requirement is never evaluated. With the opposite order, `/posts` demands a session and the `list` permission. The same key feeds the scope interceptor's `forwardDirectCalls` and the param-decorator constraints. `@UseAuthInstance` on one subclass routes the other subclass to the wrong instance. The boot scan uses `planOf(target, method)`, keyed by class, so B14/B15 validate the right plans while the runtime serves the wrong one.
- **Evidence:** exp1-inherited-handler.mjs on 11.1.17 and 12.0.1: `{"classes":["UsersController","PostsController"],"sameHandlerFunction":true,"cachePerHandlerWouldShare":true}`. Design lines 2470 and 2659 ("cached per handler"), U9 (line 1042), class-chain reading (lines 2661, 2839), `planOf(target: Function, method: string)` (line 1531).
- **Suggested fix:** State normatively that the plan cache key is `(ctx.getClass(), ctx.getHandler())`, for example `WeakMap<Type, WeakMap<Function, RoutePlan>>`, and that the planner never keys by handler alone. Add planner unit and `T-*` cases: two subclasses of one base controller or resolver with different class-level access, requirements and `@UseAuthInstance`, each requested first in turn.

### NEST-r2-02 (major): Coverage checks exist only inside registered transports (and only for the global-guard gaps they know), so a forgotten transport or `globalGuard: false` leaves written requirements silently unenforced, contradicting ADR-40

- **Section:** §5.4 B16; §9.3 item 2; §9.4 "Guard registration and hybrid coverage"; ADR-40 rationale; §0.2 P8; §2.2.1 `globalGuard`; §15.2 `disableGlobalAuthGuard` row
- **Failure scenarios:**
  - (a) Nest 11 with `BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] })`, where the user forgot `socketIoTransport()`. The gateway is `@WebSocketGateway() class Billing { @SubscribeMessage('refund') @RequirePermission({ billing: ['refund'] }) refund() {} }`. No WS transport means no `validate()`, so no `GATEWAY_UNGUARDED`. Global guards do not reach gateways on 11 (LEAD-V6), boot passes, and any socket client calls `refund`.
  - (b) Nest 11 or 12 hybrid app calling `app.connectMicroservice({ transport: Transport.NATS })` without `inheritAppConfig`, with `rpcTransport()` not registered, and `@MessagePattern('billing.refund') @RequirePermission(...)`. The handler runs for any publisher (LEAD-V32), and boot is silent.
  - (c) The migration row maps `disableGlobalAuthGuard: true` to `globalGuard: false` plus `@UseBetterAuth()` where needed. A controller method with `@RequireOrgPermission(...)` whose author forgot `@UseBetterAuth()` is served to anyone, and no check covers HTTP controllers.

  In all three cases the core boot scan already found the requirement metadata (B14 resolves policies "on every controller, resolver, gateway and message-handler method"), but nothing asks whether any guard will run.

- **Evidence:** B16 is "Each transport's `validate()` passes" (line 2089). ADR-40: "a requirement the user wrote is either enforced or the app does not start" (line 4656). §0.2 P8 (line 157). §5.4 scan (line 2110). `globalGuard` (lines 276-279). Migration row (line 4181). LEAD-V6, LEAD-V32.
- **Suggested fix:** Make coverage a name-free core rule with transports supplying facts:
  - Give `TransportValidationContext` a `claim(target, method, reach: 'global-guard' | 'explicit-only')` member:
    - the HTTP transport claims controllers as `global-guard`;
    - the WS transports claim gateway methods as `explicit-only`;
    - the RPC transport claims hybrid handlers as `explicit-only` unless `inheritAppConfig` is asserted;
    - the GraphQL transports claim root resolvers as `global-guard`, and field resolvers according to `fieldResolverEnhancers`.
  - After every `validate()` has run, BootValidator fails with `UNGUARDED_AUTH_METADATA` for each scanned method that carries enforcing library metadata (requirements, a non-public access decorator, `@AcceptPrincipals`, principal or invocation params) and is neither `isGuardApplied()` nor claimed as `global-guard` while `globalGuard` is true. The message lists the registered transport ids and needs no literal names.
  - Keep the per-transport options as ways to relax the check.
  - Add a matrix case for each of (a), (b) and (c).

### NEST-r2-03 (major): The guard selects a transport before honoring `@Public()`, and `rpcTransport.handles()` requires a carrier match, so credential-less RPC messages and public handlers in unclaimed contexts answer 500 `NO_TRANSPORT`

- **Section:** §7.1 (select first, public check after); §9.0 RPC row (`handles` = `getType() === 'rpc'` and a carrier matches); §9.4 `payloadCarrier`; §4.2.2 T1, T5; §4.2.3 `NO_TRANSPORT`
- **Failure scenarios:**
  - (a) A standalone TCP microservice (Nest's default transport) with `transports: [rpcTransport()]`. A client sends `client.send('sum', [1, 2])`, or `{ orderId }` without an `auth` object, to `@MessagePattern('sum') @Public() sum()`. TCP and Redis contexts have no headers (`TcpContext` exposes only `getSocketRef`/`getPattern`), so only `payloadCarrier` could match, and it matches only when `data.auth` is an object. No carrier matches, `handles()` is false, and the guard throws `BetterAuthConfigurationError NO_TRANSPORT` before it reads `plan.access`. `@Public()` does not help. The same message to a protected handler answers 500 "Internal server error" instead of 401 `UNAUTHENTICATED`, and an `@EventPattern` handler logs an error per event. This contradicts T5 ("missing credentials give empty Headers") and T1.
  - (b) An app that uses `@golevelup/nestjs-rabbitmq` (context type `'rmq'`), `nestjs-trpc` or a Nest 12 gateway without a registered WS transport. The global `BetterAuthGuard` runs for those handlers, because `ExternalContextCreator` applies global guards to custom context types. Every handler answers 500 until the user writes a transport, including handlers explicitly marked `@Public()`, which the design promises do "zero auth I/O".
- **Evidence:**
  - exp3-external-context-global-guard.mjs, 11.1.17 and 12.0.1: `{"guardSawContextTypes":["rmq"]}`.
  - `@golevelup/nestjs-rabbitmq` 9.0.2 `lib/rabbitmq.module.js:156-159` creates handlers with `RABBIT_CONTEXT_TYPE_KEY = 'rmq'`.
  - `@nestjs/microservices` 12.0.1 `ctx-host/tcp.context.js` and `redis.context.js` (no headers); `server/server-tcp.js:64`.
  - Design lines 2469-2474, 2937, 3059, 1550, 1554, 1569.
- **Suggested fix:**
  - Compile the plan and return `true` for `access === 'public'` before transport selection. The planner needs no transport, and B15 already forbids principal params on public handlers, so the public stamp can be skipped when no transport handles the context.
  - Define `rpcTransport.handles(ctx)` as `ctx.getType() === 'rpc'`. Choose the carrier inside `describe()`; when none matches, `headers()` returns empty `Headers`, which gives 401 on required routes.
  - Add `T-no-credentials` for TCP with a primitive payload, and a public-handler case for an unclaimed context type.

### NEST-r2-04 (major): Following B16's own hint (`fieldResolverEnhancers: ['guards', …]`) subjects every undecorated field resolver in the app to `defaultAccess: 'authenticated'`, breaking `@Public()` and `@OptionalAuth()` queries for anonymous callers

- **Section:** §9.2 "Field-resolver coverage"; §7.6 step 3 (effective access falls back to `defaultAccess`); §14.2 GraphQL job
- **Failure scenario:** The app has one resolver with `@RequirePermission` on a `@ResolveField`, so boot fails with `FIELD_RESOLVER_UNGUARDED`, and the user applies the hint: `fieldResolverEnhancers: ['guards', 'interceptors']`. That switch is global. Nest now runs every guard, the global `BetterAuthGuard` included, on every field resolver, including `PostResolver.author`, which has no decorators. That plan compiles to `required` (no access decorator and no requirements, so `defaultAccess`). The public landing-page query `@Public() @Query() posts { title author { name } }` now returns `data: null` with `UNAUTHENTICATED` at `posts.0.author` for every anonymous visitor. The guard also runs once per field per list item: 1,000 posts cost 1,000 `describe()` calls, memo lookups and debug denials. The design never states what access an undecorated field resolver should have. The kit's GraphQL job checks only that enforcement works "with it", not that public queries still work.
- **Evidence:** exp2-field-resolver-default-access.mjs, identical on 11.1.17/13.2.4 and 12.0.1/14.0.0:
  - with `[]`: `guardRuns ["PostResolver.posts:public"]` and data returned;
  - with `['guards']`: `guardRuns ["PostResolver.posts:public","PostResolver.author:default(authenticated)"]`, `data: null`, `errors [{"path":["posts",0,"author"],"code":"UNAUTHENTICATED"}]`.

  Design lines 2985-2987 (hint), 2663-2668 (`defaultAccess`), 4006.

- **Suggested fix:**
  - Give field resolvers a transport-supplied default access. For example, add an optional `AuthTransport.defaultAccessFor?(target, method): 'inherit' | undefined` that the planner consults before `defaultAccess`. An `inherit` plan returns `true` with no I/O and no stamp write, because the root field already decided.
  - Only field resolvers with their own or class-level access decorators or requirements get a real plan.
  - Document the per-field guard cost.
  - Add a GraphQL job case: with `['guards']`, an anonymous `@Public()` query that traverses an undecorated field resolver succeeds, and a decorated one is enforced.

### NEST-r2-05 (major): `NestMicroservice.init()` runs `onModuleInit`/`onApplicationBootstrap` twice, and the design's exclusive `bind()` then throws `INSTANCE_ALREADY_BOUND` against the same app

- **Section:** §5.7 Lifecycle steps 2-3; §10.2 `bind()`; §10.6 exclusive binding; B06; §14.6 `nest12-microservice` fixture; §14.2 adapter-less bootstraps
- **Failure scenario:** `const app = await NestFactory.createMicroservice(AppModule, { transport: Transport.TCP })` followed by `await app.init()`. In e2e tests the same happens with `moduleRef.createNestMicroservice(...)` and `await app.init()`. `NestMicroservice.init()` calls `super.init()` (init hooks, then bootstrap hooks) and then `registerModules()`, which calls both hook phases again because `wasInitHookCalled` was never set. On the second `onModuleInit`, HookBinder calls `bind()`. The first binding was marked `bootstrapped` by the first `onApplicationBootstrap`, so `bind()` throws `INSTANCE_ALREADY_BOUND: bound to <this app>`, the aggregated boot error rejects `init()`, and the microservice cannot start. Every other `onModuleInit` step (B-checks, advice, hook discovery) would also run twice. The matrix and the fixture boot microservices, but nothing states whether they call `init()` or `listen()`.
- **Evidence:**
  - exp4b-double-init.mjs: `testingMicroserviceInit {"onModuleInit":2,"onApplicationBootstrap":2}`, while `listen()` gives 1/1, on 11.1.17 and 12.0.1.
  - exp4c-microservice-init-twice.mjs reuses the design's `bind()` logic verbatim. It reports `events ["bind","bootstrapped"]` and `result "INSTANCE_ALREADY_BOUND: bound to this app"` for both `NestFactory.createMicroservice + init()` and `Test…createNestMicroservice + init()`, on both majors.
  - `@nestjs/microservices` 11.1.17 `nest-microservice.js:69-81, 162-169`; `@nestjs/core` `nest-application-context.js:103-119`.
- **Suggested fix:**
  - Make the kernel lifecycle idempotent per application. The core module records that boot validation, binding and mounting completed, keeps the flag on a singleton such as `InstanceRegistry`, and returns early on a repeated `onModuleInit`/`onApplicationBootstrap`.
  - `bind()` should treat a re-bind from the same owner token as a no-op.
  - Add `H-no-adapter` variants that call `init()` and then `listen()` under both bootstraps, and state which call the `nest12-microservice` fixture uses.

### NEST-r2-06 (major): The carrier stamp holds one resolution per instance, but resolutions differ per (freshness, source set), so GraphQL field resolvers read whichever root field stamped last, possibly a principal kind their own root field never admitted

- **Section:** §7.8 item 2 (`Map<instance, PrincipalResult>` on the carrier); §7.1 `stamp(call, plan.instance, result)`; §7.2 principal key `(call.key, instance, freshness, source set)`; §9.2 carrier; §7.5 "GraphQL field resolvers … run outside the root resolver's scope"
- **Failure scenario:** One GraphQL request carries the caller's session cookie (user Y) and an `x-api-key` owned by user X. The key has `{ reports: ['read'] }` only. Two root fields run concurrently:
  - `secrets` (session-only, default kinds) resolves Y;
  - `feed` (`@AcceptPrincipals('session', 'api-key')`) resolves the API-key principal for X.

  Both stamp the same GraphQL context object (`args[2]`) under `'default'`, and the last writer wins. The field resolver `Secret.owner(@CurrentPrincipal() p)` has no guard and no scope, so it reads the stamp and can receive X's API-key principal under a root field whose route never accepted `'api-key'`. Code that scopes data by `p.userId` then acts for X outside the key's delegation, which bypasses ADR-35's per-route acceptance through a side door. The same race makes a field resolver under a default-freshness root field read an `authoritative` sibling's `absent` result (a revoked session), so `@CurrentSession()` returns `null` or throws on a request whose root field was allowed. The behavior depends on promise scheduling, so tests are flaky rather than red.

- **Evidence:** Design lines 2725 (Map per instance), 2476 (the stamp after each resolution), 2501 and 2508 (different source sets and freshness give different resolutions), 2653 (field resolvers outside the scope), 2967 (the carrier is the operation's context). `@AcceptPrincipals` and filtering per route (§7.6 step 5).
- **Suggested fix:**
  - Key the carrier stamp by the full principal memo key: instance, freshness and a canonical source set. Readers compute the key from their own plan, so a field resolver sees the resolution that its own accepted kinds and freshness select. If no matching entry exists, fail with `NO_AUTH_RESULT` instead of falling back to another entry.
  - Add a transport conformance case: two root fields with different `@AcceptPrincipals` and one field resolver reading `@CurrentPrincipal()`, with the root-field order swapped between runs.

### NEST-r2-07 (major): Nothing outside the scope interceptor can read the principal: user guards and interceptors have no API, and `BetterAuthService.getPrincipal()` returns `null` there, the same value as "anonymous"

- **Section:** §2.2.2 `getPrincipal()`/`getSession()` ("null outside any scope"); §7.5 "Coverage gaps"; §7.8 "Services"; §15.2 `request.session`/`request.user` row
- **Failure scenario:** A migrating app has a `@UseGuards(SubscriptionActiveGuard)` that checks `user.plan`, a `ThrottlerGuard` subclass whose `getTracker(req)` keys by user id, or a CASL `PoliciesGuard`. The migration table maps `request.user` to `@CurrentUser()` or `BetterAuthService.getSession()`. Guards run after `BetterAuthGuard` but before interceptors, so they run outside the scope, and `getSession()` returns `null`. The custom guard sees "anonymous" for an authenticated user: every paid user is rejected, and every user shares one throttle bucket. There is no API that takes an `ExecutionContext`, and the carrier and test stamps are private `Symbol.for` slots. Services called from GraphQL field resolvers (outside the scope, §7.5) likewise get `null` although the request is authenticated. Code cannot tell "not authenticated" from "not inside a scope".
- **Evidence:** Design lines 455-458, 2653 ("Code in middleware and in other libraries' guards runs outside the scope"), 2741 ("Outside any scope they return `null`"), 4191 (migration row), 1002 (no `req.user`).
- **Suggested fix:**
  - Export a synchronous reader `getAuthResult(context: ExecutionContext, options?: { instance?: string }): PrincipalResult | undefined`, and `BetterAuthService.principalFor(context)`. They use the decorators' lookup order (scope, then carrier or test stamp, then `resolver.peek()` through `transport.describe()`), with the stamp keyed as in NEST-r2-06, and return `undefined` when `BetterAuthGuard` has not run yet.
  - Make `getPrincipal()`/`getSession()` outside a scope throw `BetterAuthConfigurationError.atRequest('NO_AUTH_SCOPE')`, or return `undefined`, so that it is distinct from `null` (see user decision 2).
  - Document the recipe for guards and add it to §15.2.
  - Add a `LIB-` test: a controller-level guard reads the principal on HTTP, GraphQL root fields and RPC.

### NEST-r2-08 (major): The protected `planFor` seam, documented for company-wide requirements, bypasses boot validation and every call site the library wires with the concrete `BetterAuthGuard`

- **Section:** §2.2.2 `BetterAuthGuard.planFor` ("e.g. a company-wide default requirement"); §2.2.2 `UseBetterAuth()`; §5.7 guard registration; §4.2.1 `isGuardApplied`; §7.6 step 6; §14.5 Planner
- **Failure scenario:** A company subclasses `BetterAuthGuard` and overrides `planFor` to append `orgMember()` to every plan. The design gives no way to register the subclass:
  - `globalGuard: true` registers `useExisting: BetterAuthGuard`;
  - `@UseBetterAuth()` hard-codes `BetterAuthGuard`;
  - the core module owns the `BetterAuthGuard` token.

  With `globalGuard: false` and `{ provide: APP_GUARD, useClass: CompanyGuard }`, the scope interceptor is no longer registered either. Every gateway and hybrid handler still needs `@UseBetterAuth()` (B16), which applies the base guard, so the company-wide requirement is silently absent on WebSockets and hybrid RPC. That is fail-open for the one requirement the override exists to add. Using `@UseGuards(CompanyGuard)` instead fails B16 `GATEWAY_UNGUARDED`, because coverage recognizes only `BetterAuthGuard`. The appended requirement is also invisible to boot validation, which scans planner plans:
  - B13 does not check the organization plugin;
  - B14 does not resolve the policy;
  - B15 does not check param conflicts (hence the runtime "safety net" in §7.6 step 6);
  - B21 collects no `advise()` from the policy.

  The scope interceptor and the param decorators also read planner plans, so they disagree with the guard.

- **Evidence:** Design lines 413-417, 442-443, 2193, 1528, 2675 (the safety net exists only for `planFor` plans), 4065.
- **Suggested fix:** Remove the protected `planFor` seam. Add a declarative extension that `RoutePlanner` applies, so that the boot scan, coverage checks, guard, interceptor and decorators all see one plan. Two options:
  - a runtime option `defaultRequirements?: readonly RequirementExpr[]`, applied like class-level requirements to every `required` plan of the instance;
  - or a `PlanContributor` extension (`contribute(plan, target, method): Partial<RoutePlan>`) registered per instance.

  The §7.6 step 6 runtime safety net and its planner test then become unnecessary.

### NEST-r2-09 (minor): The coordinator's behavior is unspecified when `init$` never emits (`Test…compile()` + `moduleRef.init()`, `Test…createNestMicroservice()`)

- **Section:** §5.7 Lifecycle step 1; §4.1.3; §6.2 "When it runs"
- **Failure scenario:** A consumer integration test runs `const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile(); await moduleRef.init();` to exercise hook providers or services. `onModuleInit` runs while "adapter known" has never happened, and `httpAdapterHost.httpAdapter` is `undefined`, not `null`. The design defines only "null adapter = no HTTP" and "prepare when both are known". An implementation that waits for, or asserts, a recorded adapter state either throws, reports B08 against `undefined`, or leaves `TransportKit.http` undefined, so `describe()` crashes. The matrix covers only `NestFactory` for adapter-less bootstraps.
- **Evidence:** exp4-testing-no-init.mjs on 11.1.17 and 12.0.1: `"moduleRef.init":["onModuleInit emitted=false httpAdapter=undefined"]`; the same for `createNestMicroservice`. LEAD-V26. Design lines 2172-2179.
- **Suggested fix:** In `onModuleInit`, if `init$` has not emitted, record `host.httpAdapter ?? null` synchronously as "no HTTP", and log a debug line. If `init$` later emits with an adapter (`createNestApplication()` after `init()`), fail with `LATE_HTTP_ADAPTER`. Add the `moduleRef.init()` and testing-microservice bootstraps to the matrix.

### NEST-r2-10 (minor): B26's pre-bind counter sees only endpoint dispatches; database writes through `internalAdapter` before binding skip Nest DB hooks without a warning

- **Section:** §10.2 plugin before-hook 1 (counter) and `createDatabaseDispatchers`; §10.6; B26; ADR-53
- **Failure scenario:** A `@Global() SeedModule`, imported before `BetterAuthModule`, seeds an admin in `onModuleInit` with `(await auth.$context).internalAdapter.createUser({...})` and `linkAccount`, a common seeding path because it can set a password hash. No endpoint is dispatched, so `unboundDispatches` stays 0. The unbound DB dispatchers return `undefined`, so `@BeforeDatabase('user.create')` normalization and `@AfterDatabase` audit hooks are skipped, and B26 stays silent. That is the NEST-r1-11 failure through a different entry.
- **Evidence:** Design line 3174 (only the before-hook matcher counts), lines 3168 and 3274-3288 (DB dispatchers read `getBinding()` and do not count), line 2099 (B26).
- **Suggested fix:** Have the DB dispatchers increment the same counter when `binding` is null and at least one target could have Nest hooks (count unconditionally, as the endpoint matcher does). Word B26 as "N better-auth calls or database writes ran before Nest hooks were bound".

### NEST-r2-11 (minor): WS coverage accepts `@UseGuards(BetterAuthGuard)` without the scope interceptor, so on Nest 11 every message that reads `@CurrentSession()` throws `NO_AUTH_RESULT`, and direct calls get no refresh suppression

- **Section:** §9.3 item 2 (coverage accepts `@UseBetterAuth()` "(or `@UseGuards(BetterAuthGuard)`)"); §7.8 (WS has no carrier; decorators read the scope); §7.4 (suppression needs the scope)
- **Failure scenario:** On Nest 11, a user migrating `@UseGuards(AuthGuard)` writes `@UseGuards(BetterAuthGuard)` on a gateway, and B16 passes. No global interceptor reaches gateways on 11 (LEAD-V6), and the WS transport deliberately has no carrier. `@SubscribeMessage('me') me(@CurrentSession() s)` therefore throws `NO_AUTH_RESULT` on every message, and the client sees only "Internal server error". A direct `auth.api.getSession({ headers })` in a WS handler runs outside any cookie-less scope and slides the session without delivering the cookie (S2). The hybrid-RPC check has the same hole for suppression.
- **Evidence:** Design lines 3032, 3067, 2518 ("Carrier: none"), 2725, 2653; LEAD-V6.
- **Suggested fix:** For transports whose `describe()` returns no `carrier`, or whose handlers the global interceptor may not reach, coverage accepts only `@UseBetterAuth()` (guard **and** interceptor, recognized through `'__interceptors__'` as well as `'__guards__'`). The message names `@UseBetterAuth()`.

### NEST-r2-12 (minor): The method-level branch of gateway coverage depends on an unpinned Nest key and passes vacuously when it finds no methods

- **Section:** §9.3 item 2 ("on every `@SubscribeMessage` method"); §12.4 Nest-owned identifiers; §12.9 step 7; RK9
- **Failure scenario:** The check passes a gateway whose `@SubscribeMessage` methods all carry the decorator. To find those methods it needs `'websockets:message_mapping'` (`MESSAGE_MAPPING_METADATA`), which `@nestjs/websockets` does not export from its root and which the design neither lists nor pins. If a Nest release renames it, the scan finds zero message methods, `every([])` is true, and every undecorated gateway passes B16. RK9's mitigation ("a blind check only matters for an app that also forgot the decorator") does not apply, because the forgotten decorator is exactly what the check exists to catch.
- **Evidence:** `@nestjs/websockets` 12.0.1 `constants.js` (`MESSAGE_MAPPING_METADATA = 'websockets:message_mapping'`, not re-exported from `index`), `decorators/subscribe-message.decorator.js:9`. Design lines 3032, 3623, 3711, 4854.
- **Suggested fix:** Add `'websockets:message_mapping'` to the pinned literals (§12.4, §12.9 step 7, RK9). Treat a gateway class with prototype methods but zero discovered message handlers as uncovered unless the class-level decorator is present.

### NEST-r2-13 (minor): The origin check hard-codes which `authorization` schemes are explicit (`Bearer`, `DPoP`), so a principal source with another scheme cannot declare its credential non-ambient without a core edit

- **Section:** §7.10 "When it applies" item 3; §2.2.1 `OriginCheckOptions.explicitCredentialHeaders`; §3.2 rule 5 ("core compares only values that extensions supply")
- **Failure scenario:** A partner SPA on `https://partner.example` makes a CORS-approved `fetch` with `credentials: 'include'` and `Authorization: ApiKey <key>`. The app uses `apiKeyPrincipal({ header: 'authorization' })`, since the api-key plugin can read keys from `authorization`. The browser also attaches the user's cookie for the API domain, so `ambientCookie` is true. Only `authorization` headers with `Bearer`/`DPoP` count as explicit, and sources' `authorization` entries are excluded from the explicit set, so the credential counts as ambient. `partner.example` is not in better-auth's `trustedOrigins`, so the POST is denied 403 `INVALID_ORIGIN`, although the key alone authenticated it. Whether a credential is ambient is decided by core-owned scheme names instead of by the source that produced the principal.
- **Evidence:** Design lines 2774-2778, 321-326, 1093.
- **Suggested fix:** Let the producing source decide. Add `PrincipalSource.isAmbient?(request: PrincipalRequest): boolean` (the session source: a cookie present and no `Bearer` authorization), or an `ambient: boolean` on the principal result. The origin check reads that data, and core keeps no scheme list.

### NEST-r2-14 (minor): Principal param decorators accept an `instance` that the guard never resolves, and no boot check catches the mismatch

- **Section:** §2.2.3 `CurrentSession/CurrentUser/CurrentPrincipal(options?: { instance? })`, `definePrincipalParam`; §7.1 (resolves only `plan.instance`); §5.5 example; B15
- **Failure scenario:** `@Get('me') me(@CurrentSession({ instance: 'admin' }) s)` on a controller without `@UseAuthInstance('admin')`. The guard resolves and stamps only `'default'`, so the decorator finds no `'admin'` result and throws `NO_AUTH_RESULT` (500) on every request. B15 checks unknown instances and kind conflicts, but not a decorator instance different from the plan's instance. The option can never be correct when it differs from the plan, and when it matches the plan it is redundant, as in §5.5.
- **Evidence:** Design lines 517-525, 2475-2476, 2128-2132, 2088.
- **Suggested fix:** Remove the `instance` option from principal params (they read the plan's instance), or add a B15 case `PRINCIPAL_PARAM_INSTANCE_MISMATCH`.

### NEST-r2-15 (minor): `overridePrincipal`, documented as the preferred test tool, cannot exercise organization requirements, and there is no seam to stub a policy decision

- **Section:** §2.2.16 `overridePrincipal` ("acceptance, origin check and policies still run"); §8.3 org policies (`hasPermission({ headers })`, `getActiveMemberRole({ headers })`); §4.4.2 Z2 net; §14.8
- **Failure scenario:** A consumer runs `overridePrincipal(builder, { kind: 'session', userId: 'u1', session })` and calls a `@RequireOrgPermission({ project: ['delete'] })` route. The org policy calls `auth.api.hasPermission` with the test request's headers, which carry no session cookie. better-auth's `orgSessionMiddleware` answers 401, the Z2 safety net turns it into a 403 deny, and every org-guarded route is forbidden whatever the fixture's membership. The admin policy works, because it passes `userId`/`role` in the body, so the helper's behavior differs silently by policy. Policies travel by reference in metadata, so `TestingModuleBuilder` cannot replace them. The only options left are a real database session (`authHeadersFor`) or `overrideAuthGuard`, which disables acceptance and every policy.
- **Evidence:** Design lines 952-954, 2851-2852, 1895, 4125; better-auth `plugins/organization/call.ts:29-46` (`orgSessionMiddleware` uses `sessionMiddleware`).
- **Suggested fix:** Put the evaluator's policy invocation behind a token, as `PRINCIPAL_RESOLVER` already is. Ship `overrideDecisions(builder, (policyId, params, principal) => AuthorizationDecision | undefined)`, which returns `undefined` to run the real policy. Document that org policies need a real session under `overridePrincipal`.

### NEST-r2-16 (minor): "The filtered list's identity" in the principal memo key, and a single-handler `triple` fixture, leave S7 unprotected for root fields in different resolver methods

- **Section:** §7.2 "Source set"; U7; §14.1 `TransportFixtures.triple`; T2
- **Failure scenario:** `{ me { id } projects { id } invoices { id } }` has three root fields in three resolver methods, so three plans, each with its own `accepts` Set. If "the filtered list's identity" means object identity of a list built per plan, the three guard runs produce three memo keys and three `getSession` calls in one request, which breaks S7 and T2's "3 root fields → 1 resolution". `triple` is a single `FixtureHandler`, exposed as one resolver field and probably invoked three times through aliases (one plan), so the kit would stay green.
- **Evidence:** Design lines 2508, 1040, 1551, 3900.
- **Suggested fix:** Specify the source-set key by content (the ordered indexes of the consulted sources, interned per instance). Make `triple` three distinct handler methods with equal accepted kinds, and add a variant where two of the three accept different kinds (expect 2 resolutions).

## Proposed user decisions

1. **When `fieldResolverEnhancers` includes `'guards'`, what access should an undecorated `@ResolveField` get?**
   - Option A: inherit (no auth I/O, no decision), because the root field already enforced access; only field resolvers with their own or class-level decorators or requirements get a real plan.
   - Option B: the instance's `defaultAccess`, like every other handler; public queries must mark their field resolvers `@Public()` or `@OptionalAuth()`.
   - Recommendation: A. Under B, fixing one guarded field resolver breaks every public query app-wide and multiplies guard work per list item (NEST-r2-04). Class-level requirements still reach field resolvers under A.

2. **What should `BetterAuthService.getPrincipal()`/`getSession()` do outside any authentication scope (guards, middleware, GraphQL field-resolver services, background jobs)?**
   - Option A: return `null`, as today (convenient for code shared between request and background contexts, but indistinguishable from "anonymous").
   - Option B: throw a generic `NO_AUTH_SCOPE` configuration error and offer `getAuthResult(ctx)` for enhancers (explicit, fails loudly).
   - Option C: return `undefined` outside a scope and `null` for anonymous (no throw, but relies on callers checking `=== null`).
   - Recommendation: B plus the `ExecutionContext` reader of NEST-r2-07. A silent "anonymous" in an authenticated request is the more dangerous outcome, and background code should not call a request-scoped accessor.

3. **How should apps add company-wide requirements?**
   - Option A: a declarative `defaultRequirements` runtime option (or a `PlanContributor` extension) applied by the planner.
   - Option B: keep subclassing `BetterAuthGuard` with `planFor`, and wire the subclass into `globalGuard`, `@UseBetterAuth()`, the coverage checks and the boot scan.
   - Recommendation: A. It keeps one plan for every reader and needs no class identity across call sites (NEST-r2-08).
