# Research: better-auth framework-integration prior art

Scope: what better-auth's official integrations (docs + source helpers) do, how Fastify is handled, what the NestJS page says, the framework-independent "integration contract" they imply, and which other NestJS integrations exist.

Versions examined:

- better-auth monorepo at v1.7.4 (`packages/better-auth`, `packages/core`, `docs/`), shallow clone at `scratchpad/better-auth`. Paths below are relative to that clone unless prefixed.
- better-call **1.4.0**, the exact pin used by better-auth 1.7.4 (`pnpm-workspace.yaml:69` `better-call: 1.4.0`; published `better-auth@1.7.4` package.json `"better-call": "1.4.0"`). Read from the npm tarball at `scratchpad/tmp-ba-integrations/better-call-1.4.0/package/dist/`. For comparison, better-call 1.3.2 is installed in the current repo.
- fastify 5.12.3, @fastify/cors 11.3.0, @nestjs/platform-fastify 11.2.3, @nestjs/platform-express 11.1.17 (npm tarballs or the repo's node_modules).
- Experiments ran on Node v22.22.0 in `scratchpad/tmp-ba-integrations/cjs-test/` (`experiment.mjs`, `experiment-rawbody.mjs`, `experiment-cors.mjs`). Output is quoted inline.

Abbreviations: `BA` = better-auth, `BC` = better-call, `D/` = `docs/content/docs/`, `S/` = `packages/better-auth/src/`, `BC/` = `scratchpad/tmp-ba-integrations/better-call-1.4.0/package/dist/`.

---

## 0. Most decision-relevant findings (TL;DR)

1. **All official integrations do the same thing.** They send every request under the auth base path to `auth.handler(request: Request): Promise<Response>`, either directly or through `toNodeHandler(auth)` for Node `req/res`. Better Auth does its own routing, method matching, body parsing, origin/CSRF checks, rate limiting, and plugin `onRequest`/`onResponse` inside that handler (`S/api/index.ts:274-407`). No official integration reimplements endpoints. Rate limiting and plugin `onRequest` run only on that router path; server-side `auth.api.*` calls skip rate limiting (`D/concepts/rate-limit.mdx:13`, `S/api/index.ts:310-332`).
2. **Better Auth never emits CORS headers.** A grep for `access-control-allow` across `packages/*/src` (tests excluded) returns nothing. Preflight `OPTIONS` requests to auth paths get **404** from Better Auth (verified by experiment). The host framework must answer preflight and decorate real responses. `trustedOrigins` is Better Auth's _CSRF/origin_ check, not CORS (`S/api/middlewares/origin-check.ts:67-151,221-297`).
3. **The body must reach Better Auth unconsumed and byte-exact.** BC 1.4.0's Node bridge now falls back to re-serializing `req.body` when a host parser already consumed the stream (`BC/adapters/node/request.mjs:102-117`). Verified: JSON and urlencoded both work with Express 5 parsers mounted _before_ the handler. **This contradicts** the docs warning "Mount the Better Auth handler before body-parsing middleware" (`D/integrations/express.mdx:20-24`). But raw-body endpoints are **not** byte-exact after re-serialization (verified, experiment E). The Stripe webhook plugin uses `ctx.request.text()` + signature verification (`packages/stripe/src/routes.ts:2000-2041`), so it breaks unless the raw buffer is handed back.
4. **The official Fastify recipe is lossy.** It builds a Web `Request` from the parsed body with `JSON.stringify` and only mounts GET/POST (`D/integrations/fastify.mdx:41-74`). Verified results:
   - `application/x-www-form-urlencoded` returns **415** from Fastify.
   - With `@fastify/formbody` registered it returns **400** (garbled body).
   - `PATCH` returns **404**.

   Better Auth has real urlencoded endpoints (sign-in/sign-up form posts, OAuth `form_post` callback, SAML ACS, oauth-provider token) and real PUT/PATCH/DELETE endpoints (SCIM, oauth-provider).

5. **On Fastify, how you write the response matters for CORS.** Writing to `reply.raw` (`toNodeHandler(request.raw, reply.raw)` after `reply.hijack()`) **drops headers that Fastify plugins set through `reply.header()`**, such as `@fastify/cors`. Verified: `GET /ok -> ACAO=undefined` while preflight is fine. Handing the Web `Response` to `reply.send(response)` (supported natively in Fastify 5, `fastify/lib/reply.js:617-640`) keeps them (verified `ACAO` present). This explains why the reference library and @nestm/better-auth ship their own Fastify CORS.
6. **Cookie forwarding for server-side calls is an explicit part of the contract.** `getSession` can emit `Set-Cookie` (session refresh updates the DB _and_ re-sets the cookie; cookie-cache refresh) (`S/api/routes/session.ts:367-413`). Verified: a server-side `getSession` emitted `better-auth.session_data`. Official meta-frameworks handle this with "cookie plugins" (`nextCookies`, `sveltekitCookies`, `tanstackStartCookies`) that must be the last plugin. **None of the NestJS libraries examined forward `Set-Cookie` from guard-side `getSession`**: the reference, @nestm, @sapix, roisuladib, buiducnhat and kylegillen all call `getSession({ headers })` without `returnHeaders`.
7. **Better Auth 1.7.4 and @better-auth/core 1.7.4 are ESM-only.** They ship 0 `.cjs` files and no `require` export conditions. The docs still say "CommonJS (cjs) isn't supported" (`D/integrations/express.mdx:12-14`, `D/installation.mdx:395`). But `require("better-auth")`, `require("better-auth/node")` and `require("better-auth/api")` **work from CJS on Node 22.22** through `require(esm)` (verified; `process.features.require_module === true`, no warning).
8. **NestJS 12 is released and is ESM-only.** `@nestjs/core@12.0.1` is `latest` (published 2026-08-27, `"type": "module"`, engines node >= 20), and the official starter is now `"type": "module"`. The newest NestJS integration, **@nestm/better-auth** (Nest 12, ESM-only, Node >= 22.12), is the most technically advanced of the alternatives:
   - no `bodyParser: false`: it recovers the body in three tiers, including byte-exact `rawBody`
   - its own basePath-scoped CORS
   - basePath resolution that mirrors Better Auth's precedence
   - hook dispatchers that work with no `hooks: {}` pre-declaration
9. **Other environment gaps every adapter inherits:**
   - Client IP is read **only from headers** (`x-forwarded-for` by default). With no trusted IP, rate limiting falls back to **one shared bucket per path** (`packages/core/src/utils/ip.ts:354-372`, `S/api/rate-limiter/index.ts:342-356`).
   - `toNodeHandler` trusts `x-forwarded-proto` unconditionally when it builds the URL (`BC/node.mjs:6`).
   - `toNodeHandler` and `fromNodeHeaders` **crash on Node HTTP/2 requests**, which carry pseudo-headers and symbol keys (verified: 500 `TypeError`).

---

## 1. Official integration docs, per framework

### 1.1 Backend frameworks

| Framework                                  | Mount (path / methods)                                                                                                                                                                                                                                                                                                                                                               | Body-parser guidance                                                                                                                                                          | CORS guidance                                                                                                                                                                                                                 | Getting the session                                                                                                                                    | Route protection pattern                                                                                                                                                                                                                                                       | Cookie forwarding from server-side calls                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Express** (`D/integrations/express.mdx`) | `app.all("/api/auth/*", toNodeHandler(auth))` for v4, `"/api/auth/*splat"` for v5 (`:18,34-35`). `installation.mdx` uses `app.all('/api/auth/{*any}', …)` for v5 (`D/installation.mdx:364-375`). All methods.                                                                                                                                                                        | **Warn:** "Mount the Better Auth handler before body-parsing middleware such as `express.json()`" (`:20-24`). The example puts `express.json()` after the handler (`:37-38`). | `cors()` middleware with explicit origin, methods GET/POST/PUT/DELETE, `credentials: true` (`:47-68`). No explicit ordering statement; the example registers it first.                                                        | `auth.api.getSession({ headers: fromNodeHeaders(req.headers) })` (`:70-85`)                                                                            | Not shown (only a `/api/me` handler returning the session)                                                                                                                                                                                                                     | Not covered                                                          |
| **Fastify** (`D/integrations/fastify.mdx`) | Native route `method: ["GET","POST"]`, `url: "/api/auth/*"`. Builds a Web `Request` manually (`:41-74`). Details in section 3.                                                                                                                                                                                                                                                       | Implicit: uses Fastify's _parsed_ `request.body` and `JSON.stringify` (`:56`)                                                                                                 | `@fastify/cors` with explicit origin, methods incl. OPTIONS, allowedHeaders, `credentials: true`, `maxAge`. "Mount authentication handler after CORS registration" (`:96-118`). Plus `trustedOrigins` (`:86-94`).             | `getSession({ headers: fromNodeHeaders(request.headers) })`, returns 401 itself if null (`:122-141`)                                                   | Inline check in the route                                                                                                                                                                                                                                                      | Not covered                                                          |
| **Hono** (`D/integrations/hono.mdx`)       | `app.all("/api/auth/*", (c) => auth.handler(c.req.raw))`. "Better Auth validates the method and returns a Response." "Register the auth route before any catch-all route" (`:34,43`). Route must match `basePath`, e.g. with `new Hono().basePath("/api")` mount `/auth/*` (`:45-55`). Note: `installation.mdx:320` uses `app.on(["POST","GET"], …)` instead, which is inconsistent. | N/A: the Fetch `Request` is passed through untouched                                                                                                                          | Hono `cors()` _before_ the auth route, explicit origin + `credentials: true`, **and** the same origin in `trustedOrigins`. "When credentials is enabled, configure an explicit CORS origin instead of `*`" (`:70-104`)        | `auth.api.getSession({ headers: c.req.raw.headers })` in a middleware that sets `c.set("session", session)`, with a typed `Env.Variables` (`:108-129`) | Route-level middleware + `throw new HTTPException(401)` in the handler (`:133-151`)                                                                                                                                                                                            | Only the client side: Hono RPC `credentials: "include"` (`:155-190`) |
| **Elysia** (`D/integrations/elysia.mdx`)   | `new Elysia().mount(auth.handler)` (`:20`)                                                                                                                                                                                                                                                                                                                                           | N/A                                                                                                                                                                           | `@elysiajs/cors` with origin, methods, credentials, allowedHeaders, registered before `.mount` (`:37-47`)                                                                                                                     | `auth.api.getSession({ headers })` inside a macro `resolve` (`:66-78`)                                                                                 | **Macro** `auth: true`. `resolve` returns `status(401)` or injects `{ user, session }` into the route context (`:54-92`)                                                                                                                                                       | Not covered                                                          |
| **Encore** (`D/integrations/encore.mdx`)   | `api.raw({ expose: true, path: "/api/auth/*path", method: "*" }, toNodeHandler(auth))` (`:32-35`). `api.raw` gives Node req/res (`:38-40`)                                                                                                                                                                                                                                           | N/A (raw endpoint)                                                                                                                                                            | Framework config `global_cors.allow_origins_with_credentials` (`:44-53`) + `trustedOrigins` (`:57-64`)                                                                                                                        | Builds `Headers` from only the `Authorization` and `Cookie` params, then `getSession({ headers })` (`:98-107`)                                         | Encore `authHandler` + `Gateway`. Endpoints opt in with `auth: true`; `getAuthData()` exposes the mapped user (`:80-135`)                                                                                                                                                      | Points at Encore typed cookies (`:138-140`)                          |
| **Nitro** (`D/integrations/nitro.mdx`)     | File route `server/api/auth/[...all].ts` with `export default auth` (`:116-122`). Works because the auth object exposes `fetch: handler` (`S/auth/base.ts:110-113`)                                                                                                                                                                                                                  | N/A                                                                                                                                                                           | Route rule `"/api/auth/**": { cors: { origin: [...], credentials: true } }`. "A wildcard origin (`cors: true`) cannot be combined with credentials. If you only use bearer tokens, `credentials` isn't required" (`:128-149`) | `auth.api.getSession({ headers: event.req.headers })` (`:166-169`)                                                                                     | Reusable `defineHandler` "middleware" that throws `HTTPError.status(401)` and stores `event.context.auth = session`, attached with `defineHandler({ middleware: [requireAuth], handler })`. Comment: "Can be extended to check for specific roles or permissions" (`:153-195`) | Not covered                                                          |
| **NestJS** (`D/integrations/nestjs.mdx`)   | Delegated to the community library `@thallesp/nestjs-better-auth` (see section 4)                                                                                                                                                                                                                                                                                                    | "Disable Body Parser … `bodyParser: false, // Required for Better Auth`" (`:30-45`)                                                                                           | Not mentioned                                                                                                                                                                                                                 | `@Session()` decorator                                                                                                                                 | Global `AuthGuard`; `@AllowAnonymous()`, `@OptionalAuth()` (`:64-93`)                                                                                                                                                                                                          | Not covered                                                          |
| **Convex** (`D/integrations/convex.mdx`)   | Maintained by Convex. `authComponent.registerRoutes(http, createAuth)` on the Convex HTTP router, plus a Next.js proxy handler `export const { GET, POST } = handler` (`:272-293`). Server integration is expressed as a Better Auth **plugin** `convex({ authConfig })` (`:187`)                                                                                                    | N/A                                                                                                                                                                           | N/A                                                                                                                                                                                                                           | Convex helpers                                                                                                                                         | Convex helpers                                                                                                                                                                                                                                                                 | Convex helpers                                                       |

Note on Express: the `*splat` (path-to-regexp v8) form requires at least one segment after `/api/auth/`. `{*any}` also matches the bare prefix. Better Auth itself returns 404 for an empty sub-path anyway (`BC/router.mjs:39`).

### 1.2 Full-stack / meta frameworks

| Framework                                                       | Mount                                                                                                                                                                                                                                                                                                                               | Session retrieval                                                                                                                                  | Protection                                                                                                                                                                                                                                                   | Server-side cookie forwarding                                                                                                                                                        |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Next.js** (`D/integrations/next.mdx`)                         | App router: `export const { GET, POST } = toNextJsHandler(auth)` (`:14-19`). **Note:** `toNextJsHandler` also returns PATCH/PUT/DELETE (`S/integrations/next-js.ts:18-24`), but the docs only destructure GET/POST. Pages router: `toNodeHandler(auth.handler)` + `export const config = { api: { bodyParser: false } }` (`:25-35`) | `auth.api.getSession({ headers: await headers() })` in RSC and server actions (`:58-91`)                                                           | Proxy/middleware (Node runtime) with full `getSession`, or the optimistic `getSessionCookie(request)`: "THIS IS NOT SECURE!… We recommend handling auth checks in each page/route" (`:127-178`, `:315-321`). `getCookieCache` is an alternative (`:334-346`) | "RSCs cannot set cookies" (`:93`). **`nextCookies()` plugin**, "make sure this is the last plugin in the array" (`:95-125`)                                                          |
| **Nuxt** (`D/integrations/nuxt.mdx`)                            | `defineEventHandler((event) => auth.handler(toWebRequest(event)))` at `server/api/auth/[...all].ts` (`:14-20`)                                                                                                                                                                                                                      | `auth.api.getSession({ headers: event.headers })` (`:88-97`)                                                                                       | `createError({ statusCode: 401 })` in server routes; route middleware on pages (`:61-98`)                                                                                                                                                                    | Client-SSR: `useRequestHeaders(["cookie"])` forwarded to a request-scoped client (`:102-142`)                                                                                        |
| **SvelteKit** (`D/integrations/svelte-kit.mdx`)                 | `hooks.server.ts`: `svelteKitHandler({ event, resolve, auth, building })` (`:14-22`)                                                                                                                                                                                                                                                | `getSession({ headers: event.request.headers })`, then populate `event.locals.session/user` yourself ("does not automatically populate", `:24-47`) | Via `event.locals`                                                                                                                                                                                                                                           | **`sveltekitCookies(getRequestEvent)`**, last plugin (`:49-69`)                                                                                                                      |
| **TanStack Start** (`D/integrations/tanstack.mdx`)              | File route `api/auth/$` with GET and POST handlers calling `auth.handler(request)` (`:30-46`)                                                                                                                                                                                                                                       | `getRequestHeaders()` then `auth.api.getSession({ headers })` in `createServerFn` (`:98-120`)                                                      | `beforeLoad` redirect, pathless layout route, `ensureSession` inside server functions (`:92-212`)                                                                                                                                                            | **`tanstackStartCookies()`** (React) or `better-auth/tanstack-start/solid` (Solid), last plugin (`:48-77`)                                                                           |
| **Astro** (`D/integrations/astro.mdx`)                          | `export const ALL: APIRoute = (ctx) => auth.handler(ctx.request)`. Comment: to use rate limiting, set `x-forwarded-for` from `ctx.clientAddress` (`:16-25`)                                                                                                                                                                         | Middleware `getSession({ headers: context.request.headers })` → `context.locals.user/session` (`:99-121`)                                          | Via locals                                                                                                                                                                                                                                                   | n/a                                                                                                                                                                                  |
| **React Router v7 / Remix** (`D/integrations/react-router.mdx`) | Resource route `loader` + `action` both return `auth.handler(request)` (`:51-62`), so every method is covered                                                                                                                                                                                                                       | n/a                                                                                                                                                | n/a                                                                                                                                                                                                                                                          | n/a                                                                                                                                                                                  |
| **SolidStart** (`D/integrations/solid-start.mdx`)               | `export const { GET, POST } = toSolidStartHandler(auth)` (`:14-19`)                                                                                                                                                                                                                                                                 | n/a                                                                                                                                                | n/a                                                                                                                                                                                                                                                          | n/a                                                                                                                                                                                  |
| **Waku** (`D/integrations/waku.mdx`)                            | `GET`/`POST` exports calling `auth.handler(request)` (`:33-43`)                                                                                                                                                                                                                                                                     | `unstable_getHeaders()` → `getSession` (`:72-100`)                                                                                                 | Hono middleware with `getSessionCookie` (optimistic) (`:174-226`)                                                                                                                                                                                            | **User-land `wakuCookies()` plugin**: an after-hook reads `ctx.context.responseHeaders` `set-cookie` into request context data, and a middleware appends it (`:113-157`, `:216-222`) |
| **Expo / Electron / Lynx**                                      | Expo API routes: `export { handler as GET, handler as POST }` (`D/integrations/expo.mdx:24-30`)                                                                                                                                                                                                                                     | Clients send `Cookie` manually (`expo.mdx:426-467`, `electron.mdx:497-508`)                                                                        | —                                                                                                                                                                                                                                                            | Server plugin `expo()` rewrites `origin` from an `expo-origin` header in a plugin `onRequest` (`packages/expo/src/index.ts:24-44`); `disableOriginOverride` option (`expo.mdx:583`)  |

Cross-cutting observation: GET/POST-only mounts appear in Fastify, Next (docs), SolidStart, TanStack, Waku and Expo. All of them silently drop PUT/PATCH/DELETE endpoints (SCIM `PUT/PATCH/DELETE`: `packages/scim/src/user-provisioning.ts:725,886,1060`, `group-provisioning.ts:1150,1323,1535`; oauth-provider `PATCH/DELETE`: `packages/oauth-provider/src/oauthClient/index.ts:490`, `oauthResource/index.ts:73,88`). Framework-agnostic mounts (Express `app.all`, Hono `app.all`, Encore `method: "*"`, Astro `ALL`, RR loader+action) cover them.

---

## 2. Integration helpers in source (what each does)

All helpers live in `S/integrations/` and are exported as `better-auth/node`, `better-auth/next-js`, `better-auth/svelte-kit`, `better-auth/solid-start`, `better-auth/tanstack-start` and `better-auth/tanstack-start/solid` (published `better-auth@1.7.4` package.json exports). There is **no** `better-auth/express` or `better-auth/fastify` helper.

### 2.1 `toNodeHandler` / `fromNodeHeaders` (`better-auth/node`, `S/integrations/node.ts`)

- `toNodeHandler(auth | auth.handler)` delegates to `better-call/node`'s `toNodeHandler(auth.handler)` (`node.ts:5-13`).
- BC 1.4.0 `toNodeHandler(handler)` returns `async (req, res) => setResponse(res, await handler(getRequest({ base, request: req })))`. The base is `${x-forwarded-proto || (socket.encrypted ? "https" : "http")}://${headers[":authority"] || headers.host}` (`BC/node.mjs:3-10`). **`x-forwarded-proto` is trusted unconditionally.**
- `getRequest` (`BC/adapters/node/request.mjs:102-124`):
  - GET and HEAD get no body.
  - Otherwise, **if the raw stream is still readable** (`!destroyed && readableEnded !== true && readable`, `:38-40`), it streams it into a `ReadableStream`. This path honours `content-length` and an optional `bodySizeLimit`, and uses backpressure via pause/resume (`:47-94`).
  - **Else, if `req.body !== undefined`** (a host parser ran), it re-serializes: string as-is, `URLSearchParams.toString()`, form-urlencoded objects via `URLSearchParams`, anything else `JSON.stringify` (`:41-46,109-116`).
  - It builds `new Request(base + constructRelativeUrl(req), { duplex: "half", method, body, headers: req.headers })`. `constructRelativeUrl` rebuilds the full path from Express `baseUrl`/`originalUrl` for sub-routers (`:95-101`).
  - Behaviour change vs **BC 1.3.2**: 1.3.2 preferred `req.body` whenever defined and only did `JSON.stringify`, with no urlencoded awareness (repo node_modules `better-call@1.3.2/.../request.mjs:60-70`). @nestm's README claims the fallback exists from "better-call >=1.3.5, pinned by better-auth >=1.6" (`@nestm dist/index.mjs:845-848`). **UNVERIFIED** at which exact 1.3.x the urlencoded-aware, stream-first logic landed.
- `setResponse` (`request.mjs:125-173`):
  - Copies headers with `res.setHeader`, splitting `set-cookie` via `set-cookie-parser.splitCookiesString` (`:126-127`).
  - Then `writeHead(status)` and **streams** the body with backpressure. There is a Lambda special case (`:162`).
  - Because it uses `res.setHeader` on the raw response, headers set earlier on the raw `res` survive (Express `cors()` sets raw headers). Headers held in a framework object (Fastify `reply.header`) do not. See 3.3.
- `fromNodeHeaders(IncomingHttpHeaders): Headers` appends array values and sets scalars (`node.ts:15-27`).
  - **Verified pitfall:** it throws on HTTP/2 pseudo-headers: `TypeError Headers.set: ":authority" is an invalid header name`.
  - **Verified pitfall:** `toNodeHandler` over Node `http2` (h2c) fails with `TypeError Request constructor: init.headers is a symbol…`, resulting in a 500.

### 2.2 `toNextJsHandler` (`S/integrations/next-js.ts:8-25`)

Wraps `auth.handler` (or a bare handler) into `{ GET, POST, PATCH, PUT, DELETE }`. It is a pure pass-through of the Fetch `Request`.

### 2.3 `nextCookies()` plugin (`next-js.ts:47-144`)

A Better Auth **plugin** (`id: "next-cookies"`):

- **before hook** on `/get-session` (`:54-94`):
  - Warns once if not last (via `cookie-plugin-guard`).
  - Returns early for real HTTP requests (`ctx._flag === "router"`).
  - Otherwise lazily imports `next/headers.js` (cached promise, `:37-45`). If the request is an RSC render (`RSC: 1` without `next-action`), it calls `setShouldSkipSessionRefresh(true)`, so a render that cannot write cookies does not refresh the DB session ("avoid DB/cookie mismatch", `:76-91`).
- **after hook** on every path (`:95-141`):
  - Skips router calls.
  - Reads `ctx.context.responseHeaders.get("set-cookie")`, parses with `parseSetCookieHeader`, and calls Next's `cookies().set(name, value, toCookieOptions(attrs))`.
  - Swallows errors from server components and outside-request-scope calls.

### 2.4 `cookie-plugin-guard.ts` (`:10-32`)

`warnIfCookiePluginNotLast(ctx, pluginId)` logs a warning when any plugin _after_ the cookie plugin declares `hooks.after`. Such hooks "may set cookies that are not forwarded to the framework cookie store."

### 2.5 SvelteKit (`S/integrations/svelte-kit.ts`)

- `toSvelteKitHandler(auth)` is `(event) => auth.handler(event.request)` (`:8-13`).
- `svelteKitHandler({ auth, event, resolve, building })` (`:15-37`):
  - Passes through during `building`.
  - If `isAuthPath(url, auth.options)`, returns `auth.handler(request)`; else `resolve(event)`.
- `isAuthPath` (`:39-56`) compares the request **origin** with `baseURL`'s origin _and_ the pathname prefix `basePath/`.
  - Pitfall: behind proxies or with a different host than `baseURL`, the origin check fails and requests fall through to the app. Path-only matching is more robust for server frameworks.
- `sveltekitCookies(getRequestEvent)` (`:58-104`): the same after-hook pattern as `nextCookies`. It writes through `event.cookies.set(name, value, { ...toCookieOptions, path: attributes.path || "/" })`, swallowing "already streamed" errors.

### 2.6 SolidStart (`S/integrations/solid-start.ts:1-20`)

`toSolidStartHandler` maps `{ GET, POST, PATCH, PUT, DELETE }` to `(event) => auth.handler(event.request)`.

### 2.7 TanStack Start (`S/integrations/tanstack-start.ts:24-67`, `tanstack-start-solid.ts:24-70`)

The same after-hook cookie plugin. It dynamically imports `setCookie` from `@tanstack/react-start/server` or `@tanstack/solid-start/server`. The plugin ids are `tanstack-start-cookies` and `tanstack-start-cookies-solid`.

### 2.8 The core handler these helpers target (`S/auth/base.ts:49-120`)

- `auth.handler(request)`:
  - Awaits the context.
  - Clones it **per request**. This also resolves request-dependent `trustedOrigins`/`trustedProviders` (`:97-104`), and derives `baseURL` from the request when none is configured (`:76-95`).
  - Runs `router(handlerCtx, options).handler(request)` inside `runWithAdapter` (AsyncLocalStorage-based).
- The returned object is `{ handler, fetch: handler, api, options, $context, $ERROR_CODES }` (`:110-120`). Verified at runtime: `Object.keys(auth)` = `handler, fetch, api, options, $context, $ERROR_CODES`.
- Router config (`S/api/index.ts:274-407`):
  - basePath = `new URL(ctx.baseURL).pathname` (`:280`)
  - `originCheckMiddleware` on `/**` (`:288-294`)
  - default `allowedMediaTypes: ["application/json"]`, overridable per endpoint (`:295`)
  - `onRequest`: disabledPaths → 404, schema check, **rate limit**, then plugin `onRequest`, which may return a Response or a replacement Request (`:297-335`)
  - plugin `onResponse` (`:336-354`)
  - `onError` logging (`:355-405`)
- BC router (`BC/router.mjs`):
  - Requires `pathname.startsWith(basePath + "/")`, else 404 (`:32-38`). Empty or `//` paths get 404 (`:39-42`).
  - Method mismatch or unknown route gets **404 (not 405)** (`:43-51`).
  - Trailing-slash strictness unless `advanced.skipTrailingSlashes` (`:44`).
  - Body is parsed by `getBody(request.clone() if cloneRequest, allowedMediaTypes)` unless `disableBody` (`:60-67`).
  - `getBody` enforces the media-type allowlist with **415**, then parses JSON, urlencoded (`formData`), multipart, text, octet-stream or blob (`BC/utils.mjs:4-54`).

### 2.9 Server-side API call options (`D/concepts/api.mdx`, `S/api/to-auth-endpoints.ts`, `S/api/dispatch.ts`)

- `auth.api.X({ body, headers, query })` (`api.mdx:29-53`).
- `returnHeaders: true` returns `{ headers, response }`. Use `headers.getSetCookie()` (`api.mdx:65-87`; `dispatch.ts:391-392,467-468`).
- `asResponse: true` returns a `Response` (`api.mdx:89-103`).
- **Default `asResponse` is true when a Web `Request` is passed as `request`** (`to-auth-endpoints.ts:104`).
- Errors throw `APIError`; check with `isAPIError` (`api.mdx:105-125`).

---

## 3. Fastify specifically

### 3.1 What the official doc does (`D/integrations/fastify.mdx:33-84`)

It **constructs a Web `Request` from the Fastify request**. It does **not** pass `req.raw` to `toNodeHandler`.

- URL: `new URL(request.url, \`http://${request.headers.host}\`)`. The protocol is hard-coded to `http` (`:47`).
- Headers: `fromNodeHeaders(request.headers)` (`:50`). This was a doc fix: better-auth issue #8802 "[Docs] Use fromNodeHeaders(request.headers) in Fastify integration example" (closed).
- Body: `...(request.body ? { body: JSON.stringify(request.body) } : {})` (`:56`). It uses **Fastify's already-parsed body, re-serialized as JSON, while the original `content-type` header is kept**.
- Methods: `["GET", "POST"]` only (`:42`).
- Response: `reply.status(response.status)`, `response.headers.forEach((v,k) => reply.header(k, v))`, then `reply.send(response.body ? await response.text() : null)` (`:63-65`). The body is buffered. Multiple `Set-Cookie` values survive, because `Headers.forEach` yields each `set-cookie` separately in Node 22 (verified) and Fastify's `reply.header('set-cookie', …)` appends to an array (`fastify/lib/reply.js:273-292`).
- A try/catch returns a custom 500 JSON.
- CORS: register `@fastify/cors` first; the handler is a native route, so the plugin's hooks apply (`:96-118`). `trustedOrigins` is explained separately (`:86-94`).
- Prereqs: ESM (`"type":"module"`), Node >= 16 (`:18-21`).

### 3.2 Caveats with Fastify content-type parsers (verified)

Fastify ships only `application/json` and `text/plain` parsers; anything else returns `FST_ERR_CTP_INVALID_MEDIA_TYPE` / 415 (`fastify/lib/content-type-parser.js:37-39,190-202`; `docs/Reference/ContentTypeParser.md:3-9`). Parsers are encapsulated per plugin scope (`:13-15`). For GET/HEAD the payload is never parsed (`:26-31`).

Experiment A (`experiment.mjs`, doc pattern, BA 1.7.4):

```
JSON sign-up         : 200 cookies=2
urlencoded sign-up   : 415 … "FST_ERR_CTP_INVALID_MEDIA_TYPE"
PATCH (any path)     : 404 … "Route PATCH:/api/auth/scim/v2/Users/x not found"
text/plain body      : 415 … (Better Auth rejects the JSON-quoted string: sign-up only allows urlencoded/json)
=== + @fastify/formbody ===
urlencoded sign-up   : 400 … "[body.name] Invalid input: expected string, received undefined; …"
```

Why this matters: Better Auth has first-class **urlencoded** endpoints:

- `sign-up/email` and `sign-in/email` (`cloneRequest: true`, `allowedMediaTypes: ["application/x-www-form-urlencoded","application/json"]`, `S/api/routes/sign-up.ts:30-45`, `sign-in.ts:400-449`)
- the OAuth callback (`GET|POST`, urlencoded for `form_post`, `S/api/routes/callback.ts:42-55`)
- SSO/SAML callbacks (`packages/sso/src/routes/sso.ts:1842-1846`)
- oauth-provider token and related endpoints (`packages/oauth-provider/src/oauth.ts:361,913,1090,…`)
- device authorization (`S/plugins/device-authorization/routes.ts:247-259`)

SCIM uses `application/scim+json` (`packages/scim/src/scim-metadata.ts:4`). Webhook-style endpoints need the raw bytes (Stripe: `disableBody: true`, `ctx.request.text()`, `packages/stripe/src/routes.ts:2000-2041`).

Additional doc-pattern defects:

- The `http://` scheme matters when `baseURL` is unset, because `baseURL` is then derived from `request.url` (`S/auth/base.ts:76-95`, `S/utils/url.ts:180-188`).
- The response is buffered.
- Falsy bodies are dropped.

### 3.3 Working Fastify patterns (verified)

- **B. Raw stream:**
  - In an encapsulated scope, `scope.removeAllContentTypeParsers(); scope.addContentTypeParser("*", (_r,_p,done)=>done(null))`, then `reply.hijack(); await toNodeHandler(auth)(request.raw, reply.raw)`.
  - This is the documented Fastify idiom for piping `request.raw` (`ContentTypeParser.md:204-231,256-266`).
  - Result: JSON 200, urlencoded 200.
  - Nest's FastifyAdapter `use()` is middie-based and runs in `onRequest`, _before_ Fastify content-type parsing. That is why middleware-mounted Better Auth on Nest+Fastify sees an unread stream (`@nestjs/platform-fastify 11.2.3 adapters/fastify-adapter.js:431-438`; parsers are registered as Fastify content-type parsers, `:344-374,445-462`).
- **B2. Web Response via `reply.send(response)`:** Fastify 5 applies `status`, all headers (through `reply.header`, so `set-cookie` is appended) and a streaming `ReadableStream` body (`fastify/lib/reply.js:617-640`; docs `Reply.md` "Response"). Result: JSON 200 with 2 cookies, urlencoded 200, plus a header set by the route through `reply.header` preserved.
- **CORS header survival (experiment F, `experiment-cors.mjs`):**
  ```
  fastify raw-hijack         GET /ok -> 200 ACAO=undefined           | preflight -> 204 ACAO=http://app.local:5173
  fastify send-web-response  GET /ok -> 200 ACAO=http://app.local:5173 | preflight -> 204 ACAO=http://app.local:5173
  express cors()+toNodeHandler      GET /ok -> 200 ACAO=http://app.local:5173 | preflight -> 204 ACAO=…
  ```
  `@fastify/cors` sets headers with `reply.header()` in an `onRequest` hook (`@fastify/cors 11.3.0 index.js:12,225-264`). Those are lost when the response is written to `reply.raw`. This matches the reference README: "On Fastify, Better Auth routes are mounted through middleware, so app-level `@fastify/cors` does not fully cover them by itself" (`ref/README.md:86,726-735`).

---

## 4. `D/integrations/nestjs.mdx`

- The integration is **community maintained**; issues go to `ThallesP/nestjs-better-auth` (`:12-14`). The page recommends **`@thallesp/nestjs-better-auth`** (`:18-22`).
- "Currently the library has **beta support for Fastify**" (`:26-28`). The reference README at v2.8.0 no longer calls it beta and documents Fastify CORS and body-parser specifics (`ref/README.md:84-86,724-735`). **Doc lags the library.**
- Setup:
  1. `NestFactory.create(AppModule, { bodyParser: false, // Required for Better Auth })` (`:30-45`).
  2. `AuthModule.forRoot({ auth })` (`:47-62`).
  3. A global `AuthGuard` by default; `@Session() session: UserSession`, `@AllowAnonymous()`, `@OptionalAuth()` (`:64-93`).
- No CORS, cookie, GraphQL or WS caveats on the page. It links to the repo for "decorators, hooks, global guards, and advanced configuration" (`:95-97`).
- Disagreements with source and prior art:
  - The reference README still says `bodyParser: false` (`ref/README.md:44-47`). It notes that this makes Nest's `rawBody: true` ineffective and offers `bodyParser.rawBody` instead (`:53-56`).
  - @nestm/better-auth claims **no `bodyParser: false` is required** (README `:7,253-265`). Our experiment C supports this for JSON and urlencoded on BC 1.4.0: with Express 5 `json()`+`urlencoded()` _before_ `toNodeHandler`, sign-up JSON and urlencoded both return 200.
  - It is **not** true for raw-body endpoints (experiment E below) unless the exact bytes are restored, which is what @nestm does from `req.rawBody`.
  - Nest's Express adapter registers `express.json()` and `express.urlencoded({ extended: true })` app-wide when `bodyParser` is on, and with `rawBody: true` attaches `req.rawBody` via the `verify` callback (`@nestjs/platform-express 11.1.17 adapters/express-adapter.js:200-212`, `adapters/utils/get-body-parser-options.util.js:4-18`).

Experiment E (`experiment-rawbody.mjs`): a plugin endpoint `{ cloneRequest: true, disableBody: true }` echoes `await ctx.request.text()` for payload `'{ "b": 1,   "a": "x" }\n'`:

```
no-parser                              200 byte-exact: true
express.json-before                    200 byte-exact: false "{\"b\":1,\"a\":\"x\"}"
express.json-before+rawBody-verify     200 byte-exact: true   (req.body = rawBody.toString("utf8"))
```

---

## 5. The framework-independent integration contract

The official integrations collectively imply the following contract. Each clause lists the evidence and the verified edge semantics.

### C1. Mount / routing

- **What:** send _every_ request whose path is under the effective auth base path to `auth.handler(Request) → Promise<Response>` (Fetch shape; `auth.fetch` is an alias). Alternatively use `toNodeHandler(auth)` → `(IncomingMessage, ServerResponse) => Promise<void>` (Node shape). Better Auth owns sub-routing, **method validation** ("Better Auth validates the method", `hono.mdx:43`) and 404s.
- **Effective base path** (source precedence):
  1. A path inside `baseURL` wins and `basePath` is then ignored (`S/utils/url.ts:73-89` `withPath`).
  2. If `baseURL` is unset, a path inside `BETTER_AUTH_URL` (and the other env vars) is used (`url.ts:153-165`).
  3. Otherwise `basePath`, defaulting to `/api/auth` (`S/context/create-context.ts:145-150,188-197`).

  The router uses `new URL(ctx.baseURL).pathname` (`S/api/index.ts:280`). Caveat: `ctx.options.basePath` is still defaulted to `/api/auth` even when `baseURL` carries a different path (`create-context.ts:196`). **Reading `auth.options.basePath` alone can mount at the wrong path.** @nestm's `resolveAuthBasePath` mirrors the precedence correctly (`@nestm dist/index.mjs:1014-1042`). Dynamic `baseURL: { allowedHosts, fallback }` is resolved per request (`S/auth/base.ts:55-62`).

- **Match semantics:** prefix `basePath + "/"`. Better Auth itself 404s on the bare base path and on `//` (`BC/router.mjs:32-42`).
- **Methods:** all of them (GET, POST, PUT, PATCH, DELETE). Better Auth returns 404 on a mismatch (verified: `GET /api/auth/sign-up/email → 404`). OPTIONS/HEAD are not Better Auth routes.
- **Ordering:**
  - Before app catch-alls and 404 handlers (`hono.mdx:43`).
  - After the CORS layer (`hono.mdx:72`, `fastify.mdx:116`).
  - Outside host-level global prefixes or versioning: the reference adds the base path to Nest's global-prefix excludes (`ref/src/auth-module.ts:113-120`); @nestm mounts raw adapter middleware "outside Nest's router" (README `:277-284`).
- **Request construction** (when not using `toNodeHandler`):
  - an absolute URL whose scheme and host reflect the public origin (when `baseURL` is unset, Better Auth derives it from `request.url`; `base.ts:76-95`)
  - Web `Headers`, with no HTTP/2 pseudo-headers
  - a streaming body with `duplex: "half"`
- **Response writing:**
  - Preserve **multiple `Set-Cookie`** (use `headers.getSetCookie()`, `res.append`, or Fastify `reply.header` append semantics).
  - **Merge with, don't clobber**, headers the host already set (CORS).
  - Stream the body.
  - Verified bug class: copying with `res.setHeader(k, v)` in a `headers.forEach` loop keeps only the last cookie (`naive setHeader copy : 200 cookies=1` vs `cookies=2` for `toNodeHandler`).

### C2. Body

- **Rule:** Better Auth must receive the unconsumed, byte-exact body stream. Better Auth parses it itself per endpoint allowlist: JSON by default; urlencoded, multipart, SCIM+json, or raw via `disableBody` on specific endpoints (section 3.2).
- **Doc guidance by framework:**
  - Express: mount before body parsers (`express.mdx:20-24`).
  - Next pages: `bodyParser: false` (`next.mdx:25-35`).
  - Nest: `bodyParser: false` (`nestjs.mdx:30-45`).
  - Fetch-native frameworks: nothing to do.
- **Degraded mode (BC 1.4.0):** re-serialization of `req.body` if the stream was consumed (`BC/adapters/node/request.mjs:102-117`). It is lossless for flat JSON and flat forms. It is **lossy for signature-verified payloads** (Stripe, and any `ctx.request.text()` consumer).
- **Size limits:** the Node bridge supports `bodySizeLimit` in `getRequest`, but `toNodeHandler` never passes it (`BC/node.mjs:5-8`). There is **no body-size limit on the raw path** unless the host enforces one. (Inferred from code; not load-tested.)

### C3. CORS and origin trust

- Better Auth does **no CORS** (grep result, section 0.2). Preflight to auth paths returns 404 (verified in experiments B and C).
- The host must:
  1. answer preflight before Better Auth;
  2. add `Access-Control-Allow-Origin` (explicit origin, not `*`, when using credentials) and `Access-Control-Allow-Credentials` to _actual_ responses;
  3. keep CORS origins consistent with `trustedOrigins` (`hono.mdx:94-104`, `nitro.mdx:147-149`, `fastify.mdx:86-94`, `encore.mdx:55-64`).
- Better Auth's own check is CSRF protection, not CORS:
  - For non-GET/HEAD/OPTIONS requests that carry cookies, it validates `Origin`/`Referer` against trusted origins.
  - For first-login form endpoints without cookies, it uses Fetch-Metadata (`Sec-Fetch-*`), and validates any present Origin (`origin-check.ts:221-297,303-375`).
  - It also validates `callbackURL`/`redirectTo`/`errorCallbackURL`/`newUserCallbackURL` (`:83-150`).
  - Verified side effect: Node's `fetch` sends `sec-fetch-mode: cors`, so a server-to-server `POST /sign-up/email` **without an `Origin` header returns 403 `MISSING_OR_NULL_ORIGIN`** in 1.7.4. E2E tests must send `Origin`.
- **Trusted-origin sources** are the union of:
  - the `baseURL` origin
  - `trustedOrigins` (array or `async (request?) => string[]`; the request is `undefined` for `auth.api` calls and at init)
  - `BETTER_AUTH_TRUSTED_ORIGINS` env
  - dynamic `allowedHosts` and `fallback`

  (`S/context/helpers.ts:108-159`; `D/reference/options.mdx:89-125`)

- Matching is available on the context as `(await auth.$context).isTrustedOrigin(url)`, with wildcard support (`create-context.ts:298-307`). The matcher `matchesOriginPattern` itself is **not exported** (runtime export check). Integrations that derive CORS only from `options.trustedOrigins` arrays (the reference `auth-module.ts:184-205`, @nestm `dist/index.mjs:889-901`) miss the `baseURL` origin, the env origins, dynamic hosts, and function-based origins.

### C4. Session retrieval

- **Universal form:** `auth.api.getSession({ headers: <Web Headers of the incoming request> })` returns `{ session, user } | null`. Used by every doc: `fromNodeHeaders(req.headers)` for Node, `c.req.raw.headers`, `request.headers`, `event.headers`, `await headers()`, `getRequestHeaders()`.
- The endpoint is `GET|POST /get-session` with `requireHeaders: true`. POST requires `deferSessionRefresh` (`S/api/routes/session.ts:29-37,79-84`).
- Cookies _or_ `Authorization: Bearer` (bearer plugin, `D/plugins/bearer.mdx:128-140`) are what matter. Encore forwards only those two headers (`encore.mdx:98-107`).
- Per-call knobs: `query: { disableCookieCache, disableRefresh }` (`session.ts:309,339-344,460-489`).

### C5. Protection

- **Pattern:** a framework-native interception point resolves the session once, stores it in request-scoped state, and rejects when it is absent:
  - Hono: middleware + `c.set`
  - Elysia: macro + `resolve`
  - Nitro: `defineHandler` middleware + `event.context`
  - Astro/SvelteKit: `locals`
  - TanStack: `beforeLoad` / server-fn
  - Encore: `authHandler` + Gateway + `auth: true`
- Handlers read the resolved value; they don't re-query.
- **Authorization beyond authentication is left to the app** (Nitro: "Can be extended to check for specific roles or permissions", `nitro.mdx:161-163`).
- **Optimistic cookie-presence checks (`getSessionCookie`) are explicitly "NOT SECURE"** and only valid for redirects (`next.mdx:166-170,315-321`).

### C6. Cookie forwarding for server-side calls

- When app code calls `auth.api.*` and the endpoint sets cookies (sign-in, sign-out, getSession refresh or cookie-cache), the integration must copy the `Set-Cookie` values onto the outgoing framework response.
- **Official mechanisms:**
  - Per call: `returnHeaders: true` / `asResponse: true` (`api.mdx:59-103`).
  - Globally: a **cookie-integration plugin**. Its after hook reads `ctx.context.responseHeaders` `set-cookie`, skips `_flag === "router"` (real HTTP requests already carry cookies), writes through the framework cookie API, and **must be last** (`next-js.ts`, `svelte-kit.ts`, `tanstack-start*.ts`, `cookie-plugin-guard.ts`).
- **If the transport cannot write cookies**, skip the refresh (`setShouldSkipSessionRefresh(true)`, exported from `better-auth/api`, or `disableRefresh`). Otherwise the DB expiry is extended while the browser cookie keeps its old Max-Age (`next-js.ts:76-91`; `session.ts:367-397`).
- Verified (experiment D): with cookie cache enabled, a server-side `getSession({ headers, returnHeaders: true })` emitted `Set-Cookie: better-auth.session_data=…`.

### C7. Environmental prerequisites (shared by all adapters)

- **AsyncLocalStorage** is required: Cloudflare needs the `nodejs_compat` or `nodejs_als` flag (`hono.mdx:59-68`, `installation.mdx:345-360`). The handler runs through `runWithAdapter` and request state (`base.ts:108`, `to-auth-endpoints.ts:108-112`).
- **Client IP comes from headers only.** It uses `advanced.ipAddress.ipAddressHeaders` (default `x-forwarded-for`) with optional `trustedProxies` chain walking (`packages/core/src/utils/ip.ts:293-372`).
  - Without an IP, rate limiting uses a single shared bucket per path and logs a warning (`S/api/rate-limiter/index.ts:342-356`).
  - Astro's doc tells users to inject `x-forwarded-for` from `ctx.clientAddress` (`astro.mdx:21-22`).
  - There is no `getClientIp` hook yet: better-auth issue #9761 (open) requests `advanced.ipAddress.getClientIp`. 1.7.4 has only `trustedProxies` (`packages/core/src/types/init-options.ts:339`).
- **`baseURL` should be configured.** Otherwise the origin is derived from the incoming request and a warning is logged (`create-context.ts:152-156`).

---

## 6. Other NestJS integrations (besides @thallesp and underfisk)

Discovery commands:

- `npm search --json` for "nestjs better-auth", "better-auth nest", "keywords:better-auth nestjs", "better-auth fastify nestjs" and others
- npm downloads API `/downloads/point/last-month/<pkg>` for the window 2026-08-11 to 2026-09-09
- `gh search repos` for "nestjs better-auth", "nest better-auth", "better-auth nestjs fastify" and "nestjs-better-auth"

Baseline: `@thallesp/nestjs-better-auth` had **335,866** downloads/month and 613 stars. `nestjs-better-auth` (underfisk) had 591 downloads/month and 10 stars.

| Package (repo)                                                                                                                                               | Ver / last publish                                  | DL/mo      | Stars  | Target                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| `nestjs-better-auth-fastify` (roisuladib/nestjs-better-auth-fastify)                                                                                         | 0.0.24 / 2025-10-21                                 | **2,370**  | 2      | Nest 11 + Fastify only, dual CJS/ESM                    |
| `@nestm/better-auth` (nestm-dev/better-auth, BSD-3)                                                                                                          | 0.1.0-alpha.1 / 2026-07-30 (repo pushed 2026-09-09) | 610        | 0      | **Nest 12, ESM-only, Node >= 22.12**, Express + Fastify |
| `@mguay/nestjs-better-auth`                                                                                                                                  | 1.0.4 / 2025-09-06                                  | 472        | –      | fork of thallesp                                        |
| `@buiducnhat/nest-better-auth` (buiducnhat/nest-better-auth)                                                                                                 | 1.1.0 / 2025-08-19                                  | 115        | 18     | Nest 11, "express and fastify"                          |
| `@kylegillen/nestjs-fastify-better-auth`                                                                                                                     | 2.1.4 / 2026-01-04                                  | 111        | 3      | fork of thallesp for Fastify                            |
| `@asibulhasanshanto/nestjs-better-auth`                                                                                                                      | 1.0.15 / 2026-01-24                                 | 111        | –      | fork of thallesp                                        |
| `@sapix/nestjs-better-auth-fastify` (AIEPhoenix/nestjs-better-auth-fastify)                                                                                  | 0.3.0 / 2026-01-14                                  | 95         | **82** | Nest 10/11 + Fastify 4/5                                |
| `@lygos`, `@cms-nestjs-libs/better-auth`, `@pedr0ni`, `@farreltobias`, `@fullstackhouse` (MikroORM fork), `@jacobbrds`, `@maevu`, `imad-…`, `@rickmartensnl` | various                                             | 11–57 each | –      | mostly thallesp forks                                   |

Also seen: kasutu/better-auth-ac (1 star), a multi-tenant RBAC/CASL layer with a Nest package. It is an authorization add-on, not a transport integration.

### 6.1 `@nestm/better-auth` 0.1.0-alpha.1 (most relevant)

Source: `scratchpad/tmp-ba-integrations/libs/nestm-better-auth-0.1.0-alpha.1/package/dist/index.mjs` (one bundled file) and its README.

- **Packaging:** ESM-only (`exports["."].import`, `.mjs`). Peers are `@nestjs/* ^12.0.0-alpha.5` and `better-auth >=1.6.0 <2.0.0`; engines node `>=22.12.0`. Built with an oxc/rolldown-style bundler (the helpers carry the `@oxc-project+runtime` banner, `:169-187`), consistent with tsdown.
- **Mount:**
  - `BetterAuthMountService.mount()` runs in `onModuleInit` and calls `httpAdapter.use((req,res,next) => …)` (`:953-997`).
  - It matches `originalUrl ?? url ?? raw.url` (query stripped) against the base path (`:935-943`), unwraps `req.raw ?? req` and `res.raw ?? res` (`:945-950`), and runs CORS, then `recoverBody`, then `toNodeHandler(auth)`.
  - An optional `middleware(req,res,run)` wrapper covers MikroORM/ALS (`:977-993`). Errors are routed to `next(error)`.
  - It rejects mounting at `/` (`:974`).
  - Rationale in a comment: mounting in `onModuleInit` means consumer `MiddlewareConsumer` middleware still runs for auth routes (`:1065-1072`).
- **Body recovery, three tiers** (`:843-862`):
  1. Stream untouched: nothing to do.
  2. `rawBody` Buffer present (Nest `rawBody: true`): set `nodeReq.body = rawBody.toString("utf8")`. That is byte-exact for UTF-8 and exploits BC's "string as-is" branch.
  3. Otherwise copy the framework-parsed `body` onto the raw request so BC re-serializes it.
- **CORS:**
  - Its own basePath-scoped handler: an exact + `*` wildcard origin matcher, `Vary: Origin`, preflight → 204 (`:864-932`).
  - Defaults to array `trustedOrigins`. It warns and skips for function-based origins (`:889-901`).
  - Rationale: "Nest's `enableCors()` cannot reach raw-mounted responses on Fastify" (README `:267-275`).
- **Base path:** `resolveAuthBasePath` = override → path in `baseURL` (string or `{fallback}`) → `BETTER_AUTH_URL` (only if no `baseURL`) → `basePath` → `/api/auth` (`:1014-1042`). This mirrors Better Auth's precedence (section 5, C1).
- **Guard** (`:195-304`):
  - Supports HTTP, GraphQL (optional `@nestjs/graphql`, loaded with dynamic `import()`), WS (`handshake.headers`) and RPC.
  - `@AllowAnonymous` skips the lookup entirely.
  - Sessions are cached per request via a symbol.
  - Fail-closed rule: class-level public markers are ignored if the handler declares authz (`:209-220`).
  - Built-in `@Roles`, `@OrgRoles`, `@RequireActiveOrg`, `@UserHasPermission`, `@MemberHasPermission` call plugin endpoints (`:250-303`). These are **hard-coded in the single guard**, not pluggable strategies.
  - Throws Nest exceptions, `WsException`, or `Error` depending on the context (`:163-167`).
  - **No `Set-Cookie` forwarding** from `getSession` (`:238`).
- **Hooks** (`:724-841`):
  - It installs a single stable before/after dispatcher pair on `(await auth.$context).options.hooks`, which does **not** require `hooks: {}` in the user's config.
  - It stores registries in a symbol slot on the context, so repeated TestingModules and HMR swap rather than chain.
  - It preserves headers and cookies returned by the user's own hook middleware (`splitMiddlewareResult` / `mergeIntoResponseHeaders`, `:744-764`).
  - Database hooks still require `databaseHooks: {}` in instance mode (`:794-796`).
- **Other:** `forRoot({ auth })` or `forRoot({ options })`, in which case the module calls `betterAuth()` itself and pre-seeds `hooks`/`databaseHooks` (`:325-337`). `ConfigurableModuleBuilder` extras `isGlobal` and `disableGlobalGuard` (`:312-322`). A type registry through module augmentation (README `:230-247`).
- **Documented limitations** (README `:286-298`):
  - Auth routes bypass Nest guards, interceptors and filters.
  - On Fastify, responses are written to the raw socket, so `onResponse` hooks and reply logging don't see them.
  - GraphQL is experimental on Nest 12.
  - One package copy per app.
- **Better:** body handling, base-path correctness, hook installation robustness, fail-closed authz, WS/RPC support.
- **Worse:** Nest 12 only; no cookie forwarding; CORS is not derived from Better Auth's full trusted-origin set; its Fastify raw writes lose Fastify reply headers and hooks; authz is not open for extension.

### 6.2 `nestjs-better-auth-fastify` 0.0.24 (roisuladib), the most-downloaded alternative

Source: `libs/nestjs-better-auth-fastify-0.0.24/package/dist/index.mjs`.

- It is a Fastify-only copy of **the official Fastify doc recipe**:
  - native `fastifyInstance.route({ method: ["GET","POST"], url: \`${basePath}/*\` })` (`:462-475`)
  - `convertToWebApiRequest`: `request.protocol`/`hostname`, headers joined with `, `, and `body: JSON.stringify(request.body)` (`:290-310`)
  - a buffered `response.text()` reply
- CORS:
  - Static origins through Fastify CORS. Dynamic `trustedOrigins` are supported by evaluating the function in a global `preHandler` hook with a synthesized Web Request (`:370-410`).
  - It is _the only_ library here that supports function-based `trustedOrigins` for CORS, but it runs on **every** request, not only auth routes.
- Guard: HTTP/GQL/WS/RPC via `extractRequestFromExecutionContext`; `@Public` skips the lookup; throws Better Auth `APIError` (`:90-130`).
- Dual CJS/ESM (`exports.require` → `.cjs`, `import` → `.mjs`). Peer `better-auth ^1.3.27`.
- **Better:** auth routes are native Fastify routes, so the Fastify hook pipeline and `@fastify/cors` apply.
- **Worse:** inherits every doc-recipe defect from section 3.2 (urlencoded, PUT/PATCH/DELETE, raw body, buffering). `basePath` is taken from `options.basePath` only.

### 6.3 `@sapix/nestjs-better-auth-fastify` 0.3.0 (AIEPhoenix, 82 stars)

Source: `libs/sapix-nestjs-better-auth-fastify-0.3.0/package/dist/`.

- Mount: again a native Fastify route, `method: ['GET','POST']` (`auth.bootstrap.js:161-171`), in `onModuleInit`. `toWebRequest` uses `request.protocol` and `JSON.stringify(request.body)` (string bodies pass through) (`auth.utils.js:~80-95`).
- `writeWebResponseToReply` **re-parses JSON responses** and lets Fastify re-serialize them. It drops `content-length` and buffers binary (`auth.utils.js`).
- **Guard:** a single ~650-line guard (`auth.guard.js`) with built-in `@Roles`, `@Permissions`, `@RequireFreshSession`, `@BanCheck`, `@AdminOnly`, `@DisallowImpersonation`, `@ApiKeyAuth`, `@OrgRequired`, `@OrgRoles`, `@OrgPermission`, plus param decorators `@CurrentOrg`, `@OrgMember`, `@IsImpersonating`, `@ApiKey` (`decorators/*.d.ts`).
  - Rich features, but a **closed-for-extension monolith**: every plugin concern is edited into one guard.
- Hooks: wraps `auth.options.hooks[type]` and requires `hooks: {}` (`auth.bootstrap.js:61-135`). It swallows errors from the user's original hooks but rethrows errors from Nest hooks.
- The `"require"` and `"import"` conditions both point at CJS `dist/index.js`.

### 6.4 `@buiducnhat/nest-better-auth` 1.1.0 (18 stars)

Source: `libs/buiducnhat-nest-better-auth-1.1.0/package/dist/index.mjs`.

- Uses an explicit `routingProvider: "express" | "fastify"` option (a crude platform strategy switch) (`:23788`).
- **Wrong default base path:** `this.auth.options.basePath || "/auth"`, while Better Auth defaults to `/api/auth` (`:23762`).
- Express branch: a global `MiddlewareConsumer` middleware re-runs `express.json()` and `urlencoded` for non-auth paths, then `consumer.apply(toNodeHandler(auth)).forRoutes(\`${basePath}/*path\`)`.
- Fastify branch: buffers the raw stream into a string (`request.on("data")`, `:23795`), builds a Web Request, then `reply.setHeaders(response.headers)` and `end(text)` (`:23806`). There is no error handling.
- **Bundles all of Express and body-parser into dist**: about 24k lines, 142 `node_modules` regions (iconv-lite, express, body-parser, qs, …).
- The guard only supports HTTP and resolves the session even for `@IsPublic` routes.

### 6.5 `@kylegillen/nestjs-fastify-better-auth` 2.1.4

Source: `dist/auth.module.js:62-112`.

- A thallesp fork for Fastify. It applies a Nest middleware (via middie) on `${basePath}/*path`.
- It does its own CORS for array `trustedOrigins` and answers preflight with 204.
- It buffers the body with `body += chunk`, which is string concatenation of Buffers and not safe for multi-byte characters split across chunks.
- It hard-codes the `https://` scheme in the URL (`:99`), and uses `reply.setHeaders(response.headers)` and `end(text)`.
- There is **no try/catch**, so a handler rejection leaves the request hanging. Peers pin `better-auth ~1.4.0` and `fastify ~5.6.0`.

### 6.6 `@cms-nestjs-libs/better-auth` 0.1.2 (counter-example)

- It mounts through a **Nest controller** with a hard-coded `@Controller('api/auth')` (`dist/esm/better-auth.controller.js:149`) and `@All`, so Nest guards, interceptors and prefixes apply and `basePath` is ignored.
- The body is `JSON.stringify(request.body)` (`:59`).
- Headers are copied with `response.setHeader(key, value)` inside `forEach` (`:74`). On Express this **loses all but the last `Set-Cookie`**, the same bug class verified in section 5 C1.
- It **`console.log`s full request headers, cookies included** (`:36,47,63`).
- The "esm" build is actually CommonJS (`dist/esm/index.js` starts with `"use strict"; … exports`).

### 6.7 Forks of thallesp, and why they exist

- `@fullstackhouse/nestjs-better-auth` added a `mikroOrm` option. It applies a middleware that forks the MikroORM `EntityManager` per auth request, solving "Using global EntityManager instance methods for context specific actions is disallowed" (`README.md:352-399`). Root cause: **the auth handler runs outside Nest's request pipeline, so request-scoped contexts (ORM contexts, CLS/ALS) are not established.** Upstream later added a generic `middleware(req,res,next)` wrapper (`ref/README.md:699`), and @nestm has the same option.
- Reference issue ThallesP#147 (open): `require("express")` inside the library (`ref/src/middlewares.ts:9,59-61`) breaks Vite bundling ("Cannot find module 'express'").

---

## 7. Packaging and runtime facts relevant to "dual CJS + ESM" and "Nest 11/12"

- **better-auth 1.7.4 is ESM-only:**
  - `"type": "module"`
  - 0 `.cjs` and 250 `.mjs` files
  - 54 export entries, none with a `require` condition
  - no `./package.json` export, so `require("better-auth/package.json")` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`

  (npm tarball inspection + runtime error)

- **@better-auth/core 1.7.4 is ESM-only** in the same way (0 `.cjs`, 108 `.mjs`). **better-call 1.4.0 is dual** (`.cjs` + `.mjs`, `require` conditions).
- **`require(esm)` works:** a `.cjs` script on Node 22.22.0 that `require`s `better-auth`, `better-auth/node` and `better-auth/api`, creates an instance and serves `/api/auth/ok` returned `ok status 200 {"ok":true}` with no ExperimentalWarning (`cjs-test/test.cjs`). **UNVERIFIED:** the exact minimum Node versions (commonly cited as 20.19 / 22.12) and behaviour on Node 20.x.
- **The docs still say CJS is unsupported** (`express.mdx:12-14`, `installation.mdx:395`). This is the doc-vs-reality disagreement noted in section 0.7.
- **Reference library v2.8.0 is also ESM-only** (`exports["."]` has only `import`/`default` → `.mjs`) and allows Nest `^11.1.6 || ^12.0.0` and better-auth `>=1.5.0 <2.0.0` (`ref/package.json`).
- **NestJS 12 facts** (brief; other research tracks may go deeper):
  - `npm view @nestjs/core dist-tags` shows `latest: 12.0.1` (published 2026-08-27).
  - `@nestjs/core@12.0.1` has `"type": "module"` and `engines.node ">= 20"`.
  - `@nestjs/platform-fastify@12.0.1` is `"type": "module"` and depends on `fastify 5.12.1`, `@fastify/cors 11.3.0` and `@fastify/formbody 9.0.0`.
  - The `nestjs/typescript-starter` package.json is now `"type": "module"`, with `@nestjs/* ^12.0.1` and tsconfig `module/moduleResolution: nodenext`.

---

## 8. Doc vs source disagreements (collected)

1. Express docs say body parsers must come after the handler (`express.mdx:20-24`). BC 1.4.0 recovers consumed bodies; JSON and urlencoded work (verified). Raw-exact payloads still break (verified).
2. The docs say CJS isn't supported. `require(esm)` of better-auth 1.7.4 works on Node 22.22 (verified).
3. `nestjs.mdx` says Fastify support is "beta". The reference README v2.8.0 documents full Fastify handling.
4. `nestjs.mdx` says `bodyParser: false` is "Required". @nestm (and our experiments) show it isn't required, given BC >= 1.4.0 and `rawBody` for webhooks.
5. Hono: `installation.mdx:320` mounts `app.on(["POST","GET"])`, while `hono.mdx:34,43` mounts `app.all` and says Better Auth validates methods.
6. Next: the docs destructure only `{ GET, POST }`, while `toNextJsHandler` returns 5 methods (`next-js.ts:18-24`). SolidStart, TanStack, Waku and Expo docs are also GET/POST only. That breaks the SCIM and oauth-provider PUT/PATCH/DELETE endpoints.
7. Express v5 catch-all: `express.mdx:18` uses `*splat`; `installation.mdx:371` uses `{*any}`.
8. The Fastify doc uses an `http://` scheme and `JSON.stringify` of the parsed body. That is lossy compared with `toNodeHandler`'s stream path (verified in section 3.2).

---

## 9. Implications for the design (listed only, not a design)

1. **The adapter contract should be expressed in Better Auth's own two shapes:** a Fetch shape (`Request → Response`, the canonical one) and a Node bridge (`toNodeHandler`). A platform adapter only has to:
   - (a) register a catch-all for the _effective_ base path, with all methods, ahead of the host's 404 and outside global prefixes;
   - (b) produce a faithful Web `Request` (public origin, headers without pseudo-headers, an unconsumed body stream);
   - (c) write the Web `Response` back while **merging** host headers and **appending** every `Set-Cookie`;
   - (d) surface platform facts Better Auth cannot see: client IP, and trust-proxy-aware protocol and host.

   Better Auth does the rest (routing, 404s, media types, CSRF, rate limit, plugin `onRequest`). Reimplementing endpoints as Nest controllers loses rate limiting, `disabledPaths` and plugin `onRequest`/`onResponse` (`S/api/index.ts:297-354`).

2. **Body strategy is a per-platform concern.** Stream-first is safest: Express via mount order or a skip-parser for the base path; Fastify via an encapsulated `'*'` passthrough parser or middie `onRequest`. Where the stream is gone, restore `rawBody` bytes as a string (@nestm tier 2) and only then fall back to re-serialization. A test must cover a byte-exact echo endpoint (`disableBody` + `ctx.request.text()`), not just JSON sign-in.
3. **CORS belongs to the adapter or platform, not core.** On Fastify, the write path decides whether `@fastify/cors` headers survive: `reply.send(Response)` keeps them, while `reply.raw` loses them (verified). An adapter can either reuse host CORS by writing through the framework reply, or supply its own basePath-scoped CORS.

   If it derives origins, the complete set is: the `baseURL` origin, `trustedOrigins` (array or per-request function), the `BETTER_AUTH_TRUSTED_ORIGINS` env, and dynamic hosts. Matching can go through `(await auth.$context).isTrustedOrigin` so wildcard semantics are identical.

4. **Session resolution belongs to the transport.** HTTP, GraphQL, WS and RPC differ only in (i) where headers come from and (ii) whether the response can carry cookies:
   - Cookie-capable transports should use `returnHeaders: true` and forward `Set-Cookie`.
   - Non-cookie transports (WS, RPC) should pass `disableRefresh` or skip-refresh request state, to avoid the DB/cookie expiry mismatch.

   None of the examined NestJS libraries do this, so it is a gap to close.

5. **Authorization strategies should be pluggable.** The alternatives (@sapix, @nestm) hard-code roles, org, permissions, api-key, ban and fresh-session checks in one guard. Better Auth itself leaves authz to the app (Nitro doc). That is a natural Open-Closed seam: authentication (session resolution) in core, authorization rules registered as strategies.
6. **Provide an "around handler" extension point** (ORM/CLS request contexts). Both the reference and @nestm added `middleware(req,res,run)` after a fork demanded it. It belongs in the adapter or mount contract.
7. **Base-path resolution** must follow Better Auth's precedence (a path in `baseURL` > env URL path > `basePath` > `/api/auth`), or read `new URL((await auth.$context).baseURL).pathname` once the context is resolved. `auth.options.basePath` alone is insufficient.
8. **Dual CJS + ESM:**
   - Better Auth and Nest 12 are ESM-only, so the CJS entry point necessarily depends on `require(esm)` (Node >= 22.12 / 20.19, UNVERIFIED lower bound) for peer loading.
   - Peer imports must be static and top-level-await-free.
   - Avoid `createRequire(import.meta.url)` + `require("express")` for peers (it breaks bundlers: ThallesP#147).
   - Never bundle peers (the buiducnhat anti-pattern).
9. **Protocol, IP and HTTP/2 handling are adapter responsibilities** that `toNodeHandler` gets wrong or can't do:
   - It trusts `x-forwarded-proto` blindly.
   - It never passes the socket IP.
   - It crashes on HTTP/2.

   An adapter that builds its own `Request` can use the platform's trust-proxy-aware `protocol`/`host`/`ip` and filter pseudo-headers. Supplying an IP means writing a header Better Auth reads (e.g., configured `ipAddressHeaders`). That must be done without trusting client-supplied values, which is a security review item.

## 10. Pitfalls (checklist for implementers and reviewers)

- Mounting only GET/POST drops SCIM and oauth-provider PUT/PATCH/DELETE.
- Using the Fastify-doc `JSON.stringify(request.body)` breaks urlencoded (415 or 400), text and raw payloads.
- Copying headers with `res.setHeader(k, v)` in a `Headers.forEach` loop keeps only the last cookie. Use `getSetCookie()` / `append`.
- Writing to Fastify `reply.raw` loses `reply.header()`-set headers (CORS) and bypasses `onSend`/`onResponse` hooks.
- Better Auth answers preflight `OPTIONS` with 404, so CORS must run before it.
- `getSession` in a guard can refresh the DB session and emit `Set-Cookie`. Dropping it causes premature cookie expiry.
- Deriving CORS only from `options.trustedOrigins` arrays misses the `baseURL` origin, env origins, dynamic hosts and function origins.
- Without an IP header, rate limiting falls back to a shared per-path bucket (DoS-ish throttling of all users).
- `auth.options.basePath` can differ from the actual router base path when `baseURL` has a path.
- Node's `fetch` sends `sec-fetch-mode: cors`, so tests that POST to sign-in or sign-up without `Origin` get 403 `MISSING_OR_NULL_ORIGIN`.
- `fromNodeHeaders`/`toNodeHandler` throw on HTTP/2 requests.
- Logging request headers leaks session cookies (@cms-nestjs-libs).
- `svelteKitHandler`-style origin comparison in path matching fails behind proxies. Match on the path only.
- `require("better-auth/package.json")` throws. Version detection must not rely on it.
