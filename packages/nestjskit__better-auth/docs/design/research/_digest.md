# Research digest

One summary per research report in this directory: the decision-relevant findings, design implications, pitfalls, and the questions each report raised for the user.

# ba-core

**Scope.** better-auth 1.7.4 (commit 8d37cc3) and better-call 1.4.0 (pinned exactly; source cloned). Findings were checked with runtime probes on Node 22.22, Express 5.2.1, Fastify 5.12.3 and TypeScript 5.9.3.

**Philosophy.** better-auth describes itself as framework- and runtime-agnostic. Its single integration seam is a Web-standard `handler(Request): Promise<Response>`.

- It extends through plugins, and recommends customizing inside the pipeline with hooks rather than beside it.
- It is type-safe through inference (`$Infer` is type-only).
- It is secure by default and ESM-only; its docs say CommonJS isn't supported.
- Framework cookie bridging ships as plugins: `nextCookies`, `sveltekitCookies`, `tanstackStartCookies` and `expo`. Each uses an after-hook gated on `ctx._flag !== "router"` that writes `ctx.context.responseHeaders` Set-Cookies into the framework's cookie store, and each must be last in `plugins`.

**What `betterAuth()` returns.** At runtime: `handler`, `fetch` (an alias), `api`, `options` (the original object, not normalized), `$context` (a Promise; init errors surface here) and `$ERROR_CODES`. Plugins cannot be added after creation.

**Types.** A plugin-specialized `Auth<Options>` is not assignable to bare `Auth` (TS2322 via `$context.adapter`). A minimal structural contract does compile.

**The handler.** Its pipeline, in order:

1. Per-request context clone.
2. `disabledPaths` check.
3. Rate limit (HTTP only; client IP read from headers only).
4. Plugin `onRequest`.
5. Base-path routing: anything outside the base path returns 404; OPTIONS and HEAD also return 404.
6. Body read: `application/json` only unless the endpoint opts in; otherwise 415.
7. Origin/CSRF check (HTTP only).
8. Hooks, then `toResponse`.

It returns 302 redirects, multiple Set-Cookie headers, HTML or streamed bodies. It can also throw.

**Where it mounts.** The real mount path is `new URL($context.baseURL).pathname`. If `baseURL` contains a path, `basePath` is ignored.

**Server calls (`auth.api.*`).**

- They accept `headers`, `body`, `query`, `request`, `asResponse`, `returnHeaders` and `returnStatus`.
- Passing `request` makes `asResponse` default to true, so you get a Response back.
- They run hooks but skip rate limiting and origin/CSRF checks.
- Errors are `APIError` (`status`, `statusCode`, `body{message,code}`), plus hidden headers under `Symbol.for("better-call:api-error-headers")`. Detect them with `isAPIError`, never `instanceof`.
- **`getSession` emits Set-Cookie on 9 code paths**: sliding refresh, cookie cache, stateless refresh-cache and cookie cleanup. Calling it without `returnHeaders: true` silently drops those cookies, and the reference library's guard does exactly this. When forwarding, forward only `set-cookie`; getSession also returns `cache-control: no-store`.

**Node bridging.** `better-auth/node`'s `toNodeHandler` relies on better-call 1.4.0, which reads the raw stream first and falls back to a pre-parsed `req.body`.

- Express works whether the body parser runs before or after the handler.
- Fastify's default parser consumes the stream, giving a 400, and Fastify itself rejects form-urlencoded with a 415. It works either with a pass-through content-type parser in its own scope, or by copying the parsed body onto `raw.body`.
- HTTP/2 pseudo-headers make both `new Request` and `fromNodeHeaders` throw.
- `toNodeHandler` trusts `x-forwarded-proto` unconditionally and never calls `next()`.

**Hooks.**

- `options.hooks` takes one middleware each (not an array); user hooks run before plugin hooks.
- `ctx.path` is the route pattern (e.g. `/callback/:id`), not the concrete URL.
- A before-hook returning `{context}` changes the input; any other object short-circuits the request.
- An APIError thrown in a before-hook is thrown even when `asResponse` is set, and any cookies the hook set are lost.
- `databaseHooks` cover user, session, account and verification: `before` may return false or `{data}`; `after` runs once the transaction completes.

**Packaging.** better-auth has 54 subpath exports and is ESM-only. From CommonJS, `require()` works on Node ≥20.19 (verified: 47 of 54 subpaths load; the rest need optional peers) and returns the same instance as `import`. better-call ships a dual build, so its `APIError` class differs between the two. For TypeScript consumers, the `node10`, `nodenext` and `bundler` resolution modes work; `node16` fails with TS1479. NestJS 12.0.1 is published and is ESM-only.

**Docs vs source.** The docs disagree with the source on: plugin `trustedOrigins` and the rate-limit `limit` vs `max` field, the rate-limit window (60 s vs 10 s), body-parser ordering, and Fastify guide bugs. The report lists all of them.

## Implications

- Keep all auth semantics in better-auth. The HTTP adapter contract is: host request -> Web Request (original headers and body bytes) -> auth.handler -> write the Response back verbatim. That means status, every Set-Cookie via getSetCookie(), Location, any content type, and streamed bodies. Keep it out of Nest interceptors, serializers and filters.
- Take the mount path from better-auth: new URL((await auth.$context).baseURL).pathname for a static baseURL, otherwise options.basePath || '/api/auth'. Route only that prefix to the handler. The host framework must answer CORS preflight (OPTIONS) and HEAD.
- Each platform adapter must meet a body contract. Express works raw or pre-parsed (better-call >= 1.4.0). Fastify needs either an encapsulated pass-through content-type parser or copying request.body onto raw.body plus urlencoded parsing, and it needs reply.hijack(). Third-party adapters must deliver raw bytes or a faithful re-serialization that matches Content-Type.
- Adapters must strip HTTP/2 pseudo-headers before building Headers or a Request. They must never rewrite Origin, Referer, Sec-Fetch-*, Cookie or Content-Type.
- Supplying a trustworthy client IP is an explicit adapter responsibility. better-auth reads the IP only from headers. The adapter needs a documented strategy, for example a socket-derived header registered in advanced.ipAddress.ipAddressHeaders that overwrites any client-supplied value, or requiring trustedProxies. Without one, production rate limiting collapses to a single shared bucket.
- Guards and decorators should resolve the session through auth.api.getSession({ headers, returnHeaders: true }) and forward only set-cookie. Transports that cannot set cookies (WS, GraphQL subscriptions, RPC) should suppress refresh with setShouldSkipSessionRefresh(true) inside a request-state scope. query.disableRefresh alone misses the stateless refresh-cache branch.
- Cookie forwarding for direct auth.api.* calls made in user services should follow better-auth's own precedent: a user-added bridge plugin (nextCookies-style). It uses an after-hook gated on _flag !== 'router', writes Set-Cookie into the current host response found via AsyncLocalStorage, and must sit last in plugins. Plugins cannot be injected after betterAuth().
- Implement Nest-discovered hooks as a single better-auth plugin exposing hooks.before/after arrays with matchers. That is OCP-friendly, whereas mutating options.hooks is fragile. Matchers must use route patterns (e.g. '/callback/:id'); user hooks run before plugin hooks.
- Keep typing generic over the user's typeof auth, or accept a minimal structural interface. Never type parameters as bare Auth. Derive Session from $Infer.Session or from getSession's return type, since custom-session and plugins change it. Avoid emitting deeply inferred better-auth types in our own declarations.
- Detect errors with isAPIError (never instanceof), map statusCode and body for non-HTTP transports, and merge the Symbol.for('better-call:api-error-headers') headers. The HTTP adapter must catch errors thrown by auth.handler itself (init failure, disallowed dynamic host).
- Await auth.$context during Nest module initialization so configuration errors fail fast at bootstrap.
- Dual CJS+ESM: the CJS build requires an ESM-only dependency, which works only on Node >= 20.19, so the engines field must say so. Consumer TS works under node10/nodenext/bundler but not node16. Import APIError from better-auth/api, not better-call. NestJS 12 is ESM-only, which affects whether a CJS build is still needed.
- better-auth disables origin/CSRF checks automatically under NODE_ENV=test and falls back to IP 127.0.0.1 in dev/test. Security e2e tests must explicitly set advanced.disableOriginCheck: false and control NODE_ENV and the IP headers.

## Pitfalls

- Calling getSession without returnHeaders:true drops refresh and cookie-cache Set-Cookies, so the DB expiry and the browser cookie drift apart. The reference guard does this (ref/src/auth-guard.ts:142-146).
- Forwarding every getSession response header leaks cache-control: no-store and pragma: no-cache onto ordinary app responses.
- Passing request: to auth.api.* returns a Response instead of data. returnStatus is undefined on success and is not in getSession's typed signature.
- With asResponse:true, an APIError thrown in a before-hook is still thrown. Cookies set in a before-hook are lost if the hook throws.
- Custom Nest controllers that call auth.api.signInEmail etc. bypass origin/CSRF checks and rate limiting.
- Fastify's default parser consumes the stream (400 from better-auth) and rejects form-urlencoded (415 from Fastify). This breaks form sign-in and Apple form_post callbacks.
- HTTP/2 pseudo-headers make better-call getRequest and fromNodeHeaders throw a TypeError.
- auth.options.basePath is undefined by default and is ignored when baseURL contains a path. Use $context.baseURL.
- toNodeHandler never calls next(): it returns 404 for non-auth paths and trusts x-forwarded-proto unconditionally. Configure a static baseURL.
- Plugins cannot be appended after betterAuth(). Mutating auth.options.hooks only works because of shallow-copy reference sharing.
- instanceof APIError fails across better-call's CJS and ESM copies. Always use isAPIError.
- NODE_ENV=test silently disables origin/CSRF checks. With no header IP in production, all clients share one rate-limit bucket (sign-in is limited to 3 per 10s).
- The current repo pins better-auth 1.5.5 with better-call 1.3.2, whose pre-parsed body handling differs from the 1.7.4 / 1.4.0 target.
- Docs are wrong in places: plugin trustedOrigins field (it doesn't exist; use init().options), rateLimit 'limit' (it is 'max'), default window 60s (it is 10s), the requirement to mount before body parsers (no longer strictly needed), and the Fastify guide stringifying every body.

## Open questions for user

- What is the minimum Node version for the CJS build? require(esm) needs >= 20.19 but NestJS 11 allows >= 20. Should we raise engines, or reconsider shipping CJS at all?
- Is NestJS 12 (already published, ESM-only) a required target now? Does the dual CJS+ESM requirement still apply to both Nest majors?
- For cookie forwarding from direct auth.api.* calls in user services, should we ship a nestCookies()-style plugin that users add (and place last), or only handle forwarding inside the library's own guard?
- Which client-IP strategy is acceptable: injecting a socket-derived header, or requiring trustedProxies config? Should the module refuse to start in production without one?
- Should users keep Nest's body parser enabled (supported by better-call 1.4.0) or be told to disable it? For Fastify, is registering an encapsulated pass-through content-type parser acceptable?
- What is the minimum supported better-auth version: 1.7.x only, or 1.5/1.6 too? Body semantics differ below better-call 1.4.0.
- On non-HTTP transports (WS, GraphQL subscriptions, RPC), should session refresh be suppressed by default to avoid drift between the DB and the cookie?

# ba-integrations

**Every official integration does the same thing.** It sends every request under the effective base path to `auth.handler(Request) → Response`, or to `toNodeHandler(auth)` for Node req/res. Better Auth does its own routing, method checks (404, not 405), media-type allowlists, origin/CSRF checks, rate limiting and plugin `onRequest`/`onResponse` inside that handler. No official integration reimplements endpoints.

**The implied integration contract:**

- **Mount:** a catch-all, all HTTP methods, placed ahead of the app's 404 handler and outside any global prefix.
- **Body:** Better Auth must receive the raw, unconsumed body.
- **CORS:** handled entirely by the host. Better Auth emits no CORS headers and answers preflight with 404. `trustedOrigins` is its CSRF check, not CORS.
- **Session:** `auth.api.getSession({ headers })`.
- **Protection:** a framework hook resolves the session once, stores it per request, and rejects with 401. Authorization is left to the app.
- **Cookie forwarding:** server-side `auth.api` calls must have their `Set-Cookie` copied to the response. Use `returnHeaders`/`asResponse`, or a cookie plugin placed last. If the transport can't write cookies, skip the session refresh.

**Verified experiments** (better-auth 1.7.4, better-call 1.4.0, Node 22):

1. **Official Fastify recipe:** JSON works. Urlencoded gets 415, 400 with `@fastify/formbody`, and PATCH gets 404. Better Auth has real urlencoded endpoints (sign-in/up forms, OAuth form_post, SAML, oauth-provider) and SCIM/oauth-provider PUT/PATCH/DELETE.
2. **Stream-first Fastify pattern works** (encapsulated `'*'` passthrough parser). Writing to `reply.raw` loses `@fastify/cors` headers on real responses. `reply.send(webResponse)` keeps them.
3. **Express 5 with body parsers before the handler** works for JSON and urlencoded, because better-call 1.4.0 re-serializes `req.body`. This contradicts the Express docs. Raw bytes are not preserved unless `req.rawBody` is restored, so Stripe-style webhooks would break.
4. **Copying headers with `res.setHeader` in a `forEach` loop** keeps only one Set-Cookie.
5. **A server-side `getSession` emits Set-Cookie** (cookie-cache or session refresh).
6. **`require('better-auth')` from CommonJS works** through require(esm), even though Better Auth 1.7.4 and core ship no CJS and the docs say CJS is unsupported.
7. **`toNodeHandler` and `fromNodeHeaders` crash on HTTP/2.**

**nestjs.mdx** recommends @thallesp/nestjs-better-auth. It says `bodyParser: false` is "Required" and calls Fastify support "beta"; both statements lag the library.

**NestJS 12.0.1 is out** (2026-08-27) and is ESM-only.

**Other NestJS libraries:**

- **@nestm/better-auth** (Nest 12, ESM-only, 610 downloads/month) is the strongest alternative: three-tier body recovery (including `rawBody`), correct base-path precedence, and robust hook dispatchers. Weaknesses: no cookie forwarding, CORS derived only from `trustedOrigins` arrays, authorization hard-coded in one guard.
- **roisuladib `nestjs-better-auth-fastify`** (2,370 downloads/month) and **@sapix** (82 stars) copy the lossy Fastify recipe. @sapix also puts every authorization check in one monolithic guard.
- **@buiducnhat, @kylegillen and @cms** each have serious bugs: wrong default base path, a bundled copy of Express, hard-coded `https`, lost cookies, logging of cookies.
- **None of them forward Set-Cookie** from a guard's `getSession`.

## Implications

- Model the adapter contract on better-auth's own two shapes: Fetch (Request->Response, canonical) and the Node bridge (toNodeHandler). A platform adapter only has to mount a catch-all for the effective base path with all methods, build a faithful Web Request, write the Response back (merging host headers and appending every Set-Cookie), and supply platform facts (client IP, trust-proxy-aware protocol and host).
- Never reimplement better-auth endpoints as Nest controllers. Rate limiting, disabledPaths, plugin onRequest/onResponse and the origin check only run inside auth.handler.
- Body handling should be a per-platform strategy, preferring the untouched stream. When the stream is already consumed, restore the exact rawBody bytes as a string before falling back to re-serialization. Tests must include a byte-exact echo endpoint (disableBody + ctx.request.text()) and urlencoded sign-in/up, not just JSON.
- On Fastify, write through reply.send(webResponse) (or copy reply.getHeaders() onto raw) so @fastify/cors and onSend hooks still apply. Alternatively the adapter owns basePath-scoped CORS. Either way, preflight must be answered before better-auth, which returns 404 for OPTIONS.
- If CORS origins are derived from better-auth config, use the full trusted-origin set: baseURL origin, trustedOrigins array or per-request function, BETTER_AUTH_TRUSTED_ORIGINS env, dynamic allowedHosts. Match via (await auth.$context).isTrustedOrigin to keep wildcard semantics identical.
- Resolve the base path with better-auth's precedence (path in baseURL > env URL path > basePath > /api/auth), or read new URL((await auth.$context).baseURL).pathname. auth.options.basePath alone is not enough.
- Session resolution belongs to the transport. HTTP/GraphQL should call getSession with returnHeaders:true and forward Set-Cookie to the response; WS/RPC, which cannot set cookies, should pass disableRefresh or skip-refresh request state to avoid a DB/cookie expiry mismatch.
- Keep authorization (roles, org, permissions, api-key, ban, fresh-session) as pluggable strategies outside core authentication. Existing libraries hard-code these in one guard, which violates Open-Closed.
- Provide an around-handler extension point (for ORM/CLS request context) in the mount contract. Multiple forks and upstream releases needed one.
- Dual CJS+ESM: better-auth and Nest 12 are ESM-only, so the CJS build depends on require(esm). Keep peer imports static and free of top-level await. Don't use createRequire('express') for peers, and never bundle peers.
- If an adapter builds its own Request instead of using toNodeHandler, it can filter HTTP/2 pseudo-headers and symbol keys, use the platform's trust-proxy-aware protocol, host and IP, and avoid blindly trusting x-forwarded-proto.

## Pitfalls

- Mounting only GET/POST (Fastify docs, Next/Solid/TanStack/Waku examples, roisuladib, @sapix) silently drops SCIM and oauth-provider PUT/PATCH/DELETE endpoints.
- JSON.stringify of a framework-parsed body (Fastify docs, roisuladib, @sapix, @cms) breaks urlencoded (415 or 400), text/plain and raw-signature payloads.
- Copying response headers with res.setHeader(k, v) inside Headers.forEach keeps only the last Set-Cookie. Use headers.getSetCookie() plus append.
- Writing to Fastify reply.raw loses headers set via reply.header() (including @fastify/cors ACAO) and bypasses Fastify onSend/onResponse hooks.
- better-auth answers OPTIONS preflight with 404, so CORS middleware must run before it and must also decorate non-preflight responses.
- A guard-side getSession can refresh the DB session and emit Set-Cookie. Dropping those cookies (every NestJS lib examined does) causes the cookie to expire before the DB session.
- Deriving CORS from options.trustedOrigins arrays only misses the baseURL origin, the BETTER_AUTH_TRUSTED_ORIGINS env var, dynamic allowedHosts and function-based origins.
- With no client IP header, rate limiting falls back to a single shared per-path bucket, so all users can be throttled together.
- auth.options.basePath can differ from the router's real base path when baseURL (or BETTER_AUTH_URL) contains a path.
- Node's fetch sends sec-fetch-mode: cors, so e2e POSTs to sign-in/sign-up without an Origin header get 403 MISSING_OR_NULL_ORIGIN in 1.7.4.
- fromNodeHeaders and toNodeHandler crash on Node HTTP/2 requests (pseudo-headers and symbol keys).
- better-call's toNodeHandler never passes bodySizeLimit, so no body-size limit applies on the raw stream path unless the host enforces one (inferred from code).
- require('better-auth/package.json') throws ERR_PACKAGE_PATH_NOT_EXPORTED, so runtime version detection can't rely on it.
- Logging request headers leaks session cookies (@cms-nestjs-libs does this).

## Open questions for user

- NestJS 12.0.1 (ESM-only) has been npm 'latest' since 2026-08-27. Should v1 target Nest 11 and 12 equally, or treat 12 as primary and 11 as a compatibility path?
- Minimum Node version: the CJS entry point depends on require(esm) to load the ESM-only better-auth and Nest 12. Is Node >= 22.12 (or 20.19) acceptable as the floor? Only Node 22.22 was verified.
- Should the library own CORS for auth routes (like the reference and @nestm), or require users to configure host CORS and only guarantee that host CORS headers survive, which on Fastify means writing through reply.send(Response)?
- Should guard-side getSession forward Set-Cookie (session refresh or cookie cache) by default for HTTP and GraphQL? It fixes a real expiry mismatch but changes responses on every protected route.
- Is HTTP/2 (Fastify http2: true) in scope? It rules out relying on better-call's toNodeHandler and fromNodeHeaders as-is.
- Should client IP forwarding for rate limiting be part of the adapter contract, e.g. setting a configured ipAddressHeaders value from the platform's trust-proxy-aware req.ip? It has security implications and needs a decision.

# ref-impl

**What the ref is:** an ESM-only NestJS module (v2.8.0). It mounts better-auth through `httpAdapter.use(toNodeHandler(auth))`, a raw path-less middleware matched on `originalUrl` against `basePath`, on both Express and Fastify. It registers a global `APP_GUARD` that calls `auth.api.getSession` on every request, including `@AllowAnonymous` ones. It wires `@Hook`/`@DatabaseHook` providers by **mutating `auth.options.hooks` and `databaseHooks` after `betterAuth()` has run**.

**Platform handling:**

- Express runs `cors(trustedOrigins)`, then the auth handler, then re-installed `express.json`/`urlencoded` as Nest `*path` middleware. The user must pass `bodyParser: false`.
- On Fastify, Nest's vendored middie runs the handler in `onRequest` on `req.raw`/`reply.raw`. The library replaces Fastify's JSON and urlencoded parsers with a hand-rolled `JSON.parse` (losing proto-poisoning protection) and `qs`.
- Everything branches on `getType() === "fastify"`. There is no adapter contract.

**Hook wiring works only because of better-auth internals:**

- `ctx.options` is a shallow copy of `auth.options` (create-context.ts:189), so nested `hooks`/`databaseHooks` objects stay shared. That is why `hooks: {}` must exist beforehand.
- `getHooks()` reads `options.hooks` on every dispatch (dispatch.ts:269-307).
- The wrapper **drops return values**, both the user's original hook and the Nest method. That breaks before-hook `{context}` rewrites and short-circuits, and database-hook `false`/`{data}` results.
- Matching is by exact path only. Nothing is cleaned up on shutdown.
- `auth.api.*` calls also dispatch hooks, so the guard's own `getSession` fires every path-less hook on every guarded request.

**Guard:**

- A fixed `if` chain over string metadata keys (`PUBLIC`, `ROLES`, and so on) delegates to plugin endpoints through `auth.api as any`. Errors are logged with `console.error` and become 403.
- The error map is closed over `http`/`graphql`/`ws`/`rpc`; RPC gets a plain `Error`.
- `@UserHasPermission({role,userId})` does nothing: better-auth uses the session user whenever headers resolve (admin/routes.ts:1864-1880), and the e2e test only passes because of that.
- `Set-Cookie` headers from session refresh are dropped.
- `APP_GUARD` does not reach WebSocket gateways (Nest builds the WS guard creator without config).

**CORS:**

- Express installs app-wide `cors` with exact-match origins, so wildcard origins fail, and `methods` lacks PATCH.
- Fastify gets hand-rolled, auth-only CORS.
- Function-based `trustedOrigins` throw at startup. better-auth itself sets no CORS headers.

**Packaging:**

- Ships only `dist/index.mjs`; CJS was added and dropped twice.
- esbuild emits no `design:paramtypes`, so every constructor parameter carries an explicit `@Inject`.
- Deep imports reach into Nest internals (`@nestjs/common/utils/shared.utils.js`, `@nestjs/core/middleware/utils.js`).
- CI tests only Nest 12.0.1 with better-auth **1.5.4**. Nest 11 and better-auth 1.7.x are never tested.

**Ecosystem facts that constrain dual CJS+ESM:**

- better-auth 1.7.4 is ESM-only: zero `.cjs` files, no `require` condition.
- Nest 12.0.1 (already released) is ESM-only.
- On Node 22.22, a `.cjs` file can `require()` both through require(esm). I checked this by running it.

**Web/Node bridge:**

- better-call 1.4.0 re-serializes an already-parsed `req.body`, which breaks byte-exact endpoints such as the Stripe webhook's `request.text()`.
- It applies no body-size cap to chunked requests.

## Implications

- Define an explicit HTTP adapter port (mount the handler at basePath before body parsing, re-install or skip parsers, apply CORS, extract headers and URL) with Express and Fastify implementations registered by extension; remove all getType()==='fastify' branches from core.
- Prefer better-auth's Web-standard auth.handler(Request)=>Response as the core primitive and keep toNodeHandler as one Node-adapter detail, so non-Node or other stacks can plug in.
- Do not mutate auth.options after creation. Consider a library-supplied better-auth plugin (user adds it to betterAuth({plugins:[...]})) whose hooks.before/after arrays and init().options.databaseHooks delegate to a late-bound registry filled from Nest DI. This follows better-auth's documented plugin model (matcher-based hooks) and preserves return-value semantics.
- Hook adapters must propagate return values: before-hook {context}/short-circuit, after-hook response replacement, DB-hook false/{data}. Consider matcher functions or wildcard paths instead of exact equality.
- Split authentication (session resolution) from authorization, using a strategy/policy registry keyed by metadata so new rules (@OrgRoles, @TeamRoles, API-key scopes) are added without editing the guard.
- Make transport support pluggable: a per-context request/headers extractor plus an error-mapper registry (http, graphql, ws, rpc/RpcException), resolved via DI, instead of a closed Record<ContextType,...>.
- Resolve the session at most once per request (cache it on the request or execution context) and skip getSession for public routes unless @Session() is used. Budget for extra DB calls from plugin permission endpoints, or evaluate access control locally via role.authorize().
- Forward Set-Cookie from getSession (returnHeaders/asResponse) to the transport response where possible, or document why not.
- Use symbol-keyed (preferably Symbol.for) or namespaced metadata keys to avoid collisions and dual-package hazards across CJS and ESM copies.
- Emit decorator metadata or require explicit @Inject everywhere. tsdown/rolldown will not emit design:paramtypes by default, the same as esbuild.
- Avoid Nest deep imports (normalizePath, mapToExcludeRoute) and global ApplicationConfig mutation. The auth mount is unprefixed by design.
- Dual CJS+ESM output: better-auth 1.7.x and Nest 12 are ESM-only, so the CJS build depends on Node require(esm) (Node >=20.19/22.12). Set engines accordingly, avoid top-level await, avoid import.meta in shared code, and test a real CJS consumer.
- CORS should reuse better-auth semantics (ctx.isTrustedOrigin or the resolved trustedOrigins, including function-based ones and plugin-contributed origins) and be scoped to auth routes consistently across platforms, or be left to the app explicitly.
- Respect platform defaults when re-installing parsers (Fastify secure JSON parser, Nest's rawBody for both json and urlencoded) and enforce a body-size limit on auth routes, which better-call does not.
- Test matrix should cover Nest 11 and 12, Express and Fastify, and better-auth 1.7.x (the ref never tests 1.7 or Nest 11).

## Pitfalls

- The hooks:{}/databaseHooks:{} requirement exists only because the ref relies on better-auth sharing nested option references; a plugin whose init() returns options.hooks would silently disconnect all Nest hooks.
- The wrapped user hooks.before loses its {context} or short-circuit behavior as soon as any @BeforeHook provider exists.
- A path-less @BeforeHook runs on every auth.api.* call, including the guard's getSession on every protected request.
- Hook wrappers accumulate on a shared auth singleton across multiple app instances (tests, HMR); there is no teardown.
- @UserHasPermission role/userId options are silently ignored by better-auth when the request has a session.
- The guard drops Set-Cookie from session refresh; uncaught APIError from getSession becomes a 500 instead of 401.
- Plugin misconfiguration (missing organization or admin plugin) yields 403 via console.error rather than a startup error.
- The global APP_GUARD does not cover WebSocket gateways; @nestjs/platform-ws clients have no headers or handshake and are always anonymous.
- GraphQL requires context to expose req; Mercurius and subscriptions would crash with a TypeError (inferred).
- RPC errors are a plain Error, not RpcException; the guard writes session/user onto the RPC payload.
- Express CORS from trustedOrigins is app-wide, exact-match only (wildcards ignored) and lacks PATCH; Fastify CORS is auth-only. The two platforms behave differently.
- Function-based trustedOrigins throw at startup; plugin-contributed trustedOrigins are ignored for CORS.
- Forgetting bodyParser:false on Express is not detected; better-call re-serializes the body, which breaks raw-body endpoints such as the Stripe webhook.
- On Fastify the lib removes Fastify's secure JSON parser (proto-poisoning protection lost) and defaults urlencoded extended:true, which requires the optional peer qs or form posts fail.
- Express rawBody is attached for JSON only.
- With a global prefix, re-installed parsers cover only /prefix/* and excluded routes; non-controller endpoints outside the prefix may get no body parsing (inferred).
- app.setGlobalPrefix(p, options) in main.ts overwrites the lib's prefix exclusions.
- disableControllers also disables body-parser re-install and CORS, not just 'controllers'.
- createRequire(import.meta.url) for express and qs resolves relative to the library (pnpm strict layout risk) and needs shims in a CJS build.
- esbuild/tsdown do not emit design:paramtypes; missing @Inject silently breaks DI.
- Bare string metadata keys (ROLES, PUBLIC) can collide with app or other-library metadata.
- req.session collides with express-session.
- No body-size cap on auth routes via toNodeHandler for chunked requests (better-call 1.4.0).
- A rejected handler promise under Fastify middie is ignored, so the request may hang (inferred).

## Open questions for user

- Should the new library keep a default global APP_GUARD (secure-by-default, costs a getSession per request) or make guard registration opt-in?
- Is it acceptable to require users to add a library-provided better-auth plugin (e.g. plugins:[nestjs()]) so hooks and DB hooks are wired through better-auth's plugin API instead of mutating auth.options?
- Should CORS be managed by the library at all (auth-routes-only, better-auth semantics) or left entirely to the app's cors/@fastify/cors with documentation?
- What Node floor is acceptable? A CJS build depends on require(esm) because better-auth 1.7.x and Nest 12 are ESM-only (Node >=20.19 or >=22.12).
- Which transports must be first-class at v1 (HTTP, GraphQL Apollo/Mercurius, socket.io vs ws, microservices RPC)?
- Should authorization decorators call better-auth plugin endpoints (extra DB round-trips, hooks fire) or evaluate access-control roles locally from the plugin's ac config?
- Is backward compatibility with @thallesp/nestjs-better-auth decorator names and option shapes (AllowAnonymous, OptionalAuth, Roles, OrgRoles, bodyParser, disableControllers) a goal?

# ref-issues

**Scope:** I read every issue (90: 86 closed, 4 open — #79, #147, #159, #163) and every PR (73: 53 merged, 20 closed unmerged) in ThallesP/nestjs-better-auth. I also went through the REF git history at v2.8.0 and checked root causes against better-auth 1.7.4, better-call 1.0.13–1.4.0, NestJS 11.1.17 and 12.0.1, and @fastify/cors 11.3.0. The underfisk repo has 0 issues, so it only offers contrasts in its source.

**Biggest pain clusters, in order:**

1. **Handler mounting (12 issues).** Users got silent, bodiless 404s. The mount strategy was rewritten 7 times: `/*path` wildcard, `req.url` override, `forRoutes(basePath)`, then a revert because of the global prefix, and finally a global `httpAdapter.use` with a manual prefix match. The triggers were better-call URL changes and better-auth 1.4.6 (#20, #85, #89, #91, #102, #107).
2. **Body parsing (7 issues + #147).** Users are told to set `bodyParser:false`, which breaks tests (#16), rawBody (#88, #101), body limits (#111) and bundlers (#147). On Fastify the library also replaces the app's own content parsers. better-call ≥1.3.5 re-serializes a body that was already parsed, but the Stripe plugin needs the raw `ctx.request.text()`.
3. **Packaging (8 issues).** Optional peers were statically imported (#82, #97, #100). v2.5.0 dropped CJS and shipped Node `<23` in a minor release (#108, #130, #141).
4. **Types (9 issues).** `Auth = any`, plus shadow instances needed with `forRootAsync` (#62, #112, #163).
5. **Fastify and CORS (#52, #53, #107, #128, #69).** better-auth writes to the raw Node response, so `@fastify/cors` headers set via `reply.header` never reach auth routes. On Express, wildcard `trustedOrigins` get no CORS headers because the `cors` package matches origins exactly.
6. **Hooks (#42, #103).** The library mutates `auth.options.hooks` / `databaseHooks` after `betterAuth()` has run, which is why `hooks: {}` must be pre-set.
7. **Guard (#159).** It always calls `getSession()` first, so `@AllowAnonymous` routes return 500 when the DB is down.
8. **Module config (#59, #88, #159).** Options are silently ignored depending on whether they sit in the static part or the `useFactory` return (ConfigurableModuleBuilder extras).

**Upstream facts verified:**

- better-auth 1.7.4 is ESM-only, and so is NestJS 12.0.1 (`type: module`, no CJS).
- `require(esm)` is unflagged only from Node 20.19 / 22.12.
- Global guards do not apply to WebSocket gateways.
- better-auth runs user hooks for server-side `auth.api.*` calls too.
- `getSession` can write to the DB and emit `Set-Cookie`, which the guard throws away.
- REF's tests run against `src` transpiled to CJS, never the shipped `dist`. The lockfile resolves better-auth 1.5.4 (1.3.27 at the time of #115).

**Zero issues filed** for GraphQL subscriptions, Mercurius, RPC/microservices auth or URI versioning. Reading the code suggests all of them are broken or unsupported, but I did not confirm this by running anything.

**Top lessons:**

- Mounting belongs to the adapter, backed by a conformance matrix.
- Solve body parsing at the platform layer.
- Don't own app-wide CORS.
- Ship dual output and smoke-test the packed tarball.
- Test a version matrix and follow semver.
- Extend better-auth only through its public extension points.
- Resolve the session lazily, once per request.
- Keep the instance type flowing through the module.
- Make config hard to misuse and fail fast.
- Make authorization strategies and transports pluggable.

## Implications

- The HTTP platform adapter contract must own mounting of the better-auth handler (prefix matching on the normalized original URL, no path-pattern wildcards, no req.url mutation) and ship with a conformance test suite across Express 5/Fastify 5 × custom basePath × Nest global prefix (include/exclude) × URI versioning × better-auth versions.
- Body handling must guarantee better-auth routes receive the untouched request stream (raw-signature plugin webhooks) while app routes keep Nest-native parsing and rawBody; the only code running before Nest's global parser is the HTTP adapter itself or pre-init instance setup, so the adapter layer is the natural extension point for this.
- Do not configure app-wide CORS by default; any CORS assistance should be scoped to auth routes, derive allowed origins from better-auth's resolved trusted origins (baseURL, array/function option, env, plugins, wildcards), and on Fastify must not rely on reply-level plugins because better-auth writes to the raw response.
- Dual CJS+ESM output from one source with exports conditions (import/require/types), no top-level await, optional peers (GraphQL, WebSockets, platform packages) loaded only through adapter/transport extension packages or lazy import, and no createRequire of bundler-hostile dynamic strings; CJS consumers on Nest 12/better-auth depend on require(esm), so engines must state Node >=20.19 || >=22.12 without upper bounds.
- CI must test the packed tarball from CJS, ESM and a bundler consumer, plus a matrix of better-auth minimum and latest (1.7.x now), NestJS 11 and 12, and supported Node versions; lockfile-only testing hid #115.
- Integrate with better-auth only via public APIs and at construction time (e.g. a better-auth plugin that late-binds to Nest DI providers) instead of mutating auth.options after betterAuth(); remember hooks also run for server-side auth.api calls.
- Session resolution should be lazy and memoized per request, reusable by guards, param decorators and transports, and skippable for fully public routes; infrastructure failures should map to 5xx, not 401; any Set-Cookie produced by server-side getSession must be forwarded or refresh disabled deliberately.
- Carry the auth instance type through the module generically (no Auth = any) so session/user types, AuthService api and guard-established invariants (e.g. active organization) are inferred; support the factory+ReturnType pattern for async configuration and keep a static auth.ts path for the better-auth CLI.
- Separate static module-shape options (global guard, transports, adapter) from runtime options (instance, parser/CORS knobs) with types that make misplacement a compile error, validate the instance at bootstrap, and export DI tokens (Symbol.for or stable string tokens) so users can compose custom guards.
- Authorization strategies (roles, org roles, permissions, active org) and transports (HTTP, GraphQL incl. subscriptions, WS connection-level, RPC) should be extension units registered with a core registry, fail fast at boot if the required better-auth plugin is missing, and never merge role sources implicitly.
- Plan for multiple named auth instances (tokens/decorators scoped per instance) and optionally a resolver-based dynamic instance (#51, #79); global string metadata keys like 'PUBLIC'/'ROLES' prevent this.
- Provide diagnostics: log the resolved auth mount path/prefix at startup, return informative errors for misconfiguration instead of bodiless 404s, since ~20% of issues were misconfiguration indistinguishable from bugs.

## Pitfalls

- Relying on better-call's node adapter URL reconstruction (req.baseUrl/req.url/req.originalUrl) — it changed in 1.0.15, 1.3.2 and 1.3.5 and broke REF each time (#20, #85, #89).
- Using Express/path-to-regexp wildcard syntaxes ('/_path', '_', '/*splat') or MiddlewareConsumer.forRoutes(basePath) for mounting — semantics differ between Express 4, Express 5, Nest 11 path-to-regexp v8 and Fastify/middie (#48, #91, #102, #107).
- MiddlewareConsumer-based mounting makes the auth path subject to the Nest global prefix ('/api/api/auth', PR #80 revert); excluding it requires internal Nest APIs (@nestjs/core/middleware/utils.js mapToExcludeRoute) that Nest 12 labels non-public.
- Asking users to set bodyParser:false silently disables Nest rawBody, parser limits and breaks tests created with Test.createTestingModule (#16, #88, #101, #111, #112).
- Replacing Fastify's global content-type parsers from a library (REF fastify-body-parser.ts) and requiring optional qs.
- Calling httpAdapter.enableCors from the library: Fastify throws on double registration (#52); Express applies app-wide policy with a restricted methods list and exact-match origins (#69, #95).
- Writing better-auth responses to the raw Node response on Fastify bypasses reply headers/hooks, so @fastify/cors and similar plugins do not apply (#128).
- Statically importing optional peers or loading them via createRequire(import.meta.url)('express') breaks non-users and bundlers (#82, #97, #100, #132, #147).
- Going ESM-only or adding Node engine upper bounds in a minor release (v2.5.0, #130, #141).
- Testing only transpiled source and a lockfile-pinned better-auth instead of the published artifact and the declared peer range (#115).
- Mutating auth.options.hooks/databaseHooks after construction; replacing the object (shallow copy) silently disables hooks (#42) and better-auth's internal formats change ({source, hooks} in 1.5.6, PR #138).
- Guard that resolves the session before checking public metadata: DB outage → 500 on health probes (#159); @Session() returns undefined when the guard did not run (#12).
- Discarding Set-Cookie headers from server-side getSession (session refresh/cookie cache) — latent, not reported.
- ConfigurableModuleBuilder extras vs factory options: placing flags in the wrong object is silently ignored (#59, #88, #159).
- Exporting a Symbol that looks like the DI token but is not (AUTH_MODULE_OPTIONS_KEY vs MODULE_OPTIONS_TOKEN).
- Combining role sources (user.role OR org role) enables privilege escalation (PR #94 review).
- Swallowing plugin/API errors in authorization checks into 403 hides misconfiguration.
- Assuming APP_GUARD protects WebSocket gateways — Nest does not apply global guards there (PR #54); per-message getSession costs a DB hit.
- Writing req.session/req.user may clobber express-session/Passport (latent, unverified).
- A 'disableControllers' flag that actually disables all HTTP wiring (including parser re-adding) is misleading and can leave apps without body parsing.

## Open questions for user

- Should the new library manage CORS at all (and if so only for auth routes), or leave CORS entirely to the host app as better-auth's own docs do?
- Should the global AuthGuard be enabled by default (secure-by-default, as REF v2 does) or opt-in?
- For CJS consumers, is it acceptable to require Node >=20.19 / >=22.12 (require(esm)) given better-auth and NestJS 12 are ESM-only?
- Which better-auth range must be supported: 1.7.x only, or back to 1.5/1.6 (each better-call change has broken mounting before)?
- Should auth routes honor the Nest global prefix/versioning (Nest-consistent) or stay at better-auth's basePath (client-default-consistent, REF's current choice)?
- Is API compatibility with @thallesp/nestjs-better-auth (decorator names like AllowAnonymous/OptionalAuth/Roles/OrgRoles, AuthService, hooks decorators) a goal, or is a clean break acceptable?
- Should route-level 'public' mean 'never touch the session store' (owner's v3 idea for @Public) while a separate decorator means 'optional session'?
- Are decorator-based API/DB hooks (@BeforeHook, @DatabaseHook) required in v1, given they need a construction-time better-auth plugin rather than post-hoc mutation?
- Which transports are in scope for v1: GraphQL (Apollo only, or Mercurius too; subscriptions?), WebSocket connection-level auth, microservices/RPC?
- Must multiple named better-auth instances or a dynamically swappable instance (#51, #79) be supported by the core design?
- Should the library ship testing utilities (session mocking / test auth instance helpers) for consumers?

# nest-platform

**Scope.** Code reading of NestJS 11.1.17 and 12.0.1, plus about 15 runtime experiments on both majors, each on Express 5.2.1 and Fastify 5.8.2/5.12.1.

**NestJS 12.0.1 is released (2026-08-27).**

- Every @nestjs package is ESM-only, so CJS consumers need `require(esm)` and Node 20.19+ or 22.12+.
- better-auth 1.7.4 is ESM-only too.
- The init order and body-parser timing are the same as v11.

**Init order.**

1. `NestFactory.create` sets `HttpAdapterHost.httpAdapter`, which fires `init$`. `init$` is a ReplaySubject.
2. Fastify registers middie.
3. Provider constructors run.
4. `app.init()` then runs: CORS from app options → **body parsers** → every `configure()` → middleware → controllers → `onModuleInit` → 404 and error handlers → `onApplicationBootstrap`.

**Express depends on order; Fastify does not.**

- **Express:**
  - Routes registered in a constructor or from `init$` sit before Nest's `jsonParser`, so they get the raw stream. That also puts them before the user's own `app.use`/`enableCors`.
  - Routes registered in `configure()` or `onModuleInit` get JSON and form bodies already consumed.
  - Routes registered after `onModuleInit` are hidden by the 404 handler in v11.
- **Fastify:**
  - Registration phase doesn't matter until `listen()`/`ready()`. After that, adding a route throws.
  - `bodyParser:false` still parses JSON and text/plain, and form requests get 415.
  - To keep the raw stream, use an encapsulated plugin with `removeAllContentTypeParsers()` plus a `'*'` pass-through. Verified: the stream is untouched for JSON, form and multipart, and other routes are unaffected.

**`@nestjs/testing` differs.** `httpAdapter` is undefined inside provider constructors. A `init$` subscription works in both production and tests.

**Mounting options.**

- **Raw adapter route:** no global prefix, guards or versioning. Global exception filters still catch its errors.
- **Nest middleware:**
  - On Express, the string form `forRoutes('x')` becomes `app.use`, which rewrites `req.url`.
  - On Fastify it is middie in `onRequest` with raw req/res. The body is unparsed, and **@fastify/cors and reply headers are bypassed**.
  - `forRoutes('api/auth')` is an exact match on Fastify but a prefix match on Express.
- **Controller `@All`:**
  - `*path` and `{*path}` **fail to boot on Fastify**. `'*'` works on both, but Express logs a warning.
  - On Fastify, `@All` ignores header and media versioning, because `FastifyAdapter` does not override `all()`.
  - It gets the global prefix and the URI version prefix.

**Web Response.**

- Express has no native support: `res.send(Response)` sends `{}`.
- Fastify has sent `Response` natively since 4.26 and in all of v5. CORS headers, `onSend` hooks and multiple `Set-Cookie` are preserved.
- **Bug:** HEAD on an auto-generated HEAD route returns 500 when the payload is a Response (`head-route.js:29`). Workaround, verified: send the status, headers and `response.body` stream yourself.
- `reply.hijack()` drops headers set earlier with `reply.header()`, such as CORS.

**better-call's Node bridge.**

- It loses the query string under `app.use('/x/*path')` mounts.
- It throws on HTTP/2 pseudo-headers.
- It re-serializes bodies that were already parsed, which is lossy. The Stripe webhook check needs the raw body.

**v12 adapter changes.**

- New methods: `query`, `beforeClose`, `mapException`, `isRouteOrderSensitive`.
- The Fastify middleware-prefix bug is fixed.
- Express now scopes its 404 handler to the global prefix. With `setGlobalPrefix('v1')` there is no Nest JSON 404 at all; this looks like a regression, not confirmed.
- New `routeConflictPolicy` option.
- Helpers moved to non-public `/internal` entry points.

## Implications

- Platform strategies must be keyed by httpAdapter.getType(), an open set (third parties return e.g. 'hono', with non-Node request/response objects). Resolve strategies through DI or a registry so core never switches on the platform name (Open-Closed).
- Registration timing must be a per-platform decision. Express needs to mount before the parsers to get raw bodies; the only hook that works in both NestFactory and @nestjs/testing is subscribing to HttpAdapterHost.init$ from a constructor. Fastify is order-insensitive, but plugin routes need ready().
- Mounting early on Express, or mounting as middleware on Fastify, bypasses the user's enableCors, app.use and helmet. CORS ownership for auth routes must be explicit per platform, e.g. derived from better-auth trustedOrigins, as the reference library does.
- Keep the raw request stream for auth routes. On Express: mount early, require bodyParser:false, or use the name-preemption hack. On Fastify: an encapsulated plugin with pass-through parsers. Treat re-serializing parsed bodies as a lossy fallback only, and enforce a body-size limit yourself when bypassing platform parsers.
- Build the Web Request yourself instead of using better-call toNodeHandler. Take the URL from originalUrl (Express) or raw.url (Fastify), apply an explicit trusted host/proto policy, filter HTTP/2 pseudo-headers and symbol keys from Headers, and set duplex:'half' for stream bodies.
- Write responses back per platform. Express: stream to ServerResponse with backpressure and preserve multiple Set-Cookie. Fastify: reply.code() plus reply.header() for each entry, then reply.send(response.body). This keeps CORS and onSend and avoids the HEAD 500. Avoid hijack, or merge reply.getHeaders() first.
- A controller-based strategy, if offered, has to handle: per-platform wildcard syntax ('*' on Fastify), VERSION_NEUTRAL, the global-prefix exclude policy, opt-out from global guards, the Fastify @All constraint gap, and Nest 12 routeConflictPolicy shadow diagnostics.
- Read ApplicationConfig (prefix, exclude, versioning) only at configure() or onModuleInit. Do not mutate globalPrefixOptions in a constructor, because the user's later setGlobalPrefix(p, opts) replaces it.
- Dual CJS+ESM: Nest 12 and better-auth are ESM-only, so the CJS build requires Node >= 20.19 / 22.12. Make DI tokens robust to our own dual-package hazard (e.g. Symbol.for or string tokens).
- Avoid deep imports (@nestjs/*/utils, middleware/utils, constants); Nest 12 marks the internal entry points non-public. Use public decorators such as re-applying @All() instead of writing metadata keys directly.
- Middleware-based strategies must use req.originalUrl on Fastify, because middie rewrites req.url. On Express, do not use string forRoutes('x/*path') without rebuilding the URL from originalUrl.

## Pitfalls

- In @nestjs/testing, HttpAdapterHost.httpAdapter is undefined in provider constructors, so constructor-time route registration breaks e2e tests.
- Express routes registered in onApplicationBootstrap or later are unreachable in v11 (Nest's 404 is registered first). In v12 they become reachable outside the global prefix.
- Fastify bodyParser:false still parses JSON and text, and form requests get 415.
- Calling Fastify useBodyParser before init sets _isParserRegistered and suppresses Nest's json/urlencoded parsers.
- Fastify throws FST_ERR_CTP_ALREADY_PRESENT on a duplicate parser and FST_ERR_INSTANCE_ALREADY_LISTENING for routes added after listen.
- @All('*path') and @Get('_path') crash Fastify at startup; @All('_') logs a LegacyRouteConverter warning on Express.
- @All on Fastify ignores header and media versioning and @RouteConfig/@RouteConstraints/@RouteSchema.
- forRoutes('api/auth') without a wildcard is an exact match on Fastify but a prefix match on Express. The current repo's src/auth-module.ts:149-157 uses this form, so it would not serve auth sub-paths on Fastify.
- Fastify v11 re-prefixes middleware paths excluded from the global prefix when the body parser is enabled (fixed in v12).
- Nest middleware on Fastify bypasses @fastify/cors (including preflight), reply.header() and onSend hooks.
- reply.hijack() drops headers set via reply.header(), such as CORS.
- reply.send(Response) on a GET route with an auto-generated HEAD route returns HEAD 500 (Fastify 5.8.2 through 5.12.3).
- Express res.send(Response) sends '{}'; a Nest controller returning Response is broken on Express but works on Fastify.
- better-call getRequest loses the query string under app.use('/x/*path') mounts (OAuth callbacks break), throws on HTTP/2, and re-serializes consumed bodies (breaks Stripe webhook signatures).
- The pass-through parsing path enforces no request body size limit.
- Sending a raw HTTP request to Fastify before ready() crashed the process.
- FastifyAdapter({skipMiddie:true}) breaks strategies that rely on adapter.use (inferred from code reading, not run).
- Nest 12 Express: with a global prefix, especially one with no leading slash, Nest's JSON 404 is not served outside the prefix (possible regression, not confirmed).
- Mutating controller route metadata at runtime is process-global and leaks between apps booted in the same test process.

## Open questions for user

- Is Node >= 20.19 / 22.12 acceptable as the floor for the CJS build? Nest 12 and better-auth 1.7.4 are ESM-only, so the CJS build depends on require(esm). The alternative is lazy import() of better-auth.
- Who should own CORS for auth routes: the library (derived from better-auth trustedOrigins), the user's enableCors, or a documented per-platform matrix?
- On Express, is it acceptable to require users to set bodyParser:false, as @thallesp/nestjs-better-auth does? The alternatives are mounting early (bypasses user middleware and CORS) or pre-empting Nest's parsers by function name (loses rawBody).
- Should auth routes ever go through the Nest pipeline (guards, interceptors, filters) via a controller strategy, or only through a raw platform mount?
- Are HTTP/2 and third-party adapters such as Hono in the v1 support matrix, or only reachable through the extension contract?
- Should auth routes honour Nest's global prefix and URI versioning by default, or stay at better-auth's absolute basePath (excluded from the prefix)?

# nest-di

**NestJS 12 is out and ESM-only.** 12.0.0 and 12.0.1 were published 2026-08-27; npm `latest` is 12.0.1. The packages have `"type":"module"` and no `require` condition. A CJS consumer can still load it through `require(esm)` on Node 20.19+ / 22.12+ (tested on Node 22.22: it worked and returned the same module instance as `import`). `@nestjs/graphql` 14 requires Nest 12.

Runtime experiments on both Nest 11.1.17 and 12.0.1:

- **WebSockets and global guards:**
  - On Nest 11, an `APP_GUARD` never runs for gateway messages, so gateways are silently unprotected.
  - On Nest 12 the same guard does run, and an `HttpException` thrown there reaches the client as `{status:'error', message:'Internal server error'}`.
  - Global exception filters never apply to gateways on either version, so WS needs `WsException`.
  - RPC: a non-`RpcException` also becomes "Internal server error". Hybrid apps skip global guards and filters unless `inheritAppConfig` is set. The gRPC status exceptions exist only in 12.
- **GraphQL:**
  - The Apollo driver (not `@nestjs/graphql` itself) maps 401 to `UNAUTHENTICATED` and 403 to `FORBIDDEN`. A guard returning `false` throws `ForbiddenException`.
  - The guard runs once per root field (3 times for one request), so the session lookup must be memoized per request.
  - `@ResolveField` resolvers skip guards unless `fieldResolverEnhancers` is set.
  - The Mercurius driver has no such mapping (from reading the code only).
- **Guards in tests and DI:**
  - An `APP_GUARD` registered with `useClass` cannot be overridden in tests. Only registering the guard as a provider plus `{provide: APP_GUARD, useExisting: G}` and then `overrideProvider(G)` works.
  - A request-scoped `APP_GUARD` re-creates every controller on every request.
  - Importing `forRoot()` twice registers the global guard twice, because modules are identified by object reference.
- **ConfigurableModuleBuilder:**
  - Extras reach only the transform callback, never a provider.
  - With an empty defaults object they leak into the options value, and an explicit `undefined` overrides the default.
  - Async extras are fixed when the module is defined. The nestjs-cls workaround is to always register the guard and let a factory return a no-op.
- **DiscoveryService:**
  - `createDecorator()` keeps one key per class and uses a random key.
  - Filtering by metadata key misses `useFactory` and `useValue` providers; scanning everything with `getMetadataByDecorator` finds them.
  - Request-scoped providers seen at bootstrap are prototype-only objects whose constructor never ran.
  - Global modules run their lifecycle hooks first. Nest 12 changed hook ordering within a module.
- **`loadPackage`:** synchronous and `process.exit(1)` on failure in 11; async and marked internal in 12. It is unusable for a library that must support both.
- **Dual CJS+ESM:** random decorator keys, `Symbol()` tokens and class tokens are duplicated if both builds load in one process. better-auth itself uses `Symbol.for` on `globalThis` for this reason.
- **Fastify:** Nest middleware receive `req.raw`, while guards see the Fastify request object.
- **Passport as an OCP precedent:**
  - Good: strategies are provider classes, and the guard has overridable template methods (throttler does the same).
  - Bad: a global mutable registry filled by constructor side effects, string keys, HTTP-only defaults, and HTTP-only errors.
- **Testing:** better-auth 1.7.4's `testUtils()` gives real session headers for end-to-end tests.

tsdown 0.23.0 does emit `design:paramtypes` metadata, but explicit `@Inject` is still safer. The report gives file:line citations throughout; claims not verified at runtime are marked UNVERIFIED.

## Implications

- Support Nest 11 and 12: peers @nestjs/* ^11||^12 and @nestjs/graphql ^13||^14. The CJS build depends on require(esm) (Node >=20.19/22.12) when used with Nest 12. The CI matrix must cover both majors, because WS global-guard behavior and hook ordering differ.
- Keep core transport-agnostic and add transports by extension: an adapter registry keyed by context.getType() and the HTTP platform getType(). Each adapter supplies credential extraction (Headers) and error mapping, so new transports and platforms never edit core.
- Error mapping belongs in transport adapters, not only in exception filters: WS ignores global filters on both majors, RPC needs RpcException (or gRPC exceptions on 12), and HTTP/Apollo accept HttpException.
- Register the global guard as a provider plus {provide: APP_GUARD, useExisting: Guard} so consumers can overrideProvider(Guard). Keep it singleton (no request-scoped dependencies) and guard against double forRoot() registration.
- Make WS behavior explicit per Nest major: on 11 a global guard does not protect gateways; on 12 it runs for them and must handle 'ws' contexts.
- To toggle features from forRootAsync config, always register the enhancer and middleware and decide at runtime in a factory or no-op (nestjs-cls pattern), because ConfigurableModuleBuilder extras are fixed when the module is defined.
- Deliver authorization strategies (roles, permissions, org) as DI-provided extensions evaluated by a stable core pipeline, not hard-coded in canActivate as the reference library does. Nest has no multi-providers, so the collection must come from discovery or an explicit list turned into providers.
- Use dual-package-safe identities: namespaced Reflector.createDecorator({key}), Symbol.for or string tokens, and @Inject helper decorators. Avoid DiscoveryService.createDecorator for markers (one key per class, random key).
- For discovery-based hook registration: do a full scan with getMetadataByDecorator, filter isAlias, warn on or resolve non-static providers per context, and run early (a global module's onModuleInit runs first).
- Memoize the session lookup per request: GraphQL runs the guard once per root field, and param decorators or field resolvers may ask again. Key by transport request identity (Fastify raw vs FastifyRequest) or ALS, and avoid the req.session and req.user names.
- Ship optional integrations as subpath entry points (e.g. /graphql, /ws, /rpc, /fastify, /testing) with static peer imports instead of Nest's loadPackage.
- Make param decorators synchronous and route them through the same transport adapter registry.
- Testing story: document the useExisting-based guard, expose an overridable session-resolution provider, and point e2e tests at better-auth's testUtils().getAuthHeaders.
- Use explicit @Inject(token) for every constructor parameter in library code even though tsdown emits design:paramtypes.

## Pitfalls

- Nest 12 is ESM-only: require('@nestjs/common/package.json') fails, loadPackage is async and internal, and @nestjs/graphql 14 removed subscriptions-transport-ws.
- On Nest 11 a global APP_GUARD silently does not protect WS gateways; on Nest 12 it does, and an HttpException thrown there becomes 'Internal server error'. Global filters never reach WS.
- In hybrid apps, microservice handlers skip global guards and filters unless inheritAppConfig: true.
- In GraphQL a guard returning false throws an HTTP ForbiddenException; only the Apollo driver maps it to a GraphQL code (Mercurius does not). @ResolveField resolvers skip guards by default.
- APP_GUARD registered with useClass cannot be overridden in tests.
- A request-scoped APP_GUARD makes every controller request-scoped.
- Importing forRoot() twice registers the global guard twice.
- ConfigurableModuleBuilder extras leak into the options value when their defaults are omitted; an explicit undefined overrides the default; async extras cannot come from factory results.
- Reflector.createDecorator() with no argument stores {}; the typed get/getAllAndOverride hide undefined; getAllAndMerge nests arrays for mixed types; overriding a method drops its metadata.
- DiscoveryService.createDecorator allows one key per class, its metadataKey filter misses useFactory/useValue providers, and its keys are random per copy.
- Request-scoped providers found by discovery are prototype-only objects without injected dependencies; lazy-loaded modules get no lifecycle hooks and are missed by discovery.
- On Fastify, middleware mutate req.raw, not the FastifyRequest that guards see.
- An async createParamDecorator factory only works when no pipes apply.
- The @nestjs/passport pattern relies on a global mutable registry filled by constructor side effects, string keys, and HTTP-only defaults.
- Loading both CJS and ESM copies of the library duplicates class tokens, Symbol() tokens and uid decorator keys.
- Isolated transpilation (tsdown/oxc) emits Object for interface or type-only-import parameter types, so injection breaks without explicit @Inject.
- The graphql-ws subscription context sets req to the graphql-ws context, not the HTTP request (UNVERIFIED at runtime).

## Open questions for user

- Nest 12 is released and ESM-only. May the CJS build require Nest 12, which limits users to Node >=20.19/22.12? Should CI test both Nest 11 and 12?
- On Nest 11 global guards do not reach WS gateways; on Nest 12 they do. Should WS authentication be automatic, opt-in, or opt-out, and should Nest 11 get an explicit gateway guard or interceptor?
- Which RPC transports are in scope (TCP/NATS/Kafka/RMQ/gRPC), and how do better-auth credentials travel there (cookie header, or bearer token in metadata) given that getSession needs Headers?
- Should the per-request session cache be an AsyncLocalStorage store (nestjs-cls-like, reachable from services) or a WeakMap keyed by the transport request object?
- Should forRoot auto-register the global guard (as the reference library and nestjs-cls do), or should users add APP_GUARD themselves (as with throttler)?

# packaging

**better-auth 1.7.4 and @better-auth/core are ESM-only.** This holds in source and in the published tarballs: no `require` condition on any of 54 + 13 subpaths, including `/node` and `/api`. The docs say "CommonJS (cjs) isn't supported". Even so, `require()` works on Node 20.19+ and 22.12+ because the graph has no top-level await. It fails with `ERR_REQUIRE_ESM` on 20.18 and 22.11. better-auth has no CJS smoke test, so this is incidental, not a contract.

**NestJS 12.0.1 (npm latest since 2026-08-27) is ESM-only.** That covers core, common, the platform packages, websockets and @nestjs/graphql 14. Nest 11 is plain CJS. `nest new` defaults:

- Nest 11: CJS.
- Nest 12: ESM with vitest. CJS (with jest) is only an interactive prompt option; CLI 12 has no `--type` flag.

**Node require(esm).** Unflagged in 20.19.0 and 22.12.0. The warning is gone from 20.19.0 and 22.13.0 (22.12.0 still warns). Stable from 25.4.0. A graph with TLA throws `ERR_REQUIRE_ASYNC_MODULE`. Node 20 is already EOL (2026-04-30).

**TypeScript.** `nodenext` (5.8+) and `node20` let CJS files import ESM with no error, keeping native `import()`. `node16`/`node18` raise TS1479. `module: commonjs` rewrites `import()` into `require()`. TS 6 deprecates `node10`. TS 7.0.2 is npm latest: it has no classic JS API, but its tsc still emits decorator metadata.

**What CJS consumers need regardless of what we ship.** Node ^20.19 || >=22.12, because of better-auth and Nest 12. Jest in CJS mode (the Nest CJS template runner) can't load better-auth or Nest 12 without Node 24.9+ and `--experimental-vm-modules`, and a CJS build of our lib doesn't change that.

**tsdown 0.23.0 (rolldown 1.2.8/oxc).** It emits legacy decorators plus `design:paramtypes` from tsconfig, and I verified Nest DI in both formats. Dual builds produce `.mjs`/`.cjs` plus `.d.mts`/`.d.cts`.

- `fixedExtension` now defaults to true on node, so the repo's exports map (made for 0.12.9's `.js`) would break.
- `exports: true` rewrites package.json with no `types` conditions.
- Running publint and attw post-build works.
- Pitfalls: a missing `experimentalDecorators` still builds, but the output crashes Node with a SyntaxError. `import type` of an injected class gives `Object`, and Biome's `useImportType` offers that rewrite as a "safe fix".
- vitest 5 on vite 8 handles decorator metadata without unplugin-swc.

**Dual-package hazard, reproduced under Nest 11.** Loading both builds splits `Symbol()` tokens, class tokens and module state, and DI fails with `UnknownDependenciesException`. `Symbol()` metadata keys fail silently. `Symbol.for` and string tokens survive. The current repo and the reference both use `Symbol()`. Three mitigations were verified:

- `module-sync`-first: one copy only on Node that supports require(esm).
- `node`→CJS routing (the rxjs 7 and graphql 17 pattern): one copy everywhere. Needs `.d.cts` types or attw reports FalseESM.
- An ESM wrapper over CJS: one copy everywhere.

**Optional peers.** `import()` and `createRequire(import.meta.url)` both work in both outputs, because tsdown shims `import.meta.url` in CJS. So do subpath entries with static imports. TLA fails the CJS build. Nest 12's own `loadPackage`/`loadPackageSync` (async import plus a sync createRequire cache) is a precedent.

**Reference library.** ESM-only via unbuild/esbuild, so 0 `design:` in dist and explicit `@Inject` everywhere. A bare `require()` in its ESM output forced async error factories. Its CJS "validation" tests SWC-compiled `src`, not `dist`.

## Implications

- The effective consumer Node floor is require(esm): ^20.19.0 || >=22.12.0, because better-auth (and Nest 12) are ESM-only. A CJS build does not lower it unless every better-auth import is deferred behind import(). Node 20 is EOL, and engines.node also drives tsdown's default target.
- If dual output is kept, pick an explicit hazard strategy: module-sync-first (ESM canonical), node->CJS routing (with .d.cts types for the node.import branch), or an ESM wrapper over CJS. Plain import/require routing leaves class-identity DI failures possible.
- Make identity-sensitive values copy-safe regardless of routing: Symbol.for('<pkg>:<name>') or namespaced string DI tokens and metadata keys, never Symbol() or ConfigurableModuleBuilder's random default. Keep state in Nest providers, not module scope. Avoid instanceof across the package boundary.
- Class tokens (AuthModule, AuthService, guards) cannot be made copy-safe with Symbol.for; only single-copy routing prevents duplicate modules or providers.
- Keep experimentalDecorators and emitDecoratorMetadata in the exact tsconfig tsdown reads, and assert in CI that dist contains design:paramtypes, or boot Nest from dist in a smoke test. Alternatively use explicit @Inject everywhere, as the reference does.
- Keep Biome style/useImportType off, or scoped away from decorated classes; its 'safe fix' breaks DI.
- Load optional peers only via subpath entry points (static import), cached import(), or createRequire(import.meta.url), mirroring Nest 12's loadPackage/loadPackageSync. Sync hot paths such as guard error mapping should preload asynchronously and read from a cache. No TLA anywhere.
- Map Open-Closed extension points (platforms, transports, strategies) to subpath entries: tsdown entry keys become export keys, and shared code becomes one chunk per format so subpaths share instances.
- Upgrading to tsdown 0.23 changes output extensions (fixedExtension). Either use exports:true (it rewrites package.json and omits types conditions) or hand-author exports with custom conditions verified by publint and attw.
- CI matrix: publint --strict; attw --profile node16 (or strict plus typesVersions); a consumer type-check matrix (CJS nodenext, ESM nodenext, bundler, node16) with skipLibCheck; runtime smoke tests installing the packed tarball into Nest 11 CJS, Nest 11 ESM and Nest 12 ESM fixtures on Node 20.19/22.12/24/26 with Express and Fastify; a dual-load identity test.
- Vitest 5 on Vite 8 needs no unplugin-swc for decorator metadata. Pin Vite 8 if dropping SWC.
- Prefer public Nest APIs over deep internal imports (Nest 12 marks ./internal as not public), and never read @nestjs/*/package.json on Nest 12.
- Revisit peer ranges: Nest ^11 || ^12, @nestjs/graphql ^13 || ^14, graphql ^16.11 || ^17, and whether typescript should be a peer at all (TS 7 is npm latest; the repo currently peers ^5.9.2).

## Pitfalls

- A tsdown build with experimentalDecorators missing from the resolved tsconfig SUCCEEDS but outputs raw TC39 decorator syntax, which throws SyntaxError at load. There is no build-time error.
- 'import type' of an injected class silently yields design:paramtypes [Object] (oxc) or [Function] (tsc), a runtime DI failure. Biome useImportType offers this change as a 'Safe fix'.
- Symbol() DI tokens and metadata keys diverge when both CJS and ESM copies load. DI tokens fail loudly (UnknownDependenciesException); metadata keys fail silently (hooks not discovered).
- tsdown 0.23 defaults fixedExtension=true on node (.mjs/.d.mts), so the repo's current exports map (./dist/index.js, index.d.ts) would point at missing files.
- tsdown exports:true generates no 'types' conditions and no node10 support for subpaths (attw strict fails node10; TS node10 consumers get TS2307).
- node->CJS routing with .d.mts types under the import branch triggers attw 'Masquerading as ESM' and a publint error; use .d.cts.
- Top-level await: the CJS build fails with a rolldown UNSUPPORTED_FEATURE error, and require() of the ESM build throws ERR_REQUIRE_ASYNC_MODULE.
- Jest in CJS mode cannot load better-auth or Nest 12 unless on Node 24.9+ with --experimental-vm-modules, whatever our package ships.
- Node 22.12.0 prints an ExperimentalWarning on require(esm); 22.13+ and 20.19 do not.
- better-auth publishes a 'dev-source' export condition pointing at an unshipped src/, so enabling a condition with that name in tooling breaks better-auth resolution.
- better-auth 1.7.4 published types fail without skipLibCheck (bun:sqlite, @cloudflare/workers-types, Timer). attw does not catch transitive type problems.
- @nestjs/core/package.json is not resolvable on Nest 12 (wildcard export maps it to package.json.js).
- TypeScript 7 (npm latest) exposes no classic JS API; ts-jest, api-extractor and rolldown-plugin-dts's tsc generator need TS 5.x/6.x installed.
- The repo's tsdown 0.12.9 is paired with rolldown 1.0.0-rc.9 and prints 'Invalid input options: define'; the toolchain is out of sync.
- A bare require() in ESM output is a ReferenceError under non-shimming bundlers; the reference shipped that bug under unbuild. tsdown on platform node shims it, but relying on that is implicit.

## Open questions for user

- Which Node engines floor: ^20.19.0 || >=22.12.0 (the require(esm) minimum), >=22.12.0 (Node 20 is EOL), or the reference's >=22.22.1?
- Which dual-package strategy: module-sync-first (ESM canonical), node->CJS routing, an ESM wrapper over CJS, or plain import/require plus copy-safe tokens while accepting class-identity risk?
- Given better-auth is ESM-only, what is the CJS artifact expected to achieve beyond the hard requirement? It cannot serve Node below the require(esm) line or fix Jest CJS users.
- Must Jest (CJS mode) users be supported? They need Node 24.9+ with --experimental-vm-modules or transform config regardless of our packaging.
- Support TS moduleResolution node10 (deprecated in TS 6, removed in TS 7) for subpaths via typesVersions, or declare it unsupported?
- Use tsdown exports:true (it auto-rewrites package.json) or hand-maintain the exports map and verify with publint and attw?
- Should typescript remain a peer dependency, and with what range now that TS 7.0.2 is npm latest?
- Target peer ranges: support Nest 11 and 12 in one release line? graphql 17 and @nestjs/graphql 14?

# ba-authz

**Scope.** I read the better-auth 1.7.4 source and docs and ran probes against npm `better-auth@1.7.4` and `@better-auth/api-key@1.7.4`, plus `tsc` type tests with `@nestjs/common@12.0.1`. Probe scripts are in `scratchpad/tmp-ba-authz/`.

**How the server gets the principal**

- `auth.api.*` runs the full plugin hook pipeline. So bearer (`Authorization: Bearer <session token>`), api-key with `enableSessionForAPIKeys` (`x-api-key`) and jwt all change what server-side `auth.api.getSession({ headers })` does.
- Some principals never reach `getSession`; it returns `null` for them:
  - **JWT-plugin tokens:** verify with `auth.api.verifyJWT` or jose + JWKS.
  - **OAuth-provider / MCP access tokens:** verify with `verifyAccessTokenRequest` from `better-auth/oauth2`.
  - **API keys used purely as credentials:** check with `verifyApiKey`.
- `customSession` replaces both `getSession` and `$Infer.Session` with whatever shape the callback returns.
- A guard-side `getSession` drops the refresh and cookie-cache `Set-Cookie` headers unless you pass `returnHeaders: true`.
- The cookie cache (default 5 min) serves stale roles and revoked sessions. better-auth's own admin endpoints read the session authoritatively instead.

**Permission APIs**

- **`userHasPermission` (admin):** passing `headers` makes it evaluate the session user and ignore `body.userId` / `body.role`. It does one authoritative session read. Without headers, `role` costs 0 DB reads and `userId` costs 1.
- **`hasPermission` (organization):** `headers` are required. The org comes from `body.organizationId` or the active org. Measured cost is 1 session read + 1 member read + 1 role read with dynamic access control. A non-member gets 401.
- **Pure org check:** the organization plugin exports a pure `hasPermission(input, { context: await auth.$context })`. The admin plugin's pure version is not exported.
- **Access control:** `role(stmts).authorize()` is pure and sync, and supports OR per resource. The HTTP endpoints only accept arrays (AND).
- **Role-string rules both plugins share:**
  - roles are split on commas **without trimming**;
  - a single role must grant every requested permission (grants aren't combined across roles);
  - the deprecated singular `permission` key gives a 400 on the admin endpoint and a silent `false` on the org endpoint, although the docs list it as valid.

**Pitfalls found in probes**

- **API-key sessions:**
  - Default rate limit is 10 requests/day, and every `getSession` counts.
  - A bad key makes `getSession` throw rather than return `null`.
  - The `x-api-key` header takes precedence over the cookie.
  - The mocked session exposes the raw key as `session.token` and includes user fields marked `returned:false`.
- **JWT plugin:** signs a JWT and reads the key table on every `getSession` unless `disableSettingJwtHeader` is set.
- **Stale active org:** a removed org member keeps `activeOrganizationId` on their session.

**Types**

- Plugin schema fields and `additionalFields` flow into `$Infer.Session` only when `plugins` is a tuple. Inline literals and `satisfies` keep it a tuple; a `BetterAuthPlugin[]` annotation loses the fields (verified with tsc).
- A NestJS param decorator can't type its parameter. Three verified ways to export a type users annotate with:
  - a generic helper, `SessionOf<typeof auth>`;
  - module augmentation of a registry interface, which is better-auth's own pattern for plugins;
  - a typed factory. Its declaration output inlines the full session type; the augmentation only emits a reference.

**Reference library (`@thallesp/nestjs-better-auth` 2.8.0)**

- `@Roles` reimplements role matching, trimming around commas and ignoring `adminUserIds` / `defaultRole`.
- The `userId` / `role` options of `@UserHasPermission` do nothing.
- It calls `getSession` before checking `@AllowAnonymous`.
- It never forwards `Set-Cookie`.
- Org decorators only work with the session's active org.
- It re-resolves the session for every permission check.
- It turns every error into a 403.
- Metadata keys are bare strings, `Auth` is typed `any`, and the policy list is hard-coded in the guard, so adding one means editing core.

**ESM:** better-auth 1.7.4 and NestJS 12.0.1 are ESM-only. Node 22.22 can still `require()` both.

## Implications

- Separate authentication (principal resolvers returning a discriminated union: session / jwt / oauth-access-token / api-key) from authorization (policies). Principal sources have different verification APIs, shapes and error semantics, so each should be addable without touching the other.
- Minimal policy contract: evaluate(requirement, principal, ctx) => Promise<Decision>. Decision is allow, or deny with status 401|403, an optional code/message, and an optional WWW-Authenticate challenge (needed for OAuth/MCP insufficient_scope). Infrastructure errors must propagate, not become 403.
- AuthzContext must be transport-neutral (Headers plus an accessor for route params / GraphQL args / headers, e.g. for the org id) and memoized per request, so the session resolves once and verifyApiKey (which consumes quota) runs at most once. better-auth can't pass a resolved session into later auth.api calls.
- Declare requirements with Reflector.createDecorator (unique typed keys) and dispatch them to policies registered by kind through DI, so new policies are new providers plus decorators with no core edits. Choose composition explicitly (getAllAndMerge vs getAllAndOverride).
- Built-in policies should be thin adapters. System permission: userHasPermission with body.userId and no headers (1 read, fresh role, handles adminUserIds). Org permission: hasPermission with headers + organizationId, or the exported pure hasPermission. API-key scopes: role(key.permissions).authorize() on the single verifyApiKey result. OAuth/JWT scopes: requiredScopes or the scope claim.
- Org context should be its own resolver extension (route param, header, or active org), since the active org can be missing, stale for removed members, and per-tab per the docs.
- The session resolver should call getSession with returnHeaders:true and hand Set-Cookie to the HTTP platform adapter. The platform-adapter contract needs an optional 'forward response headers' capability that WS/GraphQL can decline.
- Don't assume {user, session}. customSession changes the shape, so either constrain SessionOf<A> extends { user: { id: string } } or accept a user-supplied normalizer.
- Expose typing through SessionOf<A> plus a module-augmentation registry (non-generic decorators/services, matching better-auth's own BetterAuthPluginRegistry idiom) and/or a typed factory. Use a structural minimal constraint rather than Auth<any> to keep customSession precision.
- Validate plugin prerequisites (admin/organization/api-key/jwt) at module init via auth.options.plugins or $context.hasPlugin, instead of per-request typeof checks that turn into 403.
- Offer an 'authoritative/fresh' requirement. Pass disableCookieCache only when auth.options.database or secondaryStorage is set (mirrors isStateful), and read freshAge from $context.sessionConfig.
- Keep runtime imports of better-auth in core small by delegating through the user's auth instance. Both better-auth 1.7.4 and NestJS 12 are ESM-only, so the CJS build relies on require(esm).

## Pitfalls

- getSession without returnHeaders drops session-refresh and cookie-cache Set-Cookie, so the browser cookie is never extended through Nest routes; the stateless-mode docs require forwarding.
- Role and ban checks from a cookie-cached session are stale for up to cookieCache.maxAge (default 300 s), and revoked sessions still validate.
- Reimplementing role checks diverges from better-auth: no trimming in better-auth, adminUserIds and defaultRole handling, no union across comma-separated roles.
- userHasPermission with headers ignores body.userId and body.role; passing even an empty Headers object switches it to session mode (401 without a session).
- The singular 'permission' key returns 400 (admin) or silently false (org), although the docs list it as valid; always send 'permissions'.
- With enableSessionForAPIKeys, an invalid x-api-key makes getSession throw. Calling getSession on @AllowAnonymous routes then breaks public routes and consumes rate limit (default 10/day per key).
- verifyApiKey after getSession with the same x-api-key double-consumes usage and rate limit (documented); there is no side-effect-free way to read key permissions.
- The api-key mocked session exposes the raw key in session.token and user fields marked returned:false at runtime; serializing @Session() leaks them.
- The jwt plugin signs a JWT and reads the jwks table on every guard getSession unless disableSettingJwtHeader:true.
- A random non-dotted Bearer token costs a session lookup unless bearer({ requireSignature: true }).
- A present activeOrganizationId doesn't prove membership: removed members keep it. The org hasPermission endpoint returns 401 (not 403) for non-members.
- customSession changes the getSession shape; code reading session.user may crash or misjudge authentication.
- Plugins passed as a widened BetterAuthPlugin[] lose all plugin fields from $Infer.Session.
- A param decorator cannot enforce the parameter type; any annotation compiles.
- The org pure hasPermission writes to a process-global cacheAllRoles Map keyed by organizationId, which grows unbounded.
- Nest's BaseExceptionFilter duck-types better-auth APIError (statusCode + message) and replies with its status but drops body.code and logs it as an error; GraphQL/WS/RPC behavior is unverified.
- Bare-string metadata keys ('ROLES', 'PUBLIC') and the request.session / request.user slots can collide with other libraries (express-session, passport).

## Open questions for user

- Should public (@AllowAnonymous) routes skip principal resolution entirely (cheaper, avoids api-key throws), or keep populating the session opportunistically like the reference library?
- Default freshness for authorization: trust the cookie cache (cheap, up to maxAge stale), or read authoritatively (extra DB read per protected request), with per-route opt-in or opt-out?
- Should the library ship role-based decorators at all, given better-auth has no 'has role' API and favors access-control permissions? If yes, must they match better-auth's parsing exactly (no trim, adminUserIds, defaultRole)?
- For API keys: support the enableSessionForAPIKeys session-mock path, a first-class api-key principal via a single verifyApiKey call, or both?
- Should OAuth-provider / MCP access-token principals (verifyAccessTokenRequest with WWW-Authenticate challenges) be in v1 scope, or left as an extension example?
- Preferred typing ergonomics: module-augmentation registry (non-generic @Session()), typed factory (createAuthDecorators<typeof auth>()), or both?
- Where should the org id come from by default (active org, route param name, header), and should that be configurable per route?
- NestJS 12.0.1 is published and ESM-only. Should v1 support both 11 and 12, and is Node >= 20.19/22.12 (require(esm)) an acceptable floor for the CJS build?

# current-repo

**Provenance.** At commit `4a3dd2f`, the current repo's `src/` and `tests/` are byte-identical to upstream `@thallesp/nestjs-better-auth` **v2.4.0** (commit 9554855; tree hashes 874febc and 121479b match). It is not based on v2.8.0. Commit `8004ff1` only swapped bun/unbuild for pnpm/tsdown. So almost every difference from the v2.8.0 reference is upstream work the fork never received, not local changes:

- Fastify support, handler mounted with `httpAdapter.use` plus a base-path check
- `bodyParser` options
- `createAuthMiddleware` imported from `better-auth/api`
- `RequireActiveOrg`, `UserHasPermission`, `MemberHasPermission`, `@DatabaseHook` decorators, generic `UserSession<T>`
- ESM-only packaging, Nest 12 peer ranges, a Fastify test matrix and OIDC publishing

**Local semantic changes.** The only one is uncommitted: the working tree removes `.setClassMethodName("forRoot")`. `AuthModule.forRoot()` now throws `(intermediate value).forRoot is not a function`, and the inherited public methods become `register`/`registerAsync`. All 7 test files fail and `tsc` reports TS2339. The other working-tree edits are formatting (2 spaces, single quotes, against the tab/double-quote `biome.json`), doc comments, a type-only `unique symbol` change, and renaming "much" to "slightly".

**Build (run in scratch copies; the repo was not touched).** `pnpm build` exits 0 and emits CJS plus ESM, and `design:paramtypes` metadata is present. But the package is not usable:

1. tsdown 0.12.9 pulled in rolldown 1.0.0-rc.9 through a caret range, so it emits hashed declaration files (`index-DhKji9Jf.d.ts`). The `types` paths in package.json point to files that don't exist: publint reports 3 errors and attw finds no types in any mode. Pinning rolldown to 1.0.0-beta.29 fixes the names; tsdown 0.23 emits `.mjs/.cjs/.d.mts/.d.cts`.
2. The ESM build fails to import: `better-auth/plugins` does not export `createAuthMiddleware` in 1.5.5 or 1.7.4. The CJS build loads but crashes when hooks are registered.
3. package.json has **no `version`**, so pack and publish fail.
4. There is no typecheck step; the build succeeds despite type errors.

**Tests at HEAD.** 6 of 7 files fail, 10 pass, 2 skipped:

- Five files fail because `rxjs` is not resolvable under pnpm's strict layout.
- The hooks suite fails because `createAuthMiddleware` is undefined.

With two fixes (make rxjs resolvable, import from `better-auth/api`), **all 36 tests pass on better-auth 1.5.5 and on 1.7.4**.

**CI state.** Style and release jobs fail on biome formatting of package.json. The release job uses `NPM_CONFIG_TOKEN`, a bun convention. Previews use pkg.pr.new (npm pack, which needs a version). There are no changesets. `pnpm-workspace.yaml` has junk single-letter `allowBuilds` keys, and `lefthook.yml` is an all-comment template.

**Test harness.**

- Express only (`ExpressAdapter`, `bodyParser:false`), with Apollo GraphQL and a socket.io gateway.
- better-auth runs on its in-memory adapter; authentication is always bearer tokens, never cookies.
- The gateway needs an explicit `@UseGuards` because Nest's socket module ignores `APP_GUARD`.
- Worth keeping as behavioral specs: rest-auth (9), organization-roles (9), graphql (4), websocket (6), hooks (3), options rawBody and middleware-error tests, and module-async.
- Not covered: Fastify, cookie sessions, CORS/trustedOrigins, disableGlobalAuthGuard, AuthService, `@Session` on HTTP.

## Implications

- Use a current tsdown (0.23.x verified) or pin rolldown exactly; generate or verify the exports map against real output names (.mjs/.cjs/.d.mts/.d.cts); add publint + attw --pack to CI.
- Add an explicit typecheck step (tsc --noEmit): the tsdown build succeeds despite TS2305/TS2339 errors.
- Import createAuthMiddleware (and hook context types) from better-auth/api; better-auth/plugins does not export it in 1.5.5 or 1.7.4.
- The dual CJS+ESM requirement implies the CJS artifact relies on Node require(esm) for ESM-only better-auth; set an engines floor accordingly and watch for dual-package hazard on module-scoped Symbol DI tokens and metadata keys.
- Avoid a top-level express import and a required express peer (current src/middlewares.ts:3) if Fastify and other adapters are first-class; upstream made it lazy and optional.
- Handler mounting through consumer.forRoutes(basePath) depends on Express app.use prefix semantics and better-call baseUrl reconstruction; it is not adapter-portable.
- APP_GUARD reaches HTTP and GraphQL but not WebSocket gateways (Nest socket-module quirk); a transport extension point must handle WS guards explicitly.
- The error-payload contract ({code,message} vs Nest defaults, GraphQLError vs HttpException, WS 'UNAUTHORIZED' string) must be decided, and pinned by tests only after that decision.
- Existing tests (36) are a solid behavioral baseline once rxjs is a devDependency and the import is fixed; parametrize them over adapters like upstream tests/shared/http-adapter.ts (TEST_HTTP_ADAPTER).
- pnpm's strict node_modules requires every module a test imports (rxjs, fastify, @nestjs/platform-fastify, @types/body-parser) to be an explicit devDependency.
- Keep swc (unplugin-swc) in vitest for decorator metadata; tests rely on implicit constructor DI via design:paramtypes.
- The release pipeline needs a version field and working npm auth (upstream uses npm OIDC trusted publishing with npm >=11.5.1); pkg.pr.new also needs a valid version.
- Metadata keys are bare strings (PUBLIC/OPTIONAL/ROLES/ORG_ROLES), AUTH_MODULE_OPTIONS_KEY is exported but unused, and MODULE_OPTIONS_TOKEN is not exported: a cleanup opportunity for public tokens.
- The hook integration mutates auth.options.hooks after betterAuth() is constructed and requires hooks:{} pre-set; it works on 1.5.5 and 1.7.4 but couples to better-auth option-object identity.

## Pitfalls

- Do not use the working tree as the behavior baseline: it is broken by the setClassMethodName removal; HEAD (identical to upstream v2.4.0) is the real baseline.
- Do not attribute v2.8.0-vs-current differences to local customization; the fork has zero src/tests changes relative to v2.4.0.
- REPO/dist/ is a stale, broken build from 2026-03-17 (hashed d.ts); running pnpm build in the original repo overwrites it, so do builds in scratch copies.
- rsync --exclude dist also strips node_modules/**/dist; anchor the exclude to the root (/dist).
- The current green results depend on better-auth 1.5.5 installed via pnpm autoInstallPeers; better-auth is not a pinned devDependency.
- A tsdown build exit 0 does not mean usable output: check d.ts file names and run publint/attw.
- biome vcs.useIgnoreFile=false means local `biome check` also scans gitignored .omc/ and untracked .claude/.
- Tests only use bearer tokens; cookie-session behavior (better-auth default) is completely untested.
- options.e2e reuses a single testSetup variable and closes only the last app; module and hooks-validation tests never close apps (handle leaks).

## Open questions for user

- Was removing .setClassMethodName("forRoot") in the working tree intentional (to move to register/registerAsync naming) or accidental? It currently breaks every test.
- Which code style should the rewrite follow: biome.json (tabs, double quotes) or the recent working-tree edits (2 spaces, single quotes)?
- Should the upstream v2.4.0→v2.8.0 features (Fastify, bodyParser options, RequireActiveOrg, UserHasPermission/MemberHasPermission, @DatabaseHook decorators, generic UserSession<T>) be treated as minimum scope?
- Which error-payload contract should the library expose: current {code,message} bodies and GraphQLError, or upstream's Nest-default HttpExceptions?
- Release process: keep pkg.pr.new previews plus GitHub-Release-triggered publish? Adopt npm OIDC trusted publishing and/or changesets? What initial version?
- Must the rewrite keep API compatibility with current names (AuthModule.forRoot, deprecated Public/Optional, forRoot(auth, options) overload), given the package has never been published?
- What Node engine floor is intended (CI uses 22, mise uses 24; the CJS output depends on require(esm))?
- What should lefthook actually run? lefthook.yml is currently an all-comment template.
