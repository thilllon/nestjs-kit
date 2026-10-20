# Research: Dual CJS + ESM packaging and runtime compatibility

Topic: dual CJS + ESM packaging and runtime compatibility for `nestjs-slightly-better-auth`.
Date of research: 2026-09-10. Researcher: packaging subagent (research phase only; no design decisions made here).

## Conventions

- `$SP` = `/private/tmp/claude-502/-Users-thilllon-git-nestjs-slightly-better-auth/d03cce33-4991-442c-88b5-c314fe7f3223/scratchpad`
- `$TP` = `$SP/tmp-packaging` (all downloads and experiments live here)
- `$BA` = `$SP/better-auth` (better-auth monorepo at v1.7.4)
- `$REF` = `$SP/ref` (@thallesp/nestjs-better-auth v2.8.0 at 99d4a94)
- `$REPO` = `/Users/thilllon/git/nestjs-slightly-better-auth` (read-only)
- `$X` = `$TP/tarballs/x` (extracted published tarballs)
- Anything marked **UNVERIFIED** was not confirmed by source, output or a primary document.

Tools used: Node 20.18.3, 20.19.0, 22.11.0, 22.12.0 (downloaded to `$TP/node-bins`) plus 22.21.1, 22.22.0, 24.14.1, 26.7.0 (mise). pnpm 11.25.0, tsdown 0.23.0 (rolldown 1.2.8), TypeScript 5.9.3, 6.0.3 and 7.0.2, publint 0.3.24, @arethetypeswrong/cli 0.18.5, vitest 5.0.0 (vite 8.2.2), jest 30.5.1 with ts-jest 29.4.12, Biome 2.5.12.

---

## 0. Executive summary (most decision-relevant facts)

1. **better-auth 1.7.4 and @better-auth/core 1.7.4 are ESM-only.** This holds in the git source and in the published tarballs. There is no `require` condition on any of the 54 better-auth subpaths or 13 core subpaths, including `better-auth/node` and `better-auth/api`. better-auth's docs say "CommonJS (cjs) isn't supported". However, `require()` of every subpath I tested works on Node 20.19.0+ and 22.12.0+ (the require(esm) versions) because the graph has no top-level await. It fails with `ERR_REQUIRE_ESM` on 20.18.3 and 22.11.0. This compatibility is incidental: better-auth has no CJS smoke test.
2. **NestJS 12 is out and ESM-only.**
   - `@nestjs/core` / `@nestjs/common` 12.0.1 (npm `latest`, published 2026-08-27) are `"type": "module"` with no `require` condition. So are `platform-express` 12, `platform-fastify` 12, `websockets` 12, `@nestjs/graphql` 14 and `@nestjs/apollo` 14.
   - NestJS 11 (11.2.3) is plain CJS.
   - `nest new` defaults: the v11 schematics generate CJS only. The v12 schematics (`@nestjs/schematics` 12.0.0) default to **ESM** (with vitest) and offer CJS (with jest) only through an interactive prompt. A non-interactive `nest new` on CLI 12.0.0 produced `"type": "module"`.
3. **Node require(esm):**
   - Unflagged in v20.19.0 and v22.12.0 (and 23.0.0).
   - The warning was removed in v20.19.0, v22.13.0 and v23.5.0. I observed it on 22.12.0 but not on 22.21.1 or later.
   - Stable (no longer experimental) from v25.4.0.
   - It throws `ERR_REQUIRE_ASYNC_MODULE` if the graph contains top-level await (TLA), which I verified.
   - Node 20 reached end-of-life on 2026-04-30.
4. **A CJS consumer needs a require(esm)-capable Node no matter what we ship**, because better-auth (and Nest 12) are ESM-only. Our CJS build does not lower that floor unless it defers every better-auth import behind `import()`.
   - Jest in CJS mode (the Nest CJS template's runner) cannot load better-auth 1.7.4 or `@nestjs/common` 12 unless it runs on Node 24.9+ with `--experimental-vm-modules`. I verified this with jest 30.5.1 on Node 22.22 and 24.14.
   - A CJS build of our library does not fix Jest, because our CJS code would `require("better-auth/...")` and fail the same way.
5. **tsdown 0.23.0 handles legacy decorators plus `emitDecoratorMetadata`** through rolldown/oxc, driven by tsconfig. I built a class with constructor param types in ESM and CJS, and NestJS DI resolved it in both. Rolldown's own typing states that `emitDecoratorMetadata` "only works when `legacy` is true".
   - Pitfall: without `experimentalDecorators` in the tsconfig that tsdown reads, the build _succeeds_ but emits raw TC39 decorator syntax, which crashes Node with a `SyntaxError`.
   - `import type` of an injected class silently yields `Object` in `design:paramtypes`.
   - Biome's `useImportType` offers exactly that rewrite as a "Safe fix", and its docs say to disable the rule for NestJS.
6. **Dual-package hazard reproduced under NestJS 11.**
   - When both our CJS and ESM builds load in one process, `Symbol()` tokens and class tokens from the other copy fail DI with `UnknownDependenciesException`.
   - `Symbol.for()` and string tokens survive.
   - Module-level state (a `Map`) splits.
   - Metadata written under a `Symbol()` key by one copy is invisible to the other, a _silent_ failure.
   - Three mitigations were verified: `module-sync`-first, `node`→CJS routing, and an ESM wrapper over CJS. rxjs 7 and graphql 17, the two dual-format packages in Nest's graph, both route `node` to CJS.
7. **Verification tooling.** tsdown 0.23.0 can run publint and attw after the build. Its auto-generated `exports` map omits `types` conditions and relies on sibling `.d.mts`/`.d.cts` lookup; that passes attw's `node16` profile and fails the `node10` column for subpaths.
   - attw does **not** check what our `.d.cts` imports transitively from better-auth, so a consumer type-check matrix is needed.
   - better-auth 1.7.4's own types need `skipLibCheck: true`.
8. **Reference library (v2.8.0).**
   - It is ESM-only (`emitCJS: false`, since commit 36aea7c, 2026-02-16) and built with unbuild/esbuild, which does _not_ emit decorator metadata. The published `dist` has 0 `design:` occurrences, so every constructor param uses explicit `@Inject(...)`.
   - It hit the classic bug of a bare `require()` inside ESM output; fixing it (63887b3) made its error factories async.
   - It validates "CommonJS" with a SWC-compiled copy of `src`, not the published `dist`.

---

## 1. Is better-auth ESM-only or dual? Which subpaths offer `require`?

### 1.1 Source (git clone at v1.7.4)

- `$BA/packages/better-auth/package.json:5` has `"type": "module"`. Lines :40-48: `main` and `module` = `./dist/index.mjs`, `types` = `./dist/index.d.mts`, and `exports["."]` = `{ "dev-source": "./src/index.ts", "types": "./dist/index.d.mts", "default": "./dist/index.mjs" }`.
- `./api` (package.json:114) and `./node` (package.json:164) have the same shape: `dev-source` / `types` (`.d.mts`) / `default` (`.mjs`). `./node` → `./dist/integrations/node.mjs`; `./api` → `./dist/api/index.mjs`.
- A script over the exports map found **54 subpaths, 0 of which mention `require`, `.cjs` or `.cts`**. Command: node over `package.json`; output `total subpaths: 54`, `subpaths w/ require or cjs: []`.
- `$BA/packages/core/package.json:5` has `"type": "module"`. It has 13 subpaths, 0 with `require`. `./async_hooks` (core package.json:51-60) has runtime conditions `node`/`deno`/`bun`/`workerd` → `index.mjs` and `edge`/`browser` → `pure.index.mjs`. All are ESM.
- better-auth's own CI treats itself as ESM-only. `packages/better-auth/package.json:32-33` contains `"lint:package": "publint run --strict --pack false"` and `"lint:types": "attw --profile esm-only --pack ."`. Core has the same at `packages/core/package.json:26-27`.
- Build: `packages/better-auth/tsdown.config.ts:4-5` has `dts: { build: true, incremental: true }, format: ["esm"]`, and `:68` has `unbundle: true`. The monorepo pins `tsdown: 0.21.10` and `typescript: ^6.0.3` (`$BA/pnpm-workspace.yaml:72-73`).
- `engines` is not declared in either package.

### 1.2 Published tarballs (`npm pack better-auth@1.7.4 @better-auth/core@1.7.4` into `$TP/tarballs`)

- `better-auth 1.7.4 type= module main= ./dist/index.mjs types= ./dist/index.d.mts subpaths= 54`, `with require/cjs: []`. The file-extension census of `dist` is 250 `.mjs` and 210 `.d.mts`, with no `.cjs` or `.d.cts` at all.
- `@better-auth/core 1.7.4 type= module ... subpaths= 13`, `with require/cjs: []`.
- The published manifests keep the `dev-source` condition, but **the better-auth tarball ships no `src/`** (`ls ba/package` → `dist LICENSE.md package.json README.md`). A tool that enables a `dev-source` condition would therefore fail to resolve better-auth. The core tarball does ship `src/`.
- The repo's installed better-auth 1.5.5 was also ESM-only: `keys w/ require: 0 of 56 type module`.

### 1.3 Docs

- `$BA/docs/content/docs/installation.mdx:395`: "Note that CommonJS (cjs) isn't supported."
- `$BA/docs/content/docs/integrations/express.mdx:13`: "Note that CommonJS (cjs) isn't supported. Use ECMAScript Modules (ESM) by setting `"type": "module"`..."
- `$BA/docs/content/docs/integrations/fastify.mdx:18-20` lists ES module support (`"type": "module"` or `"module": "ESNext"`) as a prerequisite.
- `$BA/docs/content/docs/integrations/nestjs.mdx:12-14`: the NestJS integration is "community maintained" and points to ThallesP/nestjs-better-auth.

### 1.4 Does `require()` actually work? (empirical; `$TP/req-esm/test.cjs`)

| Node                                 | better-auth, /node, /api, /plugins, /minimal, @better-auth/core, core/api                     | `process.features.require_module` |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | --------------------------------- |
| 20.18.3                              | **FAIL `ERR_REQUIRE_ESM`**                                                                    | undefined                         |
| 20.19.0                              | OK, no warning                                                                                | true                              |
| 22.11.0                              | **FAIL `ERR_REQUIRE_ESM`**                                                                    | false                             |
| 22.12.0                              | OK, emits `ExperimentalWarning: CommonJS module ... is loading ES Module ... using require()` | true                              |
| 22.21.1 / 22.22.0 / 24.14.1 / 26.7.0 | OK, no warning                                                                                | true                              |

- So there is no top-level await in those graphs today. better-auth's e2e suite has no CJS smoke test (`$BA/e2e/smoke/test` contains only saml, expo-metro and cloudflare fixtures). **UNVERIFIED** that better-auth intends to stay TLA-free. A future TLA anywhere in the graph would turn every `require()` path into `ERR_REQUIRE_ASYNC_MODULE`.
- Disagreement to report: the docs say CJS "isn't supported", yet `require()` works on require(esm)-capable Node. Treat that as best-effort, not a contract.

---

## 2. Consequences for CommonJS NestJS apps

### 2.1 What `nest new` generates (verified from the schematics tarballs and the CLI)

- `@nestjs/schematics@11.1.0` application template `files/ts/tsconfig.json:3-5`: `"module": "nodenext", "moduleResolution": "nodenext", "resolvePackageJsonExports": true`, plus `emitDecoratorMetadata` and `experimentalDecorators` (:10-11). Its `package.json` has **no `"type"` field**, so the emitted code is CJS, and it uses jest. The factory and schema contain 0 mentions of `esm`.
- `@nestjs/schematics@12.0.0` (npm `latest`):
  - `dist/lib/application/schema.json:40-56` defines `"type": { "enum": ["cjs","esm"], "default": "esm", "x-prompt": ... "ESM (ES Modules) [ with vitest ]" / "CJS (CommonJS) [ with jest ]" }`.
  - `application.factory.js:27` has `target.type = target.type ?? 'esm'`, and `:49-51` selects the `ts-esm` template when `type === 'esm'`.
  - The `ts-esm` template's `package.json` has `"type": "module"`, `vitest ^4.1.2`, `typescript ^6.0.2`, and a vitest config with **no SWC plugin**.
  - The `ts` (CJS) template uses `jest ^30.0.0` and `ts-jest ^29.2.5`, and its `jest.config.ts` has `transform: {'^.+\\.(t|j)s$': 'ts-jest'}` with no `transformIgnorePatterns`.
- `@nestjs/cli@12.0.0 new --help` has **no `--type` flag**. `npx @nestjs/cli@12.0.0 new app12 --skip-install --skip-git -p pnpm --no-observe < /dev/null` produced `"type": "module"` with `"test": "vitest run"`.
- Conclusion: "nest new defaults to commonjs" is **true for Nest 11 and false for Nest 12**.

### 2.2 Nest 12 packages are ESM-only (published tarballs)

- `@nestjs/core 12.0.1 type= module main= ./index.js ... engines= {"node":">= 20"}`, with `exports: {".":"./index.js","./internal":"./internal.js","./*.js":"./*.js","./*":"./*.js"}` (`$X/nestjs-core-12.0.1/package/package.json:7-14`). `@nestjs/common` 12.0.1 has the same shape.
- `@nestjs/core 11.2.3` has no `type` and no `exports`, so it is CJS.
- From `npm view`: `@nestjs/platform-express@12.0.1`, `platform-fastify@12.0.1`, `websockets@12.0.1`, `@nestjs/graphql@14.0.0` and `@nestjs/apollo@14.0.0` are all `type=module`. `@nestjs/graphql@13.4.5` and `platform-fastify@11.2.3` are CJS. `express@5.2.1`, `fastify@5.12.3` and `reflect-metadata@0.2.2` are CJS.
- `require("@nestjs/common")` for v12 (`$TP/nest12/t.cjs`) fails with `ERR_REQUIRE_ESM` on 20.18.3 and works on 20.19.0, 22.12.0 and 24.14.1. The declared `engines: ">= 20"` understates this for CJS consumers.
- Nest 12 quirk: `require("@nestjs/core/package.json")` resolves to `package.json.js` (`MODULE_NOT_FOUND`), and `import(..., {with:{type:"json"}})` gives `ERR_MODULE_NOT_FOUND`. The `"./*": "./*.js"` wildcard has no explicit `./package.json` entry. Do not sniff Nest's version via its package.json.
- Instance identity (verified in `$TP/nest12/same.mjs` and `$TP/consumer/same11.mjs`): `import` and `require` return the **same** `Injectable` for Nest 12 (ESM-only; require(esm) shares the ESM cache) and for Nest 11 (CJS-only; ESM imports the CJS module). Nest itself therefore never has a dual-package hazard: each major ships exactly one format.

### 2.3 Node require(esm) status (primary docs)

From https://nodejs.org/api/modules.html, "Loading ECMAScript modules using require()":

- v25.4.0: "This feature is no longer experimental."
- v23.5.0, v22.13.0, v20.19.0: "no longer emits an experimental warning by default".
- v23.0.0, v22.12.0, v20.19.0: "no longer behind the `--experimental-require-module` CLI flag".
- v23.0.0, v22.12.0: support for the `'module.exports'` interop export.
- "If the module being `require()`'d contains top-level `await`, or the module graph it `import`s contains top-level `await`, `ERR_REQUIRE_ASYNC_MODULE` will be thrown."
- The return value is the module namespace object, with `__esModule: true` when it has a default export.

Node 20.19.0 release notes (https://nodejs.org/en/blog/release/v20.19.0, 2025-03-13): require(esm) is enabled by default, and the `"module-sync"` condition is available. Feature detection is via `process.features.require_module`.

My observations match: the 22.12.0 warning appeared, and the 22.21.1+ warning did not (§1.4).

Node release schedule (https://raw.githubusercontent.com/nodejs/Release/main/schedule.json):

- v20 end: 2026-04-30 (already EOL).
- v22 maintenance, end 2027-04-30.
- v24 active LTS until 2026-10-20, end 2028-04-30.
- v26 LTS from 2026-10-28.

### 2.4 TypeScript: `module`/`moduleResolution` and how `import`/`import()` are emitted (experiment `$TP/ts-cjs`)

A CJS file (package with no `"type"`) that statically imports `better-auth` and `better-auth/node` and dynamically imports `better-auth/api`:

| TS    | `--module` / `--moduleResolution`                           | Result                                                                                                                                          | Emitted static import         | Emitted `import()`                                                                                  |
| ----- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| 5.9.3 | nodenext / nodenext                                         | exit 0                                                                                                                                          | `require("better-auth/node")` | native `await import("better-auth/api")`                                                            |
| 5.9.3 | node20 / node16                                             | exit 0                                                                                                                                          | `require(...)`                | native `import()`                                                                                   |
| 5.9.3 | node16 / node16                                             | **TS1479** "current file is a CommonJS module whose imports will produce 'require' calls; however, the referenced file is an ECMAScript module" | `require`                     | native `import()`                                                                                   |
| 5.9.3 | node18 / node16                                             | **TS1479**                                                                                                                                      |                               |                                                                                                     |
| 5.9.3 | commonjs / node10                                           | exit 0                                                                                                                                          | `require`                     | **`Promise.resolve().then(() => require("better-auth/api"))`**, which needs require(esm) at runtime |
| 5.9.3 | commonjs / bundler                                          | TS5095, not allowed                                                                                                                             |                               |                                                                                                     |
| 6.0.3 | nodenext / nodenext, node20 / node16                        | exit 0                                                                                                                                          | `require`                     | native `import()`                                                                                   |
| 6.0.3 | node16 / node16                                             | TS1479                                                                                                                                          |                               |                                                                                                     |
| 6.0.3 | commonjs / node10                                           | **TS5107** "Option 'moduleResolution=node10' is deprecated and will stop functioning in TypeScript 7.0"                                         |                               |                                                                                                     |
| 6.0.3 | commonjs / bundler, or commonjs with the default resolution | exit 0                                                                                                                                          | `require`                     | `Promise.resolve().then(() => __importStar(require(...)))`                                          |

- TS 5.8 release notes (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html): "TypeScript 5.8 supports this behavior under the `--module nodenext` flag. When `--module nodenext` is enabled, TypeScript will avoid issuing errors on these `require()` calls to ESM files." And: "`require()` of ECMAScript modules is disallowed under `node18`, but allowed under `nodenext`."
- TS 6.0 announcement (https://devblogs.microsoft.com/typescript/announcing-typescript-6-0/): `--moduleResolution node` (node10) and `classic` are deprecated. The new defaults are `strict: true`, `module: esnext`, `target: es2025`, `rootDir: .` and `types: []`. `"ignoreDeprecations": "6.0"` silences the deprecations, and the deprecated options are "removed entirely in TypeScript 7.0".
- **TypeScript 7.0.2 is npm `latest`** (`npm view typescript dist-tags`: `"latest": "7.0.2"`). It is the native port: the package depends on `@typescript/typescript-<platform>` binaries, and its `exports["."]` is `./lib/version.cjs`. `require("typescript").createProgram` is `undefined`, and only `./unstable/*` APIs are exported. So tools that need the classic TS JS API (ts-jest, api-extractor, and rolldown-plugin-dts's `tsc` generator) need TS 5.x/6.x installed. tsc 7.0.2 **does** emit `__metadata("design:paramtypes", [...])` for the decorator experiment. It also required an explicit `rootDir` (TS5011) under its new defaults.
- The current repo's tsconfig extends `@tsconfig/node22`, which sets `"module": "nodenext", "moduleResolution": "node16"` (`$REPO/node_modules/@tsconfig/node22/tsconfig.json`).

### 2.5 Jest (CJS mode): the default runner of Nest CJS projects (experiment `$TP/jest-cjs`)

The setup mirrors the Nest 12 `ts` template's `jest.config.ts` (ts-jest transform, no `transformIgnorePatterns`), with jest 30.5.1, ts-jest 29.4.12 and TS 6.0.3.

| Node    | Flags                       | `import { Injectable } from "@nestjs/common"` (v12) | `import { toNodeHandler } from "better-auth/node"` |
| ------- | --------------------------- | --------------------------------------------------- | -------------------------------------------------- |
| 22.22.0 | none                        | FAIL "Must use import to load ES Module"            | FAIL (same)                                        |
| 22.22.0 | `--experimental-vm-modules` | FAIL                                                | FAIL                                               |
| 24.14.1 | none                        | FAIL                                                | FAIL                                               |
| 24.14.1 | `--experimental-vm-modules` | PASS                                                | PASS                                               |

- Jest docs (https://jestjs.io/docs/ecmascript-modules): "On Node v24.9 and later, Jest supports `require()`-ing an ES module from CJS code... On Node versions older than v24.9, `require()` of an ESM file still throws `ERR_REQUIRE_ESM`." Also: "Packages resolve through the `require` and `module-sync` conditions, as they do in Node." The docs also require `--experimental-vm-modules`.
- Jest 30.4.0 release (https://github.com/jestjs/jest/releases/tag/v30.4.0): "require(esm) module is now supported on Node 24.9+ (still requires --experimental-vm-modules like before)." npm dates it 2026-05-07. The fetched page summary said "2025", which is wrong according to `npm view jest time`.
- I did not generate this with `nest new --type cjs`: CLI 12.0.0 exposes no `--type` flag, and its prompt defaults to ESM. The config mirrors the template file verbatim, minus `moduleNameMapper` for empty `paths`.
- Commonly suggested workarounds such as `transformIgnorePatterns` plus babel transforming better-auth's `.mjs` are **UNVERIFIED** here.

### 2.6 What our library must do for a CJS consumer to use it (facts, not a design)

- The consumer's Node must support require(esm): **^20.19.0 || >=22.12.0**. This comes from better-auth, and from Nest 12 for Nest 12 users, whatever we ship. Below that line, only a CJS build that defers every better-auth and Nest 12 import behind `import()` could load. That is not viable for Nest 12 at all, because Nest 12 is itself ESM-only and is loaded by the app.
- Given that floor, **an ESM-only build is already `require()`-able** by Nest 11 CJS apps, provided our ESM graph has no TLA (verified with the `$TP/edge` TLA experiment, §6.4). What a CJS build adds:
  - It is loadable by tools that resolve the `require` condition and lack require(esm). Those tools still fail on better-auth.
  - TS consumers in `module: node16` or `node18` CJS mode can import _our_ package without TS1479. Verified in §7.4: the dual prototype resolved to `.d.cts` under node16 CJS with no error on our import, while the direct `better-auth` import in the same file raised TS1479.
  - It satisfies the stated hard requirement.
- Whatever we ship: no TLA anywhere in the graph, no `default` export (named exports only; see the publint `CJS_WITH_ESMODULE_DEFAULT_EXPORT` rule), and no side effects at module scope that assume a single copy (§5).

---

## 3. tsdown: dual output, `.d.ts` flavours, exports map, `fixedExtension`, unbundle

### 3.1 Versions

- Current repo: `devDependencies.tsdown ^0.12.5` (`$REPO/package.json:61`), installed as **0.12.9** paired with rolldown `1.0.0-rc.9`. That pairing printed `Warning: Invalid input options ... "define"`, i.e. the toolchain is out of sync.
- Latest: **tsdown 0.23.0** (`npm view tsdown dist-tags`: latest 0.23.0, 2026-09-03), which bundles `rolldown ~1.2.7` (1.2.8 installed) and `rolldown-plugin-dts ^0.28.5`.
  - tsdown 0.23.0 `engines.node`: `^22.18.0 || ^24.11.0 || >=26.0.0`. This constrains only the build machine; mise pins 24.14.1.
  - Peers (all optional): `publint ^0.3.8`, `@arethetypeswrong/core ^0.18.1`, `typescript ^5 || ^6 || ^7`, and others.
- better-auth builds with tsdown 0.21.10 (§1.1).

### 3.2 Current repo config vs. new defaults

- `$REPO/tsdown.config.ts:3-7`: `entry: ["src/index.ts"], format: ["cjs", "esm"], dts: true`.
- `$REPO/package.json:21-35`: `types ./dist/index.d.ts`, `main ./dist/index.cjs`, `module ./dist/index.js`, and exports with `import: {types: ./dist/index.d.ts, default: ./dist/index.js}` and `require: {types: ./dist/index.d.cts, default: ./dist/index.cjs}`.
- This matches tsdown **0.12.9** output (ESM as `.js` because `"type": "module"`), where `fixedExtension` defaults to `false` (`$REPO/node_modules/tsdown/dist/config-DL8S79AB.d.mts:269-275`). In 0.12.9's build of `$TP/deco-exp`, the output was `dist-0129/index.js`.
- In **0.23.0**, `fixedExtension` defaults to `platform === 'node'`, i.e. `true` (`$X/../tsdown/package/dist/types-CYHmmaKd.d.mts:1205-1214`). The resolver is `build-JVmLFaZt.mjs:420-426`: `es` → `mjs` unless `!fixedExtension && type==="module"`, and `cjs` → `cjs`. Outputs are `index.mjs`, `index.cjs`, `index.d.mts` and `index.d.cts`.
- **The repo's current exports map would point at files that 0.23.0 no longer emits.**

### 3.3 Relevant 0.23.0 options (`$TP/tarballs/tsdown/package/dist/types-CYHmmaKd.d.mts`)

- `format?: Format | Format[] | Partial<Record<Format, Partial<ResolvedConfig>>>` (:1154). Per-format overrides are possible.
- `platform` (:998): "For CJS format, this is always set to `node`" (enforced at `build-JVmLFaZt.mjs:563`).
- `target` (:1000-1028): "If not set, defaults to the value of `engines.node`". Observed: `target: node20.19.0` from `engines: ">=20.19.0"`.
- `shims` (:1054-1064): `__dirname`/`__filename` in ESM, default false. "`import.meta.url`, `import.meta.dirname`, and `import.meta.filename` are always shimmed in CJS output."
- `checks.legacyCjs` (:1127-1137): "If the config includes the `cjs` format and one of its targets is a Node.js version that supports `require(esm)` (`^20.19.0 || >=22.12.0`), warn the user about the deprecation of CommonJS." Default true. Observed: `WARN We recommend using the ESM format instead of CommonJS.`
- `unbundle` (:1189-1194): "output files will mirror the input file structure". Implemented as rolldown `preserveModules` (`build-JVmLFaZt.mjs:597-598`).
- `hash` (:1220-1224): default true, applied to chunk names.
- `cjsDefault` (:1226-1232): converts a single default export to `module.exports`.
- `dts` (:1302-1311): auto-enabled when `types` exists in package.json or tsconfig has `declaration: true`. For dual format, tsdown runs an extra "cjs dts" pass with `emitDtsOnly: true` (`build-JVmLFaZt.mjs:487-500`), which yields `.d.cts`. The observed `.d.cts` and `.d.mts` contents are identical (ESM syntax in both).
- `publint` (:1318-1323) and `attw` (:1324-1331, with `profile: 'strict' | 'node16' | 'esm-only'` and `level: 'error' | 'warn'` at :583-635).
- `exports` (:1343-1351, ExportsOptions :638-808): `devExports`, `packageJson`, `all`, `exclude`, `legacy` ("Defaults to `false` if only ESM builds are included, `true` otherwise"), `customExports`, `inlinedDependencies`, `extensions`, `bin`.
- `deps` (DepsConfig :84-137): `neverBundle`, `alwaysBundle` ("Force dependencies to be bundled, even if they are in `dependencies`, `peerDependencies`, or `optionalDependencies`", which implies those are external by default), `onlyBundle`, `onlyImport` ("Whitelist of packages that the emitted output is allowed to import... CJS `require` calls are not detected"), and `dts.neverBundle`.
- tsconfig is forwarded to rolldown: `tsconfig: tsconfig || void 0` (`build-JVmLFaZt.mjs:561`). This is how decorator settings reach oxc (§4).
- No option for emitting an "ESM wrapper that re-exports the CJS build" exists in the UserConfig typings (:963-1396). **UNVERIFIED** whether a plugin exists for it.

### 3.4 Prototype dual package (`$TP/proto`)

Entries `index`, `express`, `fastify`, `graphql` and `optional-require`; `format: ['esm','cjs']`, `dts: true`, `exports: true`, `publint: true`, `attw: {profile:'node16', level:'error'}`, `deps.neverBundle` for peers.

- Output: `dist/{index,express,fastify,graphql,optional-require}.{mjs,cjs,d.mts,d.cts}`, and the build ends with `✔ [attw] No problems found`, `✔ [publint] No issues found`.
- **tsdown rewrote `package.json`**. It added `main ./dist/index.cjs`, `module ./dist/index.mjs`, `types ./dist/index.d.cts`, and `exports` with `".": {"import":"./dist/index.mjs","require":"./dist/index.cjs"}` (the same for each subpath) plus `"./package.json"`.
  - **No `types` conditions are emitted**; TypeScript finds sibling `.d.mts`/`.d.cts` files.
  - The docs at https://tsdown.dev/options/package-exports say "review the generated exports before publishing... or enable publint" and don't describe the omission of `types`.
- Shared code between entries: in bundled mode it goes into a hashed chunk, e.g. `tokens-BcLp13Vl.mjs` / `tokens-4KrhwxMl.cjs`, and `express.mjs` does `import { i as registry } from "./tokens-BcLp13Vl.mjs"`. In `--unbundle` mode it becomes `tokens.mjs`/`tokens.cjs` plus `_virtual/_@oxc-project_runtime@0.149.0/helpers/esm/decorate{,Metadata,Param}.{mjs,cjs}`. Either way there is a single instance _within_ one format.

### 3.5 Other observed tsdown behaviour (`$TP/edge`)

- TLA in source with `cjs` format fails the build: `[UNSUPPORTED_FEATURE] Top-level await is currently not supported with the 'cjs' output format`.
- A bare `require("x")` in source, built as ESM on platform node, gets a shim: `var __require = (() => createRequire(import.meta.url))();`, and it works at runtime.
- `createRequire(import.meta.url)` in source becomes `createRequire(require("url").pathToFileURL(__filename).href)` in the CJS output (`proto/dist/optional-require.cjs`).
- `await import("x")` stays a native `import()` in the CJS output (`proto/dist/index.cjs:77`).

---

## 4. Decorators + `emitDecoratorMetadata` (critical for NestJS DI)

### 4.1 Experiment (`$TP/deco-exp`)

tsconfig: `experimentalDecorators: true, emitDecoratorMetadata: true, module/moduleResolution NodeNext, isolatedModules: true`. Classes: `Svc(dep: Dep, reflector: Reflector, @Inject(TOKEN) opts: Opts)`, `Guard(svc: Svc)`, and a method decorated with `@SetMetadata`.

- **tsdown 0.23.0 (rolldown 1.2.8) output**, `dist/index.cjs:51-75`:
  ```js
  __decorateMetadata("design:paramtypes", [
    typeof Dep === "undefined" ? Object : Dep,
    typeof _nestjs_core.Reflector === "undefined"
      ? Object
      : _nestjs_core.Reflector,
    Object,
  ]);
  ```
  The helpers come from `\0@oxc-project+runtime@0.149.0/helpers/esm/{decorate,decorateMetadata,decorateParam}.js`, and `design:type`/`design:returntype` are emitted for the method. Class names are preserved (`let Svc = class Svc {`).
- **Runtime**: `NestFactory.createApplicationContext(DecoModule)` worked from both builds. Output: `CJS: dep:1 paramtypes= [ 'Dep', 'Reflector', 'Object' ]` and `ESM: dep:1 paramtypes= [ 'Dep', 'Reflector', 'Object' ]`.
- **The transform is tsconfig-driven.**
  - With `emitDecoratorMetadata: false`: 0 `design:` occurrences.
  - With `experimentalDecorators` removed: the build **succeeds** but emits raw TC39 syntax (`var Dep = @Injectable() class {`, `constructor(dep, reflector, @Inject(TOKEN) opts)`), drops the type-only `Reflector` import, and `node dist-nodeco/index.mjs` fails with `SyntaxError: Invalid or unexpected token`.
- Rolldown's typings confirm the mapping:
  - `rolldown/dist/shared/binding-DZuNHVw4.d.mts:843-863` (`DecoratorOptions.legacy`, "Enables experimental support for decorators"; `emitDecoratorMetadata`, "it only works when `legacy` is true").
  - `:1561-1564` (`BindingCompilerOptions.experimentalDecorators` / `emitDecoratorMetadata`, read from tsconfig).
- tsdown 0.12.9, the repo's installed version, also emitted metadata (5 `design:` matches).
- **The `import type` pitfall**: `import type { Dep }` plus `constructor(dep: Dep)` makes oxc emit `design:paramtypes [Object]`, while tsc 5.9 emits `[Function]`. Both break DI at runtime, and tsc raised no error under `isolatedModules` (experiment `src2`).
- **Biome**: 2.5.12's `lint/style/useImportType` flags `import { Reflector } from "@nestjs/core"` in a decorated class with "Safe fix: Use import type", so `biome check --write` would apply it silently. `biome explain useImportType` says: "Since Biome doesn't know how a decorator is implemented, it is unable to detect that an import used as a type is also used as a value... We recommend disabling this rule when using such decorators."
  - The current repo already sets `"useImportType": "off"` (`$REPO/biome.json:31`) and `"unsafeParameterDecoratorsEnabled": true` (`:40`).
  - Biome also flags `noUnusedPrivateClassMembers` on injected-but-unused `private readonly` params, with an _unsafe_ fix that renames the parameter.
- TypeScript 7.0.2 tsc emits `__metadata("design:paramtypes", [Dep, ...])` (no `typeof` guard).
- rolldown-plugin-dts 0.28.5 selects its generator automatically: `'oxc'` for `isolatedDeclarations`, `'tsgo'` for TypeScript 7, and `'tsc'` otherwise (`.../rolldown-plugin-dts/dist/index.d.mts:22-32`). Its peers are `typescript ^5 || ^6 || ~7.0.0` and `@typescript/native-preview`.

### 4.2 Options if the bundler could not emit metadata (it can; these are fallbacks)

- **unplugin-swc 1.6.0** (the repo uses ^1.5.9): its default export has keys `esbuild,rollup,vite,rolldown,webpack,...`, so `swc.rolldown()` exists. **UNVERIFIED** end to end inside tsdown.
- **tsc for emit**: TS 5.9, 6.0 and 7.0 all emit metadata (verified for 5.9 and 7.0).
- **Explicit `@Inject(X)` on every constructor parameter**: this is the reference's approach, since its esbuild pipeline has no metadata (§8).

### 4.3 Test runner

- **vitest 5.0.0 with vite 8.2.2** resolved Nest DI from TS source with **no unplugin-swc** (`$TP/deco-exp/test/di.test.ts`, 1 passed). Flipping `emitDecoratorMetadata: false` produced `Nest can't resolve dependencies of the Svc (?, +, Symbol(deco-exp:token))`, so it is tsconfig-driven.
- vitest 5 peers `vite: ^6.4.0 || ^7.0.0 || ^8.0.0` and has engines `^22.12.0 || ^24.0.0 || >=26.0.0`.
- **UNVERIFIED**: vite 6/7 (esbuild) with vitest 5 would _not_ emit metadata. esbuild is known not to support `emitDecoratorMetadata`; the reference's and this repo's `unplugin-swc` setups exist for that reason, but I did not test vite 7 directly.
- The current repo uses vitest ^3.2.4 with `unplugin-swc` (`$REPO/vitest.config.ts:1,9`).
- The Nest 12 ESM template uses vitest ^4.1.2 without swc (§2.1).

---

## 5. Dual-package hazard

### 5.1 What Node says

Node's publishing guide (https://nodejs.org/en/learn/modules/publishing-a-package):

- "`instanceof` comparison of instances created by the two copies returns `false`".
- "If the package is in any way stateful, consuming both the CJS and ESM distributions will result in parallel states".
- "It's generally best to publish only 1 format". For dual distribution it recommends routing `"node"` → CJS and `"default"` → ESM, which "precludes the dual-package hazard".
- It warns that `"type": "module"` plus a `.js` CJS file under `require` fails; use `.cjs`.

`module-sync` condition (https://nodejs.org/api/packages.html): "matches no matter the package is loaded via `import`, `import()` or `require()`. The format is expected to be ES modules that does not contain top-level await...". Conditions should go from most to least specific, with `types` first and `default` last.

### 5.2 Reproduction under NestJS 11 (`$TP/consumer/hazard.mjs`)

An ESM consumer imports `proto-lib` (resolving to `dist/index.mjs`) and also `createRequire(...)("proto-lib")` (resolving to `dist/index.cjs`):

```
same AuthModule class across copies? false
Symbol() token equal? false
Symbol.for token equal? true
string token equal? true
module-level registry shared? false
optional peer (Nest11 CJS) same class via import() vs createRequire()? true
[esm token baseline] -> OK /api/auth
[cjs Symbol() token] -> FAIL UnknownDependenciesException: Nest can't resolve dependencies of the Consumer (?). Please make sure that the argument Symbol(proto:auth-options) ...
[cjs Symbol.for token] -> OK /api/auth
[cjs string token] -> OK /api/auth
[cjs class token AuthService] -> FAIL UnknownDependenciesException: ... the argument AuthService at index [0] ...
```

- Metadata keys (`$TP/consumer/metakey.mjs`): metadata written under one copy's `Symbol("BEFORE_HOOK")` returns `undefined` when read with the other copy's key, so it is **silently not discovered**. `Symbol.for("nsba:before-hook")` works across copies.
- **Class identity cannot be fixed with `Symbol.for`**. Two `AuthModule` classes are two Nest modules: global providers such as `APP_GUARD`, and middleware or route registration, could run twice. The `APP_GUARD` double-registration consequence is inferred and **UNVERIFIED**.
- Current code at risk: `$REPO/src/symbols.ts:1-4` (`Symbol('BEFORE_HOOK')`, `Symbol('AFTER_HOOK')`, `Symbol('HOOK')`, `Symbol('AUTH_MODULE_OPTIONS')`), `$REPO/src/auth-module-definition.ts:29` (`MODULE_OPTIONS_TOKEN = Symbol('AUTH_MODULE_OPTIONS')`), and the same in the reference (`$REF/src/auth-module-definition.ts:58`).

### 5.3 How Nest and its ecosystem handle it

- Nest ships **one format per major**: 11 is CJS and 12 is ESM (§2.2). Instance identity across `import` and `require` was verified for both.
- Nest's framework tokens are strings: `APP_GUARD = 'APP_GUARD'` (`$X/nestjs-core-11.2.3/package/constants.js:14`; `$X/nestjs-core-12.0.1/package/constants.js:11`).
- `ConfigurableModuleBuilder` uses the provided `optionsInjectionToken`. Otherwise it builds a deterministic string from `moduleName`, or a _random_ string `CONFIGURABLE_MODULE_OPTIONS[${hash}]` (`$X/nestjs-common-11.2.3/package/module-utils/configurable-module.builder.js:84-96`; `.../utils/generate-options-injection-token.util.js:5-8`). The random string would also diverge across two copies.
- reflect-metadata 0.2.2 shares one registry through `Symbol.for("@reflect-metadata:registry")` on the global `Reflect` (`$TP/consumer/node_modules/reflect-metadata/Reflect.js:83`, :994-1001), so multiple copies interoperate.
- Dual packages in Nest's graph route Node to CJS:
  - rxjs 7.8.2: `".": {"node":"./dist/cjs/index.js","types":...,"es2015":...,"default":"./dist/esm5/index.js","require":"./dist/cjs/index.js"}`.
  - graphql 17.0.2: `".": {"default": {"bun":"./index.mjs","node":"./index.js",...,"module-sync":"./index.mjs"}, ...}`, so Node matches `node` → CJS first.
  - graphql 16.14.2 has no `exports`, so Node always uses `main` (CJS).

### 5.4 Mitigations verified (`$TP/consumer/variants/*`, `probe.mjs` loads via both `import` and `require`)

| Variant                 | Exports shape                                                                                                                 | 20.18.3                             | 20.19.0  | 22.11.0                             | 22.12.0  | 22.22.0         | 26.7.0   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------- | ----------------------------------- | -------- | --------------- | -------- |
| A: `module-sync` first  | `{"module-sync":{types:.d.mts,default:.mjs},"import":{...mjs},"require":{types:.d.cts,default:.cjs}}`                         | import→mjs, require→**cjs** (split) | both→mjs | import→mjs, require→**cjs** (split) | both→mjs | both→mjs        | both→mjs |
| B: `node`→CJS           | `{"node":{"import":{types,default:.cjs},"require":{types:.d.cts,default:.cjs}},"default":{.mjs}}`                             | both→cjs                            | n/t      | n/t                                 | n/t      | both→cjs        | n/t      |
| C: ESM wrapper over CJS | `{"import":{default:"./dist/wrapper.mjs"},"require":{default:.cjs}}`, where `wrapper.mjs` = `export {...} from "./index.cjs"` | single instance                     | n/t      | n/t                                 | n/t      | single instance | n/t      |

(n/t = not tested.)

- For B, cjs-module-lexer detected every named export of tsdown's CJS output (`AUTH_OPTIONS, ..., AuthModule, AuthService, default, loadWsExceptionViaImport, registry`), so `import { AuthModule }` works.
- attw and publint on each variant:
  - A: attw "No problems found", with all green including node10. publint suggests only `engines`.
  - B: with `.d.mts` types under `node.import`, attw reports **👺 "Masquerading as ESM" (FalseESM)** and publint reports the error `pkg.exports["."].node.import.types types is interpreted as ESM ... use the .cts extension`. After pointing the types at `.d.cts`, attw is all green ("node16 (from ESM) 🟢 (CJS)") and publint says "All good!".
  - C: attw no problems; publint suggestion only.
- Trade-offs (facts):
  - A is hazard-free exactly on require(esm)-capable Node, the same set that can load better-auth from CJS at all. Older Node falls back to CJS, and our CJS build's `require("better-auth/...")` would fail there anyway.
  - B and C are hazard-free on all Node versions, but every Node consumer runs the CJS build. That build still needs require(esm) for better-auth and Nest 12, and TLA is impossible in it.
  - For B, bundlers pick `default` (ESM).
  - **UNVERIFIED** whether webpack (`nest build --webpack`) and esbuild honour `module-sync`. Jest 30.4+ does, per its docs.

### 5.5 Cross-subpath identity

Within one format, subpath entries share chunks (§3.4), so `pkg` and `pkg/express` share one `tokens` instance. Mixing formats across subpaths (e.g. `import "pkg"` with `require("pkg/express")`) has the same hazard as §5.2. This is inferred from §5.2 plus the chunk layout; the specific cross-subpath case was not tested.

---

## 6. Optional peer dependencies: lazy-loading patterns valid in both outputs

Experiments are in `$TP/proto` (built) and `$TP/consumer` / `$TP/nest12` (run).

### 6.1 Patterns and observed behaviour

| Pattern                                                                                      | ESM output                                                                                  | CJS output                                                     | Sync?      | Verified                                                                                                                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `await import("peer")`**                                                                | native `import()`                                                                           | native `import()` kept (`index.cjs:77`)                        | async only | Nest 11 and 12; `WsException` loaded from both builds                                                                                       |
| **B. `createRequire(import.meta.url)("peer")`**                                              | as written                                                                                  | `createRequire(require("url").pathToFileURL(__filename).href)` | sync       | ESM build loaded ESM-only `@nestjs/websockets` 12 via require(esm) on 22.22. For Nest 11 the class was identical to the one from `import()` |
| **C. Separate subpath entry with a static import** (`pkg/graphql` imports `@nestjs/graphql`) | `import { GqlExecutionContext } from "@nestjs/graphql"`                                     | `require("@nestjs/graphql")`                                   | sync       | builds; attw/publint green                                                                                                                  |
| D. bare `require("peer")` in source                                                          | tsdown injects a `createRequire` shim (§3.5)                                                | plain `require`                                                | sync       | works, but is hidden magic. This is the bug that bit the reference under unbuild (§8)                                                       |
| E. top-level await                                                                           | allowed, but breaks `require()` of our ESM build with `ERR_REQUIRE_ASYNC_MODULE` (verified) | **build error** (§3.5)                                         | n/a        | yes                                                                                                                                         |

### 6.2 First-party precedent (Nest 12, ESM-only)

- `@nestjs/common/utils/load-package.util.js:1-54` (12.0.1):
  - `loadPackage()` does `await import(packageName)` with a module-level cache.
  - `loadPackageSync()` does `createRequire(import.meta.url)(packageName)`, "meant for optional dependencies that must be loaded in synchronous contexts". It accepts `loaderFn` "so bundlers can statically analyse the string literal".
  - A cached getter serves sync access after an async preload.
- `@nestjs/core/helpers/optional-require.js:1-8` (12.0.1): `await import(packageName)` with a `{}` fallback.
- Nest 11's `loadPackage` is a plain `require(packageName)` (`$X/nestjs-common-11.2.3/package/utils/load-package.util.js`).

### 6.3 Peer-format matrix (npm, Sept 2026)

- **CJS**: `express@5.2.1`, `fastify@5.12.3`, `@nestjs/platform-fastify@11.2.3`, `@nestjs/graphql@13.4.5`, `graphql@16.14.2` (no exports).
- **ESM-only**: `@nestjs/{common,core,platform-express,platform-fastify,websockets}@12.0.1`, `@nestjs/graphql@14.0.0`, `@nestjs/apollo@14.0.0`.
- **Dual with `node`→CJS routing**: `graphql@17.0.2` (engines `^22 || ^24 || ^25 || >=26`).
- `@nestjs/graphql` 13.4.5 and 14.0.0 both peer `graphql: "^16.11.0 || ^17.0.0"`. The current repo's peer is `graphql ^16.11.0` only (`$REPO/package.json:72`).

### 6.4 Constraints for either output

- `require` is undefined in real ESM. `import.meta` is invalid syntax in CJS, though tsdown shims it (§3.3).
- Sync contexts such as guards' error mapping cannot use `import()` without going async. The reference paid that cost: its error factories became `async` (§8). Nest's precedent is to preload asynchronously, then read from a cache synchronously.
- Subpath entries keep optional peers out of the core graph statically. tsdown `deps.onlyImport` can enforce an allow-list of imported packages, but it applies per config, not per entry (types :115-125).

### 6.5 Subpath exports and tsdown entries

- An `entry` object key becomes the dist filename and the generated export key: `express: "src/platform/express.ts"` produces `"./express": {"import":"./dist/express.mjs","require":"./dist/express.cjs"}`.
- The `node10` resolution column fails for every subpath (attw strict profile: "💀 Resolution failed"). The `node16` profile marks it "ignored". Supporting TS `moduleResolution: node10` consumers would need `typesVersions` or real directories. TS 6 deprecates node10 and TS 7 removes it (§2.4).
- Consumer check (`$TP/consumer/tscheck`, TS 6.0.3): `commonjs + node10 + ignoreDeprecations 6.0` raised `TS2307: Cannot find module 'proto-lib/express'`, while the root entry resolved.

---

## 7. Verification tooling

### 7.1 publint 0.3.24

- Lints `package.json` against the packed file set.
- Rule list (https://publint.dev/rules):
  - Errors include `EXPORTS_TYPES_SHOULD_BE_FIRST`, `EXPORTS_DEFAULT_SHOULD_BE_LAST`, `EXPORTS_TYPES_INVALID_FORMAT`, `EXPORTS_MODULE_SHOULD_BE_ESM`, `FILE_DOES_NOT_EXIST`, `FILE_NOT_PUBLISHED`, `FILE_INVALID_FORMAT` (a warning) and `LOCAL_DEPENDENCY`.
  - Warnings include `CJS_WITH_ESMODULE_DEFAULT_EXPORT` and `TYPES_NOT_EXPORTED`.
  - Suggestions include `USE_ENGINES_NODE`, `USE_TYPE` and `USE_SIDE_EFFECTS`.
- CLI: `publint run --strict [dir]`. It packs with the detected package manager; better-auth uses `--pack false`.
- It catches FalseESM-style type format errors (§5.4 B), but does not resolve the graph.

### 7.2 @arethetypeswrong/cli 0.18.5 (core 0.18.5)

- Packs the package, then resolves every entrypoint under node10, node16-from-CJS, node16-from-ESM and bundler using its bundled TypeScript. The version banner printed `typescript: v5.6.1-rc`.
- Problem kinds (tsdown's `AttwOptions.ignoreRules`, types :609-634): `no-resolution`, `untyped-resolution`, `false-cjs`, `false-esm`, `cjs-resolves-to-esm`, `fallback-condition`, `cjs-only-exports-default`, `named-exports`, `false-export-default`, `missing-export-equals`, `unexpected-module-syntax`, `internal-resolution-error`.
- CLI (https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/packages/cli/README.md): `attw --pack .` or `attw file.tgz`; `--profile strict|node16|esm-only` ("node16 ignores node10 resolution failures"); `--ignore-rules`; `--format table|table-flipped|ascii|json|auto`; `--entrypoints` / `--include-entrypoints` / `--exclude-entrypoints`; and `.attw.json`.
- Running on a bare directory without `--pack` errors: "Specifying a directory requires the --pack option".

### 7.3 CI wiring options (facts)

- (a) In the tsdown config (`publint: true, attw: { profile: 'node16', level: 'error' }`) with `publint` and `@arethetypeswrong/core` installed. This ran post-build in the prototype.
- (b) As separate scripts, as in better-auth (`publint run --strict --pack false`; `attw --profile esm-only --pack .`, at `$BA/packages/better-auth/package.json:32-33`).

### 7.4 Gaps these tools leave (observed)

- attw only analyses our own files. It reported green for `proto-lib/express`, whose `.d.cts` imports `better-auth/node` types; the transitive better-auth types were never checked.
- A real consumer type-check (`$TP/consumer/tscheck`, TS 6.0.3):
  - CJS + `nodenext` + `skipLibCheck`: exit 0.
  - Without `skipLibCheck`, CJS or ESM, `nodenext` or `bundler`: 3 errors, all inside better-auth's own published types: `@better-auth/core/dist/types/init-options.d.mts(15,26): TS2307 'bun:sqlite'`, `(17,28): TS2307 '@cloudflare/workers-types'`, `@better-fetch/fetch/dist/index.d.ts(742,19): TS2304 'Timer'`.
  - CJS + `node16`: TS1479 only on the direct `better-auth` import; our dual package resolved.
  - `commonjs` + `bundler`: exit 0.
  - node10: subpath not found.
- Runtime identity and dual-load checks (§5), a Node-version matrix (§1.4, §5.4) and Nest 11/12 runs (§2.2, §7.5) are not covered by either tool.

### 7.5 End-to-end runtime checks done

- The prototype's CJS build under **Nest 12** from a CJS consumer on 22.22.0: `CJS consumer + Nest 12.x -> /api/auth | resolved: index.cjs`, and `import()` of the optional peer from the CJS build works.
- The ESM build from an ESM consumer under Nest 12: `-> /api/auth | resolved: index.mjs`.
- On Node 20.18.3, the CJS consumer failed at `require("@nestjs/core")` with `ERR_REQUIRE_ESM`: the Nest 12 floor, independent of us.

---

## 8. How the reference ships, and the ESM/CJS issues visible there

- `$REF/package.json`:
  - :11-13 `"engines": {"node": ">=22.22.1"}`
  - :21 `"type": "module"`
  - :34 `"types": "dist/index.d.ts"`
  - :35-41 `exports["."] = {types: ./dist/index.d.mts, import: ./dist/index.mjs, default: ./dist/index.mjs}`, with no `require`
  - :52-59 devDeps on `@nestjs/* ^12.0.1`
  - :78-88 peers `@nestjs/common|core ^11.1.6 || ^12.0.0`, `@nestjs/graphql ^13.1.0 || ^14.0.0`, `better-auth >=1.5.0 <2.0.0`, `typescript ^5.9.2 || ^6.0.0`, `qs`/`express`/`graphql` (optional)
- `$REF/build.config.ts:3-14`: unbuild with `declaration: true`, `rollup.emitCJS: false`, and `esbuild.tsconfigRaw.compilerOptions.experimentalDecorators: true`, with **no `emitDecoratorMetadata`**.
- Published tarball (`npm pack @thallesp/nestjs-better-auth@2.8.0`): files `dist/index.d.mts`, `dist/index.d.ts`, `dist/index.mjs`, LICENSE, package.json, README.md.
  - `grep -c "design:" dist/index.mjs` → **0**. Consequently the source uses explicit `@Inject` for every constructor param: `$REF/src/auth-module.ts:93-101` (`ApplicationConfig`, `DiscoveryService`, `MetadataScanner`, `HttpAdapterHost`, `MODULE_OPTIONS_TOKEN`), `auth-guard.ts:127-129`, and `auth-service.ts:14`. In dist these appear as `__decorateParam(n, Inject(...))` at lines 121, 430-431 and 988-992.
- Deep imports of Nest internals in dist: `import { normalizePath } from '@nestjs/common/utils/shared.utils.js'` and `import { mapToExcludeRoute } from '@nestjs/core/middleware/utils.js'` (dist/index.mjs:6-7).
  - The files exist in both 11.2.3 and 12.0.1, and Nest 12's `"./*.js"` export keeps them resolvable.
  - Nest 12 adds `./internal` entry points marked "Internal module - not part of the public API... Do not depend on these in your application code" (`$X/nestjs-core-12.0.1/package/internal.js:1-7`; `$X/nestjs-common-12.0.1/package/internal.js:1-7`). `@nestjs/common/internal` re-exports `./utils/shared.utils.js`.
- Optional peers:
  - `await import("@nestjs/graphql")` (`$REF/src/utils.ts:10`) and `await import("@nestjs/websockets")` (`$REF/src/auth-guard.ts:70`).
  - `createRequire(import.meta.url)` for `express` (`$REF/src/middlewares.ts:2,9,60`) and `qs` (`$REF/src/fastify-body-parser.ts:24,165`).
- History, from `git log` in `$REF`:
  - `36aea7c` (2026-02-16) "fix(build): migrate to ESM-only": added `emitCJS: false`, removed `main ./dist/index.cjs` and `require`.
  - `63887b3` (2026-02-22) "fix!: transform require statements into import statements for ESM support": replaced `require("graphql")` and `require("@nestjs/websockets")` with `await import(...)`. The error factories in `AuthContextErrorMap` became `async (args) => ...` (breaking), and GraphQL errors switched from `GraphQLError` to `UnauthorizedException`/`ForbiddenException`.
  - `f52d702` (2026-03-08) re-added a CJS entry, then `cd951b9` (same day) dropped it again and added a vitest pre-step that compiles `src` to `.vitest-cjs` via `@swc/core` (`legacyDecorator`, `decoratorMetadata`, `module: commonjs`) and resolves test imports there (`$REF/vitest.config.ts:45-125`). This validates SWC-compiled source, **not** the published unbuild `dist`.
  - `54b2db3` and `326425e` raised the Node engines floor.
  - `de6ccd6` and `3ff2e30` made `@nestjs/graphql` and `@nestjs/websockets` optional.
  - `13008ea` (2026-08-31) widened peers to Nest 12 with "No source changes were needed".
- Oddities:
  - Top-level `types: dist/index.d.ts` vs. `exports.types: ./dist/index.d.mts`. Both files exist, so this is harmless.
  - A runtime library declares `typescript` as a peer dependency (the current repo does too: `$REPO/package.json:73` `"typescript": "^5.9.2"`). That peer range excludes TS 6/7 for the current repo, and TS 7 is npm `latest`.

---

## 9. Design implications (for the design team; not decisions)

1. The effective Node floor for any consumer is require(esm): `^20.19.0 || >=22.12.0`. Node 20 is EOL. Setting `engines.node` also sets tsdown's default `target` (§3.3).
2. If dual output is kept, pick an explicit hazard strategy. The verified options are `module-sync`-first (ESM canonical), `node`→CJS, or an ESM wrapper over CJS (§5.4). Plain `import`/`require` routing leaves the §5.2 failures possible.
3. Independent of routing, make identity-sensitive values copy-safe:
   - DI tokens and metadata keys: `Symbol.for("<pkg>:<name>")` or namespaced strings. Never `Symbol()` or the random `ConfigurableModuleBuilder` default.
   - Avoid module-level mutable singletons; keep state in Nest providers.
   - Avoid `instanceof` against our own classes across the package boundary.
   - Class tokens (`AuthModule`, `AuthService`, guards) remain hazard-prone unless routing guarantees a single copy.
4. Keep `experimentalDecorators` and `emitDecoratorMetadata` in the exact tsconfig tsdown reads, and add a build assertion that dist contains `design:paramtypes`, or run a smoke test that boots Nest from `dist`. A missing flag passes the build and crashes at runtime (§4.1). Alternatively, use explicit `@Inject()` everywhere so correctness doesn't depend on metadata; that is the reference's approach.
5. Keep Biome `style/useImportType` off, or scope it away from decorated classes, because its "safe fix" breaks DI (§4.1).
6. Load optional peers only via subpath entries (static import), `import()` with a cache, or `createRequire(import.meta.url)`. Mirror Nest 12's `loadPackage`/`loadPackageSync` pattern (§6.2). No TLA anywhere.
7. Map new platforms, transports and strategies to subpath entries (`/express`, `/fastify`, `/graphql`, ...). tsdown turns entries into export keys (§6.5), and shared code becomes one chunk per format (§3.4).
8. Upgrading tsdown to 0.23 changes output extensions to `.mjs`/`.cjs` + `.d.mts`/`.d.cts` (fixedExtension). Either regenerate the exports with `exports: true` (which rewrites package.json and omits `types` conditions) or hand-author them with custom conditions and verify with publint and attw (§3.2-3.4).
9. CI should run:
   - publint `--strict`;
   - attw `--profile node16`, or `strict` plus `typesVersions`;
   - a consumer type matrix (CJS nodenext, ESM nodenext, bundler, node16) with `skipLibCheck: true`, since better-auth's types require it;
   - runtime smoke tests that install the packed tarball into Nest 11 CJS, Nest 11 ESM and Nest 12 ESM fixtures on Node 20.19, 22.12 and 24/26;
   - a dual-load identity test (§5.2).
10. Vitest 5 on Vite 8 needs no unplugin-swc (§4.3), which lets the repo drop the SWC test transform. That depends on Vite 8 being the resolved peer.
11. Don't sniff versions via `@nestjs/*/package.json` on Nest 12 (§2.2). Prefer public APIs over deep imports of Nest internals (§8).
12. Revisit peer ranges: `graphql ^16.11 || ^17`, `@nestjs/graphql ^13 || ^14`, Nest `^11 || ^12`, and whether `typescript` should be a peer at all given that TS 7 is `latest`.

## 10. Pitfalls (observed)

- tsdown with no `experimentalDecorators` in the resolved tsconfig: the build succeeds but outputs raw `@Decorator` syntax, giving `SyntaxError` at load (§4.1).
- `import type` of an injected class gives `design:paramtypes: [Object]` (oxc) or `[Function]` (tsc), a runtime DI failure (§4.1).
- Biome `useImportType` offers a "safe fix" that breaks DI; `noUnusedPrivateClassMembers` flags injected params (§4.1).
- `Symbol()` DI tokens and metadata keys diverge across dual copies. Metadata failures are silent (§5.2).
- tsdown 0.23 changed defaults from 0.12.9 (`fixedExtension`), so the existing exports map would break (§3.2).
- tsdown-generated exports have no `types` conditions and no node10 subpath support (§3.4, §6.5).
- The `node`→CJS routing with `.d.mts` types under `import` gives attw FalseESM and a publint error (§5.4).
- TLA: the CJS build fails, and `require()` of the ESM build gives `ERR_REQUIRE_ASYNC_MODULE` (§3.5, §6.1).
- Jest CJS cannot load better-auth or Nest 12 without Node 24.9+ and `--experimental-vm-modules`, whatever we ship (§2.5).
- Node 22.12.0 emits an ExperimentalWarning on require(esm); 22.13.0+ does not (§1.4, §2.3).
- better-auth publishes a `dev-source` export condition pointing to an unshipped `src/`. Don't enable a condition with that name in shared tooling (§1.2).
- better-auth's types need `skipLibCheck` (§7.4).
- `@nestjs/core/package.json` is not resolvable on Nest 12 (§2.2).
- TS 7's `typescript` package has no classic JS API. Keep TS 6.x as the devDependency for tools that need it, or configure rolldown-plugin-dts's generator explicitly (§2.4, §4.1).

## 11. Open questions for the user

1. Which Node floor: `^20.19.0 || >=22.12.0` (the require(esm) minimum), `>=22.12.0` (Node 20 is EOL), or the reference's `>=22.22.1`?
2. Which dual-package strategy: `module-sync`-first, `node`→CJS, an ESM wrapper, or plain `import`/`require` plus copy-safe tokens while accepting class-identity risk? And is the CJS artifact expected to serve Node versions below the require(esm) line (it can't, because of better-auth)?
3. Must Jest CJS users be supported? They need Node 24.9+ with `--experimental-vm-modules` or transform configuration, and no packaging choice on our side removes that.
4. Support TS `moduleResolution: node10` (deprecated in TS 6, removed in TS 7) for subpaths via `typesVersions`, or declare it unsupported?
5. Use tsdown `exports: true` (it rewrites package.json) or hand-maintain `exports` and verify with publint/attw?
6. Should `typescript` remain a peer dependency? If so, with what range (TS 7 is `latest`)?
7. Peer ranges for graphql 17 and `@nestjs/graphql` 14, and whether to support Nest 11 and 12 in one release line.

## Appendix: experiment index

- `$TP/req-esm/test.cjs`: `require()` of better-auth subpaths across Node versions.
- `$TP/node-bins/`: Node 20.18.3, 20.19.0, 22.11.0, 22.12.0 binaries.
- `$TP/deco-exp/`: tsdown 0.23.0 decorator and metadata builds (`dist`, `dist-nometa`, `dist-nodeco`, `dist-src2`, `dist-0129`), runtime checks `run.cjs`/`run.mjs`, tsc 5.9 and 7 emits (`tsc-src2`, `tsc7-out`), the Biome test (`biome-test/`), and the vitest 5 test (`test/di.test.ts`).
- `$TP/ts-cjs/`: TS 5.9 and 6.0 emit matrix for CJS importing ESM-only better-auth.
- `$TP/ts7/`: TypeScript 7.0.2 install.
- `$TP/jest-cjs/`: jest 30.5.1 CJS matrix.
- `$TP/nest12/`: Nest 12 `require()` matrix, instance identity, and `app.cjs`/`app.mjs` end-to-end runs.
- `$TP/proto/`: the prototype dual package, built by tsdown with generated exports, publint and attw.
- `$TP/consumer/`: `hazard.mjs`, `metakey.mjs`, `same11.mjs`, the `variants/{module-sync,node-cjs,wrapper}` probes, and `tscheck/` for the consumer type matrix.
- `$TP/edge/`: TLA and bare-`require` behaviour.
- `$TP/nestnew/app12/`: a real `nest new` output from CLI 12.0.0 (ESM).
- `$TP/tarballs/`: published tarballs for better-auth, @better-auth/core, @nestjs/core and common (11.2.3 and 12.0.1), @nestjs/schematics (11.1.0 and 12.0.0), tsdown 0.23.0 and @thallesp/nestjs-better-auth 2.8.0.
