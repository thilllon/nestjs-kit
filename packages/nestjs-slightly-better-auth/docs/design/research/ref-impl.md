# Research: reference implementation `@thallesp/nestjs-better-auth` v2.8.0

Scope: a deep read of the reference library at commit `99d4a94` (v2.8.0), checked against better-auth **v1.7.4** source, better-call **1.4.0** (the version better-auth 1.7.4 pins), and NestJS **11.1.17** / **12.0.1** package sources.

## Conventions

- `REF` = `/private/tmp/claude-502/-Users-thilllon-git-nestjs-slightly-better-auth/d03cce33-4991-442c-88b5-c314fe7f3223/scratchpad/ref`
- `BA` = `.../scratchpad/better-auth/packages/better-auth/src` (v1.7.4)
- `CORE` = `.../scratchpad/better-auth/packages/core/src`
- `TMP` = `.../scratchpad/tmp-ref-impl`. It holds the published tarballs I downloaded: `thallesp-nestjs-better-auth-2.8.0`, `better-call-1.4.0`, `better-auth-1.7.4`, `nestjs-{core,common,platform-express,platform-fastify}-12.0.1`, `nestjs-{core,platform-fastify}-11.1.17`, `fastify-5.8.2`, and a `probe/` npm project for runtime and type checks.
- `NEST11` = `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules/@nestjs/*` (11.1.17)
- Citations are `file:line`. Anything I could not confirm by reading source or running code is marked **UNVERIFIED** or **INFERRED**.

## 0. File inventory (everything I read)

| File                                                                                                                | Lines      | Role                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                                                                                                      | 5          | Barrel. Re-exports `decorators`, `auth-service`, `auth-guard`, `auth-module`, `symbols`                                  |
| `src/auth-module.ts`                                                                                                | 411        | Module; mounts the HTTP handler; wires CORS, body parsing, and hooks                                                     |
| `src/auth-module-definition.ts`                                                                                     | 79         | `ConfigurableModuleBuilder`, option types, `MODULE_OPTIONS_TOKEN`                                                        |
| `src/auth-guard.ts`                                                                                                 | 489        | `AuthGuard`, `UserSession`/`BaseUserSession` types, per-context error map                                                |
| `src/decorators.ts`                                                                                                 | 276        | All decorators                                                                                                           |
| `src/auth-service.ts`                                                                                               | 32         | `AuthService`                                                                                                            |
| `src/middlewares.ts`                                                                                                | 191        | Express body-parser re-installer, path matching, node req/res unwrapping                                                 |
| `src/body-parser-options.ts`                                                                                        | 52         | Parser option types, `BYTE_UNITS`                                                                                        |
| `src/fastify-body-parser.ts`                                                                                        | 267        | Replaces Fastify content-type parsers                                                                                    |
| `src/fastify-trusted-origins-cors.ts`                                                                               | 114        | Hand-rolled CORS for auth routes on Fastify                                                                              |
| `src/utils.ts`                                                                                                      | 31         | `getRequestFromContext` (http/graphql/ws)                                                                                |
| `src/symbols.ts`                                                                                                    | 10         | Metadata symbols                                                                                                         |
| `package.json`, `build.config.ts`, `tsconfig.json`, `vitest.config.ts`, `biome.json`, `README.md`, `tests/shared/*` |            | Read in full                                                                                                             |
| `tests/e2e/*`                                                                                                       | 3211 total | Skimmed all 12; read hooks, cors, options, module, websocket, graphql, database-hooks, and session-custom-fields in full |

---

## 1. Module registration: `forRoot`, `forRootAsync`, extras, and options

### 1.1 Builder

`ConfigurableModuleBuilder<AuthModuleOptions>` is configured with `optionsInjectionToken: MODULE_OPTIONS_TOKEN` and `.setClassMethodName("forRoot")`, so the generated methods are `forRoot`/`forRootAsync` (`auth-module-definition.ts:60-64`).

Extras and their defaults are `{ isGlobal: true, disableGlobalAuthGuard: false, disableControllers: false }`. The extras transform forces `exports: [MODULE_OPTIONS_TOKEN]` and `global: extras.isGlobal` (`auth-module-definition.ts:65-78`). The static `@Module` also exports `AuthService` and imports `DiscoveryModule` (`auth-module.ts:80-84`).

`MODULE_OPTIONS_TOKEN = Symbol("AUTH_MODULE_OPTIONS")` (`auth-module-definition.ts:58`) is **not exported** from `index.ts`. `symbols.ts:4` exports a _different_ `AUTH_MODULE_OPTIONS_KEY = Symbol("AUTH_MODULE_OPTIONS")` that nothing uses. Injecting it would fail, because two `Symbol()` calls with the same description are distinct values.

### 1.2 `forRoot`

`forRoot` has two overloads (`auth-module.ts:364-404`):

- `forRoot(options)` is the object form.
- `forRoot(auth, options?)` is **deprecated**. It is normalized by duck-typing (`"auth" in arg1`, lines 376-379).

After calling `super.forRoot`, the method post-processes the returned `DynamicModule`:

- If `disableControllers`, it swaps `module` to `AuthModuleWithoutControllers`, a subclass whose `configure()` is a no-op (`auth-module.ts:407-411`), and sets `controllers: []`.
- Unless `disableGlobalAuthGuard`, it appends `{ provide: APP_GUARD, useClass: AuthGuard }` (`auth-module.ts:392-402`).

### 1.3 `forRootAsync`

`forRootAsync` does the same post-processing (`auth-module.ts:338-362`). The extras (`isGlobal`, `disableControllers`, `disableGlobalAuthGuard`) must be passed at the top level of the async options, not inside `useFactory`'s result. The `auth` instance itself can come from the factory; see the test helper at `tests/shared/test-utils.ts:48-52`.

### 1.4 Options (`AuthModuleOptions`, `auth-module-definition.ts:43-56`)

| Option                         | Default                       | Effect (with citation)                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth`                         | required, typed `any`         | The better-auth instance. `AuthModuleOptions<A = Auth>` where `Auth` is `export type Auth = any` (`auth-module.ts:73-74`), so `forRoot` does not type-check `auth` (published `dist/index.d.mts:194,283-284`).                                                                                                 |
| `disableTrustedOriginsCors`    | `false`                       | Skips CORS wiring (`auth-module.ts:190,247`). See §4.                                                                                                                                                                                                                                                          |
| `bodyParser.json`              | enabled                       | Parser options plus `enabled`. `resolveBodyParserOptions` fills defaults (`middlewares.ts:78-112`).                                                                                                                                                                                                            |
| `bodyParser.urlencoded`        | enabled, **`extended: true`** | Same. `extended` defaults to `true` (`middlewares.ts:94-97`).                                                                                                                                                                                                                                                  |
| `bodyParser.rawBody`           | `false`                       | Attaches `req.rawBody` (Express: JSON only, see §3; Fastify: both parsers).                                                                                                                                                                                                                                    |
| `disableBodyParser`            | `false`                       | Deprecated, logs a warning (`auth-module.ts:207-211`). Flips the default `enabled` of both parsers (`middlewares.ts:84`).                                                                                                                                                                                      |
| `enableRawBodyParser`          | `false`                       | Deprecated, logs a warning (`auth-module.ts:213-217`). Fallback for `rawBody` (`middlewares.ts:87-88`).                                                                                                                                                                                                        |
| `middleware`                   | `undefined`                   | `(req, res, next) => void` wrapping the better-auth handler. `next` invokes the handler (`auth-module.ts:259-263`). Intended for MikroORM `RequestContext` and similar (README:739-754).                                                                                                                       |
| extra `isGlobal`               | `true`                        | Global module: `AuthService` and `MODULE_OPTIONS_TOKEN` are visible everywhere.                                                                                                                                                                                                                                |
| extra `disableGlobalAuthGuard` | `false`                       | If `false`, registers `APP_GUARD` → `AuthGuard`.                                                                                                                                                                                                                                                               |
| extra `disableControllers`     | `false`                       | Misnamed: the library has no controllers. It skips **all of `configure()`**: handler mounting, CORS, _and_ body-parser re-installation. With Nest's `bodyParser: false`, that means no body parsing at all (`auth-module.ts:407-411`). Test: `tests/e2e/options.e2e.test.ts:17-39` expects 404 on auth routes. |

Other facts:

- `ConfigurableModuleBuilder` strips extras from the injected options object, so `isGlobal` and friends never reach `MODULE_OPTIONS_TOKEN` (standard Nest behavior; **UNVERIFIED** in source, but consistent with the typing in `dist/index.d.mts:297-310`).
- Constructor side effect: `AuthModule`'s constructor **mutates the global `ApplicationConfig`**. It appends `basePath` and `basePath/*path` to the global-prefix excludes (`auth-module.ts:113-120`), using Nest internals `normalizePath` (`@nestjs/common/utils/shared.utils.js`) and `mapToExcludeRoute` (`@nestjs/core/middleware/utils.js`) (`auth-module.ts:49-50`). See §2.4 for why this is now mostly vestigial and fragile.

---

## 2. Mounting the better-auth handler (Express vs Fastify)

### 2.1 Mechanism: identical code path for both platforms

The handler is mounted in `configure(consumer)` (`auth-module.ts:182-277`):

```ts
const handler = toNodeHandler(this.options.auth); // :234
this.adapter.httpAdapter.use((req, res, next) => authHandler(req, res, next)); // :267-275
```

It is a raw, path-less, app-level middleware, **not** a Nest controller and **not** Nest route middleware. `authHandler` (`:235-265`) does the following:

1. It checks `matchesBasePath(req, basePath)`, which tests `originalUrl ?? url ?? baseUrl ?? raw.url` with `=== basePath || startsWith(basePath + "/")` (`middlewares.ts:114-130`). A non-match calls `next()`. The comparison includes the query string, so `/api/auth?x` does not match (**INFERRED** from code).
2. On Fastify only, it runs `handleFastifyTrustedOriginsCors` and may end a preflight (`:245-254`).
3. It unwraps `req.raw ?? req` and `res.raw ?? res` (`middlewares.ts:118-124`).
4. It calls `options.middleware(req, res, () => handler(nodeReq, nodeRes))` if one is configured, or else `handler(nodeReq, nodeRes)` directly.

`basePath` is `normalizePath(auth.options.basePath ?? "/api/auth")` (`auth-module.ts:109-111`). It is read from the user's options object, not from better-auth's resolved context. better-auth itself also defaults to `/api/auth` (`BA/auth/base.ts:51`, `BA/context/create-context.ts:197`).

### 2.2 Express

`ExpressAdapter.use` is plain `app.use` (`NEST11/platform-express/adapters/express-adapter.js`, inherited). The auth middleware receives Express `req`/`res`, and `getNodeRequest` returns them unchanged. `enableCors` is `this.use(cors(options))` (`express-adapter.js:169-170`).

**Ordering in Express** comes from Nest's bootstrap order in `NestApplication.init()` (`NEST11/core/nest-application.js:97-105`; Nest 12 is identical at `TMP/nestjs-core-12.0.1/package/nest-application.js:112-117`):

1. `applyOptions()`: `cors` from `NestFactory.create` options.
2. `httpAdapter.init()`.
3. `registerParserMiddleware()`, **only if** `bodyParser !== false`: Nest's own json/urlencoded parsers.
4. `registerModules()`, which runs `MiddlewareModule.register` and calls every module's `configure()`. At this point the ref calls `enableCors(...)` and then `httpAdapter.use(authHandler)`.
5. `registerRouter()`: consumer middleware is bound here (the ref's `SkipBodyParsingMiddleware` on `*path`), then controller routes.
6. `callInitHook()`: `onModuleInit`, where the ref wires `@Hook` and `@DatabaseHook` providers.

So the Express stack is: `[Nest parsers if not disabled] → cors(trustedOrigins) → authHandler → SkipBodyParsing(json, urlencoded) → Nest routes`.

The README and better-auth's docs both require `bodyParser: false` (README:35-51; `better-auth/docs/content/docs/integrations/nestjs.mdx`, "Disable Body Parser"). The ref does **not** detect or warn if the user forgets. With better-call 1.4.0 a pre-parsed body is re-serialized (see §2.5), so JSON auth routes still work, but raw-body-dependent endpoints break. Example: the `@better-auth/stripe` webhook calls `ctx.request.text()` for signature verification (`packages/stripe/src/routes.ts:2000-2001,2027`).

### 2.3 Fastify

`FastifyAdapter.use()` queues middleware until Nest's vendored middie is registered in `adapter.init()`, then calls `instance.use(...)` (`TMP/nestjs-platform-fastify-11.1.17/package/adapters/fastify-adapter.js:130-142,420-428,453-456`; Nest 12 has the same shape at lines 139, 447, 492).

The vendored middie adds its runner on the **`onRequest` hook** by default (`.../adapters/middie/fastify-middie.js:180-189`). It passes **`req.raw`/`reply.raw`**, the Node `IncomingMessage`/`ServerResponse` (`fastify-middie.js:205-222`), and sets `req.originalUrl = req.url` (`:50`). If a middleware ends the response without calling `next`, middie stops silently (`:74-77`).

Consequences on Fastify:

- The auth handler runs **before** Fastify content-type parsing, so the body stream is untouched. That is why the Fastify body-parser work is only about _non-auth_ routes.
- The response is written directly to `reply.raw` by better-call's `setResponse`. Fastify's `reply.header()` values set by earlier hooks or plugins, and `onSend`/`preSerialization` hooks, never apply to auth responses. This is why app-level `@fastify/cors` "does not fully cover" auth routes (README:86, 726-737). The test at `tests/e2e/cors.e2e.test.ts:103-145` asserts ACAO is **absent** on `GET /api/auth/ok` when the lib's CORS is disabled but `@fastify/cors` is registered. (**INFERRED** mechanism for the header loss: Fastify buffers `reply.header()` values until `reply.send`.)
- Correcting my own initial hypothesis: `onResponse` hooks and request logging **do** fire. Fastify calls `setupResponseListeners(reply)` before it runs `onRequest` hooks (`TMP/fastify-5.8.2/package/lib/route.js:552-554`; the listener is `reply.raw.on('finish')` at `lib/reply.js:929`).
- There is no Fastify route for `basePath`, so auth requests travel through Fastify's not-found route context, whose `onRequest` hooks still run (**UNVERIFIED** detail; the e2e suite proves the routes work on Fastify).
- Errors: a _synchronous_ throw inside the `middleware` option reaches Nest's error handler (test `options.e2e.test.ts:41-59`, which runs under both adapters). A _rejected promise_ from `handler(...)` is ignored by middie, which discards `fn`'s return value (`fastify-middie.js:108,113`). That produces an unhandled rejection and a hung request on Fastify (**INFERRED**, not tested). Express 5 forwards rejected promises returned by middleware to `next(err)` (Express 5 behavior, **UNVERIFIED** here).

### 2.4 `basePath` and the Nest global prefix

- Auth routes are **never** prefixed. The handler is a raw `use()` and matches `originalUrl` against the absolute `basePath`. The test "should authenticate with a global prefix" (`tests/e2e/rest-auth.e2e.test.ts:96-131`) posts to `/api/auth/sign-up/email` with prefix `v1`, and the comment says users must change `basePath` on the auth instance instead.
- The `ApplicationConfig.setGlobalPrefixOptions` exclusion in the constructor dates from commit `06e9d4c` (2026-01-30). At that time the handler was mounted via `consumer.apply(...).forRoutes(this.basePath)`, which _is_ subject to the global prefix. Commit `d48c027` (2026-03-08) moved the handler to `httpAdapter.use(...)` for Fastify support. That makes the exclusion **mostly vestigial**. Its remaining effect is that Nest also mounts the `*path` consumer middleware on each excluded route path (`NEST11/core/middleware/route-info-path-extractor.js`, `extractPathsFrom`, wildcard branch).
- **Fragility:** `app.setGlobalPrefix(prefix, options)` _replaces_ the prefix options wholesale (`NEST11/core/nest-application.js:241-251`). A user calling it in `main.ts` (after module constructors ran) silently discards the ref's exclusion.
- **Gap (INFERRED, not tested):** with a global prefix, the `*path` body-parser middleware is mounted only on `/<prefix>$`, `/<prefix>/*path`, and excluded routes (`route-info-path-extractor.js`, the `entries` computation). Non-prefixed endpoints that are not Nest controllers get **no body parsing** when Nest's parser is disabled. Examples: raw Express routes, and possibly `/graphql` when `useGlobalPrefix` is false.

### 2.5 Web/Node conversion (better-auth `toNodeHandler` → better-call 1.4.0)

- `better-auth/node` `toNodeHandler(auth)` just calls better-call's `toNodeHandler(auth.handler)` (`BA/integrations/node.ts:5-13`).
- better-call builds `base` from `x-forwarded-proto` (or `socket.encrypted`) and `:authority`/`host` (`TMP/better-call-1.4.0/package/dist/node.mjs`, `toNodeHandler`).
- `getRequest` (`dist/adapters/node/request.mjs:102-124`):
  - If the stream is still readable, it wraps it as a `ReadableStream` (`get_raw_body`, `:47-94`).
  - **Else, if `req.body` is set (a pre-parsed body), it re-serializes it** as JSON, or as form-urlencoded when the content type is form (`:107-116`).
  - The URL is `base + constructRelativeUrl(req)`, using Express `baseUrl`/`originalUrl` (`:95-101`).
- `setResponse` copies headers, splitting `set-cookie`; writes the status; and streams the body with backpressure (`:125-173`).
- **Body size (INFERRED from source):** `toNodeHandler` passes no `bodySizeLimit`. For chunked requests without `content-length`, `length` is `NaN` and `size > NaN` is never true, so there is **no size cap** on auth-route bodies (`request.mjs:50-56,76-80`). The ref adds no limit.
- `fromNodeHeaders` converts `IncomingHttpHeaders` to `Headers`, appending array values (`BA/integrations/node.ts:15-27`).
- Docs vs source: better-auth's **official Fastify guide** mounts auth as a normal Fastify **route**. It re-stringifies `request.body` and buffers `response.text()` (`better-auth/docs/content/docs/integrations/fastify.mdx`, handler block). The ref instead mounts it as pre-parsing middie middleware that streams. The Express guide says to mount the handler before `express.json()` (`integrations/express.mdx:21-38`), which is what the ref achieves by requiring `bodyParser: false` and re-adding parsers afterwards.

---

## 3. Body parsing: `body-parser-options.ts`, `middlewares.ts`, `fastify-body-parser.ts`

**Why it exists:** better-auth must see the unconsumed request stream on auth routes. The user disables Nest's parser (`bodyParser: false`), and the library re-installs parsers for everything except `basePath`. As a side effect, Nest's `NestFactory.create({ rawBody: true })` stops working, which is why `bodyParser.rawBody` exists (`auth-module-definition.ts:20-32`; README:53-56).

### 3.1 `body-parser-options.ts` (types only)

It defines `JsonBodyParserOptions`, `UrlencodedBodyParserOptions`, and `BodyParserLimit`. `BodyParserLimit` is a number, a template literal like `"2mb"`, or any string. `BYTE_UNITS` is base-2 (`:9-14`). Type matchers can be a string, a string array, or a function (`:3-6`).

### 3.2 Express path: `SkipBodyParsingMiddleware`

`SkipBodyParsingMiddleware` (`middlewares.ts:136-191`) is applied with `consumer.apply(...).forRoutes("*path")` when the adapter type is not `fastify` (`auth-module.ts:219-228`).

- It loads `express` with `createRequire(import.meta.url)`, then `require("express")` (`middlewares.ts:2,9,59-61`). `express` is an **optional** peer (`package.json:84,96-98`).
  - **INFERRED risk:** under pnpm's strict layout, an app that depends on `@nestjs/platform-express` but not directly on `express` may not resolve `express` from the library's location, and fails at `configure()` time.
  - It can also pick up a different Express major than the one Nest's adapter uses.
- It builds `express.json(opts)` and `express.urlencoded(opts)` once at configure time.
- It skips `basePath` requests. Otherwise it chains JSON parsing and then urlencoded (`:161-190`).
- **`rawBody` on Express only attaches for JSON.** The `verify: rawBodyParser` callback is added only to the JSON options (`:151-156`), and urlencoded gets none. Nest's own Express parser applies `verify` to both (**UNVERIFIED** against Nest source; stated from memory of `get-body-parser-options.util`). Fastify applies raw body to both (§3.3), so behavior is inconsistent across adapters.
- Other content types (`text/*`, raw) are not re-added, the same as Nest's default.

### 3.3 Fastify path: `configureFastifyBodyParser`

`configureFastifyBodyParser` (`fastify-body-parser.ts:213-267`) runs from `configure()` when the adapter type is `fastify` (`auth-module.ts:230-232`).

- It calls `fastifyInstance.removeContentTypeParser(["application/json", "application/x-www-form-urlencoded"])` (`:222-225`). This is needed because Nest may already have registered parsers in `init()` step 3 when `bodyParser` was not disabled.
- It re-registers both parsers through `httpAdapter.useBodyParser(type, rawBody, { bodyLimit }, parser)` (`:185-211`). Nest's `useBodyParser` uses `parseAs: 'buffer'`, attaches `req.rawBody` when `rawBody === true`, and sets `_isParserRegistered = true` so Nest won't overwrite it (`TMP/nestjs-platform-fastify-11.1.17/.../fastify-adapter.js:354-372`).
- **JSON parsing is a hand-rolled `JSON.parse`** (`:80-100`). It returns `{}` for an empty body and checks that the first character is `{` or `[` when `strict !== false`.
  - This **replaces Fastify's default secure JSON parser**, which by default rejects `__proto__` and `constructor` keys. Nest's own Fastify JSON parser uses `instance.getDefaultJsonParser(onProtoPoisoning || 'error', onConstructorPoisoning || 'error')` (`fastify-adapter.js:435-443`). This is a **security-hardening regression** relative to Nest defaults.
  - Empty-JSON behavior also differs: Fastify's default errors on an empty JSON body (**UNVERIFIED** exact error code).
- **Urlencoded:**
  - With `extended: false` it uses `URLSearchParams`, and `parameterLimit` **silently truncates** (`:102-127`).
  - With `extended: true`, which is the **default**, it needs the **optional** peer `qs`, loaded via `createRequire` plus `require("qs")` (`:24,159-183`). If `qs` is missing, every urlencoded request to a non-auth route **throws inside the parser**, so the default Fastify config breaks form posts unless `qs` is installed.
- A function `type` matcher throws at configure time on Fastify (`:28-43`). String limits are converted to bytes by regex (`:45-78`).
- `rawBody` for the urlencoded parser reads `bodyParserOptions.json.rawBody` (`:249`). This works only because the resolver stores a single `rawBody` flag under `json` (`middlewares.ts:100-105`).

---

## 4. CORS and `trustedOrigins`

better-auth sets **no CORS headers** itself: there is no `Access-Control-Allow-Origin` anywhere in `BA/**` or `CORE/**` non-test code (grep, zero hits). Its `trustedOrigins` powers its own origin and CSRF checks. In 1.7.4 the type is `string[] | ((request?: Request) => Awaitable<(string | undefined | null)[]>)` (`CORE/types/init-options.ts:1383-1389`). Plugins can contribute origins, which are merged in `runPluginInit`; if any are functions, `options.trustedOrigins` becomes a function (`BA/context/helpers.ts:60-80`). better-auth's matcher `matchesOriginPattern` supports `*`/`?` wildcards, host-only wildcards, and custom schemes (`BA/auth/trusted-origins.ts:116-160`). It is **not publicly exported**, but `(await auth.$context).isTrustedOrigin(url)` exists (`CORE/types/context.ts:369-372`; `BA/context/create-context.ts:298-307`).

The ref's behavior (`auth-module.ts:184-205,245-254`):

- It reads `auth.options.trustedOrigins` from the user's object, so origins contributed by plugins are ignored.
- **Function-based `trustedOrigins`:** it throws at configure time unless `disableTrustedOriginsCors: true` (`:198-205`). The comment blames the lack of a Web `Request` (`:186-187`).
- **Express:** `httpAdapter.enableCors({ origin: trustedOrigins, methods: ["GET","POST","PUT","DELETE"], credentials: true })` (`:190-197`).
  - This is **app-wide**, not auth-only, because `enableCors` is `app.use(cors(...))` (`express-adapter.js:169-170`). It is a hidden global side effect.
  - `methods` omits `PATCH`, so cross-origin PATCH preflights to _app_ routes get an `Allow-Methods` list without PATCH (**INFERRED** browser outcome).
  - The `cors` package matches string origins **exactly** (`cors@2.8.6/lib/index.js:19-34`), so wildcard `trustedOrigins` such as `https://*.example.com`, which better-auth accepts, are **not** honored for CORS on Express.
  - It combines with any user `app.enableCors()` as two stacked `cors` middlewares (**INFERRED**).
- **Fastify:** `handleFastifyTrustedOriginsCors` runs inside `authHandler`, so it covers **auth routes only** (`fastify-trusted-origins-cors.ts:71-114`).
  - Its own matcher is `^` + pattern with `*` → `.*` + `$` over the raw `Origin` string (`:52-65`). It does not support `?` and differs from better-auth's host-wildcard and custom-scheme semantics.
  - For an allowed origin it sets `Access-Control-Allow-Origin` (echoing the origin), `Allow-Credentials: true`, and `Vary: Origin`.
  - On `OPTIONS` it **echoes** the requested method and headers and ends with 204 (`:84-113`). A disallowed origin gets no headers and falls through to better-auth.
  - Tests: `cors.e2e.test.ts:22-60` covers both adapters and `:62-101` covers coexistence with `@fastify/cors`.
- The net effect is **per-platform divergence**: app-wide exact-match CORS on Express versus auth-only wildcard-ish CORS on Fastify.

---

## 5. Hooks: `@Hook`/`@BeforeHook`/`@AfterHook` and `@DatabaseHook`/`@Before*`/`@After*`

### 5.1 Discovery and wiring

Discovery and wiring happen in `onModuleInit` (`auth-module.ts:123-180`):

- It calls `discoveryService.getProviders()` and filters on `Reflect.getMetadata(HOOK_KEY, metatype)`; `@Hook()` is `SetMetadata(HOOK_KEY, true)` on the class (`decorators.ts:205`).
- If hook providers exist but `typeof auth.options.hooks !== "object"`, it **throws** and asks the user to add `hooks: {}` (`auth-module.ts:134-137`; test `hooks.e2e.test.ts:117-143`). The same applies to `databaseHooks: {}` (`:164-167`; test `database-hooks.e2e.test.ts:166-192`).
- For each method from `metadataScanner.getAllMethodNames(prototype)`, `setupHooks` checks `BEFORE_HOOK_KEY`/`AFTER_HOOK_KEY` metadata on the function (`:279-304`).

### 5.2 Wiring **mutates the user's auth instance options after creation**

```ts
const originalHook = this.options.auth.options.hooks[hookType];
this.options.auth.options.hooks[hookType] = createAuthMiddleware(
  async (ctx) => {
    if (originalHook) await originalHook(ctx); // return value DISCARDED
    if (hookPath && hookPath !== ctx.path) return; // exact path match only
    await providerMethod.apply(providerClass, [ctx]); // return value DISCARDED
  },
); // auth-module.ts:291-302
```

**Why this works at all (better-auth internals):**

- `auth.options` is the user's original object (`BA/auth/base.ts:114`).
- The runtime `ctx.options` is a _shallow_ copy: `options = { ...options, ... }` (`BA/context/create-context.ts:189-199`), plus `defu` merges (`create-context.ts:107-117,123-129`; `helpers.ts:50`).
- `defu` keeps nested object references for keys absent from the defaults. So `ctx.options.hooks === auth.options.hooks` **only if** a `hooks` object existed at `betterAuth()` time. That is the real reason for the `hooks: {}` requirement.
- `getHooks()` reads `authContext.options.hooks?.before/after` **on every dispatch** (`BA/api/dispatch.ts:269-307`, called at `:360`), so late reassignment of `hooks.before` on the shared object is picked up.
- Database hooks are captured as references: `{ source: "user", hooks: options.databaseHooks }` (`helpers.ts:83-86`, `create-context.ts:385-387`). They are read lazily per call as `hooks[model]?.create?.before` (`BA/db/with-hooks.ts:42-43`), so nested mutation of the same object works.
- **Fragile:** this depends on better-auth never deep-cloning `hooks` or `databaseHooks`. A plugin whose `init()` returns `options.hooks` would make `defu` produce a new object (`helpers.ts:50`) and silently disconnect every Nest hook. No built-in plugin in 1.7.4 does this; I checked `last-login-method`, `email-otp`, and `username`, which return only `databaseHooks` and `emailVerification` (**INFERRED** for third-party plugins).

### 5.3 Semantic losses and limitations

- **Before-hook return values are dropped.** better-auth uses them: returning `{ context: {...} }` merges into the request, and any other object short-circuits with that response (`dispatch.ts:195-217`; docs `concepts/hooks.mdx:44-66`).
  - The wrapper drops the return value of **the user's original `hooks.before`**. Once any `@BeforeHook` provider exists, a user hook that rewrites the body or short-circuits stops working.
  - It also drops the Nest method's return value, so Nest hooks can only throw or perform side effects.
- **After-hook return values are dropped.** better-auth replaces the response when an after hook returns `response` (`dispatch.ts:259-260`). **UNVERIFIED:** whether headers set by the _original_ hook via `ctx.setCookie` survive when it is invoked as `originalHook(ctx)` inside another middleware. That depends on better-call `createMiddleware` internals I did not trace.
- **Exact path equality only** (`hookPath !== ctx.path`). There is no wildcard or `matcher` support, unlike plugin hooks, which have `matcher` functions (`dispatch.ts:291-304`; docs `concepts/plugins.mdx:284-295`). `@BeforeHook()` with no path runs on **every** endpoint.
- **Hooks also fire for server-side `auth.api.*` calls.** `toAuthEndpoints` routes through `dispatchAuthEndpoint` (`BA/api/to-auth-endpoints.ts:74-100`). So `AuthGuard`'s own `auth.api.getSession()` (path `/get-session`) triggers every path-less Nest `@BeforeHook`/`@AfterHook` **on every guarded request**, and so do `getActiveMemberRole`, `hasPermission`, and `userHasPermission`.
- **Ordering:** user hook first, then Nest providers in discovery order, one nested wrapper per decorated method (`auth-module.ts:291-302`). better-auth then runs plugin hooks _after_ user hooks (`dispatch.ts:302-304`).
- **Database hooks** (`auth-module.ts:306-336`):
  - The chain `await originalHook(...args); return providerMethod.apply(...)` **discards the original's return value**. That value carries better-auth semantics: `false` aborts, and `{ data }` merges (`with-hooks.ts:58-66`).
  - Only the _last_ wrapper's value is returned, and data changes are not threaded between providers.
  - User database hooks run **after** plugin database hooks (`helpers.ts:83-84`).
- **No teardown.** Nothing unwraps on `onModuleDestroy`. When the same exported `auth` singleton is reused across several Nest app instances (tests, HMR), wrappers accumulate and old provider instances stay reachable through closures (**INFERRED** from the absence of any cleanup code).
- **Request-scoped or transient hook providers:** `provider.instance` from `DiscoveryService` is the static-context instance. Methods would run without injected dependencies (**UNVERIFIED**; no test). A class listed as a provider in two modules is discovered twice and double-registered (**INFERRED**).
- `@BeforeHook(path?: \`/${string}\`)` is not typed against the auth instance's endpoint paths (`decorators.ts:191-199`).
- A type probe confirms `AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]` resolves to a context whose `path` is `string`, with `context.session` and `context.returned` available, under better-auth 1.7.4 (`TMP/probe/hookctx.ts`; `tsc` exit 0, with a sanity check showing `tsc` does report errors).

---

## 6. `AuthGuard` decision flow (`auth-guard.ts:140-248`)

```
canActivate(ctx)
 ├─ request = await getRequestFromContext(ctx)        // utils.ts:20-31
 │     graphql → (await import("@nestjs/graphql")).GqlExecutionContext.create(ctx).getContext().req
 │     ws      → ctx.switchToWs().getClient()          (socket.io Socket)
 │     else    → ctx.switchToHttp().getRequest()       (also used for "rpc" → args[0] = payload)
 ├─ session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers || request?.handshake?.headers || []) })   // :142-146
 │     ALWAYS called, even for @AllowAnonymous routes
 ├─ request.session = session; request.user = session?.user ?? null                        // :148-149
 ├─ PUBLIC   (getAllAndOverride handler>class) → return true                                 // :151-156
 ├─ OPTIONAL && !session → return true                                                        // :158-163
 ├─ !session → throw Map[ctxType].UNAUTHORIZED()                                              // :165-166
 ├─ headers = fromNodeHeaders(...) again                                                      // :168-170
 ├─ REQUIRE_ACTIVE_ORG && !session.session.activeOrganizationId → FORBIDDEN("Active organization is required")  // :172-181
 ├─ ROLES → matchesRequiredRole(session.user.role, roles)   (array or comma-split string)    // :183-192, :257-272
 ├─ ORG_ROLES → auth.api.getActiveMemberRole({headers}) ?? auth.api.getActiveMember({headers})  // :194-207, :280-300
 ├─ USER_HAS_PERMISSION → auth.api.userHasPermission({ body:{userId?, role?, permissions}, headers })  // :209-227, :355-423
 ├─ MEMBER_HAS_PERMISSION → auth.api.hasPermission({ body:{permissions}, headers })           // :229-245, :435-488
 └─ return true
```

### 6.1 Semantics and precedence

- All checks use `getAllAndOverride`, so a handler value **replaces** the class value; checks are not merged.
- `@AllowAnonymous` short-circuits everything, including roles. `@OptionalAuth` with a session still enforces roles and permissions. There is no "require auth" override inside a public controller.
- Metadata keys are **bare strings**: `"PUBLIC"`, `"OPTIONAL"`, `"ROLES"`, `"ORG_ROLES"`, `"REQUIRE_ACTIVE_ORG"`, `"USER_HAS_PERMISSION"`, `"MEMBER_HAS_PERMISSION"` (`decorators.ts:22-155`). These can collide with app or other-library `SetMetadata("ROLES")`.
- Authorization always **delegates to better-auth plugin endpoints**. The guard has no access-control logic of its own apart from the `user.role` string match. It calls the endpoints through `this.options.auth.api as any` (`:285,367,450`) and feature-detects with `typeof authApi.x === "function"`.
- When a plugin is missing, or on any thrown error, it logs with `console.error` (not Nest `Logger`) and returns `false`, which becomes a **403** (`:341,371-373,413-421,454-457,479-486`). Misconfiguration therefore looks like "forbidden".

### 6.2 Per-request cost (DB round-trips, with better-auth 1.7.4)

- `getSession` runs on every guarded request, including public ones. It is a DB or secondary-storage lookup unless cookie cache is enabled. Cookie cache is on by default only for stateless setups with no DB or secondary storage (`BA/context/create-context.ts:103-118`).
- `@OrgRoles` calls `/organization/get-active-member-role`, which re-resolves the session via `orgSessionMiddleware` and queries the member row (`BA/plugins/organization/routes/crud-members.ts:1083-1140`).
- `@UserHasPermission` calls `getAuthoritativeSessionFromCtx`. On stateful setups this **bypasses cookie cache**, doing an extra DB read (`BA/api/routes/session.ts:527-538`; `BA/plugins/admin/routes.ts:1864`).
- `@MemberHasPermission` goes through `orgSessionMiddleware` plus `findMemberByOrgId` (`BA/plugins/organization/organization.ts:182-203,256-270`).
- Every one of these `auth.api.*` calls also runs all before and after hooks (§5.3).

### 6.3 Correctness issues found

- **`@UserHasPermission({ userId, role })` options are dead.** better-auth's `userHasPermission` uses `session?.user` whenever the passed headers resolve to a session, and uses `body.role`/`body.userId` only when there is no session (`BA/plugins/admin/routes.ts:1864-1880`). The guard always passes headers after it has already confirmed a session. The e2e test at `tests/e2e/user-has-permission.e2e.test.ts:427-448` expects **403** for a `projectEditor` user on a route decorated `role: "projectAdmin"`. That test passes _because_ `role` is ignored. The README's description of `role`/`userId` (README:351-352) is misleading.
- **Refreshed session cookies are dropped.** `getSession` may slide the DB expiry and emit `Set-Cookie` via `setSessionCookie` or `setCookieCache` (`BA/api/routes/session.ts:351,366-397,413`). The guard calls it without `returnHeaders`/`asResponse`, so those headers never reach the client (**INFERRED** consequence: the client cookie can expire while the DB session was extended, and cookie-cache refresh never lands).
- **Uncaught `APIError` from `getSession`.** It can throw, for example `UNAUTHORIZED` on a concurrent-deletion update failure, or `INTERNAL_SERVER_ERROR` (`session.ts:381-384,427-435`). The guard does not catch, so a non-`HttpException` becomes a Nest **500** over HTTP (**INFERRED**).

### 6.4 Transports

- **HTTP:** `UnauthorizedException` and `ForbiddenException("Insufficient permissions")` (`:84-93`).
- **GraphQL:** the same Nest HTTP exceptions (`:94-103`).
  - The request comes from `getContext().req`, so the user's GraphQL `context` must expose `req`; the test module sets `context: ({req,res}) => ({req,res})` at `tests/shared/test-utils.ts:61-64`.
  - With Mercurius or subscriptions where there is no `req`, `request.headers` throws a TypeError (**INFERRED**, untested).
- **WS:** a lazily imported `WsException("UNAUTHORIZED" | "FORBIDDEN")` (`:65-78,104-113`). Headers come from `socket.handshake.headers`.
  - The session is re-fetched **per message** because guards run per `@SubscribeMessage`.
  - `request.session` is assigned onto the socket object.
  - **The global `APP_GUARD` does not apply to gateways.** Nest builds the WS `GuardsContextCreator` without a config (`NEST11/websockets/socket-module.js:81`), and without config `getGlobalMetadata` returns `[]` (`NEST11/core/guards/guards-context-creator.js:53-56`). The README accordingly requires `@UseGuards(AuthGuard)` (README:94-110).
  - `@nestjs/platform-ws` clients have neither `headers` nor `handshake`, so they are always anonymous (**INFERRED**).
- **RPC:** `new Error("UNAUTHORIZED")`, not `RpcException` (`:114-117`). The "request" is `switchToHttp().getRequest()`, which is the payload, so there are no headers and never a session. The guard also writes `session`/`user` onto the message payload.
- **Unknown context types** (a custom `getType()`): `AuthContextErrorMap[ctxType]` is `undefined`, so `.UNAUTHORIZED` throws a TypeError (`:166`).
- `request.session` **collides with `express-session`'s `req.session`** (**INFERRED**; same property name).

---

## 7. Decorators and `AuthService`

| Export                                                                                                | Kind         | Exact semantics                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AllowAnonymous()`                                                                                    | class/method | `SetMetadata("PUBLIC", true)` (`decorators.ts:22-23`). The guard still calls `getSession` and attaches the session.                                                                                                                                                                                                                                                        |
| `Public`                                                                                              | alias        | Deprecated alias of `AllowAnonymous` (`:160`).                                                                                                                                                                                                                                                                                                                             |
| `OptionalAuth()`                                                                                      | class/method | `SetMetadata("OPTIONAL", true)` (`:30-31`). Passes without a session; with a session, all other checks apply.                                                                                                                                                                                                                                                              |
| `Optional`                                                                                            | alias        | Deprecated alias of `OptionalAuth` (`:165`).                                                                                                                                                                                                                                                                                                                               |
| `RequireActiveOrg()`                                                                                  | class/method | `SetMetadata("REQUIRE_ACTIVE_ORG", true)` (`:37-38`). 403 when there is no `session.session.activeOrganizationId`.                                                                                                                                                                                                                                                         |
| `Roles(roles: string[])`                                                                              | class/method | `SetMetadata("ROLES", roles)` (`:53-54`). Matches `session.user.role` only (admin plugin), which may be an array or a comma-separated string. It deliberately ignores org roles (README:185-186).                                                                                                                                                                          |
| `OrgRoles(roles: string[])`                                                                           | class/method | `applyDecorators(RequireActiveOrg(), SetMetadata("ORG_ROLES", roles))` (`:69-70`). Member role via `getActiveMemberRole`, falling back to `getActiveMember`.                                                                                                                                                                                                               |
| `UserHasPermission(opts)`                                                                             | class/method | Throws at decoration time unless `permission` or `permissions` is given (`:113-122`). Calls `auth.api.userHasPermission`; `permission` wins over `permissions` (`auth-guard.ts:397-401`). `userId` and `role` are effectively ignored (§6.3).                                                                                                                              |
| `MemberHasPermission({ permissions })`                                                                | class/method | Requires `permissions` (`:148-155`). Calls org `hasPermission`. **Does not** apply `RequireActiveOrg` metadata, but returns `false` (403) without an active org (`auth-guard.ts:442-446`).                                                                                                                                                                                 |
| `Session()`                                                                                           | param        | An **async** `createParamDecorator` returning `request.session` (`:172-178`). It works because Nest awaits custom-param values through `getParamValue` (`NEST11/core/router/router-execution-context.js:118-123,144-151`; the external context creator does the same, `helpers/external-context-creator.js:133-138`). It returns `undefined` when `AuthGuard` did not run. |
| `Hook()`                                                                                              | class        | `SetMetadata(HOOK_KEY, true)` (`:205`).                                                                                                                                                                                                                                                                                                                                    |
| `BeforeHook(path?)` / `AfterHook(path?)`                                                              | method       | `SetMetadata(BEFORE_HOOK_KEY/AFTER_HOOK_KEY, path)` (`:191-199`).                                                                                                                                                                                                                                                                                                          |
| `DatabaseHook()`                                                                                      | class        | `SetMetadata(DATABASE_HOOK_KEY, true)` (`:221-222`).                                                                                                                                                                                                                                                                                                                       |
| `BeforeCreate`, `AfterCreate`, `BeforeUpdate`, `AfterUpdate`, `BeforeDelete`, `AfterDelete` `(model)` | method       | `SetMetadata(BEFORE_/AFTER_DATABASE_HOOK_KEY, { model, operation })` (`:228-276`). `model` is `"user"                                                                                                                                                                                                                                                                      | "session" | "account" | "verification"` (`:210`), so plugin models such as `organization`and`member` cannot be targeted. |
| Types                                                                                                 |              | `PermissionCheck`, `UserHasPermissionOptions`, `MemberHasPermissionOptions`, `AuthHookContext`, `DatabaseHookModel`, `DatabaseHookOperation`.                                                                                                                                                                                                                              |

**`AuthService<T extends { api: T["api"] } = Auth>`** (`auth-service.ts:12-32`):

- It exposes `get api(): T["api"]` and `get instance(): T`. `Auth` here is better-auth's `Auth` type (`:2`).
- It has **no** `@Injectable()`. It relies on `@Inject(MODULE_OPTIONS_TOKEN)` for its only constructor parameter.
- The generic is purely a type assertion (`AuthService<typeof auth>` in README:584). There are no helpers that bind the current request's headers; users call `fromNodeHeaders(req.headers)` themselves (README:589-603).

**`UserSession<T>`** (`auth-guard.ts:44-55`) is `T["$Infer"]["Session"]` when `T` is an auth instance. Otherwise it is `BaseUserSession`, meaning `NonNullable<Awaited<ReturnType<ReturnType<typeof getSession>>>>` (`:25-27`), augmented with an optional `user.role` and `session.activeOrganizationId`. A type probe confirms `BaseUserSession.user.id: string` and that there is no `role` on the base type (`TMP/probe/hookctx.ts`).

---

## 8. End-to-end request lifecycle

### 8.1 Express: auth route `POST /api/auth/sign-up/email`

```
Node http → Express app
  (1) [Nest json/urlencoded]        ← only if user forgot bodyParser:false (NestApplication.init step 3)
  (2) cors({origin: trustedOrigins})← app-wide, if trustedOrigins is string[] (auth-module.ts:190-197)
  (3) authHandler (app.use, path-less)
        matchesBasePath(originalUrl) ✓
        [options.middleware(req,res, next=…)]?          (auth-module.ts:259-263)
        toNodeHandler(auth)(req,res)
          better-call getRequest: stream body (or re-serialize req.body if consumed)  (request.mjs:102-124)
          auth.handler(Request) → per-request ctx clone, trustedOrigins resolved       (BA/auth/base.ts:49-109)
            router → dispatchAuthEndpoint → getHooks() → before hooks (user wrapper ⇒ Nest @BeforeHook) → endpoint
              → internalAdapter (databaseHooks ⇒ Nest @BeforeCreate/...) → after hooks
          setResponse(res, Response): headers, status, streamed body                   (request.mjs:125-173)
        (next() never called → Nest router, guards, interceptors, filters are NOT involved)
```

### 8.2 Express: protected app route `GET /users/me`

```
  (1) cors (app-wide)
  (2) authHandler → basePath ✗ → next()
  (3) SkipBodyParsingMiddleware (Nest consumer mw, "*path"; with global prefix only /prefix/*path + excludes)
        express.json → express.urlencoded (rawBody verify only on json)      (middlewares.ts:136-191)
  (4) Nest router → APP_GUARD AuthGuard.canActivate
        auth.api.getSession({headers}) → dispatch (runs ALL user/Nest hooks, path "/get-session")
        attach req.session / req.user → PUBLIC/OPTIONAL/roles/permission checks (more auth.api.* calls)
  (5) interceptors → pipes (@Session() awaited) → handler → filters
```

### 8.3 Fastify: auth route

```
Node http → Fastify router (no route for basePath → not-found route context [UNVERIFIED detail])
  setupResponseListeners(reply)   (fastify lib/route.js:552-554 → onResponse/logging still fire)
  onRequest hooks:
    (1) Nest's own onRequest hook (adapter ctor)             (fastify-adapter.js:108-115)
    (2) [@fastify/cors if registered on adapter before NestFactory]  (example main.ts)
    (3) middie runner (req.raw, reply.raw)                   (fastify-middie.js:180-222)
          authHandler: matchesBasePath ✓
            handleFastifyTrustedOriginsCors → may end OPTIONS with 204   (fastify-trusted-origins-cors.ts:71-114)
            [options.middleware] → toNodeHandler(auth)(raw req, raw res)  (same better-auth pipeline as 8.1)
          response ended → middie stops; onRequest `next` never called → no parsing, no Fastify handler,
          no onSend; reply.header() values from other hooks are never flushed [INFERRED]
```

### 8.4 Fastify: protected app route

```
  onRequest: Nest hook → middie → authHandler basePath ✗ → next() → (no other Nest mw on Fastify)
  preParsing → content-type parser (REPLACED by lib: JSON.parse / qs|URLSearchParams; rawBody)  (fastify-body-parser.ts)
  Fastify route handler → Nest router → AuthGuard (same as 8.2 step 4) → handler → reply.send (onSend runs)
```

---

## 9. Full public API (from `src/index.ts:1-5`; confirmed in published `dist/index.d.mts:445-446`)

- **Values:** `AuthModule`, `AuthGuard`, `AuthService`, `AllowAnonymous`, `Public`, `OptionalAuth`, `Optional`, `RequireActiveOrg`, `Roles`, `OrgRoles`, `UserHasPermission`, `MemberHasPermission`, `Session`, `Hook`, `BeforeHook`, `AfterHook`, `DatabaseHook`, `BeforeCreate`, `AfterCreate`, `BeforeUpdate`, `AfterUpdate`, `BeforeDelete`, `AfterDelete`, `BEFORE_HOOK_KEY`, `AFTER_HOOK_KEY`, `HOOK_KEY`, `AUTH_MODULE_OPTIONS_KEY` (unused, see §1.1), `DATABASE_HOOK_KEY`, `BEFORE_DATABASE_HOOK_KEY`, `AFTER_DATABASE_HOOK_KEY`.
- **Types:** `Auth` (`= any`), `AuthHookContext`, `BaseUserSession`, `UserSession`, `DatabaseHookModel`, `DatabaseHookOperation`, `PermissionCheck`, `UserHasPermissionOptions`, `MemberHasPermissionOptions`.
- **Not exported:** `MODULE_OPTIONS_TOKEN`, the `AuthModuleOptions` type, `OPTIONS_TYPE`/`ASYNC_OPTIONS_TYPE`, body-parser option types, `AuthModuleMiddleware`, `getRequestFromContext`, `SkipBodyParsingMiddleware`. Commit `f52d702` had added option-type exports; `cd951b9` removed them again.

---

## 10. SOLID and Open-Closed critique (concrete citations)

### 10.1 Adding a new HTTP platform requires editing core

- `adapterType !== "fastify"` / `=== "fastify"` branches are spread across `configure()`: CORS (`auth-module.ts:191`), body parsing (`:219`, `:230`), and in-handler CORS (`:246`). A third platform (h3, Hono via an adapter, uWS, Koa) means editing all of them.
- `getNodeRequest`/`getNodeResponse` duck-type `req.raw`/`res.raw` (`middlewares.ts:118-124`), and `getRequestPath` hard-codes an Express/Fastify property list (`:114-116`).
- The Express body parser is hard-wired to `require("express")` (`middlewares.ts:59-61`). The Fastify parser reaches into `httpAdapter.getInstance().removeContentTypeParser` (`fastify-body-parser.ts:217-225`).
- There is no adapter or port interface. The whole integration assumes a Node `IncomingMessage` pipeline through `toNodeHandler`, even though better-auth's primitive is the Web-standard `auth.handler(Request) => Response` (`BA/auth/base.ts:49-120`).

### 10.2 Adding a transport requires editing core

- `AuthContextErrorMap: Record<ContextType | "graphql", ...>` is a closed map keyed by context type (`auth-guard.ts:80-118`).
- `getRequestFromContext` has an `if graphql / if ws / else` chain (`utils.ts:20-31`).
- Header extraction is `request.headers || request?.handshake?.headers || []` (`auth-guard.ts:143-145,168-170`).
- Error classes are hard-coded: `UnauthorizedException`, `ForbiddenException`, `WsException`, and a plain `Error` for RPC.

### 10.3 Adding an authorization rule requires editing core

- `canActivate` is a fixed sequence of `if (reflector.get("X"))` blocks (`auth-guard.ts:172-245`). Every new decorator (`@TeamRoles`, API-key scopes, and so on) requires editing the guard.
- There is no strategy registry, no composition, and no `AND`/`OR` combinators.
- Authentication (session resolution) and authorization (policy) share one class, which violates SRP.

### 10.4 Hidden global side effects

- It mutates the user's `auth.options.hooks` and `databaseHooks` after creation (`auth-module.ts:291-302,320-334`).
- It mutates `ApplicationConfig` global-prefix options in the constructor (`auth-module.ts:113-120`).
- It installs app-wide CORS on Express (`auth-module.ts:192-196`).
- It removes Fastify's default JSON and urlencoded parsers app-wide (`fastify-body-parser.ts:222-225`).
- It registers `APP_GUARD` by default, so every route in the app is protected (`auth-module.ts:392-402`).
- It uses `console.error` in the guard instead of an injectable logger (`auth-guard.ts:341,371,416-420,454,481-485`).
- It writes `session`/`user` onto WS sockets and RPC payloads.

### 10.5 Mutation of user-supplied objects

- `auth.options.hooks[before|after]` is replaced (`auth-module.ts:292`).
- `databaseHooks[model] ??= {}`, `[operation] ??= {}`, and `[hookType] =` are all written (`:323-327`).
- It writes onto `request.session` and `request.user` (`auth-guard.ts:148-149`).

### 10.6 `require()` and ESM or CJS hazards

- It uses `createRequire(import.meta.url)` plus `require("express")` and `require("qs")` (`middlewares.ts:2,9,60`; `fastify-body-parser.ts:2,24,165`). This is valid in ESM. A **CJS build of the same source** needs an `import.meta.url` shim (**INFERRED**; tsdown/rolldown shim behavior is **UNVERIFIED** here). Resolution happens relative to the library, not the app.
- History: bare `require()` broke under ESM and was replaced with `await import()` for `@nestjs/graphql` and `@nestjs/websockets` (commit `63887b3`, 2026-02-22). That made error factories `async` (`auth-guard.ts:82`) and `getRequestFromContext` `async` (`utils.ts:20`).
- Optional-dependency loading is inconsistent: dynamic `import()` in one place, `createRequire` in another.

### 10.7 Reliance on Nest internals

- Deep imports `@nestjs/common/utils/shared.utils.js` and `@nestjs/core/middleware/utils.js` (`auth-module.ts:49-50`).
  - In Nest 12 they still resolve through the `"./*.js"` wildcard export (`TMP/nestjs-common-12.0.1/package/package.json` exports: `".", "./internal", "./*.js", "./*"`).
  - Nest 12 now labels such helpers "Internal module - not part of the public API" and re-exports them from `@nestjs/common/internal` (`TMP/nestjs-common-12.0.1/package/internal.d.ts:1-9`).
- `ApplicationConfig.setGlobalPrefixOptions` is used from a library.
- It relies on the vendored middie's `onRequest` semantics, `useBodyParser`'s `_isParserRegistered` side effect (`fastify-adapter.js:369-371`), and Nest awaiting async param-decorator values.

### 10.8 Reliance on better-auth internals

- The shared `hooks`/`databaseHooks` object reference between `auth.options` and `ctx.options` (§5.2).
- The internal return-value protocol of `createAuthMiddleware`.
- Plugin endpoint names called through `any` (`getActiveMemberRole`, `getActiveMember`, `userHasPermission`, `hasPermission`).

### 10.9 Type-safety holes

- `export type Auth = any` flows into the options type (`auth-module.ts:73-74`; `dist/index.d.mts:194,283`).
- `auth.api as any` appears three times (`auth-guard.ts:285,367,450`).
- `WsException: any` (`auth-guard.ts:65-66`).
- The middleware type uses `req: any, res: any` (`auth-module-definition.ts:35-41`; `auth-module.ts:268-274`).
- Parser options are cast with `as never` (`middlewares.ts:155,158`).
- A `DatabaseHookModel` string union excludes plugin models (`decorators.ts:210`).
- In `setupHooks`, the parameter named `providerClass` is actually the instance (`auth-module.ts:281,308`).
- `forRoot` normalizes arguments by duck-typing (`:376-379`).

---

## 11. Build and packaging

### 11.1 What ships

- The build is **ESM-only**. `package.json` has `"type": "module"` (`:21`) and `exports["."] = { types: "./dist/index.d.mts", import: "./dist/index.mjs", default: "./dist/index.mjs" }` (`:35-41`). There is no `require` condition. Top-level `types` is `dist/index.d.ts` (`:34`).
- unbuild runs with `emitCJS: false` (`build.config.ts:6`).
- The published tarball contains only `dist/index.mjs` (1000 lines), `index.d.mts`, and `index.d.ts`, plus the README and LICENSE (`TMP/thallesp-nestjs-better-auth-2.8.0/package/dist`).
- CJS history:
  - `36aea7c` "fix(build): migrate to ESM-only" (2026-02-16).
  - `f52d702` re-added `dist/index.cjs` (2026-03-08).
  - `cd951b9` dropped it again the same day.
  - The CJS "guard" that remains is test-only: `vitest.config.ts:45-82` transpiles `src/**/*.ts` to CJS with SWC and redirects relative imports to that tree (`:92-113`). It checks that the source _can_ be CommonJS, but no CJS artifact is published.

### 11.2 Decorator metadata

- unbuild uses esbuild with `experimentalDecorators: true` (`build.config.ts:7-13`). esbuild **does not emit `design:paramtypes`**. The bundle contains `__decorateClass`/`__decorateParam` and no `design:paramtypes` (`dist/index.mjs:94-121,428-431,982-992`; grep found none).
- All DI therefore depends on explicit `@Inject(Token)` on every constructor parameter (`auth-module.ts:92-103`, `auth-guard.ts:126-131`, `auth-service.ts:13-16`). This is a hard constraint for any esbuild, rolldown, or tsdown pipeline.

### 11.3 Peers and engines

- Peers: `@nestjs/common` and `@nestjs/core` `^11.1.6 || ^12.0.0`; `better-auth >=1.5.0 <2.0.0`; optional `@nestjs/graphql`, `@nestjs/websockets`, `express`, `graphql`, `qs` (`package.json:78-105`); `typescript ^5.9.2 || ^6.0.0`, which is odd as a runtime peer.
- Engines: `node >=22.22.1` (`:11-13`).
- **Not declared as peers:** `@nestjs/platform-fastify` and `@nestjs/platform-express`.

### 11.4 What CI actually tests

- The CI matrix covers only `adapter: [express, fastify]` (`.github/workflows/test.yaml:12-17`).
- The lockfile pins `@nestjs/core@12.0.1`, `@nestjs/platform-fastify@12.0.1`, **`better-auth@1.5.4`**, and `better-call@1.3.2` (`bun.lock:305,313,625,627`).
- `better-auth` is not even in devDependencies; bun auto-installs peers.
- So **Nest 11 and better-auth 1.7.x are never tested by the reference.**

### 11.5 Ecosystem format facts relevant to dual CJS+ESM

- **better-auth 1.7.4 is ESM-only.** It has `"type": "module"`, exports with only `types`/`default` → `.mjs`, and **zero** `.cjs` files in the published `dist` (`TMP/better-auth-1.7.4/package/package.json`, and `ls dist | grep -c .cjs` returns 0). `@better-auth/core@1.7.4` is the same.
- **Nest 12 is ESM-only.** `"type": "module"`, exports without a `require` condition (`TMP/nestjs-common-12.0.1/package/package.json`). Nest 11 is CJS with no `exports` map.
- better-call 1.4.0 ships both `.mjs` and `.cjs` (`TMP/better-call-1.4.0/package/package.json` `exports["./node"]`).
- Runtime check on **Node v22.22.0**: a `.cjs` file can `require()` `better-auth`, `better-auth/node`, `better-auth/api`, `better-auth/plugins`, `@nestjs/common@12`, `@nestjs/core@12`, and both deep-import paths. `process.features.require_module === true` (`TMP/probe/probe.cjs` output). So a CJS build of the new library works on modern Node **only through `require(esm)`**.
- The d.ts imports only `@nestjs/common`, `@nestjs/core`, `better-auth`, `better-auth/api`, and `node:http`, with no optional peers (`dist/index.d.mts:1-6`). That part is clean.

---

## 12. Other observations

- The current repo `/Users/thilllon/git/nestjs-slightly-better-auth/src` is an older, divergent fork of the ref. `auth-service.ts` and `index.ts` are identical; the other shared files differ substantially, and it has no Fastify files. Its peer range is `better-auth >=1.3.8`.
- The better-auth docs call the NestJS integration "community maintained" and point to the ref (`better-auth/docs/content/docs/integrations/nestjs.mdx`, info callout). They also say Fastify support is "beta".
- better-auth's docs recommend a **plugin** for reusable hooks (`concepts/hooks.mdx:328`). Plugin hooks take `matcher` functions and are arrays (`concepts/plugins.mdx:284-295`); `hooks.before`/`hooks.after` take a single middleware (`concepts/hooks.mdx:122`).
- The example app registers `@fastify/cors` on the adapter before `NestFactory.create` and passes `bodyParser: false` (`examples/nestjs-better-auth-example/src/main.ts`).

## 13. UNVERIFIED items

These were not confirmed by reading source or running code:

1. Fastify not-found context details for auth routes.
2. Unhandled rejection or hang on Fastify when `toNodeHandler` rejects.
3. Express 5 forwarding of rejected middleware promises.
4. Nest Express `rawBody` verify applied to urlencoded as well.
5. Headers set via `ctx.setCookie` inside a chained `originalHook(ctx)` call.
6. Request-scoped hook providers.
7. The `/graphql` body-parsing gap under a global prefix.
8. pnpm strict-layout failure of `require("express")`.
9. tsdown `import.meta.url` shims.
10. Fastify's default empty-JSON error.
