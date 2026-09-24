# Repository instructions

Keep this file current as maintainer decisions change. `CLAUDE.md` imports this file; do not duplicate the rules there.

## Repository language

- Write repository documentation, code comments, automated reviews, commit messages, and issue/PR titles and bodies in English. The project does not plan Korean-language support or localized documentation.
- Keep conversation language independent: respond to the user in their preferred language without applying it to repository content.
- Write repository content technically. Commit messages, READMEs, code comments and docs state what the code does and its technical reasons in the present tense. Do not add narratives about earlier implementations, past incidents, former owners, or the PRs and issues that led to the current state; Git history and issues hold that record. Generated changelogs and the design material other rules preserve are exempt.
- Keep the root README to repository-wide information and a short package list. Package-specific details belong in that package's README.

## Package identities

- Check npm name availability and ownership before creating a package. Prefer an available unscoped name such as `nestjs-foobar`; if it is already taken, use the owned `@nestjs-kit/foobar` scope as the fallback.
- Unscoped package folders match their npm names, for example `packages/nestjs-foobar`. Scoped packages use folders such as `packages/nestjskit__foobar` for `@nestjs-kit/foobar`.
- Preserve existing published names and folder identities unless the maintainer explicitly requests a rename. Apply the naming preference to new packages without silently renaming established packages.
- Do not publish to the retired `@nestjs-tools/*` scope or delete its npm packages. The owner handles their retirement.
- Check registry ownership and published versions before changing package identities or release baselines. Do not describe a requested rename as published until the registry confirms its first publication.

## Toolchain and builds

- Use mise and the current Node.js LTS. pnpm has no LTS channel: pin a supported stable version and keep the lockfile current.
- Install Git hooks through mise's `postinstall = "lefthook install"` hook; do not introduce a redundant package prepare wrapper.
- Order existing package.json scripts with `typecheck`, `build`, then `dev` first in the root and every package; do not add missing commands just for ordering.
- Name type-checking scripts and Turbo tasks `typecheck`. Keep dependency fields at the end of every package.json in `peerDependencies`, `dependencies`, `devDependencies` order, omitting absent fields.
- Spell out command-line flags in their long form in package scripts, workflows, hooks, Compose files and documented commands whenever the tool provides one, for example `tsc --project`, `docker compose up --detach` and `git commit --message`.
- Use pnpm throughout. CI installs with `--frozen-lockfile`; checks must not silently install or modify dependencies.
- Share package compiler options and source include/exclude patterns in root tsconfig.base.json using `${configDir}`. Root tsconfig.test.json extends it with test-only overrides; package configs should only extend these shared configurations.
- Keep source and test files in the default package `tsconfig.json` project so editors apply the shared decorator settings to both. Use the test configuration for no-emit typechecking; production bundling stays limited to the package entry point.
- Every library must build with tsdown to separate CJS and ESM outputs and matching declarations. Maintain conditional `require` and `import` exports.
- Define `build` directly in each package's `package.json`; share options through `tsdown.config.mts`, not a build wrapper script.
- For public API renames, audit exports, services, decorators, injection tokens, source paths and current examples together. Inspect the actual npm archive, including declarations and source maps, for stale names before publication; preserve historical changelogs.
- Keep NestJS/SDK peer dependencies external and preserve decorator metadata. tsdown must run strict publint and attw checks. For build changes, also verify real consumer imports and Nest injection in both formats.
- Remove obsolete files and redundant wrappers after checking their references; prefer maintained tool features over custom validation scripts.
- Use Turbo streaming output, never TUI. Include shared build configuration in cache inputs and release change detection.
- Keep necessary executable scripts typed as `.mts` and run them through `tsx`; tests remain `*.test.ts`. Include both in the root typecheck and remove redundant setup wrappers.
- Prefer typed `.mts` configuration wherever the tool supports it. Keep required native formats such as `biome.json`, `turbo.json`, and `mise.toml`.

## Formatting and tests

- Keep these small package adapters flat: source files and colocated tests belong directly in each package's `src/`, without a `src/lib/` wrapper.

- Biome must cover every supported file throughout the repository, including root files and examples. Exclude generated/dependency state, not source directories.
- Use Prettier only for unsupported Markdown/YAML. Keep formatters from rewriting each other's files.
- Use braces for control-flow bodies, including single-statement branches and loops. Biome enforces `useBlockStatements`.
- Separate class methods, including constructors, with a blank line. Write nonempty `@Module({ ... })` metadata objects across multiple lines; keep Biome object expansion at its default `auto` behavior.
- Name all test files `*.test.ts`, with middleware E2E tests named `*.e2e.test.ts`. Use `fixtures` for any necessary fixture directories; remove stale fixture exclusions and unused assets.
- Write unit tests for meaningful behavior: signing rules, configuration isolation, lifecycle management, error propagation and regressions. Do not add trivial framework/getter tests or tests mirroring the implementation.
- Where middleware integration needs E2E coverage, provide Docker Compose services with health checks and `docker:up` / `docker:down` scripts. Use isolated local services; always clean up after tests.
- Default unit tests must not require cloud credentials or network services. PostgreSQL E2E runs separately with `pnpm test:e2e`.
- Run artifact consumer checks separately with `pnpm test:packaging` after building. Keep packaging tests out of the default unit test run so a clean checkout works without `dist`.
- Maintain working package examples and current API/runtime requirements in package READMEs. Do not recreate the retired migration guide.

## Multiple client registrations

- Keep named client registrations isolated: credentials, endpoints, service options and lifecycle cleanup must belong to the selected alias. Preserve default registration when no alias is supplied.
- Use NestJS `@Inject()` directly instead of custom injection-decorator wrappers. Named provider tokens use a readable `<BASE_TOKEN>_<alias>` suffix; retain the default token for unnamed registrations.
- Keep `MODULE_OPTIONS_TOKEN` internal. Public entry points must not expose it, including indirectly through `export *`; expose package-specific helpers such as `getFoobarOptionsToken(alias?)` and prefer those helpers wherever they are available.
- Declare asynchronous registration aliases in module extras, outside the options factory. Document each adapter's call shape and require distinct aliases for clients injected together.
- Verify multiple registrations in one real Nest consumer, including default/named coexistence and shutdown. Check CJS and ESM consumers for injection changes; use Compose E2E when database behavior is involved.

## Verification and Git workflow

- Before implementation, record a plan and checklist in GitHub issues. Link implementation PRs to those issues and keep their status accurate.
- Parallelize independent work when requested; isolate overlapping edits and validate the integrated result.
- Run relevant checks: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` (including strict publint/attw checks). Run Compose E2E for middleware changes.
- Lefthook pre-commit runs lint, formatting and staged Gitleaks; commit-msg runs commitlint; pre-push runs build and typecheck. GitHub CI uses `jdx/mise-action` and runs tests.
- Use Conventional Commit titles/messages. Mark breaking public/runtime requirements with `!` or a `BREAKING CHANGE:` footer.
- Do NOT append `Co-Authored-By` lines to commit messages. Pass `--body ''` to `gh pr merge` to suppress generated squash-message trailers.
- Main requires a squash PR, the GitHub Actions `Validate` check, resolved conversations and an up-to-date branch. There are no bypass actors; zero mandatory approvals support solo maintenance. Force pushes and deletion are forbidden. Automated release PRs dispatch full CI on their exact head. Dispatched job checks alone do not satisfy PR protection: report a Checks API `Validate` result only after verifying the actual CI repository, workflow, commit and successful job, with its run link. Never fabricate success or weaken protection if the reported check is not accepted. Preserve validated head/base/tree guards.
- Merge only verified revisions. When the maintainer authorizes merging, continue through passing PRs without repeatedly asking for approval.
- Check GitHub Code scanning between PRs. Record actionable warnings in issues, fix them in linked PRs, and confirm default-branch alerts are resolved after analysis. Do not dismiss warnings just to clear the dashboard.

## Releases and maintenance

- Changesets is the single versioning engine. Every PR with publishable package changes must include an explicit Changeset naming the affected packages, bump types and user-facing summary. The agent implementing the change writes this file as part of the PR; commit messages do not infer versions.
- Honor explicit maintainer-requested coordinated releases through a changeset; Changesets combines all pending requests into one bump per package.
- Only changed packages are versioned/published. Do not introduce a competing semantic-release publisher or release unchanged packages for documentation-only edits.
- All ten established integrations participate in native Changesets versioning and publication. Keep established packages out of `ignore`; verify any future package's first publication and trusted publisher before enabling its automated publication. Do not introduce a custom publication wrapper.
- A new package that does not exist on npm stays in Changesets `ignore` until its owner-authenticated first publication and trusted publisher are verified; `docs/releases.md` lists held packages (none today) and the procedure. Write Changesets for held packages in files naming only held packages: a mixed file fails `changeset version` and blocks every release.
- `nestjs-slightly-better-auth` implements the HTTP scope of its reviewed design, published as `1.0.0`, and WebSocket gateways through its `./websockets` entry; GraphQL and RPC transports and its conformance kit follow as minor versions. It releases like every other package. Follow its package instructions and preserve its MIT licenses and historical design material.
- Prepare and publish only the workflow event commit (`github.sha`). Never publish in the run that merges a version PR: when the publication gate is enabled, dispatch a fresh Release run after the protected merge. Verify its event SHA, preparation base and checkout agree, so signed provenance describes the actual artifact source.
- npm publishing uses trusted-publisher OIDC and provenance. Keep the established integrations' configured release gate enabled. New packages need an owner-authenticated first publication and trusted-publisher setup before joining automated publication; do not disable established releases merely because an unfinished package remains private.
- Every package's npm trusted publisher is registered with the workflow filename `release.yml`, and npm checks the calling workflow file of an OIDC publication. Never rename or move `.github/workflows/release.yml`; run publication only in it or in a reusable workflow it calls.
- Group npm and GitHub Actions Dependabot version updates in one multi-ecosystem PR. Keep Node type declarations aligned with the selected LTS major; security updates may follow GitHub's separate grouping behavior.
- Keep README badges, package entry points, licenses and release instructions accurate. Never claim an unpublished package is already available on npm.

- Package README headers must contain exactly three badges in this order: npm version, npm monthly downloads, CI. The root README header keeps only CI and License badges.
