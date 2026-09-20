# Research: @thallesp/nestjs-better-auth — issue tracker, PRs, history: what hurts users in practice

Research phase only. No design beyond "implications". Every non-obvious claim has a citation; anything not verified in-session is marked **UNVERIFIED**.

## 0. Sources, path aliases, method

| Alias     | Location                                                                                                                      | Version                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `REF`     | `/private/tmp/claude-502/-Users-thilllon-git-nestjs-slightly-better-auth/d03cce33-4991-442c-88b5-c314fe7f3223/scratchpad/ref` | @thallesp/nestjs-better-auth v2.8.0, commit `99d4a94`                               |
| `BA`      | `.../scratchpad/better-auth`                                                                                                  | better-auth monorepo, `packages/better-auth/package.json` = `1.7.4`                 |
| `BC`      | `.../scratchpad/tmp-ref-issues/better-call/package`                                                                           | better-call 1.4.0 (the version better-auth 1.7.x pins, `BA/pnpm-workspace.yaml:69`) |
| `BCv`     | `.../scratchpad/tmp-ref-issues/bc/<ver>/package`                                                                              | better-call 1.0.13 / 1.0.15 / 1.0.19 / 1.1.4 / 1.1.5 / 1.3.2 / 1.3.5 tarballs       |
| `NM`      | `/Users/thilllon/git/nestjs-slightly-better-auth/node_modules`                                                                | @nestjs/* 11.1.17 (read-only)                                                       |
| `N12`     | `.../scratchpad/tmp-ref-issues/n12c`, `n12k`                                                                                  | @nestjs/common, @nestjs/core 12.0.1 tarballs                                        |
| `PF`      | `.../scratchpad/tmp-ref-issues/pf/package`                                                                                    | @nestjs/platform-fastify 11.1.17 tarball                                            |
| `FC`      | `.../scratchpad/tmp-ref-issues/fcors/package`                                                                                 | @fastify/cors 11.3.0 tarball                                                        |
| Raw dumps | `.../scratchpad/tmp-ref-issues/{ij,pj}/N.json`, `{it,pt}/N.txt`, `all_issues_nq.txt`, `all_prs_nq.txt`                        | fetched 2026-09-10 via `gh`                                                         |

`#N` = `https://github.com/ThallesP/nestjs-better-auth/issues/N` (or `/pull/N`). Commit hashes refer to `REF`.

Method: `gh issue list/pr list --limit 400` (90 issues, 73 PRs), then `gh issue view N --json ...` / `gh pr view N --json ...` for **every** issue and PR (bodies + non-bot comments + reviews; bots `pkg-pr-new`, `coderabbitai`, `greptile-apps` filtered). All 90 issues and all 73 PRs were read. Then `git log`/`git show` on REF, reading of REF source, and verification of upstream behavior in BA / better-call / NestJS tarballs.

---

## 1. Quantitative overview

- **Issues:** 90 total — 86 closed, **4 open** (#79, #147, #159, #163). Date range 2025-06-16 → 2026-08-28 (`jq` over `issues.json`).
- **PRs:** 73 total — **53 merged, 20 closed unmerged** (#160, #155, #150, #138, #133, #126, #124, #121, #110, #92, #74, #70, #65, #63, #57, #46, #44, #24, #18, #11).
- **Time to close (86 closed issues):** median **9.9 days**, p75 21.5 days, p90 62.4 days, max 212.9 days (#32 database hooks, 2025-09-08 → 2026-04-09). Fastify crash #53 took 148 days (2025-10-11 → 2026-03-08); Fastify CORS #52 149 days; Express 5 404 #85 49 days; forRoot normalization bug #86 88 days.
- **Releases:** 27 GitHub releases v1.0.0 (2025-06-15) → v2.8.0 (2026-09-03) (`gh release list`). Eight releases in four weeks (v2.2.1 2026-01-10 → v2.4.0 2026-02-08), five of them on 2026-02-08 alone.
- **No CHANGELOG and no `.changeset/`** in REF (`ls REF` shows no CHANGELOG*, no .changeset). Release notes are GitHub auto-generated PR lists.
- **Maintainer model:** single owner, "periodic bursts of work rather than continuous updates" (owner, #117). Community escalation "this is the **third time** we have encountered a situation where a fix exists but remains unmerged" (#117) and a fork was threatened.
- **Upstream positioning:** better-auth's official NestJS page labels the integration "**community maintained**" and routes issues to this repo (`BA/docs/content/docs/integrations/nestjs.mdx:13`); the same page still says "beta support for Fastify" (`nestjs.mdx:27`) though REF removed that disclaimer in #125.

### Issue counts by category (multi-label; full table in Appendix A)

| Category                                                 |  # issues | Issue numbers                                                                   |
| -------------------------------------------------------- | --------: | ------------------------------------------------------------------------------- |
| Routing / 404 / basePath / mount                         |        12 | #13 #20 #25 #48 #58 #60 #68 #85 #89 #91 #102 #129                               |
| Body parsing & raw body                                  | 7 (+#147) | #16 #53 #60 #88 #96 #101 #111                                                   |
| ESM/CJS / module resolution / optional peers             |         8 | #35 #82 #97 #100 #108 #132 #141 #147                                            |
| Type inference & custom session fields                   |         9 | #6 #8 #30 #34 #47 #55 #62 #112 #163                                             |
| Fastify                                                  |         6 | #4 #52 #53 #107 #128 #132                                                       |
| better-auth version compatibility                        |         5 | #20 #72 #85 #89 #115                                                            |
| Hooks (API + DB)                                         |         5 | #23 #32 #42 #103 #118                                                           |
| Module config / DI (forRoot/forRootAsync/extras)         |         5 | #3 #56 #59 #86 #88                                                              |
| CORS                                                     |         4 | #52 #69 #95 #128                                                                |
| Session hydration / guard & decorator semantics          |         4 | #12 #39 #45 #159                                                                |
| Error format                                             | 3 (+#164) | #28 #148 #159                                                                   |
| NestJS version support                                   |         3 | #66 #73 #165                                                                    |
| GraphQL                                                  |         3 | #59 #97 #100                                                                    |
| Org / roles / permissions                                |         3 | #17 #157 #163                                                                   |
| Testing / mocking                                        |         3 | #16 #86 #100                                                                    |
| Multiple / dynamic auth instances                        |         2 | #51 #79                                                                         |
| Global prefix                                            |         1 | #83                                                                             |
| Microservices / distributed                              |         1 | #67                                                                             |
| Performance (session lookup per request)                 |         1 | #159 (+ PR #57 discussion)                                                      |
| WebSockets                                               |         0 | (PRs #33 #54 #77 only)                                                          |
| GraphQL subscriptions / Mercurius / URI versioning / RPC |         0 | none reported                                                                   |
| Packaging / release / process / governance               |         9 | #1 #23 #76 #117 #130 #139 #146 #151 #153                                        |
| Docs / questions / user error / upstream-usage           |        19 | #1 #5 #14 #15 #21 #25 #31 #41 #49 #50 #56 #81 #90 #114 #129 #131 #136 #156 #164 |

Takeaway: the three biggest real-defect clusters are (1) **how/where the better-auth handler is mounted** (404s), (2) **body parsing**, (3) **packaging/module format & optional peers**. Together with Fastify/CORS they account for most "production is broken" reports. ~20% of the tracker is support questions about better-auth itself.

---

## 2. Reference architecture snapshot (v2.8.0) — anchors for root causes

| Concern                 | Where                                                                                                | What it does                                                                                                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| basePath                | `REF/src/auth-module.ts:109-111`                                                                     | `normalizePath(auth.options.basePath ?? "/api/auth")`                                                                                                                                                                                             |
| Global-prefix exclusion | `auth-module.ts:113-120`, deep imports `:49-50`                                                      | mutates `ApplicationConfig.setGlobalPrefixOptions({exclude})` via **internal** `@nestjs/core/middleware/utils.js#mapToExcludeRoute` and `@nestjs/common/utils/shared.utils.js#normalizePath`                                                      |
| CORS                    | `auth-module.ts:184-205`                                                                             | Express: `httpAdapter.enableCors({ origin: trustedOrigins, methods: ["GET","POST","PUT","DELETE"], credentials: true })` — **app-wide**; function `trustedOrigins` → throws at boot                                                               |
| Body parsing            | `auth-module.ts:219-232`, `REF/src/middlewares.ts:136-191`, `REF/src/fastify-body-parser.ts:213-267` | Express: re-adds `express.json/urlencoded` via `consumer.apply(...).forRoutes("*path")`, skipping basePath; Fastify: `removeContentTypeParser(["application/json","application/x-www-form-urlencoded"])` then registers the library's own parsers |
| Handler mount           | `auth-module.ts:234-275`                                                                             | `httpAdapter.use(globalFn)`; `matchesBasePath(req)` on `originalUrl ?? url` (`middlewares.ts:114-130`); `toNodeHandler(auth)` on raw req/res; **no try/catch**                                                                                    |
| API hooks               | `auth-module.ts:123-150, 279-304`                                                                    | discovers `@Hook()` providers; **mutates `auth.options.hooks.before/after`** after construction; throws if `hooks` not pre-set                                                                                                                    |
| DB hooks                | `auth-module.ts:152-179, 306-336`                                                                    | mutates `auth.options.databaseHooks[model][op][before/after]`; throws if `databaseHooks` not pre-set                                                                                                                                              |
| Module def              | `REF/src/auth-module-definition.ts:43-79`                                                            | `ConfigurableModuleBuilder` with extras `isGlobal`, `disableGlobalAuthGuard`, `disableControllers`; DI token `Symbol("AUTH_MODULE_OPTIONS")` (`:58`)                                                                                              |
| Global guard            | `auth-module.ts:338-404`                                                                             | pushes `{ provide: APP_GUARD, useClass: AuthGuard }` unless `disableGlobalAuthGuard`                                                                                                                                                              |
| "disableControllers"    | `auth-module.ts:344-349, 407-411`                                                                    | swaps to `AuthModuleWithoutControllers` whose `configure()` is a no-op (there are no controllers; this disables the whole HTTP mount, CORS and parser re-adding)                                                                                  |
| Guard                   | `REF/src/auth-guard.ts:140-248`                                                                      | **always** calls `auth.api.getSession()` first (`:142-146`), sets `req.session`/`req.user` (`:148-149`), then reads `PUBLIC`/`OPTIONAL`/roles/permissions metadata                                                                                |
| Context extraction      | `REF/src/utils.ts:20-31`                                                                             | graphql → `GqlExecutionContext...getContext().req`; ws → `switchToWs().getClient()`; else → `switchToHttp().getRequest()` (rpc falls here)                                                                                                        |
| Session decorator       | `REF/src/decorators.ts:172-178`                                                                      | returns `request.session` (only populated by the guard)                                                                                                                                                                                           |
| Auth type               | `auth-module.ts:73-74`                                                                               | `export type Auth = any;`                                                                                                                                                                                                                         |
| Packaging               | `REF/package.json:11-12, 21, 35-40, 79-104`; `REF/build.config.ts:6`                                 | ESM-only (`emitCJS:false`, exports `import`/`default` → `.mjs`), `engines.node ">=22.22.1"`, optional peers `@nestjs/graphql`, `@nestjs/websockets`, `express`, `graphql`, `qs`; `typescript` is a peer                                           |
| Tests                   | `REF/vitest.config.ts:45-73`, `REF/.github/workflows/test.yaml`                                      | tests import `../../src/*` transpiled to a `.vitest-cjs` tree; **never the built `dist`**; CI matrix = adapter only (express/fastify)                                                                                                             |

### 2.1 The handler-mount strategy was rewritten 7 times

| #   | Commit / PR      | First tag | Strategy                                                                       | Why it changed                                                                                                                            |
| --- | ---------------- | --------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `65ae3ef`        | v1.0.0    | `getInstance().use(\`${basePath}/*path\`)`+`req.url = req.originalUrl`         | initial                                                                                                                                   |
| 2   | `7f46678` (#22)  | v1.0.3    | same, `req.url` override removed                                               | better-call 1.0.15 started computing `baseUrl + url` → doubled path `/api/auth/api/auth/*` → 404 (#20)                                    |
| 3   | `12cc459` (#93)  | v2.2.1    | `getInstance().use(basePath)` (no wildcard)                                    | Express 5 `/*path` mount put the full path in `req.baseUrl` and `/` in `req.url` → trailing slash → better-auth 1.4.6 404 (#85, #89, #91) |
| 4   | `f0ce2d6` (#80)  | v2.2.3    | `consumer.apply(handler).forRoutes(basePath)`                                  | so Nest global middleware (pino) runs + errors handled                                                                                    |
| 5   | `0bdc7e4`        | v2.2.5    | back to `getInstance().use(basePath)` + global-prefix test                     | #4 made auth live at `/api/api/auth` under `setGlobalPrefix('api')` (owner, PR #80 comment)                                               |
| 6   | `06e9d4c` (#104) | v2.3.1    | `consumer...forRoutes(basePath)` + `ApplicationConfig` global-prefix exclusion | redo of #80 compatible with prefixes                                                                                                      |
| 7   | `d48c027` (#120) | v2.5.0    | `httpAdapter.use(globalFn)` + manual `matchesBasePath`                         | on Fastify `forRoutes(basePath)` was exact-match → sub-paths never reached (#107)                                                         |

Evidence: `git show <c>:src/auth-module.ts | grep` per commit (session output); `git tag --contains` per commit.

---

## 3. Pain points by category

For each: count · representative issues (one-line quotes) · root cause · fix (clean vs hack) · still open.

### 3.1 Routing, mounting and 404s (12 issues) — the #1 pain

**Representative**

- #20 (19 comments): "all requests to endpoints under the `/api/auth/*` path result in a 404"; Eazash: "related to https://github.com/Bekacru/better-call/pull/32. Pinning `better-call` to `1.0.13` ... resolves the `404`". Users still reporting on v2.2.0 in Dec 2025.
- #85 (14 comments): "With Express 5's `/*path` wildcard ... `req.url` = `/` ... `req.baseUrl` = `/api/auth/sign-in/social` ... The **trailing slash** causes Better Auth to not recognize the route". A user: "It's weird that we didn't have any errors other than that a 404. It was super hard to debug. ... I'm moving to Hono." Another: "i took 14H to try solve it".
- #89: "when `better-auth` **1.4.6** or **1.4.7** is installed ... empty response body with 404 status. No errors in console." Workaround in thread: pin better-auth 1.4.5.
- #91: Express 4 `/*path` not valid; #48: `path-to-regexp` "Missing parameter name" on Express 4.
- #102: "The Better Auth module lib is using the legacy `*` (all) paths" → Nest 11 `LegacyRouteConverter` warning (also visible in #83 logs).
- #13/#58/#60: basePath hard-coded `/api/auth` in `SkipBodyParsingMiddleware` (`if (req.baseUrl.startsWith("/api/auth"))`, quoted in #13).
- User-error 404s (#25 wrong URL `/sign-up` vs `/sign-up/email`; #129 `/webhook` vs `/webhooks`; #68 no repro) — the silent, bodiless 404 makes misconfiguration indistinguishable from bugs.

**Root cause (verified)**

1. REF mounted with framework-specific path patterns (`/*path`, `*`, `forRoutes(basePath)`) whose semantics differ across Express 4, Express 5 (`app.use` vs route), Nest's path-to-regexp v8, and Fastify/middie (§2.1).
2. REF coupled to better-call's URL reconstruction, which changed repeatedly:
   - better-call 1.0.13: `new Request(base + request.url)` and raw-stream body only (`BCv/1.0.13/package/dist/node.js:69-73`) → REF had to override `req.url`.
   - 1.0.15–1.1.5: `fullPath = baseUrl ? baseUrl + request.url : request.url` (`BCv/1.0.15/.../node.js:69-70`; `BCv/1.1.5/.../node.js:53-54`) → broke REF's override (#20) and the Express 5 `/*path` mount (#85).
   - 1.3.2+: `constructRelativeUrl()` handles the mounted-middleware case (`BCv/1.3.2/.../adapters/node/request.mjs:52-58`; `BC/dist/adapters/node/request.mjs:95-101`).
   - better-auth 1.4.6 separately tightened path normalization (DanielvG-IT in PR #93 identifies better-auth commit "fix: pathname should be normalized when basePath is set to root", Dec 7 2025 — **UNVERIFIED** in-session, BA is a shallow clone).
3. Version mapping (verified with `npm view better-auth@X dependencies.better-call`): 1.3.7→^1.0.13, 1.4.5→1.1.4, 1.4.6→1.1.5, 1.5.0/1.5.5→1.3.2, 1.6.0→1.3.5, 1.7.0/1.7.4→1.4.0.

**Fix quality:** reactive and repeated (7 strategies). Current v2.8.0 approach — global `httpAdapter.use` + manual prefix match on `originalUrl` (`auth-module.ts:267-275`, `middlewares.ts:114-130`) — is adapter-neutral and avoids wildcards (clean-ish), but depends on Nest `use()` semantics per adapter and on internal Nest APIs for prefix exclusion (see 3.5). No conformance test matrix exists across Express/Fastify × basePath × globalPrefix × better-auth versions (CI matrix is adapter only, `REF/.github/workflows/test.yaml`).

**Still open:** nothing tracked; risk remains that the next better-call/Nest change breaks mounting silently (no version matrix, see 3.8/3.15).

### 3.2 Body parsing & raw body (7 issues + #147)

**Representative**

- #16: integration test "Exceeded timeout of 5000 ms" → owner: "remember that disabling it on `main.ts` does not affect tests".
- #96: "keeping the default body parser enabled allows both better-auth and my Stripe webhooks ... to function correctly" → owner: "better-auth needed the full body parser to consume ... would hang the request indefinitely. Perhaps that has changed" (never re-tested; still recommended, owner 2026-05-04).
- #101: "`req.rawBody` unexpectedly becomes `undefined`" after disabling body-parser; #88: Stripe webhook fails with module option, works with `NestFactory` `bodyParser:false`.
- #111: "no way to pass custom options (especially JSON size limit)".
- #112 (ropdias): "`rawBody: true` is silently ignored when this wrapper is used, because the wrapper replaces NestJS's body parsers."
- #147 (open): bundling with Vite → `Cannot find module 'express'` from `createRequire(import.meta.url)("express")` (`REF/src/middlewares.ts:9, 59-61`).

**Root cause (verified)**

- NestJS registers its global body parser **before** any module middleware: `NestApplication.init()` runs `registerParserMiddleware()` then `registerModules()` (`NM/@nestjs/core/nest-application.js:99-101`). A module's `configure()` cannot insert anything ahead of it; hence REF demands `bodyParser:false` and re-implements parsers (README `REF/README.md:35-56`).
- Old better-call (≤1.0.13) read only the raw stream (`BCv/1.0.13/.../node.js:73`) → consumed stream = hang (#16). From 1.0.15 it falls back to a pre-parsed `req.body` (`BCv/1.0.15/.../node.js:73`), from 1.3.5 it prefers the raw stream when still readable and re-serializes `req.body` content-type-aware (`BC/dist/adapters/node/request.mjs:38-46, 102-117`). So in better-auth ≥1.6, JSON/urlencoded auth endpoints would work even with Nest's parser on (consistent with #96) — **but** re-serialized JSON is not byte-identical: better-auth's Stripe plugin verifies signatures over `await ctx.request.text()` (`BA/packages/stripe/src/routes.ts:2027-2041`). Skipping parsing on auth routes is still required for correctness of signed-webhook plugin endpoints. (The byte-mismatch consequence is **UNVERIFIED** at runtime but follows from `JSON.stringify` in `serializeParsedBody`, `BC/.../request.mjs:41-46`.)
- Nest's own `rawBody: true` is wired into its parser registration (`NM/.../nest-application.js:110-114`), so disabling the parser disables rawBody (#101).

**Fix quality:** additive options (`enableRawBodyParser` #106 → replaced one month later by `bodyParser: { json, urlencoded, rawBody }` #121/#122/#123; owner: "ugh I hate this code but it works", PR #123). Deprecated flags remain (`auth-module.ts:207-217`). On Fastify, REF **replaces the app's JSON/urlencoded content-type parsers globally** and reimplements them (`fastify-body-parser.ts:80-157, 222-266`), pulling an optional `qs` peer (#123 commit `d03cbb5`). Hack-level: it duplicates what `@nestjs/platform-fastify` already does (`PF/adapters/fastify-adapter.js:341-352, 435-451`). #147 fix PR #155 ("use body-parser directly") closed by owner without comment (event log: `closed ThallesP 2026-07-04`).

**Still open:** #147; the `bodyParser:false` requirement itself (#96 discussion). **Hypothesis (UNVERIFIED):** on Fastify, better-auth routes run in middie's `onRequest` hook before content-type parsing (`PF/adapters/middie/fastify-middie.js:180-186`, `fastify-adapter.js:420-428`), so disabling Nest's parser on Fastify may be unnecessary altogether.

### 3.3 Fastify (6 issues)

**Representative**

- #4: owner closes the Fastify request: "seems like that support for Fastify already works (crazy huh)". Immediately followed by `TypeError: Cannot read properties of undefined (reading 'startsWith') at SkipBodyParsingMiddleware.use`.
- #53 (15 comments, 148 days open): "The middleware attempts to access req.baseUrl, a property specific to Express"; "I have gone back to using Express"; users applied patch files (`@thallesp%2Fnestjs-better-auth@2.0.1.patch`, #107 "forces you to keep using v2.2.2").
- #107: "returns 200 on Express but 404 on Fastify"; "`forRoutes(this.basePath)` uses exact matching on Fastify".
- #52: "`FastifyError: The decorator 'corsPreflightEnabled' has already been added!`" and "Without manual @fastify/cors, login routes return 404".
- #128: Fastify + `disableTrustedOriginsCors:true` + app-level `@fastify/cors` → "No 'Access-Control-Allow-Origin' header" on `/api/auth/get-session`.
- #132: "The lib request `express` to be installed even when I'm using Fastify".

**Root cause (verified)**

- Middleware written against Express request shape (`req.baseUrl`) and Express body-parser (#53, #132).
- `forRoutes(path)` semantics differ per adapter (#107).
- `@fastify/cors` decorates the request (`FC/index.js:46`), so a second registration throws (#52); Nest's `FastifyAdapter.enableCors` registers `@fastify/cors` (`PF/adapters/fastify-adapter.js:338-340`).
- The better-auth handler runs via middie on the **raw Node response** (REF `getNodeResponse` = `res.raw ?? res`, `middlewares.ts:122-124`; better-call writes with `res.setHeader/writeHead`, `BC/.../request.mjs:125-134`). `@fastify/cors` sets headers with `reply.header(...)` (`FC/index.js:219-237`), which Fastify only flushes on `reply.send`. So app-level Fastify CORS never reaches better-auth responses (REF README concedes: "app-level `@fastify/cors` does not fully cover them", `REF/README.md:86`). By the same mechanism other reply-level plugins/hooks (helmet, compression, onSend) are bypassed on auth routes — **UNVERIFIED** at runtime.

**Fix quality:** community Fastify PRs (#18, #63, #65) were closed; owner rewrote in v2.5.0 (#120 adapter test matrix — clean; #127 CORS dedupe) and v2.6.1 (#143 hand-written CORS for Fastify auth routes, `REF/src/fastify-trusted-origins-cors.ts`). ropdias (PR #143) showed the v2.6.0 `hasRequestDecorator("corsPreflightEnabled")` guard "was unreachable in standard Nest boot order". The shipped example still uses `disableTrustedOriginsCors: true` + adapter-level `@fastify/cors` (`REF/examples/nestjs-better-auth-example/src/app.module.ts`, `src/main.ts`) — the exact configuration reported broken in #128 (runtime **UNVERIFIED**). Missing CORS knobs (`Access-Control-Max-Age`, `Expose-Headers`) promised as follow-up (owner, PR #143) — not done in v2.8.0.

**Still open:** body parser replacement on Fastify; plugins that rely on `reply` lifecycle; better-auth docs still say "beta".

### 3.4 CORS (4 issues)

**Representative:** #52/#128 (Fastify, above). #95: "Shouldn't better auth use the global CORS? If I disable one of them, either better auth login endpoint doesnt works or my app endpoint doesnt works." #69: trustedOrigins `['http://localhost:3000','https://<MY_DOMAIN>','https://*.<MY_DOMAIN>']`, request from `https://www.<MY_DOMAIN>` → "No 'Access-Control-Allow-Origin' header"; user concluded it was a cookie problem.

**Root cause (verified)**

- REF owns **app-wide** CORS on Express by default (`auth-module.ts:190-196`) with `methods: ["GET","POST","PUT","DELETE"]` — PATCH/OPTIONS for the user's own routes are not listed (latent; **UNVERIFIED** impact).
- REF passes `trustedOrigins` verbatim to the `cors` package, which matches string origins **exactly** (`NM/.pnpm/cors@2.8.6/.../lib/index.js:19-34`), whereas better-auth supports wildcard trusted origins (`BA/packages/better-auth/src/utils/url.ts:347-381`). Wildcards silently produce no CORS header on Express — a plausible real root cause of #69 (**UNVERIFIED**). REF's Fastify path does support wildcards (`fastify-trusted-origins-cors.ts:52-59`) → Express/Fastify behave differently for the same config.
- better-auth's effective trust list = baseURL origin + `options.trustedOrigins` (array **or function(request)**) + env `BETTER_AUTH_TRUSTED_ORIGINS` + plugin-contributed origins (`BA/.../context/helpers.ts:40-85, 108-160`). REF reads only the user array and throws on functions (`auth-module.ts:198-205`).
- Upstream model: better-auth leaves CORS to the host framework (`BA/docs/.../express.mdx` "Cors Configuration"; `fastify.mdx` "Configuring CORS"); `trustedOrigins` is a CSRF/origin-check concept.

**Fix:** Fastify-only fixes (#127, #143). Express path unchanged since v1.0 aside from the guard against functions. **Open:** wildcard/function/env/plugin origins; app-wide side effects.

### 3.5 Global prefix / versioning / excluded routes (1 issue + PR churn)

- #83: 404 under `app.setGlobalPrefix('api')` — resolved by the user: `baseURL` must be `http://localhost:3000`, not `.../api`. Logs showed `LegacyRouteConverter` warnings.
- PR #80 → revert `0bdc7e4`: owner "if a user has this prefix ... The routes on better-auth will be `/api/api/auth`, which isn't very intuitive as the better-auth client expects the routes to be at /api/auth/*". PR author disagreed: "if I'm mounting Better Auth in a NestJS environment, I'd expect the plugin that is mounting it to respect my NestJS settings."
- Current: basePath is **excluded** from the global prefix by mutating `ApplicationConfig` in the module constructor (`auth-module.ts:113-120`) with internal Nest helpers (`:49-50`). Test: `REF/tests/e2e/rest-auth.e2e.test.ts:96-128` ("better-auth path should still be /api/auth and not /v1/api/auth").
- NestJS 12 marks internal APIs as internal: `@nestjs/core/internal.js` header "Internal module - not part of the public API" (`N12/n12k/package/internal.js:1-7`); the deep paths still resolve via `"./*.js"` exports (`N12` package.json exports) and `mapToExcludeRoute` still exists (`N12/n12k/package/middleware/utils.js:8`). PR #166 author verified "those APIs are unchanged in v12".
- **URI versioning (`enableVersioning`)**: zero issues/PRs (grep over all dumps). Excluded routes beyond auth: none.
- Semantics decision (prefix applies to auth or not) is a policy choice the design must make explicitly.

### 3.6 ESM / CJS / module resolution / optional peers (8 issues)

**Representative**

- #35: better-auth in a CJS Nest app on Node 20.16: "tries to require() an ESM-only dependency (@noble/ciphers/chacha.js)".
- #82: "I've installed @nestjs/graphql, graphql, @nestjs/websockets even I don't want to use it, because otherwise there were 'MODULE_NOT_FOUND' errors".
- #97: `Error: Cannot find module '@nestjs/graphql'`; #100: `Cannot find package 'graphql' imported from ... dist/index.mjs` — "Huge disappointment which broke our pipelines recently, please resolve and add automated tests around such scenarios."
- #108: "`require() of ES Module better-auth/dist/integrations/node.mjs from nestjs-better-auth/dist/index.cjs not supported`".
- #141 (after v2.5.0 went ESM-only): "`require() of ES Module .../@thallesp/nestjs-better-auth/dist/index.mjs from /var/task/apps/server/src/app.controller.js not supported`" on Node 20.11.1; owner "update your nodejs version to v22"; user "I'm using Node.js version 22.x on Vercel, and it doesn't work."
- #132 (express required on Fastify), #147 (bundlers vs `createRequire`).

**Root cause (verified)**

- better-auth 1.7.4 is ESM-only: `"type":"module"`, every one of 54 export entries has only `default` → `.mjs`, zero `require` conditions (`node -e` over `BA/packages/better-auth/package.json`). Its docs: "CommonJS (cjs) isn't supported" (`BA/docs/content/docs/integrations/express.mdx:13`).
- **NestJS 12 is also ESM-only**: `@nestjs/common@12.0.1` and `@nestjs/core@12.0.1` have `"type":"module"`, no `.cjs` files, exports without `require` conditions; `@nestjs/core` engines `node >= 20` (verified on tarballs `N12`). Same for `@nestjs/platform-express@12.0.1`, `@nestjs/platform-fastify@12.0.1`, `@nestjs/graphql@14` (`npm view ... type`).
- A CJS consumer (Nest's default TS output) can only load ESM via `require(esm)`, unflagged in **Node v20.19.0, v22.12.0, v23.0.0**; it throws `ERR_REQUIRE_ASYNC_MODULE` if the graph contains top-level await (Node docs, https://nodejs.org/api/modules.html#loading-ecmascript-modules-using-require, fetched 2026-09-10).
- Optional peers were statically imported (GraphQL in `utils.ts`, `GraphQLError`, `WsException`) until #77/#99/#105/#113 turned them into lazy `await import()` (`REF/src/utils.ts:4-13`, `auth-guard.ts:62-78`). `express`/`qs` are still loaded by `createRequire(import.meta.url)` (`middlewares.ts:9, 59-61`; `fastify-body-parser.ts:24, 159-183`), which bundlers cannot resolve (#147).

**Fix quality:** v2.5.0 "fixed" #108 by **dropping CJS** (`cd951b9`: "disable unbuild CJS emit and remove `require`/`main` package exports") — a same-day flip-flop after `f52d702` had added a CJS entry — and requiring Node `>=22.22.1 <23` (`54b2db3`), which broke Node 24 users (#130, relaxed in v2.5.1). This shifted the burden to consumers (#141). Breaking changes (ESM-only, Node engine, better-auth `>=1.5.0` from #116) shipped in a **minor** (v2.5.0 release notes). PR #110 (ESM-only by contributor) closed "in favor of #119".

**Still open:** #147; no packed-artifact smoke tests (tests use a CJS transpile of `src`, `REF/vitest.config.ts:45-73`, never `dist`).

### 3.7 NestJS version support (3 issues)

- #66: Nest 10 → all routes 404; upgrading to 11 fixed it. #73: npm `ERESOLVE ... peer @nestjs/common@"^11.1.6"` (outdated Nest CLI generating v10).
- #165 / PR #166: Nest 12 released; peers widened to `^11.1.6 || ^12.0.0` and `@nestjs/graphql ^13.1.0 || ^14.0.0`; "No source changes were needed"; 91/91 tests on Nest 12.0.1 (PR #166). Verified peers in `REF/package.json:79-81`.
- Facts for the design: Nest 11.1.17 and 12.0.1 platform-express both depend on `express 5.2.1` (`npm view @nestjs/platform-express@11.1.17 / @12.0.1 dependencies`); Nest 12 platform-fastify depends on `fastify 5.12.1`, `@fastify/cors 11.3.0`, `@fastify/formbody 9.0.0`. Express 4 problems (#48, #91) therefore only arise with Nest 10 or hand-pinned Express 4.
- Nest 12 ESM-only packaging (3.6) is the major new constraint for a dual-format library.

### 3.8 better-auth version compatibility / upstream breaking changes (5 issues)

- #20 (better-call 1.0.14/15 URL change), #85/#89 (better-auth 1.4.6), #115 (better-auth ≥1.5: "Export named 'createAuthMiddleware' not found in module 'better-auth/dist/plugins/index.mjs'"), #72 (confusion over `>=1.3.8`).
- In 1.7.4, `createAuthMiddleware` is exported from `better-auth/api` (`BA/packages/better-auth/src/api/index.ts:413`), not from `plugins/index.ts`.
- PR #138: better-auth 1.5.6 changed internal `databaseHooks` to `{ source, hooks }` entries — verified in 1.7.4: `dbHooks.push({ source: "user", hooks: options.databaseHooks })` (`BA/.../context/helpers.ts:86-88`; `create-context.ts:385-386`).
- **Why these escaped CI (verified):** better-auth is only a peer; the version actually tested is whatever the lockfile resolved. At `63887b3` (2026-02-22) `bun.lock` resolved **better-auth 1.3.27** while users ran 1.5.x → #115 undetected. At v2.8.0 `bun.lock:625` resolves **better-auth 1.5.4** while the peer range claims `>=1.5.0 <2.0.0` and 1.7.4 is latest → 1.6/1.7 untested.
- Owner's policy on breakage: "install the latest version of better-auth, as we may deprecate older versions" (#20); peer floor raised twice (`2e65238` "deprecate older better-auth versions due to 404s"; #116 → `>=1.5.0`).

### 3.9 Type inference & custom session fields (9 issues)

**Representative:** #6/#8 `@Session()` typed as `ParameterDecorator` → "Expected 3 arguments, but got 0" (fixed #7). #30/#47/#55: plugin/additional fields missing from `UserSession` ("`userSession.user.username` // undefined" — actually a typing issue, runtime data present, PR #135 author). #62: "admin functions missing" from `AuthService` when the instance is created inside `forRootAsync` (no generic). #112: `TS2339: Property demo does not exist on type UserWithRole` (upstream better-auth#6318, per ropdias). #163 (open): `@RequireActiveOrg()` does not narrow `activeOrganizationId: string | undefined`. #20 comment: `TS2742 The inferred type of 'auth' cannot be named without a reference to '.pnpm/zod...'`.

**Root cause:** REF erases the instance type (`export type Auth = any`, `auth-module.ts:73-74`); `AuthService<T>` needs an explicit generic (`REF/src/auth-service.ts:12`); `UserSession` default is a hand-written shape with `role?`/`activeOrganizationId?` (`auth-guard.ts:44-55`). forRootAsync factories make `typeof auth` unavailable → users write "shadow" instances (#112) or `Awaited<ReturnType<typeof createAuth>>` (#62 wiredmatt, #112 ropdias).

**Fix:** `UserSession<typeof auth>` generic (#135, v2.5.3) — adequate but opt-in per use site. **Open:** #163 (guard-established invariants not reflected in types); instance type flow through DI.

### 3.10 GraphQL (3 issues; subscriptions/Mercurius: 0 issues)

- #59: `disableGlobalAuthGuard` ignored in `forRootAsync` factory (really a module-config issue, 3.19). #97/#100: `@nestjs/graphql`/`graphql` required for non-GraphQL apps (3.6).
- Support added by PR #37 (`GqlExecutionContext`), then made optional (#99, #105 — `#105` replaced `GraphQLError` with Nest HTTP exceptions, `auth-guard.ts:94-103`).
- Request extraction reads `getContext().req` (`REF/src/utils.ts:22-24`). `@nestjs/apollo` assigns `req` into the context by default (`NM/@nestjs/apollo/dist/drivers/apollo-base.driver.js:197-214`); REF tests configure `context: ({ req, res }) => ({ req, res })` (`REF/tests/shared/test-utils.ts:60-63`).
- **Subscriptions:** for graphql-ws the context argument is the WS connection context, not an HTTP request; the guard does `request.headers || request?.handshake?.headers || []` (`auth-guard.ts:143-145`) → no headers → UNAUTHORIZED for any non-anonymous subscription. **Mercurius:** context has no `req` by default → `request` undefined → `TypeError` on `request.headers`. Both are code-reading conclusions, **UNVERIFIED** at runtime; no user has reported them (possibly because nobody tried).

### 3.11 WebSockets (0 issues; PRs #33, #54, #77)

- PR #33: read `handshake.headers` for socket requests. PR #54 (WS support): "when working with NestJS Gateways, the `APP_GUARD` does not apply, and you have to manually add `@UseGuards(AuthGuard)`" — **verified**: `@nestjs/websockets` builds `new GuardsContextCreator(container)` without config (`NM/@nestjs/websockets/socket-module.js:81`), and `getGlobalMetadata()` returns `[]` when `config` is absent (`NM/@nestjs/core/guards/guards-context-creator.js:53-56`); HTTP passes config (`NM/@nestjs/core/router/router-explorer.js:40`).
- PR #77 made `@nestjs/websockets` optional (lazy `WsException`).
- Code-reading implications (**UNVERIFIED** runtime): the guard runs per `@SubscribeMessage`, not on connection (`handleConnection`), so unauthenticated sockets can connect; `getSession` runs per message (DB hit per message without cookie cache).

### 3.12 Microservices / distributed services (1 issue)

- #67: "Can't use guards without registering the full module, which automatically exposes all controller endpoints." → `disableControllers` (#75), later reworked (#78) because it broke with `forRootAsync`.
- `disableControllers` actually disables the whole `configure()` (`auth-module.ts:407-411`): no handler mount, no CORS, **no body-parser re-adding**. A service following the README's `bodyParser:false` with `disableControllers:true` would parse no bodies at all (code-reading, **UNVERIFIED**). The name is misleading: REF has no controllers.
- RPC context: `getRequestFromContext` falls through to `switchToHttp().getRequest()` for `rpc` (`utils.ts:30`) — the payload, with no headers → always `Error("UNAUTHORIZED")` (`auth-guard.ts:114-117`). No issues filed; Nest microservices unsupported in practice (code-reading).

### 3.13 Hooks (5 issues)

**Representative:** #42 "Hook methods are never executed" — reporter's root cause: "This shallow copy operation prevents hooks from working properly" (`this.options.auth.options.hooks = { ...hooks }`). #32 database hooks (7 months). #103 "hooks are called two times ... If the hooks are not idempotent it could cause bugs"; #118 (same, withdrawn, AI-generated). #23 `AuthHookContext` not exported (unreleased build).

**Root cause (verified):** REF extends better-auth by **mutating the options object after `betterAuth()` has run** (`auth-module.ts:291-302, 320-334`). This works only because of reference identity:

- `auth.options` is the original user object (`BA/.../auth/base.ts:114`), while the context options are a new object (`create-context.ts:189-199` spread; `:107, :123` `defu`), which keeps nested `hooks`/`databaseHooks` objects by reference.
- API hooks are read per request from `authContext.options.hooks?.before/after` (`BA/.../api/dispatch.ts:269-288`) → mutation of the _same_ `hooks` object is visible; assigning a new object (the #42 shallow copy) or not pre-creating it is invisible. Hence the hard requirement "set `hooks: {}`" (`REF/README.md:432-433`; enforced with a throw, `auth-module.ts:134-137`).
- DB hooks are captured at context creation as `{ source: "user", hooks: options.databaseHooks }` (`helpers.ts:86-88`) → same "`databaseHooks: {}` required" rule (`REF/README.md:490-491`; `auth-module.ts:164-167`). PR #138's alternative rebuilt better-auth's internal adapter via `createInternalAdapter` — deeper coupling; owner reimplemented as #142.
- #103 root cause never established (closed "in favor of #118", which was withdrawn). Plausible contributor (**UNVERIFIED**): better-auth runs `hooks.before/after` for server-side `auth.api.*` calls too ("The HTTP router and `auth.api.*` reach it through toAuthEndpoints", `BA/.../api/dispatch.ts:310-322`), and REF's guard calls `auth.api.getSession()` on every guarded request (`auth-guard.ts:142`), so a path-less `@BeforeHook()` fires for `/get-session` on ordinary app requests.

**Fix quality:** workaround-by-documentation (`hooks: {}`), fragile coupling to better-auth internals. **Still open:** #103's real cause; hooks run on internal API calls.

### 3.14 Organization / roles / permissions (3 issues + 5 PRs)

- #17 role decorator → PR #36 `@Roles` (owner initially refused unless it used "the official better-auth plugin system"). PR #64: roles are comma-separated strings in the admin plugin ("adding through admin.setRole separates them by comma"), fixed in `matchesRequiredRole` (`auth-guard.ts:257-272`).
- PR #94 initially OR-merged `user.role` and org member role; reviewer farreltobias: "If a user has the admin role in the organization, but I use the decorator for the admin role in the admin plugin, wouldn't that change create a bug where that user would bypass the protection?" → split into `@Roles` and `@OrgRoles` (`be98ac7`, "prevent privilege escalation"; README `REF/README.md:185-186`).
- PR #109 `@UserHasPermission` / `@MemberHasPermission`; #157 → PR #158 `@RequireActiveOrg`; #163 (open) type narrowing.
- **Design smells (verified):** plugin availability is detected at request time with `typeof authApi.hasPermission !== "function"` → `console.error` + `false` → 403 (`auth-guard.ts:370-375, 453-458`); all API errors are swallowed into 403 (`:335-343, 413-422, 478-487`); `@OrgRoles` adds another `auth.api` round-trip per request (`:280-300`); all strategies are hard-coded branches inside one guard (`:172-245`) — adding a strategy means editing the guard.

### 3.15 Testing / mocking (3 issues)

- #16 (test app needs `bodyParser:false` too); #86: "this project does not have any unit tests and no contribution section" (contributor blocked); #100: "add automated tests around such scenarios".
- REF now has an e2e suite (12 files, `REF/tests/e2e`) running on Express and Fastify (#120), but: tests import `src` compiled to CJS (`vitest.config.ts:45-73`, tests import `../../src/*`), not the shipped ESM `dist` — so packaging/peer-dep failures (#97, #100, #108, #115, #141, #147) are structurally untestable in CI; no better-auth/Nest/Node version matrix (`test.yaml`).
- No testing utilities are exported for consumers (no `TestingModule` helpers, no session mocking). #164's user asks whether to "decode the session_token and re-inject it into the test Agent". No mocking issues filed; demand is implicit.

### 3.16 Performance: session lookup per request, caching (1 issue + discussion)

- #159 (open): "`AuthGuard.canActivate` calls `getSession()` before checking on `AllowAnonymous` ... `isPublic` is never reached" — DB outage turns every anonymous route (k8s probes) into 500 "Failed to get session". Verified at `auth-guard.ts:142-156`.
- PR #57 (session middleware) rejected by owner: "`getSession` is not a free call and requires a trip to the storage layer which can cause problems" — yet the global guard does exactly that on every request, including public ones.
- better-auth only defaults `cookieCache` on when there is **no** durable store (`BA/.../context/create-context.ts:103-118`) → with a DB, each guard call hits storage.
- Per guarded request REF can issue: `getSession` + `getActiveMemberRole` (OrgRoles) + `userHasPermission` / `hasPermission` — each through the full hook pipeline (3.13), with `fromNodeHeaders` computed twice (`auth-guard.ts:143-145, 168-170`). No per-request memoization.
- **Latent (verified mechanism, not reported):** `getSession` may write (session refresh after `updateAge`) and emit `Set-Cookie` (`BA/.../api/routes/session.ts:325-414`: `updateSession`, `setSessionCookie`, `setCookieCache`). REF's guard discards response headers (no `returnHeaders`), so refreshed/cookie-cache cookies are never sent for normal app routes (consequence on cookie lifetimes **UNVERIFIED** at runtime).
- Owner's stance for v3: "`@Public()` means skip auth completely, and `@AllowAnonymous()` remains as is" (#159). PR #160 (try/catch, 5xx on protected routes) closed by its author 2026-08-25 without merge.

### 3.17 Multiple / dynamic auth instances (2 issues)

- #51: "two independent authentication ... `/api/client/auth` ... `/api/admin/auth`" → owner: "you can probably provide `isGlobal` as `false` ... I never tested it".
- #79 (open): "the better auth instance can change on the fly ... configure OAuth providers from an admin panel, enable/disable plugins on the fly"; owner suggested AsyncLocalStorage; user: "AsyncLocalStorage doesn't help me".
- Code-reading constraints (**UNVERIFIED** runtime): single DI token (`auth-module-definition.ts:58`), `AuthGuard` injects that one token, `isGlobal: true` default, decorators use global string metadata keys (`"PUBLIC"`, `"ROLES"`, … `decorators.ts:22-70`), `toNodeHandler(auth)` captured once (`auth-module.ts:234`) → two instances collide; a guard cannot be bound to a specific instance.

### 3.18 Error format / exception handling (3 issues + #164)

- #28: custom filter not used; owner: "if you provide the `disableExceptionFilter` parameter, it actually enables the filter instead"; resolved by **removing exception filters entirely** in v2.0.0 (PR #27: "It doesn't make much sense to keep it as better-auth already handles its own errors"; PR #38: "better-auth does not throw an `APIError` and `onAPIError` is only for client side").
- #148: guard returned `{ code: "UNAUTHORIZED", message: "Unauthorized" }` instead of Nest's `{ message, statusCode }` → fixed by #149 (`auth-guard.ts:84-93`, v2.7.0). WS → `WsException("UNAUTHORIZED")`, RPC → plain `Error` (`:104-117`).
- #159/#164: infrastructure or schema errors inside `getSession` surface as 500 "Failed to get session" (`APIError`) on every guarded or anonymous route.
- PR #80: an uncaught error in better-call (`X-Forwarded-Proto: https, https` → "Failed to parse URL from https") "crashed the entire NestJS application". better-call still builds the base URL from the raw `x-forwarded-proto` header (`BC/dist/node.mjs:3-9`). The fallback was lost when #80 was reverted; current handler has no try/catch (`auth-module.ts:256-264`). Whether a rejection now crashes the process depends on the adapter's promise handling — **UNVERIFIED**.
- Because auth routes are raw middleware, Nest exception filters, interceptors and `MiddlewareConsumer` middleware (registered later in `registerRouter`, `NM/.../nest-application.js:115-120`) never see them — the reason for the `middleware` option (PR #71, MikroORM `RequestContext`) and #80's pino complaint.

### 3.19 Module configuration & DI (5 issues)

- #3 (forRootAsync, 3 months; community fork `@mguay/nestjs-better-auth` published meanwhile); owner's hesitation: "better-auth's CLI requiring a valid adapter inside the `auth.ts` file". Verified: the CLI discovers `auth.ts` in conventional paths and needs an exported `auth`/default export (`BA/packages/cli/src/utils/get-config.ts:17-44, 294-299, 437, 455`) → DI-built instances are invisible to the CLI; users keep a duplicate/shadow config (#3, #112).
- #59, #88, #159: options silently ignored depending on placement. **Verified mechanism:** `ConfigurableModuleBuilder` strips extras from the options provider in `forRoot` (`omitExtras`, `NM/@nestjs/common/module-utils/configurable-module.builder.js:111-116, 150-162`) and reads extras only from the top-level async options (`extractExtrasFromAsyncOptions`, `:132-148, 163-174`). So `disableGlobalAuthGuard` inside `useFactory`'s return is ignored ("must be placed in the forRootAsync static options object, not in the object returned by useFactory", #159), while `bodyParser`/`disableTrustedOriginsCors`/`middleware` must be in the factory (#59 comment). Upstream issue nestjs/nest#15661 was closed; reporter later: "i was actually mistaken about the intended behavior of `extras`" (PR #27).
- #86: backward-compat normalization of `forRoot(auth, opts)` vs `forRoot({auth})` broke `useFactory` in `forRoot` (fixed v2.5.0; normalization still at `auth-module.ts:376-379`).
- #56: user returned options instead of a `betterAuth()` instance → `Cannot read properties of undefined (reading 'trustedOrigins')` (no validation).
- Token mismatch (verified): exported `AUTH_MODULE_OPTIONS_KEY = Symbol("AUTH_MODULE_OPTIONS")` (`REF/src/symbols.ts:4`) is **not** the DI token `MODULE_OPTIONS_TOKEN = Symbol("AUTH_MODULE_OPTIONS")` (`auth-module-definition.ts:58`), which is not exported from `index.ts` (`REF/src/index.ts:1-5`). #159's workaround had to construct `new AuthGuard(reflector, { auth: authService.instance })`. PR #29 had asked to export symbols because "this lib uses `Symbol` and not `Symbol.for` so there's no way to recreate it".

### 3.20 Session hydration & guard/decorator semantics (4 issues)

- #12: "`@Session` returns undefined" → "You need to have authGuard in order to get a session" (decorator reads `request.session`, `decorators.ts:172-178`, only set by the guard `auth-guard.ts:148`).
- PR #2 discussion: "isn't `@Optional` functionally the same as `@Public`?" — owner agreed; both still exist (`AllowAnonymous`=`PUBLIC`, `OptionalAuth`=`OPTIONAL`, deprecated aliases `Public`/`Optional`, `decorators.ts:22-31, 160-165`). #39: `Optional` collided with `@nestjs/common`'s `@Optional()` → renamed in v2.0.0.
- #45: global guard ignoring `@AllowAnonymous` (closed, not reproduced).
- #159: `@AllowAnonymous` still resolves the session (and fails when storage is down). Owner wants v3 `@Public()` = no auth call at all.
- Global guard became **default-on** in v2.0.0 (`58b9ed7` "enable auth guard by default"; README "All routes are protected unless you explicitly allow access", `REF/README.md:90`).
- Latent (**UNVERIFIED**): REF writes `req.session` and `req.user` (`auth-guard.ts:148-149`) — the same properties used by `express-session` and Passport; coexisting apps would have them overwritten. Not reported.

### 3.21 Packaging, release engineering, governance (9 issues)

- #1 wrong package name in README; #23 fix merged but not released; #146 "2.6.1 not available on npm"; #130 Node engine `<23` upper bound; #139 `typescript` listed as a peer (`^5.9.2` blocked TS 6; now `^5.9.2 || ^6.0.0`, `REF/package.json:87`).
- Release automation: ~30 commits on 2026-01-10 fighting npm OIDC ("stupid npm auth 4", "the old one just works, fuck npm", `git log`), finally solved in PR #161 (bun publish lacks OIDC; `setup-node registry-url` breaks OIDC; repository URL case mismatch).
- #117 (maintenance): "When fixes remain unmerged for weeks, production teams are forced to patch `node_modules` manually". Rykuno: "a proper concise guide rather than a package would be much more helpful ... The problem with downstream packages is you rely on a maintainer to continuously keep up with the upstream changes". Owner: "it would sacrifice the benefits my solution provides, such as Decorators, Modules, WebSocket support".
- Contributor friction: PR #138 closed after owner reimplemented ("couldn't get this to work somehow") → contributor: "What specifically didn't work?". #76 "Is this vibe coded?". #150 was a bounty-bot PR moving `express` to dependencies (flagged by ropdias). Toolchain was Bun; PRs using npm/pnpm lockfiles were rejected (PR #54), leading to CONTRIBUTING (#151/#152).

### 3.22 User error & upstream-usage questions (≈19 issues)

#5 cookies vs headers, #14 changePassword 401, #15 plugins, #21 routes docs, #31 frontend client, #41 Prisma model missing, #49 admin plugin/Prisma enum, #50 social callback, #56 forgot `betterAuth()`, #81 `.env` typo, #90 dotenv, #114 example app, #129/#25 wrong URLs, #131 `asResponse`/cookie forwarding docs, #156 `onExistingUserSignUp` (user's `sendVerificationEmail` override), #164 `references` in `additionalFields` → 500. Owner's repeated boundary: "we're just a wrapper" (#31), "better-auth specific, in here we only focus on nestjs-better-auth" (#131). Lesson: silent 404s and generic 500s from the wrapper make upstream misconfiguration look like wrapper bugs; diagnostics (startup validation, route logging, clear errors) reduce this load.

---

## 4. underfisk/nestjs-better-auth

- Repo: 10 stars, 0 forks, issues **enabled** but **0 issues ever filed**; 17 PRs, all Dependabot/maintenance (`gh repo view`, `gh issue list`, `gh pr list` over `underfisk/nestjs-better-auth`). Last push 2026-06-16; better-auth dev dep 1.5.5 (PR #14 to 1.6.2 open). No new user-reported pain points available.
- Design contrasts from source (`tmp-ref-issues/underfisk/better-auth.module.ts`, README `tmp-ref-issues/u_readme.md`), code-reading only (**UNVERIFIED** at runtime):
  - Builds the better-auth instance itself from `betterAuthConfig` (README:42-47) → no user-owned `auth.ts` for the better-auth CLI and no `typeof auth` inference.
  - Mounts with `getInstance().all(basePath + (express ? '/*splat' : '/*'))`, converts to a Fetch `Request` with `body: JSON.stringify(request.body)` and calls `auth.handler` (module lines ~135-165) — breaks urlencoded bodies and raw-signature webhooks.
  - Hard-coded adapter whitelist `['express','fastify']` with a throw (module ~116, ~150) — closed to extension.
  - Same post-construction mutation of `auth.options.hooks` (`setupHooks`), README "HOOKS: WIP".
  - Configurable public metadata key `skipAuthDecoratorMetadataKey` (README:85-125) — lets users reuse their own `@Public()` instead of a library-owned one.
  - Explicitly keeps CommonJS output "as many existing applications still use CJS" (README:127-129).

---

## 5. Verified upstream facts the design will depend on

1. better-auth 1.7.4 is ESM-only; no `require` condition in any of 54 exports (package.json inspection). Docs: CJS unsupported (`express.mdx:13`), Fastify/Express guides assume ESM (`fastify.mdx:19-22`).
2. better-auth official mounting model: Express — catch-all route **before** body parsers (`express.mdx:18-35`); Fastify — a Fastify route building a Fetch `Request` and forwarding via `reply` (`fastify.mdx:36-70`, note its `JSON.stringify(request.body)` and `method: ["GET","POST"]`); CORS is the host framework's job.
3. better-call 1.4.0 `toNodeHandler` derives the base URL from raw `x-forwarded-proto`/`host` (`BC/dist/node.mjs:3-9`); `getRequest` prefers an unconsumed stream, else re-serializes `req.body` (`BC/.../request.mjs:102-117`); `constructRelativeUrl` handles Express mounts (`:95-101`); `setResponse` writes to the raw Node response (`:125-173`).
4. API hooks run for HTTP **and** server-side `auth.api.*` calls (`BA/.../api/dispatch.ts:310-322`); user hooks are read per request from context options (`:269-288`).
5. `databaseHooks` captured by reference at init (`helpers.ts:86-88`).
6. `getSession` may write and emit `Set-Cookie` (`session.ts:325-414`).
7. Trusted origins resolution includes baseURL, array/function option, env, plugins (`helpers.ts:40-85, 108-160`); wildcards supported (`utils/url.ts:347-381`).
8. NestJS 11: body parser registered before module middleware (`nest-application.js:99-101`); `configure()` runs inside `registerModules` (stack trace in #56); consumer middleware bound later in `registerRouter` (`:115-120`); global guards not applied to WS gateways (`socket-module.js:81` + `guards-context-creator.js:53-56`).
9. NestJS 12.0.1: ESM-only (`type: module`, no CJS), `node >= 20`, exports `"./*"` and `"./internal"` (internal = "not part of the public API").
10. Node `require(esm)` unflagged in 20.19.0 / 22.12.0 / 23.0.0; TLA → `ERR_REQUIRE_ASYNC_MODULE`.
11. `@fastify/cors` sets headers through `reply.header` in an `onRequest` hook and decorates the request (`FC/index.js:46, 60-67, 219-237`); NestJS Fastify `use()` = vendored middie on `onRequest` (`PF/adapters/fastify-adapter.js:420-428`, `middie/fastify-middie.js:180-186`).

---

## 6. Latent issues found by code reading (not in the tracker; runtime UNVERIFIED unless noted)

1. Express CORS wildcards silently ignored (cors exact match vs better-auth wildcards) — mechanism verified.
2. Express app-wide CORS allow-methods exclude PATCH/OPTIONS (`auth-module.ts:194`).
3. Refreshed session / cookie-cache `Set-Cookie` from the guard's `getSession` never reach the client — mechanism verified.
4. User API hooks fire on every guarded request for `/get-session` (and org/permission API calls) — mechanism verified.
5. `disableControllers: true` + README's `bodyParser:false` = no body parsing anywhere.
6. RPC contexts always 401; GraphQL subscriptions cannot authenticate; Mercurius likely throws.
7. `req.session`/`req.user` clobber express-session/Passport.
8. Fastify reply-level plugins (helmet/compress/onSend) bypassed on auth routes.
9. Tests never exercise `dist`; lockfile pins an old better-auth — verified.
10. Exported `AUTH_MODULE_OPTIONS_KEY` is not the real DI token — verified.

---

## 7. Top 10 design lessons (each tied to issues)

1. **Make mounting an adapter responsibility with a conformance suite, never a path-pattern trick.** Seven mount strategies in 15 months (§2.1) produced the largest cluster of silent 404s (#20, #25, #48, #85, #89, #91, #102, #107, #83, PR #80 revert). Match auth requests by normalized path prefix, never mutate `req.url`, and test every adapter × basePath × globalPrefix × versioning × better-auth version.
2. **Solve body parsing at the platform layer instead of instructing users to disable Nest's parser.** `bodyParser:false` caused test hangs (#16), lost `rawBody` (#88, #101, #112), missing limits (#111), Fastify crashes (#53), bundler failures (#147), and a replacement of Fastify's global parsers. better-call ≥1.3.5 tolerates pre-parsed JSON, but raw-signature plugin endpoints (Stripe `ctx.request.text()`) still need the untouched stream.
3. **Do not own app-wide CORS; if CORS help is provided, derive it from better-auth's resolved trust decision and scope it to auth routes.** #52 and #128 (Fastify double registration; raw responses bypass `reply` headers), #95 (ordering), #69 (wildcards vs exact match), function/env/plugin origins unsupported.
4. **Packaging is a feature: dual CJS+ESM built from one source, correct `exports` conditions, optional peers never statically loaded, and a smoke test of the packed tarball in CJS, ESM and bundler consumers.** #35, #82, #97, #100, #108, #132, #141, #147, #115; v2.5.0's ESM-only switch plus `node <23` (#130) pushed the problem onto consumers. With better-auth and Nest 12 ESM-only, CJS output depends on `require(esm)` (Node ≥20.19/22.12) — engines must say so, without upper bounds.
5. **Test against the real compatibility surface: better-auth min/latest (and next), Nest 11/12, Express 5/Fastify 5, supported Node versions; follow semver strictly.** A lockfile pinned better-auth 1.3.27 while users ran 1.5 (#115); 1.6/1.7 untested today; breaking changes shipped in minors (v2.5.0) led to #117's "third time" complaint.
6. **Extend better-auth only through its public extension points and at construction time.** Mutating `auth.options.hooks`/`databaseHooks` after `betterAuth()` depends on object identity and forces `hooks: {}`/`databaseHooks: {}` (#42, #32, PR #138's `{source, hooks}` break), and user hooks also run for internal `auth.api` calls (#103, UNVERIFIED link). Late-binding to Nest DI must not depend on internals.
7. **Define guard semantics explicitly and resolve the session lazily and once per request.** `@AllowAnonymous` still hits storage and 500s when the DB is down (#159, PR #160 closed); `@Session()` is `undefined` without the guard (#12); the owner rejects per-request `getSession` (PR #57) while the guard does it everywhere; infra failures must be 5xx not 401 (#159); refreshed cookies must be propagated (§6.3).
8. **Carry the auth instance type through the module without `any`.** #6, #8, #30, #47, #55, #62, #112, #163; `export type Auth = any` and an opt-in `UserSession<typeof auth>` (#135) leave most users on hand-written types, with shadow instances for `forRootAsync` (#112) and no narrowing after guards (#163).
9. **Make module configuration hard to misuse and fail fast.** Static (module-shape) vs runtime options placement silently ignored (#59, #88, #159), backward-compat normalization broke `useFactory` (#86), unvalidated instance (#56), a DI token that users cannot import (#159, PR #29), and the better-auth CLI's need for a static `auth.ts` (#3, #112).
10. **Keep authorization strategies and transports open for extension, explicit, and fail-closed at boot.** Role sources had to be split to prevent privilege escalation (PR #94 review → `@Roles`/`@OrgRoles`), plugin availability is checked per request and swallowed into 403, strategies are hard-coded in one guard (#17, #157, #163); transport handling is a lookup table where WS needs manual guards (PR #54), RPC always fails, and GraphQL subscriptions/Mercurius are unaddressed; multiple or dynamic instances are impossible with a single token and global metadata keys (#51, #79); error bodies per transport had to be patched (#148).

Honorable mentions: diagnostics for silent 404s (§3.1, §3.22); contributor experience and a documented toolchain (#86, #117, #151, PR #138); integrate with Nest middleware/filters/interceptors for auth routes (PR #71, PR #80).

---

## Appendix A — all 90 issues, categorized

| #    | State  | Opened     | Closed     | Comments | Title                                                                                                                              | Category                                          |
| ---- | ------ | ---------- | ---------- | -------: | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| #1   | CLOSED | 2025-06-16 | 2025-06-16 |        1 | package not found                                                                                                                  | release/docs                                      |
| #3   | CLOSED | 2025-06-19 | 2025-09-27 |        8 | Feature Request: Support forRootAsync in AuthModule for Dependency Injection (e.g., PrismaService)                                 | module-config/DI; better-auth CLI                 |
| #4   | CLOSED | 2025-07-02 | 2025-08-19 |       13 | Feature Request: Fastify Support                                                                                                   | fastify                                           |
| #5   | CLOSED | 2025-07-15 | 2025-07-15 |        1 | cookies vs headers                                                                                                                 | question (better-auth usage)                      |
| #6   | CLOSED | 2025-07-18 | 2025-07-21 |        0 | An argument for 'target' was not provided                                                                                          | types (decorator typing)                          |
| #8   | CLOSED | 2025-07-21 | 2025-07-23 |        3 | Session() decorator gives compile errors                                                                                           | types (decorator typing)                          |
| #12  | CLOSED | 2025-07-28 | 2025-07-28 |        4 | @Session returns undefined                                                                                                         | session-hydration semantics                       |
| #13  | CLOSED | 2025-07-30 | 2025-08-19 |        2 | Get `basePath` from `auth` config                                                                                                  | routing/basePath                                  |
| #14  | CLOSED | 2025-08-05 | 2025-08-05 |        0 | Issue with update password using nestjs backend                                                                                    | question (better-auth usage)                      |
| #15  | CLOSED | 2025-08-05 | 2025-08-05 |        1 | Does this works with the plugins too?                                                                                              | question                                          |
| #16  | CLOSED | 2025-08-07 | 2025-08-19 |        1 | Can't do integration test                                                                                                          | testing; body-parsing                             |
| #17  | CLOSED | 2025-08-11 | 2025-10-12 |        8 | Feature Request: Role Decorator for Route Protection                                                                               | org/roles/permissions                             |
| #20  | CLOSED | 2025-08-20 | 2025-08-22 |       19 | `/api/auth/*` always return 404                                                                                                    | routing/404; better-auth compat (better-call)     |
| #21  | CLOSED | 2025-08-21 | 2025-08-21 |        1 | documentation for the /api/auth routes?                                                                                            | docs                                              |
| #23  | CLOSED | 2025-08-22 | 2025-08-22 |        1 | `AuthHookContext` is not properly exported                                                                                         | hooks; release process                            |
| #25  | CLOSED | 2025-08-22 | 2025-08-23 |       16 | Bug: All auth routes return 404 due to potential typo in route registration                                                        | routing/404 (user error)                          |
| #28  | CLOSED | 2025-08-25 | 2025-09-27 |        6 | Bug: Custom HTTP Exception Filter not being used when disableExceptionFilter:true, for better auth config.                         | error format                                      |
| #30  | CLOSED | 2025-08-28 | 2025-08-28 |        0 | Automatically Adding Custom Fields to UserSession in NestJS with Better Auth Without Manual Interface Extension                    | types (custom fields)                             |
| #31  | CLOSED | 2025-09-05 | 2025-09-09 |        4 | How to use with the frontend?                                                                                                      | question (frontend)                               |
| #32  | CLOSED | 2025-09-08 | 2026-04-09 |        2 | Support for Database Hooks?                                                                                                        | hooks (database hooks)                            |
| #34  | CLOSED | 2025-09-09 | 2025-09-18 |        2 | Support for exporting instance type for use in client                                                                              | types (client inference)                          |
| #35  | CLOSED | 2025-09-13 | 2025-09-13 |        2 | [ERR_REQUIRE_ESM]: require() of ES Module - @noble/ciphers package                                                                 | ESM/CJS                                           |
| #39  | CLOSED | 2025-09-25 | 2025-09-27 |        1 | Feature request: Rename Optional decorator to avoid conflict with NestJS core                                                      | DX/naming                                         |
| #41  | CLOSED | 2025-09-26 | 2025-09-27 |        6 | [Better Auth]: Model user does not exist in the database. Prisma engine not working                                                | user error (Prisma)                               |
| #42  | CLOSED | 2025-10-01 | 2025-10-04 |        1 | [Bug] Hook decorators (@BeforeHook, @AfterHook) not working                                                                        | hooks                                             |
| #45  | CLOSED | 2025-10-03 | 2025-10-05 |        1 | Global AuthGuard ignores `@AllowAnonymous()` decorator                                                                             | guard/decorators (no repro)                       |
| #47  | CLOSED | 2025-10-07 | 2025-10-08 |        3 | Support for additional user fields?                                                                                                | types (custom fields)                             |
| #48  | CLOSED | 2025-10-09 | 2025-10-22 |        1 | Facing issue after building                                                                                                        | routing (Express 4 wildcard)                      |
| #49  | CLOSED | 2025-10-09 | 2025-10-09 |        1 | admin() plugin prevents creating normal users via email/password signup                                                            | user error (admin plugin)                         |
| #50  | CLOSED | 2025-10-09 | 2025-10-11 |        1 | How to handle Social login callback                                                                                                | question (social callback)                        |
| #51  | CLOSED | 2025-10-10 | 2025-10-20 |        2 | Mulit independent authentication within a single project                                                                           | multiple instances                                |
| #52  | CLOSED | 2025-10-11 | 2026-03-09 |        3 | FST_ERR_DEC_ALREADY_PRESENT (Duplicate @fastify/cors Registration) Breaks App, and Removing Manual CORS Breaks Better Auth Login   | fastify; CORS                                     |
| #53  | CLOSED | 2025-10-11 | 2026-03-08 |       15 | Fastify Compatibility: Cannot read properties of undefined (reading 'startsWith')                                                  | fastify; body-parsing middleware                  |
| #55  | CLOSED | 2025-10-13 | 2026-03-28 |        5 | @Session() decorator doesn't include custom user fields from Better Auth plugins                                                   | types (custom fields)                             |
| #56  | CLOSED | 2025-10-13 | 2025-10-14 |        1 | Getting undefined error for better auth options when using forRootAsync                                                            | module-config (user error, poor error msg)        |
| #58  | CLOSED | 2025-10-16 | 2025-10-19 |        1 | Changing basePath still shows on logger the default basePath configured by better-auth                                             | routing/basePath                                  |
| #59  | CLOSED | 2025-10-18 | 2025-11-01 |        3 | DisableGlobalAuthGuard won't effect with graphql code first                                                                        | module-config (extras); GraphQL                   |
| #60  | CLOSED | 2025-10-19 | 2025-10-27 |        1 | Overridden basePath is not reflected in the SkipBodyParsingMiddleware                                                              | routing/basePath; body-parsing                    |
| #62  | CLOSED | 2025-10-25 | 2025-11-23 |        5 | Admin functions missing from the api provided by AuthService                                                                       | types (plugin API via AuthService)                |
| #66  | CLOSED | 2025-11-02 | 2025-11-23 |        1 | [WARNING] AuthModule does not work with NestJS versions below v11                                                                  | NestJS version (10)                               |
| #67  | CLOSED | 2025-11-04 | 2025-11-25 |        2 | Using the module in distributed services                                                                                           | microservices/distributed                         |
| #68  | CLOSED | 2025-11-06 | 2025-11-23 |        2 | Configure and follow the steps all api routes getting 404                                                                          | routing/404 (no repro)                            |
| #69  | CLOSED | 2025-11-07 | 2025-11-08 |        1 | How to properly configure CORS?                                                                                                    | CORS (wildcard/cross-subdomain)                   |
| #72  | CLOSED | 2025-11-10 | 2025-11-23 |        2 | better-auth required version doesn't make sense                                                                                    | better-auth version range                         |
| #73  | CLOSED | 2025-11-16 | 2025-11-17 |        1 | NestJS version mismatch when installing `nestjs-better-auth`                                                                       | NestJS version (peer range)                       |
| #76  | CLOSED | 2025-11-21 | 2025-11-23 |        3 | Is this vibe coded?                                                                                                                | governance/trust                                  |
| #79  | OPEN   | 2025-11-27 | -          |        2 | Pass an instance provider rather than the better auth instance.                                                                    | multiple/dynamic instances                        |
| #81  | CLOSED | 2025-12-01 | 2026-01-27 |        4 | bug: sendVerificationEmail doesn't seems to work                                                                                   | user error (.env)                                 |
| #82  | CLOSED | 2025-12-01 | 2025-12-16 |        3 | ReferenceError: exports is not defined                                                                                             | ESM/CJS; optional peers                           |
| #83  | CLOSED | 2025-12-06 | 2025-12-06 |        1 | Auth endpoints returning 404 with NestJS global prefix                                                                             | global prefix (user baseURL error)                |
| #85  | CLOSED | 2025-12-09 | 2026-01-27 |       14 | Express 5 `/*path` Pattern Causes 404 on All Auth Routes                                                                           | routing/404 (Express 5 mount); better-auth compat |
| #86  | CLOSED | 2025-12-10 | 2026-03-08 |        3 | Normalize Options breaks useFactory pattern                                                                                        | module-config (forRoot normalization); testing    |
| #88  | CLOSED | 2025-12-13 | 2025-12-24 |        4 | Bug? - Stripe webhook not working with disableBodyParser, but works with nest bodyParser off                                       | raw body; module-config (extras)                  |
| #89  | CLOSED | 2025-12-15 | 2026-01-27 |        7 | Integration stopped to work with better-auth 1.4.6 and later                                                                       | routing/404; better-auth compat (1.4.6)           |
| #90  | CLOSED | 2025-12-16 | 2025-12-24 |        1 | Can not get .env data in auth.ts                                                                                                   | user error (dotenv)                               |
| #91  | CLOSED | 2025-12-18 | 2026-01-27 |        4 | Routes return 404 with Express 4.x due to incompatible wildcard syntax                                                             | routing/404 (Express 4 wildcard)                  |
| #95  | CLOSED | 2025-12-26 | 2026-01-09 |        2 | CORS error                                                                                                                         | CORS (ordering)                                   |
| #96  | CLOSED | 2026-01-10 | 2026-01-27 |        5 | Clarification on "bodyParser: false" requirement relevance                                                                         | body-parsing (bodyParser:false requirement)       |
| #97  | CLOSED | 2026-01-11 | 2026-01-27 |        1 | Graphql is required in non-graphql app                                                                                             | optional peers (GraphQL)                          |
| #100 | CLOSED | 2026-01-27 | 2026-02-08 |        2 | Cannot find package 'graphql' in v2.2.4                                                                                            | optional peers (GraphQL); testing                 |
| #101 | CLOSED | 2026-01-27 | 2026-02-08 |        1 | `req.rawBody` is `undefined` in my webhook when I disabled body-parser                                                             | raw body                                          |
| #102 | CLOSED | 2026-01-27 | 2026-02-08 |        2 | Unsupported route path: "*"                                                                                                        | routing (legacy '*' route warning)                |
| #103 | CLOSED | 2026-01-28 | 2026-03-09 |        3 | @AfterHook and @BeforeHook are triggered two times                                                                                 | hooks (double firing)                             |
| #107 | CLOSED | 2026-02-12 | 2026-03-08 |        2 | AuthModule does not work with @nestjs/platform-fastify (500 on all auth routes)                                                    | fastify (500/404)                                 |
| #108 | CLOSED | 2026-02-12 | 2026-03-08 |        4 | ERR_REQUIRE_ESM when deploying to Vercel/Serverless (Node.js runtime)                                                              | ESM/CJS (Vercel)                                  |
| #111 | CLOSED | 2026-02-16 | 2026-03-08 |        1 | feat: allow configuring body-parser options (e.g. express.json limit)                                                              | body-parsing (limits)                             |
| #112 | CLOSED | 2026-02-19 | 2026-06-01 |        2 | [BUG] Additional Fields not used in AuthService                                                                                    | types (additionalFields; upstream)                |
| #114 | CLOSED | 2026-03-01 | 2026-04-12 |        2 | An example app would be much of help                                                                                               | docs/example                                      |
| #115 | CLOSED | 2026-03-02 | 2026-03-08 |        3 | SyntaxError: Export named 'createAuthMiddleware' not found in module 'better-auth/dist/plugins/index.mjs' with better-auth ≥ 1.5.x | better-auth compat (1.5 export move)              |
| #117 | CLOSED | 2026-03-07 | 2026-03-08 |        7 | Maintenance status & community interest                                                                                            | governance/maintenance                            |
| #118 | CLOSED | 2026-03-08 | 2026-03-09 |        2 | Hooks fire twice when `@BeforeHook()` or `@AfterHook()` decorators are used                                                        | hooks (withdrawn)                                 |
| #128 | CLOSED | 2026-03-09 | 2026-05-22 |        7 | CORS integration error between the application and the better-auth plugin                                                          | fastify; CORS                                     |
| #129 | CLOSED | 2026-03-11 | 2026-03-11 |        1 | bug: Plugin-generated routes (e.g., Polar.sh) return 404 with AuthModule                                                           | routing/404 (user error)                          |
| #130 | CLOSED | 2026-03-11 | 2026-03-11 |        2 | v2.5.0 introduces overly restrictive Node.js engine constraint (>=22.22.1 <23)                                                     | packaging (engines)                               |
| #131 | CLOSED | 2026-03-15 | 2026-03-24 |        1 | Documentation Enhancement Required                                                                                                 | docs (server-side API/cookies)                    |
| #132 | CLOSED | 2026-03-17 | 2026-03-24 |        1 | Express installation required even when using Fastify                                                                              | fastify; optional peers (express)                 |
| #136 | CLOSED | 2026-03-28 | 2026-03-30 |        0 | docs: fix broken link                                                                                                              | docs                                              |
| #139 | CLOSED | 2026-04-01 | 2026-04-06 |        0 | Widen TypeScript peer dependency to include v6.x                                                                                   | packaging (typescript peer)                       |
| #141 | CLOSED | 2026-04-08 | 2026-04-11 |        4 | ERR_REQUIRE_ESM when deploying to Vercel/Serverless (Node.js runtime)                                                              | ESM/CJS (Vercel, Node 20)                         |
| #146 | CLOSED | 2026-05-28 | 2026-06-01 |        1 | 2.6.1 not available on npm                                                                                                         | release process                                   |
| #147 | OPEN   | 2026-05-28 | -          |        1 | `getExpressBodyParser` leads to `Cannot find module 'express'`                                                                     | module resolution (bundlers, express require)     |
| #148 | CLOSED | 2026-06-04 | 2026-06-25 |        0 | UnauthorizedException & ForbiddenException for http are not providing status code                                                  | error format                                      |
| #151 | CLOSED | 2026-06-09 | 2026-06-25 |        0 | Add a CONTRIBUTING guide and PR template                                                                                           | process (CONTRIBUTING)                            |
| #153 | CLOSED | 2026-06-09 | 2026-06-25 |        0 | CI: pin Bun version and use a frozen lockfile                                                                                      | process (CI)                                      |
| #156 | CLOSED | 2026-06-26 | 2026-07-06 |       17 | fix(emailAndPassword): onExistingUserSignUp not working                                                                            | question (better-auth behavior)                   |
| #157 | CLOSED | 2026-06-29 | 2026-07-04 |        1 | Allow requiring active organization context without requiring org roles                                                            | org/roles/permissions                             |
| #159 | OPEN   | 2026-07-01 | -          |        8 | BUG - handlers with AllowAnonymous decorator still use better-auth getSession and hit DB connection                                | performance; guard semantics; error format        |
| #163 | OPEN   | 2026-07-23 | -          |        1 | @RequireActiveOrg() decorator should require a mandatory activeOrganizationId                                                      | org; types (narrowing)                            |
| #164 | CLOSED | 2026-08-06 | 2026-09-03 |        1 | BUG: Failed To Get Session, INTERNAL_SERVER_ERROR when requesting `/get-session` endpoint                                          | user error (schema) surfaced as 500               |
| #165 | CLOSED | 2026-08-28 | 2026-09-03 |        0 | feature: Add support for NestJS Version 12                                                                                         | NestJS version (12)                               |

(Comment counts include bot comments; generated from `issues.json` + `cat_map.json` in `tmp-ref-issues/`.)

## Appendix B — design-relevant PRs (one line each)

| PR                  | Status          | Gist                                                                                               |
| ------------------- | --------------- | -------------------------------------------------------------------------------------------------- |
| #2                  | merged          | `@Public`/`@Optional` as class decorators; "isn't `@Optional` functionally the same as `@Public`?" |
| #7                  | merged          | `Session` typed via `ReturnType<typeof createParamDecorator>` (fixes #6/#8)                        |
| #9                  | merged          | hook methods called with wrong `this`                                                              |
| #11                 | closed          | first forRootAsync (community); superseded by #27/#38                                              |
| #22                 | merged          | remove `req.url` override after better-call 1.0.15 (fixes #20), pinned better-call override        |
| #26                 | merged          | migrate build to unbuild                                                                           |
| #27/#38             | merged          | ConfigurableModuleBuilder forRoot/forRootAsync; exception filters removed                          |
| #29                 | merged          | export symbols ("uses `Symbol` and not `Symbol.for`")                                              |
| #33                 | merged          | WS handshake headers                                                                               |
| #36                 | merged          | `@Roles` (admin plugin)                                                                            |
| #37                 | merged          | GraphQL support                                                                                    |
| #42→#43             | merged          | hooks fix requires `hooks: {}`                                                                     |
| #54                 | merged          | WebSocket support; APP_GUARD doesn't apply to gateways                                             |
| #57                 | closed          | session middleware on every request — rejected for cost                                            |
| #61                 | merged          | basePath in SkipBodyParsingMiddleware                                                              |
| #63/#65             | closed          | community Fastify/CORS rewrites                                                                    |
| #64                 | merged          | comma-separated roles                                                                              |
| #70→#71             | merged          | generic `middleware` option (MikroORM RequestContext)                                              |
| #75→#78             | merged          | `disableControllers`; `disableGlobalAuthGuard` removed from options type (extras only)             |
| #77/#99/#105/#113   | merged          | optional peers via lazy `import()`                                                                 |
| #80                 | merged→reverted | MiddlewareConsumer mount; broke global prefix                                                      |
| #93                 | merged          | mount at basePath without wildcard (better-auth 1.4.6 404s)                                        |
| #94                 | merged          | `@OrgRoles` separated after privilege-escalation review                                            |
| #104                | merged          | MiddlewareConsumer + global prefix exclusion via ApplicationConfig                                 |
| #106→#121/#122/#123 | merged          | rawBody → `bodyParser` options; deprecations                                                       |
| #109                | merged          | `@UserHasPermission` / `@MemberHasPermission`                                                      |
| #110 / #119         | closed / merged | ESM-only migration                                                                                 |
| #116                | merged          | `createAuthMiddleware` from `better-auth/api`; peer `>=1.5.0`                                      |
| #120                | merged          | Express+Fastify CI matrix; `httpAdapter.use` + `matchesBasePath`                                   |
| #127 / #143         | merged          | Fastify CORS dedupe / hand-rolled Fastify auth-route CORS                                          |
| #133/#134           | closed/merged   | decouple public types from Express; lazy express require                                           |
| #135                | merged          | `UserSession<typeof auth>`                                                                         |
| #138 / #142         | closed / merged | DB hooks (contributor vs owner reimplementation)                                                   |
| #145                | merged          | Fastify body limit parsing                                                                         |
| #149                | merged          | Nest-default 401/403 bodies                                                                        |
| #155                | closed          | `body-parser` instead of `express` (for #147) — closed without comment                             |
| #158                | merged          | `@RequireActiveOrg`                                                                                |
| #160                | closed          | DB-down tolerant anonymous routes — closed by author after owner's v3 comment                      |
| #161                | merged          | npm OIDC trusted publishing                                                                        |
| #166                | merged          | Nest 12 peers                                                                                      |
