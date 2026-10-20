# better-auth 1.7.4: philosophy and server-side integration surface

Research input for the `nestjs-slightly-better-auth` rewrite. Research only: no design here beyond the "Implications" lists.

## 0. Sources, versions, method

| Item                                                       | Value                                                                                                                    | How verified                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| better-auth                                                | 1.7.4 (npm `latest`)                                                                                                     | `npm view better-auth dist-tags` → `"latest": "1.7.4"`                                         |
| better-auth source                                         | shallow clone at 1.7.4, commit `8d37cc3`                                                                                 | `git log` in `scratchpad/better-auth`                                                          |
| better-call (the router/endpoint engine under better-auth) | **1.4.0, pinned exactly**                                                                                                | `npm view better-auth@1.7.4 dependencies` → `"better-call": "1.4.0"`; `pnpm-workspace.yaml:69` |
| better-call source                                         | cloned tag `v1.4.0` into `scratchpad/tmp-ba-core/better-call-src` (commit `81e83d3`)                                     | `git ls-remote --tags`                                                                         |
| Published tarballs                                         | `npm pack better-call@1.4.0 better-auth@1.7.4 @better-auth/core@1.7.4` → `scratchpad/tmp-ba-core/*`                      | dist matches source (spot-checked `dist/adapters/node/request.mjs`)                            |
| Runtime probes                                             | Node v22.22.0, better-auth 1.7.4, express 5.2.1, fastify 5.12.3, TypeScript 5.9.3, in `scratchpad/tmp-ba-core/cjs-test/` | scripts `probe*.mjs`, `node-probe.mjs`, `req.cjs`, `same.mjs`, `types-probe*/`                 |
| Current repo (being rewritten)                             | better-auth **1.5.5** + better-call **1.3.2** installed                                                                  | `node_modules/.pnpm` listing                                                                   |

Path abbreviations used below:

- `BA/` = `scratchpad/better-auth/packages/better-auth/src/`
- `CORE/` = `scratchpad/better-auth/packages/core/src/`
- `BC/` = `scratchpad/tmp-ba-core/better-call-src/packages/better-call/src/`
- `DOCS/` = `scratchpad/better-auth/docs/content/docs/`
- `REF/` = `scratchpad/ref/src/` (the @thallesp/nestjs-better-auth v2.8.0 reference library)

Anything I could not verify is marked **UNVERIFIED**.

---

## 1. Philosophy: better-auth's design principles

### 1.1 The principles, quoted

| #   | Principle                                                        | Evidence (quote + citation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Framework-agnostic and runtime-agnostic**                      | "Better Auth is a framework-agnostic, universal authentication and authorization framework for TypeScript." (`DOCS/introduction.mdx:7`). "designed to be runtime and framework-agnostic." (`AGENTS.md:3`). "Must work across Node.js, Bun, Deno, and Cloudflare Workers. Avoid runtime-specific APIs." (`AGENTS.md:26`). "Framework agnostic - Works with any framework, not just specific ones" (`DOCS/comparison.mdx:13`).                                                                                                                |
| P2  | **Web-standard Request/Response as the single integration seam** | "Better Auth supports any backend framework with standard Request and Response objects and offers helper functions for popular frameworks." (`DOCS/installation.mdx:240-241`). The type is literally `handler: (request: Request) => Promise<Response>` (`BA/types/auth.ts:9`). Every official framework helper (`toNextJsHandler`, `toSvelteKitHandler`, `toSolidStartHandler`, `toNodeHandler`) is a thin wrapper around `auth.handler` (`BA/integrations/next-js.ts:8-25`, `svelte-kit.ts:8-13`, `solid-start.ts:1-20`, `node.ts:5-13`). |
| P3  | **Plugin-first extensibility; keep core small**                  | "Plugins are a key part of Better Auth, they let you extend the base functionalities." (`DOCS/concepts/plugins.mdx:7`). "Plugin system - Extend functionality without forking or complex workarounds" (`DOCS/comparison.mdx:15`). "Plugins should be as independent as possible. When working on a plugin, prefer modifying the plugin over changing core." (`AGENTS.md:35`).                                                                                                                                                               |
| P4  | **Customize inside the pipeline (hooks) rather than beside it**  | "We highly recommend using hooks if you need to make custom adjustments to an endpoint rather than making another endpoint outside of Better Auth." (`DOCS/concepts/hooks.mdx:9-11`). "If you need to reuse a hook across multiple endpoints, consider creating a plugin." (`hooks.mdx:326-328`).                                                                                                                                                                                                                                           |
| P5  | **Type safety through inference**                                | "Better Auth is designed to be type-safe. Both the client and server are built with TypeScript, allowing you to easily infer types." (`DOCS/concepts/typescript.mdx:7`). better-call "lets you call REST API endpoints as if they were regular functions and allows us to easily infer client types from the server." (`DOCS/concepts/api.mdx:55-57`). `$Infer` exists only as a type (`BA/types/auth.ts:18-30`; runtime value is `undefined`, probe 1).                                                                                    |
| P6  | **Server code calls `auth.api`, never the client SDK**           | "Always invoke client methods from the client side. Don't call them from the server." then "To authenticate a user on the server, you can use the `auth.api` methods." (`DOCS/basic-usage.mdx:96-102`).                                                                                                                                                                                                                                                                                                                                     |
| P7  | **Own your data**                                                | "Keep your data - Users stay in your database, not a third-party service" / "Single source of truth - All user data in one place" (`DOCS/comparison.mdx:21-23`). Use `internalAdapter` rather than raw DB "to get access to `databaseHooks`, proper `secondaryStorage` support" (`DOCS/concepts/hooks.mdx:274`).                                                                                                                                                                                                                            |
| P8  | **Secure by default**                                            | CSRF: origin validation, Fetch Metadata, `SameSite=Lax`, prefer non-simple requests (JSON) (`DOCS/reference/security.mdx:33-66`). Router accepts only `application/json` unless an endpoint opts in (`BA/api/index.ts:295`). Rate limiting on by default in production (`BA/context/create-context.ts:356`). Cookies default `httpOnly`, `sameSite: "lax"`, `secure` + `__Secure-` prefix on https/production (`BA/cookies/index.ts:66-114`). Default secret throws in production (`BA/context/create-context.ts:68-72`).                   |
| P9  | **Explicit API contract, including endpoint metadata**           | "Treat long-standing metadata such as `requireHeaders`, `requireRequest`, endpoint method, schema, and middleware as part of the API contract." and "a server session check without request headers is invalid usage; a server session check with headers but no session cookie is a valid request that returns `null`." (`AGENTS.md:57-59`).                                                                                                                                                                                               |
| P10 | **Framework cookie bridging is a plugin, not a core feature**    | "If the server cannot return a response object, you'll need to manually parse and set cookies. But for frameworks like Next.js we provide [a plugin] to handle this automatically" (`DOCS/basic-usage.mdx:116-118`). "Token refresh responses set an updated account cookie, so server-side integrations must forward the returned `Set-Cookie` header to the browser." (`DOCS/concepts/session-management.mdx:430`).                                                                                                                       |
| P11 | **ESM-first**                                                    | "Note that CommonJS (cjs) isn't supported." (`DOCS/integrations/express.mdx:13`, `DOCS/installation.mdx:395`). `package.json` is `"type": "module"` with ESM-only exports (section 8).                                                                                                                                                                                                                                                                                                                                                      |

### 1.2 Which principles constrain a framework adapter, and how

- **P1 and P2 (agnostic + Web Request/Response).** The adapter translates, it does not interpret. It converts the host request to a `Request`, calls `auth.handler`, and writes the `Response` back unchanged (status, every header including multiple `Set-Cookie`, body stream). All auth semantics stay in better-auth: routing, origin/CSRF, rate limiting, body parsing, redirects, errors. Official adapters contain zero auth logic (`next-js.ts:8-25`, `node.ts:5-13`).
- **P3, P4 and P10 (plugins, hooks, cookie bridging).** Anything framework-specific that must run inside the auth pipeline belongs in a better-auth **plugin** the user adds to `plugins: [...]`. That covers forwarding cookies from direct `auth.api.*` calls, and running Nest-discovered hooks. Precedent: `nextCookies`, `sveltekitCookies`, `tanstackStartCookies`, `expo` (section 7). better-auth hooks are also the only interception point that covers **both** HTTP and `auth.api.*` calls. Middlewares cover HTTP only (`DOCS/concepts/plugins.mdx:64,311`).
- **P5 (inference).** The integration must be generic over the user's `typeof auth`. It must derive session and user types from `typeof auth.$Infer.Session` (or from `auth.api.getSession`'s return type). Plugins such as `custom-session` replace both the `getSession` endpoint and `$Infer.Session` (`BA/plugins/custom-session/index.ts:70-135`). Hard-coded session types are wrong. See 2.3 for the invariance trap.
- **P6 (server uses `auth.api`).** Guards and resolvers should call `auth.api.getSession({ headers })`, not re-read cookies or the DB. Only then do bearer, api-key, custom-session, cookie-cache and multi-session plugins take effect (section 9).
- **P8 (secure by default).** The adapter must not strip or rewrite `Origin`, `Referer`, `Sec-Fetch-*`, `Cookie` or `Content-Type`. It must not disable checks to "make it work". It must forward `Set-Cookie` from server-side session checks. It must give better-auth a trustworthy client IP (section 3.5), otherwise rate limiting falls back to one shared bucket.
- **P11 (ESM).** This collides with the "dual CJS + ESM" requirement. See section 8 for what actually works.

---

## 2. What `betterAuth()` returns

### 2.1 Runtime shape

`createBetterAuth` (`BA/auth/base.ts:15-121`) returns:

```ts
{ handler, fetch: handler, api, options, $context: authContext, $ERROR_CODES: { ...pluginErrorCodes, ...BASE_ERROR_CODES } } as any
```

(`BA/auth/base.ts:110-120`)

Probe 1 confirmed this: `instance keys: [ 'handler', 'fetch', 'api', 'options', '$context', '$ERROR_CODES' ]`, `$Infer at runtime: undefined`, `fetch===handler: true`.

| Member                                     | Meaning                                                                                                                                                                                                                                                                                            | Citation                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `handler(req: Request): Promise<Response>` | HTTP entry point (section 3)                                                                                                                                                                                                                                                                       | `base.ts:49-109`                     |
| `fetch`                                    | Alias of `handler`, new in 1.7                                                                                                                                                                                                                                                                     | `types/auth.ts:10-13`, `base.ts:112` |
| `api`                                      | Record of callable endpoints built once at creation from the **original** `options.plugins`                                                                                                                                                                                                        | `base.ts:39`, `api/index.ts:173-273` |
| `options`                                  | The **original object the user passed**, not normalized. `ctx.options` is a shallow copy (`{...options, secret, baseURL, basePath, plugins: plugins.concat(internal)}`, `create-context.ts:189-198`). Probe 5: `auth.options.basePath` is `undefined` while `ctx.options.basePath` is `/api/auth`. |                                      |
| `$context`                                 | `Promise<AuthContext>`. Init is async (adapter, schema check, plugin `init`). Rejects on config errors such as the default secret in production (`create-context.ts:68-72`).                                                                                                                       | `base.ts:19-38`                      |
| `$ERROR_CODES`                             | Plugin `$ERROR_CODES` merged with `BASE_ERROR_CODES`. Each value is `{ code, message, toString }` (`CORE/utils/error-codes.ts:52-67`).                                                                                                                                                             | `base.ts:40-48,115-118`              |
| `$Infer`                                   | **Type-only.** No runtime property.                                                                                                                                                                                                                                                                | `types/auth.ts:18-30`; probe 1       |

Side effects of `betterAuth()`: init starts immediately (`base.ts:19`). You cannot add plugins to `auth.options.plugins` afterwards: `ctx.options.plugins` is a new array (`create-context.ts:197`) and `auth.api` was already built (`base.ts:39`).

`better-auth/minimal` exports the same `betterAuth` with `initMinimal` (no Kysely) (`BA/auth/minimal.ts:11-15`).

### 2.2 Exported types

```ts
export type Auth<Options extends BetterAuthOptions = BetterAuthOptions> = {
  handler: (request: Request) => Promise<Response>;
  fetch: (request: Request) => Promise<Response>;
  api: InferAPI<ReturnType<typeof router<Options>>["endpoints"]>;
  options: Options;
  $ERROR_CODES: InferPluginErrorCodes<Options> & typeof BASE_ERROR_CODES;
  $context: Promise<AuthContext<Options> & InferPluginContext<Options>>;
  $Infer: /* { Session: { session; user } } & plugin $Infer */;
};
```

(`BA/types/auth.ts:8-31`)

- `InferAPI<API> = InferSessionAPI<API> & FilteredAPI<API>` (`BA/types/api.ts:53`).
  - `FilteredAPI` **omits at the type level** any endpoint whose `metadata` is `{isAction: false}` or `{scope: "http"}` (`types/api.ts:4-17`). It is still present at runtime (`api/to-auth-endpoints.ts:88-116` wraps every endpoint).
  - `InferSessionAPI` gives `getSession` a special signature: `{ headers: Headers; query?: { disableCookieCache?, disableRefresh? }; asResponse?; returnHeaders? }`. The return is `Promise<X | null>`, `Promise<{headers, response}>` or `Promise<Response>` (`types/api.ts:19-51`). **`returnStatus` is not in this typed signature**, though the runtime accepts it.
- `BetterAuthOptions`, `BetterAuthPlugin`, `AuthContext`, `GenericEndpointContext`, `HookEndpointContext` come from `@better-auth/core` and are re-exported by `better-auth` (`BA/index.ts:3`, `BA/types/index.ts:1-15`).
- `better-auth` also re-exports every better-call type (`export type * from "better-call"`, `BA/index.ts:28`).

### 2.3 Type-level trap: `Auth<SpecificOptions>` is not assignable to `Auth`

Probe `types-probe/esm.mts` (TS 5.9.3, strict) with `betterAuth({ plugins: [admin(), organization(), bearer()], user: { additionalFields: … } })`:

- `const x: Auth = auth` → **error TS2322** "Types of property '$context' are incompatible … Types of property 'adapter' are incompatible … `DBAdapter<{…}>` is not assignable to `DBAdapter<BetterAuthOptions>`".
- `const x: Auth<BetterAuthOptions> = auth` → same error.
- A structural minimal contract `{ handler; api: { getSession(ctx: {headers: Headers}): Promise<unknown> }; options: BetterAuthOptions; $context: Promise<unknown> }` → **compiles**.
- `typeof auth.$Infer.Session` correctly carries `user.role` (admin), `user.tenantId` (additionalFields) and `session.activeOrganizationId` (organization) → **compiles**.

The docs also warn: "If you're running into issues with TypeScript inference exceeding maximum length the compiler will serialize… ensuring that both `declaration` and `composite` are not enabled." (`DOCS/concepts/typescript.mdx:36-39`). Our library emits declarations, so it should not re-export deeply inferred `Auth<…>` types from its own code.

---

## 3. `auth.handler(request)`

### 3.1 Pipeline, in order

1. **Await init**: `const ctx = await authContext` (`base.ts:50`). Init failures reject here, so `auth.handler` can **throw**. It does not always return a Response.
2. **Per-request context clone** (`base.ts:53-105`):
   - With a dynamic `baseURL` (`{allowedHosts}`), `resolveRequestContext`. Disallowed hosts **throw** `BetterAuthError('Host "evil.com" is not in the allowed hosts list')` out of `handler` unless `fallback` is set (`auth/full.test.ts:176-195`).
   - Otherwise a prototype clone. If no `baseURL` is configured, it is derived from the request (`getBaseURL(undefined, basePath, request, …, trustedProxyHeaders)`) and throws if it cannot be (`base.ts:76-95`).
   - `trustedOrigins` and `trustedProviders` are recomputed per request, so function-valued `trustedOrigins(request)` works (`base.ts:97-104`).
3. `router(handlerCtx, options)` builds a better-call router **per request** (`base.ts:107`, `api/index.ts:274-407`). Execution is wrapped in `runWithAdapter` (`base.ts:108`).
4. better-call `createRouter(...).handler` (`BC/router.ts:294-309`):
   - `onRequest(req)` runs first. It may return a `Response` (short-circuit) or a replacement `Request`.
   - better-auth's `onRequest` (`api/index.ts:297-335`), in order:
     1. `disabledPaths` → `404 "Not Found"` (`:299-303`)
     2. await pending schema check (`:305-306`)
     3. **rate limit** → 429 (`:310-313`)
     4. each plugin's `onRequest`, which may return `{response}` or `{request}` (`:315-332`)
   - `processRequest` (`BC/router.ts:170-292`):
     - **basePath**: the router basePath is `new URL(ctx.baseURL).pathname` (`api/index.ts:280`). A request outside it gets `404` (`BC/router.ts:181-184`). An empty path or `//` gets 404 (`:191-193`). Trailing slash mismatch gets 404 unless `advanced.skipTrailingSlashes` (`:196-205`, `api/index.ts:296`).
     - Route lookup via `rou3`. Endpoints with `metadata.SERVER_ONLY` or no `path` are never routed (`BC/router.ts:140-153`).
     - Query parsing: repeated keys become arrays (`:209-220`).
     - **Body read** via `getBody` (3.2). Honors `disableBody` and `cloneRequest` (`:235-240`).
     - Context `{ path, method, headers, params, request, body, query, _flag: "router", asResponse: true, context: routerContext }` (`:229-245`).
     - **Router middlewares**: better-auth registers `originCheckMiddleware` on `/**`, then plugin `middlewares` (`api/index.ts:288-294`, `BC/router.ts:246-257`).
     - Endpoint call → `toAuthEndpoints` wrapper → `dispatchAuthEndpoint` (hooks pipeline, section 6).
     - `catch`: better-auth's `onError` logs. It **rethrows only if `onAPIError.throw`**. Re-thrown APIErrors still become responses. Non-APIErrors become `500` with a null body, or are thrown out of `handler` when `onAPIError.throw: true` (`api/index.ts:355-405`, `BC/router.ts:261-291`).
   - `onResponse(res)`: each plugin's `onResponse` may return `{response}` to replace it (`api/index.ts:336-354`).

Verified in probe 1 (NODE_ENV=production): a path outside basePath → `404`. Probe 3: `OPTIONS` and `HEAD` to `/get-session` → **404 with no headers**. better-auth does **not** answer CORS preflight or HEAD; the host framework must.

### 3.2 How the body is read (`BC/utils.ts:5-98`)

- `request.body === null` → `undefined`, with no content-type validation (GET is fine).
- **Allowed media types**: the router-level default is `["application/json"]` (`api/index.ts:295`). An endpoint can override via `metadata.allowedMediaTypes`:
  - sign-up/email: urlencoded + json (`api/routes/sign-up.ts:38`)
  - sign-in/email: same (`sign-in.ts:446`)
  - `/callback/:id`: urlencoded + json for Apple `form_post` (`api/routes/callback.ts:51-54`)
  - device authorization (`plugins/device-authorization/routes.ts:259`)
  - A mismatch gives **415** `UNSUPPORTED_MEDIA_TYPE`. Probe 1: urlencoded POST to `/sign-out` → `415 {"message":"Content-Type \"application/x-www-form-urlencoded\" is not allowed. Allowed types: application/json","code":"UNSUPPORTED_MEDIA_TYPE"}`.
- JSON (`application/json`, `+json`) → `request.json()`. A SyntaxError becomes **400** `"Invalid JSON in request body"` (`:41-53`). Other errors, such as an already-consumed body, are rethrown and become a 500.
- `application/x-www-form-urlencoded` → `formData()` flattened to strings (`:55-62`). Multipart, text, octet-stream, pdf/image/video and stream bodies are also handled (`:64-97`).
- `cloneRequest: true` (for example `sign-up/email`, `sign-up.ts:36`) makes the router read from `request.clone()`.

**Adapter consequence:** the `Request` handed to `auth.handler` must carry the original `Content-Type` and an unconsumed body stream whose bytes match that content-type.

### 3.3 Origin check / CSRF / trustedOrigins

- `originCheckMiddleware` (`BA/api/middlewares/origin-check.ts:67-151`) runs on every routed request.
  - It skips `GET`/`OPTIONS`/`HEAD` and requests with no `ctx.request` (`:69-76`).
  - It calls `validateOrigin`. That validates `Origin` (falling back to `Referer`) against trusted origins **only when a `cookie` header is present** (`:230-251`). A missing or `null` origin gives `403 MISSING_OR_NULL_ORIGIN` (`:271-273`). An untrusted origin gives `403 INVALID_ORIGIN` (`:289-296`). There is `Origin: null` + `Sec-Fetch-Site: same-origin` inference (`:253-269`).
  - It then validates `callbackURL`, `redirectTo`, `errorCallbackURL` and `newUserCallbackURL` in body/query against `trustedOrigins`, allowing relative paths (`:83-150`).
- `formCsrfMiddleware` is used by `sign-in/email`, `sign-up/email`, magic-link and email-otp. For cookie-less requests it applies a Fetch Metadata check: `Sec-Fetch-Site: cross-site` + `Sec-Fetch-Mode: navigate` gives `403 CROSS_SITE_NAVIGATION_LOGIN_BLOCKED`. If Origin/Referer is present it is validated (`origin-check.ts:303-375`; usages: `api/routes/sign-in.ts:406`, `sign-up.ts:34`, `plugins/magic-link/index.ts:212`, `plugins/email-otp/routes.ts:101`).
- **Trusted origins** = the `baseURL` origin (or dynamic `allowedHosts`), plus `options.trustedOrigins` (array or `(request) => …`), plus `BETTER_AUTH_TRUSTED_ORIGINS` env, plus origins returned by plugin `init()` (`BA/context/helpers.ts:108-160`, `:26-84`).
- **Defaults and switches:**
  - `skipOriginCheck` defaults to **`true` when `NODE_ENV === "test"` or `TEST` env is truthy** (`create-context.ts:398-403`; `isTest` at `CORE/env/env-impl.ts:59`). e2e tests will not exercise origin/CSRF unless they set `advanced.disableOriginCheck: false` (as probe 1 did).
  - `disableOriginCheck: true` also disables CSRF for backward compatibility (`origin-check.ts:15-20`; `DOCS/reference/security.mdx:118`).
- Probe 1: POST `/sign-out` with a valid cookie and `Origin: http://evil.com` → `403 {"message":"Invalid origin","code":"INVALID_ORIGIN"}`.
- **Important:** origin/CSRF checks run only when there is a `request` (HTTP). A direct `auth.api.signInEmail({ body, headers })` call has no `ctx.request` and skips them (`origin-check.ts:69-76`, `:317-320`; probe 3 shows `hasRequest: false` for direct calls). Proxying HTTP through custom Nest controllers that call `auth.api.*` therefore silently drops CSRF protection.

### 3.4 Rate limiting

- It runs **only in the router's `onRequest`**, so `auth.api.*` calls are never rate limited (`api/index.ts:310-313`). The docs agree: "Server-side requests made using `auth.api` aren't affected by rate limiting." (`DOCS/concepts/rate-limit.mdx:12-14`).
- It is enabled by default only when `NODE_ENV === "production"`. Defaults are `window: 10` s and `max: 100` (`create-context.ts:354-358`).
- Built-in stricter rules:
  - `/sign-in*`, `/sign-up*`, `/change-password*`, `/change-email*`: 3 requests per 10 s
  - password-reset and verification-email paths: 3 per 60 s
  - (`api/rate-limiter/index.ts:439-468`)
- Plugin `rateLimit[]` and `customRules` override these (`:368-407`).
- The key is `ip|path`. The response is 429 with an `X-Retry-After` header (`:94-107`, `:359`).
- Storage: memory, database, secondary storage or custom (`:270-328`).

### 3.5 Client IP (critical for Node adapters)

- `getIP(req, options)` reads **headers only**. The default header list is `["x-forwarded-for"]`. A multi-hop chain is rejected unless `advanced.ipAddress.trustedProxies` is set. In dev/test it falls back to `127.0.0.1`, otherwise to `null` (`CORE/utils/ip.ts:293-383`).
- When the IP is `null` in production, rate limiting **fails closed onto a single shared per-path bucket** and logs a warning (`api/rate-limiter/index.ts:337-359`).
  - Probe 1 (production, no XFF) printed: "Rate limiting could not determine a client IP and is falling back to a single shared per-path bucket…".
  - With the 3-per-10 s sign-in rule, one client can therefore throttle sign-in for everyone.
- A Web `Request` built from `IncomingMessage` does not carry the socket address, so the adapter cannot "just pass" the IP.

### 3.6 What it returns

- Always a `Response`, unless it throws per 3.1. Endpoint return values go through `toResponse` (`BC/to-response.ts:151-225`):
  - JSON-serializable data → `application/json`
  - `null` → body `"null"`
  - string → `text/plain`
  - `ReadableStream`/`Blob`/`ArrayBuffer`/`FormData`/`URLSearchParams` are passed through
  - **`APIError`** → status `statusCode`, body `e.body` (JSON `{message, code, …}`), headers `e.headers` (`:184-190`)
- `toResponse` strips request-only and hop-by-hop headers from merged headers (`:84-133`).
- **Raw `Response` from an endpoint** is returned as-is and **skips after-hooks** (`BA/api/dispatch.ts:421-424`). Endpoints returning raw Responses include:
  - the default error page (HTML, `BA/api/routes/error.ts:422-439`)
  - open-api reference (HTML)
  - oauth-provider, SSO and mcp routes (grep `return new Response(`)
  - So the adapter must pass through arbitrary content types, not just JSON.
- **Set-Cookie:** `ctx.setCookie` appends one header per cookie (`BC/context.ts:294-308`). Merges keep multiple cookies (`dispatch.ts:86-100`, `BC/to-response.ts:140-149`). Adapters must read them with `headers.getSetCookie()` or iterate entries. `headers.get("set-cookie")` comma-joins.
- **Redirects:** `ctx.redirect(url)` returns `APIError("FOUND")` with `location` (`BC/context.ts:309-312`). It becomes a normal **302 Response** with `Location` and any cookies, and is not logged (`api/index.ts:356-358`). The adapter must not follow redirects or treat 3xx as errors.
- **Streaming:** bodies are `ReadableStream`s. better-call's Node `setResponse` streams chunk by chunk with backpressure (`BC/adapters/node/request.ts:255-339`).
- `/get-session` always sets `cache-control: no-store` and `pragma: no-cache` (`BA/api/routes/session.ts:72-73`; probe 1 confirmed `cache-control, pragma, set-cookie` on `returnHeaders`).

### 3.7 Mount path (verified)

Probe 5:

| config                                                           | `ctx.baseURL` | serves                             |
| ---------------------------------------------------------------- | ------------- | ---------------------------------- |
| `{baseURL:"http://localhost:3000"}`                              | `…/api/auth`  | `/api/auth/*`                      |
| `{…, basePath:"/auth"}`                                          | `…/auth`      | `/auth/*`                          |
| `{baseURL:"http://localhost:3000/custom", basePath:"/api/auth"}` | `…/custom`    | **`/custom/*` (basePath ignored)** |

When `baseURL` has a path, `withPath` keeps it and ignores `basePath` (`BA/utils/url.ts:74-88`). The true mount path is therefore `new URL((await auth.$context).baseURL).pathname` for static configs. For dynamic `{allowedHosts}` configs, `ctx.baseURL` is `""` at init and the per-request path is `options.basePath || "/api/auth"` (`base.ts:51`, `context/helpers.ts:216-223`).

The reference library computes excluded routes from `auth.options.basePath ?? "/api/auth"` (`REF/auth-module.ts:106-118`), which is wrong for the third row.

---

## 4. `auth.api.*`: server calls

### 4.1 Signature and flags

Each `auth.api[key]` is `async (context?) => …` built by `toAuthEndpoints` (`BA/api/to-auth-endpoints.ts:74-118`). Accepted input (better-call `InputContext`, `BC/context.ts:186-201`):

| field                     | notes                                                                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `body`, `query`, `params` | Validated by the endpoint's Standard Schema. Failure gives `APIError(400, {code:"VALIDATION_ERROR"})` (`BC/endpoint.ts:601-625`).                                                                                                                                 |
| `headers`                 | `HeadersInit`. `getSession` requires them at the type level (`requireHeaders: true`, `session.ts:36`). Cookies are parsed from here (`BC/context.ts:220-231`).                                                                                                    |
| `request`                 | A Web `Request`. **If present and `asResponse` is not given, `asResponse` defaults to `true`** (`to-auth-endpoints.ts:104`, `dispatch.ts:336`). Probe 2: `getSession({headers, request})` returned a `Response`.                                                  |
| `asResponse`              | Return a `Response`. **Endpoint APIErrors are then returned as error Responses, not thrown** (probe 4: `401` Response). **But an APIError thrown in a _before hook_ is still thrown** (probe 4: "THROWN true 403"; code path `dispatch.ts:183-191` has no catch). |
| `returnHeaders`           | Return `{ headers: Headers, response }`, with Set-Cookie etc. (`dispatch.ts:467-477`).                                                                                                                                                                            |
| `returnStatus`            | Return `{ status, response }`. `status` is only set if the handler called `ctx.setStatus()`; it is **`undefined` on normal success** (probe 1: `signIn returnStatus: undefined`).                                                                                 |
| `method`                  | Override for multi-method endpoints.                                                                                                                                                                                                                              |
| `context`                 | **Ignored.** `toAuthEndpoints` replaces it with the resolved `AuthContext` (`to-auth-endpoints.ts:100-105`).                                                                                                                                                      |

Other behavior:

- Request-scoped state: if the caller is not already inside `runWithRequestState`, each call creates a fresh `WeakMap` store (`to-auth-endpoints.ts:108-112`). A host that wraps the whole host request in `runWithRequestState` makes all `auth.api` calls in that request share state (for example `setShouldSkipSessionRefresh`).
- Dynamic `baseURL` configs throw `APIError(500)` on direct calls unless `headers` (with host) or `request` is passed, or `fallback` is set (`to-auth-endpoints.ts:34-66`).
- Hooks (before/after, user and plugin) **run for direct calls too**. Router middlewares (origin check, plugin `middlewares`) and rate limiting **do not**. Probe 3 shows the user before-hook firing for a direct call with `flag: null, hasRequest: false`.

### 4.2 Errors

- Class: `APIError` from `better-auth/api`. It is `@better-auth/core/error`'s subclass of better-call's `APIError` (`CORE/error/index.ts:16-44`), with static helpers `APIError.from(status, {code, message})` and `APIError.fromStatus`. Base class: `BC/error.ts:200-229,257`.
- Shape (probe 1): `name: "APIError"`, `status: "UNAUTHORIZED"` (string key **or** number), `statusCode: 401` (number), `body: {"message":"Invalid email or password","code":"INVALID_EMAIL_OR_PASSWORD"}`, `headers: HeadersInit`, `message`, plus a hidden-stack getter `errorStack`.
- **Headers accumulated before the throw** (for example Set-Cookie from `deleteSessionCookie`) are attached under the non-enumerable symbol `Symbol.for("better-call:api-error-headers")` (`BC/error.ts:252-254`, `dispatch.ts:451-458`, `CORE/api/index.ts:42-53`). Probe 1: `[ 'Symbol(better-call:api-error-headers)' ]`. A host that converts a thrown APIError into an HTTP response should merge those cookies.
- **Detection:** use `isAPIError(e)` from `better-auth/api`. It checks `instanceof` against both better-call's and core's APIError **or `name === "APIError"`** (`CORE/utils/is-api-error.ts:4-10`). `instanceof` alone is unsafe across module copies (probe `same.mjs`: `require("better-call")` yields a **different** `APIError` class than better-auth's ESM import; `instanceof` is false, `isAPIError` is true).
- `status` strings map to `statusCodes` (`BC/error.ts:82-133`). `BetterAuthError` (a plain `Error`, `CORE/error/index.ts:3-10`) is used for configuration and runtime faults and is **not** an APIError.
- `getSession` never throws for "no session". It returns `null` (probe 2). It throws 405 if POST is used without `deferSessionRefresh` (`session.ts:79-84`), 401 on a failed refresh update (`:376-385`) and 500 on unexpected errors (`:427-436`).

### 4.3 Can `getSession` produce Set-Cookie? Yes, on many paths.

`getSession` (`BA/api/routes/session.ts:29-438`) writes response cookies in these cases:

| #   | Condition                                                                                 | Cookie effect                                                                     | Lines                                          |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | `session_data` cookie present but cookie cache disabled                                   | clear all `session_data` chunks                                                   | 102-109                                        |
| 2   | Cookie cache enabled, cache cookie undecodable                                            | expire `session_data`                                                             | 120-122                                        |
| 3   | Cache cookie stale, wrong token, version mismatch or expired                              | expire `session_data`                                                             | 167-168                                        |
| 4   | Stateless `refreshCache`: cache near expiry and not skipped                               | **set `session_data` + re-set `session_token` (new max-age)**                     | 204-230                                        |
| 5   | Token signature valid but session missing or expired                                      | `deleteSessionCookie` (expires token, data, dont_remember, account/oauth cookies) | 290-291 (helper `BA/cookies/index.ts:505-548`) |
| 6   | `deferSessionRefresh` + GET                                                               | set cookie cache (if enabled)                                                     | 350-351                                        |
| 7   | **Sliding refresh due** (`updateAge` elapsed; default 1 day, `create-context.ts:309-312`) | **DB `expiresAt` extended + `session_token` re-set with new max-age (+ cache)**   | 367-397                                        |
| 8   | Refresh update failed                                                                     | `deleteSessionCookie`, then 401                                                   | 380                                            |
| 9   | Normal DB hit with cookie cache enabled                                                   | **set `session_data`**                                                            | 413                                            |

Verified (probes 1/2):

- `session: { updateAge: 0 }` → `getSession({returnHeaders:true})` set-cookie = `['better-auth.session_token']` (row 7).
- DB + `cookieCache.enabled` with only the token cookie → set-cookie = `['better-auth.session_data']` (row 9).
- Default DB config, fresh session → 0 cookies.
- **Stateless (no database):** better-auth force-enables `cookieCache` with `strategy:"jwe"`, `refreshCache:true`, `maxAge` = `expiresIn` (7 d), and `cookieRefreshCache.updateAge` = 120960 s (`create-context.ts:104-116`, probe 2). Row 4 then fires routinely.

Consequences for a server integration:

- `auth.api.getSession({ headers })` **without `returnHeaders: true` silently drops these cookies.**
  - Row 7: the DB session expiry is extended but the browser cookie's max-age is not. That is the "DB/cookie mismatch" better-auth itself works to avoid (`BA/integrations/next-js.ts:76-91`, `BA/api/state/should-session-refresh.ts:3-10`).
  - Row 9: the cache never lands, so every request hits the DB.
  - Row 5: stale cookies are never cleared.
- The reference library's guard does exactly this: it calls `getSession({ headers: fromNodeHeaders(...) })` with no `returnHeaders` (`REF/auth-guard.ts:142-146`).
- Forward **only `set-cookie`**. `getSession` also returns `cache-control: no-store` and `pragma: no-cache`, which would poison ordinary controller responses. better-auth filters exactly those two when re-using getSession internally (`session.ts:498-512`).
- **Transports that cannot deliver Set-Cookie** (WebSocket after upgrade, GraphQL subscriptions, microservice/RPC) have two knobs:
  - `query: { disableRefresh: true }`: skips rows 6/7/9 via the early return at `:309-323`. It does **not** stop row 4, whose branch only checks `getShouldSkipSessionRefresh()` (`:199-204`).
  - `setShouldSkipSessionRefresh(true)`: a request-state flag exported from `better-auth/api` (`BA/api/index.ts:424-427`) and used by `nextCookies` for RSC (`next-js.ts:87-91`). It covers rows 4 and 7 but must be set inside a request-state scope.
  - Cleanup cookies (rows 1/2/3/5) are still emitted either way.

---

## 5. `better-auth/node`: `toNodeHandler` and `fromNodeHeaders`

### 5.1 Implementation

`BA/integrations/node.ts` (entire file):

- `toNodeHandler(auth | auth.handler)` → better-call's `toNodeHandler(handler)` (`:5-13`).
- `fromNodeHeaders(nodeHeaders)` → `new Headers()`. Array values are appended, others set, `undefined` skipped (`:15-27`).

better-call `toNodeHandler` (`BC/adapters/node/index.ts:5-14`):

```ts
const protocol =
  req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
const base = `${protocol}://${req.headers[":authority"] || req.headers.host}`;
const response = await handler(getRequest({ base, request: req }));
return setResponse(res, response);
```

- It **trusts `x-forwarded-proto` unconditionally** when building `request.url`. That only matters if `baseURL` is unset, since better-auth then derives the origin from `request.url` (`BA/utils/url.ts:142-190`). better-auth's own `trustedProxyHeaders` gate applies only to `x-forwarded-host/proto` inference inside `getBaseURL`.
- It **never calls `next()`**. It always writes a response, including 404 for paths outside basePath, so it must be mounted only on the auth prefix.
- The returned async function rejects if `auth.handler` throws (3.1). Express 5 forwards the rejection; other hosts need a catch.

### 5.2 Request conversion: `getRequest` (`BC/adapters/node/request.ts:213-253`)

**Raw-first strategy (better-call ≥1.4.0):**

- For methods other than GET/HEAD:
  - If the stream is still readable (`!destroyed && readableEnded !== true && readable`, `:76-80`), stream it raw (`get_raw_body`, `:98-183`, with optional `bodySizeLimit`).
  - Otherwise, if `req.body !== undefined` (**pre-parsed by a body parser**), re-serialize it (`:233-243`):
    - `string` → as is
    - `URLSearchParams` → `toString()`
    - form-urlencoded content-type + plain object → re-encode as urlencoded (nested plain objects become `JSON.stringify` values, arrays repeat the key; `:41-74`)
    - anything else → `JSON.stringify`
  - Otherwise the body is `undefined`.
- URL = `base + constructRelativeUrl(req)`. That handles Express `baseUrl`/`originalUrl` for sub-routers and wildcard mounts (`:185-211`).
- Headers: `request.headers` (raw Node object) is passed straight to `new Request` (`:246-252`).

Answers to the specific questions:

- **Does it require an unconsumed stream?** No, as of better-call 1.4.0. It prefers the raw stream but falls back to a pre-parsed `req.body`.
- **What if a body parser already consumed it?** It works **if and only if** the parser left the result on `req.body` of the **same IncomingMessage** passed to `toNodeHandler`.
- **Version-dependent:** better-call **1.3.2** (installed in the current repo with better-auth 1.5.5) used "pre-parsed first" and always `JSON.stringify`'d objects, even for urlencoded bodies (`node_modules/.pnpm/better-call@1.3.2…/dist/adapters/node/request.mjs:59-67`).
- The docs are **more conservative than the source**: "Mount the Better Auth handler before body-parsing middleware such as `express.json()`" (`DOCS/integrations/express.mdx:20-24`), and the NestJS page says to disable Nest's body parser (`DOCS/integrations/nestjs.mdx:30-45`).

Verified matrix (`node-probe.mjs`, NODE_ENV=development, sign-up via fetch):

| Case                                                                                                                                             | Result                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Express 5, handler before `express.json()` (raw)                                                                                              | 200, 1 cookie                                                                                                                                                  |
| B. Express 5, `express.json()` **before** handler (pre-parsed)                                                                                   | 200, 1 cookie                                                                                                                                                  |
| C. Express 5, `express.urlencoded({extended:true})` before handler, form sign-up                                                                 | 200, 1 cookie                                                                                                                                                  |
| D. Express sub-router `app.use("/api/auth", router)`                                                                                             | 200                                                                                                                                                            |
| **E. Fastify 5, default parsers, `toNodeHandler(req.raw, reply.raw)`**                                                                           | **400** "[body] Invalid input: expected object, received undefined". Fastify consumed the stream and put the result on `request.body`, not `request.raw.body`. |
| F. Fastify, `req.raw.body = req.body` before calling                                                                                             | 200                                                                                                                                                            |
| **G. Fastify, urlencoded POST, no `@fastify/formbody`**                                                                                          | **415 `FST_ERR_CTP_INVALID_MEDIA_TYPE` from Fastify itself.** better-auth never sees it, so form sign-in/sign-up and Apple `form_post` callbacks break.        |
| H. Fastify, encapsulated scope with `removeAllContentTypeParsers()` + `addContentTypeParser("*", (req, payload, done) => done(null, undefined))` | 200 for JSON **and** urlencoded (raw stream intact)                                                                                                            |

For Fastify, `reply.hijack()` is needed before writing to `reply.raw` (cases E–H).

### 5.3 Header edge case: HTTP/2 pseudo-headers (verified)

With HTTP/2 (for example Fastify `http2: true`), Node `req.headers` contains `:authority`, `:method`, etc.:

- `new Request(url, { headers: { ":authority": "x" } })` → **TypeError "Headers.append: ":authority" is an invalid header name."**
- `fromNodeHeaders({ ":authority": "x" })` → **TypeError "Headers.set: … invalid header name"**

Both better-call's `getRequest` and better-auth's `fromNodeHeaders` break under HTTP/2 unless pseudo-headers are stripped first.

`fromNodeHeaders` with array values: `x-multi: ["1","2"]` → `"1, 2"`; `set-cookie` arrays are preserved (`getSetCookie()` returns both).

### 5.4 Response write: `setResponse` (`BC/adapters/node/request.ts:255-339`)

- Headers are copied with `res.setHeader`. `set-cookie` goes through `set-cookie-parser.splitCookiesString` to produce an array. A header error gives a 500.
- It sets `res.statusCode`, then `writeHead`, then streams the body. It handles a locked body, client disconnect cancellation, `drain`, and Lambda environments.
- It writes directly to `ServerResponse`, bypassing any host-framework reply pipeline (interceptors, serializers, filters).

Exported from `better-call/node`: `toNodeHandler`, `getRequest`, `setResponse`. `better-auth/node` re-exports only `toNodeHandler` and `fromNodeHeaders`. Using `getRequest`/`setResponse` means depending on `better-call` directly. better-auth pins `better-call` exactly (`1.4.0`), so a separately declared range can resolve to a different copy with different body semantics (see the 1.3.2 vs 1.4.0 difference above).

---

## 6. Hooks

### 6.1 `options.hooks` (user hooks)

- Type: `hooks?: { before?: AuthMiddleware; after?: AuthMiddleware }`. **One middleware each, not an array** (`CORE/types/init-options.ts:1763-1775`). The docs say: "Each hook (`before` / `after`) takes a single middleware function, not an array. To run logic for different endpoints, branch on `ctx.path` inside that single function." (`DOCS/concepts/hooks.mdx:121-123`).
- Built with `createAuthMiddleware` from `better-auth/api`, which is better-call `createMiddleware.create({ use: [optionsMiddleware, returned/responseHeaders shim] })` (`CORE/api/index.ts:55-77`).
- User hooks get `matcher: () => true` and **run before plugin hooks**, for both `before` and `after` (`BA/api/dispatch.ts:269-307`, esp. `:302-304`).
- Hooks are read from `authContext.options` **on every dispatch** (`dispatch.ts:360`). They are not captured at creation.
  - The reference library exploits this by mutating `auth.options.hooks.before/after` after construction, and requires users to pre-declare `hooks: {}` (`REF/auth-module.ts:131-151`, `:279-292`).
  - This works only because `ctx.options` shallow-copies `options` (`create-context.ts:189-198`), so `ctx.options.hooks` is the same object reference. It would break if the options object were ever deep-cloned. A plugin `init()` returning `options.hooks` would be defu-merged into a new object (`BA/context/helpers.ts:43-55`). Fragile.

### 6.2 `ctx` shape inside a hook (`HookEndpointContext`, `CORE/types/plugin.ts:21-30`; built at `dispatch.ts:338-350`)

- `ctx.path`: **the endpoint's declared route pattern**, for example `"/callback/:id"`, not the concrete URL (`dispatch.ts:348`). Probe 3 logged `path: "/callback/:id"`; plugins match it literally (`BA/plugins/oauth-proxy/index.ts:380`).
- `ctx.body`, `ctx.query`, `ctx.params`, `ctx.method`.
- `ctx.headers`: a `Headers` copy. `ctx.request`: present only for HTTP calls.
- **`ctx._flag === "router"` for HTTP requests; absent for `auth.api.*`** (set at `BC/router.ts:242`, preserved by `...input` spread in `dispatch.ts:338-339`; probe 3). This is how bridge plugins tell "real HTTP response" from "direct server call".
- `ctx.context`: the `AuthContext` (`CORE/types/context.ts:353-508`) plus:
  - `session`: `{session, user} | null`. Null in fresh dispatch (`dispatch.ts:344-346`). Set by getSession, `sessionMiddleware`, api-key.
  - `newSession`: set via `setNewSession` by `setSessionCookie`. So it is also set on a getSession **refresh**, not only on sign-in/up (`BA/cookies/index.ts:355-397`).
  - `returned`: after hooks only. The endpoint result **or the APIError**.
  - `responseHeaders`: after hooks only. Accumulated response headers.
  - `authCookies`, `secret`, `password`, `adapter`, `internalAdapter`, `generateId`, `logger`, `trustedOrigins`, `isTrustedOrigin`, `runInBackground`, `runInBackgroundOrAwait`, `getPlugin`, `hasPlugin`, …
- Utilities (better-call `createInternalContext`, `BC/context.ts:233-352`): `json`, `redirect`, `error`, `setHeader`, `getHeader`, `setCookie`, `setSignedCookie`, `getCookie`, `getSignedCookie`, `setStatus`, `responseHeaders`.

### 6.3 Path matching

- **Plugin** hooks: `hooks.before/after: { matcher(ctx: HookEndpointContext): boolean; handler: AuthMiddleware }[]` (`CORE/types/plugin.ts:89-100`). The matcher is arbitrary code (path, headers, anything).
- A matcher that throws becomes `APIError(500, "An error occurred during hook matcher execution…")` in before-hooks (`dispatch.ts:146-163`). In after-hooks a matcher exception is not caught (`:230`).
- Plugin **middlewares** use rou3 path patterns (`/**`, `/:param`), only as a string, and apply **only to HTTP** (`BC/router.ts:155-158`, `CORE/types/plugin.ts:61-66`). The docs claim "string or a path matcher" (see section 10).

### 6.4 What a hook may return

- **Before hook:**
  - `void`: continue.
  - `{ context: {...} }`: merge into the input context. `headers` merge into request headers; other keys are defu-merged with arrays replaced (`dispatch.ts:196-214`, `:367-384`).
  - **Any other object: short-circuit.** It becomes the response (as a Response for HTTP) along with the response headers accumulated by hooks (`:215-216`, `:385-394`). Used by api-key to emulate a session on `/get-session` (`packages/api-key/src/index.ts:264-269`).
- **After hook:** a return value `!== undefined` replaces `context.returned` and becomes the final response (`dispatch.ts:259-261`). For example `return ctx.json({...})` (JSON because `asResponse` is forced false inside dispatch, `:396`). Headers set via `ctx.setHeader/setCookie` merge; `set-cookie` is appended (`:258`, `:86-100`).

### 6.5 Error semantics (verified in probe 4 where noted)

- **Before hook throws APIError:**
  - HTTP: becomes that error Response (403 in the probe).
  - Cookies set in the hook before throwing are **lost** (probe: `set-cookie: []`, because the router's `toResponse(error)` uses only `error.headers`, `BC/router.ts:282-284`, `to-response.ts:184-190`).
  - `auth.api`: **thrown even with `asResponse: true`**.
- **Endpoint throws APIError:** after-hooks still run, with `returned` = the error (`dispatch.ts:399-433`). Then it is thrown for `auth.api` (with headers attached under the symbol, `:447-459`) or turned into an error Response.
- **After hook throws APIError:** it replaces the response (`dispatch.ts:243-251`). A non-APIError propagates (500 over HTTP).

### 6.6 `databaseHooks`

- Models: `user`, `session`, `account`, `verification` (source; the docs list only user/session/account). Operations: `create` / `update` / `delete`, each with `before` / `after` (`CORE/types/init-options.ts:1405-1690`).
- `before(data, ctx: GenericEndpointContext | null)` may return:
  - `false` → abort (the internal op returns `null`)
  - `void`
  - `{ data }` → replace the payload
  - (`BA/db/with-hooks.ts:40-60`)
- Throwing `APIError` aborts and propagates (`DOCS/concepts/database.mdx:949-979`).
- `after(data, ctx)` is queued **after the transaction** (`queueAfterTransactionHook`, `with-hooks.ts:82-90`).
- `ctx` comes from AsyncLocalStorage (`tryGetCurrentAuthEndpointContext`, `with-hooks.ts:40`). It is `null` outside an endpoint, for example when calling `internalAdapter` directly.
- Plugins can contribute DB hooks via `init() → { options: { databaseHooks } }`. Plugin DB hooks run before the user's (`BA/context/helpers.ts:44-49`, `:86-96`).

---

## 7. Plugin contract, and framework-bridge plugins as precedent

### 7.1 `BetterAuthPlugin` (`CORE/types/plugin.ts:39-163`)

| field                           | behavior                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id` (required, literal string) | Used by `getPlugin`/`hasPlugin`, conflict detection, hook source labels                                                                                                                                                                                                                                                                                                                                                                 |
| `version?`                      |                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `init?(ctx)`                    | May return `{ context?: DeepPartial<AuthContext> & Record<string, unknown>, options?: Partial<BetterAuthOptions> }`. `context` is `Object.assign`'d. `options.databaseHooks` and `options.trustedOrigins` are collected specially; the rest is `defu(options, rest)`, so the **user's options win** (`BA/context/helpers.ts:23-98`). New context keys are typed via `InferPluginContext` onto `$context` (`BA/types/plugins.ts:40-55`). |
| `endpoints?`                    | `Record<string, Endpoint>` from `createAuthEndpoint`. Merged over the base endpoints **by key**, so a plugin can replace core endpoints (custom-session replaces `getSession`) (`BA/api/index.ts:178-184`, `:262-267`). `createAuthEndpoint.serverOnly(...)` gives `auth.api`-only (`CORE/api/index.ts:204-215`). `metadata.scope: "rpc"                                                                                                | "server" | "http"` (`BC/endpoint.ts:145-153`). `metadata.noStore` adds no-store headers (`CORE/api/index.ts:30-33`, `:102-111`). |
| `middlewares?`                  | `{ path: string; middleware }[]`, HTTP only (`api/index.ts:198-229`)                                                                                                                                                                                                                                                                                                                                                                    |
| `onRequest?(req, ctx)`          | Returns `{response}`, `{request}` or void. Runs after rate-limit, before routing (`api/index.ts:315-332`)                                                                                                                                                                                                                                                                                                                               |
| `onResponse?(res, ctx)`         | Returns `{response}` or void (`api/index.ts:336-354`)                                                                                                                                                                                                                                                                                                                                                                                   |
| `hooks?`                        | `{ before?: {matcher, handler}[]; after?: {matcher, handler}[] }`                                                                                                                                                                                                                                                                                                                                                                       |
| `schema?`, `migrations?`        | DB schema contributions                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `options?`                      | The plugin's own options (typed via `BetterAuthPluginRegistry` augmentation, `CORE/types/context.ts:57-86`)                                                                                                                                                                                                                                                                                                                             |
| `$Infer?`                       | Merged into `auth.$Infer` (`BA/types/models.ts:20-25`)                                                                                                                                                                                                                                                                                                                                                                                  |
| `$ERROR_CODES?`                 | `Record<string, RawError>`, usually `defineErrorCodes({...})`. Merged into `auth.$ERROR_CODES`                                                                                                                                                                                                                                                                                                                                          |
| `rateLimit?`                    | `{ window, max, pathMatcher }[]`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `adapter?`                      | Override DB operations                                                                                                                                                                                                                                                                                                                                                                                                                  |

### 7.2 Framework-bridge plugins in better-auth (key precedent)

All live in `BA/integrations/` and are exported as subpaths `better-auth/next-js`, `/svelte-kit`, `/tanstack-start`, `/tanstack-start/solid`:

| Plugin                                 | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Citation                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `nextCookies()`                        | **after** hook `matcher: () => true`: if `ctx._flag !== "router"` (direct `auth.api` call), read `ctx.context.responseHeaders.get("set-cookie")`, parse with `parseSetCookieHeader`, write each via `next/headers` `cookies().set(name, value, toCookieOptions(attrs))`. **before** hook on `/get-session`: in RSC (`RSC: 1` without `next-action`) where cookies cannot be written, `setShouldSkipSessionRefresh(true)` to avoid DB/cookie mismatch. Lazily `import("next/headers.js")` and swallow "outside request scope". | `next-js.ts:47-144`                 |
| `sveltekitCookies(getRequestEvent)`    | Same after-hook pattern. The framework's request-scoped accessor (`getRequestEvent`, ALS-backed) is **injected as a plugin argument**. Writes via `event.cookies.set`.                                                                                                                                                                                                                                                                                                                                                        | `svelte-kit.ts:58-104`              |
| `tanstackStartCookies()` (+ `/solid`)  | Same pattern. Dynamic `import("@tanstack/react-start/server")` → `setCookie`.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tanstack-start.ts:24-67`           |
| `warnIfCookiePluginNotLast(ctx, id)`   | Warns if any plugin **after** the bridge declares `hooks.after`, since those cookies would be missed. The bridge must be last in `plugins`.                                                                                                                                                                                                                                                                                                                                                                                   | `cookie-plugin-guard.ts:10-32`      |
| `expo()` (package `@better-auth/expo`) | `init` adds `exp://` trusted origin in dev. `onRequest` copies `expo-origin` into `origin` (mutating in place, falling back to a new Request on immutable headers). After-hook on callback paths rewrites a non-http `Location` to carry cookies in a query param. Adds its own endpoint.                                                                                                                                                                                                                                     | `packages/expo/src/index.ts:22-112` |

HTTP-mount helpers are **plain functions, not plugins**. They route requests to `auth.handler`: `toNextJsHandler` (`next-js.ts:8-25`), `toSvelteKitHandler`/`svelteKitHandler`/`isAuthPath` (`svelte-kit.ts:8-56`), `toSolidStartHandler` (`solid-start.ts:1-20`), `toNodeHandler` (`node.ts:5-13`).

The pattern is **two-part**:

1. A thin HTTP mount function, where the router response carries cookies natively.
2. A plugin that forwards cookies for **direct server-side `auth.api.*` calls** by reading `ctx.context.responseHeaders` in an after-hook gated on `_flag !== "router"`, and that suppresses session refresh where cookies cannot be written.

Other plugins that adapt **credential transports** into the same `getSession` pipeline:

- `bearer()`: a before-hook turns `Authorization: Bearer` into the session cookie on the request headers. An after-hook exposes a `set-auth-token` response header whenever the session cookie is set (`BA/plugins/bearer/index.ts:42-162`).
- `apiKey({ enableSessionForAPIKeys })`: a before-hook emulates a session from `x-api-key` and short-circuits `/get-session` (`packages/api-key/src/index.ts:165-270`).
- `customSession(fn)`: replaces the `getSession` endpoint and `$Infer.Session` (`BA/plugins/custom-session/index.ts:40-137`).

---

## 8. Package exports and module format

### 8.1 Subpath exports (`scratchpad/better-auth/packages/better-auth/package.json:43-314`)

`.`, `./minimal`, `./social-providers`, `./client`, `./client/plugins`, `./types`, `./crypto`, `./cookies`, `./cookies/utils`, `./oauth2`, `./react`, `./solid`, `./lynx`, `./test`, `./api`, `./db`, `./vue`, `./plugins`, `./svelte-kit`, `./solid-start`, `./svelte`, `./next-js`, `./tanstack-start`, `./tanstack-start/solid`, `./node`, `./db/adapter`, `./db/adapter/minimal`, `./db/migration`, `./adapters/prisma`, `./adapters/drizzle`, `./adapters/mongodb`, `./adapters/memory`, `./adapters`, `./plugins/access`, `./plugins/admin`, `./plugins/admin/access`, `./plugins/anonymous`, `./plugins/bearer`, `./plugins/custom-session`, `./plugins/email-otp`, `./plugins/generic-oauth`, `./plugins/jwt`, `./plugins/haveibeenpwned`, `./plugins/magic-link`, `./plugins/multi-session`, `./plugins/oauth-proxy`, `./plugins/organization`, `./plugins/organization/access`, `./plugins/one-time-token`, `./plugins/phone-number`, `./plugins/two-factor`, `./plugins/username`, `./plugins/siwe`, `./plugins/device-authorization` (54 entries).

Server-relevant ones for a Nest integration:

- `better-auth` (betterAuth, types, APIError, errors, env)
- `better-auth/api` (createAuthMiddleware, createAuthEndpoint, APIError, isAPIError, getSessionFromCtx, sessionMiddleware, getIP, dispatchAuthEndpoint, set/getShouldSkipSessionRefresh, originCheck, formCsrfMiddleware, all routes; `BA/api/index.ts:409-427`)
- `better-auth/node`
- `better-auth/cookies` (getSessionCookie, getCookieCache, parseSetCookieHeader, splitSetCookieHeader, toCookieOptions, applySetCookies, …)
- `better-auth/types`, `better-auth/plugins`, `better-auth/minimal`, `better-auth/test`

`@better-auth/core` subpaths include `./api`, `./context` (request state / endpoint context ALS), `./error`, `./async_hooks` (runtime-conditional), `./instrumentation`, `./db`, `./utils/*` (`scratchpad/better-auth/packages/core/package.json:40-118`).

### 8.2 ESM-only (not dual)

- `"type": "module"`. `main`, `module` and `types` point to `.mjs`/`.d.mts`. **Every export condition is only `dev-source` / `types` / `default` → `.mjs`**, with no `require` or `import` condition (`package.json:5,37-39,43-313`). The type-lint profile is `attw --profile esm-only` (`:30`). Same for `@better-auth/core` (`core/package.json:5,27`).
- The published tarball is identical: `npm view better-auth@1.7.4 type exports` → `"type": "module"`, `default: ./dist/…mjs`.
- `typesVersions` maps every subpath to `.d.mts` (`package.json:315-474`) for `moduleResolution: node10`.
- No `engines` field (grep found none).
- Dependency `better-call@1.4.0`, by contrast, **is dual** (`import`/`require` conditions, `.cjs` + `.mjs` builds; `tmp-ba-core/better-call-1.4.0/package/package.json` exports).

### 8.3 What works from CJS (verified)

- **Runtime:** on Node v22.22.0, `require()` of **47/54 subpaths succeeds** (`req.cjs` and the all-subpath loop). The 7 failures are all `ERR_MODULE_NOT_FOUND` for optional peers (react, solid-js, @lynx-js/react, vitest, vue, drizzle-orm, mongodb), not `ERR_REQUIRE_ASYNC_MODULE`. So the server graph has no top-level await. `process.features.require_module === true`.
- `require(esm)` is unflagged since **Node 20.19.0** ("it is now no longer behind a flag on v20.x"; "no longer emits a warning unless `--trace-require-module`"; throws `ERR_REQUIRE_ASYNC_MODULE` on TLA; https://nodejs.org/en/blog/release/v20.19.0). The same page says it was already default on v22.x (exact v22 minor **UNVERIFIED** in-session; 22.22.0 verified working).
- NestJS 11's `@nestjs/core` declares `engines.node: ">= 20"` (installed 11.1.17 and `npm view @nestjs/core@12.0.1 engines`). **Node 20.0–20.18 would fail to `require("better-auth")`.**
- **Single instance:** `import * as a from "better-auth/api"` and `createRequire(...)("better-auth/api")` return the **same** `APIError` (`same.mjs`: `true`). better-auth being ESM-only means no dual-package hazard _for better-auth_. By contrast `require("better-call")` returns a **different** `APIError` class from the one better-auth uses internally (`false`).
- **Types (TS 5.9.3):**

| consumer tsconfig                              | result                                                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module: commonjs`, `moduleResolution: node10` | OK (via `typesVersions`)                                                                                                                                                         |
| `module: node16`, `moduleResolution: node16`   | **TS1479** "The current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module…" on every better-auth import |
| `module: nodenext` (a `.cts` file)             | OK. TS ≥5.8 models require(esm) under nodenext. **UNVERIFIED** whether TS 6.x behaves the same (the monorepo catalog uses `typescript: ^6.0.3`, `pnpm-workspace.yaml:73`).       |
| `module: esnext`, `moduleResolution: bundler`  | OK                                                                                                                                                                               |

- Context (outside this topic, via `npm view`): **NestJS 12.0.1 is published and is `"type": "module"`** (`@nestjs/core@12.0.1` and `@nestjs/common@12.0.1`). NestJS 11 CLI default tsconfig module settings: **UNVERIFIED**.

---

## 9. What a NestJS integration is tempted to reimplement but should not

| Temptation                                                              | Use instead                                                                                                                                                                                                          | Why                                                                                                                                                                                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Routing auth endpoints through Nest controllers, or re-declaring routes | `auth.handler` on a catch-all at the true mount path (3.7)                                                                                                                                                           | Only the HTTP path runs origin/CSRF, rate limiting, `disabledPaths`, plugin `onRequest/onResponse`/middlewares, and media-type checks (3.1-3.4).                                                                    |
| Session lookup by reading the cookie and querying the DB                | `auth.api.getSession({ headers, returnHeaders: true })`, forwarding only `set-cookie`                                                                                                                                | bearer, api-key, custom-session, multi-session, cookie cache, secondary storage, sliding refresh and `databaseHooks` all hang off `getSession` (sections 4.3, 7.2).                                                 |
| Hard-coded cookie names or cookie parsing                               | `ctx.authCookies.sessionToken.name` (from `await auth.$context`), `getSessionCookie`, `getCookieCache`, `parseSetCookieHeader`, `splitSetCookieHeader`, `toCookieOptions`, `applySetCookies` (`better-auth/cookies`) | Names vary (`__Secure-` prefix by baseURL/NODE_ENV, `advanced.cookiePrefix`, `advanced.cookies[...]`; `BA/cookies/index.ts:44-117`). Splitting `Set-Cookie` needs Expires-comma handling (`cookie-utils.ts:53-90`). |
| Own origin/trusted-origin matching for Nest CORS                        | `(await auth.$context).trustedOrigins` / `ctx.isTrustedOrigin` / `matchesOriginPattern` semantics (wildcards, custom schemes)                                                                                        | Pattern semantics live in `BA/auth/trusted-origins.ts`, and the list is per-request for function-valued configs (`base.ts:97-104`).                                                                                 |
| Own rate limiter for auth routes                                        | `rateLimit` options / plugin `rateLimit` / `customRules` / `customStorage`                                                                                                                                           | Special sign-in rules and storage are built in (3.4). The adapter's only job is to supply a trustworthy IP (3.5).                                                                                                   |
| Own IP extraction                                                       | `getIP` (`better-auth/api`) + `advanced.ipAddress.{ipAddressHeaders, trustedProxies}`                                                                                                                                | Spoof-resistant chain walking and IPv6 subnetting (`CORE/utils/ip.ts:293-341`).                                                                                                                                     |
| Own role/permission checks                                              | `auth.api.userHasPermission` (admin, `BA/plugins/admin/admin.ts:165`), `auth.api.hasPermission` (organization, `organization.ts:1252`), `createAccessControl` (`better-auth/plugins/access`)                         | Role storage format, multi-role strings and org membership are plugin-owned. The reference library re-parses comma-separated roles itself (`REF/auth-guard.ts:251-270`).                                            |
| Own bearer/JWT/API-key verification                                     | `bearer()`, `jwt()` (`verifyJWT` export, `/jwks`, `auth.api.verifyJWT` server-only; `BA/plugins/jwt/index.ts:20-23,310`), `apiKey()` (`auth.api.verifyApiKey`, `enableSessionForAPIKeys`)                            | They already plug into `getSession` via hooks (7.2).                                                                                                                                                                |
| Own error envelope / status mapping                                     | `APIError` (`status`, `statusCode`, `body {message, code}`), `isAPIError`, `auth.$ERROR_CODES`                                                                                                                       | Error codes are merged per plugin and typed (2.1, 4.2).                                                                                                                                                             |
| Own body parsing for auth routes                                        | better-call `getBody` inside `auth.handler`                                                                                                                                                                          | JSON-only default, per-endpoint media types, 400/415 semantics (3.2). The adapter just preserves bytes and content-type.                                                                                            |
| Own Node↔Web conversion                                                 | `toNodeHandler` (+ `fromNodeHeaders`), noting 5.2-5.3                                                                                                                                                                | Handles Express `baseUrl`/`originalUrl`, streaming, backpressure, pre-parsed bodies.                                                                                                                                |
| Composing multiple hook providers by monkey-patching `options.hooks`    | A better-auth plugin whose `hooks.before/after` arrays hold matcher/handler pairs                                                                                                                                    | Plugins support arrays and matchers natively (7.1). Mutating `options.hooks` depends on shallow-copy reference sharing (6.1).                                                                                       |
| Own request-scoped state for auth                                       | `defineRequestState` / `runWithRequestState` / `setShouldSkipSessionRefresh` (`@better-auth/core/context`, `better-auth/api`)                                                                                        | Globally shared via `Symbol.for("better-auth:global")` (`CORE/context/global.ts:20-53`).                                                                                                                            |
| Own OpenAPI for auth routes                                             | `openAPI()` plugin (`BA/plugins/open-api`)                                                                                                                                                                           |                                                                                                                                                                                                                     |
| Own tracing around auth calls                                           | Built-in OpenTelemetry spans (`@better-auth/core/instrumentation`, spans in `dispatch.ts`, `api/index.ts`)                                                                                                           |                                                                                                                                                                                                                     |
| Own test harness                                                        | `getTestInstance` (`better-auth/test`), `testUtils()` plugin (`DOCS/plugins/test-utils.mdx`)                                                                                                                         |                                                                                                                                                                                                                     |

---

## 10. Docs vs source disagreements (source wins)

1. **Plugin `trustedOrigins` field.** The docs show `trustedOrigins: [...]` directly on a plugin object (`DOCS/concepts/plugins.mdx:421-423`). The `BetterAuthPlugin` type has no such field (`CORE/types/plugin.ts:39-163`). Plugins contribute origins via `init() → { options: { trustedOrigins } }` (`BA/context/helpers.ts:51-53`; expo does exactly this).
2. **Plugin rateLimit key.** Docs: `limit: 10` (`plugins.mdx:400`). Type: `max` (`CORE/types/plugin.ts:148-154`); the limiter reads `matchedRule.max` (`rate-limiter/index.ts:375`).
3. **Middleware `path`.** Docs: "can be either a string or a path matcher" (`plugins.mdx:313`). Type: `path: string`, registered via rou3 `addRoute` (`CORE/types/plugin.ts:61-66`, `BC/router.ts:155-158`).
4. **Default rate-limit window.** Docs: "Window: 60 seconds" (`DOCS/concepts/rate-limit.mdx:8-10`). Code: `window: options.rateLimit?.window || 10` (`create-context.ts:357`).
5. **Body parser ordering.** Docs require mounting before `express.json()` (`express.mdx:20-24`) and disabling Nest's body parser (`nestjs.mdx:30-45`). better-call 1.4.0 source tolerates pre-parsed bodies (5.2; verified cases B/C).
6. **databaseHooks models.** Docs: user, session, account (`database.mdx:874`). Type also includes `verification` (`init-options.ts:1626-1690`).
7. **databaseHooks ctx example.** Docs use `ctx.context.session.userId` (`database.mdx:992-996`). `AuthContext.session` is `{session, user} | null` (`CORE/types/context.ts:398-401`), so it should be `ctx.context.session.session.userId`. **UNVERIFIED** at runtime.
8. **cookieCache default strategy.** JSDoc says `@default "compact"` (`init-options.ts:1102`). Stateless setups are force-defaulted to `"jwe"` (`create-context.ts:108-114`, probe 2).
9. **Fastify guide.** It `JSON.stringify`s every body regardless of content type, only mounts GET/POST, and buffers the body with `response.text()` (`DOCS/integrations/fastify.mdx:41-73`). Urlencoded endpoints (form sign-in, Apple `form_post`) and binary/streamed responses break. Without `@fastify/formbody`, Fastify rejects urlencoded before better-auth sees it (case G).

---

## 11. Implications for the design (not a design)

1. **Mount via `auth.handler`, not controllers.** The HTTP adapter contract is "host request → Web `Request` → `auth.handler` → write `Response` verbatim". It must preserve status, every `Set-Cookie` (`getSetCookie()`), `Location`, arbitrary content types and streaming bodies. Nest interceptors, serializers and exception filters must not touch it.
2. **The mount path comes from better-auth**: `new URL((await auth.$context).baseURL).pathname` for static `baseURL`, `options.basePath || "/api/auth"` for dynamic. Only that prefix is routed to the handler (it 404s everything else and never calls `next()`). CORS preflight (`OPTIONS`) and `HEAD` are the host's job (probe 3: 404).
3. **Body contract per platform** (the platform adapter owns this):
   - Express: works raw or pre-parsed with better-call 1.4.0. Safest is still to hand over an unconsumed stream.
   - Fastify: the default parsers consume the stream and reject urlencoded. The adapter must either register a pass-through content-type parser in an encapsulated scope (case H), or copy `request.body` to `request.raw.body` and register urlencoded parsing (case F + formbody). It also needs `reply.hijack()`.
   - A third-party adapter contract should state "deliver raw bytes + original headers, or a faithful re-serialization matching `Content-Type`".
4. **Header hygiene in the adapter:** strip HTTP/2 pseudo-headers (`:authority` etc.) before building `Headers`/`Request` (5.3). Never rewrite `Origin`, `Referer`, `Sec-Fetch-*`, `Cookie` or `Content-Type`.
5. **Client IP is an explicit adapter responsibility.** better-auth reads IP only from headers (3.5). The adapter needs a documented strategy for when no trusted proxy header exists. For example, a dedicated header populated from the socket plus `advanced.ipAddress.ipAddressHeaders`, overwriting any client-supplied value. Otherwise production rate limiting collapses to one shared bucket (probe 1 warning).
6. **Session resolution for guards and decorators must use `getSession` with `returnHeaders: true`** and forward only `set-cookie` to the host response (4.3). Transports that cannot set cookies (WS, GraphQL subscriptions, RPC) should suppress refresh. Use `setShouldSkipSessionRefresh(true)` inside a request-state scope, which also covers the stateless branch; `query.disableRefresh` alone does not.
7. **Direct `auth.api.*` calls from user services** need cookie forwarding. better-auth's own precedent is a **bridge plugin** (`nextCookies`-style):
   - an after-hook gated on `_flag !== "router"` that writes `ctx.context.responseHeaders` `Set-Cookie`s into the current host response, found via an ALS set by host middleware;
   - it must be **last** in `plugins` (`warnIfCookiePluginNotLast`);
   - users add it to `plugins` themselves, because plugins cannot be injected after `betterAuth()` (2.1).
8. **Nest-discovered hooks** (decorator-based) fit naturally as one better-auth plugin exposing `hooks.before/after` arrays with matchers (section 7). That is extension by addition (OCP), as opposed to mutating `options.hooks` (6.1). Note that `ctx.path` is the route pattern (`/callback/:id`), and user hooks run before plugin hooks.
9. **Typing:**
   - Accept the auth instance through a minimal structural interface (handler, api.getSession, options, $context), or through a generic `TAuth`. **Do not type parameters as bare `Auth`**: specialized instances are not assignable (2.3).
   - Derive `Session` from `TAuth["$Infer"]["Session"]` or `Awaited<ReturnType<TAuth["api"]["getSession"]>>`.
   - Avoid emitting deeply inferred better-auth types in our declarations (`typescript.mdx:36-39`).
10. **Errors:** detect with `isAPIError` (never `instanceof`, 4.2). Map `statusCode` and `body` for non-HTTP transports (GraphQL/WS/RPC). When turning a thrown APIError into a host response, merge headers from `Symbol.for("better-call:api-error-headers")`. `auth.handler` itself can throw (init failure, disallowed dynamic host), so the HTTP adapter needs a catch.
11. **Fail fast at bootstrap:** await `auth.$context` during Nest module init so config errors (default secret in production, bad baseURL) surface at startup rather than on the first request (2.1).
12. **Dual CJS+ESM output:**
    - Our CJS build must `require()` an ESM-only dependency. This works only on Node ≥20.19 (and verified on 22.22), so it effectively forces an `engines` floor above NestJS 11's declared `>= 20`.
    - Consumer typings work under `node10`, `nodenext` and `bundler`, but fail under `node16` (8.3).
    - Import `APIError`/`isAPIError` from `better-auth/api`, not `better-call`, to avoid the separate CJS copy.
    - Our own DI tokens/classes are subject to the dual-package hazard if both builds load. Prefer `Symbol.for`/string tokens (inference; not tested here).
    - NestJS 12 is ESM-only (8.3). Weigh whether a CJS build is still needed for the Nest 12 target.
13. **Tests:** better-auth auto-skips origin/CSRF when `NODE_ENV=test` (and falls back to IP 127.0.0.1 in dev/test). Security e2e tests must set `advanced.disableOriginCheck: false` explicitly, and IP tests must run with a non-test NODE_ENV or explicit headers (3.3, 3.5).

## 12. Pitfalls (short list)

- `getSession` without `returnHeaders` drops refresh and cache cookies (4.3). The reference guard does this (`REF/auth-guard.ts:142-146`).
- Forwarding **all** getSession headers leaks `cache-control: no-store` / `pragma: no-cache` onto app responses.
- Passing `request:` to `auth.api.*` flips the return value to a `Response` (probe 2).
- `returnStatus` is `undefined` on normal success and is not in `getSession`'s typed signature.
- With `asResponse: true`, before-hook APIErrors are still thrown (probe 4).
- Cookies set in a before-hook are lost if the hook then throws (probe 4).
- Custom controllers calling `auth.api.signInEmail` skip origin/CSRF and rate limiting (3.3, 3.4).
- The Fastify default parser consumes the body (400) and rejects urlencoded (415) (cases E, G).
- HTTP/2 pseudo-headers crash both `getRequest` and `fromNodeHeaders` (5.3).
- `auth.options.basePath` is `undefined` by default and wrong when `baseURL` has a path. Use `$context.baseURL` (3.7).
- Plugins cannot be appended to `auth.options.plugins` after `betterAuth()` (2.1).
- Mutating `auth.options.hooks` works only by accident of shallow copy (6.1).
- `$Infer` is `undefined` at runtime. Only use it in type positions.
- `NODE_ENV=test` silently disables origin/CSRF checks.
- The current repo's better-auth 1.5.5 / better-call 1.3.2 has different pre-parsed-body behavior than the 1.7.4 / 1.4.0 target (5.2).
- `toNodeHandler` trusts `x-forwarded-proto` unconditionally when building the URL (5.1). Configure a static `baseURL`.

## 13. Open questions

1. **Minimum Node version** for the CJS build, given `require(esm)` needs ≥20.19 and NestJS 11 allows ≥20. Raise `engines`, or ship ESM-only?
2. **Is NestJS 12 (ESM-only) a required target now?** If so, does the dual CJS+ESM requirement still hold for both Nest majors?
3. **Session-cookie forwarding for direct `auth.api.*` calls in user services.** Ship a `nestCookies()`-style plugin the user must add (and place last), or only handle it inside the library's own guard?
4. **Client IP.** Which strategy is acceptable (socket-address injection header vs requiring `trustedProxies` config)? Should the adapter refuse to start in production without one?
5. **Body handling policy.** Require users to keep Nest's body parser enabled (supported by better-call 1.4.0) or disabled? For Fastify, is registering an encapsulated pass-through parser acceptable?
6. **Minimum better-auth version.** 1.7.x only, or support 1.5/1.6? Body semantics differ below better-call 1.4.0.
7. **Non-HTTP transports.** On WS/GraphQL-subscription/RPC, should session refresh be suppressed by default (`setShouldSkipSessionRefresh`) to avoid DB/cookie drift?

## Appendix: probe artifacts

All under `scratchpad/tmp-ba-core/cjs-test/` (better-auth 1.7.4, Node 22.22.0):

| file                            | what it checks                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `probe.mjs`                     | instance shape, getSession cookies, APIError shape, origin 403, 404 outside basePath, 415 |
| `probe2.mjs`                    | cookie-cache Set-Cookie, `request` flips asResponse, stateless defaults                   |
| `probe3.mjs`                    | OPTIONS/HEAD 404, `_flag`/`request`/`path` in hooks                                       |
| `probe4.mjs`                    | hook error propagation                                                                    |
| `probe5.mjs`                    | mount path vs baseURL/basePath                                                            |
| `node-probe.mjs`                | Express/Fastify body matrix                                                               |
| `req.cjs`, `same.mjs`           | CJS require and module identity                                                           |
| `types-probe/`, `types-probe2/` | TS assignability and module-resolution matrix                                             |
