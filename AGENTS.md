# Repository instructions

Keep this file current as maintainer decisions change. `CLAUDE.md` imports this file; do not duplicate the rules there.

## Package identities

- Preserve `nestjs-azure-storage-blob` and `nestjs-drizzle-pg`, including their existing folder names.
- Scoped packages use npm names `@nestjs-kit/<name>` and folders `packages/nestjskit__<name>`.
- `nestjs-pg-listen` is an explicitly requested unscoped package in `packages/nestjs-pg-listen`.
- Do not publish to the retired `@nestjs-tools/*` scope or delete its npm packages. The owner handles their retirement.
- Check registry ownership and published versions before changing package identities or release baselines.

## Toolchain and builds

- Use mise and the current Node.js LTS. pnpm has no LTS channel: pin a supported stable version and keep the lockfile current.
- Install Git hooks through mise's `postinstall = "lefthook install"` hook; do not introduce a redundant package prepare wrapper.
- Order existing package.json scripts with `typecheck`, `build`, then `dev` first in the root and every package; do not add missing commands just for ordering.
- Name type-checking scripts and Turbo tasks `typecheck`. Keep dependency fields at the end of every package.json in `peerDependencies`, `dependencies`, `devDependencies` order, omitting absent fields.
- Use pnpm throughout. CI installs with `--frozen-lockfile`; checks must not silently install or modify dependencies.
- Share package compiler options and source include/exclude patterns in root tsconfig.base.json using `${configDir}`. Root tsconfig.test.json extends it with test-only overrides; package configs should only extend these shared configurations.
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
- Name all test files `*.test.ts`, with middleware E2E tests named `*.e2e.test.ts`. Use `fixtures` for any necessary fixture directories; remove stale fixture exclusions and unused assets.
- Write unit tests for meaningful behavior: signing rules, configuration isolation, lifecycle management, error propagation and regressions. Do not add trivial framework/getter tests or tests mirroring the implementation.
- Where middleware integration needs E2E coverage, provide Docker Compose services with health checks and `docker:up` / `docker:down` scripts. Use isolated local services; always clean up after tests.
- Default unit tests must not require cloud credentials or network services. PostgreSQL E2E runs separately with `pnpm test:e2e`.
- Maintain working package examples and current API/runtime requirements in package READMEs. Do not recreate the retired migration guide.

## Verification and Git workflow

- Before implementation, record a plan and checklist in GitHub issues. Link implementation PRs to those issues and keep their status accurate.
- Parallelize independent work when requested; isolate overlapping edits and validate the integrated result.
- Run relevant checks: `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` (including strict publint/attw checks). Run Compose E2E for middleware changes.
- Lefthook pre-commit runs lint, formatting and staged Gitleaks; commit-msg runs commitlint; pre-push runs build and typecheck. GitHub CI uses `jdx/mise-action` and runs tests.
- Use Conventional Commit titles/messages. Mark breaking public/runtime requirements with `!` or a `BREAKING CHANGE:` footer.
- Do NOT append `Co-Authored-By` lines to commit messages. Pass `--body ''` to `gh pr merge` to suppress generated squash-message trailers.
- Main requires a squash PR, the GitHub Actions `Validate` check, resolved conversations and an up-to-date branch. There are no bypass actors; zero mandatory approvals support solo maintenance. Force pushes and deletion are forbidden. Automated release PRs dispatch CI on their exact head and wait for success before merging.
- Merge only verified revisions. When the maintainer authorizes merging, continue through passing PRs without repeatedly asking for approval.
- Check GitHub Code scanning between PRs. Record actionable warnings in issues, fix them in linked PRs, and confirm default-branch alerts are resolved after analysis. Do not dismiss warnings just to clear the dashboard.

## Releases and maintenance

- Changesets is the single versioning engine. Every PR with publishable package changes must include an explicit Changeset naming the affected packages, bump types and user-facing summary. The agent implementing the change writes this file as part of the PR; commit messages do not infer versions.
- Honor explicit maintainer-requested coordinated releases through a changeset; Changesets combines all pending requests into one bump per package.
- Only changed packages are versioned/published. Do not introduce a competing semantic-release publisher or release unchanged packages for documentation-only edits.
- npm publishing uses trusted-publisher OIDC and provenance. Leave `NPM_PUBLISH_ENABLED` disabled until the owner completes npm setup; new packages need an owner-authenticated first publication before trust can be configured.
- Group npm and GitHub Actions Dependabot version updates in one multi-ecosystem PR. Keep Node type declarations aligned with the selected LTS major; security updates may follow GitHub's separate grouping behavior.
- Keep README badges, package entry points, licenses and release instructions accurate. Never claim an unpublished package is already available on npm.

- Package README headers must contain exactly three badges in this order: npm version, npm monthly downloads, CI. The root README header keeps only CI and License badges.
