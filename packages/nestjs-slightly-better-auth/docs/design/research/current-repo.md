# Research: inventory of the current repo (`nestjs-slightly-better-auth`)

Scope: what exists in `/Users/thilllon/git/nestjs-slightly-better-auth` today, whether it builds and tests, how it differs from the reference library, and which tests are worth keeping as behavioral specs.

Research date: 2026-09-10. The original repo was not modified. Every build, test, typecheck, and lint run happened on byte-exact copies under `scratchpad/tmp-current-repo/`:

- `wt/` is the working tree, uncommitted changes included.
- `head/` is `git archive HEAD` plus the same `node_modules`.
- `head-fixed/` is the HEAD copy with two small fixes, described in Q2.

Abbreviations:

- `SP` = `/private/tmp/claude-502/-Users-thilllon-git-nestjs-slightly-better-auth/d03cce33-4991-442c-88b5-c314fe7f3223/scratchpad`
- `REPO` = `/Users/thilllon/git/nestjs-slightly-better-auth`
- `REF` = `$SP/ref` (upstream `@thallesp/nestjs-better-auth`; clone HEAD is v2.8.0 at 99d4a94)

---

## 0. Headline findings (TL;DR)

1. **The current repo is a copy of upstream v2.4.0, not v2.8.0.** At commit `4a3dd2f`, `src/` and `tests/` are byte-identical to upstream tag **v2.4.0** (commit `9554855`, 2026-02-08):
   - src tree hash `874febc99c38546bf02cf38cd9679874e931db48`, tests tree hash `121479b0a296f3af06bde223cb405208f64cf76c`. Both match `git -C $REF rev-parse v2.4.0:src` and `v2.4.0:tests`.
   - `biome.json`, `tsconfig.json`, `vitest.config.ts`, and all four workflow files were also byte-identical at `4a3dd2f` (blob hashes compared).
   - Commit `8004ff1` changed only tooling: bun/unbuild were replaced by pnpm/tsdown.
   - So almost every difference from `REF` (v2.8.0) is upstream evolution the fork never received, not local work.
2. **The only semantic source change the fork has ever made is uncommitted, and it breaks the library.** The working tree removes `.setClassMethodName("forRoot")` from `src/auth-module-definition.ts` (HEAD line 31).
   - `AuthModule.forRoot()` now throws `TypeError: (intermediate value).forRoot is not a function`.
   - The inherited static methods become `register`/`registerAsync`.
   - All 7 test files fail. `tsc` reports TS2339.
   - Everything else in the working tree is formatting, doc comments, or a type-only change.
3. **The committed build "succeeds" (exit 0) but the package is not usable:**
   - (a) tsdown 0.12.9 resolved rolldown `1.0.0-rc.9` (tsdown declares `^1.0.0-beta.19`). The build emits hashed declaration files (`index-DhKji9Jf.d.ts`, `index-DYD7L77y.d.cts`), so `package.json`'s `types`/`exports.*.types` point at files that do not exist. publint reports 3 errors; attw reports "No types" in all 4 resolution modes. Root cause confirmed: pinning rolldown to `1.0.0-beta.29` makes tsdown 0.12.9 emit `index.d.ts`/`index.d.cts`.
   - (b) The ESM build cannot be imported with better-auth 1.5.5: `SyntaxError: The requested module 'better-auth/plugins' does not provide an export named 'createAuthMiddleware'`. The CJS build loads, but hook registration crashes.
   - (c) `package.json` has **no `version`**, so `pnpm pack`, `npm pack`, and `pnpm publish` all fail.
4. **Tests at HEAD: 6 of 7 files fail, 10 tests pass, 2 skipped.**
   - Five files fail on `Cannot find package 'rxjs'`. pnpm's strict layout does not expose rxjs; upstream used bun's hoisted layout.
   - The hooks suite fails on `createAuthMiddleware is not a function`.
   - With two small fixes (make `rxjs` resolvable; import `createAuthMiddleware` from `better-auth/api`), **all 36 tests pass on better-auth 1.5.5 and also on 1.7.4** (Express only, Nest 11.1.17).
5. **The test harness is Express-only.**
   - Every suite uses `new ExpressAdapter()` with `bodyParser: false`.
   - GraphQL runs on Apollo (express5 integration). WebSockets run on socket.io.
   - Authentication always uses the better-auth `bearer()` plugin (`Authorization: Bearer`), never cookies. Storage is better-auth's in-memory adapter.
   - Upstream later added an adapter switch (`TEST_HTTP_ADAPTER=express|fastify`, `tests/shared/http-adapter.ts`) and a CI matrix.

---

## Q1. Tooling to preserve

### 1.1 `package.json` (working tree; the HEAD differs only in name/description)

Cited from `REPO/package.json`:

- Identity:
  - `name` is `nestjs-slightly-better-auth` in the working tree; HEAD has `nestjs-much-better-auth` (`git diff` hunk on package.json).
  - `author` `thilllon`, `license` `MIT`, `"type": "module"` (L11), `"packageManager": "pnpm@10.32.1"` (L12).
  - **No `version` field.** Commit `8004ff1` deleted `"version": "0.0.1"` (`git show 8004ff1 -- package.json`).
  - No `repository`, `engines`, `sideEffects`, or `publishConfig`.
- `scripts` (L13-20):

  | Script    | Command          |
  | --------- | ---------------- |
  | `build`   | `tsdown`         |
  | `prepack` | `pnpm run build` |
  | `lint`    | `biome lint`     |
  | `format`  | `biome format`   |
  | `check`   | `biome check`    |
  | `test`    | `vitest`         |

  There is no typecheck script (no `tsc --noEmit` anywhere), no coverage script, and no changeset or release script.

- Entry points (L21-35):
  - `"types": "./dist/index.d.ts"`, `"main": "./dist/index.cjs"`, `"module": "./dist/index.js"`.
  - `exports["."]`: `import` → `{ types: ./dist/index.d.ts, default: ./dist/index.js }`; `require` → `{ types: ./dist/index.d.cts, default: ./dist/index.cjs }`.
  - `"files": ["dist"]`.
- `devDependencies` (L39-64):
  - `@apollo/server ^5.4.0`, `@as-integrations/express5 ^1.1.2`, `@biomejs/biome 2.2.4`, `@faker-js/faker ^10.3.0`
  - `@nestjs/apollo ^13.2.4`, `@nestjs/graphql ^13.2.4`, `@nestjs/platform-express ^11.1.17`, `@nestjs/platform-socket.io ^11.1.17`, `@nestjs/testing ^11.1.17`, `@nestjs/websockets ^11.1.17`
  - `@swc/cli ^0.7.10` (unused by any script), `@swc/core ^1.15.18`, `@tsconfig/node22 ^22.0.5`
  - `@types/express ^5.0.6`, `@types/supertest ^6.0.3`, `@vitest/coverage-v8 ^3.2.4` (not wired up)
  - `graphql ^16.13.1`, `reflect-metadata ^0.2.2`, `socket.io ^4.8.3`, `socket.io-client ^4.8.3`, `supertest ^7.2.2`
  - `tsdown ^0.12.5`, `unplugin-swc ^1.5.9`, `vitest ^3.2.4`
  - **Missing:** `rxjs` (imported by `tests/shared/test-gateway.ts:7`), `@types/body-parser` (type-imported by `src/middlewares.ts:4`), and anything for Fastify. `better-auth`, `@nestjs/common`, `@nestjs/core`, and `express` are not devDependencies; they are installed only through pnpm `autoInstallPeers` (`pnpm-lock.yaml` L3-4 `autoInstallPeers: true`; importers `dependencies` L10-25 resolve `better-auth` to **1.5.5**).
- `peerDependencies` (L65-74):
  - `@nestjs/common ^11.1.6`, `@nestjs/core ^11.1.6`, `@nestjs/graphql ^13.1.0`, `@nestjs/websockets ^11.1.6`
  - `better-auth >=1.3.8 <2.0.0`, `express ^5.1.0` (**required, not optional**), `graphql ^16.11.0`, `typescript ^5.9.2` (a required peer, which is unusual for a runtime library)
  - Optional (`peerDependenciesMeta` L75-85): `@nestjs/graphql`, `@nestjs/websockets`, `graphql`.
  - Upstream moved to `better-auth >=1.5.0` when it fixed the `createAuthMiddleware` import (upstream commits `ab3aa62`, `b1b4bac`). The fork's `>=1.3.8` range claims support for versions the code does not handle correctly.
- Installed versions in `REPO/node_modules` (checked through each package's package.json):

  | Package                                                     | Version                                                        |
  | ----------------------------------------------------------- | -------------------------------------------------------------- |
  | @nestjs/common, core, platform-express, websockets, testing | 11.1.17                                                        |
  | @nestjs/graphql, @nestjs/apollo                             | 13.2.4                                                         |
  | better-auth                                                 | 1.5.5                                                          |
  | express                                                     | 5.2.1                                                          |
  | graphql                                                     | 16.13.1                                                        |
  | tsdown                                                      | 0.12.9 (with rolldown 1.0.0-rc.9, rolldown-plugin-dts 0.13.14) |
  | vitest                                                      | 3.2.4                                                          |
  | unplugin-swc                                                | 1.5.9                                                          |
  | @swc/core                                                   | 1.15.18                                                        |
  | typescript                                                  | 5.9.3                                                          |
  | @biomejs/biome                                              | 2.2.4                                                          |

- Current npm dist-tags (`npm view … dist-tags`, 2026-09-10):
  - better-auth `latest: 1.7.4`
  - @nestjs/core `latest: 12.0.1`, so **Nest 12 has been released**
  - tsdown `latest: 0.23.0`
  - vitest `latest: 5.0.0`
  - @biomejs/biome `latest: 2.5.13`
  - `nestjs-slightly-better-auth` returns **404: never published**, so the name is free as of today.

### 1.2 `tsdown.config.ts` (L1-7)

```ts
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
});
```

- No `platform`, `target`, `external`, `shims`, or `outExtensions` setting.
- tsdown automatically treats dependencies and peers as external: `dist/index.js` imports `@nestjs/*`, `better-auth/*`, and `express` rather than bundling them (dist/index.js L1-8).

### 1.3 `tsconfig.json` (L1-11)

- Extends `@tsconfig/node22`: `module: nodenext`, `moduleResolution: node16`, `target: es2022`, `strict: true`, `esModuleInterop`, `skipLibCheck` (source: `node_modules/@tsconfig/node22/tsconfig.json`).
- Adds `types: ["vitest/globals"]`, `emitDecoratorMetadata: true`, `experimentalDecorators: true`, `allowImportingTsExtensions: true`, `noEmit: true`, `declaration: true`.
- There is no `include`, so `tsc` also type-checks `tests/`, `tsdown.config.ts`, and `vitest.config.ts`.
- Source files import siblings with `.ts` extensions (e.g. `src/index.ts:1`).

### 1.4 `vitest.config.ts` (L1-13): how decorators compile in tests

- `test.globals: true`.
- `plugins: [swc.vite({ module: { type: "es6" } })]`. No `include`, so vitest uses its default glob and finds the 7 `tests/e2e/*.e2e.test.ts` files. No setup files.
- unplugin-swc 1.5.9 (`node_modules/unplugin-swc/dist/index.js` L130-161) reads the nearest tsconfig. When `experimentalDecorators` is set, it enables `jsc.parser.decorators = true`, `jsc.transform.legacyDecorator = true`, and `decoratorMetadata = compilerOptions.emitDecoratorMetadata`, and sets `jsc.keepClassNames`. Its vite hook also sets `esbuild: false` (around L186).
- As a result, tests get **legacy TS decorators plus `design:paramtypes` metadata**. Test code depends on this: in `tests/e2e/hooks.e2e.test.ts`, `SignUpBeforeHook`'s constructor injects `HookTrackerService` without `@Inject`.
- Upstream v2.8.0 extends this config: it compiles `src` to CommonJS into `.vitest-cjs/` with `@swc/core`, validates each file with `vm.Script`, and redirects relative `src` imports there (`REF/vitest.config.ts` L1-123; `diff REPO/vitest.config.ts REF/vitest.config.ts`).

### 1.5 `biome.json` (L1-43)

- Biome 2.2.4 schema. `vcs.enabled: false` and `useIgnoreFile: false`, so gitignored directories like `.omc/` get scanned locally. `files.includes: ["**", "!**/dist"]`.
- Formatter: `indentStyle: "tab"` (L14), JS `quoteStyle: "double"` (L37).
- Linter: recommended rules, with `complexity.noThisInStatic: off` and `style.useImportType: off`. Organize-imports assist is off.
- `javascript.parser.unsafeParameterDecoratorsEnabled: true` (L40), which is required for Nest parameter decorators.
- Identical to the upstream v2.4.0 blob. Upstream v2.8.0 only adds `!**/.vitest-cjs` and `!examples` to `includes`.
- **Current lint state:**

  | Tree                              | `biome format` | `biome lint` | `biome check` | Cause                                                                                                                                     |
  | --------------------------------- | -------------- | ------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | HEAD copy                         | exit 1         | exit 0       | exit 1        | `package.json` is 2-space indented, but the config says tabs                                                                              |
  | Working tree (tracked paths only) | fails          | —            | 5 errors      | Formatter errors in `package.json`, `src/auth-guard.ts`, `src/auth-module-definition.ts`, `src/symbols.ts`, `tests/e2e/hooks.e2e.test.ts` |
  - Lint reports one fixable `lint/complexity/noUselessCatch` at `src/auth-guard.ts:280` (HEAD numbering) that does not fail the run.
  - The working-tree edits use 2 spaces and single quotes, which contradicts biome.json.

### 1.6 `mise.toml` (working tree, L1-9)

- `[tools] node = "24.14.1"`, `pnpm = "10.33.0"`, `lefthook = "latest"`; `[hooks] postinstall = "lefthook install"`.
- HEAD had only `node = "24.14.0"` and `pnpm = "10.32.1"`.
- Per mise docs, `postinstall` runs after tools are installed and needs no `mise activate` (https://mise.jdx.dev/hooks.html).
- Version drift across the toolchain:
  - `packageManager` pins pnpm 10.32.1, mise pins 10.33.0. `pnpm --version` in the repo prints `10.32.1`.
  - CI uses Node 22 (`actions/setup-node` with `node-version: 22`) while mise pins Node 24.
  - The shell used for these runs had Node v22.22.0.

### 1.7 `lefthook.yml` (untracked, L1-42)

- It is the stock lefthook example template with **every line commented out**, so no hooks are actually defined. `lefthook install` therefore wires nothing meaningful (UNVERIFIED how lefthook behaves with an all-comment config).

### 1.8 `pnpm-workspace.yaml` (L1-12)

- Contains only `allowBuilds`:
  - Real entries: `'@apollo/protobufjs'`, `'@nestjs/core'`, `'@swc/core'`, `esbuild`.
  - Seven single-letter keys `b, d, e, i, l, s, u`, all `true`. None of these packages exists in `pnpm-lock.yaml` (grep count 0 for each), so they are junk entries. Their origin is UNVERIFIED; they were added in `8004ff1`.
- `allowBuilds` is a pnpm setting added in **v10.26.0**. It maps package matchers to booleans and replaces `onlyBuiltDependencies`, `ignoredBuiltDependencies`, and related settings (https://pnpm.io/settings/build).
- There is no `packages:` key, so this is a single-package repo that uses the workspace file only for settings.

### 1.9 `.github/workflows/*`

| File           | Trigger                              | Steps                                                                                                                                                                                     | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview.yaml` | `on: [push, pull_request]` (L2)      | checkout, `pnpm/action-setup@v4`, setup-node 22 with pnpm cache, `pnpm install`, `pnpm run build`, **`pnpx pkg-pr-new publish`** (L25)                                                    | Preview releases through **pkg.pr.new**. By default pkg-pr-new packs with `npm pack` and changes the version only when `--previewVersion` is passed (pkg.pr.new CLI source, `packages/cli/index.ts`). `npm pack` fails here with `npm error Invalid package, must have name and version`, so previews should fail until a version is added (not observed in CI; inferred from the local `npm pack`). It also needs the pkg.pr.new GitHub App installed (UNVERIFIED).                                                                                                                                                                                                                               |
| `release.yaml` | `release: types: [published]` (L3-5) | install, build, `pnpm run lint`, `pnpm run format`, `pnpm run test`, **`pnpm publish --access public --no-git-checks`** (L36) with env `NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}` (L38) | Publishes to npm when a GitHub Release is published. **No changesets.** `NPM_CONFIG_TOKEN` is a bun convention ("`bun publish` respects the `NPM_CONFIG_TOKEN` environment variable": https://bun.sh/docs/cli/publish), left over from the bun version of this file (`git show 8004ff1 -- .github/workflows/release.yaml`). pnpm's docs describe `_authToken` in `.npmrc`/`auth.ini` instead (https://pnpm.io/npmrc). Whether pnpm honors `NPM_CONFIG_TOKEN` is UNVERIFIED; it is probably ignored. The job would also fail today at `pnpm run format` (package.json formatting) and at publish (missing version: `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND`, reproduced with `pnpm publish --dry-run`). |
| `style.yaml`   | push to `main`, PR, manual dispatch  | install, `pnpm run check`                                                                                                                                                                 | Fails today (see 1.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test.yaml`    | push to `main`, PR, manual dispatch  | install, `pnpm run build`, `pnpm run test -- --run` with `CI: true`                                                                                                                       | Express only, no matrix. `pnpm run test -- --run` expands to `vitest -- --run`, which still runs once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

- Upstream v2.8.0 for comparison (`REF/.github/workflows/*`): bun with `--frozen-lockfile`; the test job has a matrix `adapter: [express, fastify]` running `bun run test:${adapter}`. The release job uses **npm OIDC trusted publishing** (`permissions: id-token: write`, npm upgraded to >=11.5.1, `npm publish --provenance --access public`, and setup-node deliberately without `registry-url`). The preview job is still pkg-pr-new.

### 1.10 Other repo files

- `README.md`: one line (`# nestjs-slightly-better-auth` in the working tree; HEAD says `much`).
- `LICENSE`: MIT, "Copyright 2025 thilllon" (upstream says Thalles Passos).
- `.gitignore`: ignores `dist`, `coverage`, `.vscode`, `.omc`, and others.
- `.claude/settings.local.json` (untracked): only WebFetch and WebSearch permissions.
- Git remote: `https://github.com/thilllon/nestjs-slightly-better-auth.git`, branch `main`.
- **A stale `REPO/dist/` exists** (dated 2026-03-17 23:13) with the same hashed `.d.ts` names. It is gitignored. Do not treat it as a good artifact.
- Working-tree state drift: `README.md` and `package.json` were modified at 2026-09-10 22:56. The session-start git snapshot did not list them, but my first `git status` did.

---

## Q2. Does the current build and test suite actually work?

All runs used copies (see header). The original `REPO` was left untouched: `git status` was unchanged afterwards and `REPO/dist` kept its March timestamps.

### 2.1 `pnpm build`

**HEAD copy** (`$SP/tmp-current-repo/head`), command `pnpm build`, exit 0. Output excerpt:

```
tsdown v0.12.9 powered by rolldown v1.0.0-rc.9
Warning: Invalid input options (1 issue found)
- For the "define". Invalid key: Expected never but received "define".   (x3)
[CJS] dist/index.cjs  21.86 kB
[ESM] dist/index.js             19.73 kB
[ESM] dist/index-DhKji9Jf.d.ts  9.59 kB
[CJS] dist/index-DYD7L77y.d.cts  9.59 kB
✔ Build complete
```

- **Formats:** CJS (`index.cjs`) and ESM (`index.js`), as intended.
- **Declarations: broken file names.** The output has `index-<hash>.d.ts` and `index-<hash>.d.cts`, with no `index.d.ts` or `index.d.cts`.
  - The two declaration files differ only in import order (`diff`). Their contents are fine: 21 exports, including types `Auth`, `AuthHookContext`, `BaseUserSession`, `UserSession`.
  - `publint` on a versioned copy reports: `pkg.exports["."].import.types is ./dist/index.d.ts but the file does not exist`, the same for `require.types`, and `pkg.types`.
  - `attw` on the packed tarball: `❌ Import resolved to JavaScript files, but no type declarations were found` for node10, node16-CJS, node16-ESM, and bundler.
  - **Root cause (verified):** `tsdown@0.12.9` depends on `rolldown: ^1.0.0-beta.19`, and pnpm resolved `1.0.0-rc.9` (`pnpm-lock.yaml` L2569/L5266). Rebuilding the same source with tsdown 0.12.9 and rolldown pinned to `1.0.0-beta.29` (npm `overrides`, in `$SP/tmp-current-repo/tsdown-0129-pinned`) produces `index.d.ts` and `index.d.cts` with no warnings.
  - With **tsdown 0.23.0 / rolldown 1.2.8** (latest), the output is `index.cjs`, `index.d.cts`, `index.mjs`, `index.d.mts`. The names are correct, but they differ from the `index.js`/`index.d.ts` paths in `package.json`, so the exports map must be updated on any upgrade.
- **`design:paramtypes` is emitted.**
  - `grep -c design:paramtypes` finds 3 matches in `dist/index.js` and 3 in `dist/index.cjs`.
  - Examples: `dist/index.js` L161 `AuthService = __decorate([__decorateParam(0, Inject(MODULE_OPTIONS_TOKEN)), __decorateMetadata("design:paramtypes", [Object])], AuthService);`, L319-323 for AuthGuard, L465-484 for AuthModule.
  - The helpers come from `@oxc-project/runtime` (`__decorateMetadata`/`__decorateParam`/`__decorate`, dist L122-139).
  - The same holds for tsdown 0.23.0 and for the pinned-rolldown build (3 and 3).
  - Library code also puts an explicit `@Inject(...)` on every constructor parameter (`src/auth-module.ts:57-68`, `src/auth-guard.ts` HEAD L152-157, `src/auth-service.ts:13-16`), so it does not depend on paramtypes metadata.
- **Optional-dependency `require()` in ESM.** Source calls `require("graphql")`, `require("@nestjs/websockets")`, and `require("@nestjs/graphql")` (HEAD `src/auth-guard.ts` L30, L70; `src/utils.ts:8`). In the ESM output rolldown rewrites these as `var __require = createRequire(import.meta.url)` (`dist/index.js` L1, L10, L21, L171, L183), so they work in ESM.
- **Nest deep imports** are kept as bare imports: `@nestjs/common/utils/shared.utils.js` and `@nestjs/core/middleware/utils.js` (dist L7-8; source `src/auth-module.ts:30-31`).
- **Runtime smoke test** of the built output with better-auth 1.5.5:
  - `node -e "require('reflect-metadata'); require('./dist/index.cjs')"` works and lists 17 value exports.
  - `node --input-type=module -e "import('./dist/index.js')"` **fails** with `SyntaxError: The requested module 'better-auth/plugins' does not provide an export named 'createAuthMiddleware'` at `dist/index.js:5`.
  - Verified directly: `better-auth/plugins` has no `createAuthMiddleware` in 1.5.5 (CJS and ESM) and not in 1.7.4 source (`$SP/better-auth/packages/better-auth/src/plugins/index.ts` L1-27). It is exported from `better-auth/api` (`src/api/index.ts` L409-416, `export { … createAuthMiddleware … } from "@better-auth/core/api"`).
  - In CJS the missing export is `undefined`, so the crash happens later, at `onModuleInit`, when `@Hook` providers exist.
  - With the import fixed to `better-auth/api`, the tsdown 0.23.0 output loads in both ESM and CJS (`ESM OK: 17 exports`, `CJS OK: 17 exports`).
- **better-auth is ESM-only**: `type: module`; exports only `default → *.mjs` (1.5.5 `exports['./plugins'|'./api'|'./node']`; 1.7.4 `exports['.']`). The CJS build therefore relies on Node's `require(esm)`. On Node v22.22.0, `require()` of `better-auth`, `/api`, `/node`, `/plugins`, `/plugins/{organization,admin,bearer}` from 1.7.4 all succeed.
- **Pack and publish:** `pnpm pack` and `pnpm publish --dry-run` fail with `ERR_PNPM_PACKAGE_VERSION_NOT_FOUND  Package version is not defined in the package.json.` `npm pack --dry-run` fails with `npm error Invalid package, must have name and version`.

**Working-tree copy** (`wt/`): `pnpm build` also exits 0 (hashed `index-CkxiE9VU.d.ts` and `index-DxVr_jnj.d.cts`), even though the code is broken. tsdown does not type-check. The generated d.ts shows `ConfigurableModuleCls<AuthModuleOptions<any>, "register", "create", …>` and `declare const BEFORE_HOOK_KEY: unique symbol;`.

### 2.2 `tsc --noEmit -p .` (not part of any script or CI job)

- **HEAD copy**, exit 2:
  ```
  src/auth-module.ts(16,10): TS2305 Module '"better-auth/plugins"' has no exported member 'createAuthMiddleware'.
  src/auth-module.ts(175,12): TS7006 Parameter 'ctx' implicitly has an 'any' type.
  src/middlewares.ts(4,34): TS2307 Cannot find module 'body-parser' …
  tests/shared/test-gateway.ts(7,39): TS2307 Cannot find module 'rxjs' …
  tests/shared/test-gateway.ts(28,2): TS2564 Property 'namespace' has no initializer …
  tests/shared/test-gateway.ts(39|48|62,9): TS7006 Parameter 'char' implicitly has an 'any' type.
  ```
- **Working-tree copy**: all of the above, plus
  ```
  src/auth-module.ts(189,36): TS2339 Property 'forRootAsync' does not exist on type 'ConfigurableModuleCls<…, "register", "create", …>'
  src/auth-module.ts(231,31): TS2339 Property 'forRoot' does not exist on type …
  ```
- **HEAD with the two fixes** leaves only `middlewares.ts(4,34)` (missing `@types/body-parser`) and `test-gateway.ts(28,2)` (TS2564).

### 2.3 `pnpm test --run`

| Tree                                     | Result                                                                                       | Details                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD copy (committed code)               | **FAIL**, exit 1. `Test Files 6 failed \| 1 passed (7)`; `Tests 10 passed \| 2 skipped (12)` | `graphql-auth`, `module`, `options`, `rest-auth`, `websocket-auth` fail to load: `Error: Cannot find package 'rxjs' imported from …/tests/shared/test-gateway.ts` (`test-gateway.ts:7`). `REPO/node_modules/rxjs` does not exist. `hooks.e2e`: `TypeError: (0 , createAuthMiddleware) is not a function` at `src/auth-module.ts:174`, reached from `onModuleInit` at `:112`; its two tests are skipped. Its configuration-validation test passes. `organization-roles` passes (9). |
| Working-tree copy (uncommitted code)     | **FAIL**, exit 1. `Test Files 7 failed (7)`; `Tests 1 failed \| 11 skipped (12)`             | Same rxjs failures, plus `TypeError: (intermediate value).forRoot is not a function` at `src/auth-module.ts:231` in `hooks` and `organization-roles`.                                                                                                                                                                                                                                                                                                                              |
| HEAD with 2 fixes, better-auth 1.5.5     | **PASS**, exit 0. `Test Files 7 passed (7)`; `Tests 36 passed (36)`                          | Fixes: symlink `node_modules/rxjs → .pnpm/rxjs@7.8.2/...`, and `createAuthMiddleware` imported from `better-auth/api`.                                                                                                                                                                                                                                                                                                                                                             |
| HEAD with 2 fixes, **better-auth 1.7.4** | **PASS**, exit 0. `Test Files 7 passed (7)`; `Tests 36 passed (36)`                          | `node_modules/better-auth` symlinked to an npm install of 1.7.4 in `$SP/tmp-current-repo/ba174`. The 1.7.4-specific warning "Base URL is not set. … allowedHosts …" in the log confirms the version actually used.                                                                                                                                                                                                                                                                 |

Notes on the passing runs:

- They log two expected errors: `ERROR [ExceptionsHandler] GraphQLError: Unauthorized` from the GraphQL protected-query test, and `Error: uncaught` from the middleware-throws test.
- CI-style `CI=true pnpm run test -- --run` gives the same 36/36.
- Logs: `$SP/tmp-current-repo/{test-head,test-wt,test-head-fixed,test-head-fixed-174,ci-style}.log`.
- Pitfall for anyone copying the repo: `rsync --exclude dist` also removes every `node_modules/**/dist`. I hit this; re-copy `node_modules` without that exclude.

---

## Q3. Semantic diff: current repo vs the reference

### 3.0 Method

- Provenance by git object hashes (see §0). Within `REF` history, the current src tree `874febc…` equals tag `v2.4.0` (`9554855`) and the side-branch commits `36aea7c`, `cd951b9`, `54b2db3`. The tests tree `121479b…` also equals it. Script: `$SP/find-fork.sh`.
- Formatting normalization: I copied both sides with the same `biome.json`, ran `biome format --write` on each copy, then ran `diff -ru`. Outputs:
  - `$SP/tmp-current-repo/worktree-vs-HEAD.biome-normalized.diff` (54 lines)
  - `$SP/tmp-current-repo/current-vs-ref-v2.8.0.biome-normalized.diff` (1978 lines)
  - `$SP/tmp-current-repo/upstream-v2.4.0..v2.8.0.src-tests.diff` (4246 lines; raw `git diff v2.4.0 v2.8.0 -- src tests`)

### 3.1 The fork's own changes (HEAD and working tree vs its base, upstream v2.4.0)

**Committed (`4a3dd2f`, `8004ff1`):**

- **Zero changes to src/ or tests/.**
- Tooling only:
  - bun/unbuild replaced by pnpm/tsdown.
  - `build.config.ts` deleted (it had an unbuild config with `declaration: true` and esbuild `experimentalDecorators`).
  - `tsdown.config.ts` added.
  - `package.json` rewritten: name, description, exports, pnpm, versions bumped, `@types/bun` removed, `version` removed.
  - Workflows switched from bun to pnpm/Node 22, and style/test branches from `master` to `main`.
  - `mise.toml`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` added. `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc` removed.
  - LICENSE holder and `.gitignore` (`.omc`) changed.

**Uncommitted working tree.** After biome normalization, only these semantic items remain:

| #   | File                            | Change                                                                                                          | Semantic effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `src/auth-module-definition.ts` | **Removes `.setClassMethodName("forRoot")`** (HEAD L31; working tree L31-49 has only `.setExtras(...).build()`) | **Breaking.** `ConfigurableModuleBuilder` falls back to the default names `register`/`registerAsync`, and `AuthModule.forRoot`/`forRootAsync` call `super.forRoot…`. Runtime check with the built CJS: HEAD `forRoot: function … register: undefined`; working tree `register: function registerAsync: function`, and `AuthModule.forRoot({...})` throws `(intermediate value).forRoot is not a function`. The inherited public `register()`/`registerAsync()` would also skip the module's APP_GUARD and `disableControllers` handling (`src/auth-module.ts:188-254`). |
| W2  | `src/auth-module-definition.ts` | JSDoc `@default false` on `disableTrustedOriginsCors`; callback parameter renamed `def` → `definition`          | None.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| W3  | `src/symbols.ts:1`              | `BEFORE_HOOK_KEY = Symbol('BEFORE_HOOK')` loses `as symbol`                                                     | Type-level only: the emitted d.ts becomes `declare const BEFORE_HOOK_KEY: unique symbol;`, while the other three keys stay `symbol`. Runtime is identical.                                                                                                                                                                                                                                                                                                                                                                                                              |
| W4  | `src/auth-guard.ts`             | Tabs → 2 spaces, double → single quotes, one blank line added                                                   | None. The normalized diff is just the blank line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| W5  | `tests/e2e/hooks.e2e.test.ts`   | Reformatting only                                                                                               | None. Identical after normalization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| W6  | `README.md`, `package.json`     | Rename `much` → `slightly` (name, description, keyword)                                                         | Package identity only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| W7  | `mise.toml`, `lefthook.yml`     | Tool versions, lefthook plus postinstall hook, template config                                                  | Tooling only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 3.2 Current repo vs `REF` v2.8.0

Everything below is upstream work the fork does not have, plus W1-W3 above. After normalization these files are **identical** between the two: `src/index.ts`, `src/auth-service.ts`, `tests/shared/test-gateway.ts`, `tests/shared/test-resolver.ts`, `tests/e2e/{graphql-auth,module,rest-auth,websocket-auth}.e2e.test.ts`.

**src (upstream v2.4.0 → v2.8.0):**

1. **`createAuthMiddleware` import fix:** `better-auth/plugins` → `better-auth/api` (`REF/src/auth-module.ts`). This is the crash in Q2.
2. **Fastify support, and a new way of mounting the handler**:
   - `configure()` reads `httpAdapter.getType()`.
   - On Fastify it skips `enableCors` and handles trusted-origin CORS manually (`src/fastify-trusted-origins-cors.ts`: ACAO/ACAC/`Vary: Origin` headers, and short-circuits OPTIONS preflight).
   - Fastify body parsing goes through `configureFastifyBodyParser` (`src/fastify-body-parser.ts`: content-type parsers, limit parsing, optional `qs` for extended urlencoded).
   - The better-auth handler is mounted with **`this.adapter.httpAdapter.use(...)` plus a `matchesBasePath()` check**, instead of `consumer.apply(...).forRoutes(basePath)`. It unwraps `req.raw`/`res.raw` via `getNodeRequest`/`getNodeResponse`.
   - The global-prefix exclusion becomes `mapToExcludeRoute([basePath, \`${basePath}/*path\`])`.
3. **Body-parser options**: new `bodyParser: { json?: {enabled, limit, inflate, type, reviver, strict}, urlencoded?: {enabled, extended=true, parameterLimit, …}, rawBody?: boolean }` (`src/body-parser-options.ts`, `src/auth-module-definition.ts`).
   - `disableBodyParser` and `enableRawBodyParser` are deprecated, with `logger.warn` at configure time.
   - `resolveBodyParserOptions()` merges old and new options.
   - Express parsers are loaded lazily with `createRequire(import.meta.url)("express")`, so `express` is no longer a hard import. The fork does a top-level `import * as express from "express"` (`REPO/src/middlewares.ts:3`).
   - Matching the Better Auth path uses `originalUrl ?? url ?? baseUrl ?? raw.url` instead of `req.baseUrl.startsWith(basePath)` (`REPO/src/middlewares.ts:60`).
4. **`middleware` option type** changes from Express `(Request, Response, NextFunction)` to an adapter-neutral `AuthModuleMiddleware` (`any`, `any`, `next(error?)`) that returns `void | Promise<void>`.
5. **Lazy optional dependencies:** `require(...)` becomes `await import(...)`. As a consequence, `getRequestFromContext` and the `Session` parameter decorator factory become **async**, and all error factories become `async` returning `Promise<Error>` (`throw await AuthContextErrorMap[...]`).
6. **Error payload changes** (these change behavior):
   - HTTP 401: fork `new UnauthorizedException({ code: "UNAUTHORIZED", message: "Unauthorized" })` (HEAD `auth-guard.ts` L85-91), so the body is `{code, message}`. Upstream uses `new UnauthorizedException()`, so Nest's default body.
   - HTTP 403: fork `{ code: "FORBIDDEN", message: "Insufficient permissions" }` (L92-98). Upstream uses `new ForbiddenException("Insufficient permissions")`.
   - GraphQL: the fork throws `GraphQLError` (lazy-required `graphql`, L100-129). Upstream throws the same Nest `UnauthorizedException`/`ForbiddenException` as HTTP.
   - WebSocket (`WsException("UNAUTHORIZED"|"FORBIDDEN")`) and RPC (`Error("UNAUTHORIZED")`) are unchanged.
7. **New authorization decorators and guard checks:**
   - `@RequireActiveOrg()` (metadata `"REQUIRE_ACTIVE_ORG"`): 403 with `{message:"Active organization is required"}` when the session has no `activeOrganizationId`. `@OrgRoles()` becomes `applyDecorators(RequireActiveOrg(), SetMetadata("ORG_ROLES", roles))`.
   - `@UserHasPermission({userId?, role?, permission? | permissions?})`: calls `auth.api.userHasPermission({ body, headers })` from the admin plugin and throws at decoration time if neither `permission` nor `permissions` is given.
   - `@MemberHasPermission({permissions})`: requires an active org, then calls `auth.api.hasPermission({ body, headers })` from the organization plugin.
8. **Database hooks:** class decorator `@DatabaseHook()` plus method decorators `@BeforeCreate/@AfterCreate/@BeforeUpdate/@AfterUpdate/@BeforeDelete/@AfterDelete(model)`, where `model` is `"user"|"session"|"account"|"verification"`.
   - New symbols `DATABASE_HOOK_KEY`, `BEFORE_DATABASE_HOOK_KEY`, `AFTER_DATABASE_HOOK_KEY`.
   - The handlers are chained into `auth.options.databaseHooks[model][operation][before|after]`. It throws if providers exist but `databaseHooks` is not an object.
9. **`UserSession<T = unknown>`** now infers from `T["$Infer"]["Session"]` (for plugin-aware session typing) and falls back to the old shape.
10. `getMemberRoleInOrganization` drops a useless try/catch (no behavior change).
11. **Packaging:** ESM-only (`build.config.ts` `emitCJS: false`; exports `{types: ./dist/index.d.mts, import/default: ./dist/index.mjs}`). Peer ranges `@nestjs/* ^11.1.6 || ^12.0.0`, `@nestjs/graphql ^13.1.0 || ^14.0.0`, `better-auth >=1.5.0 <2.0.0`, `typescript ^5.9.2 || ^6.0.0`; `express` and `qs` optional peers; `engines.node >=22.22.1` (`REF/package.json`). The ref's `bun.lock` resolves `@nestjs/*` to 12.0.1 and better-auth to 1.5.4.

**tests (upstream v2.4.0 → v2.8.0):**

- New `tests/shared/http-adapter.ts`: `TEST_HTTP_ADAPTER` env picks `FastifyAdapter` or `ExpressAdapter`. `initTestApplication()` awaits `getInstance().ready()` on Fastify.
- `test-utils.ts`:
  - New `createTestNestApplication(moduleRef, {globalPrefix, initialize, authOptions, configureAdapter})`.
  - `createTestAuth(authOptions?)` becomes configurable.
- `test-controller.ts` gains:
  - Routes: `echo-body`, `json-body`, `form-body`, and `@RequireActiveOrg()` on `active-org-protected`.
  - A new `ActiveOrgController` with class-level `@RequireActiveOrg()`.
- `hooks.e2e` uses the adapter-agnostic factory.
- New suites (test counts from `grep`):

  | Suite                       | Tests |
  | --------------------------- | ----- |
  | `cors.e2e`                  | 1     |
  | `database-hooks.e2e`        | 5     |
  | `member-has-permission.e2e` | 17    |
  | `user-has-permission.e2e`   | 17    |
  | `session-custom-fields.e2e` | 3     |

- Extended `options.e2e`: bodyParser rawBody, deprecated flags, json-only/urlencoded-only disable, json limit.
- Extended `organization-roles.e2e`: 4 `@RequireActiveOrg` tests.

---

## Q4. Test harness: how it works and what is worth keeping

### 4.1 How the apps are started

- **Better Auth instance** (`tests/shared/test-utils.ts:19-36`): `betterAuth({ basePath: "/api/auth", emailAndPassword: { enabled: true }, plugins: [bearer(), admin({ roles: { admin: adminAc, moderator: userAc, user: userAc } })] })`.
  - It has **no `database`**, so better-auth uses its **in-memory adapter** (`$SP/better-auth/packages/better-auth/src/db/adapter-base.ts` L15-22). No external services are needed.
  - The organization suite builds its own instance with `bearer()`, `admin()`, `organization()` (`tests/e2e/organization-roles.e2e.test.ts:16-30`).
- **Nest app** (`createTestApp`, `test-utils.ts:76-99`):
  - Builds an `AppModule` that imports `AuthModule.forRoot({ auth, ...options })`, or `forRootAsync({ useFactory })` when `async=true`, plus `GraphQLModule.forRoot<ApolloDriverConfig>({ driver: ApolloDriver, autoSchemaFile: true, path: "/graphql", context: ({req,res}) => ({req,res}) })`.
  - Controller `TestController`; providers `TestResolver`, `TestGateway` (`test-utils.ts:39-69`).
  - Then `Test.createTestingModule(...).compile()` and `moduleRef.createNestApplication(new ExpressAdapter(), { bodyParser: false })`, an optional `app.setGlobalPrefix(...)`, and `app.init()`.
  - **Express only. No Fastify anywhere.** `hooks.e2e` and `organization-roles.e2e` construct their own apps the same way (Express, `bodyParser: false`).
- **HTTP requests** use `supertest` against `app.getHttpServer()`.
- **Users** are created through the server API: `auth.api.signUpEmail`, `createUser` (admin), `signInEmail`, `createOrganization`, `setActiveOrganization`, `addMember`. Requests authenticate **only** with `Authorization: Bearer <token>` (bearer plugin). No cookie-based session is ever tested.
- **WebSocket:**
  - `TestGateway` is `@WebSocketGateway({ path: "/ws", namespace: "test", cors: { origin: "*" } })` with **`@UseGuards(AuthGuard)`** (`tests/shared/test-gateway.ts:18-26`), using socket.io through `@nestjs/platform-socket.io`'s default IoAdapter.
  - The suite calls `app.listen(0)` and connects `socket.io-client` with `extraHeaders.Authorization` (`websocket-auth.e2e.test.ts:37-41`, `:95-100`).
  - The explicit `@UseGuards` is required because Nest's socket module builds `GuardsContextCreator(container)` **without** the application config (`node_modules/@nestjs/websockets/socket-module.js:81`). `getGlobalMetadata()` then returns `[]` (`@nestjs/core/guards/guards-context-creator.js:53-56`), so the `APP_GUARD` registered by `forRoot` (`@nestjs/core/scanner.js:373`) never applies to gateways.
  - GraphQL resolvers do receive the global guard: `protectedUserId` has no decorator and is still protected.
- **Express mounting detail the tests implicitly depend on:**
  - `consumer.apply(handler).forRoutes(this.basePath)` (`src/auth-module.ts:149-157`) goes through `RoutesMapper.getRouteInfoFromPath`, which sets method `-1` (`@nestjs/core/middleware/routes-mapper.js` L26-33). `RouterMethodFactory` finds no mapping for `-1` and falls back to `target.use` (`@nestjs/core/helpers/router-method-factory.js` L23-31), which becomes Express **`app.use('/api/auth', …)` prefix mounting**.
  - better-call then rebuilds the full URL from `req.baseUrl + req.url` (`better-call@1.4.0 dist/adapters/node/request.mjs` L95-101).
  - This path is Express-specific. Upstream replaced it with `httpAdapter.use()` plus `matchesBasePath`.
- **Body parsing:** the app disables Nest's parser (`bodyParser: false`). The module installs `SkipBodyParsingMiddleware` on `*path`, which skips Better Auth paths and otherwise runs `express.json` then `express.urlencoded({extended:true})`, with an optional raw-body `verify` (`src/middlewares.ts:47-74`; `src/auth-module.ts:138-147`).

### 4.2 Coverage per suite (36 tests at HEAD once fixed)

| Suite                            | Tests | Behavior pinned                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rest-auth.e2e.test.ts`          | 9     | 401 on the global guard without a session (only asserts `body.message` is defined); `@AllowAnonymous` 200; `@OptionalAuth` with and without a session (`req.session` and `req.user` attached); bearer auth; **global prefix excludes the better-auth basePath** (`/api/auth` stays un-prefixed while `/v1/test/protected` works); `@Roles(["admin"])` 403 with message containing "Insufficient permissions"; admin and moderator roles allowed (comma/array role matching through the admin plugin). |
| `graphql-auth.e2e.test.ts`       | 4     | Public query, optional query (`@Session()` returns null), protected query without auth gives an `errors` array with HTTP 200, with auth returns data. It does **not** exercise `@Roles` on resolvers, although `TestResolver` defines them.                                                                                                                                                                                                                                                           |
| `websocket-auth.e2e.test.ts`     | 6     | Anonymous event, protected event rejected with `exception` whose `message === "UNAUTHORIZED"`, authenticated through handshake headers (`request?.handshake?.headers`), optional auth with and without a session, invalid token gives `UNAUTHORIZED`.                                                                                                                                                                                                                                                 |
| `options.e2e.test.ts`            | 4     | `disableControllers: true` returns 404 on better-auth routes. It actually disables **all** module middleware: `AuthModuleWithoutControllers.configure()` is a no-op (`src/auth-module.ts:257-261`). A throwing `middleware` option gives a 500 with `{statusCode, message: MESSAGES.UNKNOWN_EXCEPTION_MESSAGE}`, using the deep import `@nestjs/core/constants.js`. `enableRawBodyParser` true/false attaches or omits `req.rawBody` as a Buffer on a non-auth route.                                 |
| `hooks.e2e.test.ts`              | 3     | `@Hook()` class plus `@BeforeHook('/sign-up/email')`/`@AfterHook(...)` are each called once on a matching HTTP route. App init rejects with `/@Hook providers.*hooks.*not configured/` when `betterAuth` has no `hooks: {}`.                                                                                                                                                                                                                                                                          |
| `module.e2e.test.ts`             | 1     | `forRootAsync` with controllers resolves.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `organization-roles.e2e.test.ts` | 9     | `@Roles` checks **only** `user.role`: an org owner without `user.role` gets 403, the "security fix" case. `@OrgRoles` checks **only** the active-org member role (owner, owner-or-admin, admin, member). 403 without an active org, 403 for a system admin without an active org, 403 for a member on an owner route.                                                                                                                                                                                 |

**Not covered today:**

- Fastify, or any adapter other than Express.
- Cookie sessions.
- `trustedOrigins` CORS, including the function-based `trustedOrigins` error at `src/auth-module.ts:129-136`.
- `disableTrustedOriginsCors`, `disableGlobalAuthGuard`, `isGlobal:false`.
- `AuthService` injection (`api`/`instance`).
- `@Session()` on HTTP controllers (the tests use `@Request()`).
- The deprecated `Public`/`Optional` aliases and the deprecated `forRoot(auth, options)` overload (`src/auth-module.ts:214-229`).
- Hook path _non-match_, and chaining multiple hook providers.
- JSON or urlencoded parsing on normal routes, and better-auth routes receiving the untouched body.
- Custom `basePath`, versioning, and the RPC context.

**Test hygiene issues:**

- `options.e2e` reassigns `testSetup` in each test and closes only the last app.
- `module.e2e` and the hooks validation test never close their apps.
- `test-gateway.ts` needs `rxjs`, which is not a devDependency.

### 4.3 Which tests to keep as behavioral specs

Keep these, run across every adapter in a matrix, and treat them as the compatibility contract for the rewrite. All 36 already pass on better-auth 1.7.4 once the two fixes are applied.

- **rest-auth (all 9).** Especially: anonymous, optional, protected; the global-prefix exclusion of the better-auth basePath; role matching.
- **organization-roles (all 9).** Encodes the intended separation between `@Roles` (user.role) and `@OrgRoles` (member role plus active org), including the security-fix case.
- **graphql-auth (4) and websocket-auth (6).** They pin the transport-specific request extraction (GraphQL context `req`, WS handshake headers) and show that WS needs an explicit guard.
- **hooks (3).** Plugs Nest providers into better-auth `hooks.before/after` with path filtering, and fails fast when `hooks` is not configured. Verified working on 1.7.4 (the module mutates `auth.options.hooks` after `betterAuth()` has been constructed).
- **options.** Keep the rawBody pair (2) and the middleware-throws test (1).
- **module async (1).**

Keep, but decide the contract first:

- The `disableControllers` 404 test: the option name no longer matches what it does (it disables all middleware).
- Exact error payloads: HTTP `{code, message}` vs Nest defaults, GraphQL `GraphQLError` vs `HttpException`, WS `"UNAUTHORIZED"` string. The current tests pin only the WS string and "Insufficient permissions".

Extend with, as the upstream-inspired minimum:

- An adapter-parametrized harness (the upstream `http-adapter.ts` pattern), plus the upstream `cors`, `options` bodyParser, and `@RequireActiveOrg`/permission suites if those features stay in scope.

---

## Implications for the design team (facts only, no design)

1. Toolchain:
   - Use a current tsdown (0.23.x with rolldown 1.2.x verified) or pin rolldown exactly. Caret ranges on rolldown prereleases drift.
   - Generate the `exports` map from the real output names (tsdown 0.23 emits `.mjs/.cjs/.d.mts/.d.cts`).
   - Add `publint` and `attw --pack` to CI. Add a `tsc --noEmit` step: the tsdown build exits 0 despite TS2305/TS2339.
2. Import `createAuthMiddleware` (and the hook context type) from `better-auth/api`. `better-auth/plugins` does not export it in 1.5.5 or in 1.7.4.
3. **Dual CJS+ESM constraints:**
   - better-auth is ESM-only, so the CJS artifact only works on Node versions with `require(esm)` (verified on Node 22.22.0). The Node engine floor must reflect that.
   - Module-scoped `Symbol()` DI tokens and metadata keys are duplicated between the CJS and ESM builds (dual-package hazard) if both formats load in one process.
   - Source that uses `import.meta.url` (as upstream does) needs shims in the CJS output.
   - tsdown already rewrites bare `require()` into `createRequire(import.meta.url)` for ESM.
4. `express` is imported at top level (`src/middlewares.ts:3`) and is a required peer. A Fastify-first or other platform would need that removed or made lazy, which is what upstream did.
5. Handler mounting through `forRoutes(basePath)` relies on Express `app.use` prefix semantics plus better-call's `baseUrl` reconstruction. It is not portable across adapters.
6. Global `APP_GUARD` covers HTTP and GraphQL but **not** WebSocket gateways (Nest socket-module quirk). Any transport extension point must account for this.
7. The public API surface that exists today (from the d.ts export list):
   - `AuthModule`, `AuthService`, `AuthGuard`
   - `AllowAnonymous`, `OptionalAuth`, `Roles`, `OrgRoles`, `Session`, `Public`/`Optional` (deprecated)
   - `Hook`, `BeforeHook`, `AfterHook`
   - `BEFORE_HOOK_KEY`, `AFTER_HOOK_KEY`, `HOOK_KEY`, `AUTH_MODULE_OPTIONS_KEY`
   - Types `Auth`, `AuthHookContext`, `BaseUserSession`, `UserSession`
   - Notes: `AUTH_MODULE_OPTIONS_KEY` (`src/symbols.ts:4`) is exported but **never used**; the real token `MODULE_OPTIONS_TOKEN` (`src/auth-module-definition.ts` L29 in the working tree) is **not exported**. Reflector metadata keys are bare strings (`"PUBLIC"`, `"OPTIONAL"`, `"ROLES"`, `"ORG_ROLES"`; `src/decorators.ts:11-52`).
8. The guard calls `auth.api.getSession` on **every** guarded request, including `@AllowAnonymous` routes. The session lookup happens before the public check (HEAD `auth-guard.ts` L168-182). `@OrgRoles` makes a second API call (`getActiveMemberRole` or `getActiveMember`).
9. Release pipeline prerequisites:
   - A `version` field.
   - Working npm auth (upstream uses OIDC trusted publishing with npm >=11.5.1).
   - pkg.pr.new also needs a valid version, or the `--previewVersion` flag.
10. Test infrastructure:
    - pnpm's strict layout means every module a test imports must be a direct devDependency (`rxjs`, `fastify`, `@nestjs/platform-fastify`, and `@types/body-parser` if kept).
    - Tests need swc (unplugin-swc) for decorator metadata; vite's esbuild does not emit it.

## Pitfalls

- Do not use the working tree as the behavior baseline: it is broken (W1). HEAD, which equals upstream v2.4.0, is the real baseline.
- Do not read differences from `REF` v2.8.0 as local customizations. The fork has none in src/ or tests/.
- `REPO/dist/` is stale (March) and broken (hashed d.ts names). Running `pnpm build` in `REPO` would overwrite it, so do builds in copies.
- `rsync --exclude dist` strips `node_modules/**/dist`. Exclude `/dist` (root-anchored) instead.
- Every current green result depends on better-auth 1.5.5 being auto-installed as a peer. better-auth is not pinned in devDependencies.
- Running `biome check` locally also scans gitignored `.omc/` and `.claude/`, because `vcs.useIgnoreFile` is false.

## Open questions for the user

1. Was removing `.setClassMethodName("forRoot")` intentional (for example, to switch to `register`/`registerAsync` naming), or an accident? It currently breaks every test.
2. Which code style wins? `biome.json` says tabs and double quotes; the recent working-tree edits and `package.json` use 2 spaces (single quotes in the TS files).
3. Should upstream's v2.4.0 → v2.8.0 features be the minimum scope for the rewrite: Fastify, `bodyParser` options, `RequireActiveOrg`, `UserHasPermission`/`MemberHasPermission`, `@DatabaseHook` decorators, generic `UserSession<T>`?
4. What error-payload contract should the library have: the fork's `{code, message}` bodies and `GraphQLError`, or upstream's Nest-default `HttpException`s?
5. Release process: keep pkg.pr.new previews plus GitHub-Release-triggered publishing? Adopt npm OIDC trusted publishing and/or changesets? What initial version?
6. Should the rewrite keep API compatibility with the current names (`AuthModule.forRoot`, deprecated aliases, the `(auth, options)` overload)? The package has never been published, so a clean break costs nothing.
7. What is the Node engine floor? CI uses 22, mise uses 24, and the CJS output depends on `require(esm)`.
8. What should `lefthook.yml` actually run? It is an empty template today.
