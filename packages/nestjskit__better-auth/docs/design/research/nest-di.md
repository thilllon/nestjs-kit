# NestJS module / DI / authorization idioms for an Open-Closed better-auth integration

Research report (RESEARCH phase only, no design). Every non-obvious claim carries a citation; items not verified are marked **UNVERIFIED**. Runtime experiments were run on Node v22.22.0 against **both** Nest 11.1.17 and Nest 12.0.1; results were identical unless stated otherwise.

## 0. Sources, aliases, method

Path aliases used in citations:

| Alias    | Path                                                                                                                                                                                             | Version       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| `N11C`   | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/common`                                                                                                                    | 11.1.17       |
| `N11K`   | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/core`                                                                                                                      | 11.1.17       |
| `N11WS`  | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/websockets`                                                                                                                | 11.1.17       |
| `N11GQL` | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/graphql`                                                                                                                   | 13.2.4        |
| `N11APO` | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/apollo`                                                                                                                    | 13.2.4        |
| `N11T`   | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/testing`                                                                                                                   | 11.1.17       |
| `X`      | `/private/tmp/claude-502/-Users-thilllon-git-nestjs-slightly-better-auth/d03cce33-4991-442c-88b5-c314fe7f3223/scratchpad/tmp-nest-di/x` (npm-packed sources, one dir per `name-version/package`) | see dir names |
| `DOCS`   | `.../scratchpad/tmp-nest-di/nest-docs/content` (shallow clone of `nestjs/docs.nestjs.com` @ `21af05a`, 2026-08-31)                                                                               | v12 docs      |
| `REF`    | `.../scratchpad/ref` (@thallesp/nestjs-better-auth 2.8.0 @ 99d4a94)                                                                                                                              | 2.8.0         |
| `BA`     | `.../scratchpad/better-auth`                                                                                                                                                                     | 1.7.4         |
| `EXP`    | `.../scratchpad/tmp-nest-di` (experiment scripts; run as `node <script> <dir-with-node_modules>`; Nest 12 install lives in `EXP/n12`)                                                            |               |

Packed packages under `X`: `nestjs-common-{11.2.3,12.0.1}`, `nestjs-core-{11.2.3,12.0.1}`, `nestjs-passport-{11.0.5,12.0.0}`, `nestjs-jwt-12.0.1`, `nestjs-throttler-6.5.0`, `nestjs-cache-manager-12.0.0`, `nestjs-microservices-{11.1.17,11.2.3,12.0.1}`, `nestjs-websockets-{11.2.3,12.0.1}`, `nestjs-graphql-14.0.0`, `nestjs-apollo-14.0.0`, `mercurius` (= @nestjs/mercurius 14.0.0), `mercurius-core` (= mercurius 16.10.0), `nestjs-cls-6.3.0`, `nestjs-event-emitter-12.0.0`, `nestjs-schedule-12.0.1`, `nestjs-cqrs-12.0.0`, `nestjs-platform-fastify-{11.1.17,12.0.1}`, `nestjs-platform-express-12.0.1`, `platform-ws` (= @nestjs/platform-ws 11.1.17), `nestjs-testing-12.0.1`.

Experiments (all in `EXP`):

- `experiments.cjs` – E1 ConfigurableModuleBuilder extras, E2 Reflector semantics, E3 discoverable decorators, E4 APP_GUARD overriding in tests, E5 request-scoped providers under discovery.
- `exp-discovery-factory.cjs` – discovery of factory/value providers.
- `exp-scoped-guard.cjs` – request-scoped APP_GUARD cost.
- `exp-double-forroot.cjs` – importing `forRoot()` twice.
- `exp-ws-global-guard.cjs` – global guards/filters on WebSocket gateways (11 vs 12).
- `exp-gql-guard.cjs` – guard errors in GraphQL (Apollo), guard invocation count (Nest 11 only; needs @nestjs/apollo).
- `n12/req-test.cjs` – `require()` of ESM-only Nest 12 from CommonJS.
- `tsdown-test/` – tsdown 0.23.0 decorator-metadata output.

---

## 0.1 Headline finding: NestJS 12 IS released, and it changes several facts below

- `@nestjs/common`/`@nestjs/core` **12.0.0 published 2026-08-27T07:03Z, 12.0.1 at 07:30Z; `latest` dist-tag = 12.0.1**; latest 11.x = 11.2.3 (2026-08-25) (`npm view @nestjs/common time/dist-tags`).
- **Nest 12 packages are ESM-only**: `"type": "module"`, `exports: {".": "./index.js", "./internal": "./internal.js", "./*.js": "./*.js", "./*": "./*.js"}` — no `require` condition (`X/nestjs-common-12.0.1/package/package.json`; same for core, testing). Nest 11 packages are CJS with no `exports` map (`N11C/package.json`, `N11K/package.json`).
- Ecosystem majors that only support 12: `@nestjs/graphql` 14.0.0 peers `@nestjs/core ^12.0.0` (`npm view @nestjs/graphql peerDependencies`), `@nestjs/microservices` 12.0.1 peers ^12. `@nestjs/passport` 12.0.0, `@nestjs/jwt` 12.0.1, `@nestjs/cache-manager` 12.0.0 accept 11 or 12. `@nestjs/throttler` 6.5.0 still peers only up to ^11 and is CJS.
- **CJS consumers can load Nest 12 through `require(esm)`**: `EXP/n12/req-test.cjs` printed `require(esm) ok in 121 ms` and `same Injectable identity (require vs import): true` on Node 22.22.0. The migration guide requires **Node 20.19+ or 22.12+** for this (`DOCS/migration.md:29-40`). A full Nest 12 bootstrap (HTTP + testing + WS) from `.cjs` scripts worked in every experiment below.
- Nest 12's exports map makes `require('@nestjs/common/package.json')` fail (`Cannot find module '.../@nestjs/common/package.json.js'`, first run of `experiments.cjs` against `n12`). Deep imports like `@nestjs/core/middleware/utils.js` still resolve through `./*.js`.
- `@nestjs/common/internal` and `@nestjs/core/internal` are new entry points marked "Internal module - not part of the public API" (`X/nestjs-common-12.0.1/package/internal.js:1-7`, `X/nestjs-core-12.0.1/package/internal.js:1-7`). `loadPackage` moved there and changed signature (§8).
- Behavioral changes relevant to auth (details in later sections): global guards/pipes/interceptors now apply to WS gateways (§3.4, verified by experiment); lifecycle hooks within a module now run by hierarchy level (`DOCS/migration.md:185-189`, `X/nestjs-core-12.0.1/package/hooks/on-module-init.hook.js`); `subscriptions-transport-ws` removed from @nestjs/graphql (`DOCS/migration.md:146-159`); new gRPC exception family (§5.4); request-scoped WS gateways with the socket injectable via `REQUEST` (`DOCS/websockets/gateways.md:284-304`).

---

## 1. ConfigurableModuleBuilder (CMB)

### 1.1 Mechanics (Nest 11.1.17; 12.0.1 is functionally identical)

The 12.0.1 source diff against 11.1.17 shows only CJS-to-ESM syntax changes (diff of `configurable-module.builder.js` and `constants.js`).

- **Builder is immutable/fluent.** `setExtras`, `setClassMethodName`, `setFactoryMethodName` each return a new builder that copies the parent's state (`N11C/module-utils/configurable-module.builder.js:15-26, 42-79`).
- **Method names.** The default static method is `register` plus `registerAsync` (`N11C/module-utils/constants.js:4-6`). `setClassMethodName('forRoot')` yields `forRoot`/`forRootAsync`; the async name is always `<name> + 'Async'` (`configurable-module.builder.js:110`). `setFactoryMethodName` renames the method that a `useClass`/`useExisting` options factory must implement (default `create`) (`:75-79, :203`).
- **Options token.** Priority: explicit `optionsInjectionToken`; otherwise `moduleName` gives `"<SNAKE>_MODULE_OPTIONS"` (e.g. `moduleName:'Auth'` gives `'AUTH_MODULE_OPTIONS'`); otherwise a random `CONFIGURABLE_MODULE_OPTIONS[<hash>]` (`:88-90, :99-106`, `utils/generate-options-injection-token.util.js`). Verified by E1: `E1 token AUTH_MODULE_OPTIONS`.
- **Sync path (`forRoot`)** registers `{provide: TOKEN, useValue: omitExtras(options, extras)}`. It then calls `transformModuleDefinition({module: this, providers}, {...extras, ...options})` (`:112-132`).
  - `omitExtras` removes only keys that exist in the default extras object (`:150-162`).
- **Async path (`forRootAsync`)** builds `imports: options.imports || []` plus the async providers. Extras are computed as `{...defaultExtras, ...extractExtrasFromAsyncOptions(options)}`, which takes **every** key that is not in `['useFactory','useClass','useExisting','inject','imports','provideInjectionTokensFrom']` (`:133-149, :163-174`, `constants.js:12-19`).
- **`useFactory`/`useClass`/`useExisting`.** `useFactory` becomes `{provide: TOKEN, useFactory, inject: inject || []}`. `useClass`/`useExisting` become a factory that awaits `optionsFactory[factoryMethod]()` with `inject: [useExisting || useClass]`, and `useClass` additionally registers the class as a provider (`:175-206`).
  - `useExisting` does not register anything, so the referenced provider must already be visible in the module (usually via `imports`).
  - `provideInjectionTokensFrom` copies the needed providers (recursively by `inject`) into the module (`:177-182`, `utils/get-injection-providers.util.js:21-35`).
- **`alwaysTransient`** adds a random `CONFIGURABLE_MODULE_ID` provider so each call produces a unique module (`:119-124, :135-140`).
- `OPTIONS_TYPE`/`ASYNC_OPTIONS_TYPE` are type-only Proxies that throw if read as values (`:210-217`).

### 1.2 How extras reach the module

- Extras are visible **only** inside the `transformDefinition(definition, extras)` callback passed to `setExtras`. The builder never registers them as a provider (`configurable-module.builder.js:113-131, 141-148`). To use an extra at runtime (e.g. "disable global guard"), the transform must turn it into providers or `global`/`controllers`/`exports`, or the subclass must override `forRoot`/`forRootAsync` and read it from the raw argument. REF does the latter (`REF/src/auth-module.ts:338-404`).
- In the async path, extras come from the **synchronous async-options object**. They cannot depend on values resolved by `useFactory`. Anything that must change the module _shape_ (register or skip APP_GUARD, controllers, middleware) is therefore fixed at definition time.

E1 empirical results (`experiments.cjs`, Nest 11 and 12 identical):

```
E1 A.forRoot useValue {"foo":1} global= true                               # setExtras({isGlobal:false}) -> isGlobal stripped
E1 B.forRoot (empty extras default) useValue {"foo":1,"isGlobal":true} ... # setExtras({}) -> isGlobal LEAKS into options value
E1 A.forRoot({isGlobal: undefined}) global= undefined (default was false)  # explicit undefined overrides the default
E1 module class identity across calls true
```

### 1.3 Limitations of CMB (from code and E1)

1. Only one sync/async method pair is generated. `forFeature`-style methods must be hand-written.
2. `useFactory` is typed `(...args: any[]) => ...` and `inject` is untyped, so there is no link between inject tokens and factory parameters (`N11C/module-utils/interfaces/configurable-module-async-options.interface.d.ts:31-35`).
3. Extras are stripped from the sync options value only if their key appears in the default extras object (E1, case B). A default of `{}` leaks extras into the options value.
4. Passing `extra: undefined` explicitly overrides the default (E1). The spread `{...extras, ...options}` does not skip undefined values (`:128-131`).
5. The transform does not receive async-resolved options. Anything conditional on async config must be decided at runtime (see the nestjs-cls precedent in §1.4).
6. There is no built-in `extraProviders`/`exports`. JWT and cache-manager add `extraProviders` by hand (`X/nestjs-jwt-12.0.1/package/dist/jwt.module.js:20-29`, `X/nestjs-cache-manager-12.0.0/package/dist/cache.module.js:46-55`).
7. A token from `moduleName:'Auth'` is the plain string `'AUTH_MODULE_OPTIONS'`, so any other library using `moduleName:'Auth'` would collide. Random tokens are per-copy strings (dual-package hazard, §8.4).
8. **Module identity is by reference in Nest 11 and 12.** The default `moduleIdGeneratorAlgorithm` is `'reference'` (`N11C/interfaces/nest-application-context-options.interface.d.ts:46-48`, `N11K/injector/container.js:26-28`). Each `forRoot()` call returns a new object and so creates a new module instance (`N11K/injector/opaque-key-factory/by-reference-module-opaque-key-factory.js:17-33`).
   - Verified by `exp-double-forroot.cjs`: importing `Lib.forRoot()` in two places made a global guard run **2 times for one request** (Nest 11 and 12).
   - With `'deep-hash'`, identical options dedupe, but Nest serializes the dynamic metadata. It warns above 10 ms (`deep-hashed-module-opaque-key-factory.js:30-45`), which matters when the options contain a large `auth` instance.

### 1.4 How well-known libraries structure dynamic modules

| Library                      | Structure                                                                                                                                                                                                                                                                                                                             | Notable idioms                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @nestjs/jwt 12.0.1           | Hand-written `register`/`registerAsync`; `global` option copied to `DynamicModule.global`; `extraProviders` (`X/nestjs-jwt-12.0.1/package/dist/jwt.module.js:13-56`)                                                                                                                                                                  | Factory interface `createJwtOptions` (`interfaces/jwt-module-options.interface.d.ts:17-27`)                                                                                                                                                                                                                                                                                                          |
| @nestjs/throttler 6.5.0      | Hand-written `forRoot`/`forRootAsync`; **module class is `@Global()`**; exports all providers (`X/nestjs-throttler-6.5.0/package/dist/throttler.module.js:14-63`)                                                                                                                                                                     | Storage port = abstract class token `ThrottlerStorage`, default via factory unless `options.storage` (`throttler.providers.js:16-24`); `@InjectThrottlerOptions()`/`@InjectThrottlerStorage()` helper decorators (`throttler.decorator.js:38-41`); users add `APP_GUARD` themselves (`DOCS/security/rate-limiting.md:34`)                                                                            |
| @nestjs/passport 12.0.0      | Hand-written `register`/`registerAsync`; options token is the **class** `AuthModuleOptions` (`X/nestjs-passport-12.0.0/package/dist/passport.module.js:10-51`)                                                                                                                                                                        | Class-as-token gives typed injection without `@Inject`                                                                                                                                                                                                                                                                                                                                               |
| @nestjs/cache-manager 12.0.0 | **Uses CMB** `new ConfigurableModuleBuilder({moduleName:'Cache'}).setFactoryMethodName('createCacheOptions')` with no `setExtras`; overrides `register`/`registerAsync` to add `global: options.isGlobal` and `extraProviders` (`X/nestjs-cache-manager-12.0.0/package/dist/cache.module-definition.js:2-6`, `cache.module.js:24-68`) | Because no extras are declared, `isGlobal` stays inside the options value (see limitation 3). Abstract class `Cache` is aliased to `CACHE_MANAGER` via `useExisting` for typed injection (`cache.module.js:59-66`)                                                                                                                                                                                   |
| nestjs-cls 6.3.0             | Hand-written `forRoot`/`forRootAsync`/`forFeature`/`registerPlugins`; root module `@Global()` (`X/nestjs-cls-6.3.0/package/dist/src/lib/cls-module/cls-root.module.js:53-99, 190-195`)                                                                                                                                                | **Always** registers `APP_GUARD` and `APP_INTERCEPTOR` through factories that return either the real enhancer or a no-op, decided from (possibly async) options (`:127-138, :165-186`). Middleware is mounted in `configure()` from options read at runtime via `moduleRef.get` (`:34-44`). Plugins carry their own `imports/providers/exports`/lifecycle hooks (`plugin/cls-plugin.interface.d.ts`) |
| REF 2.8.0                    | CMB `setClassMethodName('forRoot').setExtras({isGlobal:true, disableGlobalAuthGuard:false, disableControllers:false}, ...)`; overrides `forRoot`/`forRootAsync` to conditionally push `{provide: APP_GUARD, useClass: AuthGuard}` (`REF/src/auth-module-definition.ts:60-79`, `REF/src/auth-module.ts:338-404`)                       | APP_GUARD uses `useClass`, which cannot be overridden in tests (§9). The options token is `Symbol("AUTH_MODULE_OPTIONS")`, which is per-copy (§8.4)                                                                                                                                                                                                                                                  |

---

## 2. @nestjs/passport as an OCP precedent

### 2.1 How strategies plug in without editing the guard

- `AuthGuard` is a **memoized mixin factory**: `export const AuthGuard = memoize(createAuthGuard)` (`X/nestjs-passport-12.0.0/package/dist/auth.guard.js:18`).
  - `memoize` caches by `args[0]` (the strategy name, or `'default'`) (`utils/memoize.util.js:1-15`). `AuthGuard('jwt')` therefore always returns the same class, so `overrideGuard(AuthGuard('jwt'))` works.
- The generated class delegates to `passport.authenticate(type || options.defaultStrategy, ...)` (`auth.guard.js:30-44, 81-89`). The guard has no knowledge of any particular strategy.
- A strategy is a DI provider created with `PassportStrategy(Strategy, name)`. Its constructor wraps `validate()` and **registers itself on the global passport singleton**: `passportInstance.use(name, this)` (`passport/passport.strategy.js:4-45`, especially `:31-38`). Adding a strategy means adding a provider class. The core guard is untouched, which is the OCP property.
- Template-method seams on the guard: `getRequest`/`getResponse` (transport seam, default `switchToHttp()`), `handleRequest` (error policy, default `throw err || new UnauthorizedException()`), `getAuthenticateOptions` (per-request options), `logIn` (`auth.guard.js:45-63`). `mixin()` gives each generated class a random uid name and applies `@Injectable()` (`N11C/decorators/core/injectable.decorator.js:44-50`).
- The official docs make users subclass for GraphQL by overriding `getRequest()` to return `GqlExecutionContext.create(ctx).getContext().req` (`DOCS/recipes/passport.md:958-971`).

### 2.2 Good for our case

- A strategy is a provider class, so new auth mechanisms are added by extension.
- Template-method hooks give per-transport and per-error-policy customization without forking.
- The memoized factory gives stable class identity per key, which helps testing and dedupes guard instances.
- The throttler guard uses the same template-method approach: `getRequestResponse`, `shouldSkip`, `handleRequest`, `throwThrottlingException`, `getTracker`, `generateKey` are all overridable (`X/nestjs-throttler-6.5.0/package/dist/throttler.guard.js:99-164`).

### 2.3 Bad for our case

- **Global mutable singleton plus constructor side effect.** Registration happens only if Nest instantiates the strategy provider (`passport.strategy.js:31-38`). Strategies cannot be request-scoped: "Nest will never instantiate it since it's not tied to any specific route" (`DOCS/recipes/passport.md:887-889`; `DOCS/fundamentals/provider-scopes.md:53`).
- **Stringly-typed coupling** between `AuthGuard('name')` and `PassportStrategy(S, 'name')`. A typo only fails at runtime.
- **HTTP-centric defaults.** `getRequest` uses `switchToHttp()` (`auth.guard.js:45-47`), so every other transport requires subclassing. The guard mutates `request[property] = user` and `request.authInfo` (`:42, :83`). Errors are always `UnauthorizedException` (HTTP) (`:55-60`), which degrades on WS/RPC (§5).
- **Testing:** overriding a strategy provider with a mock skips the constructor, so `passport.use` never runs. Because the registry is process-global, a strategy registered by another test in the same process may still be present (test pollution). **UNVERIFIED at runtime**, derived from `passport.strategy.js:31-38`.
- **Random mixin class names** (`uid(21)`) appear in DI error messages (`injectable.decorator.js:45-47`).
- Better-auth has no strategy/serializer model. Its integration model is "mount one handler, then `auth.api.getSession({headers})`" (covered in other research). The part of passport worth reusing is _DI-provided extension classes plus template-method seams_, not the global registry.

---

## 3. Guards and metadata

### 3.1 SetMetadata / applyDecorators / createDecorator

- `SetMetadata(key, value)` stores on `descriptor.value` (the handler function) for methods, or on the class for classes (`N11C/decorators/core/set-metadata.decorator.js:20-31`). Metadata keys can be any type, including symbols.
- `applyDecorators(...ds)` applies each decorator. On a class it calls `decorator(target)` with no descriptor (`N11C/decorators/core/apply-decorators.js:13-23`).
- **`Reflector.createDecorator<T>({key?, transform?})`** (`N11K/services/reflector.service.js:15-25`; unchanged in 12):
  - The default key is `uid(21)`, generated **at module-evaluation time** (`:16`). `key` is typed `string` only (`services/reflector.service.d.ts:10`).
  - A no-arg call stores `{}`, not `true`/`undefined` (`value ?? {}`, `:21`; E2 printed `stored value = {}`).
  - Types: `ReflectableDecorator<TParam>` is `(opts?: TParam) => CustomDecorator`, so the argument is always optional. `reflector.get(Decorator, target)` and `getAllAndOverride` return `TTransformed`, not `TTransformed | undefined`, although they return `undefined` when metadata is absent (`reflector.service.d.ts:21-23, 50, 101`).
- `DiscoveryService.createDecorator<T>()` has **no key option** and always uses `uid(21)` (`N11K/discovery/discovery-service.js:22-32`; unchanged in 12).

### 3.2 getAllAndOverride / getAllAndMerge semantics (`reflector.service.js:58-98`) and E2 results

- `getAllAndOverride(key, [handler, class])` returns the first non-`undefined` value in array order. `false`/`null`/`0` count as values.
- `getAllAndMerge`:
  - drops `undefined`;
  - a single remaining object (arrays count) is returned as-is, and a single primitive is wrapped in an array;
  - with several values, it reduces by: array → `concat`; both plain objects → spread; otherwise `[a, b]`.
- E2 outputs: `getAllAndMerge(string handler, array class) = ["admin",["user"]]` (nested array for mixed types); `getAllAndMerge(array, array) = ["admin","user"]`; `getAllAndOverride = ["admin"]`.
- Inheritance (E2): class metadata is inherited through the prototype chain. Method metadata is lost when a subclass overrides the method, and kept when the method is inherited: `inherited class meta: base-class | overridden method meta: undefined | non-overridden method meta: base-method`.

### 3.3 APP_GUARD mechanics

- `APP_GUARD` (`'APP_GUARD'`, `N11K/constants.js:14`) is special-cased by the scanner. Each registration is renamed `APP_GUARD (UUID: …)` and recorded in `applicationProvidersApplyMap` (`N11K/scanner.js:231-264`). After instantiation, singleton guards go to `applicationConfig.addGlobalGuard(instance)` and request/transient-scoped ones to `addGlobalRequestGuard(wrapper)` (`scanner.js:347-383`).
  - Multiple APP_GUARDs run in registration order (`DOCS/guards.md:145`). APP_GUARD "cannot be retrieved later with `app.get()` or injected" (same line).
  - Nest has no general multi-provider (`N11C/interfaces/modules/provider.interface.d.ts:9` lists no `multi` option). APP_* tokens are the only framework-level "collections".
- Guards referenced by class in `@UseGuards(G)` are instantiated as **injectables of the host module**. `GuardsContextCreator.getInstanceByMetatype` looks in `moduleRef.injectables` of the controller/resolver module (`N11K/guards/guards-context-creator.js:41-52`; scanner registers them via `reflectDynamicMetadata` → `insertInjectable`, `scanner.js:137-168`). The guard's dependencies must therefore be resolvable from that module, which in practice means global or exported-and-imported providers.
- **A request-scoped APP_GUARD makes every controller request-scoped.** `addScopedEnhancersMetadata` attaches the scoped enhancer to all controllers and entry providers (`scanner.js:334-346`), and the dependency-tree introspection includes enhancers (`N11K/injector/instance-wrapper.js:150-169`). Verified by `exp-scoped-guard.cjs` (Nest 11 and 12): `after bootstrap {guardCtor:0, ctlCtor:0} after 3 requests {guardCtor:3, ctlCtor:3}`.
- Global guards are read from `ApplicationConfig` only when `GuardsContextCreator` is constructed **with** `config` (`guards-context-creator.js:53-68`). Which transports pass it is the key to §3.4.

### 3.4 Guards on controllers vs resolvers vs gateways vs message handlers

| Target                                                                           | Where guards run                                                                                                                                                                                                                    | Global (APP_GUARD / useGlobalGuards) applies?                                                                                                                                                                                                                                                                                                                                                                  | Guard-returns-false exception                                                                                        |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| HTTP controllers                                                                 | Route handlers via `RouterExecutionContext`                                                                                                                                                                                         | Yes                                                                                                                                                                                                                                                                                                                                                                                                            | `ForbiddenException('Forbidden resource')` (`N11K/router/router-execution-context.js:133-141`)                       |
| GraphQL resolvers                                                                | Via `ExternalContextCreator.create(..., 'graphql')`. Built with `container.applicationConfig` (`N11K/helpers/external-context-creator.js:31-42`)                                                                                    | Yes                                                                                                                                                                                                                                                                                                                                                                                                            | `ForbiddenException` (HTTP class!) (`external-context-creator.js:153-161`)                                           |
| GraphQL `@ResolveField` (and other property resolvers, e.g. reference resolvers) | Guards/filters/interceptors are **off** unless `fieldResolverEnhancers: ['guards', …]`; `__typename` never has enhancers (`N11GQL/dist/services/resolvers-explorer.service.js:88-104`; `DOCS/graphql/guards-interceptors.md:91-99`) | Only if enabled                                                                                                                                                                                                                                                                                                                                                                                                | same                                                                                                                 |
| WS gateways                                                                      | Only `@SubscribeMessage` handlers (`N11WS/context/ws-context-creator.js:27-54`). `afterInit`/`handleConnection`/`handleDisconnect` are invoked directly and never guarded (`N11WS/web-sockets-controller.js:70-85`)                 | **Nest 11: NO.** `new GuardsContextCreator(container)` without config (`N11WS/socket-module.js:81`; same in 11.2.3 `X/nestjs-websockets-11.2.3/package/socket-module.js:81`). **Nest 12: YES.** `new GuardsContextCreator(container, config)` (`X/nestjs-websockets-12.0.1/package/socket-module.js:88`)                                                                                                       | `WsException('Forbidden resource')` (`ws-context-creator.js:61-67`)                                                  |
| RPC message/event handlers                                                       | `RpcContextCreator`                                                                                                                                                                                                                 | Yes for standalone microservices (`X/nestjs-microservices-11.1.17/package/microservices-module.js:22`). **Hybrid apps get a fresh `ApplicationConfig` unless `connectMicroservice(opts, {inheritAppConfig: true})`** (`N11K/nest-application.js:125-131`; `DOCS/faq/hybrid-application.md:84-92`), so APP_GUARD does not apply to hybrid microservice handlers by default (code plus docs; not runtime-tested) | `RpcException('Forbidden resource')` (`X/nestjs-microservices-11.1.17/package/context/rpc-context-creator.js:57-65`) |

**Runtime confirmation (`exp-ws-global-guard.cjs`, socket.io):**

```
Nest 11 mode=allow       guardCalls=0 ... {"ack":"pong"}   # APP_GUARD never runs for gateway messages
Nest 12 mode=allow       guardCalls=1 ... {"ack":"pong"}
Nest 11 mode=throw-http  guardCalls=0 ... {"ack":"pong"}   # gateway is UNPROTECTED by a global guard on Nest 11
Nest 12 mode=throw-http  guardCalls=1 ... {"exceptionEvent":{"status":"error","message":"Internal server error","cause":{"pattern":"ping","data":{}}}}
```

- Docs disagreement: `DOCS/guards.md:120` says `useGlobalGuards()` "doesn't set up guards for gateways and microservices" **in hybrid apps**, which implies they do apply otherwise. The Nest 11 code and experiment show they **never** apply to gateways. Nest 12 applies them, and the v12 migration guide does not list this change (`DOCS/migration.md` headings, §0.1).
- GraphQL guard invocations are per root field: one HTTP request querying 3 root fields ran the global guard **3 times** (`exp-gql-guard.cjs`: `guard invocations (one HTTP request, 3 root fields): 3`). The guard wrapper runs per resolver call (`external-context-creator.js:71-76`).

---

## 4. ExecutionContext across transports

### 4.1 `getType()` values and argument layout

- `ContextType = 'http' | 'ws' | 'rpc'` (`N11C/interfaces/features/arguments-host.interface.d.ts:1`). GraphQL sets `'graphql'` via the `contextType` argument of `ExternalContextCreator.create` (`resolvers-explorer.service.js:111,118`). `GqlContextType = 'graphql' | ContextType` (`N11GQL/dist/services/gql-execution-context.d.ts:4`).
- `ExecutionContextHost` is a thin view over `args` (`N11K/helpers/execution-context-host.js:4-49`):
  - `switchToHttp()` → `getRequest()=args[0]`, `getResponse()=args[1]`, `getNext()=args[2]`;
  - `switchToWs()` → `getClient()=args[0]`, `getData()=args[1]`, `getPattern()=args[last]`;
  - `switchToRpc()` → `getData()=args[0]`, `getContext()=args[1]`.
  - `switchTo*` mutates and returns the same object (`Object.assign(this, …)`).

### 4.2 Obtaining request / handshake / metadata

| Transport                                | Where the credentials live                                                                                                                                                                                                                                                                                                                                                 | Citation                                                                                                                                                                                                                                    |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTP Express                             | `switchToHttp().getRequest()` is Express `req` (`req.headers`, IncomingHttpHeaders)                                                                                                                                                                                                                                                                                        | `execution-context-host.js:35-41`                                                                                                                                                                                                           |
| HTTP Fastify                             | `getRequest()` is **FastifyRequest** (`.headers`, raw node request at `.raw`). **Nest middleware receives `req.raw`/`reply.raw`**, not the Fastify wrappers, and runs in the `onRequest` hook by default                                                                                                                                                                   | `X/nestjs-platform-fastify-11.1.17/package/adapters/middie/fastify-middie.js:178-218` (same in 12.0.1: `:178`, `:216`); `fastify-adapter.js:373-409`                                                                                        |
| GraphQL                                  | `context.getArgByIndex(2)` or `GqlExecutionContext.create(ctx).getContext()`. Both drivers ensure `ctx.req` (Apollo: `req: contextOrRequest.req ?? contextOrRequest`; Mercurius: `(req) => ({ req })`)                                                                                                                                                                     | `N11APO/dist/drivers/apollo-base.driver.js:196-230`; `X/mercurius/package/dist/drivers/mercurius.driver.js:42-68`; runtime: `exp-gql-guard.cjs` printed `{"type":"graphql","hasReq":true,"hasHeaders":true}`                                |
| GraphQL, reference/resolveType resolvers | Arg layout differs: 3 args, context at index 1. `GqlExecutionContext.create` normalizes by inserting `undefined` (`normalizeResolverArgs`, which uses `graphql`'s `isType`)                                                                                                                                                                                                | `N11GQL/dist/utils/normalize-resolver-args.js`; `gql-execution-context.js:7-12`                                                                                                                                                             |
| GraphQL subscriptions (graphql-ws)       | `GqlSubscriptionService` passes the (driver-wrapped) `options.context` to `graphql-ws` `useServer`. graphql-ws's context object has no `.req`, so Apollo's wrapper sets `req` to the graphql-ws ctx (`{connectionParams, extra:{request, socket}}`). Upgrade-request headers would be at `req.extra.request.headers`. **Derived from code reading; UNVERIFIED at runtime** | `N11GQL/dist/services/gql-subscription.service.js:28-37`; `N11APO/dist/drivers/apollo.driver.js:25-32`; `apollo-base.driver.js:196-216`; same in 14.0.0 (`X/nestjs-graphql-14.0.0/package/dist/services/gql-subscription.service.js:20-24`) |
| WS socket.io                             | `switchToWs().getClient()` is a socket.io `Socket`: `handshake.headers` (IncomingHttpHeaders), `handshake.auth`, `handshake.query`, a `data` bag, and a `request` getter (IncomingMessage)                                                                                                                                                                                 | socket.io 4.8.3 `dist/socket-types.d.ts:17-53`, `dist/socket.d.ts:59,64,474`                                                                                                                                                                |
| WS `ws` adapter                          | Client is a bare WebSocket with no headers. The upgrade `IncomingMessage` is only passed to `handleConnection(client, request)` (connection event emitted as `(ws, request)`)                                                                                                                                                                                              | `X/platform-ws/package/adapters/ws-adapter.js:144`; `N11WS/adapters/ws-adapter.js:22-24`                                                                                                                                                    |
| RPC                                      | `getData()` = payload; `getContext()` = transport ctx: `NatsContext.getHeaders()`, `KafkaContext.getMessage()` (`.headers`), `RmqContext.getMessage()` (`.properties.headers`), `MqttContext.getPacket()`, `TcpContext` and `RedisContext` carry no headers                                                                                                                | `X/nestjs-microservices-11.1.17/package/ctx-host/*.context.d.ts`; `server/server-nats.js:96`, `server-tcp.js:60`                                                                                                                            |
| RPC gRPC                                 | Handler args are `(data, metadata: Metadata, call)`, so metadata is `getArgByIndex(1)`                                                                                                                                                                                                                                                                                     | `X/nestjs-microservices-11.1.17/package/server/server-grpc.js:189,203`                                                                                                                                                                      |

### 4.3 createParamDecorator per transport

- `createParamDecorator(factory)` stores a custom arg entry keyed by a random `uid(21)` paramtype (`N11C/decorators/http/create-route-param-metadata.decorator.js:16-32`).
- All four context creators evaluate custom decorators through `contextUtils.getCustomFactory(factory, data, contextFactory)`, where `contextFactory` builds an `ExecutionContextHost` with the transport's `contextType` (`N11K/helpers/context-utils.js:41-53`). Call sites: HTTP `router-execution-context.js:104-106`, GraphQL `external-context-creator.js:121-123`, WS `ws-context-creator.js:95-97`, RPC `rpc-context-creator.js:91-93`. **One decorator therefore works on every transport** if it branches on `ctx.getType()`.
- **Async factories only work by accident.** On HTTP, a custom param value goes through `await this.getParamValue(value, …)`. That awaits a Promise returned by the factory only when **no pipes** apply; with pipes, the Promise itself is handed to `pipesConsumer.apply` (`router-execution-context.js:118-151`). REF's `@Session()` factory is `async` (`REF/src/decorators.ts:172-178`). Param factories should be synchronous.

---

## 5. Exception handling per transport

### 5.1 GraphQL

- `@nestjs/graphql` core (13.2.4 and 14.0.0) contains **no** HttpException-to-GraphQL mapping: grep for `HttpException|UNAUTHENTICATED` in `N11GQL/dist` and `X/nestjs-graphql-14.0.0/package/dist` returned nothing.
- In the GraphQL context, Nest's `ExternalExceptionFilter` rethrows the exception after invoking custom filters, and does not log `IntrinsicException`s (`N11K/exceptions/external-exception-filter.js`, `external-exceptions-handler.js`). `HttpException extends IntrinsicException` (`N11C/exceptions/http.exception.js:14`).
- **The Apollo driver does the mapping** (`autoTransformHttpErrors`, default true). Its `formatError` wrapper maps 400→`BAD_REQUEST`, 422→`BAD_USER_INPUT`, **401→`UNAUTHENTICATED`, 403→`FORBIDDEN`**, other statuses → `INTERNAL_SERVER_ERROR` + `status`, and adds `extensions.originalError` (`N11APO/dist/drivers/apollo-base.driver.js:17-22, 144-194`; same logic in 14.0.0 `X/nestjs-apollo-14.0.0/package/dist/drivers/apollo-base.driver.js:13-16, 220-253`).
  - Doc/code disagreement: the 14.0.0 option doc says it "will register a global interceptor" (`X/nestjs-apollo-14.0.0/package/dist/interfaces/apollo-driver-config.interface.d.ts:35-40`), but the implementation is a `formatError` wrapper.
- **Runtime (Nest 11 + @nestjs/apollo 13.2.4, `exp-gql-guard.cjs`):**
  ```
  HTTP status 200
  errors [{"path":["needsAuth"],"message":"Unauthorized","code":"UNAUTHENTICATED"},{"path":["forbidden"],"message":"Forbidden resource","code":"FORBIDDEN"}]
  data {"needsAuth":null,"forbidden":null,"open":"z"}
  ```
- **Mercurius:** `@nestjs/mercurius` 14.0.0 has no HttpException mapping (grep of `X/mercurius/package/dist`). mercurius 16.10.0's `defaultErrorFormatter` serializes `error.toJSON()` and uses `originalError.statusCode` only for the HTTP status (`X/mercurius-core/package/lib/errors.js:37-77`). Nest `HttpException` exposes `status`/`getStatus()` rather than `statusCode`, so no `extensions.code` would be produced. **Code-derived; UNVERIFIED at runtime.**
- Global filters **do** apply to GraphQL (`ExternalExceptionFilterContext` built with config, `external-context-creator.js:38`; `N11K/exceptions/external-exception-filter-context.js:25-28`). An HTTP-only global filter that calls `host.switchToHttp().getResponse().status()` will misbehave for GraphQL; the docs say to use `GqlArgumentsHost` (`DOCS/graphql/guards-interceptors.md:50-62`).

### 5.2 WebSockets

- `WsException(error: string | object)` stores `error`, sets `message` from a string or `.message` (`N11WS/errors/ws-exception.js`).
- `BaseWsExceptionFilter`:
  - For a `WsException`, it emits `'exception'` with the object as-is, or `{status:'error', message, cause:{pattern,data}}`.
  - For **any other error, including HttpException**, it emits `{status:'error', message:'Internal server error'}` and logs only non-intrinsic errors (`N11WS/exceptions/base-ws-exception-filter.js`; `N11K/constants.js:8`; unchanged in 12).
- **Global filters never apply to gateways, in 11 or 12**: WS `ExceptionFiltersContext.getGlobalMetadata()` returns `[]` (`N11WS/context/exception-filters-context.js:25-27`; `X/nestjs-websockets-12.0.1/package/context/exception-filters-context.js:21-23`). Runtime: `mode=throw-http+global-filter ... filterCalls=0` on both versions, and the client still received `"Internal server error"`.
- Docs: "instead of throwing `HttpException`, you should use `WsException`" (`DOCS/websockets/guards.md:3`, `DOCS/websockets/exception-filters.md:3`).

### 5.3 RPC

- `RpcException(error: string | object)` has the same shape as `WsException` (`X/nestjs-microservices-11.1.17/package/exceptions/rpc-exception.js`).
- `BaseRpcExceptionFilter`: an `RpcException` becomes `throwError(() => isObject(res) ? res : {status:'error', message: res})`; **anything else becomes `{status:'error', message:'Internal server error'}`** (`exceptions/base-rpc-exception-filter.js`; unchanged in 12).
- Global filters apply to RPC (`context/exception-filters-context.js:28-40`), except in hybrid apps without `inheritAppConfig` (`DOCS/microservices/exception-filters.md:48`).
- REF's RPC mapping throws plain `new Error("UNAUTHORIZED")` (`REF/src/auth-guard.ts:114-117`), which reaches the client as "Internal server error".

### 5.4 gRPC (Nest 12 only)

- `@nestjs/microservices` 12 adds `GrpcException` subclasses such as `GrpcUnauthenticatedException` and `GrpcPermissionDeniedException` (`X/nestjs-microservices-12.0.1/package/exceptions/grpc-exception.d.ts:33,60`).
- It also adds an opt-in `@Catch()` `GrpcExceptionFilter` that maps `GrpcException`, or `RpcException` with a numeric `code`/`status`, to gRPC status; everything else becomes `UNKNOWN` (`exceptions/grpc-exception-filter.js`).
- Nest 11.2.3 has none of these files (`X/nestjs-microservices-11.2.3/package/exceptions/` listing).

### 5.5 Is per-transport error mapping in the guard necessary?

| Transport           | Can an exception filter own the mapping?                                         | What the guard must throw                          | Evidence     |
| ------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------- | ------------ |
| HTTP                | Yes. HttpException is native                                                     | HttpException (or return `false`, which gives 403) | §3.4         |
| GraphQL + Apollo    | Yes (driver)                                                                     | HttpException works                                | §5.1 runtime |
| GraphQL + Mercurius | No driver mapping. Codes would need a GraphQL-aware filter or error              | a GraphQL-aware error                              | code-derived |
| WS                  | **Only through gateway-local `@UseFilters`**, because global filters are ignored | `WsException` (or return `false`)                  | §5.2 runtime |
| RPC                 | Yes, a global RPC filter can map (not in hybrid apps without `inheritAppConfig`) | otherwise `RpcException` / gRPC exceptions         | §5.3/§5.4    |

---

## 6. DiscoveryService, MetadataScanner, discoverable decorators

### 6.1 APIs

- `DiscoveryModule` provides/exports `DiscoveryService` and `MetadataScanner` (`N11K/discovery/discovery-module.js:11-19`).
- `getProviders(options?, modules?)`: with `{metadataKey}` it returns wrappers indexed at scan time; otherwise all providers of all modules (or `{include:[ModuleClass]}`). Same for `getControllers` (`N11K/discovery/discovery-service.js:40-62, 80-92`).
- `getMetadataByDecorator(decorator, wrapper, methodKey?)` reads `decorator.KEY` from `wrapper.instance[methodKey]`, or from `instance.constructor ?? metatype` (`:70-76`).
- `MetadataScanner.getAllMethodNames(proto)` walks the prototype chain up to `Object.prototype`. It uses `getOwnPropertyNames`, so **string keys only, not symbol-keyed methods**, and skips getters/setters/constructor. Results are cached per prototype (`N11K/metadata-scanner.js:52-81`).

### 6.2 `DiscoveryService.createDecorator()` specifics and limitations

- A class-level application calls `DiscoverableMetaHostCollection.addClassMetaHostLink(target, key)`, i.e. `metaHostLinks.set(target, key)`, a **Map keyed by class holding ONE key** (`N11K/discovery/discoverable-meta-host-collection.js:10-12, 88`).
- Method-level application only sets metadata and does not register the class (`discovery-service.js:25-28`).
- Indexing happens when the provider is added to the container (`N11K/injector/container.js:157-169`, `inspectProvider` at `:167`).
- **E3 (runtime, 11 and 12):** a class decorated with two discoverable decorators is found only under the outermost one: `getProviders({metadataKey: HookA.KEY}) -> ['Both']`, `getProviders({metadataKey: HookB.KEY}) -> ['OnlyB']`, while `Reflect.getMetadata(HookB.KEY, Both)` still returns `{}`.
- **`exp-discovery-factory.cjs` (runtime, 11 and 12):** the `metadataKey` filter finds only class providers: `['Decorated','VIA_CLASS']`. Iterating all providers and calling `getMetadataByDecorator` finds `['Decorated','VIA_FACTORY','VIA_VALUE','VIA_CLASS']`. At scan time `instance` is not created yet, so the lookup falls back to the factory function or `null` (`discoverable-meta-host-collection.js:67-82`).
- The key is random per module evaluation (§3.1), so a second copy of the library (dual package) produces different keys.

### 6.3 Request-scoped, transient, alias and lazy-loaded providers

- **Request-scoped (or any provider whose tree is non-static):**
  - At bootstrap Nest stores `Object.create(metatype.prototype)` as the static-context instance and **does not call the constructor** (`N11K/injector/injector.js:28-41`, `instance-wrapper.js:216-222`, `injector.js:407-433` via `isInContext`).
  - E5 (11 and 12): `{"name":"ReqScoped","static":false,"hasInstance":true,"instanceIsProtoOnly":true,"hookResult":"undefined"}` and `ReqScoped ctor calls during bootstrap = 0`. A singleton depending on it also became non-static (`DependsOnReq ... static:false`). Calling a discovered method on such an instance runs without injected dependencies.
  - Precedents:
    - @nestjs/schedule warns and skips non-static providers (`X/nestjs-schedule-12.0.1/package/dist/schedule.explorer.js:33, 46-48, 91-101`).
    - @nestjs/event-emitter resolves per event via `ContextIdFactory.getByRequest` + `moduleRef.registerRequestByContextId` + `injector.loadPerContext` (`X/nestjs-event-emitter-12.0.0/package/dist/event-subscribers.loader.js:52, 86-99`). It deep-imports `@nestjs/core/injector/injector.js` (`:15`).
- **Aliases:** event-emitter filters `wrapper.instance && !wrapper.isAlias` (`event-subscribers.loader.js:48`). Without that filter, a `useExisting` alias of a hook provider would be processed twice.
- **Duplicates:** the same class listed in two modules gives two wrappers/instances, which is inherent to `getProviders()`.
- **Lazy-loaded modules:**
  - `LazyModuleLoader.load` scans and instantiates into the same container but calls **no lifecycle hooks** (`N11K/injector/lazy-module-loader/lazy-module-loader.js:14-34`; `DOCS/fundamentals/lazy-loading-modules.md:9`). Controllers, resolvers, gateways and middleware in lazy modules "will not behave as expected" (`:100-104`).
  - Discovery done at bootstrap will not see lazily loaded providers.
  - That an `APP_GUARD` declared in a lazily loaded module is never applied is **UNVERIFIED**: `applyApplicationProviders` is only called during initial bootstrap (`scanner.js:347`), but this was not traced end-to-end.

### 6.4 Timing: onModuleInit vs onApplicationBootstrap

- `NestApplication.init()` order: `httpAdapter.init` → body-parser middleware → `registerModules()` (WS gateways connected, microservices registered, **`configure(consumer)` middleware of every module**) → `registerRouter()` → **`callInitHook()`** → `registerRouterHooks()` → **`callBootstrapHook()`** (`N11K/nest-application.js:79-109`; Nest 12 adds async `loadSocketModule`/`loadMicroservicesModule` first, `X/nestjs-core-12.0.1/package/nest-application.js:103-119`).
  - All static instances exist before any hook runs.
  - `configure()` runs **before** `onModuleInit`.
- Hooks iterate modules by `distance` descending (`N11K/nest-application-context.js:249-254, 308-319`). **Global modules get `distance = Number.MAX_VALUE` "to ensure their lifecycle hooks are always executed first"** (`N11K/injector/container.js:104-110`). Non-global modules get their depth from the root (`N11K/scanner.js:201-218`).
  - A **global** library module's `onModuleInit` therefore runs before any non-global user module's `onModuleInit`, e.g. before seeding code that calls `auth.api.*`.
- Within a module: Nest 11 calls non-transient then transient instances, then the module class (`N11K/hooks/on-module-init.hook.js:31-53`). **Nest 12 groups by hierarchy level, dependencies first** (`X/nestjs-core-12.0.1/package/hooks/on-module-init.hook.js`; `DOCS/migration.md:185-189`).
- Precedents: @nestjs/schedule explores in `onModuleInit`; @nestjs/event-emitter in `onApplicationBootstrap`; REF in `onModuleInit` (`REF/src/auth-module.ts:123-180`).

---

## 7. Per-request state

- **Cost of request scope:** "it will slow down your average response time… a properly designed application… should not slow down by more than ~5% latency-wise" (`DOCS/fundamentals/provider-scopes.md:148-152`, docs claim). REQUEST scope "bubbles up the injection chain" (`:71`). WS gateways and passport strategies must not be request-scoped (`:53`), but Nest 12 adds request-scoped gateway dependencies, one per socket (`DOCS/websockets/gateways.md:284-304`).
- **Library-guard impact, measured:** a request-scoped APP_GUARD re-instantiated every controller per request (`exp-scoped-guard.cjs`, §3.3).
- **Durable providers:** a `ContextIdStrategy` groups requests into shared DI sub-trees, with `@Injectable({scope: Scope.REQUEST, durable: true})`; durability also bubbles (`DOCS/fundamentals/provider-scopes.md:154-243`).
- **AsyncLocalStorage:**
  - Nest docs present ALS as "an alternative to REQUEST-scoped providers". The hand-rolled example wraps `next()` in middleware and is **HTTP-only** (`DOCS/recipes/async-local-storage.md:3-17, 36-62`).
  - **nestjs-cls** can initialize the store through middleware (HTTP), guard, interceptor, or decorator, so it covers GraphQL/WS/RPC (`:232-234`). It keys per-request stores in a WeakMap by the transport's natural request identity (`X/nestjs-cls-6.3.0/package/dist/src/lib/cls-initializers/utils/context-cls-store-map.js:34-53`):
    - http: `request.raw ?? request`, a Fastify workaround because middleware sees the raw request;
    - rpc: `switchToRpc().getContext()`;
    - graphql: `getArgByIndex(2)`;
    - ws: `context.switchToWs()`, i.e. the ExecutionContextHost itself, which differs per guard/interceptor call despite the "data object" comment at `:15`.
  - nestjs-cls detects Fastify by `httpAdapter.constructor.name === 'FastifyAdapter'`. It selects middleware mount paths per Express/Fastify major (`'/'` for Express 5, `'{*path}'` for Fastify 5) (`cls-module/feature-detection.utils.js`, `cls-module/middleware.utils.js`).
- **better-auth's own per-request state** uses ALS stores kept on `globalThis[Symbol.for("better-auth:global")]`, explicitly to survive multiple copies of the package in one process (`BA/packages/core/src/context/global.ts:20-49`, `context/request-state.ts:7-45`).
- **Attaching data to `req`:**
  - Express: one object across middleware, guards, and handlers.
  - Fastify: middleware mutate `req.raw`, while guards and handlers see FastifyRequest (§4.2), so they are different objects.
  - GraphQL: `ctx.req` is the HTTP request for queries/mutations, but the graphql-ws ctx for subscriptions (§4.2, UNVERIFIED at runtime).
  - WS: per connection on the socket (`socket.data`), not per message.
  - RPC: no mutable request object besides the transport ctx.
  - REF writes `request.session` and `request.user` (`REF/src/auth-guard.ts:148-149`). `req.session` is also the property used by express-session and @fastify/session (**UNVERIFIED in this session**; ecosystem knowledge), so collisions are likely.

---

## 8. Optional peer dependencies

### 8.1 `loadPackage`: Nest 11 vs Nest 12 (incompatible)

- **Nest 11** (`N11C/utils/load-package.util.js:7-16`) is **synchronous**: `loaderFn ? loaderFn() : require(packageName)`. On failure it logs "package is missing" and calls **`process.exit(1)`**. A bare `require(packageName)` resolves from @nestjs/common's own location; that is why callers pass `loaderFn = () => require('pkg')`, e.g. `N11GQL/dist/federation/graphql-federation.factory.js:44` and `N11APO/dist/drivers/apollo-base.driver.js:86,119`.
- **Nest 12** (`X/nestjs-common-12.0.1/package/utils/load-package.util.js:11-97`):
  - `loadPackage` is **async** (`await loaderFn()` or `await import(name)`) and still exits the process on failure.
  - New sync `loadPackageSync(name, ctx, loaderFn?)` uses `createRequire(import.meta.url)`.
  - New `loadPackageCached` and `tryLoadPackage` (the latter returns `null` instead of exiting).
  - All of it is exposed via `@nestjs/common/internal` ("not part of the public API", `internal.js:1-16`).
  - The ecosystem switched to `await loadPackage('x', …, () => import('x'))` (`X/nestjs-apollo-14.0.0/package/dist/drivers/apollo-base.driver.js:102,135`) and `loadPackageSync(…, () => nodeRequire(…))` (`X/nestjs-graphql-14.0.0/package/dist/federation/graphql-federation.factory.js:266`).
- `optionalRequire` in core: 11 is sync and returns `{}` on failure (`N11K/helpers/optional-require.js`); 12 is async `import()` (`X/nestjs-core-12.0.1/package/helpers/optional-require.js`).
- **Consequence:** code calling `loadPackage` gets a value on 11 and a Promise on 12, and a missing optional package kills the process. It is internal API in 12.

### 8.2 Behavior under ESM

- In an ESM build, `require` is undefined. Sync loading needs `createRequire(import.meta.url)`, which in turn needs a shim in CJS output; otherwise loading is async `import()`.
- REF, which is ESM-only, lazily `await import("@nestjs/graphql")` / `import("@nestjs/websockets")` inside the guard (`REF/src/utils.ts:4-13`, `REF/src/auth-guard.ts:66-78`).

### 8.3 Ecosystem patterns for optional integrations

- **Separate packages per integration:** GraphQL drivers `@nestjs/apollo`/`@nestjs/mercurius` implement `AbstractGraphQLDriver`; HTTP platforms `@nestjs/platform-express`/`-fastify` implement `AbstractHttpAdapter`; nestjs-cls plugins are published separately (§1.4).
- **Lazy load at first use** with a caller-supplied `loaderFn` (§8.1).
- **Subpath entry points:** `@nestjs/graphql/plugin` (`X/nestjs-graphql-14.0.0/package/package.json` exports `./plugin`); better-auth exposes `better-auth/node`, `better-auth/api`, `better-auth/plugins` (imports in `REF/src/auth-module.ts:15-16`, `REF/src/auth-guard.ts:13-14`).
- **Counter-examples to OCP:**
  - the Apollo driver hard-codes `if express … else if fastify … else throw 'No support for current HttpAdapter'` (`N11APO/dist/drivers/apollo.driver.js:35-46`);
  - nestjs-cls switches on the adapter constructor name (above);
  - REF branches on `adapterType === 'fastify'` in several places (`REF/src/auth-module.ts:191, 219-232, 245-253`).

### 8.4 Dual CJS+ESM hazards specific to Nest DI

- If both builds of a library load in one process, every module-level identity is duplicated:
  - class tokens;
  - `Symbol()` tokens (REF uses `Symbol("AUTH_MODULE_OPTIONS")`, `REF/src/auth-module-definition.ts:58`);
  - `Reflector.createDecorator()`/`DiscoveryService.createDecorator()`/`createParamDecorator()` keys, which come from `uid(21)` at evaluation time (`reflector.service.js:16`, `discovery-service.js:23`, `create-route-param-metadata.decorator.js:17`).
- For Nest itself, `require(esm)` and `import` share one instance (`EXP/n12/req-test.cjs` → `true`). Nest 12 is ESM-only, so no Nest-side duplication exists on 12.
- The better-auth precedent for surviving copies is `Symbol.for` on `globalThis` (§7).
- **tsdown decorator metadata:** tsdown 0.23.0 (oxc runtime 0.149.0) emits `__decorateMetadata("design:paramtypes", [typeof X === "undefined" ? Object : X, …])` when `emitDecoratorMetadata` is set (`EXP/tsdown-test/dist/index.mjs`, CJS output `dist/index.cjs:41`). Types that isolated transpilation cannot resolve (interfaces, type-only imports) become `Object`, so explicit `@Inject(token)` is the robust choice. REF injects everything explicitly, e.g. `REF/src/auth-module.ts:92-103`. tsdown's default output for a `"type":"module"` package was `index.mjs` + `index.cjs` + `.d.mts`/`.d.cts`.

---

## 9. Testing idioms

- `TestingModuleBuilder`:
  - `overrideGuard/Pipe/Filter/Interceptor(x)` replace entries in module **injectables**;
  - `overrideProvider(x)` replaces **providers**;
  - `overrideModule(M).useModule(N)`;
  - `useMocker(factory)` fills missing dependencies
    (`N11T/testing-module.builder.js:31-50, 79-96`; `N11K/injector/module.js:344-356`; `DOCS/fundamentals/unit-testing.md:171-183, 322-336`).
- **E4, APP_GUARD overriding (runtime, 11 and 12; guard returns false, so 403 means "override failed"):**
  ```
  baseline APP_GUARD useClass (no override)            -> 403
  APP_GUARD useClass + overrideGuard(G)                -> 403   # not overridable
  APP_GUARD useClass + overrideProvider(G)             -> 403   # not overridable
  APP_GUARD useClass + overrideProvider(APP_GUARD)     -> 403   # not overridable (token renamed APP_GUARD (UUID…))
  G + APP_GUARD useExisting G + overrideProvider(G)    -> 200   # works
  @UseGuards(G) + overrideGuard(G)                     -> 200   # works for decorator-bound guards
  ```
  This matches the docs' "Overriding globally registered enhancers" section, which recommends `useExisting` (`DOCS/fundamentals/unit-testing.md:393-420`).
- **`overrideModule` needs identity.** It matches with `moduleToReplace === module` (`N11K/scanner.js:305-313`). A dynamic module created inline (`AuthModule.forRoot({...})`) cannot be targeted by passing the class. Code-derived.
- **better-auth 1.7.4 ships `testUtils()`** (exported from `better-auth/plugins`, `BA/packages/better-auth/src/plugins/index.ts:25`). It provides `test.login({userId})` returning `{session,user,headers,cookies,token}`, `test.getAuthHeaders({userId})` returning a `Headers` with a session cookie, `getCookies`, factories, DB helpers and OTP capture. Docs recommend a test-only auth instance (`BA/docs/content/docs/plugins/test-utils.mdx:13-40, 155-200`). This allows exercising the real guard path end-to-end without mocking.
- Precedents for mockable seams:
  - throttler's `ThrottlerStorage` abstract-class token (`throttler.providers.js:16-28`);
  - cache-manager's `Cache` alias;
  - passport's memoized guard classes, overridable via `overrideGuard(AuthGuard('jwt'))` thanks to `memoize.util.js`.

---

## 10. Design implications (not a design)

1. **Support Nest 11 and Nest 12**, since 12 is released: peers `@nestjs/* ^11 || ^12` and `@nestjs/graphql ^13 || ^14`. The CJS build will `require()` ESM Nest 12, which requires Node ≥ 20.19/22.12 (§0.1). Test on both majors: WS global-guard behavior and hook ordering differ (§3.4, §6.4).
2. **Transport-agnostic core, transport adapters by extension:**
   - Credential extraction differs per transport and platform: HTTP Express/Fastify, GraphQL (query vs subscription, reference-resolver arg layout), socket.io vs ws, NATS/Kafka/RMQ/gRPC metadata (§4.2).
   - Error mapping differs per transport (§5.5).
   - This maps onto an adapter registry keyed by `context.getType()` (plus HTTP platform `getType()`), which new transports extend without editing core. Avoid the Apollo/nestjs-cls/REF `if express … else fastify` style (§8.3).
3. **Error mapping cannot be delegated to global filters for WS**, in either version (§5.2). The WS adapter (or the guard via the adapter) must produce `WsException`. RPC can use a filter but hybrid apps need `inheritAppConfig`, and gRPC codes exist only on 12 (§5.3-5.4). HTTP and Apollo work with HttpException.
4. **Global guard registration:**
   - Register as `{provide: APP_GUARD, useExisting: X}` plus `X` so consumers can `overrideProvider(X)` (E4).
   - Keep the guard singleton and never inject request-scoped dependencies, or every controller becomes request-scoped (§3.3).
   - Guard against double `forRoot()` imports; with by-reference IDs they double-register (§1.3).
   - On Nest 11 a global guard does **not** protect gateways; on Nest 12 it does, and receives `'ws'` contexts (§3.4). Behavior must be explicit per major.
5. **Conditional features from async options:** CMB extras are static. To let `forRootAsync` config toggle the global guard or middleware, follow nestjs-cls: always register and decide in a factory or no-op at runtime (§1.4).
6. **Authorization strategies (roles, org roles, permissions) should be DI-provided extensions** evaluated by a stable core. REF hard-codes every check inside `canActivate` (`REF/src/auth-guard.ts:140-248`), which violates OCP. Nest has no multi-providers (§3.3). Collections of strategies must come from discovery, an explicit list turned into providers (plugin-module style), or both.
7. **Metadata keys and tokens must be dual-package safe:** explicit namespaced string keys (`Reflector.createDecorator({key})`), `Symbol.for(...)`, or string tokens with `@Inject()` helper decorators (throttler style), following better-auth's own `Symbol.for` precedent (§8.4, §7). Avoid `DiscoveryService.createDecorator()` for markers that other libraries might also put on the same class (one-key-per-class limit, E3), and for keys that need to be stable.
8. **Discovery-based hook registration:**
   - use full scan + `getMetadataByDecorator`, since the `metadataKey` filter misses factory/value providers;
   - filter `isAlias`;
   - handle or warn on non-static providers, whose instances have no dependencies (E5);
   - it runs once, before `onModuleInit` of non-global user modules if the module is global (§6.4);
   - lazy modules are not covered.
9. **Per-request memoization of the session lookup:**
   - GraphQL runs the guard once per root field (3 calls in one request, §3.4), and param decorators and field resolvers may ask again.
   - Keying by request identity needs the Fastify `raw` subtlety (§4.2/§7).
   - Avoid `req.session` and `req.user` names (§7).
10. **Optional integrations:** do not use Nest's `loadPackage`: its signature differs between 11 and 12, it calls `process.exit`, and it is internal in 12. Prefer subpath entry points (e.g. `/graphql`, `/ws`, `/rpc`, `/fastify`, `/testing`) with static imports of their peers, which works identically in CJS and ESM builds (§8).
11. **Param decorators** should be synchronous and branch on `ctx.getType()` via the same adapter registry (§4.3).
12. **Testing story:** document and ship `useExisting`-based guard registration, an overridable session-resolution provider, and better-auth `testUtils()` headers for e2e (§9).
13. **Toolchain:** tsdown emits `design:paramtypes`, but library code should still use explicit `@Inject()` for every constructor parameter (§8.4).

## 11. Pitfalls (quick list)

- Nest 12 is ESM-only. `require('@nestjs/common/package.json')` fails. `loadPackage` is async in 12. `subscriptions-transport-ws` is gone in @nestjs/graphql 14.
- Global APP_GUARD skips WS gateways on Nest 11 (gateways silently unprotected) but runs on Nest 12. HttpException thrown in WS becomes "Internal server error". Global filters never apply to WS.
- In GraphQL, `@ResolveField` resolvers skip guards unless `fieldResolverEnhancers` is set. Guard-false in GraphQL throws `ForbiddenException` (HTTP class).
- `APP_GUARD` with `useClass` cannot be overridden in tests. A request-scoped APP_GUARD makes every controller request-scoped. Importing `forRoot()` twice registers the guard twice.
- CMB extras leak into options unless declared with defaults. Explicit `undefined` overrides defaults. Extras can't come from async config.
- `Reflector.createDecorator()` with no argument stores `{}`. Typed getters hide `undefined`. `getAllAndMerge` nests arrays for mixed types. Overriding a method drops its metadata.
- `DiscoveryService.createDecorator`: one key per class; `metadataKey` filter misses factory/value providers; random keys.
- Request-scoped providers seen by discovery are prototype-only objects with no dependencies.
- On Fastify, middleware see `req.raw`, not FastifyRequest.
- Async `createParamDecorator` factories only work without pipes.
- A mix of CJS and ESM copies of the library duplicates tokens and metadata keys.

## 12. Open questions for the user

1. Nest 12 is released and ESM-only. Should the CJS build be allowed to require Nest 12 (Node ≥ 20.19/22.12 only)? Should both Nest majors be tested in CI?
2. On Nest 11, should the library make a global guard also protect WS gateways (e.g. an explicit gateway guard or interceptor), or document that gateways need `@UseGuards` there? On Nest 12 a global guard will see WS messages: should WS authentication be opt-in or opt-out?
3. Which RPC transports are in scope (TCP/NATS/Kafka/RMQ/gRPC)? Where would better-auth credentials travel (cookie header? bearer in metadata?) given that `getSession` needs `Headers`?
4. Should the per-request session cache be an ALS store (nestjs-cls-like, covers services outside the request object) or a WeakMap keyed by transport request identity?
5. Should the global guard be auto-registered by `forRoot` (REF, nestjs-cls) or added by users via `APP_GUARD` (throttler)?
