# NestJS HTTP platform internals for a platform-agnostic better-auth adapter layer

Research date: 2026-09-10. Scope: NestJS 11.1.17 (installed in the target repo) and NestJS 12.0.1 (released), `@nestjs/platform-express` and `@nestjs/platform-fastify` for both majors, Fastify 5.x, Express 5.x, and better-call 1.4.0 (the version better-auth 1.7.4 pins).

Every claim below is backed by a file:line citation or by a runtime experiment I ran. Experiment scripts are listed in the appendix and can be re-run. Anything I could not verify is marked **UNVERIFIED**.

## Path abbreviations used in citations

| Abbrev                               | Absolute path                                                                                              | Version                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `NC11`                               | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/core`                                | @nestjs/core 11.1.17                             |
| `NPE11`                              | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/platform-express`                    | 11.1.17                                          |
| `NPF11`                              | `…/scratchpad/tmp-nest-platform/v11/nestjs-platform-fastify-11.1.17/package`                               | 11.1.17 (npm pack)                               |
| `NC12` / `NPE12` / `NPF12` / `NCO12` | `…/scratchpad/tmp-nest-platform/v12/nestjs-{core,platform-express,platform-fastify,common}-12.0.1/package` | 12.0.1 (npm pack)                                |
| `FST`                                | `…/scratchpad/tmp-nest-platform/exp11/node_modules/fastify`                                                | fastify 5.8.2 (the version NPF11 pins)           |
| `BC`                                 | `…/scratchpad/tmp-nest-platform/bc/package/dist`                                                           | better-call 1.4.0                                |
| `DOCS`                               | `…/scratchpad/tmp-nest-platform/docs-nestjs/content`                                                       | nestjs/docs.nestjs.com @ 21af05a (2026-08-31)    |
| `BA`                                 | `…/scratchpad/better-auth`                                                                                 | better-auth v1.7.4                               |
| `REF`                                | `…/scratchpad/ref`                                                                                         | @thallesp/nestjs-better-auth v2.8.0 @ 99d4a94    |
| `EXP11` / `EXP12`                    | `…/scratchpad/tmp-nest-platform/exp11` / `exp12`                                                           | experiment projects (Nest 11.1.17 / Nest 12.0.1) |

`…/scratchpad` = `/private/tmp/claude-502/-Users-thilllon-git-nestjs-slightly-better-auth/d03cce33-4991-442c-88b5-c314fe7f3223/scratchpad`. The runtime is Node v22.22.0 on darwin (Apple M4 Pro).

---

## 0. Executive summary (most decision-relevant facts)

1. **NestJS 12 is released.** 12.0.0 shipped 2026-08-27 and 12.0.1 is `latest` (`npm view @nestjs/core time`). 11.x is still maintained (11.2.3, 2026-08-25). All v12 packages are **ESM-only** (`"type": "module"`, NC12/package.json). CommonJS consumers rely on `require(esm)`, so the runtime floor is Node 20.19+ or 22.12+ (DOCS/migration.md:29-40). I verified that `require('@nestjs/core')` v12 works from CJS on Node 22.22 (`process.features.require_module === true`). better-auth 1.7.4 is also ESM-only: its exports have no `require` condition. `require('better-auth/node')` works via `require(esm)`.
2. **Init order is the same in v11 and v12.** The sequence is:
   1. `NestFactory.create` sets the adapter on `HttpAdapterHost`, which fires `init$`.
   2. It calls `adapter.init()`. On Fastify this registers middie.
   3. It instantiates providers, so **constructors run here**.
   4. Then `app.init()` runs these steps in order:
      - `applyOptions()` (CORS from app options)
      - `adapter.init()`
      - **the body parsers** (`registerParserMiddleware`)
      - `configure(consumer)` on all modules
      - middleware registration
      - controller routes
      - `onModuleInit`
      - the 404 and error handlers
      - `onApplicationBootstrap`

   Sources: NC11/nest-factory.js:94-119, NC11/nest-application.js:93-109, NC12/nest-application.js:103-124.

3. **Express is order-sensitive and Fastify is not.**
   - On Express, a route registered in a provider constructor or from `HttpAdapterHost.init$` lands **before** Nest's `jsonParser`/`urlencodedParser`, so the raw stream is untouched.
   - A route registered in `configure()` or `onModuleInit` lands **after** them. JSON and form bodies are already consumed there; `text/plain` and `multipart` are not.
   - On v11, anything registered in `onApplicationBootstrap` or later is **shadowed by Nest's 404 handler**.
   - On Fastify, the registration phase doesn't matter until `listen()`/`ready()`. After that it throws `FST_ERR_INSTANCE_ALREADY_LISTENING`. Root-level routes always get root-level content-type parsers.

   Source: experiment 1 (§2.3).

4. **`bodyParser: false` does not give raw streams on Fastify.** Fastify's built-in `application/json` and `text/plain` parsers still run. With `bodyParser: false`, urlencoded requests get **415**. To get an unconsumed stream on Fastify, use an encapsulated plugin (`register(plugin, {prefix})`) that calls `removeAllContentTypeParsers()` and adds a `'*'` pass-through parser. I verified this leaves `request.raw` readable for JSON, form and multipart, and does not affect other routes (experiment 5).
5. **Three mounting styles, none identical across platforms:**
   - **Raw adapter route** (`getInstance().all(...)`, or a Fastify plugin): no guards, pipes, interceptors, versioning or global prefix. It is still caught by _global_ exception filters (experiment 9). Behaviour is the same on both platforms apart from timing and body state.
   - **Nest middleware:**
     - On Express, a string `forRoutes('x')` becomes `app.use` (prefix mount: `req.url` is rewritten and `baseUrl` is set). A `RouteInfo` with `RequestMethod.ALL` becomes `app.all` (exact pattern, `req.url` intact).
     - On Fastify it is always middie in the `onRequest` hook with raw `IncomingMessage`/`ServerResponse`. The body is not parsed yet. **`@fastify/cors` and `reply.header()` are bypassed.** `forRoutes('api/auth')` without a wildcard matches **only exactly `/api/auth` on Fastify** but is a prefix match on Express (experiment 4b).
   - **Nest controller with `@All(...)`:**
     - It runs through global guards, interceptors and pipes, and gets the global prefix and URI version prefix (use `VERSION_NEUTRAL`).
     - `@All('*path')` and `@All('{*path}')` **fail to boot on Fastify** ("Wildcard must be the last character in the route"). `@All('*')` works on Fastify, and works on Express with a `LegacyRouteConverter` WARN.
     - **On Fastify `@All` silently ignores header or media-type versioning constraints**, because `FastifyAdapter` does not override `all()` (experiment 12).
6. **Web Response write-back:**
   - Express 5.2.1 has no native support: `res.send(new Response(...))` returns `200 "{}"`.
   - Fastify has supported `reply.send(Response)` natively since **4.26.0** and in all of 5.x. It keeps CORS and other `reply.header()` headers, runs `onSend`, and preserves multiple `Set-Cookie`.
   - **Bug:** on a GET route with Fastify's auto-generated HEAD route (the default `exposeHeadRoutes: true`), a HEAD request answered with a `Response` payload returns **500**, because `head-route.js:29` calls `Buffer.byteLength(Response)`. This happens in 5.8.2, 5.12.1 and 5.12.3. Workaround (verified): set the status and headers yourself and `reply.send(response.body)` (a `ReadableStream`), or register HEAD explicitly (`fastify.all`).
   - `reply.hijack()` plus a raw write **loses headers previously set via `reply.header()`** (e.g. `@fastify/cors`) and skips `onSend`. `onResponse` still runs.
7. **better-call's Node bridge (`toNodeHandler`/`getRequest`/`setResponse`) has sharp edges:**
   - It drops the query string when mounted via Express `app.use('/x/*path')`. That is exactly what Nest string-middleware `forRoutes('x/*path')` produces (experiment 6).
   - It throws on HTTP/2 requests (pseudo-headers and a symbol key in `req.headers`; h2 experiment).
   - It re-serializes already-parsed bodies, which is lossy. The better-auth Stripe plugin verifies webhook signatures over `ctx.request.text()` (BA/packages/stripe/src/routes.ts:2027-2041), so a re-serialized body can break it.
8. **`@nestjs/testing` differs from `NestFactory`.** `HttpAdapterHost.httpAdapter` is **undefined in provider constructors** during `Test.createTestingModule().compile()`. It is set later, in `createNestApplication()`. `HttpAdapterHost.init$` is a `ReplaySubject`. Subscribing to it from a constructor fires in both flows before the body parsers, which I verified on Express (experiment 10b).
9. **NestJS 12 Express changes the 404 handler.** With a global prefix, Nest's JSON 404 handler is mounted only under the prefix (NPE12/adapters/express-adapter.js:93-116). Paths outside the prefix fall through to Express's HTML 404. With `setGlobalPrefix('v1')` (no leading slash), **no** Nest 404 is served at all in 12.0.1 (experiment, §7.4). This looks like a regression but is **UNVERIFIED as intended behaviour**. Consequence: in v12 with a prefix, Express routes registered after `init` are reachable. In v11 they are not.

---

## 1. `HttpAdapterHost` and `AbstractHttpAdapter`

### 1.1 `HttpAdapterHost`

- It is a plain holder class: NC11/helpers/http-adapter-host.js:17-72.
  - `_init$` is a `ReplaySubject` (line 20). The `httpAdapter` **setter** emits `init$` and completes it (lines 28-32). Late subscribers therefore still receive the event.
  - `listen$` is a `Subject` that fires when `listening = true` is set from `NestApplication.listen` (lines 59-65; NC11/nest-application.js:177-199).
- It is provided by the global `InternalCoreModule` (NC11/injector/internal-core-module/internal-core-module-factory.js:38-39), so any provider can inject it.
- **When the adapter gets set:**
  - Production: `NestFactory.initialize` → `container.setHttpAdapter(httpServer)` (NC11/nest-factory.js:105; NC11/injector/container.js:44-51). This is **before** dependency scanning and instantiation (nest-factory.js:110-113). Constructors therefore see `host.httpAdapter` (experiment 1: `Svc.constructor: host.httpAdapter set? true`).
  - Testing: `TestingModule.createNestApplication()` calls `container.setHttpAdapter(httpAdapter)` (EXP11/node_modules/@nestjs/testing/testing-module.js:21-29). That happens _after_ `compile()` has already instantiated providers. Experiment 10: `ctor: httpAdapter=undefined` for the default, express and fastify adapters. `init$` fires inside `createNestApplication`, and `onModuleInit` sees the adapter.
- v12 is unchanged apart from ESM import paths (diff of `http-adapter-host.d.ts`, §7).
- Docs: DOCS/faq/http-adapter.md:17-68 cover injection, `.httpAdapter`, `getInstance()`, `listen$` and `listening`.

### 1.2 `AbstractHttpAdapter` surface (v11)

NC11/adapters/http-adapter.d.ts:7-80 and NC11/adapters/http-adapter.js:7-89.

- **Concrete defaults** simply forward to `this.instance`: `use`, `get`, `post`, `head`, `delete`, `put`, `patch`, `propfind`, `proppatch`, `mkcol`, `copy`, `move`, `lock`, `unlock`, **`all`**, `search`, `options`, `listen` (js:12-65).
  - Also: `getHttpServer`, `setHttpServer`, `setInstance`, `getInstance`, `normalizePath` (identity), `setOnRouteTriggered`/`getOnRouteTriggered`, and no-op `setOnRequestHook`/`setOnResponseHook`, plus `init()` (no-op, js:11).
- **Abstract** (d.ts:57-79): `close`, `initHttpServer`, `useStaticAssets`, `setViewEngine`, `getRequestHostname`, `getRequestMethod`, `getRequestUrl`, `status`, `reply`, `end`, `render`, `redirect`, `setErrorHandler`, `setNotFoundHandler`, `isHeadersSent`, `getHeader`, `setHeader`, `appendHeader`, `registerParserMiddleware(prefix?, rawBody?)`, `enableCors(options?, prefix?)`, `createMiddlewareFactory(requestMethod)`, `getType()`, `applyVersionFilter(handler, version, versioningOptions)`.
- `useBodyParser` is **not** part of the abstract contract. `NestApplication.useBodyParser` feature-detects it (`'useBodyParser' in this.httpAdapter`) and logs a warning if it is missing (NC11/nest-application.js:155-164).
- **v12 additions** (NC12/adapters/http-adapter.d.ts:44-60, http-adapter.js:60-95):
  - `query()`: the HTTP `QUERY` method.
  - `beforeClose()`: no-op default, called from `NestApplication.dispose`, NC12/nest-application.js:54.
  - `mapException(error)`: identity default, used by `RoutesResolver.registerExceptionHandler`, NC12/router/routes-resolver.js:90-93.
  - Optional duck-typed `isRouteOrderSensitive?()`, read in NC12/nest-application.js:136 with a default of `true`.

### 1.3 Express vs Fastify adapter behaviour per method

Citations: `E` = NPE11/adapters/express-adapter.js, `F` = NPF11/adapters/fastify-adapter.js.

| Method                                           | ExpressAdapter (v11)                                                                                                                                                                                                                                                                                                      | FastifyAdapter (v11)                                                                                                                                                                                                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| constructor                                      | `express()` unless an instance is passed; installs a first `app.use` that runs `onRequestHook`/`onResponseHook` (E:19-37)                                                                                                                                                                                                 | `fastify({... routerOptions.constraints.version})` unless `{server}`-like instance passed; `skipMiddie` option; adds `onRequest`/`onResponse` hooks (F:25-124)                                                                                                                                   |
| `getType()`                                      | `'express'` (E:223-225)                                                                                                                                                                                                                                                                                                   | `'fastify'` (F:417-419)                                                                                                                                                                                                                                                                          |
| `getInstance()`                                  | Express app                                                                                                                                                                                                                                                                                                               | Fastify instance (F:283-285)                                                                                                                                                                                                                                                                     |
| `getHttpServer()`                                | `http(s).createServer(app)` created in `initHttpServer` (E:188-199), i.e. **only after `NestApplication` construction**                                                                                                                                                                                                   | `instance.server` (F:280-282,304-306)                                                                                                                                                                                                                                                            |
| `init()`                                         | inherited no-op                                                                                                                                                                                                                                                                                                           | registers the vendored middie once, then flushes queued `use()` calls (F:131-143,453-456)                                                                                                                                                                                                        |
| `use(...)`                                       | `app.use(...)` (inherited)                                                                                                                                                                                                                                                                                                | queued until middie registered, then `instance.use` = **middie** (raw req/res) (F:420-428)                                                                                                                                                                                                       |
| `get/post/put/...`                               | `app.get(...)` etc. (inherited)                                                                                                                                                                                                                                                                                           | `injectRouteOptions(METHOD, ...)` → `instance.route({...constraints(version), config, schema})`; adds unknown methods via `addHttpMethod` (F:165-209,460-503)                                                                                                                                    |
| `all(...)`                                       | `app.all(...)` (inherited)                                                                                                                                                                                                                                                                                                | **not overridden** → `instance.all(path, handler)` → Fastify `all` = `prepareRoute({method: supportedMethods})` (FST/fastify.js:201-203). **Bypasses `injectRouteOptions`**: no version constraint, `@RouteConfig`, `@RouteConstraints` or `@RouteSchema` (experiment 12)                        |
| `listen`                                         | `httpServer.listen(port, ...)`                                                                                                                                                                                                                                                                                            | converts to `instance.listen({port, host}, cb)` (F:144-164)                                                                                                                                                                                                                                      |
| `registerParserMiddleware(prefix, rawBody)`      | **ignores `prefix`**; `app.use(express.json(...))` + `app.use(express.urlencoded({extended:true}))` unless a router layer whose `handle.name` is `jsonParser`/`urlencodedParser` already exists (E:200-212, 347-353); `rawBody` → `verify` sets `req.rawBody` (NPE11/adapters/utils/get-body-parser-options.util.js:4-19) | guard `_isParserRegistered`; `addContentTypeParser` on the **root** for `application/x-www-form-urlencoded` (fast-querystring) and `application/json` (Fastify default JSON parser), `parseAs:'buffer'`, `bodyLimit` from `initialConfig`; stores `_pathPrefix = '/'+prefix` (F:341-353,435-452) |
| `useBodyParser(type, rawBody, options, parser?)` | `app.use(express[type](opts))`, global (E:213-218)                                                                                                                                                                                                                                                                        | `instance.addContentTypeParser(type, {...options, parseAs:'buffer'}, …)`; **sets `_isParserRegistered = true`** (F:354-372). So calling `app.useBodyParser(...)` before `init` suppresses Nest's json/urlencoded registration                                                                    |
| `enableCors(options)`                            | `app.use(cors(options))`, global and immediate (E:169-171)                                                                                                                                                                                                                                                                | `register(import('@fastify/cors'), options)` (F:338-340)                                                                                                                                                                                                                                         |
| `applyVersionFilter`                             | wraps the handler with a filter that calls `next()` on mismatch (E:226-334)                                                                                                                                                                                                                                               | tags `handler.version`; `injectRouteOptions` turns it into a find-my-way constraint (F:210-217, 462-499)                                                                                                                                                                                         |
| `createMiddlewareFactory(method)`                | `RouterMethodFactory.get(app, method)` → `app.all`/`app.get`/…; **falls back to `app.use` when the method is not in the map** (e.g. `-1`) (E:172-187; NC11/helpers/router-method-factory.js:23-31)                                                                                                                        | async; registers middie if needed; applies `_pathPrefix` (bug, §4.4); `instance.use(path, …)` then re-checks the full path with `pathToRegexp(path)` (end=true) (F:373-416)                                                                                                                      |
| `setNotFoundHandler`/`setErrorHandler`           | `app.use(handler)`, **position-dependent** (E:94-99)                                                                                                                                                                                                                                                                      | `instance.setNotFoundHandler`/`setErrorHandler`, position-independent (F:274-279)                                                                                                                                                                                                                |
| `normalizePath`                                  | `LegacyRouteConverter.tryConvert` + `pathToRegexp` validation (E:112-125)                                                                                                                                                                                                                                                 | **not overridden** (identity), so route paths go to find-my-way verbatim                                                                                                                                                                                                                         |
| `getRequestUrl`                                  | `req.originalUrl` (E:166-168)                                                                                                                                                                                                                                                                                             | `raw.originalUrl \|\| raw.url` (F:335-337,457-459)                                                                                                                                                                                                                                               |
| `reply/status/redirect`                          | Express `res` API (E:44-93)                                                                                                                                                                                                                                                                                               | Fastify `reply` API; wraps a raw `ServerResponse` in `new Reply(...)` when called from middleware context (F:218-273,432-434)                                                                                                                                                                    |
| `appendHeader`                                   | `res.append`                                                                                                                                                                                                                                                                                                              | `reply.header` (v11 overwrites; v12 concatenates, special-casing `set-cookie`, NPF12/adapters/fastify-adapter.js:333-344)                                                                                                                                                                        |
| extras                                           | `set/enable/disable/engine/setLocal`                                                                                                                                                                                                                                                                                      | `register`, `inject`, `registerWithPrefix(factory, prefix)` (F:286-291,429-431)                                                                                                                                                                                                                  |

v12 differences are in §7.3.

### 1.4 Third-party adapters (extensibility reference)

`@kiyasov/platform-hono@2.0.3` is a community `AbstractHttpAdapter`. Source: `…/tmp-nest-platform/hono/package/dist/esm/src/adapters/hono-adapter.js`.

- `getType()` returns `'hono'` (line 246-248).
- Middleware callbacks receive `(ctx.req /* HonoRequest */, ctx /* Context */, next)` (line 259-275), not Node req/res.
- It parses bodies in a global middleware installed in `initHttpServer` (line 222-237).
- It throws on `applyVersionFilter` (line 276-278).

**Implication:** `getType()` is an open set, and request/response objects are not guaranteed to be Node `IncomingMessage`/`ServerResponse`.

---

## 2. Application init order and safe registration points

### 2.1 Code-level sequence (v11; v12 is identical except for lazy module loading)

**Phase A: `NestFactory.create(AppModule, adapter?, options)`** (NC11/nest-factory.js:34-47)

1. `initialize(...)` (94-119):
   - `container.setHttpAdapter(adapter)` sets `HttpAdapterHost.httpAdapter` and fires **`init$`** (105).
   - `await adapter.init?.()`. Fastify registers middie here (107; F:131-143).
   - `dependenciesScanner.scan(module)`: modules are scanned; `forRoot` factories and decorators have already run.
   - `instanceLoader.createInstancesOfDependencies()`: **provider, controller and module constructors run** (112).
2. `new NestApplication(container, adapter, config, …)` (44). The constructor calls `registerHttpServer()` → `adapter.initHttpServer(appOptions)` (NC11/nest-application.js:39,59-61,75-78). Express creates the `http.Server` here.
3. The proxy is returned to the user's `main.ts`. The user then typically calls `app.setGlobalPrefix`, `app.enableVersioning`, `app.enableCors`, `app.use(...)`, `app.useBodyParser(...)`, `app.useGlobalGuards(...)`. On Express, each `app.use`, `enableCors` and `useBodyParser` pushes a layer immediately (E:169-171, 213-218).

**Phase B: `app.init()`** (NC11/nest-application.js:93-109; v12: NC12/nest-application.js:103-124)

1. `applyOptions()`: CORS from `NestFactory.create(..., {cors})` (65-74).
2. `await httpAdapter.init()` (98). This is a no-op the second time on Fastify.
3. **`registerParserMiddleware()` if `bodyParser !== false`** (99-100, 110-114), using the global prefix and `rawBody`.
4. `registerModules()` → `MiddlewareModule.register` → **every module's `configure(consumer)` is called** (NC11/middleware/middleware-module.js:26-70).
5. `registerRouter()`:
   - It first **applies all middleware** (`registerMiddleware`), sorted by module distance, with global modules first (middleware-module.js:71-97).
   - Then it **registers all controller routes** (`routesResolver.resolve`) (115-120).
6. `callInitHook()`: **`onModuleInit`** (103).
7. `registerRouterHooks()`: **404 handler, then error handler** (121-124; NC11/router/routes-resolver.js:72-93).
8. `callBootstrapHook()`: **`onApplicationBootstrap`** (105).

**Phase C: `app.listen()`**

- It calls `init()` if needed, then `adapter.listen` (172-207).
- Fastify's `listen` calls `ready()`: plugins registered with `register()` are loaded here (§2.4).
- After this, Fastify refuses new routes and content-type parsers (FST/fastify.js:461-463; FST/lib/content-type-parser.js:344-347, 370-373, 384-387).

### 2.2 v12 differences in the sequence

- Optional socket and microservice modules are lazily loaded at the start of `init()` (NC12/nest-application.js:107-111).
- Lifecycle hooks within a module are grouped by "hierarchy level" (NC12/hooks/on-module-init.hook.js:29-45; DOCS/migration.md:185-189). Hooks are still called module-by-module in the same place in the sequence.
- `registerRouter` can defer and sort route registration when `routeConflictPolicy` or `routeResolutionStrategy: 'specificity'` is set (NC12/nest-application.js:130-175). Both are opt-in (DOCS/controllers.md:227-285).

### 2.3 Experiment 1: what each phase gets (EXP11/exp1-init-order.js, EXP12 copy)

Each phase registers `getInstance().all('/<phase>{/*path}')` on Express or `all('/<phase>/*')` on Fastify, then POSTs JSON, form and text bodies.

**Express, default options (v11 and v12 identical)**

Final router stack:

```
<nest hook mw> > ctor-route > jsonParser > urlencodedParser > configure-route > oninit-route > <404> > <error> > onboot-route > afterinit-route > afterlisten-route
```

| Phase                             | json                            | form       | text/plain |
| --------------------------------- | ------------------------------- | ---------- | ---------- |
| provider **constructor**          | 200, **raw stream readable**    | 200 raw    | 200 raw    |
| `configure()`                     | 200, parsed, stream consumed    | 200 parsed | 200 raw    |
| `onModuleInit`                    | 200, parsed                     | 200 parsed | 200 raw    |
| `onApplicationBootstrap`          | **404** (Nest 404 handler wins) | 404        | 404        |
| after `init()` / after `listen()` | **404**                         | 404        | 404        |

- With `{bodyParser:false}`: no parser layers exist, and constructor, `configure` and `onModuleInit` are all raw. Phases after init still return 404.
- With `{rawBody:true}`: same as the default table.

**Fastify** (v11 and v12 identical)

| Options            | json                                     | form                           | text/plain                      |
| ------------------ | ---------------------------------------- | ------------------------------ | ------------------------------- |
| default            | parsed (Nest parser)                     | parsed                         | parsed (Fastify default parser) |
| `bodyParser:false` | **parsed** (Fastify default JSON parser) | **415 Unsupported Media Type** | parsed                          |
| `rawBody:true`     | parsed                                   | parsed                         | parsed                          |

- The same result holds for all phases up to and including after-`init()`.
- After `listen()`, registration throws `FST_ERR_INSTANCE_ALREADY_LISTENING Fastify instance is already listening. Cannot add route!`.

### 2.4 Fastify plugin load timing (experiment 11, EXP11/exp11-fastify-ready.js)

- A plugin `register`ed in `onModuleInit` is **not loaded after `app.init()`**: `hasRoute` is false for the plugin route and true for a direct root route.
- Sending a raw HTTP request to the Fastify server before `ready()` **crashed the process** with a Fastify internal `TypeError` in `hooks.js`.
- Loading happens on `fastify.ready()`, `listen()` or `inject()` (which auto-readies).
- Nest's docs already tell Fastify users to call `await app.getHttpAdapter().getInstance().ready()` after `app.init()` in tests (DOCS/fundamentals/unit-testing.md:280-293).

### 2.5 Summary: where a library can register

| Hook                                                 | Adapter available?                          | Express position                                                                                                                   | Fastify                                                                                          | Caveats                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| module or provider constructor                       | prod: yes; **`@nestjs/testing`: no** (§1.1) | before Nest's parsers **and before everything in `main.ts`** (`app.use(cors/helmet/cookie-parser)`, `enableCors`, `useBodyParser`) | fine                                                                                             | global prefix and versioning are not set yet (`main.ts` runs later); do not read `ApplicationConfig` here |
| `HttpAdapterHost.init$.subscribe` from a constructor | fires in both prod and testing              | same as constructor (verified raw in both flows, experiment 10b)                                                                   | fine; middie is not yet registered in the testing flow, so `adapter.use()` is queued (F:420-428) | same ordering caveat as constructor                                                                       |
| `configure(consumer)`                                | yes                                         | after parsers and after user `app.use`/`enableCors`                                                                                | fine                                                                                             | ideal for Nest middleware; raw-route body is already parsed on Express (JSON/form)                        |
| `onModuleInit`                                       | yes                                         | after parsers, before 404                                                                                                          | fine                                                                                             | same as above                                                                                             |
| `onApplicationBootstrap`                             | yes                                         | **v11: after 404, unreachable**; v12: reachable only outside the global prefix (§7.4)                                              | fine until listen                                                                                | avoid                                                                                                     |
| after `listen()`                                     | yes                                         | unreachable (v11)                                                                                                                  | **throws**                                                                                       | never                                                                                                     |

`ApplicationConfig`, which holds the global prefix, its exclude list and versioning, is injectable in every module (NC11/injector/module.js:122-130) and exported from `@nestjs/core` (NC11/index.d.ts:3). It is only final at `init()`, because `setGlobalPrefix` and `enableVersioning` are called in `main.ts`.

`app.setGlobalPrefix(prefix, options)` **replaces** the options object (NC11/nest-application.js:241-253 → NC11/application-config.js:24-26). So an `exclude` a library injects in its constructor (as REF does, REF/src/auth-module.ts:113-120) is overwritten if the user later calls `setGlobalPrefix(p, {exclude:[…]})`. I found this by code reading; I did not run a dedicated experiment for it.

`NestApplicationOptions` (`bodyParser`, `rawBody`, `cors`) are **not reachable through public API**. They live in `NestContainer.contextOptions` (NC11/injector/container.js:18-42, internal). The only indirect signals:

- Express: presence of a `jsonParser` layer in `app.router.stack` at `configure` time.
- Fastify: the `FastifyAdapter.isParserRegistered` getter (F:22-24).

---

## 3. Body parsing

### 3.1 Options and behaviour

- **`bodyParser: false`** skips `registerParserMiddleware` (NC11/nest-application.js:99-100).
  - Express: no parsers at all (experiment 1).
  - Fastify: Fastify's own default parsers for `application/json` and `text/plain` remain (FST/lib/content-type-parser.js:33-42). urlencoded returns 415 (experiment 1).
- **`rawBody: true`** only works when the built-in parser is enabled (DOCS/faq/raw-body.md:5).
  - Express: `verify` stores `req.rawBody` for json and urlencoded (get-body-parser-options.util.js).
  - Fastify: stores `req.rawBody` only in Nest's json and urlencoded parsers (F:354-372, 435-452). Fastify's default `text/plain` parser does not.
- **`app.useBodyParser(type, options)`** passes `rawBody` from the app options.
  - Express: another **global** `app.use(express[type])` (E:213-218).
  - Fastify: `addContentTypeParser(type, {parseAs:'buffer'})` and marks parsers as registered (F:354-372).
- **Fastify parser override rules:**
  - Defaults exist for `application/json` and `text/plain`. `existingParser` lets you override those two defaults once (FST/lib/content-type-parser.js:103-115).
  - Any second `add` for the same type throws `FST_ERR_CTP_ALREADY_PRESENT` (44-60).
  - Adding or removing parsers after start throws `FST_ERR_CTP_INSTANCE_ALREADY_STARTED` (344-347, 370-373, 384-387).
  - REF works around the duplicate error by calling `removeContentTypeParser([...])` before re-adding (REF/src/fastify-body-parser.ts:222-225), because it runs in `configure()`, after Nest registered its parsers.
- **Fastify dispatch:**
  - Body-less methods skip parsing.
  - Body methods with no content-type and an empty body skip parsing.
  - Otherwise `contentTypeParser.run(...)` is called. If no parser matches, the response is **415** (FST/lib/handle-request.js:19-61; content-type-parser.js:185-196).
  - A parser without `parseAs` receives the raw payload stream and may leave it untouched (content-type-parser.js:210-213).

### 3.2 Fastify parser scoping (encapsulation)

- Each non-`fastify-plugin` child context gets a **copy** of the parent's parser map when the plugin loads (FST/lib/plugin-override.js:46 → content-type-parser.js:335-342). Root routes share the root map.
- So Nest's root-level parsers are inherited by a child plugin that loads at `ready()`. Inside that child you can call `removeAllContentTypeParsers()` and add a `'*'` pass-through without affecting anything else.
- **Verified (experiment 5, EXP11/exp5-fastify-web.js; also EXP12):**
  - Child plugin at prefix `/api/auth` with `removeAllContentTypeParsers()` and `addContentTypeParser('*', (_req, _payload, cb) => cb(null))`: `request.raw.readable === true` and `request.body === undefined` for JSON, urlencoded and multipart.
  - A controller `POST /echo` outside the plugin still got a parsed JSON body.
  - It worked whether the plugin was registered in a constructor, `onModuleInit` or `onApplicationBootstrap`.
- **Caveat: the pass-through enforces no body limit.** Fastify's `bodyLimit` is enforced only in the `parseAs` path (content-type-parser.js:233-240). better-call's `getRequest` supports `bodySizeLimit`, but `toNodeHandler` never passes it (BC/node.mjs:3-10; BC/adapters/node/request.mjs:47-56,102-108).

### 3.3 Exempting one path prefix from parsing

**Express options:**

- **(a) Register before the parsers**, in a constructor or via `init$`. Verified raw (experiments 1 and 10b). The cost: it also lands before the user's `main.ts` `app.use(...)`/`enableCors()`, so user CORS, helmet and cookie-parser don't apply to those routes. `NestFactory.create({cors})` is applied at `init` and also comes after.
- **(b) `bodyParser: false`, then the library re-adds json/urlencoded for non-auth paths.** This is what REF does: a Nest middleware `forRoutes('*path')` skipping basePath (REF/src/middlewares.ts:136-191; README "Disable Body Parser", REF/README.md:34-57). It requires user action. REF documents that Nest's `rawBody: true` then has no effect (REF/README.md:53-55).
- **(c) Pre-empt by function name.** `ExpressAdapter.registerParserMiddleware` skips adding a parser if a router layer's `handle.name` is `jsonParser`/`urlencodedParser` (E:209-211, 347-353).
  - **Verified (experiment 7):** registering `function jsonParser(...)` and `function urlencodedParser(...)` wrappers that skip `/api/auth/` in a constructor stops Nest from adding its own. The auth route in `configure()` got a raw stream and CORS headers.
  - **But** it silently drops Nest `rawBody:true` semantics (`/echo` rawBody null), relies on a private check, and **any user `app.useBodyParser('json', …)` is global and consumes the auth body** (experiment 7, second run).
- **(d) Accept consumed bodies:** use `req.rawBody` when present, otherwise re-serialize `req.body`. better-call does the latter automatically (BC/adapters/node/request.mjs:38-46,109-116). It is lossy (e.g. form `b=%20x` came back as `b=+x`, experiment 6) and breaks raw-signature endpoints (Stripe plugin, BA/packages/stripe/src/routes.ts:2027-2041).
- **(e) Reorder `app.router.stack`.** Express 5 exposes it, and Nest itself reads it (E:347-353). Possible but fragile. **UNVERIFIED.**

better-auth's own Express guidance: "Mount the Better Auth handler before body-parsing middleware such as `express.json()`" (BA/docs/content/docs/integrations/express.mdx:20-24, 34-38).

**Fastify options:**

- An encapsulated plugin with pass-through parsers (verified above).
- Nest middleware or middie, which runs in `onRequest` before parsing. The raw stream is intact (experiment 4), but it bypasses CORS and `reply.header` (§4.6).
- Nothing per-route: Fastify has no route option that disables body parsing. Scoping is by plugin context (content-type-parser.js / plugin-override.js above).

---

## 4. `MiddlewareConsumer`, especially on Fastify

### 4.1 Engine

- Nest vendors a clone of `@fastify/middie`: NPF11/adapters/middie/fastify-middie.js. Its header comment says "with an extra vulnerability fix. Path is now decoded before matching" (lines 11-15, 84-101).
- `@fastify/middie` is **not** a dependency of `@nestjs/platform-fastify`. The dependencies are fastify, find-my-way, path-to-regexp, reusify, fastify-plugin and others (`npm view @nestjs/platform-fastify@11.1.17 dependencies`).
- It is registered as a `fastify-plugin` (skip-override) named `@fastify/middie` (lines 247-250) on the **`onRequest`** hook by default (180-189).
- It hands `req.raw` and `reply.raw` to middleware, after copying `id`, `hostname`, `ip`, `log` and `query` onto the raw request, and `body` if already set (205-223).
- **The body is never parsed at `onRequest`.** Experiment 4: `req.readable === true` and `body` undefined.
- Registration happens during `NestFactory.create`, via `adapter.init()` at NC11/nest-factory.js:107. So middie's `onRequest` hook precedes hooks added later, such as `@fastify/cors` from `enableCors`.
- `FastifyAdapter({ skipMiddie: true })` marks middie as registered without registering it (F:105-107). After that, `adapter.use()` calls a nonexistent `instance.use` (**UNVERIFIED at runtime**; code reading of F:420-428).

### 4.2 Path matching semantics

- **String vs RouteInfo on Express.** `forRoutes('api/auth/*path')` (string) maps to method `-1` (NC11/middleware/routes-mapper.js:26-34). `REQUEST_METHOD_MAP[-1]` is undefined, so it falls back to **`app.use(path, fn)`**: a prefix mount where Express strips the matched part from `req.url` and sets `req.baseUrl`. `{path, method: RequestMethod.ALL}` maps to **`app.all(path, fn)`**: exact pattern, `req.url` intact (router-method-factory.js:5-31).

  Experiment 4:

  | Form                             | `url`                     | `baseUrl`                 |
  | -------------------------------- | ------------------------- | ------------------------- |
  | `RouteInfo ALL 'api/auth/*path'` | `/api/auth/sign-in/email` | `''`                      |
  | string `'api/auth/*path'`        | `/`                       | `/api/auth/sign-in/email` |
  | string `'api/auth'`              | `/sign-in/email`          | `/api/auth`               |

- **Fastify** always uses `instance.use(path)` through middie:
  - It prefix-matches with `pathToRegexp(url, {end:false})` (fastify-middie.js:23-44), then rewrites `req.url` by removing the matched portion (102-106).
  - Nest's adapter wrapper then re-tests `pathToRegexp(normalizedPath)` (end=true) against `pathname + '/'` (F:391-407).
  - Result: `forRoutes('api/auth')` **matches only `/api/auth` on Fastify but every sub-path on Express** (experiment 4b, v11 and v12).
- During the middleware call on Fastify, `req.url` is rewritten (e.g. `/` for `/api/auth/sign-in/email`) unless the URL was percent-encoded. `/api/auth/%73ign-in` kept its full `req.url`, because the regex runs on the decoded URL and `String.replace` on the raw one. `req.originalUrl` is always intact (fastify-middie.js:50, 73, 103).
- **Wildcards.** Express 5 and middie both use path-to-regexp 8.x: `*name` is required and `{*name}` is optional (DOCS/middlewares.md:129-150). `LegacyRouteConverter.tryConvert` auto-converts `/*`, `(.*)` and `+` with a WARN (NC11/router/legacy-route-converter.js:15-52). It is applied by both adapters' `createMiddlewareFactory` (E:175; F:380).
- **Wildcard detection for global prefix.** `RouteInfoPathExtractor.isAWildcard` treats paths matching `^\/\{.*\}.*|^\/\*.*$` or `*`, `/*`, `(.*)` as wildcards. Those get `prefix + '$'`, `prefix + path`, **and every excluded route path** (NC11/middleware/route-info-path-extractor.js:17-56).

### 4.3 Global prefix and `exclude`

- Middleware paths get the global prefix unless the route is excluded (route-info-path-extractor.js:57-70).
- Experiment 4 (string `'api/auth/*path'`):
  - Prefix `v1` → the middleware fires at `/v1/api/auth/...` only.
  - Adding `exclude: ['api/auth/{*path}']`:
    - Express fires at `/api/auth/...`.
    - **Fastify v11 still fired only at `/v1/api/auth/...`** (the bug in §4.4).
    - With `bodyParser:false`, Fastify v11 fired at `/api/auth/...`.
- The consumer's own `.exclude(...)` is checked per request via `httpAdapter.getRequestUrl(req)` (NC11/middleware/utils.js:50-106).

### 4.4 Fastify `_pathPrefix` bug (v11), fixed in v12

- v11 re-prepends the global prefix to any middleware path that does not start with it (F:383-389). `_pathPrefix` is only set in `registerParserMiddleware` (F:348-352), i.e. only when `bodyParser !== false`. So prefix-excluded middleware paths get re-prefixed on Fastify.
- v12 only prepends when the path is `/` or `''` (NPF12/adapters/fastify-adapter.js:400-405).
- Experiment 4 on v12: excluded middleware fires at `/api/auth/...` on both platforms.

### 4.5 Errors

- Nest docs: only global filters catch middleware exceptions (DOCS/middlewares.md:330-334).
- Experiment 9: a throw inside a Nest middleware produced the global `APP_FILTER` response on Express and Fastify.

### 4.6 CORS and hooks bypass on Fastify (experiment 8, EXP11 and EXP12)

A Nest middleware that ends the raw response, with `app.enableCors({origin})`:

- POST with Origin: **no `Access-Control-Allow-Origin` header**.
- OPTIONS preflight: **handled by the middleware** (200 plus its body), not by `@fastify/cors`.
- Root `onSend` did not run; root `onResponse` did.

The cause: middie's `onRequest` hook precedes cors's hook, and middie never calls `next` once `res.writableEnded` (fastify-middie.js:74-77). REF documents this and re-implements CORS for Fastify (REF/README.md:86, 726-736; REF/src/fastify-trusted-origins-cors.ts).

---

## 5. Mounting a catch-all under `basePath`: three options compared

Legend: ✓ verified by experiment, (c) from code reading.

| Concern                                        | (a) Raw adapter route (`getInstance().all`, `fastify.route`, or Fastify child plugin)                                                                                        | (b) Nest middleware (`consumer.apply(X).forRoutes(...)`)                                                                                         | (c) Nest `@Controller(basePath)` + `@All(...)`                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Path syntax                                    | platform-native: Express `'/api/auth/*path'` or `'{/*path}'`; Fastify `'/api/auth/*'` (find-my-way rejects named wildcards: EXP11/node_modules/find-my-way/index.js:281,432) | path-to-regexp v8 on both (`'api/auth/*path'`, `'api/auth/{*path}'`) ✓; string form without wildcard is prefix on Express and exact on Fastify ✓ | Express: `*path`/`{*path}` ✓, `*` works with WARN ✓. Fastify: **only `*`**; `*path`/`{*path}` throw "Wildcard must be the last character in the route" at startup ✓ (v11 and v12). Workaround: set the path in `configure()` via public `@All()` re-application (✓ v11 and v12, experiment 13b), but that mutates class-level metadata shared across apps in one process |
| Global prefix                                  | not applied (literal path) ✓                                                                                                                                                 | applied unless excluded ✓; Fastify v11 exclude bug ✓                                                                                             | applied ✓; `exclude: ['api/auth/{*path}']` works on both ✓                                                                                                                                                                                                                                                                                                               |
| URI versioning (`defaultVersion`)              | not applied                                                                                                                                                                  | applied if `RouteInfo.version`                                                                                                                   | **applied**: `/v2/api/auth/...`; use `@Version(VERSION_NEUTRAL)` ✓                                                                                                                                                                                                                                                                                                       |
| Header / media versioning                      | n/a                                                                                                                                                                          | n/a                                                                                                                                              | Express: enforced (404 on mismatch) ✓. **Fastify: ignored for `@All`** (always 200) ✓, a platform divergence                                                                                                                                                                                                                                                             |
| Guards, interceptors, pipes                    | none                                                                                                                                                                         | none                                                                                                                                             | all global (`APP_GUARD` etc.) and scoped enhancers run ✓; the library must opt its routes out of its own global guard and of user guards (e.g. throttlers)                                                                                                                                                                                                               |
| Exception filters                              | only **global** (via Nest's error handler) ✓ (experiment 9, Express `next(err)`, sync throw and async reject; Fastify throw and child-plugin throw)                          | only global ✓                                                                                                                                    | all scopes                                                                                                                                                                                                                                                                                                                                                               |
| Body state (Express)                           | raw if registered before parsers (constructor or `init$`), else parsed JSON/form ✓                                                                                           | parsed JSON/form (runs after the global parser) unless `bodyParser:false` ✓                                                                      | parsed JSON/form; `req.rawBody` if `rawBody:true` (c)                                                                                                                                                                                                                                                                                                                    |
| Body state (Fastify)                           | root route: parsed; child plugin with pass-through: **raw** ✓                                                                                                                | **raw**; `onRequest` runs before parsing ✓                                                                                                       | parsed (root parsers); 415 for unregistered types such as multipart ✓ (experiment 1, bodyParser:false form)                                                                                                                                                                                                                                                              |
| CORS via `enableCors()` / `{cors}`             | Express: applies only if registered after cors (`configure`/`onModuleInit`) ✓; Fastify: applies (route lifecycle) ✓                                                          | Express: applies (after cors) (c); **Fastify: bypassed** ✓                                                                                       | applies (c)                                                                                                                                                                                                                                                                                                                                                              |
| 404 handler interplay                          | Express v11: must register before `registerRouterHooks` (≤ `onModuleInit`) ✓                                                                                                 | registered at `registerRouter` ✓                                                                                                                 | n/a                                                                                                                                                                                                                                                                                                                                                                      |
| `@nestjs/testing`                              | constructor registration fails (adapter undefined); `init$` works ✓                                                                                                          | works                                                                                                                                            | works                                                                                                                                                                                                                                                                                                                                                                    |
| Fastify `ready()` needed                       | plugin routes: yes ✓                                                                                                                                                         | no                                                                                                                                               | no                                                                                                                                                                                                                                                                                                                                                                       |
| Request object                                 | native (Express `req` / Fastify `FastifyRequest`)                                                                                                                            | Express `req`; **Fastify raw `IncomingMessage`** with a rewritten `req.url` ✓                                                                    | native, via `@Req()`                                                                                                                                                                                                                                                                                                                                                     |
| Response                                       | native `res` / `FastifyReply`                                                                                                                                                | Express `res`; Fastify raw `ServerResponse`, reply headers unavailable ✓                                                                         | `@Res()` native; returning a `Response` works on Fastify but not Express ✓ (experiment 14)                                                                                                                                                                                                                                                                               |
| Nest 12 route diagnostics                      | invisible to `routeConflictPolicy` (c)                                                                                                                                       | invisible (c)                                                                                                                                    | participates: a catch-all can be flagged `shadow` against user routes under the same basePath, and `'specificity'` sorting places wildcards last on Express (DOCS/controllers.md:227-285)                                                                                                                                                                                |
| Throughput (indicative, experiment `bench.js`) | Express 18.3k req/s; Fastify **56.3k**                                                                                                                                       | Express 20.7k; Fastify 50.0k                                                                                                                     | Express 15.0k; Fastify 35.4k (with a global guard and interceptor)                                                                                                                                                                                                                                                                                                       |

The benchmark used autocannon, 50 connections for 4 s, a trivial JSON handler, Node 22.22 on an M4 Pro, and Nest 11.1.17. Numbers are indicative only; real auth handlers are dominated by DB and crypto work. A path-less `adapter.use` middleware on Fastify changed `/hello` from 36.6k to 34.8k req/s (about 5%, within noise). **These are microbenchmarks, not a load test.**

---

## 6. Platform request → Web `Request`, and Web `Response` → platform

### 6.1 better-call's reference bridge (the one better-auth ships as `toNodeHandler`)

- `better-auth/node` `toNodeHandler(auth)` → `better-call/node.toNodeHandler(auth.handler)` (BA/packages/better-auth/src/integrations/node.ts:5-13).
- `toNodeHandler` builds the base URL from `x-forwarded-proto` (or `socket.encrypted`) plus `:authority` or `host` (BC/node.mjs:3-10). It trusts `x-forwarded-proto` unconditionally (c).
- **`getRequest`** (BC/adapters/node/request.mjs:102-124):
  - For non-GET/HEAD, if `request.readable`, it streams the body (`get_raw_body`, with pause/resume backpressure, lines 47-94).
  - Otherwise, if `req.body !== undefined`, it **re-serializes**: form-urlencoded via `URLSearchParams`, anything else via `JSON.stringify` (38-46,109-116).
  - Then `new Request(base + constructRelativeUrl(req), { duplex:'half', method, body, headers: request.headers })`.
- **URL pitfall.** `constructRelativeUrl` (95-101) returns `baseUrl` **without the query string** when `baseUrl + url !== originalUrl` and the path doesn't end in `/`. Experiment 6 (Nest string middleware `forRoutes('nest-mw/*path')` on Express): `/nest-mw/callback/google?code=abc&state=1` became `…/nest-mw/callback/google`, **losing `code`/`state`** (v11 and v12). The raw `app.all('/x/*path')` and `app.use('/x')` mounts preserved the query.
- **HTTP/2 pitfall.** `headers: request.headers` throws on HTTP/2: `"Request constructor: init.headers is a symbol, which cannot be converted to a DOMString."`. Header keys were `:path, :method, :authority, :scheme` plus a symbol (EXP12/h2test.cjs, Fastify `http2:true`). Separately, `new Headers({':authority':'x'})` throws "invalid header name".
- **`setResponse`** (126-173):
  - Copies headers, re-splitting `set-cookie` with `set-cookie-parser.splitCookiesString(headers.get('set-cookie'))` because `Headers.get()` joins with `", "`.
  - Calls `res.writeHead(status)` and streams with `drain` backpressure.
  - Cancels the reader on `close`/`error`.
  - Writes directly to the Node `ServerResponse`.
- Web platform facts (Node 22.22, verified inline):
  - `Headers` iteration yields each `set-cookie` separately; `get('set-cookie')` joins them as `"a=1, b=2"`; `getSetCookie()` returns an array.
  - A `Request` with a stream body requires `duplex:'half'`.
  - `Response.redirect(url, 302)` sets `location`.

### 6.2 Express

- **No native Web Response support.** `res.send(new Response('hello', {status:201}))` gave `200 application/json "{}"` on Express 5.2.1 (verified).
- A Nest controller returning a `Response` on Express gives `200 "{}"` (experiment 14), because `ExpressAdapter.reply` sends objects via `res.json` (E:80).
- `setResponse` onto Express `res` (experiment 6): 2 `Set-Cookie` headers preserved, a 302 with `Location` and cookie preserved, and JSON and form bodies streamed through intact when the handler ran before parsers.
- Express `res` is the Node `ServerResponse`, so headers set earlier by `cors` or other middleware via `res.setHeader` survive (experiment 7: ACAO present).

### 6.3 Fastify

- **`reply.send(Response)` is native in Fastify ≥ 4.26.0.** The `[object Response]` branch exists in 4.26.0 and is absent in 4.22.0-4.25.0 (grep across npm-packed versions, …/tmp-nest-platform/fastify4/*). It is present in 5.0.0 (…/fastify500/package/lib/reply.js:156, 574), 5.8.2 (FST/lib/reply.js:164-172, 596-616) and 5.12.x.
- Behaviour:
  - Status comes from `Response.status`.
  - Headers are copied with `for … of payload.headers` → `reply.header()`. Fastify's `reply.header` appends `set-cookie` values (FST/lib/reply.js:253-272).
  - The body goes through `sendWebStream` with drain-based backpressure (695+).
  - The documented caveat: `reply.statusCode` and `getHeaders()` don't reflect the `Response` inside `onSend` (FST/docs/Reference/Reply.md:798-825).
  - Verified in experiment 5 (send mode, v11 and v12): 201 plus 2 cookies plus `x-custom`, `@fastify/cors` ACAO present, a 302 with `Location`, a 3-chunk stream delivered, and root and plugin `onSend`/`onResponse` hooks both ran.
- **HEAD bug.** `head-route.js:29` calls `Buffer.byteLength(payload)` on a `Response` (FST/lib/head-route.js:2-34; unchanged in 5.12.1 and 5.12.3).
  - Any GET route relying on the auto-generated HEAD sibling (`exposeHeadRoutes` default) that answers with `reply.send(Response)` gives HEAD **500** (`TypeError ERR_INVALID_ARG_TYPE … Received an instance of Response`). Verified via a plugin route (experiment 5), a Nest `@Get` controller (experiment 14), and raw fastify `method:['GET','POST']` (EXP11 inline).
  - **Not affected:** routes that register HEAD explicitly (`fastify.all`, Nest `@All`) returned HEAD 200 (experiment 14b and the inline test).
  - **Workaround, verified** (EXP12/unwrap.cjs): `reply.code(res.status); for (const [k,v] of res.headers) reply.header(k,v); return reply.send(res.body ?? undefined)`. GET and HEAD both return 200, keep 2 cookies and CORS; a 204 with a null body works.
  - I did not find an upstream Fastify issue for this; the search was inconclusive.
- **`reply.hijack()`** (FST/lib/reply.js:125-137; docs Reply.md:617-650) "prevent[s] Fastify from sending the response, and from running the remaining hooks". The same docs say "If `reply.raw` is used to send a response back to the user, the `onResponse` hooks will still be executed" (Reply.md:650-651).
  - Verified (experiment 5, hijack mode): `onSend` hooks did **not** run; `onResponse` **did**.
  - **Headers set earlier via `reply.header()` are lost.** `@fastify/cors`'s ACAO was **absent** on hijacked responses but present with `send`, because Fastify stores them in `reply[kReplyHeaders]` and flushes them only in `safeWriteHead` → `res.writeHead(statusCode, reply[kReplyHeaders])` (FST/lib/reply.js:563-566) or `sendWebStream` (reply.js:695+).
  - Preflight still returned 204 from `@fastify/cors` before the handler.
- Nest middleware on Fastify only has the raw `ServerResponse`, so it has the same header-loss characteristics as hijack (§4.6).

### 6.4 Nest controller returning `Response`

- Fastify: `FastifyAdapter.reply` → `fastifyReply.send(body)` (F:218-256) gives the native Response handling above, with 202, `x-a` and 2 cookies (experiment 14). HEAD returns 500 for `@Get` (auto-HEAD) and 202 for `@All`.
- Express: `{}` (see §6.2).

### 6.5 Getting headers for session lookup outside the handler (guards)

- `fromNodeHeaders(req.headers)` in better-auth appends array values and sets scalars (BA/packages/better-auth/src/integrations/node.ts:15-27). It passes pseudo-headers through, so it hits the same HTTP/2 invalid-name error as §6.1 (c, based on the `new Headers` check).
- Request header shapes differ per platform:
  - Express `req.headers`: Node `IncomingHttpHeaders`.
  - Fastify `request.headers`: the same object (`request.raw.headers`).
  - Hono adapter: the native request is a Web `Request` (`ctx.req.raw`, with Web `Headers`). The adapter also copies them onto a plain object, `ctx.req['headers'] = Object.fromEntries(ctx.req.raw.headers)` (hono-adapter.js:231).

---

## 7. NestJS 12

### 7.1 Release status

- `npm view @nestjs/core dist-tags`: `latest: 12.0.1`, `next: 12.0.0-alpha.7`, `legacy: 10.4.22`.
- Times: 12.0.0 at 2026-08-27T07:03Z, 12.0.1 at 2026-08-27T07:29Z. 11.2.0 through 11.2.3 were released in August 2026 alongside it.
- `@nestjs/platform-fastify` dist-tags are the same.
- The GitHub release v12.0.0 lists these breaking changes: ESM packages, Node 20.19+/22.12+, lifecycle hooks by hierarchy level, reworked HTTP adapter error mapping, and Express graceful shutdown (fetched from github.com/nestjs/nest/releases/tag/v12.0.0).

### 7.2 Module format and runtime

- All `@nestjs/*` 12 packages are `"type":"module"` with `exports` maps: `"."`, `"./internal"`, `"./*.js"`, `"./*"` (NC12/package.json, NCO12/package.json, NPF12/package.json). `engines` is still `>= 20`, but the docs require **Node v20.19+ or v22.12+** because CJS consumers rely on `require(esm)` (DOCS/migration.md:29-40, 44-56).
- Verified on Node 22.22 from a CJS script:
  - `require('@nestjs/core')`, `require('@nestjs/platform-fastify')` and `require('better-auth/node')` succeed.
  - Deep paths such as `@nestjs/core/adapters/http-adapter`, `@nestjs/core/middleware/utils` and `@nestjs/common/utils/shared.utils` still resolve through the `./*` export.
- v12 moves many helpers to `@nestjs/core/internal` and `@nestjs/common/internal`, both documented as "Internal module - not part of the public API … Do not depend on these" (NC12/internal.d.ts:1-7, NCO12/internal.d.ts:1-7). Examples: `LegacyRouteConverter`, `RouterMethodFactory`, the shared utils. The v12 platform adapters import from those entry points (NPF12/adapters/fastify-adapter.js:6-8; NPE12 diff).
- REF v2.8.0 deep-imports `@nestjs/common/utils/shared.utils.js` and `@nestjs/core/middleware/utils.js` (REF/src/auth-module.ts:49-50). It is ESM-only and has peer range `^11.1.6 || ^12.0.0` (REF/package.json).

### 7.3 Adapter and API changes relevant here

| Area                                                   | Nest 12 behavior                                                                                                                                                                                                                                           | Source                                                                                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Bundled HTTP stacks                                    | platform-express → express **5.2.1**, path-to-regexp 8.4.2, multer 2.2.0; platform-fastify → fastify **5.12.1**, find-my-way 9.9.0, @fastify/cors 11.3.0, fastify-plugin 6.0.0, @fastify/formbody 9.0.0 (v11.1.17 had fastify 5.8.2, fastify-plugin 5.1.0) | `npm view … dependencies`                                                                                                   |
| `AbstractHttpAdapter`                                  | + `query()`, `beforeClose()`, `mapException()`; optional `isRouteOrderSensitive()` (Express `true`, Fastify `false`)                                                                                                                                       | NC12/adapters/http-adapter.d.ts:44-60; NPE12/adapters/express-adapter.js:256-258; NPF12/adapters/fastify-adapter.js:444-446 |
| Error mapping                                          | `SyntaxError`/`URIError` → 400 moved to `ExpressAdapter.mapException`; FastifyError → `HttpException` moved to `FastifyAdapter.mapException`                                                                                                               | NPE12:368-378; NPF12:456-467; NC12/router/routes-resolver.js:90-93                                                          |
| Express 404/error handlers                             | prefix-scoped (see 7.4)                                                                                                                                                                                                                                    | NPE12:82-116                                                                                                                |
| Express shutdown                                       | `beforeClose()` sets `isShuttingDown`; new `return503OnClosing` option                                                                                                                                                                                     | NPE12:146-155, 217-227; NCO12 nest-application-options d.ts:35                                                              |
| Fastify middleware prefix                              | fixed (§4.4)                                                                                                                                                                                                                                               | NPF12:400-405                                                                                                               |
| Fastify `appendHeader`                                 | concatenates; special-cases `set-cookie`                                                                                                                                                                                                                   | NPF12:333-344                                                                                                               |
| Fastify `useStaticAssets`/`setViewEngine`/`enableCors` | async `import()`                                                                                                                                                                                                                                           | NPF12 diff                                                                                                                  |
| Route diagnostics                                      | opt-in `routeConflictPolicy`, `routeResolutionStrategy`                                                                                                                                                                                                    | NC12/nest-application.js:130-175; DOCS/controllers.md:227-285                                                               |
| Lifecycle ordering                                     | hooks within a module grouped by hierarchy level                                                                                                                                                                                                           | NC12/hooks/on-module-init.hook.js:29-45; DOCS/migration.md:185-189                                                          |
| Init sequence and body-parser timing                   | **unchanged**; experiment 1 on v12 matches v11                                                                                                                                                                                                             | NC12/nest-application.js:103-124                                                                                            |
| Wildcards on Fastify                                   | still only `*` for controllers; `*path` still throws                                                                                                                                                                                                       | experiment 3 (EXP12)                                                                                                        |
| `@All` on Fastify ignores constraints                  | still true                                                                                                                                                                                                                                                 | experiment 12 (EXP12)                                                                                                       |
| Fastify HEAD + `Response` bug                          | still present (fastify 5.12.1)                                                                                                                                                                                                                             | experiment 5 (EXP12)                                                                                                        |

### 7.4 Express 404 behaviour change (observed)

v12 `setNotFoundHandler(handler, prefix)` does one of two things:

- With a prefix: mounts `router.all('*path', handler)` under `app.use(prefix, router)` and records the prefix, **and registers nothing at root**.
- Without a prefix: registers a root handler that skips registered prefixes.

Source: NPE12/adapters/express-adapter.js:93-116.

Runtime (unknown routes, `app.setGlobalPrefix(...)`):

| Version | prefix                | `/nothing`                          | `/v1/nothing`     |
| ------- | --------------------- | ----------------------------------- | ----------------- |
| v11     | `'v1'`, `'/v1'`, `''` | 404 JSON (Nest)                     | 404 JSON          |
| v12     | `'v1'`                | **404 text/html (Express default)** | **404 text/html** |
| v12     | `'/v1'`               | 404 text/html                       | 404 JSON          |
| v12     | `''`                  | 404 JSON                            | 404 JSON          |

Consequence (experiment 1 on v12 with prefix `v1`): raw Express routes outside the prefix registered in `onApplicationBootstrap`, after `init` or after `listen` **are reachable** (200). In v11 they return 404. Whether the `'v1'` (no leading slash) case is intended is **UNVERIFIED**; it looks like a regression.

---

## 8. Design implications (facts → constraints; not a design)

1. **Adapter contract keyed by `httpAdapter.getType()`, an open string set.** Built-ins are `'express'` and `'fastify'`; third parties report their own (e.g. `'hono'`). Request and response objects may not be Node primitives (§1.4). A strategy registry resolved through DI (multi-provider or token) satisfies Open-Closed. Core must never `switch` on type.
2. **Registration timing must be a per-strategy decision, not a single core hook:**
   - Express needs "before the parsers" for raw bodies.
   - The only point that works in both `NestFactory` and `@nestjs/testing` is **`HttpAdapterHost.init$`**, subscribed from a constructor.
   - That point is also before user CORS and middleware.
   - Fastify is order-insensitive, but plugin routes load only at `ready()`/`listen()`/`inject()`.
3. **Whoever handles CORS for auth routes must be explicit:**
   - With early Express registration and Fastify middleware, the user's `enableCors()` does not apply.
   - With a Fastify plugin route using `reply.send(...)`, or Express registration in `configure()`/`onModuleInit`, it does apply.
   - This needs a strategy-level decision (e.g. derive from better-auth `trustedOrigins`, as REF does, or document it).
4. **Body handling is the crux:**
   - Raw-stream access differs per platform: Express needs early mounting, name pre-emption or `bodyParser:false`; Fastify needs a child plugin with pass-through parsers.
   - Re-serialization fallbacks are lossy and break the Stripe webhook signature.
   - When bypassing platform parsers, the library must enforce its own **body size limit**.
5. **Do not rely on better-call's `toNodeHandler`/`getRequest` URL logic.** Build the URL from `req.originalUrl` (Express) or `request.url`/`raw.url` (Fastify), plus an explicit trusted host/proto policy.
6. **Build `Headers` yourself.** Filter pseudo-headers (`:`-prefixed) and non-string keys so HTTP/2 works; derive host from `:authority`.
7. **Response write-back per platform:**
   - Express: stream to `ServerResponse` with backpressure (better-call `setResponse` works) and preserve multiple `Set-Cookie`.
   - Fastify: prefer `reply.code()` plus `reply.header()` per entry plus `reply.send(body stream)`. That keeps CORS and `onSend` hooks and avoids the HEAD bug. Avoid `hijack` unless you also merge `reply.getHeaders()`.
8. **If a controller-based catch-all is offered as a strategy (e.g. for teams that want guards or interceptors on auth routes), it must handle:**
   - Per-platform wildcard syntax (`*` on Fastify; `*path` on Express to avoid the WARN).
   - `VERSION_NEUTRAL`.
   - Global-prefix exclusion policy.
   - Opt-out from global guards.
   - The Fastify `@All` constraint gap.
   - Nest 12 `routeConflictPolicy` interactions.
9. **Dual CJS+ESM:** both Nest 12 and better-auth 1.7.4 are ESM-only, so the CJS build depends on `require(esm)`, which needs Node ≥ 20.19 / 22.12. Keep public DI tokens resilient to the dual-package hazard: our own CJS and ESM copies loaded side by side would produce distinct class tokens. Use `Symbol.for` or string tokens (c).
10. **Avoid deep imports.** Nest 12 labels `internal` entry points non-public, and deep paths are unstable.
11. **Read `ApplicationConfig` (prefix, exclude, versioning) only at `configure()`/`onModuleInit` time.** Never mutate `globalPrefixOptions` in a constructor, because `setGlobalPrefix(p, opts)` replaces the object.
12. **Middleware-based strategies on Fastify must use `originalUrl`**, since middie rewrites `req.url`. On Express, avoid the string-form `forRoutes('x/*path')` (`app.use` mount) unless the URL is rebuilt from `originalUrl`.

---

## 9. Pitfalls checklist

- **Constructors under `@nestjs/testing`:** `HttpAdapterHost.httpAdapter` is undefined in provider constructors (experiment 10).
- **Express after init:** routes registered in `onApplicationBootstrap` or later are shadowed by Nest's 404 in v11 (experiment 1).
- **Express route order vs user middleware:** routes registered before init bypass user `app.use`, `enableCors` and helmet (the stack order in experiment 1 and experiment 7).
- **Fastify `bodyParser:false`:** still parses JSON and text; form returns 415 (experiment 1).
- **Fastify `useBodyParser` before init:** it sets `_isParserRegistered`, which suppresses Nest's json/urlencoded override (F:369-371).
- **Fastify parser conflicts:** adding a parser for a type that already has a custom parser throws `FST_ERR_CTP_ALREADY_PRESENT`. Parser changes after start throw.
- **Fastify request before `ready()`:** a raw HTTP request to Fastify before `ready()` crashed the process (experiment 11).
- **Fastify wildcards:**
  - `@All('*path')`/`@Get('*path')` on Fastify throw at startup (experiment 3).
  - `@All('*')` on Express logs a WARN (experiment 3).
- **Fastify `@All` constraints:** it ignores header and media versioning and `@RouteConfig`/`@RouteConstraints`/`@RouteSchema` (experiment 12; F:165-209 has no `all`).
- **Fastify string-form middleware:** `forRoutes('api/auth')` (no wildcard) is exact on Fastify and prefix on Express (experiment 4b). This is how the current repo mounts its handler (`src/auth-module.ts:149-157`), so its current approach would not serve sub-paths on Fastify.
- **Fastify exclude bug (v11):** Fastify v11 re-prefixes excluded middleware paths when the body parser is enabled (experiment 4).
- **Fastify middleware bypasses:** it bypasses `@fastify/cors` and preflight handling, and `onSend` (experiment 8).
- **Fastify `reply.hijack()`:** it drops `reply.header()` headers (CORS) and skips `onSend` (experiment 5).
- **Fastify HEAD bug:** `reply.send(Response)` combined with an auto-HEAD route gives HEAD 500 (experiments 5 and 14).
- **Express has no native Response:** `res.send(Response)` gives `{}` (inline test).
- **better-call pitfalls:** it loses the query under `app.use('/x/*path')` mounts (experiment 6), fails on HTTP/2 (h2test), and re-serializes consumed bodies (experiment 6: `%20` became `+`).
- **Pass-through body limits:** pass-through parsing enforces no body limit (§3.2).
- **Fastify with `skipMiddie: true`:** it breaks any `adapter.use`-based strategy (F:105-107, 420-428; runtime **UNVERIFIED**).
- **Nest 12 Express 404:** with a global prefix, especially one without a leading slash, Nest's JSON 404 is not served outside the prefix (§7.4).
- **Global metadata mutation:** mutating controller route metadata at runtime is process-global. Tests that boot Express and Fastify apps in one process would share it.

---

## 10. Open questions for the user or design team

1. **Minimum Node version.** Is requiring Node ≥ 20.19 / 22.12 acceptable for the CJS build (required by Nest 12 and better-auth 1.7.4 being ESM-only)? Or should the CJS build lazy-`import()` better-auth?
2. **CORS ownership.** Who owns CORS for auth routes: the library (from `trustedOrigins`), the user (`enableCors`), or a documented per-platform matrix?
3. **Express integration trade-off.** Is requiring users to set `bodyParser:false` on Express acceptable (as REF does)? The alternatives are an early-mount strategy that bypasses user middleware, or the parser name pre-emption hack.
4. **Nest pipeline on auth routes.** Should auth routes ever run through Nest guards and interceptors, i.e. offer a controller strategy? Or is a raw mount the only supported mode?
5. **HTTP/2 and third-party adapters.** Should HTTP/2 and third-party adapters (e.g. Hono) be in the v1 support matrix or only reachable via the extension contract?
6. **Global prefix default.** Should auth routes honour the Nest global prefix by default? better-auth's `basePath` is absolute, and REF excludes it from the prefix.

---

## Appendix A: experiment scripts (re-runnable)

Run the scripts in `EXP11` (Nest 11.1.17, fastify 5.8.2, express 5.2.1) or `EXP12` (Nest 12.0.1, fastify 5.12.1), for example `node exp1-init-order.js fastify '{"bodyParser":false}'`.

| Script                                                           | Purpose                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `exp1-init-order.js`                                             | registration phase vs body state and reachability                                        |
| `exp3-controller-catchall.js`                                    | `@All` patterns, prefix, exclude, versioning, guards                                     |
| `exp4-middleware.js`                                             | middleware path semantics, prefix, exclude                                               |
| `exp5-fastify-web.js`                                            | child plugin with pass-through parsers, Web Request/Response, send vs hijack, CORS, HEAD |
| `exp6-express-web.js`, `exp6b-express-mount.js`                  | better-call bridge on Express (URL/query, cookies, redirect)                             |
| `exp7-express-preempt.js`                                        | parser pre-emption by function name                                                      |
| `exp8-fastify-mw-cors.js`                                        | Fastify middleware vs `@fastify/cors`                                                    |
| `exp9-errors.js`                                                 | error propagation into global filters                                                    |
| `exp10-testing.js`, `exp10b-init-subject.js`                     | `@nestjs/testing` adapter availability and `init$`                                       |
| `exp11-fastify-ready.js`                                         | plugin load timing                                                                       |
| `exp12-all-version.js`                                           | `@All` vs `@Get` header versioning                                                       |
| `exp13-late-path.js` (EXP11), `exp13b-late-decorator.js` (EXP12) | late route path rewrite                                                                  |
| `exp14-return-response.js`, `exp14b-all-response.js`             | controller returning `Response`                                                          |
| `bench.js`                                                       | indicative throughput                                                                    |
| `EXP12/h2test.cjs`                                               | HTTP/2 plus better-call                                                                  |
| `EXP12/unwrap.cjs`                                               | Fastify Response unwrap workaround                                                       |
