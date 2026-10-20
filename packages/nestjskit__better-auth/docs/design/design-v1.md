# nestjs-slightly-better-auth: Design v1

|                  |                                                                                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status           | Design v1 (merge of drafts A, B and C). Design only, no implementation.                                                                                                                                        |
| Author           | Lead architect                                                                                                                                                                                                 |
| Date             | 2026-09-11                                                                                                                                                                                                     |
| Inputs           | `design/draft-A.md` ("better-auth-native", thinnest host binding), `design/draft-B.md` ("ports and adapters"), `design/draft-C.md` ("DX and types first"), `research/_digest.md` and the nine research reports |
| Verified against | better-auth 1.7.4 / better-call 1.4.0 source, NestJS 11.0.0 / 11.1.17 / 12.0.1 source, @nestjs/apollo 13.2.4, Fastify 5.8.2, body-parser 2.2.2 / raw-body 3.0.2, Node 22.22.0                                  |

## How to read this document

**Provenance tags.** Every design element names the draft(s) it came from: `[A]`, `[B]`, `[C]`, or `[L]` for a change the lead architect made during the merge. The decision log (section 16) records alternatives rejected and why.

**Evidence tags.**

| Tag             | Meaning                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `BA/…`          | better-auth 1.7.4 source, `scratchpad/better-auth/packages/better-auth/src/`                             |
| `CORE/…`        | `scratchpad/better-auth/packages/core/src/`                                                              |
| `R:<report> §n` | research report `scratchpad/research/<report>.md`                                                        |
| `EXP-A:<file>`  | draft A experiment, `scratchpad/tmp-draft-A/` (re-run by A on Nest 11.1.17 and 12.0.1 × Express/Fastify) |
| `EXP-B:E<n>`    | draft B experiment, `scratchpad/tmp-draft-B/` (re-run by B on the same matrix)                           |
| `EXP-C<n>`      | draft C experiment, `scratchpad/tmp-draft-C/` (re-run by C on the same matrix)                           |
| `LEAD-V<n>`     | a source fact the lead re-checked for this merge (list below)                                            |
| `LEAD-EXP-<n>`  | an experiment the lead ran for this merge, `scratchpad/tmp-lead/`                                        |
| UNVERIFIED      | derived from code reading only; must be pinned by a conformance case before 1.0                          |

**Lead verifications performed for this merge:**

| Id       | Fact                                                                                                                                                                                                                                                                                                                                                                                                              | Where                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| LEAD-V1  | Every before-hook receives the _same original_ context; a `{ context }` result is merged with `defuReplaceArrays(rest, accumulated)` (later hook wins, arrays replaced), headers are `set`; any other object short-circuits. An `APIError` thrown by an after-hook becomes the response with its headers merged. `getHooks` re-reads `options.plugins` on every dispatch; plugin hooks run after `options.hooks`. | `BA/api/dispatch.ts:44-49, 136-217, 219-262, 264-307`                                      |
| LEAD-V2  | `better-auth/api` exports `createAuthMiddleware`, `APIError`, `isAPIError`, `getIP`, `setShouldSkipSessionRefresh`, `getShouldSkipSessionRefresh`                                                                                                                                                                                                                                                                 | `BA/api/index.ts:409-427`                                                                  |
| LEAD-V3  | The stateless refresh-cache branch checks only `getShouldSkipSessionRefresh()`; `query.disableRefresh` returns early only later; `freshSessionMiddleware` rule is `now - createdAt >= freshAge*1000`, skipped when `freshAge === 0`                                                                                                                                                                               | `BA/api/routes/session.ts:199-204, 309, 597-616`                                           |
| LEAD-V4  | Plugin `init().options.databaseHooks` are collected per plugin and the user's `databaseHooks` are appended last; all other plugin options are merged with `defu(userOptions, pluginOptions)` (user wins, arrays concatenate)                                                                                                                                                                                      | `BA/context/helpers.ts:23-98`                                                              |
| LEAD-V5  | `isAPIError` accepts both `APIError` classes and `name === "APIError"`                                                                                                                                                                                                                                                                                                                                            | `CORE/utils/is-api-error.ts:4-10`                                                          |
| LEAD-V6  | Nest 11.1.17 builds the WS pipes, guards and interceptors context creators **without** application config (no global enhancers reach gateways); Nest 12.0.1 passes config to all three (global guards **and** global interceptors and pipes reach gateways)                                                                                                                                                       | `@nestjs/websockets` 11.1.17 `socket-module.js:81`; 12.0.1 `socket-module.js:87-88`        |
| LEAD-V7  | For WS messages, guards and interceptors receive the same `args` array; param factories receive a fresh array (spread) with the same elements; the handler runs inside the interceptor chain                                                                                                                                                                                                                      | `@nestjs/websockets` 11.1.17 `context/ws-context-creator.js:39-50, 95-104`                 |
| LEAD-V8  | Apollo's `autoTransformHttpErrors` rewrites `extensions.code` for every `HttpException` and maps only 400/422/401/403; any other status becomes `INTERNAL_SERVER_ERROR`. On Fastify the Apollo context receives only the request (`{ req }`), not the reply                                                                                                                                                       | `@nestjs/apollo` 13.2.4 `apollo-base.driver.js:17-22, 118-141, 161-216`                    |
| LEAD-V9  | `IntrinsicException` is exported by `@nestjs/common` 11.0.0, 11.1.17 and 12.0.1; `HttpException extends IntrinsicException`; Nest's `ExternalExceptionFilter` logs only non-intrinsic errors                                                                                                                                                                                                                      | `common/exceptions/index.d.ts:11`; `core/exceptions/external-exception-filter.js:8`        |
| LEAD-V10 | Fastify: a body without `content-type` falls through to the catch-all parser; a `parseAs: 'buffer'` parser with `bodyLimit` answers 413 (`FST_ERR_CTP_BODY_TOO_LARGE`, `connection: close`) through `reply.send`, so reply-level CORS headers survive; parser callbacks are `AsyncResource`-bound; `fastify.all()` registers `supportedMethods`                                                                   | Fastify 5.8.2 `lib/content-type-parser.js:119-153, 180-240`; `fastify.js:199-202, 336-343` |
| LEAD-V11 | raw-body 3.0.2 binds its completion callback with `AsyncResource`, so body-parser 2.2.2's `next()` keeps the caller's async context                                                                                                                                                                                                                                                                               | `raw-body/index.js:116, 317-326`; `body-parser/lib/read.js:113`                            |
| LEAD-V12 | `AbstractHttpAdapter.prototype.mapException` exists in `@nestjs/core` 12.0.1 and not in 11.1.17                                                                                                                                                                                                                                                                                                                   | `core/adapters/http-adapter.js:93`                                                         |
| LEAD-V13 | `GATEWAY_METADATA` (`'websockets:is_gateway'`) is not re-exported from the `@nestjs/websockets` root in 11.1.17 or 12.0.1                                                                                                                                                                                                                                                                                         | `websockets/constants.js:8`, `index.d.ts`                                                  |
| LEAD-V14 | better-auth's own cookie integrations warn when a later plugin declares `hooks.after`; `nextCookies` suppresses refresh only on `/get-session`                                                                                                                                                                                                                                                                    | `BA/integrations/cookie-plugin-guard.ts:10-32`; `BA/integrations/next-js.ts:47-94`         |
| LEAD-V15 | `role()` and `createAccessControl()` are exported from `better-auth/plugins/access`; `testUtils()` (from `better-auth/plugins`) exposes `login` and `getAuthHeaders`                                                                                                                                                                                                                                              | `BA/plugins/access/access.ts:106,158`; `BA/plugins/test-utils/index.ts:74-93`              |

**LEAD-EXP-1** (`tmp-lead/exp-gql-denial.cjs`, Nest 11.1.17, @nestjs/apollo 13.2.4, Express, Node 22.22.0). Result for a guard-thrown denial:

| Thrown object                                                 | 401 code          | 403 code    | 429 code                    | Logged at ERROR by Nest |
| ------------------------------------------------------------- | ----------------- | ----------- | --------------------------- | ----------------------- |
| `HttpException` subclass with `extensions` (draft B)          | `UNAUTHENTICATED` | `FORBIDDEN` | **`INTERNAL_SERVER_ERROR`** | no                      |
| `IntrinsicException` subclass with `extensions` (this design) | `UNAUTHENTICATED` | `FORBIDDEN` | `RATE_LIMITED`              | no                      |
| plain `GraphQLError` (drafts A, C)                            | `UNAUTHENTICATED` | `FORBIDDEN` | `RATE_LIMITED`              | **yes, every denial**   |

---

## 0. Summary and principles

### 0.1 Summary

better-auth defines its own integration contract. Its handler is a Web-standard `handler(Request): Promise<Response>`. Framework bridging is done by plugins (`nextCookies`, `sveltekitCookies`, `tanstackStartCookies`, `expo`), server code calls `auth.api.*`, and authorization runs on access control. This design binds NestJS to exactly that contract and reimplements nothing better-auth already does. It has three parts:

1. **The `nestjs()` better-auth plugin** `[A][B][C]`. The user adds it last to `betterAuth({ plugins })`, following the `nextCookies()` precedent, and a boot check makes it mandatory. It is the only code that runs inside better-auth's pipeline, and it does four things:
   - bridges Nest hook providers and database hooks, preserving better-auth's return-value semantics;
   - forwards `Set-Cookie` from direct `auth.api.*` calls into the current response;
   - suppresses session refresh on any endpoint dispatched from a cookie-less scope, which also covers the stateless refresh-cache branch;
   - declares a client-IP header through `init()`.

   It imports only `better-auth/api` and `defu`, never `@nestjs/*`, so the better-auth CLI can still load `auth.ts`.

2. **A small kernel** `[B][C]`: the module, guard, scope interceptor, principal resolver, authorization evaluator, boot validator and error model. It depends only on its own extension contracts and on better-auth's public surface. It never branches on a platform, transport, principal or policy name.
3. **Extension units** `[A][B][C]` for the five extension points:
   - HTTP platforms: Express and Fastify ship; third parties plug in their own;
   - transports: HTTP, GraphQL (Apollo and Mercurius), WebSockets (socket.io and ws), and RPC;
   - principal sources: the better-auth session, API keys, or a third party's;
   - authorization policies: thin adapters over better-auth's permission APIs;
   - hook providers.

   Built-in units register through exactly the same contract a third party uses. Their behavior is proven identical by runner-agnostic conformance kits shipped in `./testing/conformance`.

**Auth routes.** Every request under better-auth's own mount path, for every method, goes to `auth.handler`. The platform produces a Web `Request` with the exact body bytes, a trust-proxy-aware origin and client IP, and HTTP/2-safe headers. It writes the `Response` back verbatim: status, every `Set-Cookie`, redirects and streams. The Express binding uses two phases: bounded raw capture at `HttpAdapterHost.init$`, then dispatch at `onModuleInit`, after the user's CORS and middleware. The Fastify binding is an encapsulated plugin with a `parseAs: 'buffer'` catch-all parser and a body limit, written back through `reply`.

**App routes and messages.** A single transport-neutral guard resolves the principal lazily, at most once per request, operation or message. It calls `auth.api.getSession({ headers, returnHeaders: true })` and forwards only `set-cookie`, and only where the transport can carry cookies. It then authorizes through requirement expressions whose policies travel by reference in route metadata.

**The common case** needs three lines plus one platform import:

```ts
// auth.ts: static and CLI-friendly; imports no Nest code
export const auth = betterAuth({ database, emailAndPassword: { enabled: true },
  plugins: [admin(), organization(), nestjs()] });                    // nestjs() last
declare module 'nestjs-slightly-better-auth' { interface Register { auth: typeof auth } }

// app.module.ts
@Module({ imports: [BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] })] })
export class AppModule {}

// any controller: no generics, typed from `typeof auth`
@Get('me') me(@Session() s: AuthSession) { return s.user.role; }
@RequireOrgPermission({ project: ['delete'] }, { organization: fromParam('orgId') })   // typo = compile error
@Delete(':orgId/projects/:id') remove() {}
@Public() @Get('health') health() {}                                                   // zero auth I/O
```

The user never sets `bodyParser: false`, never adds `hooks: {}` placeholders, writes no generics at use sites, and gets no CORS side effects.

### 0.2 How the design embodies better-auth's philosophy (R1)

| better-auth principle (R:ba-core §1.1)                                             | How this design honors it                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1/P2: framework-agnostic; the Web `Request → Response` handler is the single seam | Auth routes are raw platform routes that call `auth.handler` with a `Request` we build (§6). No auth endpoint is re-declared as a Nest controller. Routing, 404/415, origin/CSRF, rate limiting, `disabledPaths` and plugin `onRequest`/`onResponse` all stay inside `auth.handler`.                                                                                                                 |
| P3/P4: plugin-first; customize inside the pipeline with hooks                      | Everything that must run _during_ a better-auth call enters through the `nestjs()` plugin, added at construction (§10). `auth.options` is never mutated (S1).                                                                                                                                                                                                                                        |
| P5: type safety through inference                                                  | Types flow from `typeof auth` through a `Register` augmentation, which is better-auth's own `BetterAuthPluginRegistry` idiom. Permission arguments, hook contexts and endpoint paths are inferred (§11). Core accepts a structural `AuthLike`, never bare `Auth`.                                                                                                                                    |
| P6: server code calls `auth.api`                                                   | The session principal comes from `auth.api.getSession` (§7). Policies call `userHasPermission`, `hasPermission`, `getActiveMemberRole` and `role().authorize()` (§8). Nothing parses cookies or queries the database itself.                                                                                                                                                                         |
| P8: secure by default                                                              | The global guard is on by default. `@Public()` performs zero auth I/O. `Origin`, `Referer`, `Sec-Fetch-*`, `Cookie`, `Authorization` and `Content-Type` are never rewritten. The client IP is trust-proxy-aware and anti-spoofed. Auth-route bodies are bounded. Bad credentials are never downgraded to anonymous. Infrastructure failures are 5xx. Misconfiguration fails at compile time or boot. |
| P10: framework cookie bridging is a plugin                                         | The `nestjs()` after-hook, gated on `ctx._flag !== 'router'`, forwards `Set-Cookie` from direct calls. This is the `nextCookies` pattern (`BA/integrations/next-js.ts:47-144`, LEAD-V14).                                                                                                                                                                                                            |
| P11: ESM-first                                                                     | ESM is the canonical build. The exports map is `module-sync`-first, so on the supported Node range a single ESM copy serves both `import` and `require` (§12).                                                                                                                                                                                                                                       |
| "Do not reimplement" (R:ba-core §9)                                                | Not reimplemented: routing, CSRF, rate limiting, body parsing of auth routes, cookie names, permission and role evaluation, trusted-origin matching, IP extraction, error envelopes. The integration supplies only what better-auth leaves to the host: the mount, a faithful `Request`, a client IP, cookie write-back, and refresh control where cookies cannot be written.                        |

### 0.3 SOLID mapping

| Letter | Concrete design elements                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S**  | Each unit has one reason to change (§3.1):<br>• `MountCoordinator`: lifecycle timing.<br>• `AuthExchange`: `Request` construction, header hygiene, `auth.handler`, error conversion.<br>• `RequestScope`: the per-request ALS and state.<br>• `PrincipalResolver`: the source chain and memoization.<br>• `AuthorizationEvaluator`: requirement composition.<br>• `HookBinder`: discovery into the plugin registry.<br>• `BootValidator`: fail-fast checks.<br>• `BetterAuthGuard`: orchestration only; it holds no policy logic, no transport branch and no better-auth call of its own.<br>Platforms only translate I/O; transports only extract context and map errors. |
| **O**  | Five extension points, each added by a new class, value or package, never by editing core (§4):<br>• `HttpPlatform`, selected by its own `supports()`;<br>• `AuthTransport`, selected by its own `handles()`;<br>• `PrincipalSource`, an ordered chain;<br>• `AuthorizationPolicy`, carried by reference inside requirement metadata, so there is no registry to edit;<br>• hook methods, discovered.<br>Core contains no `switch`/`if` on platform, transport, principal-kind or policy names. An architecture test enforces this (§14.7).                                                                                                                                |
| **L**  | Every contract lists its invariants: exact bytes, every `Set-Cookie`, a stable memo key per logical request, "denials are values, exceptions are infrastructure", and more. Runner-agnostic conformance kits check them, and the built-in units and any third-party unit must pass the same kits (§14.1). Principals form a discriminated union, so policies narrow instead of casting.                                                                                                                                                                                                                                                                                    |
| **I**  | Contracts are small, and optional members add progressive disclosure:<br>• `HttpPlatform` separates lifecycle (`prepare`/`mount`) from per-request access (`HttpRequestAccessor`), so GraphQL-over-HTTP uses the accessor without mounting anything.<br>• `CookieSink` has one method.<br>• `AuthorizationPolicy` needs only `id` and `evaluate`.<br>• `PrincipalSource` needs only `id` and `resolve`.<br>• Policies see an `AuthorizationContext`, never an `ExecutionContext` unless they ask for it.                                                                                                                                                                   |
| **D**  | Core depends on `AuthLike`, its own contracts and `Symbol.for` tokens. It reaches the plugin through a versioned protocol object found with `$context.getPlugin(id)`, never through an import. The principal resolver sits behind a token (`PRINCIPAL_RESOLVER`) so tests can substitute it. Platform and transport units depend on the contracts and their own peer framework, never on each other.                                                                                                                                                                                                                                                                       |

### 0.4 What this design optimizes for and what it costs

- **Optimizes for:**
  - zero reimplementation of better-auth;
  - identical behavior across platforms, proven by kits rather than asserted;
  - third-party extension without forking;
  - fail-fast configuration;
  - zero generics in the common case.
- **Costs** (accepted in §16):
  - one line in `auth.ts` (`nestjs()`);
  - one platform import in `forRoot` (`platforms: [expressPlatform()]`);
  - a boot-time metadata scan;
  - a small hook-dispatch mirror kept in parity with `BA/api/dispatch.ts` by a property test.

---

## 1. Requirements traceability

| Id  | Requirement / decision / default                                                                                                                                            | Satisfied in                                                                                                                                                                               | Notes                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| R1  | Honor better-auth's philosophy; do not reimplement                                                                                                                          | §0.2, §6 (handler-only auth routes), §7.3 (`getSession` only), §8.3 (delegation to better-auth permission APIs), §10 (plugin-first hooks), §11 (inference); ADR-01, ADR-02, ADR-07, ADR-19 |                                                                                        |
| R2  | Pluggable HTTP platforms; Express and Fastify first-class; third parties attach without editing us                                                                          | §4.1 (`HttpPlatform` contract, invariants H1–H11, worked Hono example), §6.4–§6.6 (Express, Fastify), §14.1 (conformance kit); ADR-03, ADR-04, ADR-05                                      |                                                                                        |
| R3  | Dual CJS + ESM                                                                                                                                                              | §12 (tsdown dual build, `module-sync`-first exports, hazard strategy, tarball smoke tests); ADR-20                                                                                         |                                                                                        |
| R4  | SOLID and OCP; no switch/if on platform, transport or policy names                                                                                                          | §0.3, §3 (units, dependency rules), §4 (five extension points), §14.7 (architecture fitness tests); ADR-05, ADR-12                                                                         | The only Nest-major probe (`mapException`) lives in the WS extension unit, not in core |
| R5  | pnpm, tsdown 0.23.x, vitest, biome                                                                                                                                          | §12.1 (tsdown), §12.6 (biome rules), §12.8 (toolchain), §14 (vitest)                                                                                                                       |                                                                                        |
| D1  | `@nestjs/* ^11 \|\| ^12`; Node `>=22.12`; CJS via require(esm)                                                                                                              | §2.4 (peers), §12.3–§12.4 (engines, exports); §6.1 and §9.4 (Nest 11/12 differences); §14.2 (matrix)                                                                                       |                                                                                        |
| D2  | Built-in HTTP (Express, Fastify), GraphQL (Apollo, Mercurius), WS (socket.io, ws), RPC; each an extension unit                                                              | §2.1 (one subpath per unit), §6 and §9 (behavior per unit), §4 (same contracts third parties use)                                                                                          |                                                                                        |
| D3  | Clean break plus migration guide                                                                                                                                            | §2 (new names), §15 (migration guide); ADR-24                                                                                                                                              |                                                                                        |
| D4  | better-auth `>=1.7.0 <2`                                                                                                                                                    | §2.4, §12.4, §14.2 (floor and latest in the matrix); ADR-21                                                                                                                                |                                                                                        |
| S1  | Never mutate `auth.options`; hooks via a user-added plugin preserving return semantics                                                                                      | §10 (fixed dispatcher entries plus a late-bound registry; parity test), §5.4 (B03 plugin check); ADR-07                                                                                    |                                                                                        |
| S2  | `getSession` with `returnHeaders: true`, forward only `set-cookie` on cookie-capable transports; deliberate suppression elsewhere, incl. the stateless refresh-cache branch | §7.3–§7.5 (session source, per-transport capability table, suppression mechanism), §10.2 (plugin entries 1 and 4); ADR-02, ADR-06, ADR-09                                                  |                                                                                        |
| S3  | Mount path from `new URL((await auth.$context).baseURL).pathname` precedence; all methods; outside the global prefix                                                        | §6.2 (path resolution), §6.9 (prefix and versioning stance); ADR-14                                                                                                                        |                                                                                        |
| S4  | Untouched body on auth routes; Nest-native parsing incl. `rawBody` on app routes; body limit on auth routes                                                                 | §6.4 (body strategy, Express two-phase, Fastify encapsulated parser, degraded tier); ADR-03, ADR-04                                                                                        |                                                                                        |
| S5  | Copy-safe identities; explicit `@Inject`; explicit dual-package-hazard strategy                                                                                             | §2.3 (tokens and keys), §12.5 (hazard strategy), §12.6 (decorator metadata); ADR-20                                                                                                        |                                                                                        |
| S6  | `isAPIError`, never `instanceof`; infrastructure → 5xx                                                                                                                      | §7.7, §8.1, §13 (taxonomy and normalization); ADR-16                                                                                                                                       |                                                                                        |
| S7  | Lazy principal resolution, at most once per request                                                                                                                         | §7.2 (memo keyed by transport request key; promise stored before settling; GraphQL root fields share); ADR-10                                                                              |                                                                                        |

---

## 2. Package layout and public API

One npm package, `nestjs-slightly-better-auth`. Every framework integration and every better-auth plugin integration lives in its own subpath. Optional peers are therefore imported statically, and only by the subpath that needs them. There is no `loadPackage`, no `createRequire` of peers and no top-level await (R:packaging §6; R:nest-di §8).

### 2.1 Entry points

| Subpath                 | Units                                                                                                                                                                                                               | Runtime imports                                             | Peers (§2.4)                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------- |
| `.`                     | Kernel: `BetterAuthModule`, guard, scope interceptor, service, decorators, tokens, contracts (SPI types), `httpTransport()`, `sessionPrincipal()`, `freshSession()`, errors, type helpers, `betterAuthCorsOrigin()` | `@nestjs/common`, `@nestjs/core`, `better-auth/api`, `rxjs` | required only                                                  |
| `./plugin`              | `nestjs()` better-auth plugin                                                                                                                                                                                       | `better-auth/api`, `defu`                                   | `better-auth` only; **never** `@nestjs/*` (CI-enforced, §12.7) |
| `./platform`            | Helpers for Node-based third-party platforms (header conversion, bounded body reader, Node response writer)                                                                                                         | Node built-ins                                              | none                                                           |
| `./express`             | `expressPlatform()`, `ExpressPlatform`                                                                                                                                                                              | none (structural types; drives the Nest adapter)            | none                                                           |
| `./fastify`             | `fastifyPlatform()`, `FastifyPlatform`                                                                                                                                                                              | none (structural types)                                     | none                                                           |
| `./graphql`             | `apolloTransport()`, `mercuriusTransport()`, `mercuriusSubscriptionContext()`, `BetterAuthGraphqlDenial`                                                                                                            | `@nestjs/graphql`                                           | `@nestjs/graphql`, `graphql`                                   |
| `./websockets`          | `socketIoTransport()`, `wsTransport()`, `withUpgradeRequest()`, `recordUpgradeRequest()`, `WsConnectionAuth`                                                                                                        | `@nestjs/websockets`                                        | `@nestjs/websockets`                                           |
| `./microservices`       | `rpcTransport()`, RPC credential carriers                                                                                                                                                                           | `@nestjs/microservices`                                     | `@nestjs/microservices`                                        |
| `./admin`               | `permission()`, `RequirePermission()` (admin plugin)                                                                                                                                                                | core only                                                   | admin plugin enabled (boot-checked)                            |
| `./organization`        | `orgPermission()`, `RequireOrgPermission()`, `orgMember()`, `RequireOrgMember()`, organization refs, `ActiveOrganizationId()`, `ActiveMemberRole()`                                                                 | core only                                                   | organization plugin enabled (boot-checked)                     |
| `./api-key`             | `apiKeyPrincipal()`, `apiKeyPermission()`, `RequireApiKeyPermission()`                                                                                                                                              | `better-auth/plugins/access`                                | `@better-auth/api-key` plugin enabled (boot-checked)           |
| `./testing`             | Consumer test helpers                                                                                                                                                                                               | `@nestjs/testing` (types), `better-auth`                    | `@nestjs/testing`                                              |
| `./testing/conformance` | Runner-agnostic conformance kits for platforms, transports, principal sources, policies                                                                                                                             | `@nestjs/core`, `@nestjs/testing`, `node:assert`            | `@nestjs/testing`                                              |

Express and Fastify are separate subpaths even though they import no peer (ADR-05). They are extension units, and registering them explicitly is the same act a third party performs. Keeping them out of the root also lets the architecture test prove that core never depends on them.

### 2.2 Exported symbols with signatures

Types derived from the user's instance are always computed from `typeof auth`, never re-declared (§11). Signatures are normative; bodies are illustrative.

#### 2.2.1 `nestjs-slightly-better-auth`: module and options

```ts
import type {
  DynamicModule,
  InjectionToken,
  ModuleMetadata,
  OptionalFactoryDependency,
  Provider,
  Type,
} from "@nestjs/common";

export declare class BetterAuthModule {
  /** Default instance. When a Register augmentation exists, `auth` must be the registered type. */
  static forRoot<A extends AuthLike = RegisteredAuth>(
    options: BetterAuthModuleOptions<A> & {
      name?: "default";
    } & DefaultInstanceCheck<A>,
  ): DynamicModule;
  /** Named instance (§5.5): any better-auth instance. */
  static forRoot<A extends AuthLike>(
    options: BetterAuthModuleOptions<A> & { name: string },
  ): DynamicModule;
  static forRootAsync<A extends AuthLike = RegisteredAuth>(
    options: BetterAuthModuleAsyncOptions<A>,
  ): DynamicModule;
}

/** Module-shape options: they decide which providers exist, so they are fixed at definition time. [A][B][C] */
export interface BetterAuthStaticOptions {
  /** Instance name. Default 'default'. Named instances get their own tokens and mount (§5.5). */
  name?: string;
  /** Register the module as global. Default true. */
  isGlobal?: boolean;
  /**
   * Register BetterAuthGuard as APP_GUARD and BetterAuthScopeInterceptor as APP_INTERCEPTOR (both via useExisting,
   * so tests can overrideProvider them). Default true for the default instance, false for named instances.
   */
  globalGuard?: boolean;
  /** HTTP platforms. Exactly one must support the running HTTP adapter when the app has one. Default []. */
  platforms?: readonly ExtensionRef<HttpPlatform>[];
  /** Transports, consulted in order BEFORE the built-in httpTransport(). Default []. */
  transports?: readonly ExtensionRef<AuthTransport>[];
  /** Principal sources, tried in order BEFORE the built-in session source. Default []. */
  principals?: readonly ExtensionRef<PrincipalSource>[];
}

/** Runtime options: read by providers after DI resolution, so they may come from useFactory. */
export type BetterAuthRuntimeOptions<A extends AuthLike = RegisteredAuth> = {
  /** The object returned by betterAuth(). Never wrapped, cloned or mutated. */
  auth: A;
  /** Access for handlers without an access decorator. Default 'authenticated'. [C] */
  defaultAccess?: "authenticated" | "public";
  /** HTTP mount options for this instance. */
  http?: HttpMountOptions;
  /** App-level override of transport error objects (§13.4). */
  errors?: ErrorMappingOptions;
  /** Log the one-line boot summary. Default true. */
  logSummary?: boolean;
} & SessionOption<A>;

/** `session` is REQUIRED (with userId) when the session shape lacks user.id, i.e. customSession (§11.5). [C] */
export type SessionOption<A extends AuthLike> =
  HasUserId<SessionOf<A>> extends true
    ? { session?: SessionPrincipalOptions<SessionOf<A>> | false }
    : {
        session:
          | (SessionPrincipalOptions<SessionOf<A>> & {
              userId: (s: SessionOf<A>) => string | null;
            })
          | false;
      };

export interface SessionPrincipalOptions<S> {
  /** Map a (possibly customSession-shaped) session to its user id. Default s => s.user?.id ?? null. */
  userId?: (session: S) => string | null;
  /** Default freshness of identity reads; per route: @RequireAuth({ authoritative: true }). Default 'default'. */
  freshness?: "default" | "authoritative";
}

export interface HttpMountOptions {
  /** Mount better-auth routes on the platform. Default true. false = guard-only service. */
  mount?: boolean;
  /** Maximum auth-route request body. Default 1_048_576 (1 MiB). 413 above. */
  bodyLimit?: number | `${number}${"b" | "kb" | "mb"}`;
  /** Wrap every auth-route exchange (ORM request context, tracing). Outermost first. [A][C] */
  around?: readonly AuthHandlerInterceptor[];
  /** Allow a mount path of '/'. Default false (a root mount captures every unmatched route). [A] */
  allowRootMount?: boolean;
}

export type AuthHandlerInterceptor = (
  call: {
    readonly request: Request;
    readonly platformRequest: unknown;
    readonly instance: string;
  },
  next: (request?: Request) => Promise<Response>,
) => Promise<Response>;

export type BetterAuthModuleOptions<A extends AuthLike> =
  BetterAuthStaticOptions & BetterAuthRuntimeOptions<A>;

export interface BetterAuthModuleAsyncOptions<
  A extends AuthLike,
> extends BetterAuthStaticOptions {
  imports?: ModuleMetadata["imports"];
  inject?: readonly (InjectionToken | OptionalFactoryDependency)[];
  useFactory: (
    ...args: any[]
  ) => BetterAuthFactoryResult<A> | Promise<BetterAuthFactoryResult<A>>;
}

/** A static key returned from useFactory is a compile error with a readable message (EXP-C9). [C] */
export type BetterAuthFactoryResult<A extends AuthLike> =
  BetterAuthRuntimeOptions<A> & {
    [
      K in keyof BetterAuthStaticOptions
    ]?: StaticOptionMustBePassedToForRootAsync<K>;
  };
export interface StaticOptionMustBePassedToForRootAsync<K extends string> {
  readonly __error: `'${K}' is a static option: pass it to forRootAsync() next to useFactory, not in its result`;
}
/** Rejects a different instance than the registered one for the default instance (EXP-C2). [C] */
export type DefaultInstanceCheck<A> = IsRegistered extends true
  ? A extends RegisteredAuth
    ? unknown
    : { auth: RegisteredAuth }
  : unknown;

// ── Extension registration (§4) [A][B] ────────────────────────────────────
/** A class (DI-constructed), a ready instance, or a definition that brings its own providers. */
export type ExtensionRef<T> = Type<T> | T | ExtensionDefinition<T>;
export interface ExtensionDefinition<T> {
  readonly [EXTENSION_DEFINITION]: true; // Symbol.for brand, set by defineExtension
  readonly use:
    | { readonly useClass: Type<T> }
    | {
        readonly useFactory: (...deps: any[]) => T | Promise<T>;
        readonly inject?: readonly InjectionToken[];
      }
    | { readonly useExisting: InjectionToken<T> };
  readonly providers?: readonly Provider[]; // e.g. the extension's own options provider
  readonly imports?: ModuleMetadata["imports"];
}
export declare const EXTENSION_DEFINITION: unique symbol; // Symbol.for('nestjs-slightly-better-auth:extension')
export declare function defineExtension<T>(
  definition: Omit<ExtensionDefinition<T>, typeof EXTENSION_DEFINITION>,
): ExtensionDefinition<T>;
```

#### 2.2.2 Enhancers, service, resolver token

```ts
/** Transport-neutral authentication + authorization (§7, §8). Singleton; template-method seams are protected. */
export declare class BetterAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): Promise<boolean>;
  /** Override to customize the compiled plan (e.g. a company-wide default requirement). */
  protected planFor(context: ExecutionContext): RoutePlan;
}
export interface RoutePlan {
  readonly instance: string;
  readonly access: "public" | "optional" | "required";
  readonly requirements: readonly RequirementExpr[];
  readonly freshness: "default" | "authoritative";
  readonly readsSession: boolean; // @Session()/@CurrentUser() present on the handler
  readonly site: string; // 'ProjectsController.remove' for messages
}

/** Opens the per-invocation scope used by the cookie bridge, refresh suppression, param decorators and the service. */
export declare class BetterAuthScopeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
}

/** Applies BetterAuthGuard + BetterAuthScopeInterceptor explicitly (Nest 11 gateways, hybrid RPC, globalGuard:false). */
export declare function UseBetterAuth(): ClassDecorator & MethodDecorator;

export declare class BetterAuthService<A extends AuthLike = RegisteredAuth> {
  readonly name: string;
  /** The better-auth instance, unchanged and fully typed. */
  readonly instance: A;
  /** instance.api. Inside a request scope, direct calls get Set-Cookie forwarded / refresh suppressed (§7.5). */
  readonly api: A["api"];
  /** Memoized await of instance.$context (resolves immediately after boot). */
  context(): Promise<Awaited<A["$context"]>>;
  /** Mount information after bootstrap; undefined when not mounted. */
  mount():
    | {
        readonly basePath: string;
        readonly bodyLimit: number;
        readonly platform: string;
      }
    | undefined;
  /** Principal of the current scope, resolved lazily through the shared memo. null outside any scope. */
  getPrincipal(): Promise<AuthPrincipal | null>;
  /** Session of the current scope, or null (also null for non-session principals). */
  getSession(): Promise<SessionOf<A> | null>;
  /** Web Headers for a direct auth.api call from a platform request: pseudo-headers dropped, client-IP header set. [A] */
  headersFrom(platformRequest: unknown): Headers;
  /** Run fn in a cookie-less scope: every auth.api call inside has session refresh suppressed (§7.4). [C] */
  withoutCookies<T>(fn: () => Promise<T>): Promise<T>;
  /** Run fn outside the current scope: no Set-Cookie forwarding, no suppression (plain better-auth). [C] */
  runOutsideScope<T>(fn: () => Promise<T>): Promise<T>;
}

/** The resolver port the guard, decorators and service use. Default: ChainPrincipalResolver. [B] */
export interface PrincipalResolver {
  resolve(
    call: TransportCall,
    auth: AuthHandle,
    freshness: "default" | "authoritative",
  ): Promise<PrincipalResult>;
  /** Settled result for (key, instance, freshness) if the guard already resolved it; never performs I/O.
   *  Without `freshness`, returns the authoritative entry if present, else the default one. */
  peek(
    key: object,
    instance: string,
    freshness?: "default" | "authoritative",
  ): PrincipalResult | undefined;
}
```

#### 2.2.3 Decorators

```ts
// Access (class or method; method overrides class; §7.6) [A][B][C]
export declare function Public(): ClassDecorator & MethodDecorator; // zero auth I/O
export declare function OptionalAuth(): ClassDecorator & MethodDecorator; // resolve if present; anonymous allowed
export declare function RequireAuth(options?: {
  authoritative?: boolean;
}): ClassDecorator & MethodDecorator;
export declare function UseAuthInstance(
  name: string,
): ClassDecorator & MethodDecorator; // named instance (§5.5)

// Authorization (§8) [B][C]
export declare function Require(
  ...requirements: readonly RequirementExpr[]
): ClassDecorator & MethodDecorator; // AND
export declare function anyOf(
  ...requirements: readonly RequirementExpr[]
): RequirementExpr;
export declare function allOf(
  ...requirements: readonly RequirementExpr[]
): RequirementExpr;
export declare function requirement<P>(
  policy: PolicyRef<P>,
  params: P,
  label?: string,
): Requirement<P>;
export declare function freshSession(options?: {
  maxAgeSeconds?: number;
}): Requirement<{ maxAgeSeconds?: number }>;
export declare function RequireFreshSession(options?: {
  maxAgeSeconds?: number;
}): ClassDecorator & MethodDecorator;

// Parameters (synchronous; all transports; §7.8) [A][C]
export declare function Session(options?: {
  instance?: string;
}): ParameterDecorator; // type as AuthSession
export declare function CurrentUser(options?: {
  instance?: string;
}): ParameterDecorator; // type as AuthUser
export declare function CurrentPrincipal(options?: {
  instance?: string;
}): ParameterDecorator; // AuthPrincipal | null

// Hooks (§10) [C]
export declare function BeforeAuth<
  const P extends EndpointPath | (string & {}),
>(
  match?: P | readonly P[] | HookPredicate,
  options?: HookOptions,
): HookMethodDecorator<P>;
export declare function AfterAuth<const P extends EndpointPath | (string & {})>(
  match?: P | readonly P[] | HookPredicate,
  options?: HookOptions,
): HookMethodDecorator<P>;
export declare function BeforeDatabase<E extends DatabaseHookTarget>(
  target: E,
  options?: DbHookOptions,
): MethodDecorator;
export declare function AfterDatabase<E extends DatabaseHookTarget>(
  target: E,
  options?: DbHookOptions,
): MethodDecorator;
export interface HookOptions {
  /** 'http' = requests routed by auth.handler; 'server' = direct auth.api calls. Default 'all'. */
  calls?: "all" | "http" | "server";
  /** Skip calls this library makes (guard getSession, policy checks). Default false (better-auth semantics). */
  skipInternal?: boolean;
  /** Ascending order among Nest hooks; ties keep discovery order. Default 0. */
  order?: number;
  /** Named instance the hook binds to. Default 'default'. */
  instance?: string;
}
export interface DbHookOptions {
  order?: number;
  instance?: string;
}
export type HookPredicate = (ctx: AuthHookContext) => boolean;
export type HookMethodDecorator<P extends string> = <T>(
  target: object,
  key: string | symbol,
  descriptor: TypedPropertyDescriptor<(ctx: AuthHookContext<P>) => T>,
) => void;
export type DatabaseHookTarget =
  `${"user" | "session" | "account" | "verification"}.${"create" | "update" | "delete"}`;

// Injection helpers (S5)
export declare function InjectAuth(
  name?: string,
): ParameterDecorator & PropertyDecorator;
export declare function InjectBetterAuthService(
  name?: string,
): ParameterDecorator & PropertyDecorator;
```

#### 2.2.4 Built-in extension units exported from the root

These implement public contracts. Only the composition root (`src/module/**`) references them; core never does (§3.2).

```ts
/** Always registered last in the transport list; user transports serving 'http' contexts take precedence. */
export declare function httpTransport(): ExtensionRef<AuthTransport>;
/** The built-in better-auth session source (§7.3); included last unless `session: false`. */
export declare function sessionPrincipal<S = AuthSession>(
  options?: SessionPrincipalOptions<S>,
): PrincipalSource<SessionPrincipal>;
/** CORS origin callback backed by better-auth's own isTrustedOrigin (static trusted origins; §6.9). [A][B][C] */
export declare function betterAuthCorsOrigin(
  auth: AuthLike,
): (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void;
export declare const DEFAULT_CLIENT_IP_HEADER: "x-nsba-client-ip";
```

#### 2.2.5 Contracts and helpers (definitions in §4)

```ts
export type {
  HttpPlatform,
  PlatformPrepareContext,
  PlatformMountContext,
  AuthRouteBinding,
  InboundAuthRequest,
  HttpRequestAccessor,
  CookieSink,
  AuthTransport,
  TransportCall,
  TransportKit,
  TransportValidationContext,
  PrincipalSource,
  PrincipalRequest,
  PrincipalResult,
  AuthorizationPolicy,
  PolicyRef,
  Requirement,
  RequirementExpr,
  AuthorizationDecision,
  AuthorizationContext,
  PolicyBootContext,
  AuthHandle,
  AuthContextView,
  ScopeInit,
};
export declare function defineHttpPlatform<P extends HttpPlatform>(
  platform: P,
): P;
export declare function defineTransport<T extends AuthTransport>(
  transport: T,
): T;
export declare function definePrincipalSource<P extends AuthPrincipalBase>(
  source: PrincipalSource<P>,
): PrincipalSource<P>;
export declare function definePolicy<
  P,
  K extends PrincipalKind = PrincipalKind,
>(
  policy: AuthorizationPolicy<P, PrincipalOfKind<K>>,
): (params: P, label?: string) => Requirement<P>;
export declare function authenticated<P extends AuthPrincipalBase>(
  principal: P,
): PrincipalResult<P>;
export declare function absent(): PrincipalResult<never>;
export declare function rejected(failure: AuthFailure): PrincipalResult<never>;
export declare function allow(): AuthorizationDecision;
export declare function deny(input: {
  reason: string;
  status?: 401 | 403;
  message?: string;
  challenge?: string;
}): AuthorizationDecision;
```

#### 2.2.6 Errors (§13)

```ts
export type AuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "RATE_LIMITED";
/** Transport-neutral denial value. Only transports turn it into something throwable. [B][C] */
export interface AuthFailure {
  readonly status: 401 | 403 | 429;
  readonly code: AuthErrorCode;
  readonly reason?: string; // better-auth body.code or a policy/library reason
  readonly message: string;
  readonly challenge?: string; // WWW-Authenticate value
  readonly headers?: Headers; // e.g. Retry-After; set-cookie cleanup is forwarded separately
}
export declare const AuthFailures: {
  unauthenticated(message?: string): AuthFailure; // 401 UNAUTHENTICATED
  rejected(input: {
    status: 401 | 403 | 429;
    reason?: string;
    message?: string;
    challenge?: string;
  }): AuthFailure;
  forbidden(reason: string, message?: string): AuthFailure; // 403 FORBIDDEN
  fromAPIError(error: unknown): AuthFailure | null; // 401/403/429 APIError → failure; else null
};
export declare function isAuthFailure(value: unknown): value is AuthFailure; // Symbol.for brand
/** Thrown at boot (aggregated) and at request time for misconfiguration only (surfaces as 500). */
export declare class BetterAuthConfigurationError extends Error {
  constructor(code: string, message: string, hint?: string);
  readonly code: string;
  readonly hint?: string;
  readonly issues?: readonly BetterAuthConfigurationError[]; // set on the aggregated boot error
}
/** Wraps an infrastructure fault (DB down, APIError >= 500, unknown error). Never 401/403. Not intrinsic: Nest logs it.
 *  Generic client-facing message ("Authentication service unavailable"); the cause is logged, never exposed. */
export declare class BetterAuthInfrastructureError extends Error {
  constructor(cause: unknown);
  readonly cause: unknown;
  readonly extensions: {
    readonly code: "INTERNAL_SERVER_ERROR";
    readonly reason: "AUTH_UNAVAILABLE";
  };
}
export type {
  AuthErrorBody,
  AuthGraphqlExtensions,
  AuthTransportErrorPayload,
  ErrorMappingOptions,
} from "./errors";
```

#### 2.2.7 Types (§11)

```ts
export type {
  Register,
  RegisteredAuth,
  RegisteredInstances,
  IsRegistered,
  AuthOf,
  AuthLike,
  SessionOf,
  UserOf,
  AuthSession,
  AuthUser,
  AuthPrincipal,
  AuthPrincipalBase,
  PrincipalKinds,
  PrincipalKind,
  PrincipalOfKind,
  SessionPrincipal,
  EndpointPath,
  AuthHookContext,
  AuthAfterHookContext,
  DatabaseHookData,
  WithActiveOrganization,
};
```

#### 2.2.8 Tokens (§2.3)

```ts
export declare function getAuthToken(
  kind: "instance" | "options" | "service" | "handle",
  name?: string,
): symbol;
export declare const BETTER_AUTH_INSTANCE: unique symbol; // = getAuthToken('instance')
export declare const BETTER_AUTH_OPTIONS: unique symbol; // = getAuthToken('options')
export declare const BETTER_AUTH_SERVICE: unique symbol; // = getAuthToken('service'); useExisting BetterAuthService
export declare const PRINCIPAL_RESOLVER: unique symbol;
```

#### 2.2.9 `./plugin`

```ts
import type { BetterAuthPlugin } from "better-auth";
export declare const NESTJS_PLUGIN_ID: "nestjs-slightly-better-auth";
export interface NestjsPluginOptions {
  /**
   * Header better-auth reads the client IP from, contributed to advanced.ipAddress.ipAddressHeaders as a default
   * (user values win and come first). false = contribute nothing (configure advanced.ipAddress yourself).
   * Default 'x-nsba-client-ip'.
   */
  clientIpHeader?: string | false;
}
export declare function nestjs(
  options?: NestjsPluginOptions,
): BetterAuthPlugin & { id: typeof NESTJS_PLUGIN_ID };
```

#### 2.2.10 `./platform` (helpers for Node-based platforms) [A][B][C]

```ts
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
/** Node headers → Web Headers: drops ':'-prefixed pseudo-headers and symbol keys, appends array values; sets host from :authority if absent. */
export declare function toWebHeaders(
  raw: IncomingHttpHeaders | Record<string | symbol, unknown>,
): Headers;
/** true if the request may carry a body (not GET/HEAD, and content-length > 0 or transfer-encoding present). */
export declare function mayHaveBody(
  method: string,
  headers: IncomingHttpHeaders,
): boolean;
/**
 * Read at most `limit` bytes. Never throws for size: resolves { ok: false, reason: 'too-large' } instead.
 * drainOnOverflow: keep consuming and discarding (up to drainCap, then destroy the socket) so later middleware sees a finished stream.
 */
export declare function readBoundedBody(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  options: {
    limit: number;
    declaredLength?: number;
    drainOnOverflow?: boolean;
    drainCap?: number; // drain* apply to Node streams only
  },
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too-large" | "aborted" }
>;
/** Stream a Web Response to a ServerResponse: status, headers (vary merged), each Set-Cookie appended, backpressure, no body for HEAD. */
export declare function writeWebResponse(
  res: ServerResponse,
  response: Response,
  options?: { head?: boolean },
): Promise<void>;
/** Append Set-Cookie values without clobbering existing ones. Returns false if headers were already sent. */
export declare function appendSetCookie(
  res: ServerResponse,
  values: readonly string[],
): boolean;
/** Bind a continuation to the current async context (use when resuming from stream events). */
export declare function bindAsyncContext<F extends (...args: any[]) => any>(
  fn: F,
): F;
/** Degraded tier (§6.4.3): req.rawBody if present, else re-serialize req.body for its content type (warns once). */
export declare function recoverConsumedBody(
  req: IncomingMessage & { body?: unknown; rawBody?: Buffer },
): Uint8Array | null;
```

#### 2.2.11 `./express`, `./fastify`

```ts
// ./express
export interface ExpressPlatformOptions {
  /** Client IP for better-auth's rate limiter. Default req.ip (honors Express `trust proxy`). */
  clientIp?: (req: IncomingMessage & { ip?: string }) => string | null;
}
export declare function expressPlatform(
  options?: ExpressPlatformOptions,
): ExtensionRef<HttpPlatform>;
export declare class ExpressPlatform implements HttpPlatform {
  readonly id: "express";
  constructor(options?: ExpressPlatformOptions);
}

// ./fastify
export interface FastifyPlatformOptions {
  /** Default request.ip (honors Fastify `trustProxy`). */
  clientIp?: (request: { ip?: string; raw: IncomingMessage }) => string | null;
}
export declare function fastifyPlatform(
  options?: FastifyPlatformOptions,
): ExtensionRef<HttpPlatform>;
export declare class FastifyPlatform implements HttpPlatform {
  readonly id: "fastify";
  readonly capabilities: { http2: true };
}
```

#### 2.2.12 `./graphql`

```ts
export interface GraphqlTransportOptions {
  /** connectionParams keys copied into Headers for subscriptions (case-insensitive). Default ['authorization', 'cookie']. [A] */
  connectionParamHeaders?: readonly string[];
  /** Full override of subscription credential extraction. [B][C] */
  subscriptionCredentials?: (
    connectionContext: unknown,
  ) => HeadersInit | undefined;
  /** Reuse a subscription connection's principal for this long. Default 0 (resolve per subscription start). */
  subscriptionPrincipalTtlMs?: number;
}
export declare function apolloTransport(
  options?: GraphqlTransportOptions,
): ExtensionRef<AuthTransport>;
export declare function mercuriusTransport(
  options?: GraphqlTransportOptions,
): ExtensionRef<AuthTransport>;
/** Mercurius `subscription.context` helper that keeps the upgrade request reachable for the transport. [B] */
export declare function mercuriusSubscriptionContext(): (
  connection: unknown,
  request: { headers: Record<string, unknown> },
) => Record<string | symbol, unknown>;
/** What GraphQL transports throw for a denial (LEAD-EXP-1): intrinsic (not logged), extensions preserved by both drivers. [L] */
export declare class BetterAuthGraphqlDenial extends IntrinsicException {
  readonly extensions: AuthGraphqlExtensions;
  constructor(failure: AuthFailure);
}
```

#### 2.2.13 `./websockets`

```ts
export interface WsTransportOptions<C> {
  /** Map socket credentials to headers, e.g. handshake.auth.token → authorization: Bearer … */
  credentials?: (client: C) => HeadersInit | undefined;
  /** Reuse a connection's principal for this long. Default 0 = resolve per message (secure default). */
  principalTtlMs?: number;
  /** Boot check for gateways the guard does not reach (§9.4). Default 'error'. */
  gatewayCoverage?: "error" | "warn" | "off";
}
export declare function socketIoTransport(
  options?: WsTransportOptions<SocketIoClientLike>,
): ExtensionRef<AuthTransport>;
export declare function wsTransport(
  options?: WsTransportOptions<WsClientLike>,
): ExtensionRef<AuthTransport>;
/** Mixin over any WsAdapter subclass; records the upgrade request on each client (no @nestjs/platform-ws import). [B][C] */
export declare function withUpgradeRequest<
  T extends new (...args: any[]) => WsAdapterLike,
>(Base: T): T;
/** For custom adapters: record the upgrade request yourself. */
export declare function recordUpgradeRequest(
  client: object,
  request: {
    headers: IncomingHttpHeaders;
    url?: string;
    socket?: { remoteAddress?: string };
  },
): void;
/** Connection-time authentication (guards never run on connect). [B] */
export declare class WsConnectionAuth {
  /** Resolve (refresh suppressed) and cache on the client for principalTtlMs. */
  authenticate(client: unknown): Promise<AuthPrincipal | null>;
  /** socket.io middleware: afterInit(server) { server.use(this.wsAuth.socketIoMiddleware({ required: true })) } */
  socketIoMiddleware(options?: {
    required?: boolean;
  }): (socket: unknown, next: (err?: Error) => void) => void;
}
export interface SocketIoClientLike {
  readonly handshake: {
    readonly headers: IncomingHttpHeaders;
    readonly auth?: Record<string, unknown>;
    readonly address?: string;
  };
}
export interface WsClientLike {
  readonly [UPGRADE_REQUEST]?: {
    readonly headers: Headers;
    readonly url?: string;
    readonly remoteAddress?: string;
  };
}
export interface WsAdapterLike {
  bindClientConnect(
    server: unknown,
    callback: (...args: any[]) => void,
  ): unknown;
}
export declare const UPGRADE_REQUEST: unique symbol; // Symbol.for('nestjs-slightly-better-auth:upgrade-request')
```

#### 2.2.14 `./microservices`

```ts
export interface RpcCredentialCarrier {
  readonly id: string;
  matches(context: ExecutionContext): boolean;
  headers(context: ExecutionContext): HeadersInit | undefined;
  /** Optional transport-specific error (e.g. gRPC numeric status). */
  toException?(failure: AuthFailure, context: ExecutionContext): unknown;
}
export declare function rpcTransport(options?: {
  carriers?: readonly RpcCredentialCarrier[];
}): ExtensionRef<AuthTransport>;
export declare function natsCarrier(options?: {
  headers?: readonly string[];
}): RpcCredentialCarrier;
export declare function kafkaCarrier(options?: {
  headers?: readonly string[];
}): RpcCredentialCarrier;
export declare function rmqCarrier(options?: {
  headers?: readonly string[];
}): RpcCredentialCarrier;
export declare function grpcCarrier(options?: {
  metadata?: readonly string[];
}): RpcCredentialCarrier;
export declare function mqttCarrier(options?: {
  userProperties?: readonly string[];
}): RpcCredentialCarrier;
/** TCP / Redis carry no headers: credentials travel inside the payload envelope data[field]. */
export declare function payloadCarrier(options?: {
  field?: string;
}): RpcCredentialCarrier; // default field 'auth'
export declare const defaultCarriers: readonly RpcCredentialCarrier[]; // grpc, nats, kafka, rmq, mqtt, payload
```

Default header allow-list for every carrier: `authorization`, `cookie`, `x-api-key`.

#### 2.2.15 `./admin`, `./organization`, `./api-key`

```ts
// ./admin
export type AdminPermissions =
  /* body.permissions of RegisteredAuth['api']['userHasPermission'] (§11.3) */ unknown;
export interface PermissionOptions {
  /** 'fresh' (default): userHasPermission by userId without headers (reads the user row).
   *  'session': body.role from the resolved session (0 reads; stale up to cookieCache.maxAge). [C] */
  freshness?: "fresh" | "session";
}
export declare function permission(
  permissions: AdminPermissions,
  options?: PermissionOptions,
): Requirement<AdminPermissionParams>;
export declare function RequirePermission(
  permissions: AdminPermissions,
  options?: PermissionOptions,
): ClassDecorator & MethodDecorator;
export declare const adminPermissionPolicy: AuthorizationPolicy<
  AdminPermissionParams,
  AuthPrincipal
>;
export interface AdminPermissionParams {
  readonly permissions: AdminPermissions;
  readonly freshness: "fresh" | "session";
}

// ./organization
export type OrgPermissions =
  /* body.permissions of RegisteredAuth['api']['hasPermission'] (§11.3) */ unknown;
export type OrganizationRef = (
  ctx: AuthorizationContext,
) => string | null | undefined | Promise<string | null | undefined>;
export declare function activeOrganization(): OrganizationRef; // default: omit organizationId (better-auth uses the active org)
export declare function fromParam(name: string): OrganizationRef; // route param / GraphQL arg / WS or RPC payload field
export declare function fromHeader(name: string): OrganizationRef;
export declare function orgPermission(
  permissions: OrgPermissions,
  options?: { organization?: OrganizationRef },
): Requirement<OrgPermissionParams>;
export declare function RequireOrgPermission(
  permissions: OrgPermissions,
  options?: { organization?: OrganizationRef },
): ClassDecorator & MethodDecorator;
export declare function orgMember(options?: {
  organization?: OrganizationRef;
}): Requirement<OrgMemberParams>;
export declare function RequireOrgMember(options?: {
  organization?: OrganizationRef;
}): ClassDecorator & MethodDecorator;
/** Valid after an org requirement ran on the handler: the resolved organization id / member role (memoized). [C] */
export declare function ActiveOrganizationId(): ParameterDecorator; // string
export declare function ActiveMemberRole(): ParameterDecorator; // string (comma-joined roles, as better-auth stores them)
export declare const orgPermissionPolicy: AuthorizationPolicy<
  OrgPermissionParams,
  SessionPrincipal
>;
export declare const orgMemberPolicy: AuthorizationPolicy<
  OrgMemberParams,
  SessionPrincipal
>;

// ./api-key
export interface ApiKeyPrincipal extends AuthPrincipalBase {
  readonly kind: "api-key";
  readonly keyId: string;
  readonly referenceId: string | null;
  readonly permissions: Record<string, string[]> | null;
}
declare module "nestjs-slightly-better-auth" {
  interface PrincipalKinds {
    "api-key": ApiKeyPrincipal;
  }
}
export declare function apiKeyPrincipal(options?: {
  header?: string /* default 'x-api-key' */;
  configId?: string;
}): PrincipalSource<ApiKeyPrincipal>;
export declare function apiKeyPermission(
  permissions: Record<string, string[]>,
): Requirement<Record<string, string[]>>;
export declare function RequireApiKeyPermission(
  permissions: Record<string, string[]>,
): ClassDecorator & MethodDecorator;
```

#### 2.2.16 `./testing`, `./testing/conformance`

```ts
// ./testing
/** init() + Fastify ready() when present (capability check) + registers app.close() with a global afterAll if one exists. [C][A] */
export declare function initTestApp<T extends INestApplication>(
  app: T,
): Promise<T>;
/** Real session headers through better-auth's testUtils() plugin (the test instance must include it). */
export declare function authHeadersFor(
  auth: AuthLike,
  userId: string,
): Promise<Headers>;
/** Replace principal resolution in a TestingModuleBuilder (no better-auth I/O); policies still run. [A][B] */
export declare function overridePrincipal(
  builder: TestingModuleBuilder,
  principal:
    AuthPrincipal | null | ((call: TransportCall) => AuthPrincipal | null),
  options?: { instance?: string },
): TestingModuleBuilder;
/** A principal source returning a fixed principal, for modules composed in tests. [C] */
export declare function testPrincipal(
  principal: AuthPrincipal | ((req: PrincipalRequest) => AuthPrincipal | null),
): PrincipalSource;
/** Replace the guard (works because APP_GUARD uses useExisting). */
export declare function overrideAuthGuard(
  builder: TestingModuleBuilder,
  impl: CanActivate,
): TestingModuleBuilder;

// ./testing/conformance (§14.1)
export interface ConformanceCase {
  readonly id: string;
  readonly title: string;
  readonly skip?: string;
  run(): Promise<void>;
}
export interface ConformanceRunner {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void>): void;
}
export declare function runConformance(
  cases: readonly ConformanceCase[],
  runner: ConformanceRunner,
): void;
export declare function conformanceProbePlugin(): BetterAuthPlugin;
export declare function httpPlatformConformance(
  options: HttpConformanceOptions,
): ConformanceCase[];
export declare function transportConformance(
  options: TransportConformanceOptions,
): ConformanceCase[];
export declare function principalSourceConformance(
  options: PrincipalSourceConformanceOptions,
): ConformanceCase[];
export declare function policyConformance(
  options: PolicyConformanceOptions,
): ConformanceCase[];
```

### 2.3 Tokens and metadata keys (S5) [A][B][C]

Every identity-sensitive value is copy-safe. If the CJS and ESM builds are both loaded, `Symbol.for` keys still match, so metadata written by one copy is visible to the other (R:packaging §5.2: `Symbol()` keys fail silently; `Symbol.for` works).

| Kind                         | Key (`Symbol.for('nestjs-slightly-better-auth:<…>')`)                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DI tokens                    | `instance:<name>`, `options:<name>`, `service:<name>`, `handle:<name>`, `principal-resolver`, `transports`, `platforms`, `principal-sources`, `instance-registry`, `request-scope`                                                                          |
| Metadata keys (class/method) | `access`, `requirements`, `freshness`, `auth-instance`, `reads-session`, `use-better-auth`, `hook`, `db-hook`                                                                                                                                               |
| Runtime brands and slots     | `bridge` (protocol object on the plugin), `extension` (ExtensionDefinition brand), `failure` (AuthFailure brand), `resolution` (stamp on a carrier object), `raw-body` (Express capture), `upgrade-request` (ws), `mounted` (per-server double-mount stamp) |

- Metadata is written with `SetMetadata`-style decorators under these keys. Requirement decorators **append** to the target's own array rather than overwriting it (§8.2).
- `Reflector.createDecorator` is not used. Its key is typed `string` and defaults to a random `uid(21)` per copy.
- `DiscoveryService.createDecorator` is not used. It allows one key per class, and its key is random (R:nest-di §3.1, §6.2).
- Library code never writes `req.session` or `req.user`, which express-session and Passport own.

### 2.4 Peer dependencies

| Package                          | Range                   | Optional | Needed by                            |
| -------------------------------- | ----------------------- | -------- | ------------------------------------ |
| `@nestjs/common`, `@nestjs/core` | `^11.0.0 \|\| ^12.0.0`  | no       | all Nest-facing entries              |
| `better-auth`                    | `>=1.7.0 <2`            | no       | all                                  |
| `reflect-metadata`               | `^0.2.0`                | no       | `.`                                  |
| `rxjs`                           | `^7.8.0`                | no       | `.` (interceptor)                    |
| `@nestjs/graphql`                | `^13.0.0 \|\| ^14.0.0`  | yes      | `./graphql`                          |
| `graphql`                        | `^16.11.0 \|\| ^17.0.0` | yes      | `./graphql`                          |
| `@nestjs/websockets`             | `^11.0.0 \|\| ^12.0.0`  | yes      | `./websockets`                       |
| `@nestjs/microservices`          | `^11.0.0 \|\| ^12.0.0`  | yes      | `./microservices`                    |
| `@nestjs/testing`                | `^11.0.0 \|\| ^12.0.0`  | yes      | `./testing`, `./testing/conformance` |

- **Dependencies:** `defu` `^6.1.4`. It is better-auth's own dependency and implements the exact merge the hook dispatcher must mirror (LEAD-V1).
- **Not peers:**
  - `@nestjs/platform-express`, `@nestjs/platform-fastify`, `express`, `fastify`, `@nestjs/apollo`, `@nestjs/mercurius`, `@nestjs/platform-ws`, `socket.io`: we never import them; platforms reach the server through `HttpAdapterHost` and structural types.
  - `better-call`: `APIError`/`isAPIError` come from `better-auth/api`.
  - `@better-auth/core`: not resolvable under pnpm's strict layout.
  - `typescript`: TS 7 is npm `latest`, and a runtime library should not constrain it (R:packaging §9.12).

---

## 3. Architecture

### 3.1 Units

| #   | Unit                                                           | Purpose                                                                                                                                                                                                  | Interface                                           | Depends on                                |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| U1  | `nestjs()` plugin (`./plugin`)                                 | The only code inside better-auth's pipeline: hook and DB-hook dispatchers, cookie bridge, refresh suppression, client-IP header default, protocol object                                                 | `BetterAuthPlugin` + `BridgeHandle` (§10.2)         | `better-auth/api`, `defu`                 |
| U2  | `BridgeClient`                                                 | Finds the plugin via `$context.getPlugin(id)[Symbol.for(…:bridge)]`, checks the protocol version and position, binds and unbinds exclusively                                                             | internal                                            | U1 protocol types only                    |
| U3  | `RequestScope`                                                 | Kernel-owned `AsyncLocalStorage<ScopeState>` + `WeakMap<object, RequestState>` (principal promises, decision memo, TTL entries); `run`, `current`, `stateFor(key)`                                       | internal; exposed via `AuthHandle.run`, the service | none                                      |
| U4  | `MountCoordinator`                                             | Subscribes to `HttpAdapterHost.init$` in its constructor. Selects the single platform by `supports()`, calls `prepare()`, then in `onModuleInit` resolves each instance's mount path and calls `mount()` | lifecycle only                                      | `HttpAdapterHost`, platforms, U5          |
| U5  | `AuthExchange`                                                 | Platform-independent auth-route semantics: body buffering, origin, header hygiene, client-IP header, `around` chain, `auth.handler`, `APIError` → `Response`                                             | `AuthRouteBinding.handle`                           | `AuthHandle`                              |
| U6  | `TransportRegistry`                                            | Ordered list; `select(ctx)` = first `handles(ctx)`                                                                                                                                                       | internal                                            | transports                                |
| U7  | `ChainPrincipalResolver` (default behind `PRINCIPAL_RESOLVER`) | Ordered sources, memoization per (key, instance, freshness), TTL entries, error normalization                                                                                                            | `PrincipalResolver`                                 | sources, U3                               |
| U8  | `AuthorizationEvaluator`                                       | AND/`anyOf`/`allOf` over requirement expressions; resolves policy references (object, or class via `ModuleRef`); per-request decision memo                                                               | internal                                            | `ModuleRef`, U3                           |
| U9  | `RoutePlanner`                                                 | Compiles class/method metadata into a cached `RoutePlan` (§7.6); used by the guard, the boot scan and param decorators                                                                                   | internal                                            | `Reflector`                               |
| U10 | `BetterAuthGuard`                                              | Orchestrates transport → plan → resolver → evaluator → failure mapping; stamps the resolution                                                                                                            | `CanActivate`                                       | U6–U9, instance registry                  |
| U11 | `BetterAuthScopeInterceptor`                                   | Opens the per-invocation scope (cookie sink, resolutions, `internal: false`) around the handler                                                                                                          | `NestInterceptor`                                   | U3, U6, U7                                |
| U12 | `HookBinder`                                                   | Discovers `@BeforeAuth`/`@AfterAuth`/`@BeforeDatabase`/`@AfterDatabase` methods, validates paths and scopes, builds the late-bound tables, binds through U2                                              | lifecycle only                                      | `DiscoveryService`, `MetadataScanner`, U2 |
| U13 | `BootValidator`                                                | Fail-fast checks B01–B22 (§5.4) and the boot summary                                                                                                                                                     | lifecycle only                                      | all, read-only                            |
| U14 | `InstanceRegistry`                                             | App-scoped `name → InstanceKernel` (handle, options, binding); name uniqueness                                                                                                                           | internal                                            | none                                      |
| U15 | `BetterAuthModule` (composition root, `src/module/**`)         | Turns options into providers; appends built-in defaults; registers `APP_GUARD`/`APP_INTERCEPTOR` via `useExisting`                                                                                       | `forRoot`, `forRootAsync`                           | everything above + built-in units         |
| E1  | Built-in units in the root entry                               | `httpTransport()`, `sessionPrincipal()`, `freshSession` policy                                                                                                                                           | contracts                                           | kernel contracts                          |
| E2  | Built-in units in subpaths                                     | Express, Fastify; Apollo, Mercurius; socket.io, ws; RPC + carriers; admin, organization, api-key                                                                                                         | contracts                                           | contracts + own peer                      |

`BetterAuthGuard`, `BetterAuthScopeInterceptor`, `InstanceRegistry`, `RequestScope`, `PRINCIPAL_RESOLVER`, `TransportRegistry` and `MountCoordinator` live in an internal static `BetterAuthCoreModule`. It is global, and Nest deduplicates it because it is a class reference. Each `forRoot` dynamic module imports it and contributes one `InstanceKernel` (instance, options, handle, hook binder). This is how several named instances share one guard without registering it twice `[C]`.

### 3.2 Dependency direction

```
      user auth.ts ─── imports ──► ./plugin (U1) ────────────► better-auth/api, defu      (never @nestjs/*)
                                      ▲
                                      │  runtime handshake only: (await auth.$context).getPlugin(id)[Symbol.for('…:bridge')]
                                      │  versioned protocol object; no import edge in either direction
┌──────────────────────────── kernel (src/core/**) ─┴──────────────────────────────────────────────┐
│ contracts (SPI types) ◄──────────────────────────────────────────────────────────────┐          │
│ U10 Guard ─► U6 TransportRegistry ─► «AuthTransport»                                   │          │
│    │     ─► U9 RoutePlanner ─► Reflector                                               │          │
│    │     ─► U7 PrincipalResolver ─► «PrincipalSource» ─► AuthHandle ─► auth.api        │          │
│    │     ─► U8 Evaluator ─► «AuthorizationPolicy» (by reference / ModuleRef)            │          │
│ U11 ScopeInterceptor ─► U3 RequestScope ◄─ AuthHandle.run                              │          │
│ U4 MountCoordinator ─► «HttpPlatform» ─► U5 AuthExchange ─► auth.handler               │          │
│ U12 HookBinder ─► U2 BridgeClient      U13 BootValidator (read-only)                   │          │
└────────────────────────────────────────────────────────────────────────────────────────┼──────────┘
          ▲ imported by                                                                  │ implement
┌─────────┴──────── composition root (src/module/**, src/index.ts) ────┐    ┌────────────┴───────────────────────┐
│ U15 BetterAuthModule: providers, defaults (httpTransport,             │    │ extension units (src/extensions/**) │
│ sessionPrincipal), APP_GUARD/APP_INTERCEPTOR via useExisting          │    │ express fastify │ graphql websockets│
└───────────────────────────────────────────────────────────────────────┘    │ microservices   │ admin organization│
                                                                              │ api-key         │ third-party pkgs  │
                                                                              └───────┬──────────────────────────────┘
                                                                                      ▼ own peers only
                                                     @nestjs/graphql, @nestjs/websockets, @nestjs/microservices
```

Arrows point from the dependent to the dependency. The layering rules are enforced by the architecture test (§14.7) `[B]`:

1. `src/core/**` imports only `src/core/**`, `src/shared/**`, `@nestjs/common`, `@nestjs/core`, `rxjs` and `better-auth/api`.
2. `src/extensions/**` import `src/core/contracts/**` and `src/shared/**` (errors, the `./platform` helpers in `src/shared/platform/**`) plus their own peer. They never import another extension. `src/shared/**` imports nothing but Node built-ins and `src/core/contracts/**` types.
3. Only the composition root (`src/module/**`, `src/index.ts`) and the per-subpath entry files reference concrete extension units.
4. `src/plugin/**` imports only `better-auth/api`, `defu` and `src/core/contracts/bridge-protocol.ts` (types).
5. No file under `src/core/**` contains a string literal equal to a platform, transport or principal/policy name (`'express'`, `'fastify'`, `'graphql'`, `'ws'`, `'rpc'`, `'http'`, `'session'`, `'admin'`, `'organization'`, `'api-key'`). This is a lint rule with a grep fallback. Core compares only values that extensions supply (for example `policy.requires.principals` against `principal.kind`).

### 3.3 What lives where

| better-auth (never reimplemented)                                                                                                                                                                                                                                                            | the plugin (inside better-auth's pipeline)                                                                                                 | the kernel (Nest side, framework-neutral)                                                                                                                                                                         | extension units                                                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| routing, method checks, media types, auth-route body parsing, origin/CSRF, rate limiting, `disabledPaths`, plugin `onRequest`/`onResponse`, sessions and refresh, bearer/api-key/jwt credential translation inside `getSession`, permission evaluation, error codes, trusted-origin matching | Nest hooks, Nest DB hooks, cookie forwarding for direct calls, refresh suppression in cookie-less scopes, the client-IP header declaration | lifecycle, DI, boot validation, `Request` construction and header hygiene, request scope and memoization, guard orchestration, principal chain semantics, requirement composition, hook discovery, error taxonomy | everything that names a framework or a better-auth plugin: Express, Fastify, Apollo, Mercurius, socket.io, ws, microservices, admin, organization, api-key, and third-party units |

### 3.4 Request walkthroughs

**A. Auth route `POST /api/auth/sign-in/email` (form-encoded) on Express.**

1. _Phase A capture_, installed at `init$`. The path matches a binding and the request has a body, so `readBoundedBody` reads at most `bodyLimit` bytes into `req[Symbol.for(…:raw-body)]` and calls `next()` through `bindAsyncContext`. body-parser later skips the request because the stream is finished (`body-parser/lib/read.js:40-44`).
2. The user's `enableCors()`, `helmet()` and `app.use()` run, then Nest's parsers, which skip this request.
3. _Phase B dispatch_, installed in `onModuleInit`, builds an `InboundAuthRequest`: the original URL, `toWebHeaders(req.headers)`, the captured bytes and `req.ip`.
4. `AuthExchange` does the rest:
   - replaces the origin with the static `baseURL` origin;
   - strips hop-by-hop headers and any inbound `x-nsba-client-ip`, then sets that header from `clientIp`;
   - runs the `around` chain and calls `auth.handler(new Request(…))`.
5. `writeWebResponse` writes the status and headers, appends each `Set-Cookie`, and streams the body.

Evidence: EXP-A:`exp-express.mjs`, EXP-B:E1 and EXP-C4 (byte-exact, CORS applied, app routes keep `rawBody`), and EXP-B:E4 (form sign-up with 2 cookies, 302 with cookie, PATCH, 413 with ACAO).

**B. App route `GET /orgs/:orgId/projects` with `@RequireOrgPermission(…)` on Fastify.**

1. `BetterAuthGuard`:
   - `TransportRegistry.select(ctx)` returns the HTTP transport;
   - `describe()` gives the key `request.raw`, lazy headers, a sink (`reply.header('set-cookie', v)`) and the params;
   - the plan says `required` with one requirement;
   - `PrincipalResolver.resolve` runs the session source inside an internal scope: `getSession({ headers, returnHeaders: true })`, forwarding only `set-cookie` to the sink;
   - the evaluator calls the org policy, which calls `auth.api.hasPermission({ headers, body: { organizationId, permissions } })` inside the same internal scope. A sliding refresh inside that endpoint reaches the browser through the plugin's cookie bridge.
2. `BetterAuthScopeInterceptor` opens the handler scope, carrying the sink and the resolution.
3. The handler runs. `@Session()` reads the resolution synchronously from the scope.

**C. socket.io message on Nest 11.**

1. The gateway carries `@UseBetterAuth()`, because global enhancers do not reach gateways on Nest 11 (LEAD-V6). The boot check (§9.4) fails the boot if it is missing.
2. The socket.io transport takes credentials from `client.handshake.headers`. The memo key is the per-message `args` array and the sink is `null`.
3. Resolution runs in a cookie-less internal scope. The plugin's any-path before-hook sets `setShouldSkipSessionRefresh(true)` and the source also passes `disableRefresh`.
4. On denial the transport throws `WsException({ status: 'error', statusCode: 401, code, reason, message })`.
5. Param decorators read the resolution from the interceptor's scope, which is race-free across concurrent messages (§7.8).

---

## 4. Extension points (Open-Closed)

All five extension points follow one shape `[C]`, so learning one teaches the others:

- **A contract.** A small TypeScript interface exported from the root entry, with written invariants. Each invariant is mapped to conformance case ids (§14.1); that mapping is the LSP contract `[B]`.
- **A `define*` helper.** An identity function that gives inference and a stable place for future defaults.
- **Registration by addition.** Every extension point except policies and hooks is registered by listing it in the `forRoot` static options. Policies travel by reference inside route metadata `[B][C]`. Hooks are discovered from decorated provider methods `[A][B][C]`. Nothing is registered by editing library files, and no registration relies on core resolving a name.

| Extension point      | Contract                              | Registered via                                                                                   | Selection rule in core                                            |
| -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| HTTP platform        | `HttpPlatform`                        | `platforms: [...]` (static)                                                                      | exactly one `supports(httpAdapter)` must be true                  |
| Transport            | `AuthTransport`                       | `transports: [...]` (static); built-in `httpTransport()` appended last                           | first `handles(ctx)`                                              |
| Principal source     | `PrincipalSource`                     | `principals: [...]` (static); built-in session source appended last unless `session: false`      | ordered chain: first `authenticated` wins, first `rejected` stops |
| Authorization policy | `AuthorizationPolicy` + `Requirement` | carried by reference in `@Require(...)` metadata; class policies are ordinary Nest providers     | none: the requirement names its own policy                        |
| Hook                 | method decorators                     | any singleton provider method with `@BeforeAuth`/`@AfterAuth`/`@BeforeDatabase`/`@AfterDatabase` | discovery at boot                                                 |

**`ExtensionRef<T>` resolution** `[A][B]`:

- A class becomes a provider constructed by DI; its constructor must use explicit `@Inject`.
- A plain instance becomes `useValue`.
- An `ExtensionDefinition` brings its own providers and imports, for example an options provider.

Each list entry becomes one provider under `Symbol.for('…:ext:<point>:<instance>:<i>')`. A registry provider for each extension point collects them with `useFactory` + `inject`, because Nest has no multi-providers (R:nest-di §3.3). An extension package ships options without core knowing about them:

```ts
export class MyTransport implements AuthTransport {
  static configure(options: MyOptions): ExtensionDefinition<MyTransport> {
    return defineExtension({
      use: { useClass: MyTransport },
      providers: [{ provide: MY_OPTIONS, useValue: options }],
    });
  }
  constructor(@Inject(MY_OPTIONS) private readonly options: MyOptions) {}
  /* … */
}
```

### 4.1 HTTP platform

#### 4.1.1 Contract `[A][B][C]`

```ts
import type { AbstractHttpAdapter } from "@nestjs/core";
import type { LoggerService } from "@nestjs/common";

export interface HttpPlatform {
  /** Diagnostic id ('express', 'fastify', 'hono'…). Core prints it and never compares it. */
  readonly id: string;
  /** Capabilities the conformance kit should exercise. */
  readonly capabilities?: { readonly http2?: boolean };
  /** Does this platform drive the running Nest HTTP adapter? Adapter-owned predicate (getType(), instanceof, duck typing). */
  supports(adapter: AbstractHttpAdapter): boolean;
  /**
   * Phase 1, optional, synchronous. Called from HttpAdapterHost.init$:
   *   NestFactory     → during NestFactory.create(), before providers, Nest's body parsers and main.ts code;
   *   @nestjs/testing → inside createNestApplication(), with the same position relative to parsers.
   * Use it only for work that must precede body parsing (Express raw capture) or per-request bookkeeping
   * (Fastify request→reply map). Mount paths are not resolved yet: call ctx.route(pathname) per request.
   */
  prepare?(ctx: PlatformPrepareContext): void;
  /**
   * Phase 2, required. Called once per auth instance from onModuleInit, after parsers, main.ts middleware/CORS,
   * MiddlewareConsumer middleware and controller routes are registered, and before Nest's 404/error handlers.
   * Route every method for binding.basePath and binding.basePath/* to binding.handle(). May be async.
   */
  mount(ctx: PlatformMountContext): void | Promise<void>;
  /** Per-request access for transports running on this platform (HTTP controllers, GraphQL over HTTP). */
  readonly requests: HttpRequestAccessor;
  /** Optional boot-time checks (throw BetterAuthConfigurationError to fail fast). */
  validate?(adapter: AbstractHttpAdapter): void;
}

export interface PlatformPrepareContext {
  readonly adapter: AbstractHttpAdapter;
  readonly logger: LoggerService;
  /** The binding whose base path matches this raw (undecoded, query-less) pathname; undefined before mount or if none. */
  route(pathname: string): AuthRouteBinding | undefined;
}

export interface PlatformMountContext {
  readonly adapter: AbstractHttpAdapter;
  readonly logger: LoggerService;
  readonly binding: AuthRouteBinding;
}

export interface AuthRouteBinding {
  readonly instance: string;
  /** Normalized mount path: no trailing slash; never '/' unless allowRootMount. */
  readonly basePath: string;
  readonly bodyLimit: number;
  /** Static baseURL origin (e.g. 'https://api.example.com'), or undefined for unset/dynamic baseURL. */
  readonly staticOrigin: string | undefined;
  /** pathname === basePath || pathname.startsWith(basePath + '/'), on the raw pathname. */
  matches(pathname: string): boolean;
  /** Core exchange (§6.3). Resolves a Response for every better-auth outcome; rejects only with BetterAuthInfrastructureError. */
  handle(inbound: InboundAuthRequest): Promise<Response>;
  /** Canonical 413: better-auth's error shape { code: 'PAYLOAD_TOO_LARGE', message }. */
  payloadTooLarge(): Response;
}

export interface InboundAuthRequest {
  readonly method: string;
  /** Absolute URL: platform trust-proxy-aware origin + the ORIGINAL path and query (never a rewritten req.url). */
  readonly url: string;
  /** Original headers as Web Headers (toWebHeaders drops pseudo-headers); never rewritten by the platform. */
  readonly headers: Headers;
  /** Exact bytes (<= bodyLimit), or a stream core buffers up to bodyLimit, or null when there is no body. */
  readonly body: Uint8Array | ReadableStream<Uint8Array> | null;
  /** Client IP from the platform's own trust-proxy resolution; never read from a raw header by core. */
  readonly clientIp: string | null;
  /** Opaque; passed to AuthHandlerInterceptor. */
  readonly platformRequest: unknown;
  /** Aborted on client disconnect. */
  readonly signal?: AbortSignal;
}

export interface HttpRequestAccessor {
  /** Stable identity of one request for guards, pipes, interceptors and GraphQL (Fastify: request.raw). */
  key(req: unknown): object;
  /** Request headers as Web Headers (pseudo-headers dropped). */
  headers(req: unknown): Headers;
  /** Method and absolute URL (trust-proxy-aware origin, original path). DPoP-bound tokens need both. */
  request(req: unknown): { readonly method: string; readonly url: string };
  /** Trust-proxy-aware client IP, or null. */
  clientIp(req: unknown): string | null;
  /** Route param. */
  param(req: unknown, name: string): string | undefined;
  /** Sink writing Set-Cookie onto the native response; null if unreachable. */
  cookieSink(req: unknown, res: unknown): CookieSink | null;
  /** Locate the native response for a request when a framework dropped it (Apollo on Fastify, LEAD-V8). */
  responseFor?(req: unknown): unknown | undefined;
}

export interface CookieSink {
  /** Append each value as its own Set-Cookie header. Returns false (and writes nothing) if headers were already sent. */
  append(setCookies: readonly string[]): boolean;
}
```

Core wraps every sink it receives. The wrapper drops exact duplicate strings within one request and logs one debug line when `append` returns `false` `[C]`.

#### 4.1.2 Invariants (LSP contract) `[A][B][C]`

| #   | Invariant                                                                                                                                                                                                                                                | Conformance ids (§14.1)                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| H1  | Every request whose raw pathname matches `binding.matches()` reaches `binding.handle()` for **every** method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, any other). No other request does (`/api/authx` is not matched). The URL is never rewritten. | `H-mount-methods`, `H-mount-boundary`, `H-mount-custom-path`                             |
| H2  | The auth route runs **after** host middleware and CORS registered in `main.ts` and after `MiddlewareConsumer` middleware (when no global prefix applies). Host CORS answers preflight before better-auth.                                                | `H-cors-preflight`, `H-cors-actual`, `H-middleware-order`                                |
| H3  | `body` is byte-identical to what the client sent, for any content type (JSON with odd whitespace, UTF-8, urlencoded, multipart, `text/plain`, `application/scim+json`, binary, chunked, empty). App routes keep Nest-native parsing and `rawBody`.       | `H-body-*`, `H-app-parsing`, `H-app-rawbody`                                             |
| H4  | A body larger than `bodyLimit` yields `payloadTooLarge()` **with host CORS headers**, without calling `auth.handler`. This holds for a declared `content-length` and for chunked bodies.                                                                 | `H-limit-declared`, `H-limit-chunked`                                                    |
| H5  | `url` keeps the path and query exactly, including percent-encoding. Its origin is the platform's trust-proxy-aware protocol and host. Core substitutes the static origin (§6.3).                                                                         | `H-url-query`, `H-url-encoded`, `H-url-trust-proxy`                                      |
| H6  | Headers are forwarded unmodified except that pseudo-headers are dropped. `Origin`, `Referer`, `Sec-Fetch-*`, `Cookie`, `Content-Type` and `Authorization` are never rewritten. `clientIp` is the platform's trust-proxy result.                          | `H-headers-passthrough`, `H-h2-pseudo` (if `http2`), `H-ip-platform`, `H-ip-spoof`       |
| H7  | The Response is written verbatim: status, every header, **each Set-Cookie on its own line**, host headers merged (`vary` union), the body streamed with backpressure, redirects not followed. HEAD writes no body and never 500s.                        | `H-resp-multicookie`, `H-resp-redirect`, `H-resp-stream`, `H-resp-head`, `H-resp-status` |
| H8  | A rejected `handle()` reaches the host's error pipeline, so Nest's global filters see it. It is never swallowed and never leaves the request hanging.                                                                                                    | `H-errors-infra`, `H-errors-no-hang`                                                     |
| H9  | Behavior is identical under `NestFactory` and `@nestjs/testing` on Nest 11 and 12.                                                                                                                                                                       | whole suite per bootstrap                                                                |
| H10 | `requests.key()` returns the same object for guards, interceptors and GraphQL of one request. Cookies written through `cookieSink()` arrive alongside cookies the handler set.                                                                           | `H-accessor-key`, `H-accessor-cookie-merge`                                              |
| H11 | A Nest controller route that exactly matches a path under `basePath` is served by Nest on every platform. This is consistent precedence and is warned at boot.                                                                                           | `H-app-route-precedence`                                                                 |

#### 4.1.3 Registration

```ts
BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] });
BetterAuthModule.forRoot({
  auth,
  platforms: [expressPlatform(), fastifyPlatform()],
}); // one module, both test matrices
BetterAuthModule.forRoot({ auth, platforms: [honoPlatform()] }); // third party (§4.1.4)
```

- `MountCoordinator` evaluates `supports()` for each listed platform against `HttpAdapterHost.httpAdapter`.
- If the app has an HTTP adapter, exactly one platform must match (B08).
  - Zero matches fails boot with: `No HTTP platform supports the running adapter (getType() = "hono"). Registered: express, fastify. Add platforms: [yourPlatform()].`
  - Two or more matches fail boot too, naming the ambiguous ids.
- The adapter type string appears only in messages; core never branches on it.
- Apps without an HTTP adapter (`createMicroservice`, `createApplicationContext`) never emit `init$`. Mounting is skipped and the platform check does not apply `[B]`.

#### 4.1.4 Worked example: a third-party Hono platform (a server we do not ship)

The target is the community adapter `@kiyasov/platform-hono` 2.0.3. These facts come from its source (R:nest-platform §1.4):

- `getType()` returns `'hono'`.
- It installs a global body-parsing middleware in `initHttpServer`, which runs after `init$` fires.
- `enableCors` is `instance.use(cors(...))`.
- Its `extractClientIp` trusts `x-forwarded-for` and nine other client-controlled headers, so the platform must not use it.

The sketch reuses the Express two-phase pattern `[A]`: capture a bounded copy of the bytes before the adapter's parser, then answer after the user's CORS, deferring any 413 until then `[B]`. It uses only public contracts and the `./platform` helpers. **UNVERIFIED at runtime.** It demonstrates that the contract is sufficient, and the conformance kit is its acceptance gate.

```ts
// package: nestjs-slightly-better-auth-hono (third party)
import type { AbstractHttpAdapter } from "@nestjs/core";
import type { Context, HonoRequest } from "hono";
import type { IncomingMessage } from "node:http";
import {
  defineHttpPlatform,
  type CookieSink,
  type HttpPlatform,
} from "nestjs-slightly-better-auth";
import { readBoundedBody } from "nestjs-slightly-better-auth/platform";

const BYTES = Symbol.for("nsba-hono:bytes");
type Stash = { [BYTES]?: Uint8Array | "too-large" };
const incoming = (c: Context) =>
  (c.env as { incoming?: IncomingMessage } | undefined)?.incoming; // @hono/node-server

export function honoPlatform(
  options: { trustProxy?: (c: Context) => string | null } = {},
): HttpPlatform {
  const sink = (c: Context): CookieSink => ({
    append: (values) => {
      if (c.finalized) return false;
      for (const v of values) c.header("set-cookie", v, { append: true });
      return true;
    },
  });
  const clientIp = (c: Context) =>
    options.trustProxy?.(c) ?? incoming(c)?.socket.remoteAddress ?? null; // socket, not XFF

  return defineHttpPlatform({
    id: "hono",
    supports: (adapter: AbstractHttpAdapter) => adapter.getType() === "hono",

    // Phase 1 (init$): runs before the adapter's global body parser.
    prepare(ctx) {
      ctx.adapter
        .getInstance()
        .use("*", async (c: Context, next: () => Promise<void>) => {
          const raw = c.req.raw;
          const binding = ctx.route(new URL(raw.url).pathname);
          if (
            binding &&
            raw.body &&
            raw.method !== "GET" &&
            raw.method !== "HEAD"
          ) {
            const r = await readBoundedBody(raw.clone().body!, {
              // bounded copy; the parser reads the original
              limit: binding.bodyLimit,
              declaredLength: Number(raw.headers.get("content-length") ?? NaN),
            });
            (c as unknown as Stash)[BYTES] = r.ok ? r.bytes : "too-large";
          }
          await next();
        });
    },

    // Phase 2 (onModuleInit): a real route, registered after main.ts app.use(cors()).
    mount({ adapter, binding }) {
      const app = adapter.getInstance();
      const handler = (c: Context) => {
        const bytes = (c as unknown as Stash)[BYTES];
        if (bytes === "too-large") return binding.payloadTooLarge(); // after CORS: browsers can read it
        const raw = c.req.raw;
        return binding.handle({
          method: raw.method,
          url: raw.url,
          headers: new Headers(raw.headers),
          body: bytes ?? null,
          clientIp: clientIp(c),
          platformRequest: c,
          signal: raw.signal,
        }); // Hono writes Web Responses natively
      };
      app.all(binding.basePath, handler);
      app.all(`${binding.basePath}/*`, handler);
    },

    requests: {
      key: (req) => (req as HonoRequest).raw,
      headers: (req) => new Headers((req as HonoRequest).raw.headers),
      request: (req) => ({
        method: (req as HonoRequest).method,
        url: (req as HonoRequest).raw.url,
      }),
      clientIp: () => null, // guards get HonoRequest; no socket access here
      param: (req, name) => (req as HonoRequest).param(name),
      cookieSink: (_req, res) => (res ? sink(res as Context) : null),
    },
  });
}
// user: BetterAuthModule.forRoot({ auth, platforms: [honoPlatform()] })   — no change to our package
```

The third party runs the kit in its own CI:

```ts
runConformance(
  httpPlatformConformance({
    platform: honoPlatform(),
    createHttpAdapter: () => new HonoAdapter(),
  }),
  { describe, it },
);
```

`H-h2-pseudo` is skipped because the platform declares no `http2` capability. Two cases give the author real signal:

- `H-app-parsing` shows whether the adapter's parser still works for app routes;
- `H-limit-*` checks that the deferred 413 carries CORS headers.

### 4.2 Transport

#### 4.2.1 Contract `[A][B][C]`

```ts
export interface AuthTransport {
  /** Diagnostics only. */
  readonly id: string;
  /** Adapter-owned, side-effect free predicate (e.g. ctx.getType() === 'graphql' plus shape probes). */
  handles(context: ExecutionContext): boolean;
  /** Build the per-call view. Synchronous and side-effect free; headers are computed lazily. */
  describe(context: ExecutionContext, kit: TransportKit): TransportCall;
  /** Turn a denial into what this transport's runtime delivers correctly (thrown by the guard). */
  toException(failure: AuthFailure, context: ExecutionContext): unknown;
  /** Optional boot-time checks (e.g. gateway coverage on Nest 11). */
  validate?(ctx: TransportValidationContext): void | Promise<void>;
}

export interface TransportCall {
  /** Memo identity: the same object for every guard invocation within ONE logical request/operation/message. */
  readonly key: object;
  /** Optional object from ctx.getArgs() where the resolution is stamped for decorators outside the scope (§7.8). */
  readonly carrier?: object;
  /** Credentials as Web Headers. Core then strips any inbound client-IP header and sets it from clientIp. Never throws. */
  headers(): Headers;
  /** Trust-proxy-aware client IP when the transport knows it (HTTP); null otherwise. */
  readonly clientIp: string | null;
  /** null = this transport cannot deliver Set-Cookie: core suppresses session refresh (§7.4). */
  readonly cookies: CookieSink | null;
  /** Method and URL when the transport has them (DPoP-bound tokens need both). */
  readonly request?: { readonly method: string; readonly url: string };
  /** Named input for policies: route param, GraphQL arg, WS/RPC payload field. */
  param(name: string): unknown;
  /** Reuse the principal on this key for this long (connection-level transports). Default 0. */
  readonly principalTtlMs?: number;
}

export interface TransportKit {
  /** Accessor of the running app's HTTP platform (for transports layered on HTTP, e.g. GraphQL); null without one. */
  readonly http: HttpRequestAccessor | null;
}

export interface TransportValidationContext {
  readonly discovery: DiscoveryService;
  readonly reflector: Reflector;
  readonly moduleRef: ModuleRef;
  readonly globalGuard: boolean; // whether BetterAuthGuard is registered as APP_GUARD
  readonly isGuardApplied: (target: Function, method?: string) => boolean; // @UseBetterAuth / @UseGuards(BetterAuthGuard)
  readonly isPublic: (target: Function, method?: string) => boolean;
  readonly logger: LoggerService;
}
```

**Interface segregation** `[B]`. Each core unit reads only its slice:

- the resolver reads `key`, `headers`, `cookies`, `clientIp`, `request` and `principalTtlMs`;
- the evaluator reads `param` and `request`;
- the guard reads `toException` and `carrier`;
- the scope interceptor reads `key` and `cookies`.

A transport author implements one small object.

#### 4.2.2 Invariants

| #   | Invariant                                                                                                                                                                                                                         | Conformance ids                              |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| T1  | `handles` is side-effect free. Exactly one registered transport accepts any context the app produces (first match wins).                                                                                                          | `T-selection`                                |
| T2  | `key` is stable within one logical request and distinct across requests (GraphQL: 3 root fields → 1 resolution). With `principalTtlMs > 0` the key is per connection.                                                             | `T-memo-once`                                |
| T3  | `cookies` is non-null only if a Set-Cookie written through it reaches the client.                                                                                                                                                 | `T-cookie-forwarded`, `T-refresh-suppressed` |
| T4  | `toException` returns the native error that the transport's runtime delivers with `code` and `reason` intact. For HTTP and GraphQL it must be an `IntrinsicException`, so denials are not logged as errors (LEAD-V9, LEAD-EXP-1). | `T-error-shape`, `T-no-error-log`            |
| T5  | `headers()` never throws; missing credentials give empty `Headers`.                                                                                                                                                               | `T-no-credentials`                           |
| T6  | `carrier`, when present, is one of `ctx.getArgs()` and is per-request (never shared across concurrent requests).                                                                                                                  | `T-carrier`                                  |

#### 4.2.3 Registration and selection

```ts
BetterAuthModule.forRoot({
  auth,
  platforms: [fastifyPlatform()],
  transports: [mercuriusTransport(), wsTransport()],
}); // httpTransport() is appended automatically, last
```

- The registry is an ordered list: user transports first, then the built-in `httpTransport()`.
- `select(ctx)` returns the first transport whose `handles(ctx)` is true. To change HTTP error bodies, list a subclass of the HTTP transport; it is selected before the built-in one `[A]`.
- If no transport matches, the guard throws `BetterAuthConfigurationError` (500), naming the context type and the subpath to install. For example: `BetterAuthGuard ran for execution context type 'graphql' but no transport handles it: add apolloTransport() from 'nestjs-slightly-better-auth/graphql'.` It never silently allows `[A][B][C]`.

#### 4.2.4 Third-party sketches

A tRPC-style integration whose guards run through `ExternalContextCreator` with a custom context type `[C]`:

```ts
export const trpcTransport = () =>
  defineTransport({
    id: "trpc",
    handles: (ctx) => ctx.getType<string>() === "trpc",
    describe: (ctx, kit) => {
      const { req, res } = ctx.getArgByIndex<{
        req: IncomingMessage;
        res: ServerResponse;
      }>(0);
      return {
        key: kit.http?.key(req) ?? req, // share the memo with the HTTP request
        carrier: ctx.getArgByIndex(0),
        headers: () => kit.http!.headers(req),
        clientIp: kit.http?.clientIp(req) ?? null,
        cookies: kit.http?.cookieSink(req, res) ?? null,
        request: kit.http?.request(req),
        param: (name) => ctx.getArgByIndex<Record<string, unknown>>(1)?.[name],
      };
    },
    toException: (f) =>
      new TRPCError({
        code:
          f.status === 401
            ? "UNAUTHORIZED"
            : f.status === 429
              ? "TOO_MANY_REQUESTS"
              : "FORBIDDEN",
        message: f.message,
      }),
  });
// BetterAuthModule.forRoot({ auth, transports: [trpcTransport()] })
```

A custom microservice transporter (for example Google Pub/Sub via `CustomTransportStrategy`) is not a new transport. It is a new `RpcCredentialCarrier` for the RPC unit `[A]`:

```ts
const pubsubAttributes: RpcCredentialCarrier = {
  id: "pubsub-attributes",
  matches: (ctx) => ctx.switchToRpc().getContext() instanceof PubSubContext,
  headers: (ctx) => {
    const a = ctx
      .switchToRpc()
      .getContext<PubSubContext>()
      .getMessage().attributes;
    return a.authorization ? { authorization: a.authorization } : undefined;
  },
};
rpcTransport({ carriers: [pubsubAttributes, ...defaultCarriers] });
```

### 4.3 Principal source

#### 4.3.1 Contract `[B][C]`

```ts
export interface AuthPrincipalBase {
  readonly kind: string;
  /** PrincipalSource.id that produced it. */
  readonly source: string;
  /** The better-auth user this principal acts for; null for machine principals. */
  readonly userId: string | null;
}

export interface PrincipalSource<P extends AuthPrincipalBase = AuthPrincipal> {
  readonly id: string;
  /** better-auth plugins this source needs; checked at boot with $context.hasPlugin (B13). */
  readonly requires?: { readonly plugins?: readonly string[] };
  /** Cheap synchronous sniffing (e.g. a header is present). false = skip without I/O. Default: true. */
  appliesTo?(request: PrincipalRequest): boolean;
  /**
   * Denials are values: return authenticated(p), absent() (no credential this source understands) or
   * rejected(failure) (a credential was presented and is invalid). A throw means infrastructure (5xx).
   */
  resolve(request: PrincipalRequest): Promise<PrincipalResult<P>>;
}

export type PrincipalResult<P extends AuthPrincipalBase = AuthPrincipal> =
  | { readonly outcome: "authenticated"; readonly principal: P }
  | { readonly outcome: "absent" }
  | { readonly outcome: "rejected"; readonly failure: AuthFailure };

export interface PrincipalRequest {
  readonly headers: Headers; // hygiene applied (pseudo-headers dropped, client-IP header set)
  readonly cookies: CookieSink | null; // null on cookie-less transports
  readonly transport: string; // TransportCall owner id, informational only
  readonly request?: { readonly method: string; readonly url: string };
  readonly freshness: "default" | "authoritative";
  readonly auth: AuthHandle;
  /** Per-request memo shared with policies (e.g. one verifyApiKey per request: it consumes quota). */
  memo<T>(key: object | symbol, compute: () => Promise<T>): Promise<T>;
}

/** What extensions receive instead of the raw instance. [A][C] */
export interface AuthHandle<A extends AuthLike = AuthLike> {
  readonly name: string;
  readonly instance: A;
  readonly api: A["api"];
  context(): Promise<AuthContextView>;
  hasPlugin(id: string): Promise<boolean>;
  /** userId of a session value: session.userId option, default s => s.user?.id ?? null (customSession, §11.5). */
  userIdOf(session: unknown): string | null;
  /** Run auth.api calls inside a scope: cookie capability, bridge on/off, internal flag (§7.4, §10.4). */
  run<T>(init: ScopeInit, fn: () => Promise<T>): Promise<T>;
}
export interface ScopeInit {
  /** null = cannot write cookies → the plugin suppresses session refresh for every call in fn. */
  readonly cookies: CookieSink | null;
  /** Forward Set-Cookie of direct calls through the plugin's cookie bridge. Default true. */
  readonly bridge?: boolean;
  /** Mark calls as library-internal (HookOptions.skipInternal). Default false. */
  readonly internal?: boolean;
}
/** The subset of better-auth's AuthContext the library reads (structural: any version in range fits). [C] */
export interface AuthContextView {
  readonly baseURL: string;
  readonly options: {
    readonly basePath?: string;
    readonly database?: unknown;
    readonly secondaryStorage?: unknown;
    readonly plugins?: readonly {
      readonly id: string;
      readonly hooks?: { readonly after?: readonly unknown[] };
    }[];
    readonly advanced?: {
      readonly ipAddress?: { readonly ipAddressHeaders?: readonly string[] };
      readonly disableOriginCheck?: boolean;
    };
  };
  readonly sessionConfig: {
    readonly freshAge: number;
    readonly updateAge: number;
    readonly expiresIn: number;
  };
  hasPlugin(id: string): boolean;
  getPlugin(id: string): unknown;
  isTrustedOrigin(
    url: string,
    settings?: { allowRelativePaths: boolean },
  ): boolean;
}
```

#### 4.3.2 Invariants

| #   | Invariant                                                                                                                                                                                                                                                                 | Conformance ids                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| P1  | Invalid presented credentials give `rejected`, never a throw. A throw means infrastructure and maps to 5xx (S6). As a safety net, core normalizes a thrown `APIError` with status 401, 403 or 429 into `rejected` and any other thrown error into infrastructure (§13.2). | `S-rejected-not-thrown`, `S-infra-throws`    |
| P2  | Every better-auth call runs through `auth.api` inside the scope core established. Cookie forwarding and refresh suppression therefore apply automatically.                                                                                                                | `S-cookie-forwarded`, `S-refresh-suppressed` |
| P3  | `absent` has no client-visible side effects.                                                                                                                                                                                                                              | `S-absent-clean`                             |
| P4  | The principal carries `kind`, `source` and `userId`.                                                                                                                                                                                                                      | `S-shape`                                    |

#### 4.3.3 Registration and chain semantics

`principals: [apiKeyPrincipal(), oauthAccessTokenPrincipal()]` is tried in order before the built-in session source. `session: false` removes the built-in source, so an app can place `sessionPrincipal()` anywhere in its own list `[C]`.

- A source whose `appliesTo` returns `false` is skipped.
- The first `authenticated` result wins.
- The first `rejected` result **stops** the chain. A bad API key never falls back to the cookie, matching better-auth's "the api-key header beats the cookie" (R:ba-authz §1.2).
- If every source is `absent`, the result is `absent`.
- Extensions add their principal kind to the union by augmenting `PrincipalKinds` (§11.6).

#### 4.3.4 Third-party sketch: OAuth-provider / MCP access tokens `[A]`

Verification is delegated entirely to better-auth (`verifyAccessTokenRequest`, `CORE/oauth2/verify.ts:619-667`):

```ts
import { verifyAccessTokenRequest } from "better-auth/oauth2";
import {
  AuthFailures,
  absent,
  authenticated,
  definePrincipalSource,
  rejected,
  type AuthPrincipalBase,
} from "nestjs-slightly-better-auth";

export interface OAuthAccessTokenPrincipal extends AuthPrincipalBase {
  readonly kind: "oauth-access-token";
  readonly clientId: string | null;
  readonly scopes: readonly string[];
  readonly claims: Record<string, unknown>;
}
declare module "nestjs-slightly-better-auth" {
  interface PrincipalKinds {
    "oauth-access-token": OAuthAccessTokenPrincipal;
  }
}

export const oauthAccessTokenPrincipal = (
  verifyOptions: VerifyAccessTokenRequestOptions,
) =>
  definePrincipalSource<OAuthAccessTokenPrincipal>({
    id: "oauth-provider:access-token",
    requires: { plugins: ["oauth-provider"] },
    appliesTo: (r) =>
      /^(Bearer|DPoP)\s+[\w-]+\.[\w-]+\.[\w-]+$/i.test(
        r.headers.get("authorization") ?? "",
      ),
    async resolve(r) {
      if (!r.request) return absent(); // DPoP needs method + URL
      try {
        const claims = await verifyAccessTokenRequest(
          {
            authorizationHeader: r.headers.get("authorization"),
            dpopProofJwt: r.headers.get("dpop"),
            method: r.request.method,
            url: r.request.url,
          },
          verifyOptions,
        );
        return authenticated({
          kind: "oauth-access-token",
          source: "oauth-provider:access-token",
          userId: typeof claims.sub === "string" ? claims.sub : null,
          clientId: (claims.azp ?? claims.client_id ?? null) as string | null,
          scopes: String(claims.scope ?? "")
            .split(" ")
            .filter(Boolean),
          claims,
        });
      } catch (e) {
        const failure = AuthFailures.fromAPIError(e); // 401 + WWW-Authenticate challenge
        if (failure) return rejected(failure);
        throw e; // JWKS fetch failure → 5xx
      }
    },
  });
// BetterAuthModule.forRoot({ auth, principals: [oauthAccessTokenPrincipal(opts)] })
```

A JWT-plugin source works the same way. It calls `auth.api.verifyJWT({ body: { token } })` (server-only) and returns `rejected(AuthFailures.rejected({ status: 401, reason: 'INVALID_JWT', challenge: 'Bearer error="invalid_token"' }))` when the token is invalid `[B][C]`.

### 4.4 Authorization policy

#### 4.4.1 Contract `[B][C]`

```ts
export interface AuthorizationPolicy<
  Params = unknown,
  P extends AuthPrincipalBase = AuthPrincipal,
> {
  /** Diagnostic id ('better-auth:admin/permission'); never used for dispatch. */
  readonly id: string;
  readonly requires?: {
    /** better-auth plugin ids validated at boot through $context.hasPlugin (B13). */
    readonly plugins?: readonly string[];
    /** Principal kinds this policy can judge; others are denied 403 PRINCIPAL_NOT_SUPPORTED (data-driven, no core branch). */
    readonly principals?: readonly P["kind"][];
  };
  /** Denials are values. Throw only for infrastructure faults (they become 5xx, never 403). */
  evaluate(
    params: Params,
    context: AuthorizationContext<P>,
  ): AuthorizationDecision | Promise<AuthorizationDecision>;
  /** Optional boot validation of params (e.g. empty permission maps). Throw BetterAuthConfigurationError. */
  validate?(params: Params, boot: PolicyBootContext): void | Promise<void>;
}

/** A policy value, or a provider class/token resolved through ModuleRef (for DI-backed policies). */
export type PolicyRef<Params> =
  | AuthorizationPolicy<Params, any>
  | Type<AuthorizationPolicy<Params, any>>
  | InjectionToken;

export interface Requirement<Params = unknown> {
  readonly policy: PolicyRef<Params>;
  readonly params: Params;
  readonly label?: string; // diagnostics and anyOf messages
}
export type RequirementExpr =
  | Requirement
  | { readonly anyOf: readonly RequirementExpr[] }
  | { readonly allOf: readonly RequirementExpr[] };

export type AuthorizationDecision =
  | { readonly effect: "allow" }
  | {
      readonly effect: "deny";
      readonly status?: 401 | 403;
      readonly reason: string;
      readonly message?: string;
      readonly challenge?: string;
    };

export interface AuthorizationContext<
  P extends AuthPrincipalBase = AuthPrincipal,
> {
  readonly principal: P; // never null: requirements apply only to 'required' access (§7.6)
  readonly instance: string;
  readonly transport: string; // informational only
  readonly headers: Headers;
  readonly cookies: CookieSink | null;
  readonly request?: { readonly method: string; readonly url: string };
  param(name: string): unknown;
  readonly handler: { readonly class: Type; readonly method: string };
  readonly auth: AuthHandle;
  memo<T>(key: object | symbol, compute: () => Promise<T>): Promise<T>;
  readonly execution: ExecutionContext; // escape hatch; prefer the fields above
}

export interface PolicyBootContext {
  readonly auth: AuthHandle;
  readonly context: AuthContextView; // awaited $context: hasPlugin, sessionConfig, options
  readonly site: string; // 'ProjectsController.remove'
}
```

#### 4.4.2 Invariants

| #   | Invariant                                                                                                                                                                                                                                                                                                                                                                   | Conformance ids                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Z1  | A policy returns `deny` for "no" and never throws for it. A throw means infrastructure (5xx).                                                                                                                                                                                                                                                                               | `Z-deny-decision`, `Z-infra-throws` |
| Z2  | better-auth calls run through `context.auth.api` inside the evaluator's scope. Core's safety net maps an `APIError` that escapes a policy: 401 or 403 becomes deny 403 with the better-auth code as `reason` (the principal is authenticated), 429 becomes 429, another 4xx becomes a configuration error (500, logged), and 5xx or a non-API error becomes infrastructure. | `Z-apierror-mapping`                |
| Z3  | Policies are stateless singletons with no request-scoped dependencies.                                                                                                                                                                                                                                                                                                      | `Z-singleton` (B11)                 |
| Z4  | Missing plugin prerequisites fail boot.                                                                                                                                                                                                                                                                                                                                     | `Z-boot-prerequisite`               |

#### 4.4.3 Registration

- **No registry.** A requirement carries its policy by reference in class or method metadata `[B][C]`. Adding a policy never touches core, and the reference survives a dual-package load, because the guard only calls `.evaluate`.
- **Policy values** (`definePolicy(...)`, or any object with `evaluate`) are used directly.
- **Policy classes and tokens** must be providers somewhere in the app. The evaluator resolves them once with `moduleRef.get(ref, { strict: false })` and caches the instance. `BootValidator` resolves every reference it finds on controllers, resolvers and gateways and fails boot if one is missing (B14).

#### 4.4.4 Third-party sketch: a DI-backed "project owner" policy `[C]`

```ts
@Injectable()
export class ProjectOwnerPolicy implements AuthorizationPolicy<{
  param: string;
}> {
  readonly id = "acme:project-owner";
  constructor(@Inject(ProjectsRepo) private readonly projects: ProjectsRepo) {}
  async evaluate({ param }: { param: string }, ctx: AuthorizationContext) {
    const project = await this.projects.findById(String(ctx.param(param)));
    return project?.ownerId === ctx.principal.userId
      ? allow()
      : deny({ reason: "NOT_PROJECT_OWNER" });
  }
}
export const projectOwner = (param = "projectId") =>
  requirement(ProjectOwnerPolicy, { param }, "project owner");
export const RequireProjectOwner = (param?: string) =>
  Require(projectOwner(param));
// @Require(anyOf(projectOwner(), permission({ project: ['update'] })))  — owner OR system permission
```

A role-name policy follows the same pattern. §15.3 gives the recipe and §17 Q1 discusses whether to ship one.

### 4.5 Hooks

#### 4.5.1 Contract

A hook provider is any **singleton** provider. No class marker is needed `[C]`; this follows the idiom of `@nestjs/event-emitter` and `@nestjs/schedule`, and it removes a way to forget a step. Its methods carry `@BeforeAuth(match?, options?)`, `@AfterAuth(match?, options?)`, `@BeforeDatabase('model.op')` or `@AfterDatabase('model.op')`. Method signatures and return semantics are better-auth's own (§10.5):

```ts
type BeforeAuthMethod<P extends string> = (
  ctx: AuthHookContext<P>,
) => unknown | Promise<unknown>;
// before: undefined (continue) | { context: Partial<input> } (merge) | any other object (short-circuit) | throw APIError
type AfterAuthMethod<P extends string> = (
  ctx: AuthAfterHookContext<P>,
) => unknown | Promise<unknown>;
// after:  undefined (keep) | value (replaces ctx.context.returned) | throw APIError (replaces the response)
type BeforeDatabaseMethod<E extends DatabaseHookTarget> = (
  data: DatabaseHookData<E>,
  ctx: GenericEndpointContext | null,
) =>
  | void
  | false
  | { data: Partial<DatabaseHookData<E>> }
  | Promise<void | false | { data: Partial<DatabaseHookData<E>> }>;
type AfterDatabaseMethod<E extends DatabaseHookTarget> = (
  data: DatabaseHookData<E>,
  ctx: GenericEndpointContext | null,
) => void | Promise<void>;
```

Registration is discovery (§10.3). A package only has to be imported. Hooks from independent packages are additive; where order matters, `order` settles it.

#### 4.5.2 Third-party sketch: an audit-log package

```ts
@Injectable()
export class AuditHooks {
  constructor(@Inject(AuditSink) private readonly sink: AuditSink) {}

  @AfterAuth(["/sign-in/email", "/sign-in/social", "/callback/:id"], {
    calls: "http",
  })
  async signedIn(
    ctx: AuthAfterHookContext<
      "/sign-in/email" | "/sign-in/social" | "/callback/:id"
    >,
  ) {
    if (ctx.context.newSession)
      await this.sink.write("sign-in", ctx.context.newSession.user.id);
  }

  @BeforeDatabase("user.delete")
  async beforeUserDelete(user: DatabaseHookData<"user.delete">) {
    await this.sink.write("user-delete-requested", user.id); // return false here would abort the delete
  }
}
@Module({ providers: [AuditHooks, AuditSink], exports: [AuditSink] })
export class AuditModule {} // importing it is the whole integration
```

### 4.6 Auxiliary extension: `http.around` `[A][B][C]`

Raw auth routes bypass Nest interceptors by design. The reference library grew a `middleware` option for ORM request contexts and tracing (`ref/src/auth-module-definition.ts:35-41`). `http.around` is the typed, platform-neutral replacement: a runtime option whose functions receive the Web `Request` and may replace it or short-circuit with a `Response`:

```ts
BetterAuthModule.forRootAsync({
  platforms: [expressPlatform()],
  inject: [MikroORM],
  useFactory: (orm: MikroORM) => ({
    auth,
    http: {
      around: [(call, next) => RequestContext.create(orm.em, () => next())],
    },
  }),
});
```

Interceptors must not log `Cookie` or `Set-Cookie` values. A conformance case checks that the kit's probe cookies never appear in captured logs `[B]`.

## 5. Module configuration

### 5.1 Registration API

`BetterAuthModule` is hand-written; it does not use `ConfigurableModuleBuilder` `[A][B][C]`. Builder extras reach only the transform callback and never a provider. They leak into the options value when their defaults object is empty. An explicit `undefined` overrides a default. Those traps caused reference issues #59, #88 and #159 (R:nest-di §1.2–1.3). The name `BetterAuthModule` avoids colliding with the `AuthModule` most applications already have, and `BetterAuthGuard` avoids `@nestjs/passport`'s `AuthGuard` `[A][B]` (ADR-24).

Three supported shapes, simplest first:

```ts
// (1) Static instance (recommended: the better-auth CLI can load auth.ts; R:ref-issues §3.19)
BetterAuthModule.forRoot({
  auth, // runtime
  platforms: [expressPlatform()], // static
  transports: [apolloTransport(), socketIoTransport()], // static
  principals: [apiKeyPrincipal()], // static (tried before the session)
});

// (2) Static instance, runtime knobs from configuration
BetterAuthModule.forRootAsync({
  platforms: [fastifyPlatform()],
  transports: [mercuriusTransport()],
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    auth,
    http: { bodyLimit: config.get("AUTH_BODY_LIMIT") ?? "1mb" },
    defaultAccess: config.get("AUTH_DEFAULT_ACCESS") ?? "authenticated",
  }),
});

// (3) Instance built from DI (e.g. a Prisma client); types via the factory's return type (no shadow instance, #62/#112)
// auth.ts
export const createAuth = (prisma: PrismaClient) =>
  betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    plugins: [admin(), nestjs()],
  });
declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: ReturnType<typeof createAuth>;
  }
}
// auth.cli.ts (for the better-auth CLI only): export const auth = createAuth(new PrismaClient());
// app.module.ts
BetterAuthModule.forRootAsync({
  platforms: [expressPlatform()],
  imports: [PrismaModule],
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => ({ auth: createAuth(prisma) }),
});
```

### 5.2 Static vs runtime options

| Kind                                     | Fields                                                                                                        | Why                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Static** (`BetterAuthStaticOptions`)   | `name`, `isGlobal`, `globalGuard`, `platforms`, `transports`, `principals`                                    | Each decides which providers, enhancers or exports exist. Nest fixes that when the dynamic module is created. Extensions may be DI classes, which must become providers. |
| **Runtime** (`BetterAuthRuntimeOptions`) | `auth`, `defaultAccess`, `session`, `http.{mount, bodyLimit, around, allowRootMount}`, `errors`, `logSummary` | Read by providers after DI resolution, so they may come from `useFactory`.                                                                                               |

The split is enforced twice `[C]`:

1. **At compile time.** `useFactory` must return `BetterAuthFactoryResult<A>`, which maps every static key to `StaticOptionMustBePassedToForRootAsync<K>`. Returning `{ auth, globalGuard: false }` fails with `Type 'boolean' is not assignable to type 'StaticOptionMustBePassedToForRootAsync<"globalGuard">'` (EXP-C9).
2. **At runtime.** The options provider rejects static keys found in a factory result with `BetterAuthConfigurationError: 'globalGuard' was returned from useFactory; pass it to BetterAuthModule.forRootAsync({ globalGuard, useFactory })`. This covers JavaScript users and `any`.

Toggles users commonly want to drive from configuration are runtime options, so they never hit this wall. Making a whole app public is `defaultAccess: 'public'`, not "remove the guard". Behavior that depends on runtime options is decided at runtime by always-registered providers, following the nestjs-cls pattern (R:nest-di §1.4). For example, the built-in session source is always registered, and `session: false` removes it from the chain when the options resolve.

### 5.3 How the typed instance flows `[A][C]`

```
auth.ts ──typeof auth──► Register augmentation ──► RegisteredAuth / AuthOf<N>
                                                     ├─► AuthSession<N> / AuthUser<N> / AuthPrincipal
                                                     ├─► BetterAuthService (default generic)         [DI: class / BETTER_AUTH_SERVICE]
                                                     ├─► AdminPermissions / OrgPermissions           [decorator arguments]
                                                     ├─► EndpointPath / AuthHookContext<P>           [hook decorators]
                                                     └─► forRoot<A> check: A must be RegisteredAuth for the default instance
forRoot({ auth }) ──infers A──► SessionOption<A> (customSession ⇒ session.userId mapper required)
```

1. `forRoot<A>` infers `A` from `auth`. It gives completion for `session.userId(s: SessionOf<A>)`. When the program has registered an instance, the default-instance overload also requires `A extends RegisteredAuth` (EXP-C2 case 9).
2. For non-generic injection sites and decorators, the user registers the type once with `interface Register { auth: typeof auth }`. Named instances go under `instances: { admin: typeof adminAuth }`.
3. At runtime, `InjectAuth()` resolves `getAuthToken('instance')` to the exact object the user passed, with no wrapper and no proxy. No runtime code reads `$Infer`.
4. Our declarations contain only conditional types over `Register`, evaluated in the user's program. Nothing deeply inferred from better-auth is emitted (§11.7).

### 5.4 Bootstrap validation (fail fast)

All checks run in `onModuleInit` of the internal core module. It is global, so its hooks run before non-global user modules' hooks, and user seeding code never talks to a half-validated instance (R:nest-di §6.4). Errors are **aggregated** `[C]`: one boot reports every problem found, each as a `BetterAuthConfigurationError` with a stable `code` and a copy-paste `hint`. Rows marked _warn_ or _info_ log instead of throwing.

| #   | Check                                                                                                                                                                                                                                                                                     | Source    | Code / message (abridged)                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01 | `auth` looks like a better-auth instance: `handler` is a function, `api.getSession` is a function, `$context` is thenable                                                                                                                                                                 | [A][B][C] | `NOT_AN_AUTH_INSTANCE`: "`auth` must be the object returned by betterAuth(); received an object with keys [...]" (#56)                                                   |
| B02 | `await auth.$context` resolves. A rejection (default secret in production, bad `baseURL`, adapter init) is rethrown with its cause                                                                                                                                                        | [A][B][C] | `AUTH_CONTEXT_FAILED`                                                                                                                                                    |
| B03 | The `nestjs()` plugin is present: `(await $context).getPlugin('nestjs-slightly-better-auth')` has the `Symbol.for(…:bridge)` handle                                                                                                                                                       | [A][C]    | `PLUGIN_MISSING`: "Add nestjs() from 'nestjs-slightly-better-auth/plugin' as the LAST entry of betterAuth({ plugins })"                                                  |
| B04 | Plugin protocol version is compatible                                                                                                                                                                                                                                                     | [B][C]    | `PLUGIN_PROTOCOL_MISMATCH`: "plugin protocol 2 is newer than this module (1); align package versions"                                                                    |
| B05 | _warn_: a plugin after `nestjs()` declares `hooks.after`. Mirrors `warnIfCookiePluginNotLast` (LEAD-V14)                                                                                                                                                                                  | [A][B][C] | `W_PLUGIN_NOT_LAST`                                                                                                                                                      |
| B06 | The instance is not bound by another **live** application (exclusive binding, §10.6)                                                                                                                                                                                                      | [B][C]    | `INSTANCE_ALREADY_BOUND`: "…already bound to a running Nest application. Close it first (await app.close()) or create one instance per app."                             |
| B07 | Instance names are unique in the app, and at most one instance has `globalGuard: true`                                                                                                                                                                                                    | [A][C]    | `DUPLICATE_INSTANCE`, `DUPLICATE_GLOBAL_GUARD`: "BetterAuthModule.forRoot() was imported twice for instance 'default'. Import it once in the root module; it is global." |
| B08 | If the app has an HTTP adapter, exactly one listed platform `supports()` it                                                                                                                                                                                                               | [A][B][C] | `NO_PLATFORM` / `AMBIGUOUS_PLATFORM`                                                                                                                                     |
| B09 | Each platform's `validate(adapter)` passes                                                                                                                                                                                                                                                | [C]       | platform-specific                                                                                                                                                        |
| B10 | Each mount path resolves (§6.2), starts with `/`, and is not `/` unless `allowRootMount`. Instances do not overlap. The server does not already carry a `Symbol.for(…:mounted)` stamp for the same path, which catches a double mount even from a second copy of the library              | [A][B][C] | `INVALID_MOUNT_PATH`, `OVERLAPPING_MOUNTS`, `DUPLICATE_MOUNT`                                                                                                            |
| B11 | Hook providers and class-based extensions or policies are static singletons (`wrapper.isDependencyTreeStatic()`). Discovered non-static instances are prototype-only (R:nest-di §6.3)                                                                                                     | [A][B][C] | `NON_SINGLETON_EXTENSION`                                                                                                                                                |
| B12 | Every hook string pattern exists among the instance's runtime endpoint paths (`auth.api[*].path`, EXP-C8), with a Levenshtein "did you mean". Every hook `instance` names a registered instance                                                                                           | [C]       | `UNKNOWN_HOOK_PATH`: "@BeforeAuth('/sign-up/emial') on SignupHooks.normalize: unknown endpoint. Did you mean '/sign-up/email'?"                                          |
| B13 | Every `requires.plugins` of each referenced policy and each principal source is present (`$context.hasPlugin`)                                                                                                                                                                            | [A][B][C] | `PLUGIN_PREREQUISITE`: "RequireOrgPermission on ProjectsController.remove needs the 'organization' plugin"                                                               |
| B14 | Every policy reference on every controller, resolver and gateway method resolves (object, or `ModuleRef.get`), and `policy.validate()` passes                                                                                                                                             | [B][C]    | `UNRESOLVED_POLICY`                                                                                                                                                      |
| B15 | Plan consistency (§7.6):<br>• `@Public()` or `@OptionalAuth()` with requirements at the same level;<br>• `@Public()` with `@Session()`/`@CurrentUser()`/`@CurrentPrincipal()` on the same handler (hint: use `@OptionalAuth()`);<br>• `@UseAuthInstance(name)` naming an unknown instance | [A][B][C] | `CONTRADICTORY_ACCESS`, `PUBLIC_READS_SESSION`, `UNKNOWN_INSTANCE`                                                                                                       |
| B16 | Each transport's `validate()` passes (for example WebSocket gateway coverage, §9.4)                                                                                                                                                                                                       | [C]       | transport-specific                                                                                                                                                       |
| B17 | _warn_: a Nest controller route falls under an auth base path, so it shadows better-auth on both platforms                                                                                                                                                                                | [A][B][C] | `W_ROUTE_SHADOWS_AUTH`                                                                                                                                                   |
| B18 | _warn_ in production:<br>• the client-IP header is not first in the effective `advanced.ipAddress.ipAddressHeaders` (the user put their own list first);<br>• `clientIpHeader: false` while neither `ipAddressHeaders` nor `trustedProxies` is set, so all clients share one bucket       | [A][B][C] | `W_CLIENT_IP`                                                                                                                                                            |
| B19 | _warn_:<br>• `advanced.disableOriginCheck === true` in production;<br>• `NODE_ENV=test` while `disableOriginCheck` is unset (origin checks are off)                                                                                                                                       | [A][B]    | `W_ORIGIN_CHECK`                                                                                                                                                         |
| B20 | _warn_: a dynamic `baseURL.allowedHosts` without `fallback`, so `auth.handler` throws on a disallowed host                                                                                                                                                                                | [B][C]    | `W_DYNAMIC_HOST`                                                                                                                                                         |
| B21 | _info_, cost hints (R:ba-authz §1.1):<br>• jwt plugin without `disableSettingJwtHeader`;<br>• bearer without `requireSignature`;<br>• `apiKey({ enableSessionForAPIKeys })` (prefer `apiKeyPrincipal()`)                                                                                  | [A]       | `I_COST`                                                                                                                                                                 |
| B22 | _info_: the boot summary line per instance; the hybrid-RPC `inheritAppConfig` reminder                                                                                                                                                                                                    | [A][B][C] | none                                                                                                                                                                     |

```
[BetterAuth] 'default': mounted at /api/auth (all methods, body limit 1 MiB) on fastify, outside global prefix '/v1';
             transports: http, graphql(apollo); principals: api-key → session; hooks: 3 before, 1 after, 2 database;
             default access: authenticated; client IP: platform (x-nsba-client-ip)
```

Plans for B14 and B15 are compiled by scanning every controller and every provider's methods with `DiscoveryService` and `MetadataScanner`. The scan is full, skips alias wrappers, and reads only our own `Symbol.for` metadata keys (R:nest-di §6.2). Handlers in lazily loaded modules are compiled on first use with the same checks. A failure there surfaces as a 500 `AUTH_MISCONFIGURED` response plus an error log, never as a silent allow `[C]`.

### 5.5 Multiple instances `[A][C]`

The stance is one default instance per app, plus any number of **named** instances with explicit routing. Dynamically swappable instances are not supported (§17 Q10).

```ts
@Module({
  imports: [
    BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] }), // 'default', owns the global guard
    BetterAuthModule.forRoot({
      name: "admin",
      auth: adminAuth,
      platforms: [expressPlatform()],
    }), // globalGuard: false by default
  ],
})
export class AppModule {}

@UseAuthInstance("admin") // the (single) guard evaluates this controller against 'admin'
@Controller("admin")
export class AdminController {
  constructor(
    @InjectBetterAuthService("admin")
    private readonly admin: BetterAuthService<AuthOf<"admin">>,
  ) {}
  @Get("me") me(@Session({ instance: "admin" }) s: AuthSession<"admin">) {
    return s.user;
  }
}
// types: declare module '…' { interface Register { auth: typeof auth; instances: { admin: typeof adminAuth } } }
```

- Each instance has its own tokens (`getAuthToken(kind, name)`), its own `nestjs()` plugin binding, and its own mount path from its own `$context`. Mounts must not overlap (B10).
- **Platforms and transports are app-wide.** The app uses the union of every instance's `platforms` and `transports`, de-duplicated by `id`, so listing `expressPlatform()` in each `forRoot` is harmless. One platform serves every instance's mount. **Principal sources and runtime options are per instance.**
- There is one `BetterAuthGuard` and one scope interceptor, both in the static core module. The guard resolves the instance per route from `@UseAuthInstance` metadata (method over class, default `'default'`).
- Metadata keys carry no instance name, so every decorator works for every instance.
- Hooks bind to one instance through `HookOptions.instance` (default `'default'`).
- Memo keys include the instance name, so one request can be authenticated against two instances without confusion.

### 5.6 Double-import safety

`forRoot()` returns a new dynamic module on every call, and Nest identifies modules by reference, so importing it twice creates two modules (R:nest-di §1.3). The documented pattern is one import in the root module; the module is global, and decorators need no import. Three independent defences turn a mistake into a boot error instead of a silently doubled guard:

1. **Name uniqueness** in the app-scoped `InstanceRegistry` (B07) `[A][C]`.
2. **Exclusive plugin binding** (B06) `[B][C]`. The same better-auth instance cannot be bound twice, even from two copies of this library, because the handle lives on the plugin object.
3. **A per-server mount stamp** (B10) `[B]`. `Symbol.for(…:mounted)` on `httpAdapter.getInstance()` catches two mounts of the same path, again even across library copies.

The guard lives in the static core module, which Nest deduplicates by class, so a second `forRoot` can never register it twice. `APP_GUARD` is contributed only by the `forRoot` whose `globalGuard` is true (B07).

### 5.7 Providers and lifecycle `[B][C]`

| Provider                                                                    | Token                                                                                        | Scope     | Module                                 |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------- | -------------------------------------- |
| `BetterAuthGuard`, `BetterAuthScopeInterceptor`                             | class                                                                                        | singleton | core (static, global)                  |
| `InstanceRegistry`, `RequestScope`, `TransportRegistry`, `MountCoordinator` | internal `Symbol.for`                                                                        | singleton | core                                   |
| `PRINCIPAL_RESOLVER` (`ChainPrincipalResolver`)                             | `Symbol.for(…:principal-resolver)`                                                           | singleton | core                                   |
| options, instance, handle                                                   | `getAuthToken('options' \| 'instance' \| 'handle', name)`                                    | singleton | per `forRoot`                          |
| `BetterAuthService`                                                         | class (default instance) + `getAuthToken('service', name)` via `useExisting`                 | singleton | per `forRoot`                          |
| extension providers + registries                                            | `Symbol.for(…:ext:<point>:<name>:<i>)`, `…:transports`, `…:principal-sources`, `…:platforms` | singleton | per `forRoot`                          |
| `APP_GUARD` / `APP_INTERCEPTOR`                                             | `useExisting: BetterAuthGuard` / `BetterAuthScopeInterceptor`                                | —         | the `forRoot` with `globalGuard: true` |

All library constructors put an explicit `@Inject(token)` on every parameter, including `Reflector`, `ModuleRef`, `DiscoveryService`, `MetadataScanner`, `HttpAdapterHost` and `ApplicationConfig` (S5; §12.6). No library provider is request-scoped, because a request-scoped `APP_GUARD` makes every controller request-scoped (R:nest-di §3.3).

**Lifecycle:**

1. **`MountCoordinator` constructor.** It subscribes to `HttpAdapterHost.init$`, a `ReplaySubject`. The callback selects the platform and calls `platform.prepare()`.
   - Under `NestFactory` the callback runs synchronously during `create()`. Under `@nestjs/testing` it runs during `createNestApplication()`. Both are before Nest's body parsers and before `main.ts` code (EXP-C4; R:nest-platform §1.1).
   - Selection cannot happen in the constructor itself, because `httpAdapter` is `undefined` in constructors under `@nestjs/testing`.
   - No adapter (standalone microservice) means no emission, so there is no mount.
2. **`onModuleInit`** of the global core module, which runs first, in this order:
   - B01–B22;
   - hook discovery and exclusive binding;
   - mount path resolution;
   - `platform.mount()` per instance.

   This all happens before Nest registers its 404 handler (EXP-C5).

3. **`onApplicationShutdown`.** Unbind the plugin handles (idempotent). This runs after the HTTP server has stopped accepting requests, so in-flight requests keep their hooks. `onModuleDestroy` would be too early, because `close()` runs destroy → before-shutdown → `dispose()` (closes the adapter) → shutdown (Nest 11.1.17 `core/nest-application-context.js:126-133`) `[C]`.

**Guard registration and overriding.** When `globalGuard` is true, the registration is `providers: [{ provide: APP_GUARD, useExisting: BetterAuthGuard }, { provide: APP_INTERCEPTOR, useExisting: BetterAuthScopeInterceptor }]`. Tests can then call `overrideProvider(BetterAuthGuard)`; that does not work with `useClass` (R:nest-di §9). With `globalGuard: false`, `@UseBetterAuth()` applies both enhancers where needed.

## 6. HTTP integration, per platform

### 6.1 Mount timing in the Nest lifecycle

Core owns the lifecycle and the platform supplies the platform-specific moves (§5.7, `MountCoordinator`). Subscribing to `init$` is the only hook that works under both `NestFactory` and `@nestjs/testing`. Constructor-time registration alone would break tests, because `httpAdapter` is `undefined` in provider constructors there (R:nest-platform §1.1).

| Platform | Step                                                  | Lifecycle point                                          | `NestFactory` 11 / 12                                                                                                | `@nestjs/testing` 11 / 12                         | Why here                                                                                                                                            |
| -------- | ----------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Express  | A: bounded raw capture of auth-route bodies           | `init$` (`prepare`)                                      | inside `create()`, before providers, parsers and `main.ts` middleware                                                | inside `createNestApplication()`, before `init()` | must precede Nest's `jsonParser`/`urlencodedParser` (R:nest-platform §2.3)                                                                          |
| Express  | B: dispatcher (`app.use`, path-checked)               | `onModuleInit` (`mount`)                                 | after parsers, `main.ts` middleware/CORS, `configure()` middleware and controller routes; **before** the 404 handler | same                                              | host CORS, helmet and `app.use` apply to auth routes. Routes registered after `onModuleInit` are hidden by v11's 404 handler (R:nest-platform §2.5) |
| Fastify  | root `onRequest` hook recording `request.raw → reply` | `init$` (`prepare`)                                      | before `ready()`                                                                                                     | before `init()`                                   | lets Apollo-on-Fastify find the reply for cookies (LEAD-V8)                                                                                         |
| Fastify  | encapsulated plugin at `prefix: basePath`             | `onModuleInit` (`mount`, `await instance.register(...)`) | loaded immediately; no `ready()` needed (EXP-B:E10)                                                                  | same                                              | Fastify is order-insensitive until `ready()`; adding routes after `listen()` throws (R:nest-platform §2.4)                                          |

The resulting Express stack was verified on Nest 11.1.17 and 12.0.1 under both bootstraps by EXP-A:`exp-express.mjs`, EXP-B:E1 and EXP-C4/C5:

```
[nest hook] → [A: capture] → cors (enableCors) → user app.use(...) → jsonParser → urlencodedParser
            → consumer middleware → controller routes → [B: dispatch] → 404 → error handler
```

- **Consumer middleware.** `MiddlewareConsumer` middleware, for example a CLS or MikroORM `RequestContext` middleware applied with `forRoutes({ path: '*path', method: ALL })`, wraps the Express dispatcher when there is **no** global prefix (EXP-A:`exp-consumer-mw.mjs`, EXP-C5). With `setGlobalPrefix('v1')` it does not, because Nest mounts consumer middleware under the prefix. `http.around` covers that case (§4.6).
- **Nest 12** does not change any of this. The init order and body-parser timing are the same (R:nest-platform §7.3). The v12 Express 404 prefix-scoping change does not matter, because B runs before the 404 handler on both majors. Raw routes are invisible to v12's `routeConflictPolicy`, which is documented.

### 6.2 Path resolution (S3) `[A][B][C]`

```ts
async function resolveMountPath(auth: AuthLike, allowRoot: boolean): Promise<string> {
  const ctx = (await auth.$context) as AuthContextView;
  const raw = ctx.baseURL
    ? new URL(ctx.baseURL).pathname                 // static baseURL (incl. BETTER_AUTH_URL): its path wins over basePath
    : ctx.options.basePath || '/api/auth';          // unset or dynamic { allowedHosts }: ctx.baseURL === '' (EXP-B:E11)
  const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
  if (!path.startsWith('/') || (path === '/' && !allowRoot)) throw new BetterAuthConfigurationError('INVALID_MOUNT_PATH', …);
  return path;
}
```

- The router uses exactly `new URL(ctx.baseURL).pathname` for a static `baseURL` (`BA/api/index.ts:280`; `BA/utils/url.ts:73-89`).
- For an unset or dynamic `baseURL`, the per-request base path is `options.basePath || '/api/auth'` (`BA/auth/base.ts:51`). EXP-B:E11 verified every configuration style.
- `auth.options.basePath` is **never** read. It is `undefined` by default and wrong when `baseURL` contains a path (R:ba-core §3.7).
- **Matching** is a raw-string prefix test on the undecoded pathname of the original URL, with the query stripped: `p === base || p.startsWith(base + '/')`. It uses no Express or path-to-regexp wildcard syntax, which broke the reference seven times (R:ref-issues cluster 1). Everything below the prefix goes to better-auth, which owns 404, method checks and trailing-slash rules.
- **All methods** are routed, including PUT/PATCH/DELETE (SCIM, oauth-provider), HEAD and OPTIONS. better-auth answers HEAD and OPTIONS with 404 unless host CORS answered the preflight first (R:ba-core §3.1).

### 6.3 Web Request construction (core `AuthExchange`) `[A][B][C]`

`binding.handle(inbound)` does the following, in order:

1. **Body.**
   - GET and HEAD: `null`.
   - A `Uint8Array` is used as-is; the platform has already enforced the limit, and core re-checks `byteLength > bodyLimit` as a guard against a faulty third-party platform.
   - A `ReadableStream` is buffered up to `bodyLimit`. Past the limit the stream is cancelled and the result is `payloadTooLarge()`. This keeps the limit and the 413 in one place for Web-native platforms `[C]`.
2. **URL.** If the instance has a static `baseURL`, the origin is replaced with that origin, so no client-controlled header influences it `[B][C]`. Otherwise the platform's trust-proxy-aware origin is kept, and better-auth applies its own `advanced.trustedProxyHeaders` gate on the untouched `x-forwarded-*` headers (`BA/utils/url.ts:167-190, 270-340`). An unparsable URL, such as a malformed `Host`, yields `400 { code: 'INVALID_REQUEST_URL' }` `[A]`.
3. **Headers.** Copy `inbound.headers`, then:
   - delete hop-by-hop headers (`connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, `te`, `trailer`, `upgrade`), because the body is now a fixed buffer;
   - delete any inbound copy of the client-IP header, for anti-spoofing;
   - set that header from `inbound.clientIp` when it is non-null (§6.8).

   `Origin`, `Referer`, `Sec-Fetch-*`, `Cookie`, `Authorization`, `Content-Type` and `X-Forwarded-*` are never touched (R:ba-core §1.2 P8). Pseudo-headers cannot be present, because `Headers` rejects them and `toWebHeaders` drops them.

4. **`around` chain.** `http.around` functions run outermost-first around step 5 (§4.6).
5. **Dispatch.** `auth.handler(new Request(url, { method, headers, body, signal }))` runs **outside** any `RequestScope`. Router calls carry `_flag === 'router'` anyway, so the cookie bridge and refresh suppression stay inactive, and the Response already carries its cookies.
6. **Errors.** `auth.handler` can throw: on an init failure, on a disallowed dynamic host, or with `onAPIError.throw` (`BA/auth/base.ts:49-109`).
   - If `isAPIError(e)` (never `instanceof`, S6), the result is `Response.json(e.body ?? { message: e.message }, { status: e.statusCode, headers })`. The headers are `e.headers` merged with the hidden `e[Symbol.for('better-call:api-error-headers')]`, which carry cookies set before the throw.
   - Anything else becomes `BetterAuthInfrastructureError(cause)`, which rejects to the platform. The platform routes it to the host error pipeline, so it surfaces as a 5xx logged by Nest's filters.

**Why we do not use `toNodeHandler`, `getRequest` or `setResponse`** `[A][B][C]`:

- they lose the query string under some Express mounts (R:nest-platform §6.1);
- they crash on HTTP/2 pseudo-headers;
- they trust `x-forwarded-proto` unconditionally;
- they re-serialize consumed bodies, which breaks raw-signature endpoints;
- they apply no body limit to chunked requests;
- using them means importing `better-call`, which better-auth pins exactly.

Building the `Request` ourselves also makes body semantics independent of better-call versions: 1.3.2 and 1.4.0 differ (R:ba-core §5.2).

### 6.4 Body strategy (S4)

**Invariant.** Auth routes receive exactly the bytes the client sent, bounded by `bodyLimit` (default 1 MiB). App routes keep Nest-native parsing, including `rawBody: true`, `useBodyParser`, parser limits and Fastify's secure JSON parser. The library never asks for `bodyParser: false` and never replaces the app's parsers (R:ref-issues cluster 2).

#### 6.4.1 Express: two phases `[A][B][C]`

- **Step A**, at `init$`, a path-less `app.use(nsbaCapture)`. It acts only when `ctx.route(rawPath(req.originalUrl))` matches, the method is not GET, HEAD or OPTIONS, and `mayHaveBody(...)` is true. For those requests it calls `readBoundedBody(req, { limit, declaredLength, drainOnOverflow: true })`, stores the result under `req[Symbol.for(…:raw-body)]`, and calls `next()` through `bindAsyncContext`, so any async context that was already active survives the stream callback (EXP-C5). body-parser 2.x skips a finished stream (`body-parser/lib/read.js:40-44`), so Nest's parsers, any `useBodyParser(...)` and any `express.json()` never touch auth bodies. They behave normally for everything else (EXP-B:E1: app routes keep `rawBody`, with and without `useBodyParser`).
- **Overflow.** A declared `content-length` above the limit, or a streamed overflow, sets the flag `'too-large'`. Capture stops buffering and **drains** the rest of the stream so later middleware sees it finished, which is what body-parser itself does before it answers an error (`read.js:132-135, 240-247`). The drain is capped at `drainCap` (default `8 × bodyLimit`, a design choice that has not been measured). Past the cap the socket is destroyed. Step B then answers 413 **after** the host's CORS middleware, so browsers can read it: EXP-B:E1 and EXP-B:E4 showed 413 with ACAO. Answering inside step A returned 413 **without** ACAO (EXP-A:`exp-e2e.mjs`), which is why the flag is deferred `[A][B]`.
- **Step B**, at `onModuleInit`, one `app.use(nsbaDispatch)` per binding. If the path does not match it calls `next()`. Otherwise it builds `InboundAuthRequest` from these parts and writes the Response back (§6.5):
  - `req.method`;
  - `${req.protocol}://${req.host}${req.originalUrl}` (`req.protocol` and `req.host` honor `trust proxy`);
  - `toWebHeaders(req.headers)`;
  - the captured bytes;
  - `options.clientIp?.(req) ?? req.ip`.

  A rejection goes to `next(err)`.

- **Residual caveat** `[B]`. Global middleware that reads the raw stream _without_ checking `isFinished`, such as a hand-written `raw-body` logger, would wait on an ended stream for auth routes. This is documented, and case `H-middleware-order` catches it.

#### 6.4.2 Fastify: an encapsulated `parseAs: 'buffer'` parser `[A]`

```ts
await instance.register(
  async (scope) => {
    scope.removeAllContentTypeParsers(); // this context only; root parsers untouched
    scope.addContentTypeParser(
      "*",
      { parseAs: "buffer", bodyLimit: binding.bodyLimit },
      (_req, body, done) => done(null, body),
    ); // exact bytes as a Buffer; native 413 above the limit
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const response = await binding.handle({
        method: request.method,
        url: `${request.protocol}://${request.host}${request.originalUrl}`, // originalUrl = raw.originalUrl || raw.url
        headers: toWebHeaders(request.raw.headers), // drops HTTP/2 pseudo-headers
        body: request.body instanceof Uint8Array ? request.body : null,
        clientIp: options.clientIp?.(request) ?? request.ip,
        platformRequest: request,
        signal: abortOnClose(request.raw, reply.raw),
      });
      return sendWebResponse(reply, response, request.method === "HEAD"); // §6.6; a rejection → Fastify error handler → Nest filters
    };
    scope.route({
      method: scope.supportedMethods,
      url: "/",
      handler,
      exposeHeadRoute: false,
    });
    scope.route({
      method: scope.supportedMethods,
      url: "/*",
      handler,
      exposeHeadRoute: false,
    });
  },
  { prefix: binding.basePath },
);
```

- **Isolation.** Parsers are copied into child contexts when the plugin loads, so `removeAllContentTypeParsers()` affects only auth routes (R:nest-platform §3.2). App routes keep Nest's parsers, Fastify's secure JSON parser and `rawBody`.
- **Coverage.** A body without `content-type` falls through to the `'*'` parser (LEAD-V10, `content-type-parser.js:119-153`).
- **Limit.** `parseAs: 'buffer'` with `bodyLimit` makes Fastify enforce the limit in its own parser path. It rejects a declared `content-length` above the limit before reading, stops a streamed overflow, and answers `FST_ERR_CTP_BODY_TOO_LARGE` (413, `connection: close`) through `reply.send`. `@fastify/cors` headers therefore survive (LEAD-V10; EXP-A:`exp-e2e.mjs`: 413 with ACAO on Fastify 5.8.2 and 5.12.1).
- **Exactness.** EXP-A:`exp-e2e.mjs` echoed JSON with odd whitespace, UTF-8 over PATCH and multipart byte-for-byte on Nest 11 and 12. Form sign-in succeeds (EXP-B:E4 with the equivalent pass-through variant).
- **Methods.** `supportedMethods` includes HEAD and OPTIONS. `exposeHeadRoute: false` prevents an auto-generated HEAD sibling, which is what triggers Fastify's `reply.send(Response)` HEAD 500 bug (`head-route.js:29`).
- **Why not the alternatives** (ADR-04):
  - a hand-rolled pass-through reader (EXP-B:E4) works but duplicates Fastify's limit logic;
  - a root route with a route-level `onRequest` answering from the hook (EXP-C6) works but runs handler logic in a hook;
  - middie middleware bypasses `@fastify/cors` and `onSend`.

#### 6.4.3 Degraded tier (documented, warned once) `[A][C]`

If a platform finds the stream already consumed before its capture point, it falls back in this order:

1. `req.rawBody` (a Buffer): exact.
2. `req.body` re-serialized for its content type, with `JSON.stringify` or `URLSearchParams`: lossy.

A one-time warning names the cause and the endpoints that break: raw-signature webhooks such as Stripe's, which read `ctx.request.text()` (R:ba-integrations §4). The only known trigger is an Express instance passed to `new ExpressAdapter(app)` that already had `express.json()` attached before `NestFactory.create`. It never happens in the default setup.

#### 6.4.4 Why buffer instead of streaming to better-auth `[A][B]`

Buffering bounded bytes gives:

- a deterministic 413 before better-auth runs, identical on every platform;
- a correct `content-length`;
- no `duplex: 'half'` stream plumbing;
- no half-consumed stream when a before-hook short-circuits.

With a streaming body and an in-flight limit, better-auth logged `SERVER_ERROR: PAYLOAD_TOO_LARGE` before the host could answer (EXP-B:E4). better-auth's endpoints take small bodies; the largest legitimate ones are SAML responses and SCIM documents, well under 1 MiB.

### 6.5 Express write-back

`writeWebResponse(res, response, { head })`, exported from `./platform` for other Node platforms `[A][B]`:

- `res.statusCode = response.status`.
- `res.setHeader(k, v)` for every header except `set-cookie`. For `vary`, merge the union with any value already set (CORS sets `Vary: Origin`). For every other header better-auth's value wins.
- `set-cookie`: append each value from `response.headers.getSetCookie()` to any existing values. Never loop with `setHeader`, which keeps only the last cookie (R:ba-integrations §5 C1).
- HEAD, or a `null` body: `res.end()`.
- Otherwise stream the body with backpressure (`drain`), and cancel the reader on the client's `close`.
- Redirects (302 + `Location`) pass through untouched with their cookies (EXP-B:E4).

### 6.6 Fastify write-back `[A][B][C]`

```ts
function sendWebResponse(
  reply: FastifyReply,
  response: Response,
  head: boolean,
) {
  reply.code(response.status);
  for (const [k, v] of response.headers)
    if (k !== "set-cookie") reply.header(k, v);
  for (const c of response.headers.getSetCookie())
    reply.header("set-cookie", c); // Fastify appends set-cookie
  return reply.send(head ? undefined : (response.body ?? undefined));
}
```

- `reply.send(Response)` is **not** used. It returns 500 for HEAD on routes with an auto-generated HEAD sibling (R:nest-platform §6.3). Unwrapping status, headers and the body stream is the verified workaround, and it keeps `@fastify/cors` headers and `onSend` hooks (EXP-B:E4, EXP-C6).
- `reply.hijack()` and writes to `reply.raw` are never used. They drop `reply.header()` values such as CORS and skip `onSend`.
- The handler is `async`. A rejection takes Fastify's error path (Nest's `setErrorHandler`, then the global filters), so it never hangs, unlike a rejected middie middleware (R:ref-impl §2.3).

### 6.7 Write-back rules common to every platform

| Concern                                 | Rule                                                     | Evidence                                                                    |
| --------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| Multiple `Set-Cookie`                   | read via `getSetCookie()`, append each                   | EXP-B:E4 `["a","b"]` on both platforms                                      |
| Streaming                               | pass `response.body` through with backpressure           | better-auth returns streamed and HTML bodies (`BA/api/dispatch.ts:421-424`) |
| HEAD                                    | status and headers, no body                              | better-auth answers HEAD with 404; the Fastify HEAD bug is avoided          |
| Redirects                               | verbatim 3xx + `Location` + cookies                      | `BC/context.ts:309-312`                                                     |
| Arbitrary content types                 | never re-serialize                                       | oauth-provider, SSO and error pages return raw Responses (R:ba-core §3.6)   |
| Host headers                            | merge, don't clobber (`vary` union, `set-cookie` append) | CORS survives (EXP-B:E4, EXP-A:`exp-e2e`, EXP-C4/C6)                        |
| Nest interceptors, serializers, filters | never involved on auth routes                            | P1/P2                                                                       |

### 6.8 Client IP for rate limiting `[A][B][C]`

better-auth reads the client IP **only from headers**; the default is `x-forwarded-for`. With no usable IP in production, rate limiting falls back to one shared bucket per path, and sign-in is limited to 3 per 10 s for everyone (`CORE/utils/ip.ts:353-383`; `BA/api/rate-limiter/index.ts:342`). A Web `Request` cannot carry the socket address, so the host must supply it. The design splits the job so that proxy trust is configured once, in the platform, for the whole app:

1. **The platform decides trust.** Express `req.ip` honors `app.set('trust proxy', …)`; Fastify `request.ip` honors `trustProxy`. Each platform accepts a `clientIp` override.
2. **The plugin declares the header.** `nestjs()` returns `{ options: { advanced: { ipAddress: { ipAddressHeaders: ['x-nsba-client-ip'] } } } }` from `init()`. better-auth merges plugin options with `defu(userOptions, pluginOptions)` (LEAD-V4), so this is a construction-time _default_, not a mutation (S1). A user-configured list stays first and ours is appended. The merged options feed both the rate limiter and session IP recording (`db/internal-adapter.ts:501`).
3. **Core strips and sets.** `AuthExchange` deletes any client-supplied `x-nsba-client-ip` and sets it from `inbound.clientIp`. For app routes the kernel does the same on `TransportCall.headers()` using `call.clientIp`, so direct `auth.api.signInEmail({ headers })` calls record the right IP. `BetterAuthService.headersFrom(req)` does it too.
4. **Verified end to end.** EXP-A:`exp-e2e.mjs` covers Nest 11/12 × Express/Fastify; EXP-B:E9 and EXP-C7 ran with `NODE_ENV=production`:
   - better-auth sees the trust-proxy-resolved IP;
   - a spoofed `x-nsba-client-ip` is ignored;
   - the third request from one IP gets 429 while another IP gets 200;
   - a user list is kept first: `["cf-connecting-ip","x-nsba-client-ip"]`.
5. **Opt-out.** `nestjs({ clientIpHeader: false })`. The user then configures `advanced.ipAddress` themselves, and B18 warns in production if nothing is configured.

The header name is shared through the plugin's protocol object (`handle.clientIpHeader`), so the plugin option is the single source of truth.

### 6.9 CORS, global prefix and versioning

**CORS stays with the host** `[A][B][C]`. better-auth emits no CORS headers and answers preflight with 404; `trustedOrigins` is its CSRF check, not CORS (R:ba-integrations §0.2). The library configures no CORS. Its job is to make sure host CORS reaches auth routes:

- **Express:** the dispatcher is registered after `enableCors()` and `app.use()`.
- **Fastify:** the auth route is a real Fastify route answered through `reply`, so `@fastify/cors` hooks and preflight apply.

Preflight 204 with ACAO, and ACAO on 200, 302 and 413, were verified on both platforms and both majors (EXP-B:E1/E4, EXP-A:`exp-e2e`, EXP-C4/C6). We never call `enableCors` ourselves: Fastify throws on double registration (#52) and Express would apply it app-wide (#69, #95).

For teams that want CORS to follow better-auth's trusted origins, `betterAuthCorsOrigin(auth)` is a `cors` / `@fastify/cors` origin callback that delegates to `(await auth.$context).isTrustedOrigin(origin)`. It keeps better-auth's wildcard and custom-scheme semantics, the `baseURL` origin, env origins and plugin-contributed origins. It has one limit: a function-valued `trustedOrigins(request)` cannot be evaluated without a request, so the helper throws at first use with a hint to supply your own `origin` function `[C]`. That is safer than silently using init-time values.

**Global prefix and versioning** `[A][B][C]`. Auth routes live at better-auth's own path, outside `setGlobalPrefix` and `enableVersioning`, because raw platform routes are subject to neither (R:nest-platform §5).

- There is one source of truth: better-auth's client, OAuth callbacks and `trustedOrigins` all derive from `baseURL`/`basePath`.
- To serve auth under `/v1`, set better-auth's `basePath: '/v1/api/auth'` or put the path in `baseURL`.
- We read `ApplicationConfig.getGlobalPrefix()`, a public API, only for the boot summary. We never mutate `ApplicationConfig`, because a later `setGlobalPrefix(p, opts)` would overwrite it (R:nest-platform §2.5).
- This fixes the reference's `/api/api/auth` regressions (PR #80) by construction.

### 6.10 Error handling on auth routes

| Source                                                               | Result                                                                                                                                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| better-auth Response (any status, redirect, stream)                  | verbatim                                                                                                                                                                                             |
| `APIError` thrown out of `auth.handler`                              | its Response: status, JSON body, `headers` + hidden `better-call:api-error-headers` (Set-Cookie appended)                                                                                            |
| Body over limit                                                      | `413 { code: 'PAYLOAD_TOO_LARGE', message }`, after host middleware (Express flag) or through Fastify's reply lifecycle                                                                              |
| Unparsable URL                                                       | `400 { code: 'INVALID_REQUEST_URL', message }`                                                                                                                                                       |
| Any other throw (init failure, disallowed dynamic host, adapter bug) | `BetterAuthInfrastructureError` → host error pipeline (Express `next(err)`, Fastify rejected handler) → Nest's global filters → 500, logged (R:nest-platform §4.5 exp 9; EXP-C5). Never 401/403 (S6) |
| Client disconnects mid-exchange                                      | `signal` aborts; the write is abandoned without error logs                                                                                                                                           |

### 6.11 HTTP/2

Pseudo-headers and the HTTP/2 symbol key are dropped by `toWebHeaders`, and `host` is set from `:authority` when absent, so HTTP/2 does not crash the exchange. Fastify's `request.host` falls back to `:authority`. `FastifyPlatform` declares `capabilities.http2`, and the kit runs `H-h2-pseudo` against `new FastifyAdapter({ http2: true })`. Express has no HTTP/2 server in Nest.

## 7. Authentication (principal resolution)

Authentication answers "who is calling". It produces an `AuthPrincipal`, a discriminated union over the augmentable `PrincipalKinds`. Authorization (§8) answers "may they" and never re-resolves identity.

### 7.1 Guard flow `[A][B][C]`

```
BetterAuthGuard.canActivate(ctx)
 ├─ transport = transports.select(ctx)           // first handles(ctx); none → BetterAuthConfigurationError (500), never allow
 ├─ plan      = planner.get(ctx)                 // cached per handler: instance, access, requirements, freshness, readsSession
 ├─ kernel    = instances.get(plan.instance)
 ├─ call      = transport.describe(ctx, kit)     // sync, no I/O; headers lazy
 ├─ if plan.access === 'public':
 │     stamp(call, plan.instance, { outcome: 'absent', skipped: 'public' }); return true         // zero auth I/O
 ├─ result = await resolver.resolve(call, kernel.handle, plan.freshness)                          // memoized (7.2)
 ├─ stamp(call, plan.instance, result)
 ├─ result.outcome === 'rejected'      → throw transport.toException(result.failure, ctx)         // never downgraded
 ├─ result.outcome === 'absent'        → plan.access === 'optional' ? return true
 │                                                                   : throw toException(AuthFailures.unauthenticated())
 ├─ plan.readsSession && principal.kind !== 'session' → throw toException(forbidden('SESSION_REQUIRED'))  // 7.8
 ├─ decision = await evaluator.evaluate(plan.requirements, principal, call, kernel)               // memoized per request
 │     deny → throw transport.toException(failureOf(decision), ctx)
 └─ return true
 (infrastructure errors propagate as BetterAuthInfrastructureError: 5xx on every transport)
```

The guard **never returns `false`**. A `false` return makes Nest throw an HTTP `ForbiddenException` on every transport, which Mercurius, WS and RPC then mis-deliver (R:nest-di §3.4, §5). The guard always throws the transport-native error.

### 7.2 Resolver contract and memoization (S7) `[A][B][C]`

The port is in §2.2.2. The default `ChainPrincipalResolver` works as follows:

- **Key.** `(call.key, instance, freshness)`. Storage is `WeakMap<object, RequestState>` inside the singleton `RequestScope`. There is no module-level state and no DI request scope.
- **The promise is stored before it settles** `[A][B]`. GraphQL runs the guard once per root field, three times for three root fields in one request (R:nest-di §3.4; EXP-B:E8: 3 guard calls → **1** resolution). Concurrent invocations share one `getSession`. A rejection is memoized for the same key too, so every root field fails the same way and a failing database sees no retry storm.
- **Chain.** Resolution runs inside `handle.run({ cookies: call.cookies, internal: true }, …)`. That makes every nested better-auth call cookie-aware and refresh-suppressed where needed (§7.4), and marks it internal for hooks (§10.4). The sources run in order: skip those whose `appliesTo` is false, stop at the first `authenticated` or `rejected`, and return `absent` if none applies (§4.3.3).
- **TTL entries.** When `call.principalTtlMs > 0` (WS or subscription connections), the entry lives on the connection key with an `expiresAt` and is re-resolved after it.
- **`peek(key, instance)`** returns the settled result without I/O. The scope interceptor and decorators use it.

| Transport                            | Memo key (`call.key`)                                                                                           | Carrier (stamp fallback, §7.8)                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| HTTP (Express, Fastify, third-party) | the platform's `requests.key(req)` (Express `req`; Fastify `request.raw`)                                       | the Nest request object (`args[0]`)                                                    |
| GraphQL query/mutation               | the underlying HTTP request key, **shared with the HTTP transport**                                             | the GraphQL context (`args[2]`), one per operation                                     |
| GraphQL subscription                 | the subscription context object                                                                                 | the GraphQL context                                                                    |
| WebSocket (socket.io, ws)            | the per-message `args` array (shared by all guards of a message, LEAD-V7); the socket when `principalTtlMs > 0` | **none**: decorators read the scope (the socket would race across concurrent messages) |
| RPC                                  | `switchToRpc().getContext()` (one object per message; gRPC: the per-call `Metadata`)                            | the same object                                                                        |

### 7.3 Built-in session source (S2) `[A][B][C]`

```ts
export const sessionPrincipal = <S = AuthSession>(
  options: SessionPrincipalOptions<S> = {},
) =>
  definePrincipalSource<SessionPrincipal>({
    id: "better-auth:session",
    async resolve(r) {
      const ctx = await r.auth.context();
      const stateful = Boolean(
        ctx.options.database || ctx.options.secondaryStorage,
      ); // mirrors hasServerSessionStore
      const query: { disableCookieCache?: true; disableRefresh?: true } = {};
      if (r.freshness === "authoritative" && stateful)
        query.disableCookieCache = true; // stateless: the cookie IS the session
      if (r.cookies === null) query.disableRefresh = true; // belt; the plugin's skip flag is the braces (7.4)

      let result: { headers: Headers; response: unknown };
      try {
        // bridge: false → this call's cookies are forwarded exactly once, through returnHeaders (no bridge duplicate)
        result = await r.auth.run(
          { cookies: r.cookies, bridge: false, internal: true },
          () =>
            r.auth.api.getSession({
              headers: r.headers,
              returnHeaders: true,
              query,
            }) as Promise<{ headers: Headers; response: unknown }>,
        );
      } catch (e) {
        const failure = AuthFailures.fromAPIError(e); // 401/403/429 (bad x-api-key, failed refresh, api-key rate limit)
        if (!failure) throw e; // ≥500 or non-APIError → infrastructure (S6)
        const cleanup = apiErrorSetCookies(e); // e.headers + hidden better-call:api-error-headers
        if (r.cookies && cleanup.length) r.cookies.append(cleanup);
        return rejected(failure);
      }
      if (r.cookies) {
        const setCookie = result.headers.getSetCookie(); // ONLY set-cookie: never cache-control / pragma
        if (setCookie.length) r.cookies.append(setCookie);
      }
      if (result.response == null) return absent();
      const userId = r.auth.userIdOf(result.response); // default s.user?.id; customSession → session.userId option
      return authenticated({
        kind: "session",
        source: "better-auth:session",
        userId,
        session: result.response as S,
      });
    },
  });
```

- **`returnHeaders: true`** keeps the refresh and cookie-cache `Set-Cookie`s that a plain call drops. There are 9 code paths (R:ba-core §4.3). EXP-C1's baseline with `updateAge: 0` emits `session_token`. It works for `customSession` too, because it is a dispatch-level feature (`BA/api/dispatch.ts:467-477`).
- **Only `set-cookie` is forwarded.** `getSession` also returns `cache-control: no-store` and `pragma: no-cache`, which must not leak onto app responses (R:ba-core §4.3). EXP-A:`exp-e2e.mjs` verified one `session_token` and `cache-control=null` on a guarded route on all four platform × major combinations.
- **Credential translation happens inside `getSession`.** Bearer, api-key session mocks (`enableSessionForAPIKeys`), jwt side effects, multi-session and `customSession` all take effect through better-auth's own hooks, so the source never parses credentials (R1).
- **`authoritative`** bypasses the cookie cache only when a server-side store exists. That mirrors better-auth's own authoritative read (`BA/api/routes/session.ts:520-539`) `[C]`.

### 7.4 Cookie forwarding and refresh suppression per transport capability (S2)

`getSession` emits `Set-Cookie` on 9 code paths (R:ba-core §4.3). Two of them move server or cookie state:

- **row 7, sliding refresh:** the DB `expiresAt` is extended and `session_token` is re-set;
- **row 4, stateless refresh-cache:** `session_data` is re-issued and `session_token` is re-set, with no DB write.

If the cookie cannot be delivered, the browser cookie expires before the server session, which is the drift better-auth works to avoid (`BA/api/state/should-session-refresh.ts:3-10`; `nextCookies`). Where the transport can deliver cookies, they are forwarded. Where it cannot, the refresh itself is suppressed, not just its cookies dropped.

| Transport                                                                       | `call.cookies`                                                                                                               | Session source call             | Refresh                                   | Forwarded to client                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------- |
| HTTP controller (Express, Fastify, third-party)                                 | platform sink                                                                                                                | `returnHeaders: true`           | normal                                    | `set-cookie` only                                                      |
| GraphQL query/mutation over HTTP (Apollo, Mercurius)                            | the HTTP sink: Express `req.res`; Fastify `requests.responseFor(req)` (root `onRequest` map, LEAD-V8); Mercurius `ctx.reply` | same                            | normal                                    | `set-cookie` only                                                      |
| GraphQL subscription                                                            | `null`                                                                                                                       | + `disableRefresh`, + skip flag | **suppressed**                            | none                                                                   |
| WebSocket (socket.io, ws)                                                       | `null`                                                                                                                       | same                            | **suppressed**                            | none                                                                   |
| RPC (all carriers)                                                              | `null`                                                                                                                       | same                            | **suppressed**                            | none                                                                   |
| Direct `auth.api.*` in a handler or service (under the scope interceptor, §7.5) | the handler's transport sink or `null`                                                                                       | the user's call                 | normal (bridge forwards) / **suppressed** | `set-cookie` via the plugin bridge                                     |
| Direct call outside any scope (cron, queue worker, bootstrap seeding)           | none                                                                                                                         | the user's call                 | better-auth default                       | none. Use `returnHeaders`, or `service.withoutCookies(fn)` to suppress |

**How suppression works** `[A][B][C]`. It is construction-time plugin behavior, following the `nextCookies` precedent. The `nestjs()` plugin registers one before-hook:

- **matcher:** `ctx._flag !== 'router' && binding?.current()?.cookies === null`;
- **handler:** `await setShouldSkipSessionRefresh(true)`.

This is the only public way to set that flag. It lives in better-auth request state, which exists only inside a better-auth dispatch. `better-auth/api` exports the setter (LEAD-V2) but not `runWithRequestState`, which lives in `@better-auth/core/context`. A before-hook runs inside the dispatch's own store, so the flag lands exactly where `getSession` reads it (EXP-C1: "plugin skip-refresh set-cookie: []").

**Stateless refresh-cache branch.** Without a database or secondary storage, better-auth force-enables `cookieCache` with `refreshCache` (`BA/context/create-context.ts:104-116`). That branch checks **only** `getShouldSkipSessionRefresh()` (`BA/api/routes/session.ts:199-204`, LEAD-V3). `query.disableRefresh` returns early only later (`:309`), so on its own it does **not** stop the branch. EXP-A:`exp-plugin.mjs` and EXP-B:E2 show this:

- control, `disableRefresh` only: `session_data` and `session_token` emitted;
- with the skip flag: none emitted.

The session source still passes `disableRefresh: true` on cookie-less calls as a belt, because it also skips rows 6 and 9 (a pointless cookie-cache write).

**Why any path, not just `/get-session`.** `nextCookies` suppresses only on `/get-session` (LEAD-V14), but plugin endpoints that read the session internally slide it too. Policies call `hasPermission` and `getActiveMember`, for example. EXP-B:E3, re-run by A and C:

- without a scope, `getActiveMember` emits `session_token` and moves the DB expiry;
- inside a cookie-less scope, neither happens.

The matcher therefore covers every non-router call made inside a cookie-less scope.

**Cleanup cookies** (rows 1, 2, 3 and 5: expire a stale cache or delete an invalid token) are still computed by better-auth. On cookie-less transports they are dropped harmlessly, and the next cookie-capable request cleans up again.

**The plugin is mandatory** (B03). Without it the stateless branch and nested plugin-endpoint refreshes could not be suppressed, and service-level cookie forwarding would silently differ. That would be two behavior modes users cannot see (ADR-02).

### 7.5 Direct `auth.api.*` calls in application code `[A][C]`

`BetterAuthScopeInterceptor`, a global `APP_INTERCEPTOR` registered with `useExisting`, handles each handler invocation:

1. It selects the transport and builds `call` (sync).
2. It opens `RequestScope.run({ cookies: call.cookies, bridge: true, internal: false, resolutions }, …)` around the _subscription_ to `next.handle()`:

```ts
intercept(ctx: ExecutionContext, next: CallHandler) {
  const scope = this.scopes.forExecution(ctx);                     // null when no transport handles ctx
  return scope ? new Observable((sub) => scope.run(() => next.handle().subscribe(sub))) : next.handle();
}
```

Nest invokes the handler and its param factories inside the interceptor chain (`router-execution-context.js:40-46`; WS: LEAD-V7), and `InterceptorsConsumer` binds each step with `AsyncResource`. So `await auth.api.signInEmail({ body })` in a controller, or in a service it calls, gets its `Set-Cookie` forwarded to the HTTP response through the plugin's after-hook, with no `returnHeaders` plumbing.

- The after-hook's **matcher** is `ctx._flag !== 'router' && scope.cookies !== null && scope.bridge !== false`.
- Its **handler** appends `ctx.context.responseHeaders.getSetCookie()` to the sink.

EXP-A:`exp-e2e.mjs` verified this on Nest 11/12 × Express/Fastify with `bridgeLogin: 201 … set-cookie=better-auth.session_token`, and EXP-C1 with `signOut`. The same scope makes direct calls in cookie-less handlers (WS, RPC) refresh-suppressed.

- **Why an interceptor rather than a platform-level scope opened at `init$`** (drafts B, C; ADR-11):
  - it is transport-neutral;
  - it runs after body parsing;
  - it gives param decorators a race-free source on WebSockets, where the per-message `args` array is not visible to param factories (LEAD-V7);
  - it keeps the platform contract small.

  An early scope would survive Express parsing (LEAD-V11), but it would cover HTTP only.

- **Coverage gaps, documented.** Code in middleware and in other libraries' guards runs outside the scope. So do Nest 11 gateways without `@UseBetterAuth()` (LEAD-V6) and GraphQL field resolvers (their continuations run outside the root resolver's scope). Such code can use `service.withoutCookies(fn)` or its own `returnHeaders`. Decorators there fall back to the carrier stamp (§7.8).
- **Opting out.** A controller that deliberately manages cookies itself, for example by proxying `asResponse: true`, wraps the call in `service.runOutsideScope(fn)` `[C]`.
- **Committed responses.** If a handler has already sent the response itself (`@Res()` plus a manual send), the sink reports `false`. The bridge then logs one debug line and drops the cookies.

### 7.6 Public, optional and required semantics `[A][B][C]`

**Plan compilation** (`RoutePlanner`, cached per handler):

1. Read the access decorator (`@Public` / `@OptionalAuth` / `@RequireAuth`) and the requirements at the **method** level and at the **class** level. For the class level, use the own metadata of each class in the prototype chain, most-derived first.
2. **Same-level contradiction** fails boot (B15). `@Public()` or `@OptionalAuth()` together with requirements at the same level is contradictory: an anonymous caller can never satisfy a principal requirement.
3. **Effective access** is decided by the closest level that says anything:
   - the method's access decorator; else
   - `'required'` if the method has requirements; else
   - the class's access decorator; else
   - `'required'` if the class has requirements; else
   - `defaultAccess`.
4. **Effective requirements.** If access is `'required'`, they are class requirements (base first) followed by method requirements, in declaration order. Otherwise there are none. A method-level `@Public()` or `@OptionalAuth()` is therefore an explicit, visible opt-out of class-level requirements (§17 Q3).
5. **Freshness** is `'authoritative'` if `@RequireAuth({ authoritative: true })` is present at the effective level, or `session.freshness` says so.

| Effective access               | Principal I/O | No credentials        | Presented but invalid credential (e.g. bad `x-api-key`)        | Infrastructure failure | `@Session()`          |
| ------------------------------ | ------------- | --------------------- | -------------------------------------------------------------- | ---------------------- | --------------------- |
| `required` (default)           | yes           | 401 `UNAUTHENTICATED` | denial with better-auth's status and `reason`                  | 5xx                    | `AuthSession`         |
| `optional` (`@OptionalAuth()`) | yes           | allowed               | **denial** (a bad credential is never downgraded to anonymous) | 5xx                    | `AuthSession \| null` |
| `public` (`@Public()`)         | **none**      | allowed               | not inspected                                                  | cannot happen (no I/O) | boot error B15        |

`@Public()` doing zero I/O fixes reference issue #159: health probes no longer return 500 when the database is down. It also means a bad API key on a public route consumes no quota (R:ba-authz §4.2 #5). `@OptionalAuth()` is the "attach the session if present" mode. `BetterAuthService.getSession()` remains available to public handlers that explicitly ask for it.

### 7.7 Error semantics (S6)

| Situation                                                                                                 | Result                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No principal on a required route                                                                          | 401 `UNAUTHENTICATED`                                                                                                                                    |
| A source returns `rejected` (for example `APIError` 401/403 from `getSession` hooks: `INVALID_API_KEY`)   | that status; `code` `UNAUTHENTICATED` (401) or `FORBIDDEN` (403); `reason` = better-auth code; cleanup cookies forwarded where possible; the chain stops |
| `APIError` 429 during resolution (api-key rate limit; every `getSession` counts, R:ba-authz §1.2)         | 429 `RATE_LIMITED`, `Retry-After` passed through                                                                                                         |
| `APIError` ≥ 500, `BetterAuthError`, DB or network errors, anything else                                  | `BetterAuthInfrastructureError` → 5xx, logged once with its cause; **never 401/403**                                                                     |
| Configuration faults met at request time (unknown transport; `customSession` without `userId` at runtime) | `BetterAuthConfigurationError` → 500                                                                                                                     |
| Public route during a DB outage                                                                           | unaffected (never resolves)                                                                                                                              |

Detection is always `isAPIError` from `better-auth/api`, which accepts both `APIError` classes and `name === "APIError"` (LEAD-V5). It is never `instanceof`, because better-call's CJS and ESM copies have different classes (R:ba-core §4.2).

**Known upstream limitation** (risk RK2). `customSession` catches errors from its inner `getSession` and returns `null` (`BA/plugins/custom-session/index.ts:100-107`). For such apps a storage outage therefore looks like "no session" (401) instead of a 5xx. We cannot fix this without reimplementing `getSession`, which R1 forbids. It is documented, and we will propose an upstream change.

### 7.8 Accessing the principal

**Param decorators are synchronous** (async factories only work without pipes, R:nest-di §4.3). `@Session()`, `@CurrentUser()` and `@CurrentPrincipal()` look up the resolution for their instance in this order:

1. **The scope** opened by `BetterAuthScopeInterceptor`, which holds the resolutions `peek()`ed for this invocation. It is race-free on every transport `[L]`.
2. **The carrier stamp** `[A]`: scan `ctx.getArgs()` for `Symbol.for(…:resolution)` (a `Map<instance, PrincipalResult>`). This covers HTTP, GraphQL (including field resolvers outside the root scope) and RPC when the interceptor is not applied. WS has no carrier on purpose.
3. **Otherwise** throw `BetterAuthConfigurationError('No authentication result for SiteController.method: BetterAuthGuard did not run (globalGuard: false without @UseBetterAuth(), or a Nest 11 gateway without @UseBetterAuth()).')`. This surfaces reference issue #12 as a clear error instead of an `undefined`.

**What each decorator returns:**

- `@Session()` returns the session for a `session` principal, or `null` on an optional route with no principal. It **implies a session principal** `[C]`: the planner marks `readsSession`. With extra principal sources configured, an API-key caller reaching a handler that reads `@Session()` gets 403 `SESSION_REQUIRED` from the guard instead of a `null` typed as `AuthSession`.
- `@CurrentUser()` behaves the same way and returns `session.user`.
- `@CurrentPrincipal()` returns `AuthPrincipal | null` and has no kind constraint.

**Services** use `BetterAuthService.getPrincipal()` or `getSession()`. Inside a scope these resolve lazily through the same memo, so calling them in a guarded handler costs nothing extra. Outside any scope they return `null`.

### 7.9 Cost per protected request

- **Session resolution.** One `getSession` per request, shared by all guard invocations, decorators and services. That is 0 storage reads on a cookie-cache hit, otherwise 1 read, plus 1 write when a refresh is due (R:ba-authz §1.0).
- **Public routes.** Zero.
- **Multipliers,** surfaced as boot _info_ hints (B21):
  - the jwt plugin without `disableSettingJwtHeader: true` signs a JWT and reads `jwks` on every `getSession`;
  - bearer without `requireSignature: true` pays a lookup for foreign tokens;
  - `apiKey({ enableSessionForAPIKeys: true })` counts every `getSession` against the key's rate limit (default 10/day). Prefer `apiKeyPrincipal()` (§8.3).

## 8. Authorization

### 8.1 Model `[A][B][C]`

A handler declares **requirements**: values that carry their **policy** by reference (§4.4). After the principal is known, the evaluator judges them. Each policy is a thin adapter over a better-auth API. The evaluator owns composition only.

- **AND across the plan.** Class requirements (base class first) come before method requirements, in declaration order. Evaluation is sequential and stops at the first deny, which gives a deterministic cost and a deterministic error.
- **`anyOf(a, b, …)`.** Children are evaluated in order and the first allow wins. If every child denies, the status is 401 if any child denied with 401, otherwise 403. The `reason` is the first child's, and the `message` lists the children's labels `[C]`.
- **`allOf(…)`.** An explicit AND group, useful inside `anyOf`.
- **Principal kinds.** If `policy.requires.principals` is set and the principal's kind is not listed, the requirement denies with 403 `PRINCIPAL_NOT_SUPPORTED`. This is data-driven: the evaluator compares strings the policy supplied, never a kind core knows about. An example is an API-key principal on an organization-permission route.
- **Scope.** Every policy call runs inside `handle.run({ cookies: call.cookies, bridge: true, internal: true }, …)`. On cookie-capable transports, cookies produced by nested better-auth calls reach the client through the bridge. On cookie-less transports, refresh is suppressed (§7.4; EXP-B:E3).
- **Memoization.** Decisions are memoized per request by requirement object identity, so a requirement shared by several GraphQL root fields, or re-run by a second guard binding, is evaluated once `[C]`.
- **Errors (S6).** Policies return decisions and never throw to deny. For third-party policies that let a better-auth error escape, the safety net (Z2) maps it:
  - `APIError` 401 or 403 becomes deny **403** with the better-auth code as `reason`, because the principal is already authenticated;
  - 429 becomes 429;
  - another 4xx becomes `BetterAuthConfigurationError` (500, logged), because our own call was malformed;
  - ≥ 500 or a non-API error becomes infrastructure (5xx).

  The reference library turned every error into 403 (R:ref-impl §6.1), which is exactly what S6 forbids.

### 8.2 Decorators and composition

```ts
@Require(freshSession()) // class: every handler needs a fresh session
@Controller("billing")
export class BillingController {
  @RequirePermission({ billing: ["read"] }) // AND with the class requirement
  @Get()
  list() {}

  @Require(
    anyOf(
      permission({ billing: ["refund"] }),
      orgPermission(
        { billing: ["refund"] },
        { organization: fromParam("orgId") },
      ),
    ),
  )
  @Post(":orgId/refund")
  refund() {} // system admin OR org-level refund right

  @Public() @Get("status") status() {} // explicit opt-out of the class requirement (§7.6)
}
```

- **Stacking accumulates.** Each requirement decorator **appends** `RequirementExpr`s to its target's _own_ metadata array instead of overwriting it. Plain `SetMetadata` overwrites, and the reference's `getAllAndOverride` model lost class requirements (R:ref-impl §6.1) `[A]`.
- **Reading.** The planner reads the own metadata of every class in the prototype chain (base first), then the handler. A subclass cannot silently drop a base-class requirement. It always stores arrays, which avoids `getAllAndMerge`'s nested-array behavior for mixed types (R:nest-di §3.2).
- **Sugar.** `@RequirePermission(p)` is `@Require(permission(p))`. Third parties get both forms through `definePolicy` (value policies) or `requirement(Class, params)` (DI policies) plus `Require(...)`.

### 8.3 Built-in policies (each an extension unit)

| Requirement / decorator (subpath)                                                             | Delegates to                                                                                                                                                                                                                                                 | Principal                                                                                                  | Cost per request (R:ba-authz §2)                                                                                                                                      | Deny mapping                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freshSession({ maxAgeSeconds })` / `@RequireFreshSession()` (core) `[A][C]`                  | Mirrors `freshSessionMiddleware`: `freshAge = maxAgeSeconds ?? $context.sessionConfig.freshAge`; deny when `now - session.createdAt >= freshAge*1000`; `freshAge === 0` disables the check (LEAD-V3)                                                         | `session` (a `customSession` shape without `session.createdAt` → `PRINCIPAL_NOT_SUPPORTED` + boot warning) | 0 I/O (`createdAt` is immutable, so a cookie-cached session is accurate)                                                                                              | 403 `SESSION_NOT_FRESH` (better-auth's own code)                                                                                                                                                |
| `permission(p)` / `@RequirePermission(p)` (`./admin`) `[A][B][C]`                             | `auth.api.userHasPermission({ body: { userId: principal.userId, permissions } })` **without headers**                                                                                                                                                        | any kind with `userId` (else 403 `USER_REQUIRED`)                                                          | 1 user read: a fresh role from the user row; honors `adminUserIds`, `defaultRole`, custom roles and multi-role rules exactly (`BA/plugins/admin/routes.ts:1864-1894`) | `{ success: false }` → 403 `MISSING_PERMISSION`                                                                                                                                                 |
| `permission(p, { freshness: 'session' })` (`./admin`) `[C]`                                   | same, with `body.role = session.user.role`                                                                                                                                                                                                                   | `session`                                                                                                  | 0 reads; the role may be cookie-cache stale up to `cookieCache.maxAge`                                                                                                | same                                                                                                                                                                                            |
| `orgPermission(p, { organization })` / `@RequireOrgPermission` (`./organization`) `[A][B][C]` | `auth.api.hasPermission({ headers, body: { organizationId?, permissions } })`                                                                                                                                                                                | `session` (the endpoint needs a session)                                                                   | 1 session (cookie cache allowed) + 1 member + 1 role read with dynamic access control                                                                                 | `success: false` → 403 `MISSING_PERMISSION`. `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` (better-auth returns 401) → 403 with that reason. `NO_ACTIVE_ORGANIZATION` (400) → 403 with that reason |
| `orgMember({ organization })` / `@RequireOrgMember()` (`./organization`) `[A][C]`             | `auth.api.getActiveMemberRole({ headers, query: { organizationId? } })`. It checks membership in the given org (default: the active org) and returns `{ role }` (`BA/plugins/organization/routes/crud-members.ts:1083-1130`)                                 | `session`                                                                                                  | 1 session + 1 member                                                                                                                                                  | `YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION` (403) → 403 with that reason; `NO_ACTIVE_ORGANIZATION` (400) → 403 with that reason                                                                 |
| `apiKeyPermission(p)` / `@RequireApiKeyPermission` (`./api-key`) `[A][C]`                     | `role(principal.permissions).authorize(p)` from `better-auth/plugins/access` (LEAD-V15), the same primitive `verifyApiKey` uses internally (`packages/api-key/src/routes/verify-api-key.ts:116-131`), applied to the record the API-key source verified once | `api-key`                                                                                                  | 0 I/O                                                                                                                                                                 | 403 `MISSING_PERMISSION`                                                                                                                                                                        |

**Notes:**

- **Admin permissions and headers.** The admin policy deliberately omits `headers`. With headers, better-auth evaluates the session user and ignores `body.userId` and `body.role`, at the cost of an extra authoritative session read (R:ba-authz §2.1). The reference's `@UserHasPermission({ userId, role })` options were silently ignored for exactly this reason.
- **Plural `permissions`.** Requirement builders always send `permissions`. The deprecated singular `permission` key gives a 400 on the admin endpoint and a silent `false` on the org endpoint. Empty permission maps are rejected by `validate()` at boot.
- **Organization refs:**
  - `activeOrganization()`, the default, omits `organizationId` so better-auth uses the session's active organization;
  - `fromParam('orgId')` reads `call.param`: a route param, GraphQL arg, or WS/RPC payload field;
  - `fromHeader('x-organization-id')` reads a header;
  - any function is accepted.

  A ref that returns `undefined` when no organization can be determined yields 403 `ORGANIZATION_REQUIRED`. A present `activeOrganizationId` alone does not prove membership, because removed members keep it (R:ba-authz §1.2). The endpoint call is what checks.

- **Param decorators.** The resolved organization id and member role are memoized per request and exposed through `@ActiveOrganizationId()` and `@ActiveMemberRole()`. These are valid after an org requirement ran, and return a `string`, never `undefined`. That fixes reference issue #163 without type gymnastics `[C]`.
- **API keys.** `apiKeyPrincipal()` calls `auth.api.verifyApiKey({ body: { key, configId? } })` **once per request**, memoized through `r.memo`. Every call consumes quota, and calling it after `getSession` with the same `x-api-key` would double-consume (R:ba-authz §4.2). An invalid key yields `rejected(401 INVALID_API_KEY)`. The principal never exposes the raw key.

Deliberately **not** shipped:

- **A presence-only "active org" check.** It is unsafe; see above.
- **The pure (in-process) org `hasPermission` export.** It saves the session read but writes to an unbounded process-global role cache (R:ba-authz pitfalls). Revisit after measuring (§17 Q9).
- **Role-name decorators.** better-auth has no "has role" API (§8.6).

### 8.4 Freshness (cookie cache) stance `[A][B][C]`

- **Identity** honors whatever cookie-cache policy the user configured in better-auth: 0 storage reads on a hit, staleness up to `cookieCache.maxAge` (default 300 s). That is better-auth's own performance/staleness trade-off, and it belongs in `auth.ts`.
- **Authorization data** is read fresh wherever better-auth reads it fresh: the admin policy reads the user row, and the org policies read member rows. Promotions and demotions take effect immediately even with the cookie cache on. This matches better-auth's own admin endpoints, which bypass the cache (`BA/plugins/admin/routes.ts:33-46`).
- **Session revocation** is only as fresh as the cookie cache, as in better-auth. Routes that must see a revocation immediately use `@RequireAuth({ authoritative: true })`. It passes `disableCookieCache: true` to the identity read, and only when a server-side store exists. It is one read, not two, because the plan's freshness keys the memo `[C]`. The same can be set globally with `session: { freshness: 'authoritative' }`.

### 8.5 Plugin-prerequisite validation

1. **At compile time** (registered programs). `AdminPermissions` and `OrgPermissions` are derived from the plugin endpoints' body types, which better-auth computes from the user's access-control statements. Unknown resources or actions are compile errors. If the registered instance lacks the plugin, the argument type is `never` and the decorator cannot be called (EXP-C2 cases 3, 4, 8; EXP-A:`types/`) `[A][C]`.
2. **At boot** (B13). The evaluator collects `requires.plugins` from every referenced policy and every principal source and checks `$context.hasPlugin(id)`. That check accounts for plugins added through `init`. A missing plugin fails boot and lists the affected handlers. The reference instead feature-detected per request with `typeof auth.api.x === 'function'` and returned 403 via `console.error` (R:ba-authz §4.2 #9) `[A][B][C]`.

### 8.6 Stance on role decorators `[B][C]`

v1 has no built-in `@Roles()`. better-auth has no "has role" API and steers users to access-control permissions. A faithful role check would have to reproduce comma splitting without trimming, `defaultRole`, `adminUserIds`, `creatorRole`, and the rule that grants are not combined across roles. Otherwise it silently diverges, and the reference's `@Roles` diverges on all of these (R:ba-authz §4.2 #2–3). Permission requirements are the better-auth way and are fully typed.

§15.3 shows a short `definePolicy` recipe for teams that need role names now. Draft A recommended shipping an exact-mirror role policy as an opt-in export of `./admin`. That is a genuine product trade-off, recorded as §17 Q1.

## 9. Transports

Every transport is an extension unit implementing `AuthTransport` (§4.2). The guard, resolver, evaluator and error taxonomy are identical for all of them. Transports differ only in context extraction, cookie capability and error delivery, as better-auth's own integrations imply (R:ba-integrations §9.4). D2's breadth costs one small object per transport and never a branch in core `[B]`.

### 9.0 Matrix

| Transport (unit)                | `handles`                                                                            | Memo key                                                                     | Credentials                                                                                           | Cookies                                             | Denial thrown                                            | Guard reaches it via                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| HTTP (`httpTransport()`, root)  | `getType() === 'http'`                                                               | platform `requests.key(req)`                                                 | platform `requests.headers(req)`                                                                      | platform sink                                       | `HttpException` subclass + payload (§13)                 | `APP_GUARD` (11 and 12)                                                                                                |
| GraphQL Apollo (`./graphql`)    | `getType() === 'graphql'` and the context has no Mercurius `reply`/`_connectionInit` | query/mutation: the HTTP request key; subscription: the subscription context | query/mutation: HTTP request headers; subscription: upgrade headers + allow-listed `connectionParams` | query/mutation: the HTTP sink; subscription: `null` | `BetterAuthGraphqlDenial` (intrinsic, `extensions.code`) | `APP_GUARD` on root fields (`@ResolveField` needs `fieldResolverEnhancers: ['guards']`)                                |
| GraphQL Mercurius (`./graphql`) | `getType() === 'graphql'` and the context has `reply` or `_connectionInit`           | query/mutation: `req.raw`; subscription: the connection context              | `req.headers`; subscriptions via `mercuriusSubscriptionContext()`                                     | `gql.reply` / `null`                                | same                                                     | same                                                                                                                   |
| socket.io (`./websockets`)      | `getType() === 'ws'` and the client has `handshake`                                  | per-message `args` (the socket with a TTL)                                   | `handshake.headers` + `credentials(client)`                                                           | `null`                                              | `WsException`                                            | Nest 11: `@UseBetterAuth()` (global enhancers never reach gateways, LEAD-V6); Nest 12: `APP_GUARD` + `APP_INTERCEPTOR` |
| ws (`./websockets`)             | `getType() === 'ws'` and the client carries `UPGRADE_REQUEST`                        | same                                                                         | recorded upgrade headers                                                                              | `null`                                              | `WsException`                                            | same                                                                                                                   |
| RPC (`./microservices`)         | `getType() === 'rpc'` and a carrier `matches`                                        | `switchToRpc().getContext()`                                                 | first matching carrier                                                                                | `null`                                              | `RpcException` (gRPC: numeric status)                    | standalone: `APP_GUARD`; hybrid: `inheritAppConfig: true` (R:nest-di §3.4)                                             |

### 9.1 HTTP (built-in, root entry)

```ts
describe(ctx, kit) {
  const http = ctx.switchToHttp();
  const req = http.getRequest(), res = http.getResponse();
  const a = kit.http!;                                    // B08 guarantees a platform when an HTTP adapter exists
  return { key: a.key(req), carrier: req, headers: () => a.headers(req), clientIp: a.clientIp(req),
           cookies: a.cookieSink(req, res), request: a.request(req), param: (n) => a.param(req, n) };
}
```

- **Cookies.** Express uses `res.append('set-cookie', v)` and Fastify uses `reply.header('set-cookie', v)`, both appending. The sink returns `false` once headers are sent. EXP-B:E7 showed guard-appended cookies arriving alongside handler-set cookies on both platforms and both majors.
- **Denial.** An `HttpException` subclass: `UnauthorizedException`, `ForbiddenException` or `HttpException(…, 429)`. It carries the payload `{ statusCode, error, code, reason?, message }`, which is Nest's default body shape plus a stable `code`; reference issue #148 asked for this. These are `IntrinsicException`s, so Nest does not log them (LEAD-V9). A `challenge` is written as `WWW-Authenticate` through Nest's public `httpAdapter.setHeader(res, …)`. `Retry-After` is copied for 429.
- **Infrastructure.** `BetterAuthInfrastructureError` (not intrinsic) goes through Nest's filters, which answer 500 and log it.

### 9.2 GraphQL: Apollo and Mercurius (`./graphql`)

**Shared behavior** `[A][B][C]`:

- `gql = GqlExecutionContext.create(ctx)`. The operation kind comes from `gql.getInfo().operation.operation`.
- **Queries and mutations share the HTTP request's memo.** The key is `kit.http.key(gql.getContext().req)`, so three root fields resolve the principal once (EXP-B:E8), and a sliding refresh on a GraphQL POST reaches the browser as `Set-Cookie`.
- **Cookie sink.** Mercurius uses `gql.getContext().reply`. Apollo on Express uses `req.res`. Apollo on Fastify uses `kit.http.responseFor(req)`, because the Apollo driver keeps only the request in its Fastify context (LEAD-V8); `FastifyPlatform.prepare` records `request.raw → reply` in a `WeakMap` from a root `onRequest` hook.
- **The carrier** is the GraphQL context object (`args[2]`), one per operation. Field resolvers without guards still read the stamp.
- **`param(name)`** reads the resolver args first, then the route params.
- **Denial.** `BetterAuthGraphqlDenial extends IntrinsicException` carries `extensions: { code: 'UNAUTHENTICATED' | 'FORBIDDEN' | 'RATE_LIMITED', reason?, statusCode }` `[L]`. graphql-js copies `originalError.extensions` into the formatted error (`graphql` 16 `error/GraphQLError.js:130-143`), so the code survives on both drivers. The HTTP status stays 200, the GraphQL-over-HTTP norm for field errors. LEAD-EXP-1 on Apollo showed:
  - the codes are preserved for 401, 403 **and 429**;
  - Nest logs nothing.

  The alternatives each fail somewhere. A plain `GraphQLError` (drafts A and C) is logged at ERROR on every denial, because it is not intrinsic. An `HttpException` (draft B) has its `extensions.code` rewritten by Apollo's `autoTransformHttpErrors`, so 429 becomes `INTERNAL_SERVER_ERROR` (LEAD-V8).

- **Infrastructure.** `BetterAuthInfrastructureError` is not intrinsic, so Nest logs it. Its `extensions.code` is `INTERNAL_SERVER_ERROR` and its message is generic ("Authentication service unavailable"), so infrastructure details never reach GraphQL clients.
- **Guard coverage.** The global guard covers root query, mutation and subscription resolvers. `@ResolveField` resolvers skip guards unless `fieldResolverEnhancers: ['guards']` is set (R:nest-di §3.4). Requirements on field resolvers are enforced only then, and the docs say so.
- **Versions.** `@nestjs/graphql` 13 serves Nest 11 and 14 serves Nest 12. Version 14 removed `subscriptions-transport-ws`, so only `graphql-ws` is supported.

|                          | Apollo (`apolloTransport()`)                                                                                                                                                                                                                                                                             | Mercurius (`mercuriusTransport()`)                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Query/mutation request   | `gql.req`; the driver guarantees `req` (`apollo-base.driver.js:196-216`)                                                                                                                                                                                                                                 | `gql.req` (Nest's default `(req) => ({ req })`), else `gql.reply.request`                                                                                                                                                                         |
| Query/mutation response  | Express `req.res`; Fastify `responseFor(req)`                                                                                                                                                                                                                                                            | `gql.reply`                                                                                                                                                                                                                                       |
| Subscription credentials | graphql-ws context `{ connectionParams, extra: { request } }` wrapped as `req`. Headers = `toWebHeaders(extra.request.headers)` + `connectionParams` keys in `connectionParamHeaders` (default `authorization`, `cookie`), or `subscriptionCredentials(ctx)`. **UNVERIFIED at runtime** (R:nest-di §4.2) | `gql._connectionInit` payload + the upgrade request exposed by `mercuriusSubscriptionContext()` under a `Symbol.for` key. **UNVERIFIED at runtime**; Mercurius subscriptions ship as _preview_ until `T-subscription-credentials` passes (§17 Q7) |
| Subscription cookies     | `null`, refresh suppressed                                                                                                                                                                                                                                                                               | `null`, refresh suppressed                                                                                                                                                                                                                        |
| Subscription lifetime    | the guard runs once per subscription start, not per event; revalidation during a long-lived subscription is out of scope for v1 (§17 Q11)                                                                                                                                                                | same                                                                                                                                                                                                                                              |

### 9.3 WebSockets: socket.io and ws (`./websockets`)

**Credentials:**

- **socket.io** `[A][B][C]` takes them from `client.handshake.headers`. The handshake is an HTTP request, so it carries cookies for same-site browsers or with `withCredentials`. Then `credentials(client)` adds more, for example `handshake.auth.token` → `authorization: Bearer <token>` for the `bearer()` plugin. The default mapping copies `handshake.auth.token` when no `authorization` header exists.
- **ws** `[B][C]` has a problem: the bare `WebSocket` has no headers, and the upgrade request is passed only to the `connection` event (`@nestjs/platform-ws` `adapters/ws-adapter.js:144`). `withUpgradeRequest(Base)` is a mixin over any `WsAdapter` subclass. It overrides `bindClientConnect(server, cb)` and records `{ headers: toWebHeaders(request.headers), url, remoteAddress }` on the client under `UPGRADE_REQUEST` before delegating. A mixin composes with users' own adapters (Redis, custom) and needs no `@nestjs/platform-ws` import. Custom adapters call `recordUpgradeRequest(client, request)` directly.

  ```ts
  app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app)); // main.ts
  ```

  A guarded message from a client without a recorded request throws `BetterAuthConfigurationError`, which includes this snippet.

**Memo, revalidation and decorators.**

- `principalTtlMs: 0` is the default `[A][C]`. Each guarded message resolves once, memoized across the guards of that message through the shared `args` array (LEAD-V7), with no writes, because refresh is suppressed.
- `principalTtlMs > 0` caches per socket for chat-style traffic. The docs state the revocation delay this implies.
- Param decorators read the resolution from the scope interceptor. The socket is deliberately **not** used as a carrier, because concurrent messages on one socket would race (§7.8).

**Guard behavior by Nest major** (LEAD-V6, R:nest-di §3.4 runtime table):

|                                                            | Nest 11 | Nest 12                                                 |
| ---------------------------------------------------------- | ------- | ------------------------------------------------------- |
| `APP_GUARD` runs for `@SubscribeMessage` handlers          | **no**  | yes                                                     |
| `APP_INTERCEPTOR` wraps them                               | **no**  | yes                                                     |
| An `HttpException` thrown by a guard reaches the client as | n/a     | `{ status: 'error', message: 'Internal server error' }` |
| Global exception filters apply to gateways                 | no      | no                                                      |

**Design consequences** `[C]`, with draft A's portable alternative recorded in ADR-18:

1. The WS transports always throw `WsException({ status: 'error', statusCode, code, reason, message })` themselves. `BaseWsExceptionFilter` emits an object payload as-is, and filters never reach gateways (R:nest-di §5.2).
2. **Nest 12 with `globalGuard: true`** needs nothing more; the global guard and interceptor cover gateways.
3. **Nest 11, or `globalGuard: false`**: gateways need `@UseBetterAuth()`, which applies the guard and the scope interceptor. The WS transports' `validate()` (B16) does this:
   - it detects whether global enhancers reach gateways with a capability probe: `typeof AbstractHttpAdapter.prototype.mapException === 'function'` is true only on Nest 12 (LEAD-V12);
   - it enumerates gateway classes through Nest's `'websockets:is_gateway'` class metadata (not publicly exported, LEAD-V13; pinned by a CI test on both majors);
   - it fails boot (`gatewayCoverage: 'error'`) for any gateway that has neither `@Public()` nor `@UseBetterAuth()` at class level or on every `@SubscribeMessage` method. The message reads: "ChatGateway is not protected: on NestJS 11 global guards do not apply to WebSocket gateways. Add @UseBetterAuth() (or @Public() to opt out)."

   An inconclusive probe is treated as "not covered", which fails closed. This turns the reference's silent hole (R:ref-impl pitfalls) into a boot error.

4. **Nest 12 with `@UseBetterAuth()` and a global guard** runs the guard twice. That is harmless: the second call hits the per-message memo. It is logged at _info_ because it is common in libraries that support both majors.
5. **Connection-time authentication** `[B]`. Guards never run on connect (`handleConnection` is never guarded). `WsConnectionAuth` resolves the principal with refresh suppressed and caches it on the client for `principalTtlMs`:

   ```ts
   @WebSocketGateway()
   @UseBetterAuth()
   export class ChatGateway implements OnGatewayInit {
     constructor(
       @Inject(WsConnectionAuth) private readonly wsAuth: WsConnectionAuth,
     ) {}
     afterInit(server: Server) {
       server.use(this.wsAuth.socketIoMiddleware({ required: true }));
     } // socket.io
   }
   // ws: in handleConnection(client) { if (!(await this.wsAuth.authenticate(client))) client.close(4401, 'UNAUTHENTICATED'); }
   ```

6. **`param(name)`** reads `switchToWs().getData()?.[name]`.

### 9.4 Microservices / RPC (`./microservices`) `[A][B][C]`

RPC messages have no cookies; credentials travel in transport metadata. `rpcTransport({ carriers })` uses the first carrier whose `matches(ctx)` is true (default: `defaultCarriers`):

| Carrier                             | Matches                                                             | Credential source (headers copied into `Headers`)                                                                |
| ----------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `grpcCarrier()`                     | `getArgByIndex(1)` is a gRPC `Metadata` (duck-typed `get`/`getMap`) | metadata entries (`authorization`, `cookie`, `x-api-key`)                                                        |
| `natsCarrier()`                     | the context has `getHeaders()`                                      | NATS message headers                                                                                             |
| `kafkaCarrier()`                    | the context has `getMessage().headers`                              | Kafka headers (Buffer values decoded as UTF-8)                                                                   |
| `rmqCarrier()`                      | the context has `getMessage().properties`                           | `properties.headers`                                                                                             |
| `mqttCarrier()`                     | the context has `getPacket()`                                       | MQTT 5 `userProperties` (MQTT 3 has no headers)                                                                  |
| `payloadCarrier({ field: 'auth' })` | the payload has an object at `field`                                | `data.auth` (TCP and Redis carry no headers). The docs warn this is weaker: credentials are visible to every hop |

- **Credentials** are ordinary better-auth credentials: `authorization: Bearer <session token>` with the `bearer()` plugin, a `cookie` header, or `x-api-key`. `getSession` and `apiKeyPrincipal()` work unchanged. Forwarding browser cookies between services is discouraged.
- **Memo key and carrier:** `switchToRpc().getContext()`, one object per message. **Cookies:** `null`, so refresh is suppressed.
- **Denial:** `new RpcException({ status: 'error', statusCode, code, reason, message })`. `BaseRpcExceptionFilter` passes an `RpcException` object through as-is and turns anything else into "Internal server error".
- **gRPC:** the carrier's `toException` returns `RpcException({ code: 16 | 7 | 8, message })` (UNAUTHENTICATED, PERMISSION_DENIED, RESOURCE_EXHAUSTED). On Nest 12, if `@nestjs/microservices` exports `GrpcUnauthenticatedException` / `GrpcPermissionDeniedException`, the carrier uses them. That is feature-detected by export presence inside the RPC unit, not in core. **UNVERIFIED at runtime** on Nest 11 (grpc-js reads `code` from the error object).
- **Guard registration.** Standalone microservices apply `APP_GUARD`. Hybrid apps apply it only with `connectMicroservice(options, { inheritAppConfig: true })`; otherwise use `@UseBetterAuth()` on message controllers. The boot summary prints this reminder when the RPC transport is registered in an app that also has an HTTP adapter.
- **`param(name)`** reads `switchToRpc().getData()?.[name]`.

### 9.5 Summary: guard reach, cookie capability, error delivery

| Transport                                  | Global guard reaches it                          | Cookies | Refresh    | Denial                                                       |
| ------------------------------------------ | ------------------------------------------------ | ------- | ---------- | ------------------------------------------------------------ |
| HTTP controllers (Express, Fastify)        | 11 ✓ / 12 ✓                                      | ✓       | normal     | `HttpException` + payload                                    |
| GraphQL query/mutation (Apollo, Mercurius) | 11 ✓ / 12 ✓ (root fields)                        | ✓       | normal     | `BetterAuthGraphqlDenial` (`extensions.code`)                |
| GraphQL subscription                       | 11 ✓ / 12 ✓ (at subscribe)                       | ✗       | suppressed | `BetterAuthGraphqlDenial`                                    |
| WS socket.io / ws                          | 11 ✗ (→ `@UseBetterAuth()`, boot-checked) / 12 ✓ | ✗       | suppressed | `WsException({ status, statusCode, code, reason, message })` |
| RPC standalone                             | 11 ✓ / 12 ✓                                      | ✗       | suppressed | `RpcException` / gRPC status                                 |
| RPC hybrid                                 | only with `inheritAppConfig`                     | ✗       | suppressed | same                                                         |

## 10. Hooks

### 10.1 Why a plugin (S1) `[A][B][C]`

The reference library wraps `auth.options.hooks.before/after` and `databaseHooks` _after_ `betterAuth()` has run. That works only because `ctx.options` is a shallow copy that shares the nested objects, which is why users had to pre-declare `hooks: {}` (R:ref-impl §5.2; reference issues #42 and #103; PR #138 broke it with `{ source, hooks }`). The wrappers also drop return values, so `{ context }` rewrites, short-circuits and DB `false`/`{ data }` all stop working.

better-auth's documented alternative is a plugin:

- plugin `hooks.before/after` are **arrays of matcher + handler** (`CORE/types/plugin.ts:89-100`);
- plugins contribute database hooks through `init() → { options: { databaseHooks } }` (LEAD-V4);
- the docs say "if you need to reuse a hook across multiple endpoints, consider creating a plugin" (`docs/concepts/hooks.mdx:326-328`).

`betterAuth()` cannot take plugins after construction (R:ba-core §2.1), so the user adds `nestjs()` in `auth.ts`. Nest-discovered hooks bind to it late, through a registry. Nothing in `auth.options` is ever written.

### 10.2 The plugin (`./plugin`)

```ts
// imports only better-auth/api and defu — never @nestjs/*, never node:* (runtime-agnostic; CI-enforced)
import {
  createAuthMiddleware,
  isAPIError,
  setShouldSkipSessionRefresh,
} from "better-auth/api";

const HANDLE = Symbol.for("nestjs-slightly-better-auth:bridge");

/** Versioned protocol object on the plugin instance; core finds it via (await auth.$context).getPlugin(id)[HANDLE]. [B][C] */
export interface BridgeHandle {
  readonly protocol: 1; // checked by core (B04)
  readonly clientIpHeader: string | null; // single source of truth for the header name (§6.8)
  readonly bound: boolean;
  /** Returns unbind. Throws INSTANCE_ALREADY_BOUND if another live app is bound (B06). */
  bind(binding: BridgeBinding): () => void;
}
export interface BridgeBinding {
  readonly owner: string; // app description for the B06 message
  /** View of the kernel's RequestScope; the plugin never owns an AsyncLocalStorage. [C] */
  current(): ScopeView | undefined;
  readonly before: readonly CompiledHook[]; // sorted by order, then discovery order
  readonly after: readonly CompiledHook[];
  readonly database: Readonly<
    Record<
      DatabaseHookTarget,
      {
        readonly before: readonly DbBeforeFn[];
        readonly after: readonly DbAfterFn[];
      }
    >
  >;
}
export interface ScopeView {
  readonly cookies: CookieSink | null;
  readonly bridge: boolean;
  readonly internal: boolean;
}
export interface CompiledHook {
  /** Never throws: a throwing user predicate is recorded and re-thrown by run() as APIError INTERNAL_SERVER_ERROR,
   *  mirroring better-auth's matcher-exception semantics (BA/api/dispatch.ts:146-163). */
  matches(ctx: HookEndpointContext, scope: ScopeView | undefined): boolean;
  run(ctx: HookEndpointContext): Promise<unknown>;
}

export function nestjs(options: NestjsPluginOptions = {}) {
  let binding: BridgeBinding | null = null;
  const scope = () => binding?.current();
  const isRouter = (ctx: object) =>
    "_flag" in ctx && (ctx as { _flag?: string })._flag === "router";
  const clientIpHeader =
    options.clientIpHeader === false
      ? null
      : (options.clientIpHeader ?? "x-nsba-client-ip");
  const handle: BridgeHandle = {
    protocol: 1,
    clientIpHeader,
    get bound() {
      return binding !== null;
    },
    bind(b) {
      if (binding)
        throw new Error(`INSTANCE_ALREADY_BOUND: bound to ${binding.owner}`);
      binding = b;
      return () => {
        if (binding === b) binding = null;
      };
    },
  };
  return {
    id: "nestjs-slightly-better-auth",
    [HANDLE]: handle,
    init: () => ({
      options: {
        databaseHooks: createDatabaseDispatchers(() => binding), // 4 models × 3 ops × before/after (§10.6)
        ...(clientIpHeader
          ? { advanced: { ipAddress: { ipAddressHeaders: [clientIpHeader] } } }
          : {}), // default; user wins (§6.8)
      },
    }),
    hooks: {
      before: [
        {
          // 1. refresh suppression: every non-router endpoint dispatched from a cookie-less scope (§7.4)
          matcher: (ctx) => !isRouter(ctx) && scope()?.cookies === null,
          handler: createAuthMiddleware(async () => {
            await setShouldSkipSessionRefresh(true);
          }),
        },
        {
          // 2. Nest @BeforeAuth dispatcher
          matcher: (ctx) =>
            binding?.before.some((h) => h.matches(ctx, scope())) ?? false,
          handler: createAuthMiddleware((ctx) =>
            runBefore(binding!, ctx, scope()),
          ),
        },
      ],
      after: [
        {
          // 3. Nest @AfterAuth dispatcher
          matcher: (ctx) =>
            binding?.after.some((h) => h.matches(ctx, scope())) ?? false,
          handler: createAuthMiddleware((ctx) =>
            runAfter(binding!, ctx, scope()),
          ),
        },
        {
          // 4. cookie bridge for direct auth.api calls (nextCookies pattern); last, so it also sees cookies Nest after-hooks set
          matcher: (ctx) => {
            const s = scope();
            return !isRouter(ctx) && !!s?.cookies && s.bridge;
          },
          handler: createAuthMiddleware(async (ctx) => {
            const setCookie = ctx.context.responseHeaders?.getSetCookie() ?? [];
            if (setCookie.length) scope()!.cookies!.append(setCookie);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
```

- **Entry order** follows `nextCookies` (`BA/integrations/next-js.ts:47-144`):
  - Suppression runs before any Nest before-hook. Nested `auth.api` calls made inside a hook share the dispatch's request state and inherit the flag.
  - The cookie bridge runs after the Nest after-hooks, so it also forwards cookies they set with `ctx.setCookie`.
- **Placement.** The plugin must be **last** in `plugins`, the `nextCookies` rule. Later plugins' after-hooks could set cookies the bridge never sees, because plugin hooks run in plugin order after `options.hooks` (LEAD-V1). B05 warns otherwise, and being last also means Nest before-hooks see the effects of other plugins' before-hooks, for example `bearer()` turning `Authorization` into a cookie.
- **Construction time only.** The plugin writes nothing into `auth.options` after construction. Its `init()` contributions are merged by better-auth itself during construction.
- **Fixed entries and a late-bound registry, not per-hook entries pushed at bind time** `[A][C]`. Pushing entries into our own `hooks.before` array at bind time would get better-auth's composition for free. It would, however, depend on better-auth re-reading plugin arrays on every dispatch. That is true in 1.7.4 (LEAD-V1: `getHooks` runs per dispatch) but is an implementation detail; if it were ever cached at init, every Nest hook would silently stop, which is the reference's #42 failure mode (ADR-07).
- **Runtime-agnostic** `[C]`. The plugin imports only `better-auth/api` and `defu`. The `AsyncLocalStorage` lives in the kernel and is reached through `binding.current()`, so `auth.ts` stays loadable in every runtime better-auth supports, and by the better-auth CLI.
- **Inert before binding and after unbinding.** All matchers return `false` and the DB dispatchers are no-ops, so the same `auth.ts` can be shared with scripts and non-Nest code.
- **Dual-package safety.** Core finds the handle through `getPlugin(id)`, which returns the user's own plugin object (EXP-B:E2, EXP-C1), under a `Symbol.for` key. A plugin imported from the ESM build and a kernel loaded from the CJS build still find each other.

### 10.3 Discovery and validation `[A][B][C]`

`HookBinder` runs in the core module's `onModuleInit`. The module is global, so this happens before user modules seed data through `auth.api` (R:nest-di §6.4). Steps:

1. `discovery.getProviders()` across all modules. It is a full scan, because the `metadataKey` filter misses `useFactory`/`useValue` providers (R:nest-di §6.2). Wrappers without an instance and `isAlias` wrappers are skipped.
2. `MetadataScanner.getAllMethodNames(prototype)`, then read `Symbol.for(…:hook)` and `Symbol.for(…:db-hook)` metadata per method. No class marker is required `[C]`.
3. Validate:
   - a non-static provider (`wrapper.isDependencyTreeStatic() === false`) fails boot (B11), because discovery would see a prototype-only instance with no dependencies (R:nest-di §6.3);
   - unknown string patterns fail boot with a "did you mean" (B12);
   - an unknown `instance` fails boot;
   - the same class provided in two modules registers twice, and boot warns with both module names.
4. Compile matchers, bind `instance[method]` to the instance, sort by `order` ascending then discovery order, and bind the tables to each instance's plugin handle.

Lazily loaded modules are not discovered, because Nest gives them no lifecycle hooks. This is documented (risk RK7).

### 10.4 Matching `[A][B][C]`

- **Patterns.** `ctx.path` is the endpoint's **route pattern** (`'/callback/:id'`), not the concrete URL (`BA/api/dispatch.ts:348`). A string matches a pattern exactly. An array matches any of its patterns. A predicate `(ctx) => boolean` is the escape hatch for anything else. No argument means every endpoint. Pattern strings autocomplete from `EndpointPath` (§11.4) and are validated at boot against `auth.api[*].path`: 67 of 69 endpoints expose `.path` at runtime (EXP-C8).
- **`calls`.** `'http'` matches requests routed by `auth.handler` (`ctx._flag === 'router'`). `'server'` matches direct `auth.api.*` calls. `'all'` is the default.
- **`skipInternal`.** The library's own calls (the guard's `getSession`, policy checks) run in scopes marked `internal: true`, and `skipInternal: true` ignores them. The **default is `false`**, which is faithful to better-auth, where user hooks also run for server calls (R:ba-core §4.1). This matters for security hooks: a `@BeforeAuth('/get-session')` that rejects banned users must also affect guarded routes. The docs warn that a path-less hook therefore runs on every guarded request, the unexplained "hooks run twice" of reference issue #103, and that `skipInternal: true` is the one-flag fix for audit-style hooks. Draft B's opposite default was rejected (ADR-08).

### 10.5 Return-value semantics (a faithful mirror of better-auth)

| Hook                          | better-auth semantics (LEAD-V1)                                                                                                                                                    | Dispatcher behavior                                                                                                                                                                                                                                   | Verified                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| before → `undefined`          | continue                                                                                                                                                                           | continue                                                                                                                                                                                                                                              | EXP-A:`exp-plugin.mjs`                                                                                                               |
| before → `{ context }`        | `headers` are `set` into the accumulated Headers; other keys merged with `defuReplaceArrays(rest, acc)` (later hook wins, arrays replaced); **every hook sees the original input** | identical, using `createDefu` with the same array-replacing merger (`defu`, better-auth's own dependency). The accumulated `{ context }` is returned to better-auth, which merges it into its own accumulator. Empty accumulation returns `undefined` | EXP-A:`exp-merge.mjs` (SAME as N native plugins for full-spread, partial and array bodies); EXP-C10 (`hooks saw: orig,orig`; merged) |
| before → any other object     | short-circuit: becomes the response                                                                                                                                                | returned immediately; remaining Nest hooks skipped                                                                                                                                                                                                    | EXP-A, EXP-B:E2, EXP-C1 (`{"shortCircuited":true}`)                                                                                  |
| before → throws               | propagates; with `asResponse` still thrown; cookies set in that hook are lost (R:ba-core §6.5)                                                                                     | propagates unchanged                                                                                                                                                                                                                                  | by construction                                                                                                                      |
| after → value `!== undefined` | replaces `ctx.context.returned`; later hooks see it                                                                                                                                | sets `ctx.context.returned`, continues, returns the final value                                                                                                                                                                                       | EXP-B:E2 (`{"ok":"replaced"}`); EXP-C10 (after-hook 2 sees after-hook 1's value)                                                     |
| after → throws `APIError`     | becomes the current `returned` with its headers merged; later hooks still run                                                                                                      | identical: captured as `returned`, headers merged into `ctx.context.responseHeaders`, later Nest hooks run, the final value returned                                                                                                                  | EXP-C10 (403 `NOPE` reaches both the `auth.api` caller and HTTP)                                                                     |
| after → throws non-`APIError` | propagates (500)                                                                                                                                                                   | propagates                                                                                                                                                                                                                                            | by construction                                                                                                                      |
| DB before → `false`           | abort (`BA/db/with-hooks.ts:56-58`)                                                                                                                                                | return `false` immediately                                                                                                                                                                                                                            | EXP-A:`exp-plugin.mjs`, EXP-B:E2 (`400 FAILED_TO_CREATE_USER`)                                                                       |
| DB before → `{ data }`        | shallow-merged; the _next_ hook sees the merged data                                                                                                                               | identical; returns `{ data: merged }` only if something changed                                                                                                                                                                                       | EXP-A (`orig+db`), EXP-B:E2 (`"… +db"`)                                                                                              |
| DB after                      | queued after the transaction completes (`queueAfterTransactionHook`)                                                                                                               | our dispatcher is itself queued, so Nest after-hooks run after commit; return values ignored                                                                                                                                                          | EXP-A:`exp-plugin.mjs`                                                                                                               |

Hook methods receive better-auth's own context objects: `HookEndpointContext` for endpoint hooks, and `(data, ctx | null)` for DB hooks, where `ctx` is `null` outside an endpoint. Nothing is re-wrapped, so `ctx.setCookie`, `ctx.json` and `ctx.redirect` behave as in native hooks.

**Parity guarantee.** A property test registers the same randomly generated hook functions two ways: as N native plugins, and as N Nest hooks behind one `nestjs()` dispatcher. It asserts identical responses, headers and DB effects (§14.5). That is how the mirror stays faithful across better-auth releases.

### 10.6 `databaseHooks`, ordering, lifecycle, teardown, multiple apps

- **Coverage.** Models `user`, `session`, `account` and `verification`; operations `create`, `update` and `delete`; phases before and after. `init()` contributes one delegating dispatcher per target:

  ```ts
  before: async (data, ctx) => {
    let current = data, changed = false;
    for (const fn of getBinding()?.database[target].before ?? []) {
      const r = await fn(current, ctx);
      if (r === false) return false;                                         // abort, like better-auth
      if (r && typeof r === 'object' && 'data' in r) { current = { ...current, ...r.data }; changed = true; }
    }
    return changed ? { data: current } : undefined;
  },
  after: async (data, ctx) => { for (const fn of getBinding()?.database[target].after ?? []) await fn(data, ctx); },
  ```

- **Ordering.** For endpoint hooks, better-auth runs the user's `options.hooks` first, then earlier plugins, then Nest hooks (`order` ascending, then discovery order). For DB hooks, **Nest's run before the user's `databaseHooks`** in `auth.ts`, because better-auth appends user DB hooks last (LEAD-V4). This is documented.
- **Bind and unbind** `[B][C]`. Binding happens in `onModuleInit`, after discovery and B03/B04. Unbinding happens in `onApplicationShutdown`, after the server stops accepting requests (§5.7), and is idempotent. Nothing on `auth.options` needs reverting, because nothing was changed.
- **Exclusive binding** `[B][C]`. One **live** Nest application per better-auth instance. A second `bind()` throws (B06). That catches forgotten `app.close()` calls in tests and double imports, instead of silently running hooks twice or leaking them across apps; the reference accumulated wrappers on a shared singleton (R:ref-impl §5.3). In practice:
  - sequential lifetimes are fine: close, then boot the next app. `initTestApp` registers `app.close()` for you;
  - concurrent apps need one instance each (shape 3 in §5.1);
  - vitest isolates test files by default, so per-file module-level instances are already separate;
  - hybrid apps share one container, so there is one binding.
- **Calls outside any scope** (cron jobs, CLI scripts using an application context) still run bound Nest hooks. `current()` is `undefined` there, so there is no cookie capture and no suppression, which is plain better-auth behavior.
- **Named instances** each have their own plugin instance and therefore their own binding.

### 10.7 Reference vs this design

|               | @thallesp/nestjs-better-auth 2.8.0                              | This design                                                                            |
| ------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Mechanism     | mutates `auth.options.hooks`/`databaseHooks` after construction | construction-time plugin with fixed entries and a late-bound registry                  |
| Prerequisite  | `hooks: {}` and `databaseHooks: {}` in the user's config        | `plugins: [..., nestjs()]` (boot-checked)                                              |
| Return values | dropped (user hook and Nest hook)                               | better-auth semantics, parity-tested                                                   |
| Matching      | exact path equality only                                        | route patterns validated at boot, arrays, predicates, `calls`, `skipInternal`, `order` |
| Typing        | `any`                                                           | `AuthHookContext<P>` typed from the endpoint schema (§11.4)                            |
| Teardown      | none (leaks across apps)                                        | exclusive bind, unbind on shutdown                                                     |

## 11. Types

### 11.1 Constraints that shape the type design

1. **Structural only.** A plugin-specialized `Auth<Options>` is **not assignable** to bare `Auth` (TS2322 through `$context.adapter`), while a minimal structural contract compiles (R:ba-core §2.3; EXP-C2 case 1). The library therefore never types a parameter as `Auth`.
2. **No fixed shape.** `customSession` replaces both `getSession`'s return type and `$Infer.Session` with an arbitrary shape (R:ba-authz §3.2). No core code assumes `{ session, user }`; everything is derived from `typeof auth`.
3. **Plugins must stay a tuple.** Plugin schema fields reach `$Infer.Session` only when `plugins` is a tuple: an inline array, or `satisfies BetterAuthOptions`. Annotating `BetterAuthPlugin[]` loses them (R:ba-authz §3.2). This is documented prominently; nothing at runtime can detect it.
4. **Decorators cannot type their parameter.** A Nest param decorator is a `ParameterDecorator`, so any annotation compiles (R:ba-authz §3.6). The library can only export precise types to annotate with.
5. **Small declarations.** Emitting inferred better-auth types is large and can hit serialization limits (`docs/concepts/typescript.mdx:36-39`). Our `.d.mts`/`.d.cts` contain only conditional types evaluated in the user's program.

### 11.2 Chosen approach: registry augmentation first, generics second, call-site inference third `[A][B][C]`

| Approach                                                                                                                      | Used for                                                                                                                                                | Why                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Module augmentation** of `Register`, better-auth's own `BetterAuthPluginRegistry` idiom (`BA/plugins/bearer/index.ts:9-15`) | the default experience: `@Session() s: AuthSession`, `BetterAuthService`, `InjectAuth()`, permission-typed requirement builders, hook path autocomplete | non-generic, zero ceremony at use sites; declaration emit stays small (138 B vs 1293 B for a typed factory, R:ba-authz §3.6); visible to subpath types in both ESM and CJS resolution (EXP-C3) |
| **Generic helpers** `SessionOf<A>`, `UserOf<A>`, `AuthOf<N>`, `BetterAuthService<A>`                                          | libraries, multi-instance apps, users who avoid augmentation                                                                                            | explicit, no global state                                                                                                                                                                      |
| **Call-site inference** in `forRoot<A>({ auth })`                                                                             | typing `session.userId`, rejecting a different instance for the default slot                                                                            | free                                                                                                                                                                                           |
| ~~Typed factory~~ `createAuthDecorators<typeof auth>()`                                                                       | rejected (ADR-19)                                                                                                                                       | inlines the full session type into consumer declarations; a factory-created service class per call is a new DI token (identity hazard, S5)                                                     |

The user writes this once, in `auth.ts` or a `.d.ts`:

```ts
declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: typeof auth; // or ReturnType<typeof createAuth> with forRootAsync
    instances: { admin: typeof adminAuth }; // optional, named instances (§5.5)
  }
}
```

### 11.3 Definitions

```ts
/** Structural minimum; accepts any betterAuth() result incl. plugins and customSession (EXP-C2, EXP-A:types/). */
export interface AuthLike {
  handler(request: Request): Promise<Response>;
  api: {
    getSession(ctx: {
      headers: Headers;
      query?: { disableCookieCache?: boolean; disableRefresh?: boolean };
      returnHeaders?: boolean;
    }): Promise<unknown>;
  };
  $context: Promise<unknown>;
}

export interface Register {}
export type IsRegistered = Register extends { auth: AuthLike } ? true : false;
export type RegisteredAuth = Register extends { auth: infer A extends AuthLike }
  ? A
  : AuthLike;
export type RegisteredInstances = Register extends {
  instances: infer I extends Record<string, AuthLike>;
}
  ? I
  : {};
export type AuthOf<N extends string = "default"> = N extends "default"
  ? RegisteredAuth
  : N extends keyof RegisteredInstances
    ? RegisteredInstances[N]
    : AuthLike;

/** Unregistered fallback = better-auth's default core shape (Session/User are exported by better-auth, EXP-C11). */
type DefaultSession = {
  session: import("better-auth").Session;
  user: import("better-auth").User;
};
export type SessionOf<A> = A extends { $Infer: { Session: infer S } }
  ? NonNullable<S>
  : DefaultSession;
export type UserOf<A> = SessionOf<A> extends { user: infer U } ? U : never;
export type AuthSession<N extends string = "default"> = SessionOf<AuthOf<N>>;
export type AuthUser<N extends string = "default"> = UserOf<AuthOf<N>>; // never for customSession shapes without `user`
type HasUserId<S> = S extends { user: { id: string } } ? true : false;

// Permissions: derived from the plugin endpoints' body types, which better-auth computes from `ac` statements [A][C]
type BodyOf<F> = F extends (ctx: infer C) => unknown
  ? [NonNullable<C>] extends [{ body?: infer B }]
    ? NonNullable<B>
    : never
  : never;
type PermissionsOf<A, K extends string> = A extends {
  api: { [k in K]: infer F };
}
  ? BodyOf<F> extends { permissions?: infer P }
    ? NonNullable<P>
    : never
  : never;
export type AdminPermissions<N extends string = "default"> =
  IsRegistered extends true
    ? PermissionsOf<AuthOf<N>, "userHasPermission">
    : Record<string, readonly string[]>;
export type OrgPermissions<N extends string = "default"> =
  IsRegistered extends true
    ? PermissionsOf<AuthOf<N>, "hasPermission">
    : Record<string, readonly string[]>;
// Builders are generic in the instance for named instances: permission<'admin'>({ … }), orgPermission<'admin'>({ … }).

// Endpoint paths and typed hook contexts (EXP-C9) [C]
type ApiOf<A> = A extends { api: infer Api } ? Api : never;
export type EndpointPath<A = RegisteredAuth> = {
  [K in keyof ApiOf<A>]: ApiOf<A>[K] extends { path: infer P extends string }
    ? P
    : never;
}[keyof ApiOf<A>];
type EndpointAt<P extends string, A = RegisteredAuth> = {
  [K in keyof ApiOf<A>]: ApiOf<A>[K] extends { path: P } ? ApiOf<A>[K] : never;
}[keyof ApiOf<A>];
type BodyAt<P extends string> = [EndpointAt<P>] extends [never]
  ? unknown
  : BodyOf<EndpointAt<P>>;
export type AuthHookContext<P extends string = string> = Omit<
  import("better-auth").HookEndpointContext,
  "path" | "body"
> & { path: P; body: string extends P ? unknown : BodyAt<P> };
export type AuthAfterHookContext<P extends string = string> =
  AuthHookContext<P>; // context.returned / newSession / responseHeaders populated

// Database hook payloads (best effort: user/session from the registered instance, account/verification structural) [A][C]
export type DatabaseHookData<E extends DatabaseHookTarget> =
  E extends `user.${string}`
    ? UserOf<RegisteredAuth> & Record<string, unknown>
    : E extends `session.${string}`
      ? (SessionOf<RegisteredAuth> extends { session: infer S }
          ? S
          : Record<string, unknown>) &
          Record<string, unknown>
      : Record<string, unknown> & { id?: string };

/** Guard-established invariant helper (reference #163). Prefer @ActiveOrganizationId() (§8.3). */
export type WithActiveOrganization<S> = S & {
  session: { activeOrganizationId: string };
};

// Principals (§4.3) [A][B][C]
export interface PrincipalKinds {
  session: SessionPrincipal;
} // augmentable
export type PrincipalKind = keyof PrincipalKinds & string;
export type AuthPrincipal = PrincipalKinds[PrincipalKind];
export type PrincipalOfKind<K extends PrincipalKind> = PrincipalKinds[K];
export interface SessionPrincipal<S = AuthSession> extends AuthPrincipalBase {
  readonly kind: "session";
  readonly session: S;
}
```

### 11.4 How types reach each API `[C]`

| Where                                                        | Type                                   | Registered                                                                                         | Unregistered                                        |
| ------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `@Session() s: AuthSession`                                  | parameter annotation                   | exact `$Infer.Session`, including plugin fields and `additionalFields` (EXP-C2; EXP-A:`types/`)    | better-auth core `{ session: Session; user: User }` |
| `@CurrentUser() u: AuthUser`                                 | parameter annotation                   | exact user; `never` for `customSession` shapes without `user` (a visible signal)                   | core `User`                                         |
| `@CurrentPrincipal() p: AuthPrincipal \| null`               | discriminated union                    | `SessionPrincipal \| <augmented kinds>`                                                            | same                                                |
| `BetterAuthService`                                          | class generic default `RegisteredAuth` | `api` fully typed; `getSession(): Promise<AuthSession \| null>`                                    | structural                                          |
| `BetterAuthService<AuthOf<'admin'>>`, `AuthSession<'admin'>` | explicit instance                      | named instances (verified EXP-A:`types/consumer.ts`)                                               | `AuthLike`                                          |
| `@InjectAuth() auth: RegisteredAuth`                         | annotation                             | the instance type                                                                                  | `AuthLike`                                          |
| `@RequirePermission(p)`, `permission(p)`                     | argument                               | typed from the admin `ac` statements; `never` if the admin plugin is absent (EXP-C2 cases 3, 4, 8) | `Record<string, readonly string[]>`                 |
| `@RequireOrgPermission(p)`                                   | argument                               | typed from the organization `ac`; `never` if absent                                                | same                                                |
| `@BeforeAuth('/sign-up/email')`                              | literal union + any string             | autocompletes every endpoint path                                                                  | any string                                          |
| `AuthHookContext<'/sign-up/email'>`                          | hook parameter                         | `body` typed from the endpoint schema (EXP-C9: `body.email: string`)                               | `unknown`                                           |
| Multi-path hook                                              | parameter must accept the path union   | a method typed for a single path is rejected (EXP-C9 `multi.ts`)                                   | —                                                   |
| `forRoot({ auth, session })`                                 | option inference                       | `session.userId` is **required** when the session lacks `user.id` (EXP-C2 `types-unreg`)           | same (inferred from `auth`)                         |
| `forRootAsync` factory result                                | return type                            | static keys rejected with `StaticOptionMustBePassedToForRootAsync<K>` (EXP-C9)                     | same                                                |
| `@ActiveOrganizationId() id: string`                         | annotation                             | resolved after the org requirement ran (#163)                                                      | same                                                |

### 11.5 `customSession` `[A][B][C]`

- `SessionOf<typeof auth>` is the callback's return type (EXP-C2 case 7), so `AuthSession` follows automatically.
- At runtime the session source stores whatever `getSession` returned. The principal's `userId` comes from the `session.userId` mapper, and the types force the user to provide it when the shape has no `user.id`:

  ```ts
  const auth = betterAuth({
    plugins: [
      customSession(async ({ user }) => ({
        principal: { uid: user.id },
        roles: ["x"],
      })),
      nestjs(),
    ],
  });
  BetterAuthModule.forRoot({
    auth,
    platforms: [expressPlatform()],
    session: { userId: (s) => s.principal.uid },
  }); // omitting it = compile error
  ```

- `@CurrentUser()` is typed `never` for such shapes, which steers users to `@Session()`.
- The built-in org and admin policies work unchanged. They never read the custom shape: they use `principal.userId` or call endpoints with the request headers, which resolve the base session internally.
- `freshSession()` needs `session.session.createdAt`. For shapes without it, it denies with `PRINCIPAL_NOT_SUPPORTED` and boot warns.
- If the `userId` mapper returns `null` for a resolved session at runtime, that is a `BetterAuthConfigurationError` (500), never a silent anonymous result.

### 11.6 Principal kinds and narrowing

`AuthPrincipal` is the union `PrincipalKinds[keyof PrincipalKinds]`. Extensions augment `PrincipalKinds` (`./api-key` adds `'api-key'`; the third-party OAuth source adds `'oauth-access-token'`), so `p.kind === 'api-key'` narrows to `ApiKeyPrincipal` in user code with no core change. That is OCP at the type level `[A][B][C]`.

### 11.7 Declaration hygiene `[A][C]`

- Our declarations never reference user types. `Register` is empty in them, `AuthLike` is structural, and deeply inferred better-auth types are never re-exported.
- Type imports from better-auth are limited to `better-auth` (`Session`, `User`, `HookEndpointContext`, `BetterAuthPlugin`, `BetterAuthOptions`: EXP-C11) and `better-auth/api`.
- We never import `@better-auth/core` directly; under pnpm's strict layout it is not resolvable from our package.
- All entries share one declaration chunk per format, so a `Register` augmentation of the root specifier is visible to types exported from subpaths (EXP-C3). A program that mixes `.cts` and `.mts` files sees two declaration copies, so users should augment from one format (risk RK10).

### 11.8 Consumer TypeScript requirements (documented)

- `strict: true`. better-auth requires it for inference.
- `skipLibCheck: true`. better-auth 1.7.4's own published types reference `bun:sqlite`, `@cloudflare/workers-types` and `Timer` (R:packaging §7.4).
- **Module resolution:**
  - Supported: `nodenext` or `node20` (CJS and ESM; TS ≥ 5.8 models require(esm)), and `bundler`.
  - `node16`/`node18` in CJS mode: our package resolves to `.d.cts`, but a direct `better-auth` import in the same file errors with TS1479. That is documented, not supported.
  - `node10` is unsupported for subpaths: TS 6 deprecates it and TS 7 removes it.
- Keep `plugins` a tuple.
- Consumer TypeScript 5.9, 6.x and 7.x are covered by the type matrix (§14.2).

## 12. Packaging

### 12.1 tsdown configuration (tsdown 0.23.x, pinned exactly with its rolldown) `[A][B][C]`

```ts
// tsdown.config.ts
import { defineConfig } from "tsdown";

const neverBundle = [
  /^@nestjs\//,
  /^better-auth(\/|$)/,
  /^@better-auth\//,
  /^graphql(\/|$)/,
  "rxjs",
  "reflect-metadata",
  "defu",
];
const common = {
  format: ["esm", "cjs"] as const,
  platform: "node" as const,
  target: "node22.12", // matches engines (D1)
  tsconfig: "tsconfig.build.json", // experimentalDecorators + emitDecoratorMetadata live HERE (§12.6)
  dts: true,
  fixedExtension: true, // .mjs/.cjs + .d.mts/.d.cts (0.23 default on node; explicit on purpose)
  exports: false, // hand-authored map (§12.3): tsdown's generator omits `types` and cannot express module-sync
  checks: { legacyCjs: false }, // R3 requires the CJS artifact; silence the recommendation
  deps: { neverBundle },
};

export default defineConfig([
  {
    ...common,
    name: "library",
    entry: {
      index: "src/index.ts",
      platform: "src/shared/platform/index.ts",
      express: "src/extensions/express/index.ts",
      fastify: "src/extensions/fastify/index.ts",
      graphql: "src/extensions/graphql/index.ts",
      websockets: "src/extensions/websockets/index.ts",
      microservices: "src/extensions/microservices/index.ts",
      admin: "src/extensions/admin/index.ts",
      organization: "src/extensions/organization/index.ts",
      "api-key": "src/extensions/api-key/index.ts",
      testing: "src/testing/index.ts",
      "testing/conformance": "src/testing/conformance/index.ts",
    },
    publint: true,
    attw: { profile: "node16", level: "error" },
  },
  {
    ...common,
    name: "plugin", // separate build: its import graph can never reach @nestjs/* or node:* [A]
    entry: { plugin: "src/plugin/index.ts" },
  },
]);
```

- Within the library build, subpath entries share chunks per format. `.`, `./express` and `./graphql` therefore share one instance of the kernel, contracts and tokens within a format (R:packaging §3.4).
- The plugin has its own build, so a chunking decision can never make `./plugin` import kernel code. Only the tiny protocol types and constants are duplicated, and that is safe because the handle is found through a `Symbol.for` key (§10.2).
- A top-level await cannot slip in. The CJS build fails with rolldown `UNSUPPORTED_FEATURE`, and CI `require()`s every ESM entry on Node 22.12 to catch `ERR_REQUIRE_ASYNC_MODULE` (R:packaging §3.5, §6.1).

### 12.2 Formats and extensions

- The package is `"type": "module"`. Each entry emits `dist/<entry>.mjs` (ESM), `.cjs` (CJS), `.d.mts` and `.d.cts`, plus shared chunks per format.
- The `.cjs` files `require()` ESM-only peers (better-auth, and `@nestjs/*` on Nest 12) through require(esm). That works on Node ≥ 22.12 because neither graph has top-level await (R:packaging §1.4, §2.2), which is why engines is `>=22.12.0` (D1).
- 22.12.0 prints an `ExperimentalWarning`; 22.13+ does not.

### 12.3 `package.json` (relevant fields)

```jsonc
{
  "name": "nestjs-slightly-better-auth",
  "version": "0.1.0", // real version: pack and publish fail without it (R:current-repo)
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=22.12.0" },
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.cts",
  "files": ["dist"],
  "exports": {
    ".": {
      "module-sync": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs",
      },
      "import": {
        "types": "./dist/index.d.mts",
        "default": "./dist/index.mjs",
      },
      "require": {
        "types": "./dist/index.d.cts",
        "default": "./dist/index.cjs",
      },
    },
    "./plugin": {/* same three-condition shape → dist/plugin.* */},
    "./platform": {/* … */},
    "./express": {/* … */},
    "./fastify": {/* … */},
    "./graphql": {/* … */},
    "./websockets": {/* … */},
    "./microservices": {/* … */},
    "./admin": {/* … */},
    "./organization": {/* … */},
    "./api-key": {/* … */},
    "./testing": {/* … */},
    "./testing/conformance": {/* … */},
    "./package.json": "./package.json",
  },
  "dependencies": { "defu": "^6.1.4" },
  "peerDependencies": {
    "@nestjs/common": "^11.0.0 || ^12.0.0",
    "@nestjs/core": "^11.0.0 || ^12.0.0",
    "better-auth": ">=1.7.0 <2",
    "reflect-metadata": "^0.2.0",
    "rxjs": "^7.8.0",
    "@nestjs/graphql": "^13.0.0 || ^14.0.0",
    "graphql": "^16.11.0 || ^17.0.0",
    "@nestjs/websockets": "^11.0.0 || ^12.0.0",
    "@nestjs/microservices": "^11.0.0 || ^12.0.0",
    "@nestjs/testing": "^11.0.0 || ^12.0.0",
  },
  "peerDependenciesMeta": {
    "@nestjs/graphql": { "optional": true },
    "graphql": { "optional": true },
    "@nestjs/websockets": { "optional": true },
    "@nestjs/microservices": { "optional": true },
    "@nestjs/testing": { "optional": true },
  },
}
```

- **Condition order.** Within `exports`, the most specific condition (`module-sync`) comes first. Within each branch, `types` comes first and `default` last (publint `EXPORTS_TYPES_SHOULD_BE_FIRST`, `EXPORTS_DEFAULT_SHOULD_BE_LAST`). This exact shape, packaging variant A, passed attw with all columns green and publint with only an `engines` suggestion (R:packaging §5.4).
- **Types under `module-sync`.** TypeScript ignores `module-sync` and resolves `import`/`require` to `.d.mts`/`.d.cts`, whose contents are identical.
- **No default exports anywhere.** Named exports only, per publint `CJS_WITH_ESMODULE_DEFAULT_EXPORT`.
- **`sideEffects: false` is honest.** Nothing runs at import time.
- **No `typesVersions`.** `node10` is unsupported (§11.8).

### 12.4 Engines and peers (D1, D4)

- **`engines.node: ">=22.12.0"`.** This is the require(esm) line: it is unflagged in 22.12.0, and 22.11 fails (R:packaging §1.4). Node 20 is EOL (2026-04-30). It is the floor any CJS consumer of better-auth 1.7 or Nest 12 already has, whatever we ship (R:packaging §2.6). There is no upper bound, because the reference's `<23` broke Node 24 users (#130).
- **Peers:** Nest `^11 || ^12`; `@nestjs/graphql ^13 || ^14`; `graphql ^16.11 || ^17` (both GraphQL majors peer on that range); better-auth `>=1.7.0 <2`.
- **Semver.** Dropping a Node, Nest or better-auth major is a semver-major change. Format and engines never change in a minor release (#108, #130, #141).

### 12.5 Dual-package hazard strategy (S5) `[A][B][C]`

**Primary: `module-sync` first, ESM canonical (packaging variant A).** On every Node version in our engines range, `import` and `require` both resolve the `module-sync` branch, so both load the ESM build. There is exactly one copy of every class (`BetterAuthModule`, `BetterAuthGuard`, `BetterAuthService`, platform and transport classes) per process. This was verified for this exports shape on 22.12.0, 22.22.0 and 26.7.0 ("both→mjs", R:packaging §5.4). The CJS build serves tools that resolve `require` without `module-sync` support, such as some bundlers and runners, which is exactly R3's purpose. For bundlers, `default`-condition handling is UNVERIFIED and is covered by the bundler fixtures (§14.6).

**Defense in depth, independent of routing:**

1. Every DI token and metadata key is `Symbol.for('nestjs-slightly-better-auth:…')` (§2.3). `Symbol()` and random `Reflector.createDecorator()` keys do not survive two copies (R:packaging §5.2: `Symbol()` tokens → `UnknownDependenciesException`; `Symbol()` metadata keys → hooks silently not discovered).
2. Class tokens have `Symbol.for` aliases (`BETTER_AUTH_SERVICE` via `useExisting`) plus helper decorators (`@InjectBetterAuthService()`), so injection works across copies.
3. The plugin-to-kernel link is a versioned protocol object on the plugin instance, found through `getPlugin()` (§10.2). It is never shared module state.
4. Requirement metadata carries policy objects by reference, so the guard of either copy just calls `evaluate`.
5. There is no `instanceof` on our own classes across the package boundary:
   - `isAuthFailure` and `isExtensionDefinition` check `Symbol.for` brands;
   - better-auth errors use `isAPIError` (S6);
   - the exceptions we throw are Nest's own classes, with one copy per Nest major.
6. There is no module-level mutable state. Request state, registries and bindings live in providers or on the plugin object.
7. Double registration across copies is caught by the exclusive plugin binding (B06) and the per-server mount stamp (B10) (§5.6).
8. CI loads both builds in one process and asserts that tokens, metadata, brands and the plugin handshake interoperate (§14.6).

**What remains.** Class identity for enhancers: `overrideProvider(BetterAuthGuard)` must import the same copy the app resolved, which `module-sync` makes automatic on supported Node. This is documented and covered by the dual-load test.

**Rejected alternatives** (ADR-20):

- **`node` → CJS routing:** it would make every Node consumer, including Nest 12 ESM apps, run the CJS build, against better-auth's and Nest 12's ESM direction. It also needs `.d.cts` under `node.import` to avoid attw "Masquerading as ESM".
- **An ESM wrapper over CJS:** it makes CJS canonical, for the same reason.
- **ESM-only:** it violates R3.
- **Plain `import`/`require` routing:** it leaves the class-identity hazard open.

### 12.6 Decorator-metadata guarantees `[A][B][C]`

- **Explicit `@Inject(token)`** on **every** library constructor parameter, so correctness never depends on `design:paramtypes`. Isolated transpilation (oxc) emits `Object` for interface and type-only-import parameters (R:packaging §4.1).
- **`tsconfig.build.json`**, the exact file tsdown reads, sets `experimentalDecorators` and `emitDecoratorMetadata`. Without the first, tsdown **builds successfully** but emits TC39 decorator syntax that throws `SyntaxError` at load. Metadata is still emitted so users can subclass `BetterAuthGuard` without re-declaring injections.
- **CI checks:**
  - `dist/**/*.{mjs,cjs}` contains no raw `@`-decorator syntax;
  - `dist/index.mjs` contains `__decorateMetadata("design:paramtypes"`;
  - every entry is imported from `dist` in both formats, and a minimal app is booted from each.
- **Biome.** `style/useImportType` is off for `src/**`, because its "safe fix" rewrites injected classes into type imports and yields `design:paramtypes: [Object]`. `unsafeParameterDecoratorsEnabled: true`. `noUnusedPrivateClassMembers` is off for constructor-injected members. `vcs.useIgnoreFile: true`.

### 12.7 Optional peers via subpaths

- The root entry imports only required peers. Every optional peer is imported **statically** and only by its own subpath: `./graphql` → `@nestjs/graphql`; `./websockets` → `@nestjs/websockets`; `./microservices` → `@nestjs/microservices`; `./testing` → `@nestjs/testing`. A REST-only app never resolves them (reference #82, #97, #100).
- **Not used:**
  - Nest's `loadPackage`: sync and `process.exit` on failure in 11, async and internal in 12 (R:nest-di §8.1);
  - `createRequire(import.meta.url)('peer')`, which is bundler-hostile (#147);
  - bare `require`;
  - top-level await;
  - lazy `import()` on hot paths.
- **Import-graph checks in CI:**
  - `.` must not reach an optional peer or any `src/extensions/**` file;
  - `./plugin` (including its chunks) must not reach `@nestjs/*` or `node:*`;
  - an extension must not import another extension.

### 12.8 Toolchain (R5)

- **pnpm.** A workspace with the library at the root and fixtures under `fixtures/*` (§14.6), each an explicit package. Because of pnpm's strict layout, every module a test imports is an explicit devDependency; the current repo's `rxjs` was unresolvable (R:current-repo).
- **tsdown 0.23.x**, pinned exactly with its rolldown. A caret pairing produced hashed `.d.ts` names in the current repo.
- **TypeScript 6.x** as the devDependency. rolldown-plugin-dts's `tsc` generator needs the classic JS API that TS 7 lacks (R:packaging §2.4).
- **vitest 5 on Vite 8.** It honors `emitDecoratorMetadata` from tsconfig without `unplugin-swc` (R:packaging §4.3). Vite 8 is pinned.
- **biome**, with the rules in §12.6.
- **lefthook** pre-commit: `biome check` and `tsc --noEmit`. A tsdown build succeeds despite type errors, so the separate typecheck is mandatory.
- **Release:** changesets and npm OIDC trusted publishing with provenance.

### 12.9 Verification pipeline

| #   | Step                      | Tool                                                                                   | Failure means                                                   |
| --- | ------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | Lint and format           | `biome ci`                                                                             | style or rule violations (incl. `useImportType` off-check)      |
| 2   | Typecheck                 | `tsc --noEmit -p tsconfig.json`                                                        | type errors (tsdown would not catch them)                       |
| 3   | Build                     | `tsdown` (runs publint + attw `--profile node16`)                                      | broken paths, condition order, FalseESM/FalseCJS, missing types |
| 4   | Architecture              | dependency-cruiser + literal lint (§14.7)                                              | core depends on an extension; name literals in core             |
| 5   | Plugin purity             | import-graph walk of `dist/plugin.{mjs,cjs}` + chunks                                  | `./plugin` reaches `@nestjs/*` or `node:*`                      |
| 6   | Tests                     | `vitest run` (unit, e2e, conformance projects)                                         | behavior regression                                             |
| 7   | Pack                      | `pnpm pack`                                                                            | —                                                               |
| 8   | Tarball smoke + dual-load | fixtures (§14.6)                                                                       | the published artifact differs from what the tests ran          |
| 9   | Consumer types            | TS {5.9, 6.x, 7.x} × {nodenext ESM, nodenext CJS, bundler, node16 CJS}, `skipLibCheck` | our declarations do not compile for a consumer mode             |

## 13. Error model

### 13.1 Taxonomy `[A][B][C]`

| Class                                                | When                                                                                                                                                                                              | Status                                                                   | `code` / `reason`                                                                                                                                                                                              | Logged                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Denial: unauthenticated**                          | required route, no principal                                                                                                                                                                      | 401                                                                      | `UNAUTHENTICATED`                                                                                                                                                                                              | no (debug)                                                               |
| **Denial: rejected credential**                      | a source returned `rejected` (for example an `APIError` 401/403 from `getSession` hooks, or a bad JWT)                                                                                            | 401 or 403 (better-auth's status)                                        | `UNAUTHENTICATED` / `FORBIDDEN`; `reason` = better-auth `body.code` (`INVALID_API_KEY`, `UNAUTHORIZED`, …)                                                                                                     | no (debug)                                                               |
| **Denial: forbidden**                                | a policy denied                                                                                                                                                                                   | 403 (or 401 when the policy asks for re-authentication with a challenge) | `FORBIDDEN`; `reason` ∈ `MISSING_PERMISSION`, `NOT_A_MEMBER`, `ORGANIZATION_REQUIRED`, `SESSION_NOT_FRESH`, `SESSION_REQUIRED`, `PRINCIPAL_NOT_SUPPORTED`, `USER_REQUIRED`, better-auth codes, extension codes | no (debug)                                                               |
| **Denial: rate limited**                             | better-auth 429 during resolution or evaluation (API-key limits)                                                                                                                                  | 429                                                                      | `RATE_LIMITED`; `Retry-After` passed through                                                                                                                                                                   | no (debug)                                                               |
| **Infrastructure** (`BetterAuthInfrastructureError`) | any throw from a source, policy or better-auth call that is not a 401/403/429 `APIError`: storage or network failure, `APIError` ≥ 500, `BetterAuthError`; `auth.handler` throwing on auth routes | 500                                                                      | HTTP: Nest's default 500 body; GraphQL `INTERNAL_SERVER_ERROR` (reason `AUTH_UNAVAILABLE`); WS/RPC "Internal server error"                                                                                     | **yes**, once, with its cause, by Nest's exception layer (not intrinsic) |
| **Configuration** (`BetterAuthConfigurationError`)   | boot validation (§5.4); at request time: no transport for a context, unresolved policy, `userId` mapper returning `null`, another 4xx `APIError` from our own call                                | boot: the process fails; request time: 500                               | `code` = the check id (e.g. `NO_TRANSPORT`, `UNRESOLVED_POLICY`)                                                                                                                                               | yes                                                                      |
| **Auth routes**                                      | anything better-auth returns                                                                                                                                                                      | verbatim                                                                 | better-auth's `{ message, code }` bodies; ours only for `PAYLOAD_TOO_LARGE` (413) and `INVALID_REQUEST_URL` (400), in the same shape                                                                           | host pipeline for 5xx                                                    |

**The key rule (S6).** Only a _denial value_ produces 401, 403 or 429. Detection uses `isAPIError` from `better-auth/api` (LEAD-V5), the status comes from `e.statusCode`, and the reason from `e.body?.code`. Nothing in the library catches an arbitrary error and returns 401/403. The reference did that for every plugin error (R:ref-impl §6.1).

### 13.2 Normalization `[B][C]`

Sources and policies return values. The kernel's safety net normalizes anything they throw:

```ts
function normalizeThrown(
  e: unknown,
  where: "source" | "policy",
  site: string,
): AuthFailure | never {
  if (isAuthFailure(e)) return e; // brand check, dual-package safe
  if (isAPIError(e)) {
    // better-auth/api; never instanceof (S6)
    const status = e.statusCode,
      reason = (e.body as { code?: string } | undefined)?.code;
    if (status === 429) return AuthFailures.rejected({ status: 429, reason });
    if (status === 401 || status === 403)
      return where === "source"
        ? AuthFailures.rejected({ status, reason }) // presented credential rejected
        : AuthFailures.forbidden(reason ?? "FORBIDDEN"); // principal is authenticated → 403
    if (status >= 500) throw new BetterAuthInfrastructureError(e);
    throw new BetterAuthConfigurationError(
      "BETTER_AUTH_REJECTED_CALL",
      `${site}: better-auth rejected the library's call (${status} ${reason})`,
    );
  }
  throw new BetterAuthInfrastructureError(e);
}
```

A 4xx other than 401, 403 or 429 means our own call was malformed, for example a validation error from `userHasPermission`. That is a bug or a misconfiguration, not a client error `[C]`. Built-in policies convert the better-auth denials they expect into decisions themselves before this net sees them. Examples are `USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION` (401 → 403) and `NO_ACTIVE_ORGANIZATION` (400 → 403) (§8.3).

### 13.3 Mapping per transport and payload contract

```ts
/** HTTP body of a denial: Nest's default shape plus a stable code. [A][C] */
export interface AuthErrorBody {
  statusCode: 401 | 403 | 429;
  error: string;
  code: AuthErrorCode;
  reason?: string;
  message: string;
}
/** GraphQL extensions of a denial (both drivers). [L] */
export interface AuthGraphqlExtensions {
  code: AuthErrorCode | "INTERNAL_SERVER_ERROR";
  reason?: string;
  statusCode: number;
}
/** WS and RPC error object. [A][B][C] */
export interface AuthTransportErrorPayload {
  status: "error";
  statusCode: number;
  code: AuthErrorCode;
  reason?: string;
  message: string;
}
```

| Transport                   | Denial thrown                                                                                                                                     | Client-visible payload                                                                                                                                                                                                                                   | Infrastructure                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| HTTP                        | `UnauthorizedException` / `ForbiddenException` / `HttpException(…, 429)` constructed with `AuthErrorBody` and `{ cause }` (intrinsic: not logged) | `{ "statusCode": 403, "error": "Forbidden", "code": "FORBIDDEN", "reason": "MISSING_PERMISSION", "message": "Forbidden" }` + `WWW-Authenticate` when a challenge exists + `Retry-After` for 429. User filters catching `ForbiddenException` keep working | 500 through Nest's filters, logged                                   |
| GraphQL (Apollo, Mercurius) | `BetterAuthGraphqlDenial` (intrinsic, `extensions`) (LEAD-EXP-1)                                                                                  | `errors[i].extensions = { code, reason, statusCode }`, HTTP 200; identical across drivers; same codes Apollo uses for 401/403                                                                                                                            | `extensions.code = 'INTERNAL_SERVER_ERROR'`, generic message, logged |
| WebSocket                   | `WsException(AuthTransportErrorPayload)`                                                                                                          | `exception` event with that object (`BaseWsExceptionFilter`)                                                                                                                                                                                             | "Internal server error", logged                                      |
| RPC                         | `RpcException(AuthTransportErrorPayload)`                                                                                                         | that object (`BaseRpcExceptionFilter`)                                                                                                                                                                                                                   | "Internal server error", logged                                      |
| gRPC (carrier)              | `RpcException({ code: 16 \| 7 \| 8, message })` or Nest 12's `Grpc*Exception`                                                                     | gRPC status + message                                                                                                                                                                                                                                    | status 13                                                            |
| Auth routes                 | better-auth's own responses, untouched                                                                                                            | better-auth's `{ message, code }`                                                                                                                                                                                                                        | 500 via the host pipeline                                            |

`AuthFailure` is transport-neutral, and only a transport's `toException` knows the transport's format. A new transport therefore gets the whole taxonomy by implementing one method `[B]`.

### 13.4 Logging

- Denials are not errors. HTTP and GraphQL mappings are `IntrinsicException`s, which Nest's filters do not log (LEAD-V9). Denials are logged at `debug` by the guard.
- Infrastructure failures are logged once per request with their cause chain, by Nest's exception layer.
- **Never logged:** request headers, `Cookie`, `Set-Cookie`, bearer tokens and API keys. One alternative library logs full headers (R:ba-integrations §6.6).
- The docs warn that with `apiKey({ enableSessionForAPIKeys })`, the mocked session carries the raw key in `session.token`. Serializing `@Session()` into responses or logs leaks it (R:ba-authz §1.2). `apiKeyPrincipal()` never exposes the raw key.

### 13.5 Customization

```ts
export interface ErrorMappingOptions {
  /** Replace what a transport throws for a denial; return undefined to keep the transport's default. [C] */
  map?: (
    failure: AuthFailure,
    context: ExecutionContext,
    transport: string,
  ) => unknown;
}
```

- `errors.map` is the app-level override. It is applied before the transport's `toException`.
- A deeper change is made by subclassing a transport (for example the HTTP transport) and listing it in `transports`, where it is selected before the built-in one `[A]`.
- Neither mechanism depends on exception filters, which do not reach WebSocket gateways in any Nest version (R:nest-di §5.2).

## 14. Testing strategy

### 14.1 Conformance kits (the LSP proof, reusable by third parties) `[A][B][C]`

The kits live in `nestjs-slightly-better-auth/testing/conformance`. They are **runner-agnostic**: each returns `ConformanceCase[]`, and `runConformance(cases, { describe, it })` registers them with vitest, jest or `node:test`. Assertions use `node:assert/strict`. The same kits run in our CI for every built-in unit, which makes "Express and Fastify behave the same" a tested property rather than a claim.

Each HTTP case boots a real Nest app, under both `NestFactory.create` and `Test.createTestingModule().createNestApplication()`. It uses a real better-auth instance (memory adapter) that includes `conformanceProbePlugin()`, which provides these endpoints:

- `/probe/echo-raw`: `disableBody` + `ctx.request.text()`, echoing the received bytes and headers;
- `/probe/multi-cookie`: three cookies;
- `/probe/redirect`: 302 with a cookie;
- `/probe/stream`: three chunks with delays;
- `/probe/html`;
- `/probe/put`, `/probe/patch`, `/probe/delete`;
- `/probe/url`: echoes `request.url`;
- `/probe/ip`: echoes `getIP(request)`;
- `/probe/throw-api-error`, `/probe/throw-error`.

The kit also adds a throwing `around` interceptor and an app controller `/app/echo` that returns `{ body, rawBody }`.

```ts
export interface HttpConformanceOptions {
  platform: ExtensionRef<HttpPlatform>;
  /** Fresh Nest HTTP adapter per app, e.g. () => new ExpressAdapter(). */
  createHttpAdapter(): AbstractHttpAdapter;
  /** Bootstraps to exercise. Default both. */
  bootstrap?: readonly ("factory" | "testing")[];
  /** Enable host CORS the platform's usual way. Default: app.enableCors({ origin, credentials: true }). */
  enableHostCors?(app: INestApplication, origin: string): void | Promise<void>;
  /** HTTP/2 variant, required when the platform declares capabilities.http2. */
  http2?: { createHttpAdapter(): AbstractHttpAdapter };
  /** How to obtain a base URL. Default: app.listen(0) + getUrl(). */
  listen?(app: INestApplication): Promise<string>;
}
export interface TransportConformanceOptions {
  transport: ExtensionRef<AuthTransport>;
  /** Boots an app exposing the kit's fixture handlers (one per access mode, plus 'triple' and 'forbidden') on this transport. */
  createApp(
    fixtures: TransportFixtures,
    auth: AuthLike,
  ): Promise<INestApplication>;
  /** Invokes a fixture handler with given credentials; returns the transport-native outcome. */
  invoke(
    app: INestApplication,
    handler:
      | "required"
      | "optional"
      | "public"
      | "forbidden"
      | "triple"
      | "readsSession",
    headers: HeadersInit,
  ): Promise<{
    ok: boolean;
    body?: unknown;
    error?: { code?: string; statusCode?: number; reason?: string };
    setCookies: string[];
  }>;
  expectCookieCapable: boolean;
}
export interface PrincipalSourceConformanceOptions {
  source: ExtensionRef<PrincipalSource>;
  credentials: { valid(): Promise<Headers>; invalid(): Headers };
}
export interface PolicyConformanceOptions {
  requirement: RequirementExpr;
  allowingPrincipal(): Promise<AuthPrincipal>;
  denyingPrincipal(): Promise<AuthPrincipal>;
}
```

**HTTP platform cases** (invariants H1–H11, §4.1.2):

| Group      | Cases                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mount      | every method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS, QUERY if supported) reaches better-auth under the base path; the bare base path; `/api/authx` falls through; custom path via a `baseURL` path, via `basePath`, and via dynamic `allowedHosts` + `basePath`; Nest global prefix + URI versioning leave the mount unchanged; a controller outside the path still works; a controller under the path wins (H11) |
| Body       | byte-exact echo of JSON with odd whitespace and key order, UTF-8, urlencoded (`b=%20x&c=1`), `text/plain`, `application/scim+json`, multipart, binary, chunked transfer, empty body, no content-type; urlencoded sign-in succeeds; over-limit → 413 **with host CORS headers** (declared and chunked; boundary exact); app routes still parsed, with `rawBody` and `useBodyParser` limits                                |
| Facts      | URL protocol and host honor the platform's trust-proxy setting; the query string is preserved (OAuth `?code=&state=`); percent-encoding kept; better-auth's `getIP` sees the platform IP; a client-sent client-IP header is ignored; per-IP rate-limit buckets in production mode; HTTP/2 pseudo-headers do not crash (h2c, capability `http2`)                                                                          |
| Write-back | three `Set-Cookie` preserved; 302 + `Location` + cookie; 3-chunk stream arrives in order and client abort cancels the reader; HEAD has no body and never 500s; `text/html` passes through; host CORS headers on real responses and preflight; `vary` merged; `cache-control`/`pragma` from `getSession` never leak onto app routes                                                                                       |
| Errors     | before-hook `APIError` → its Response; non-`APIError` from `auth.handler` → a global exception filter sees it; no hang (completes within a timeout)                                                                                                                                                                                                                                                                      |
| Lifecycle  | `MiddlewareConsumer` middleware runs before the auth handler (no global prefix); a second `forRoot` for the same instance → boot error; unbind on `app.close()`; identical results under both bootstraps and on Nest 11 and 12                                                                                                                                                                                           |
| Hygiene    | probe cookies never appear in captured logs                                                                                                                                                                                                                                                                                                                                                                              |

**Transport cases** (invariants T1–T6):

| Id                           | Asserts                                                                                                                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T-selection`                | `handles()` is true only for its contexts                                                                                                                                                                                                    |
| `T-no-credentials`           | missing credentials → 401 `UNAUTHENTICATED`, no throw from `headers()`                                                                                                                                                                       |
| `T-credentials`              | cookie, bearer (bearer plugin) and `x-api-key` credentials are extracted                                                                                                                                                                     |
| `T-memo-once`                | at most one `getSession` per key under N guard invocations (`triple`: GraphQL 3 root fields → 1 call, S7)                                                                                                                                    |
| `T-cookie-forwarded`         | cookie-capable transports forward refresh cookies (`updateAge: 0`) and nothing but `set-cookie`                                                                                                                                              |
| `T-refresh-suppressed`       | cookie-less transports: DB `expiresAt` unchanged and no `Set-Cookie` with `updateAge: 0` (stateful), none with `refreshCache` near expiry (stateless); a probe after-hook confirms `getShouldSkipSessionRefresh() === true` inside the scope |
| `T-error-shape`              | payload per status (401/403/429) matches §13.3, `code` and `reason` intact                                                                                                                                                                   |
| `T-no-error-log`             | denials are not logged at ERROR (captured Nest logger)                                                                                                                                                                                       |
| `T-infra-5xx`                | adapter throwing → 5xx on protected handlers, never 401/403                                                                                                                                                                                  |
| `T-public-no-lookup`         | public handlers never call `getSession` (adapter call counter)                                                                                                                                                                               |
| `T-reads-session`            | `@Session()` handler with a non-session principal → 403 `SESSION_REQUIRED`                                                                                                                                                                   |
| `T-carrier` / `T-scope`      | decorators see the resolution (scope first, carrier fallback); WS concurrent messages on one socket see their own resolution                                                                                                                 |
| `T-subscription-credentials` | GraphQL subscription credentials extracted per driver (gates Mercurius subscriptions leaving preview)                                                                                                                                        |

**Principal-source cases** (P1–P4: `S-*`) and **policy cases** (Z1–Z4: `Z-*`) are smaller harnesses around a real instance, using the memory adapter plus better-auth's `testUtils()` (LEAD-V15).

### 14.2 Matrix `[A][B][C]`

| Axis                       | Values                                                                                                                                                                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NestJS                     | 11.x latest (11.0.x on the floor job), 12.x latest                                                                                                                                                                          |
| HTTP platform              | Express 5, Fastify 5 (each Nest major's bundled versions), + Fastify `http2: true` for `H-h2-pseudo`                                                                                                                        |
| Node                       | 22.12.0 (floor, require(esm) warning expected), 22.x latest, 24.x; 26.x advisory                                                                                                                                            |
| better-auth                | 1.7.0 (D4 floor), latest 1.x; nightly allowed-failure job against `next`                                                                                                                                                    |
| Consumer module system     | CJS (Nest 11 `nest new` template, TS `nodenext`), ESM (Nest 12 template); tarball fixtures (§14.6)                                                                                                                          |
| Transports                 | Apollo (`@nestjs/graphql` 13 on Nest 11, 14 on Nest 12) on Express and Fastify; Mercurius on Fastify; socket.io; ws (with `withUpgradeRequest`); RPC: TCP (payload carrier), NATS (container), gRPC                         |
| TypeScript (type fixtures) | 5.9, 6.x, 7.x × `nodenext` ESM, `nodenext` CJS, `bundler`, `node16` CJS; `skipLibCheck: true`; each fixture includes the `Register` augmentation and the `@ts-expect-error` assertions of EXP-A:`types/`, EXP-C2 and EXP-C9 |

- **HTTP conformance** runs the full cross product {Nest 11, 12} × {Express, Fastify} × {Node 22.12, 24} × {better-auth 1.7.0, latest}, sharded.
- **Transport suites** run on the Nest × platform combinations that apply.
- **A dedicated WS job** asserts the per-major difference on purpose: on 11 an undecorated gateway fails boot (B16); on 12 it is protected by the global guard.
- **Hybrid RPC** asserts the `inheritAppConfig` behavior.

### 14.3 Cookie-session end-to-end `[A][B][C]`

The current repo tests only bearer tokens (R:current-repo). This suite uses a real cookie jar:

1. Sign up and sign in over JSON **and** `application/x-www-form-urlencoded`, then call a protected controller route. With `session.updateAge: 0`, the app-route response carries the refreshed `session_token` `Set-Cookie` with a new max-age, the DB expiry matches, and there is no `cache-control`.
2. With `cookieCache.enabled`, the first guarded response carries `session_data`.
3. Stateless mode (no database): the refresh-cache branch re-issues cookies over HTTP. Over WS, GraphQL subscriptions and RPC nothing is issued.
4. A GraphQL query over HTTP refreshes cookies (Apollo on Express and on Fastify, Mercurius). Subscription and WS messages do not move the DB expiry.
5. A controller calling `auth.api.signInEmail` / `signOut` directly sets or clears cookies through the plugin bridge. The same call in a WS handler does not refresh.
6. An expired cookie gets 401 on required routes, with cleanup cookies forwarded.
7. API-key principal:
   - an invalid key on a `@Public()` route is never resolved (200);
   - on a required route it gets 401 with `reason: INVALID_API_KEY`;
   - on `@OptionalAuth()` it gets 401, never anonymous;
   - `verifyApiKey` is called once per request (usage counter).

### 14.4 Security end-to-end (origin check ON) `[A][B][C]`

better-auth disables origin/CSRF checks when `NODE_ENV=test` and falls back to IP 127.0.0.1 in dev/test (R:ba-core §3.3, §3.5). This suite therefore runs with `NODE_ENV=production`, sets `advanced.disableOriginCheck: false` explicitly, and uses a production-grade secret. Cases:

- a cross-origin POST with a session cookie → 403 `INVALID_ORIGIN`;
- a missing Origin with `sec-fetch-mode: cors` → 403 `MISSING_OR_NULL_ORIGIN` (Node's `fetch` sends that header, so tests set `Origin` explicitly);
- a cross-site navigation form login → 403;
- an untrusted `callbackURL` → 403;
- per-IP rate limiting with two clients, behind `trust proxy` on and off; spoofed `x-nsba-client-ip` and `x-forwarded-for` are ignored;
- `Host` header injection with a static `baseURL` changes neither URLs nor cookies;
- an oversized body → 413 before better-auth runs;
- an adapter throwing → 500 on protected routes, 200 on `@Public()` routes (the #159 regression);
- HTTP/2 requests do not crash (Fastify).

### 14.5 Unit and parity tests

- **Hook dispatcher parity** `[A][C]`. A property test generates random before-hook, after-hook and DB-hook functions (void, `{ context }` with headers, arrays and nested bodies, short-circuit objects, thrown `APIError`s, `false`, `{ data }`). It registers them once as N native better-auth plugins and once as N Nest hooks behind one `nestjs()` dispatcher, then asserts identical responses, headers, `ctx.context.returned` chains and DB effects. EXP-A:`exp-merge.mjs` and EXP-C10 are its seeds.
- **Resolver.** Concurrent guard invocations share one `getSession`; a rejection is memoized per key; TTL expiry works; a thrown `APIError` is normalized (§13.2).
- **Evaluator.** AND, `anyOf` (401-over-403 rule, first reason) and `allOf`; `PRINCIPAL_NOT_SUPPORTED`; the Z2 safety net; decision memo by requirement identity.
- **Planner.** Access resolution rules 1–5 of §7.6, class-chain accumulation, contradictions (B15), `readsSession`.
- **Helpers.** `toWebHeaders` (symbol key, pseudo-headers, arrays, `:authority` → `host`), `readBoundedBody` (declared, chunked, drain cap, Web streams), `writeWebResponse` (multi-cookie, `vary` merge, HEAD, backpressure), sink de-duplication.
- **Types.** `tsc` on `*.test-d.ts` with `@ts-expect-error`: permission typing, static-option guard, `customSession` `userId` requirement, hook path typing, named instances.

### 14.6 Packed-tarball smoke tests `[A][B][C]`

`pnpm pack` runs once per CI run, and the tarball (not the workspace) is installed into each fixture. The reference tested SWC-compiled `src` against a lockfile-pinned better-auth, which hid #97, #100, #108 and #115 (R:ref-issues §3.15).

1. **Fixtures:** `nest11-cjs-express`, `nest11-cjs-fastify`, `nest11-esm-express`, `nest12-esm-express`, `nest12-esm-fastify`, `nest12-cjs` (require(esm)). Each boots, signs up, calls a protected route with a real cookie session, runs one GraphQL query, and exits.
2. **Bundlers:** `nest build --webpack` and esbuild bundles of the Nest 12 fixture.
3. **Dual-load identity test.** Load `.mjs` and `.cjs` in one process. Register the module from one copy and decorators from the other, and assert that tokens, metadata, brands and the plugin handshake interoperate. Assert that the double-registration guards fire, and that `module-sync` resolves `require` to `.mjs` on 22.12+.
4. **Entry loading.** `require()` every entry from a CJS script and `import()` it from ESM, on Node 22.12 and 24, with no `ERR_REQUIRE_ASYNC_MODULE`.
5. **Artifact hygiene.** `dist` contains `design:paramtypes` metadata and no raw decorator syntax. `./plugin`'s import graph contains no `@nestjs/*` or `node:*`. The better-auth CLI (`npx @better-auth/cli generate`) loads a fixture `auth.ts` that uses `nestjs()`.
6. **Package checks:** publint `--strict`, attw `--profile node16`, and the consumer `tsc` matrix (§14.2).

### 14.7 Architecture fitness tests `[B]`

- **Import graph (dependency-cruiser).** Enforces the rules of §3.2:
  - `src/core/**` never imports `src/{module,extensions,plugin,testing}/**`;
  - extensions never import each other;
  - `src/plugin/**` never imports `@nestjs/*` or `node:*`;
  - only the composition root references concrete extension units.
- **Name literals.** A Biome restricted-syntax rule, with a grep fallback, forbids the literals `'express' | 'fastify' | 'graphql' | 'ws' | 'rpc' | 'http' | 'session' | 'admin' | 'organization' | 'api-key'` in `src/core/**`.
- **Coverage.** Every built-in extension unit has a CI job running its conformance kit.

### 14.8 Consumer testing utilities (`./testing`) `[A][B][C]`

```ts
// Unit/integration: fixed principal, real guard + policies, no better-auth I/O
const moduleRef = await overridePrincipal(
  Test.createTestingModule({ imports: [AppModule] }),
  { kind: "session", source: "test", userId: "u1", session: fakeSession },
).compile();

// Composed test module with a fixed principal source
BetterAuthModule.forRoot({
  auth,
  platforms: [expressPlatform()],
  session: false,
  principals: [testPrincipal(principal)],
});

// e2e with real cookies (the test auth instance includes better-auth's testUtils() plugin)
const headers = await authHeadersFor(auth, user.id);
await request(app.getHttpServer())
  .get("/projects")
  .set("cookie", headers.get("cookie")!)
  .expect(200);

// Replace the guard entirely (works because APP_GUARD uses useExisting)
overrideAuthGuard(Test.createTestingModule({ imports: [AppModule] }), {
  canActivate: () => true,
});

// init() + Fastify ready() when present (capability check, not a platform-name branch) + automatic close → unbinds the plugin
const app = await initTestApp(
  moduleRef.createNestApplication(new FastifyAdapter()),
);
```

The docs explain that `NODE_ENV=test` disables origin checks, when to switch them back on, and that closing apps is required by exclusive binding (B06).

## 15. Migration guide sketch from @thallesp/nestjs-better-auth

Target: apps on `@thallesp/nestjs-better-auth` 2.x (the v2.8.0 surface, R:ref-impl). This is a clean break (D3). Most changes are mechanical renames, and several of the old library's "requirements" disappear.

### 15.1 Checklist

1. Upgrade better-auth to `>=1.7.0` and Node to `>=22.12`.
2. `pnpm add nestjs-slightly-better-auth`, then remove `@thallesp/nestjs-better-auth`.
3. In `auth.ts`, add the plugin **last** and delete the empty hook placeholders:
   ```ts
   import { nestjs } from "nestjs-slightly-better-auth/plugin";
   export const auth = betterAuth({
     /* … */ plugins: [admin(), organization(), nestjs()],
   }); // no hooks: {} / databaseHooks: {}
   declare module "nestjs-slightly-better-auth" {
     interface Register {
       auth: typeof auth;
     }
   }
   ```
4. In `main.ts`, delete `bodyParser: false`. Nest's parsers, `rawBody: true` and body limits work again, and auth routes still get raw bytes. Configure CORS on the host, optionally with better-auth's trusted origins:
   ```ts
   app.enableCors({ origin: betterAuthCorsOrigin(auth), credentials: true });
   ```
5. Replace the module: `BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] })`, or `fastifyPlatform()`.
6. Rename decorators and move role checks to permissions (§15.2). Then remove the `UserSession<typeof auth>` and `AuthService<typeof auth>` generics.
7. Register non-HTTP transports: `apolloTransport()`, `mercuriusTransport()`, `socketIoTransport()`, `wsTransport()` or `rpcTransport()`. On Nest 11, add `@UseBetterAuth()` to gateways; boot fails until you do.
8. Boot the app once. The diagnostics (B01–B22) point at every remaining mistake with a fix.
9. Re-run your e2e tests with origin checks **on** (§14.4).

### 15.2 API mapping

| @thallesp/nestjs-better-auth 2.8.0                                                 | nestjs-slightly-better-auth                                                                                                              | Notes                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthModule.forRoot({ auth })` / `forRootAsync`                                    | `BetterAuthModule.forRoot({ auth, platforms })` / `forRootAsync({ platforms, useFactory })`                                              | the static/runtime split is type-checked and runtime-checked                                                                          |
| `forRoot(auth, options)` (deprecated overload)                                     | removed                                                                                                                                  |                                                                                                                                       |
| `disableGlobalAuthGuard` placed in the factory (silently ignored, #59/#159)        | `forRootAsync({ globalGuard: false, useFactory })`, or keep the guard and return `defaultAccess: 'public'`                               | static keys in the factory are a compile error and a boot error                                                                       |
| `disableGlobalAuthGuard: true`                                                     | `globalGuard: false` + `@UseBetterAuth()` where needed                                                                                   |                                                                                                                                       |
| `disableControllers: true`                                                         | `http: { mount: false }`                                                                                                                 | it now only disables the auth mount (the old flag also disabled parser re-adding and CORS)                                            |
| `bodyParser.{json,urlencoded,rawBody}`, `disableBodyParser`, `enableRawBodyParser` | removed; use Nest's own `rawBody`/`useBodyParser`                                                                                        | auth-route limit: `http.bodyLimit`                                                                                                    |
| `disableTrustedOriginsCors` / automatic CORS                                       | removed (the library owns no CORS)                                                                                                       | `betterAuthCorsOrigin(auth)` helper                                                                                                   |
| `middleware: (req, res, next) => …`                                                | `http: { around: [(call, next) => …] }`                                                                                                  | wraps the Web exchange; without a global prefix, `MiddlewareConsumer` middleware already runs before auth routes on Express           |
| `isGlobal`                                                                         | `isGlobal` (default true)                                                                                                                |                                                                                                                                       |
| `AuthGuard`                                                                        | `BetterAuthGuard`                                                                                                                        | `overrideProvider(BetterAuthGuard)` works (`useExisting`)                                                                             |
| `@AllowAnonymous()` / `@Public()`                                                  | `@Public()` if the handler never reads the session; `@OptionalAuth()` if it does                                                         | **behavior change:** `@Public()` performs no session lookup at all (#159). B15 flags `@Public()` handlers that read `@Session()`      |
| `@OptionalAuth()` / `@Optional()`                                                  | `@OptionalAuth()`                                                                                                                        | an explicitly invalid credential is now a denial, not anonymous                                                                       |
| `@Session() s: UserSession` / `UserSession<typeof auth>`                           | `@Session() s: AuthSession` / `SessionOf<typeof auth>`                                                                                   | throws a configuration error instead of returning `undefined` when no guard ran                                                       |
| `request.session`, `request.user`                                                  | `@Session()`, `@CurrentUser()`, `@CurrentPrincipal()`, `BetterAuthService.getSession()`                                                  | no properties are written on the request (no clash with express-session or Passport)                                                  |
| `@Roles(['admin'])`                                                                | `@RequirePermission({ <resource>: ['<action>'] })` with the admin plugin's access control, or the recipe in §15.3                        | the old `@Roles` trimmed around commas and ignored `adminUserIds`/`defaultRole` (R:ba-authz §4.2)                                     |
| `@OrgRoles(['owner'])`                                                             | `@RequireOrgPermission({ … })`                                                                                                           | permission-based; supports `organization: fromParam('orgId')`                                                                         |
| `@RequireActiveOrg()`                                                              | `@RequireOrgMember()`                                                                                                                    | now proves membership (removed members keep a stale `activeOrganizationId`)                                                           |
| `@UserHasPermission({ permission \| permissions, userId?, role? })`                | `@RequirePermission(permissions)`                                                                                                        | `userId`/`role` never had an effect (better-auth ignores them when headers are sent); singular `permission` is invalid in better-auth |
| `@MemberHasPermission({ permissions })`                                            | `@RequireOrgPermission(permissions, { organization? })`                                                                                  | can target a route-param org                                                                                                          |
| `@Hook()` class + `@BeforeHook('/p')` / `@AfterHook('/p')`                         | `@BeforeAuth('/p')` / `@AfterAuth('/p')` on any provider (no class marker)                                                               | return values honored (`{ context }`, short-circuit, replacement); unknown paths fail boot; typed contexts                            |
| `@DatabaseHook()` + `@BeforeCreate('user')` …                                      | `@BeforeDatabase('user.create')`, `@AfterDatabase('session.delete')` …                                                                   | `false` and `{ data }` honored; Nest DB hooks run before `auth.ts` DB hooks                                                           |
| `AuthService` (`.api`, `.instance`)                                                | `BetterAuthService` (typed via `Register`) or `@InjectAuth()`                                                                            | adds `context()`, `getSession()`, `getPrincipal()`, `headersFrom(req)`, `withoutCookies()`, `runOutsideScope()`                       |
| `AuthHookContext`, `DatabaseHookModel`                                             | `AuthHookContext<P>`, `DatabaseHookTarget`                                                                                               |                                                                                                                                       |
| WS: `@UseGuards(AuthGuard)` on gateways                                            | Nest 12: nothing (global guard); Nest 11: `@UseBetterAuth()` (boot-checked) + `socketIoTransport()`/`wsTransport()`                      | platform-ws now works (`withUpgradeRequest`)                                                                                          |
| GraphQL: `context: ({ req, res }) => ({ req, res })` required                      | not required; `transports: [apolloTransport()]` or `[mercuriusTransport()]`                                                              | subscriptions supported (Mercurius: preview)                                                                                          |
| RPC: effectively unsupported                                                       | `transports: [rpcTransport({ carriers })]`                                                                                               |                                                                                                                                       |
| Error bodies `{ statusCode, message, error }` / `'UNAUTHORIZED'` strings           | HTTP `{ statusCode, error, code, reason?, message }`; GraphQL `extensions.code`; WS/RPC `{ status, statusCode, code, reason?, message }` | §13.3                                                                                                                                 |
| `AUTH_MODULE_OPTIONS_KEY` (not the real token)                                     | `BETTER_AUTH_OPTIONS`, `BETTER_AUTH_INSTANCE`, `BETTER_AUTH_SERVICE`, `getAuthToken()` (`Symbol.for`)                                    |                                                                                                                                       |

### 15.3 Role names without the old `@Roles`

The preferred path is to model roles as access-control statements (`createAccessControl`) and use `@RequirePermission`. For teams that need role names now, a custom policy takes a few lines. It follows better-auth's storage format (comma-joined, **no trimming**) but deliberately does not replicate `adminUserIds`/`defaultRole`, so the choice stays explicit in application code (§17 Q1):

```ts
export const hasRole = definePolicy<{ roles: string[] }, "session">({
  id: "app:has-role",
  requires: { plugins: ["admin"], principals: ["session"] },
  evaluate: ({ roles }, ctx) => {
    const userRoles = String(
      (ctx.principal.session.user as { role?: string | null }).role ?? "",
    ).split(","); // no trim, like better-auth
    return roles.some((r) => userRoles.includes(r))
      ? allow()
      : deny({ reason: "MISSING_ROLE" });
  },
});
export const RequireRole = (...roles: string[]) => Require(hasRole({ roles }));
```

### 15.4 Behavior changes to verify after migrating

- **Refreshed session cookies now reach the browser on ordinary routes.** This fixes a latent expiry drift. CDN and proxy rules keyed on the absence of `Set-Cookie` should be reviewed.
- **`@Public()` no longer attaches a session.** Handlers that read `@Session()` on public routes need `@OptionalAuth()`, and B15 tells you which ones.
- **Authorization infrastructure failures are now 5xx, not 403.** Monitoring may see new 5xx where 403s used to hide outages.
- **Nest hooks can now short-circuit or rewrite input.** A hook that returned an object "for logging" now short-circuits the endpoint.
- **Path-less hooks still see the guard's `/get-session` calls**, as in better-auth. Use `skipInternal: true` for audit-style hooks.
- **The auth path comes from better-auth** (a `baseURL` path beats `basePath`), not from `auth.options.basePath`. Check that the client's `baseURL` agrees.
- **The rate-limit IP comes from the platform** (`trust proxy` / `trustProxy`). Configure it behind a proxy.
- **On Nest 11, WebSocket gateways that were silently unprotected now fail boot** until you mark them `@UseBetterAuth()` or `@Public()`.
- **On Fastify:**
  - `@fastify/cors`, helmet and `onSend` hooks now apply to auth routes;
  - the app's JSON parser is Fastify's secure one again (the reference had replaced it and dropped proto-poisoning protection);
  - the `qs` optional peer is no longer needed.

## 16. Decision log

Every entry records the decision, where it came from, the alternatives rejected (including those proposed by other drafts), the rationale, and the evidence. Draft ADR numbers are given as `A-ADR-n`, `B-ADR-n` and `C-ADR-n`.

**ADR-01. Auth routes are raw platform routes that call `auth.handler` with a `Request` we build.**

- _From:_ [A] A-ADR-1, [B] B-ADR-01, [C] C-ADR-02. All three drafts agree.
- _Rejected:_
  - better-call `toNodeHandler` (the reference): loses the query string under some mounts, crashes on HTTP/2, trusts `x-forwarded-proto`, re-serializes consumed bodies, has no chunked body limit;
  - a Nest `@All` controller: gets the global prefix and versioning; `*path` fails on Fastify; Fastify's `@All` ignores version constraints;
  - `MiddlewareConsumer` mounting: path semantics differ per platform, it bypasses `@fastify/cors`, and prefix exclusion needs Nest internals.
- _Rationale:_ this is better-auth's own seam (P1/P2). It bypasses Nest's router, prefix and versioning by construction, and it gives full control of header hygiene, IP and body limits.
- _Evidence:_ R:nest-platform §5, §6.1; R:ref-issues cluster 1 (seven mount rewrites); EXP-B:E4; EXP-A:`exp-e2e.mjs`; EXP-C4–C6.

**ADR-02. The `nestjs()` plugin is mandatory and validated at boot (B03), even for apps without hooks.**

- _From:_ [A] A-ADR-3, [C] C-ADR-01.
- _Rejected:_
  - [B] Q2: optional-with-degradation, required only once hooks exist;
  - no plugin, with cookies handled only in the guard;
  - mutating `auth.options`, which S1 forbids.
- _Rationale:_ several requirements can only be met from inside a better-auth dispatch:
  - suppressing the stateless refresh-cache branch needs `setShouldSkipSessionRefresh`, and nested plugin-endpoint refreshes need an any-path hook (S2);
  - the client-IP header must be declared through `init()`;
  - cookie forwarding for direct calls is better-auth's own `nextCookies` pattern.

  B's degraded mode creates two behavior modes users cannot see: some cookies are silently lost, and some plugin endpoints refresh on cookie-less transports (B's own §7.4 table). The cost is one line in `auth.ts`, backed by a boot check with a copy-paste fix.

- _Evidence:_ EXP-A:`exp-plugin.mjs` (control row); EXP-B:E2, E3; EXP-C1; LEAD-V2, LEAD-V3.

**ADR-03. Express uses two phases: bounded raw capture at `HttpAdapterHost.init$`, dispatch in `onModuleInit`, and a deferred 413.**

- _From:_ [A] A-ADR-4, [B] B-ADR-08, [C] C-ADR-03. The drain-and-flag 413 is from [A][B].
- _Rejected:_
  - requiring `bodyParser: false`: breaks `rawBody`, limits and `@nestjs/testing` (#16, #88, #101, #111);
  - mounting everything at `init$`: bypasses the user's CORS and middleware;
  - pre-empting parsers by function name: loses `rawBody` and is defeated by `useBodyParser`;
  - accepting re-serialization: lossy, and breaks Stripe signatures;
  - answering 413 inside phase A: EXP-A showed it lacks CORS headers.
- _Rationale:_ this is the only combination that gives byte-exact bytes, host middleware and CORS, controller precedence, Nest-native parsing elsewhere, and identical behavior under both bootstraps and both majors.
- _Evidence:_ EXP-A:`exp-express.mjs`, `exp-e2e.mjs`; EXP-B:E1 (413 with ACAO); EXP-C4/C5; `body-parser/lib/read.js:40-44`.

**ADR-04. Fastify uses an encapsulated plugin with a `'*'` `parseAs: 'buffer'` parser and `bodyLimit`, writing back through `reply` (never `hijack`, never `reply.send(Response)`).**

- _From:_ [A] A-ADR-17. The write-back rules are shared by [A][B][C].
- _Rejected:_
  - [B]: a pass-through parser plus a hand-rolled bounded reader (works, EXP-B:E4, but duplicates Fastify's limit logic);
  - [C] C-ADR-04: a root route answering from a route-level `onRequest` (works, EXP-C6, but runs handler logic in a hook, and C's claim that encapsulated routes load only at `ready()` is contradicted by EXP-B:E10);
  - middie middleware: bypasses `@fastify/cors` and `onSend`;
  - replacing the root parsers (the reference): loses proto-poisoning protection.
- _Rationale:_ Fastify enforces the limit natively and answers 413 through the reply lifecycle, so CORS survives. The bytes are exact, including requests without a content-type. Parsers are isolated per context.
- _Evidence:_ LEAD-V10; EXP-A:`exp-e2e.mjs` (413 with ACAO, byte-exact); EXP-B:E10; R:nest-platform §3.2, §6.3.

**ADR-05. HTTP platforms, transports and principal sources register through explicit static lists of `ExtensionRef`s. Express and Fastify live in their own subpaths and must be listed (`platforms: [expressPlatform()]`).**

- _From:_ explicit registration is [A] A-ADR-5 and [B] B-ADR-02, B-ADR-03. The `ExtensionRef` union (class | instance | definition) merges [A]'s `ExtensionDefinition` with [B]'s `ExtensionProvider`. Additive lists with built-ins appended last are from [A][C].
- _Rejected:_
  - [C] C-ADR-14: Express and Fastify in the root entry, auto-selected. Zero-config, but it blurs "each is an extension unit" (D2), and the root would ship platform code;
  - [B]: transport lists that _replace_ the defaults. More ceremony (`...defaultTransports()`) for no gain;
  - discovery for everything: order between principal sources becomes implicit;
  - a passport-style global registry filled by constructor side effects.
- _Rationale:_ registration is deterministic where order matters (sources, transports), core never names an extension, and a missing platform fails boot with the exact import to add (B08). The DX cost is one import (§17 Q12).
- _Evidence:_ R:nest-di §2.3, §3.3, §6.2; R:nest-platform §8.1 (`getType()` is an open set).

**ADR-06. Refresh suppression is an any-path plugin before-hook (`setShouldSkipSessionRefresh(true)` in cookie-less scopes, gated on `_flag !== 'router'`) plus `disableRefresh` on the session source.**

- _From:_ [A], [B] B-ADR-05, [C] C-ADR-08. All agree; the `_flag` gate is from [A].
- _Rejected:_
  - `disableRefresh` only: misses the stateless refresh-cache branch and nested plugin endpoints;
  - `runWithRequestState` from `@better-auth/core/context`: an extra peer, and state set outside the endpoint's own store is not seen;
  - the `nextCookies`-style `/get-session`-only matcher: misses `hasPermission` and `getActiveMember` refreshes.
- _Rationale:_ the flag is set inside the dispatch's own request state, exactly where `getSession` reads it. It reuses the mechanism better-auth uses for RSC.
- _Evidence:_ LEAD-V2, LEAD-V3, LEAD-V14; EXP-A:`exp-plugin.mjs`; EXP-B:E2, E3; EXP-C1.

**ADR-07. Nest hooks enter better-auth through fixed dispatcher entries plus a late-bound registry; the dispatcher mirrors `dispatch.ts` merge semantics using `defu`.**

- _From:_ [A] A-ADR-2, [B] B-ADR-06, [C] C-ADR-07. All agree on the mechanism. Using `defu` (better-auth's own dependency) instead of a hand-rolled merge is from [A]; the parity property test is from [A][C].
- _Rejected:_
  - mutating `auth.options.hooks` (the reference): S1, fragile (#42), drops return values;
  - pushing one entry per Nest hook into the plugin's arrays at bind time: exact composition for free, but it depends on better-auth re-reading plugin arrays per dispatch, an implementation detail (LEAD-V1);
  - requiring hooks to be written in `auth.ts`: no DI;
  - [C]'s local ~15-line merge: divergence risk.
- _Rationale:_ it relies only on the public plugin contract and preserves every return semantic. The parity test keeps it faithful across releases.
- _Evidence:_ LEAD-V1; EXP-A:`exp-merge.mjs` (SAME); EXP-B:E2; EXP-C10.

**ADR-08. Hook discovery needs no class marker, and hooks include library-internal calls by default (`skipInternal` opt-out). String patterns are validated at boot.**

- _From:_ no marker and boot validation are [C]; the internal-calls default is [A][C].
- _Rejected:_
  - [A] `@BetterAuthHooks()` and [B] `@AuthHooks()` class markers: forgetting the marker silently disables hooks;
  - [B] excluding internal calls by default (`includeInternalCalls` opt-in): a `@BeforeAuth('/get-session')` security hook, for example blocking banned users, would silently not protect guarded routes;
  - [B] `*`/`**` wildcard patterns: they cannot be validated against the endpoint list. Predicates cover the need.
- _Rationale:_ this is faithful to better-auth, where user hooks also run for server calls, and follows Nest's own `@OnEvent`/`@Cron` discovery idiom. Unknown paths fail boot with a "did you mean".
- _Evidence:_ R:ba-core §4.1; R:ref-issues #103; EXP-C8, EXP-C9.

**ADR-09. Guard-side `getSession` uses `returnHeaders: true` and forwards only `set-cookie`, with the plugin bridge disabled for that one call; policy calls use the bridge; the kernel's cookie sink de-duplicates.**

- _From:_ [A] A-ADR-16 (bridge off for the guard call); [C] (sink de-duplication); S2.
- _Rejected:_
  - [B] B-ADR-07: an `AuthApiInvoker` through which every internal call must pass. It works, but third-party sources and policies must remember to use it, and the bridge already covers them;
  - relying on the bridge alone: S2 requires `returnHeaders` for `getSession` explicitly;
  - forwarding all headers: leaks `cache-control: no-store`.
- _Rationale:_ S2 literally, one forwarding path per call, and third-party authors call `auth.api` normally.
- _Evidence:_ EXP-A:`exp-e2e.mjs` (single cookie, `cache-control=null`); EXP-B:E7; R:ba-core §4.3.

**ADR-10. The principal is memoized per `(transport key, instance, freshness)` in a `WeakMap`, with the promise stored before it settles; rejections are memoized too.**

- _From:_ [A] A-ADR-9, [B] §7.5, [C] C-ADR-19.
- _Rejected:_
  - a request-scoped provider: it makes every controller request-scoped;
  - `req.session`/`req.user`: collides with express-session and Passport;
  - [B]'s 300 s per-connection default key for WebSockets (see ADR-18).
- _Rationale:_ S7, including GraphQL root fields sharing one resolution, and no retry storms against a failing DB.
- _Evidence:_ EXP-B:E8 (3 guard calls → 1 resolution); R:nest-di §3.3, §3.4.

**ADR-11. The per-invocation scope comes from `BetterAuthScopeInterceptor` plus explicit internal scopes (`handle.run`), not from a platform-level scope opened at `init$`.**

- _From:_ [A] (interceptor + `handle.run`); [L] (race analysis).
- _Rejected:_ [B] and [C] open an ALS scope in the platform's earliest hook. Their "scope is lost after parsing" concern does **not** apply to body-parser (LEAD-V11), so the rejection rests on other grounds:
  1. it covers HTTP only; WS and RPC would still need an interceptor;
  2. param decorators on WebSockets cannot find a per-message resolution by key, because param factories get a fresh `args` array (LEAD-V7), and stamping it on the socket races across concurrent messages. The interceptor sees the guards' `args` and publishes the resolution race-free;
  3. it enlarges every third-party platform's contract (C's conformance case P13 exists because it is easy to get wrong, EXP-C5).
- _Rationale:_ transport-neutral, it runs after body parsing, it gives race-free decorators, and the platform contract stays small. The gap (middleware and other libraries' guards run outside the scope) is documented, with `withoutCookies`/`returnHeaders` as the workaround.
- _Evidence:_ LEAD-V6, LEAD-V7, LEAD-V11; EXP-A:`exp-e2e.mjs` (bridge through the interceptor on Nest 11/12 × Express/Fastify).

**ADR-12. Requirements carry their policy by reference (value or DI class/token); there is no policy registry.**

- _From:_ [B] B-ADR-03, [C] C-ADR-09.
- _Rejected:_
  - [A] A-ADR-5: a `Map<kind, policy>` registry filled from a `policies` list. It needs registration in `forRoot`, and a missing entry is only a boot error;
  - the reference's `if` chain.
- _Rationale:_ a new policy is a new value with nothing to register, which is pure OCP. References survive a dual-package load, DI-backed policies are ordinary providers, and boot validation still resolves every reference (B14).
- _Evidence:_ R:ba-authz §5.4; R:nest-di §10.6.

**ADR-13. "Denials are values, exceptions are infrastructure": principal sources return a `PrincipalResult` union and policies return `AuthorizationDecision`s, with a kernel safety net for thrown `APIError`s.**

- _From:_ [B] (result union, invariants P1/Z1); the decision helpers are from [A][B][C]; the safety-net mapping is from [A] (policy 401 → 403) and [C] (other 4xx → configuration error).
- _Rejected:_ [A] and [C] let sources throw a denial (`AuthDenial` / `AuthError`). That is less explicit, and a forgotten catch turns a denial into an unintended path.
- _Rationale:_ the rule is teachable, LSP-checkable, and keeps S6 airtight.
- _Evidence:_ R:ba-authz §5.3; R:ref-impl §6.1.

**ADR-14. Auth routes live at better-auth's own path, resolved from `(await $context).baseURL` (falling back to `options.basePath || '/api/auth'` for unset or dynamic `baseURL`), outside Nest's global prefix and versioning.**

- _From:_ [A], [B] B-ADR-04, [C] C-ADR-20.
- _Rejected:_
  - honoring the global prefix: two sources of truth, and the `/api/api/auth` regression that forced the revert of PR #80;
  - reading `auth.options.basePath`: wrong when `baseURL` has a path.
- _Rationale:_ S3. better-auth's client, callbacks and trusted origins derive from `baseURL`.
- _Evidence:_ EXP-B:E11; R:ba-core §3.7; `BA/api/index.ts:280`.

**ADR-15. The client IP travels in a plugin-declared header (`x-nsba-client-ip`) that core strips and sets from the platform's trust-proxy-aware IP.**

- _From:_ [A] A-ADR-6, [B] B-ADR-15, [C] C-ADR-06. The header name is [A][B]'s.
- _Rejected:_
  - [C]'s `x-nestjs-client-ip`: suggests Nest itself sets it;
  - passing `x-forwarded-for` through: spoofable unless better-auth's `trustedProxies` duplicates the proxy config;
  - requiring `trustedProxies`: easy to forget, and production collapses into one bucket;
  - overwriting `x-forwarded-for`: rewrites a header other code may read.
- _Rationale:_ one trust configuration (the platform's), spoof-proof, a user list keeps precedence (defu), and it feeds both rate limiting and session IP recording.
- _Evidence:_ EXP-A:`exp-e2e.mjs`; EXP-B:E9; EXP-C7; LEAD-V4.

**ADR-16. The error model is a transport-neutral `AuthFailure` value with a stable `code` (UNAUTHENTICATED/FORBIDDEN/RATE_LIMITED) plus a detailed `reason`. Infrastructure is `BetterAuthInfrastructureError` (5xx, logged); transports own the mapping.**

- _From:_ two-level code/reason is [C]; the value object is [B]; mapping in transports is [A] A-ADR-13, [B] B-ADR-09, [C] C-ADR-17.
- _Rejected:_
  - [A]'s better-auth code as the top-level `code` (an unbounded set for clients to switch on);
  - [C]'s `AuthError` class hierarchy (`instanceof`-prone across copies; thrown classes still need per-transport mapping);
  - exception filters as the mapping point (they never reach gateways; hybrid RPC needs `inheritAppConfig`).
- _Rationale:_ S6. Clients switch on three codes and get detail in `reason`. A new transport gets the whole taxonomy by implementing one method.
- _Evidence:_ R:nest-di §5; R:ref-impl §6.1.

**ADR-17. GraphQL denials are an `IntrinsicException` subclass carrying `extensions` (`BetterAuthGraphqlDenial`).**

- _From:_ [L]. It resolves a conflict between [A]/[C] and [B].
- _Rejected:_
  - [A] A-ADR-13 and [C] Q10, a plain `GraphQLError`: Nest's `ExternalExceptionFilter` logs it at ERROR on every denial;
  - [B] B-ADR-09, an `HttpException` with `extensions`: Apollo's `autoTransformHttpErrors` overwrites `extensions.code` and maps 429 to `INTERNAL_SERVER_ERROR`.
- _Rationale:_ codes are preserved for 401, 403 and 429, nothing is logged, and graphql-js copies `originalError.extensions` for both drivers.
- _Evidence:_ LEAD-EXP-1 (Nest 11.1.17 + Apollo 13.2.4); LEAD-V8, LEAD-V9. Mercurius and Nest 12 are pinned by `T-error-shape` (RK3).

**ADR-18. WebSockets use message-level guards with a per-message default (`principalTtlMs: 0`). A boot check requires `@UseBetterAuth()` only where global enhancers do not reach gateways (Nest 11, or `globalGuard: false`). `ws` upgrade headers come from a `withUpgradeRequest` mixin.**

- _From:_ the per-message default is [A][C]; the capability-probed coverage check is [C] C-ADR-18; the mixin is [B][C]; `WsConnectionAuth` is [B].
- _Rejected:_
  - [A] A-ADR-14, requiring an explicit guard on both majors: portable, but it forces redundant decorators on Nest 12, npm `latest`;
  - [B] Q11, documentation only: Nest 11 gateways stay silently open;
  - [B] a 300 s per-connection cache default: revocation lag by default;
  - [A] shipping `BetterAuthIoAdapter`/`BetterAuthWsAdapter` subclasses: they conflict with Redis or custom adapters.
- _Rationale:_ secure by default, and the check fails closed when the probe is inconclusive. The probe lives in the WS extension unit, not in core, so R4 holds.
- _Evidence:_ LEAD-V6, LEAD-V12, LEAD-V13; R:nest-di §3.4 runtime table; EXP-B:E6.

**ADR-19. Types come from `Register` augmentation (better-auth's idiom), generics are the escape hatch, and C's type-level enforcement is adopted. There is no typed factory.**

- _From:_ [A] §11, [B] §11, [C] C-ADR-10. The `AuthOf<N>` named-instance registry is [A]. `DefaultInstanceCheck`, the `SessionOption` required `userId`, `BetterAuthFactoryResult`, `EndpointPath` and `AuthHookContext<P>` are [C].
- _Rejected:_
  - `createAuthDecorators<typeof auth>()`: inlines types into consumer declarations; a service class per call is a new DI token;
  - generics only: repetitive at every use site.
- _Rationale:_ zero generics in the common case, tiny declaration output, and misconfiguration as compile errors.
- _Evidence:_ EXP-A:`types/` (tsc 5.9.3 exit 0); EXP-C2, EXP-C3, EXP-C9; R:ba-authz §3.6.

**ADR-20. Dual packaging is `module-sync`-first (ESM canonical), with `Symbol.for` identities, explicit `@Inject`, and a separate plugin build.**

- _From:_ [A] A-ADR-12, [B] B-ADR-11, [C] C-ADR-13. The separate plugin build is [A].
- _Rejected:_
  - `node` → CJS routing and an ESM wrapper over CJS: CJS canonical against better-auth's and Nest 12's ESM direction;
  - ESM-only: R3;
  - plain `import`/`require`: class-identity hazard;
  - tsdown `exports: true`: no `types` conditions and no `module-sync`.
- _Rationale:_ one copy per process on every supported Node, the CJS artifact still ships and is smoke-tested, and several layers of defense in depth.
- _Evidence:_ R:packaging §5.2–5.4 (variant A green).

**ADR-21. The better-auth floor is 1.7.0 (D4).**

- _From:_ [A] A-ADR-11.
- _Rationale:_ the design depends on:
  - `createAuthMiddleware`, `setShouldSkipSessionRefresh`, `isAPIError` and `APIError` exported from `better-auth/api`;
  - `ctx._flag`;
  - `$context.getPlugin`/`hasPlugin`;
  - `auth.api[*].path`.

  It does _not_ depend on better-call's body fallback, because we build the `Request` ourselves.

- _Evidence:_ LEAD-V2; EXP-C8; the matrix tests 1.7.0 and latest.

**ADR-22. The dynamic module is hand-written, with the static/runtime split enforced at compile time and at runtime.**

- _From:_ [A] A-ADR-15, [B] B-ADR-16, [C] C-ADR-11. The runtime rejection and readable error type are from [C].
- _Rejected:_ `ConfigurableModuleBuilder` extras: they leak into options, are invisible to providers, and cannot come from factories.
- _Evidence:_ R:nest-di §1.2–1.3; #59, #88, #159; EXP-C9.

**ADR-23. Secure by default: the global guard is on, `defaultAccess: 'authenticated'`, `@Public()` does zero I/O, and bad credentials are never downgraded. A method-level `@Public()`/`@OptionalAuth()` is an explicit opt-out of class-level requirements; same-level contradictions fail boot.**

- _From:_ [A] A-ADR-10, [B] B-ADR-17, [C] C-ADR-12. The opt-out rule is [C] (Q8); `defaultAccess` is [C].
- _Rejected:_
  - [A]: a route with requirements anywhere is always authenticated, and a method-level `@Public()` under class requirements is a boot error. That is fail-closed, but it breaks the common "one public endpoint in a protected controller" case and is non-idiomatic for Nest (`getAllAndOverride`);
  - opt-in guards (throttler style);
  - opportunistic resolution on public routes (the reference; #159).
- _Rationale:_ the opt-out is explicit and visible in code, and the boot summary counts public handlers. §17 Q3 lets the user choose A's stricter rule.

**ADR-24. Names.**

- _Decision:_
  - `BetterAuthModule`, `BetterAuthGuard`, `BetterAuthService`, `BetterAuthScopeInterceptor`, `UseBetterAuth` ([A][B]);
  - `Public`, `OptionalAuth`, `RequireAuth` ([C]);
  - `Require` + `anyOf`/`allOf` ([C], [B]'s combinators);
  - `RequirePermission`, `RequireOrgPermission`, `RequireOrgMember`, `RequireFreshSession` ([A][C]);
  - `Session`, `CurrentUser`, `CurrentPrincipal` (`CurrentPrincipal` from [B], to avoid clashing with the `AuthPrincipal` type);
  - `BeforeAuth`, `AfterAuth`, `BeforeDatabase('model.op')` ([B][C], target string from [C]);
  - `nestjs()` ([A][C]).
- _Rejected:_
  - `AuthModule`/`AuthGuard` ([C]): they collide with apps' own `AuthModule` and `@nestjs/passport`'s `AuthGuard`;
  - `@Authorize`/`@Permissions` ([B]): less explicit about AND semantics;
  - `nestjsBridge()` ([B]).
- _Evidence:_ D3; R:ba-authz.

**ADR-25. Exclusive binding: one live Nest app per better-auth instance.**

- _From:_ [B] B-ADR-06, [C] C-ADR-15.
- _Rejected:_ [A]'s attach/detach per app with ALS-based host routing. It is complex, ambiguous for calls outside any scope (A falls back to "most recently attached"), and it silently allows double side effects.
- _Rationale:_ a forgotten `app.close()` or a double import becomes a loud boot error, and hooks never leak across apps.
- _Evidence:_ R:ref-impl §5.3.

**ADR-26. Named better-auth instances are supported in v1; dynamically swappable instances are not.**

- _From:_ [A] §5.5, [C] §5.5.
- _Rejected:_
  - [B] B-ADR-18, one instance in v1 with a seam kept: reference issues #51/#79 show real demand, and the token and metadata design already supports it at low cost;
  - dynamic instances: they conflict with better-auth's construction-time model.
- _Evidence:_ R:ref-issues #51, #79.

**ADR-27. Built-in policies live in per-plugin subpaths (`./admin`, `./organization`, `./api-key`), with `freshSession` in core. There are no role-name decorators in v1.**

- _From:_ subpaths are [A]; no roles is [B][C].
- _Rejected:_
  - [B]/[C] admin and org policies in the root entry: that blurs "one unit per better-auth plugin";
  - [A] an opt-in exact-mirror `RolePolicy` in `./admin`: it would reimplement admin internals such as `adminUserIds` and `defaultRole` (§17 Q1).
- _Rationale:_ this mirrors better-auth's own plugin-first layout.

**ADR-28. Authoritative identity reads are a plan attribute (`@RequireAuth({ authoritative: true })`): one `getSession` with `disableCookieCache` when stateful. `freshSession()` is 0-I/O.**

- _From:_ [C] (freshness in the plan); [A] (0-I/O fresh-session policy).
- _Rejected:_
  - [A]'s separate `AuthoritativeSessionPolicy`: a second read per request;
  - [B]'s `FreshSessionPolicy` re-reading the session: unnecessary, because `createdAt` is immutable.
- _Evidence:_ LEAD-V3; `BA/api/routes/session.ts:520-539`.

**ADR-29. `@Session()`/`@CurrentUser()` imply a session principal (403 `SESSION_REQUIRED` otherwise), and `@Public()` combined with them fails boot.**

- _From:_ [C] C-ADR-22, B12.
- _Rejected:_ [A]/[B] returning `null` there, which lies against an `AuthSession` annotation and hides the migration trap left by the old `@AllowAnonymous`.

**ADR-30. Param decorators are synchronous and read the scope, then the carrier stamp; otherwise they throw.**

- _From:_ [A] (carrier stamp, throw); [C] (sync, throw); [L] (scope first).
- _Rejected:_ [B] B-ADR-10, a sync factory plus a DI pipe that resolves lazily even without a guard. It hides unguarded routes, does I/O in the pipe stage, and interacts with global `ValidationPipe` configuration.
- _Evidence:_ LEAD-V7; R:nest-di §4.3; EXP-B:E6 (the pipe approach works, but was not chosen).

**ADR-31. Plugin handles are unbound in `onApplicationShutdown`.**

- _From:_ [C].
- _Rejected:_ `onModuleDestroy` ([A][B]): it runs before the HTTP server stops accepting requests, so in-flight requests would lose their hooks.
- _Evidence:_ Nest 11.1.17 `core/nest-application-context.js:126-133`.

**ADR-32. HEAD and OPTIONS are passed through to better-auth.**

- _From:_ [B] Q10, [C] C-ADR-21.
- _Rejected:_ answering HEAD as a body-less GET. It would run GET side effects (session refresh writes) under a different method, and better-auth deliberately answers HEAD itself (404).
- _Evidence:_ R:ba-core §3.1.

**ADR-33. CORS belongs to the host. The library guarantees host CORS reaches auth routes and ships `betterAuthCorsOrigin(auth)`, which throws for function-valued `trustedOrigins`.**

- _From:_ [A] A-ADR-7, [B] B-ADR-14, [C] C-ADR-05. The throw is [C].
- _Rejected:_
  - library-owned CORS derived from `trustedOrigins` (the reference, @nestm): exact-match bugs with wildcards (#69), Fastify double registration (#52), app-wide side effects (#95), different behavior per platform;
  - [A]/[B]'s helper silently using init-time values of a request-dependent function.
- _Evidence:_ R:ba-integrations §0.2; R:ref-issues §3.4; EXP-B:E1/E4; EXP-C4/C6.

## 17. Open questions and residual risks

### 17.1 Open questions for the user (genuine product trade-offs, each with a recommendation)

| #   | Question                                                                                                             | Options                                                                                                                                                                                                                          | Recommendation                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Ship a role-name decorator (`@RequireRole`)?                                                                         | (a) none; permissions only plus the §15.3 recipe ([B][C]). (b) ship a `RolePolicy` in `./admin` that mirrors better-auth's parsing exactly, including `adminUserIds`/`defaultRole` ([A]). (c) the reference's trimming semantics | **(a) in v1.** (b) reimplements admin-plugin internals that can drift from better-auth (R1). (c) creates privilege differences. Revisit if better-auth adds a role-check API or users ask repeatedly. |
| Q2  | Default WebSocket principal reuse                                                                                    | per message (`principalTtlMs: 0`, [A][C]) vs per connection for 300 s ([B])                                                                                                                                                      | **Per message.** It is secure by default and costs one read per message with no writes (refresh suppressed). Document `principalTtlMs` for chat workloads.                                            |
| Q3  | Should a method-level `@Public()`/`@OptionalAuth()` opt out of class-level requirements?                             | allow as a visible exception ([C]) vs boot error, fail-closed ([A])                                                                                                                                                              | **Allow.** It fits the common "one public endpoint in a protected controller" case and is Nest-idiomatic. Same-level contradictions still fail boot, and the boot summary counts public handlers.     |
| Q4  | Two live Nest apps sharing one better-auth instance                                                                  | exclusive: boot error ([B][C]) vs shared with per-app routing ([A])                                                                                                                                                              | **Exclusive.** It surfaces double side effects and forgotten `app.close()` early. Concurrent apps create one instance each.                                                                           |
| Q5  | Default auth-route body limit                                                                                        | 100 KiB (Express default) vs 1 MiB (Fastify default)                                                                                                                                                                             | **1 MiB.** SAML responses and SCIM payloads can be large, and it is configurable.                                                                                                                     |
| Q6  | Declare the client-IP header by default                                                                              | on vs off                                                                                                                                                                                                                        | **On**, with the B18 production warnings. Otherwise production rate limiting collapses into one bucket.                                                                                               |
| Q7  | Mercurius subscriptions at 1.0                                                                                       | stable vs _preview_ until `T-subscription-credentials` passes in CI                                                                                                                                                              | **Preview.** The context shape is code-derived only.                                                                                                                                                  |
| Q8  | First-party OAuth-provider / MCP access-token principal source in v1                                                 | ship `./oauth-provider` vs the §4.3.4 example only                                                                                                                                                                               | **Example in v1, subpath in 1.x**, once DPoP replay-store configuration is designed.                                                                                                                  |
| Q9  | Org permission checks: endpoint (1 extra session read) vs the pure `hasPermission` export plus our own member lookup | endpoint vs pure                                                                                                                                                                                                                 | **Endpoint in v1.** It has exact semantics, including dynamic access control, and avoids the unbounded process-global `cacheAllRoles`. Measure later.                                                 |
| Q10 | Dynamically swappable instances (reference #79)                                                                      | support vs named instances only                                                                                                                                                                                                  | **Named instances only.** Swapping plugins at runtime conflicts with better-auth's construction-time model.                                                                                           |
| Q11 | Revalidate long-lived GraphQL subscriptions                                                                          | at subscription start only vs periodically                                                                                                                                                                                       | **Start only in v1.** Periodic revalidation needs driver hooks and is planned later.                                                                                                                  |
| Q12 | HTTP platform registration                                                                                           | explicit `platforms: [expressPlatform()]` with Express/Fastify in subpaths ([A][B]) vs auto-detected built-ins in the root entry ([C])                                                                                           | **Explicit.** Each built-in is visibly an extension unit (D2, R4). A missing platform fails boot with the exact import to add. The cost is one line.                                                  |

### 17.2 Residual risks

| #    | Risk                                                                                                                                                                                                                                                                                                       | Likelihood / impact | Mitigation                                                                                                                                                                                   |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RK1  | Reliance on better-auth surfaces its own integrations use but does not formally document: `ctx._flag`, `ctx.context.responseHeaders`/`returned` in after-hooks, `setShouldSkipSessionRefresh` semantics, `getPlugin()` returning the user's plugin object, `init().options` defu merge, `auth.api[*].path` | low / high          | CI against 1.7.0, latest and a `next` nightly; the dispatcher parity property test (§14.5); a dedicated test per surface; a protocol-versioned handle (B04)                                  |
| RK2  | `customSession` swallows errors of its inner `getSession` into `null`, so a storage outage looks like 401 for those apps (`BA/plugins/custom-session/index.ts:100-107`)                                                                                                                                    | medium / medium     | documented; cannot be fixed without reimplementing `getSession` (R1); propose an upstream change                                                                                             |
| RK3  | Code-derived, not run: GraphQL subscription context shapes (Apollo graphql-ws wrapping; Mercurius); `extensions` delivery on Mercurius and on Nest 12 Apollo; gRPC error mapping on Nest 11. LEAD-EXP-1 covered Apollo on Nest 11 + Express only                                                           | medium / medium     | conformance cases pin them before 1.0; Mercurius subscriptions stay preview (Q7); `subscriptionCredentials` override                                                                         |
| RK4  | A future top-level await anywhere in better-auth's or Nest 12's graph breaks every CJS consumer's require(esm) (R:packaging §1.4)                                                                                                                                                                          | low / high          | a nightly CJS fixture against better-auth `next`; nothing we ship can fix it. If it happens, entry points that must load better-auth lazily become async (planned fallback, not built in v1) |
| RK5  | Toolchains that ignore `module-sync` and mix `require` with `import` could load both builds (class-token duplication)                                                                                                                                                                                      | low / medium        | `Symbol.for` identities and brands, `useExisting` aliases, B06/B10 boot errors, the dual-load CI test                                                                                        |
| RK6  | Express phase A reads auth-route bodies before user middleware (for example an early abuse filter); the drain cap (8 × limit) is unmeasured                                                                                                                                                                | low / low           | bounded by `bodyLimit` and `drainCap`, then the socket is destroyed; documented                                                                                                              |
| RK7  | Hook discovery misses lazily loaded modules                                                                                                                                                                                                                                                                | low / low           | documented; route plans are compiled on first use with the same checks; a `forFeature`-style registration can be added later without breaking changes                                        |
| RK8  | The third-party Hono platform (§4.1.4) is unverified at runtime                                                                                                                                                                                                                                            | —                   | it is an illustration; the conformance kit is the acceptance gate                                                                                                                            |
| RK9  | The WS coverage check reads Nest-internal metadata (`'websockets:is_gateway'`, LEAD-V13; `'__guards__'` to recognize a plain `@UseGuards(BetterAuthGuard)`) and a capability probe (`mapException`, LEAD-V12)                                                                                              | low / medium        | a CI test on 11.x and 12.x; an inconclusive probe fails closed; `gatewayCoverage: 'warn' \| 'off'` escape hatch                                                                              |
| RK10 | A program mixing `.cts` and `.mts` files sees two declaration copies, so a `Register` augmentation in one format does not affect the other                                                                                                                                                                 | low / low           | documented: augment from one format                                                                                                                                                          |
| RK11 | Organization checks cost 3 DB reads per request                                                                                                                                                                                                                                                            | high / low          | per-request decision memo; cookie cache recommended; Q9 optimization later                                                                                                                   |
| RK12 | Global Express middleware that reads the raw stream without an `isFinished` check hangs on auth routes                                                                                                                                                                                                     | low / medium        | documented; conformance case `H-middleware-order`                                                                                                                                            |
| RK13 | better-auth trusts `x-nsba-client-ip`. Any other code path that calls `auth.handler` directly, outside this library, must strip it                                                                                                                                                                         | low / medium        | documented next to the plugin option; `clientIpHeader: false` disables it                                                                                                                    |
| RK14 | The automatic cookie bridge also fires when a controller deliberately manages cookies itself (`returnHeaders`/`asResponse`)                                                                                                                                                                                | low / low           | `BetterAuthService.runOutsideScope(fn)`; the sink de-duplicates identical strings                                                                                                            |
| RK15 | Nest changes WS enhancer behavior again, as 11 → 12 did without announcement                                                                                                                                                                                                                               | medium / medium     | the WS matrix job asserts per-major behavior explicitly                                                                                                                                      |
| RK16 | A disallowed `Host` under a dynamic `baseURL` makes `auth.handler` throw: a 500 plus a log line per request (log amplification)                                                                                                                                                                            | medium / low        | B20 warns when `allowedHosts` is used without `fallback` (better-auth's own remedy)                                                                                                          |
| RK17 | Nest 12 Express serves no JSON 404 outside a global prefix that has no leading slash (R:nest-platform §7.4); users may blame the auth mount                                                                                                                                                                | low / low           | unrelated to our mount (registered before the 404 handler); noted in the docs                                                                                                                |

---

## 18. Changelog

- **v1.0** (2026-09-11), lead architect. First merged design, built from drafts A ("better-auth-native"), B ("ports and adapters") and C ("DX and types first").
  - **Adopted from A:**
    - Fastify encapsulated `parseAs: 'buffer'` parser with native 413;
    - the `ExtensionDefinition` registration helper;
    - scope interceptor plus explicit internal scopes;
    - the carrier stamp;
    - `defu`-based dispatcher parity;
    - `getActiveMemberRole` membership proof;
    - the separate plugin build;
    - named instances via `AuthOf<N>`;
    - the Hono two-phase sketch.
  - **Adopted from B:**
    - ports-and-adapters layering with the architecture fitness tests;
    - the `PrincipalResult` union ("denials are values");
    - invariant tables mapped to conformance ids;
    - policies resolved by reference through `ModuleRef`;
    - deferred-413 Express drain;
    - exclusive binding;
    - the `withUpgradeRequest`-style mixin;
    - `WsConnectionAuth`;
    - the experiment log E1–E11.
  - **Adopted from C:**
    - the type layer (`DefaultInstanceCheck`, the required `customSession` mapper, `BetterAuthFactoryResult`, `EndpointPath`, typed hook contexts, permission types becoming `never` without the plugin);
    - aggregated boot diagnostics with "did you mean";
    - no hook class marker, and `'model.op'` DB hook targets;
    - `defaultAccess`;
    - the plan compilation rules and `readsSession`;
    - a two-level `code`/`reason` error payload;
    - authoritative reads as a plan attribute;
    - unbinding in `onApplicationShutdown`;
    - the Nest-major capability probe for gateway coverage.
  - **Lead changes [L]:**
    - GraphQL denials as an `IntrinsicException` subclass (LEAD-EXP-1 showed B's approach loses the 429 code under Apollo and A/C's approach logs every denial);
    - param decorators read the interceptor scope first, because WS param factories cannot see the per-message key and the socket races (LEAD-V7);
    - the platform-scope rationale was corrected, since body-parser preserves ALS (LEAD-V11);
    - the Express/Fastify accessor gained `responseFor` for Apollo on Fastify (LEAD-V8);
    - `orgMember()` corrected to `getActiveMemberRole` semantics (403 `YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION`);
    - LEAD-V1–V15 source verifications.
  - **Resolved contradictions:**
    - plugin mandatory (A, C) vs optional (B) → mandatory;
    - module name `AuthModule` (C) vs `BetterAuthModule` (A, B) → `BetterAuthModule`;
    - platform auto-detection (C) vs explicit (A, B) → explicit;
    - hooks including internal calls (A, C) vs excluding them (B) → including;
    - WS default revalidation per message (A, C) vs 300 s (B) → per message;
    - policy registry by kind (A) vs by reference (B, C) → by reference;
    - multi-app hook routing (A) vs exclusive binding (B, C) → exclusive;
    - one instance (B) vs named instances (A, C) → named;
    - method-level `@Public` fail-closed (A) vs opt-out (C) → opt-out, with Q3;
    - GraphQL error type (A/B/C) → `IntrinsicException` subclass.
