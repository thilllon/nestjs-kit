# Contributing

Choose the package you want to improve from the [package directory](README.md#pick-an-integration). For bugs, include the package version, Node.js version, and a minimal reproduction. For changes to public behavior, explain the expected behavior before opening a large pull request.

## Setup

```sh
git clone https://github.com/thilllon/nestjs-kit.git
cd nestjs-kit
mise trust
mise install
mise exec -- pnpm install
```

Use `mise exec --` before commands, or activate mise in your shell. The repository selects the latest Node.js LTS and pins stable pnpm, Lefthook, and Gitleaks. Do not update the lockfile with another package manager.

The mise `postinstall` hook runs `lefthook install`, including on a repeated `mise install` when the tools are already present. `mise run setup` installs dependencies and refreshes hooks; `pnpm hooks:install` can repair hooks explicitly.

## Checks

```sh
pnpm lint
pnpm format:check
pnpm check-types
pnpm build
pnpm test
```

Run `pnpm format` to apply formatting. Biome covers all supported files throughout the repository, including root configuration and examples. Markdown and YAML use Prettier because [Biome does not yet support those languages](https://biomejs.dev/internals/language-support/). Generated files and dependencies follow `.gitignore`; source directories are not excluded. Prettier, commitlint, and Vitest use typed `.mts` configuration files.

Run a single package's unit tests with, for example, `pnpm test:unit packages/nestjskit__s3`. Keep unit tests focused on behavior such as error propagation, connection cleanup, configuration isolation, and signing rules. Do not add tests merely to repeat framework behavior or trivial getters. Unit tests run without cloud credentials or a database.

For real PostgreSQL integration tests, install Docker with Compose and run:

```sh
pnpm docker:up
pnpm test:e2e
pnpm docker:down
```

Compose starts an isolated PostgreSQL instance on `127.0.0.1:55432` and waits for its health check. The E2E suite verifies Drizzle queries, actual LISTEN/NOTIFY delivery, and connection cleanup. If the port is occupied, set `PGPORT` consistently for both Compose and the test command. Always stop the test services afterward; CI does so even on failure.

Lefthook checks lint, formatting, and staged secrets before a commit; before a push, it checks builds and types. Commit messages are checked with commitlint. CI runs the repository checks, including tests, with the same mise toolchain.

## Pull requests and commits

Use a Conventional Commit title so release automation can determine the change type:

- `fix(s3): preserve custom endpoint configuration`
- `feat(cloudinary): support a new upload option`
- `docs: clarify installation`
- `feat(pubnub)!: require the current SDK configuration`

Explain breaking changes in the PR description and migration guide. Prefer one concern per PR and squash merge with the Conventional Commit title. Do not add `Co-Authored-By` trailers.

Package versions and changelogs are maintained by release automation. Do not manually bump versions for ordinary feature or fix PRs. See [releases](docs/releases.md) for how Conventional Commits become package-specific Changesets.

## Repository layout

- `packages/nestjskit__*`: packages published under `@nestjs-kit/*`.
- `packages/nestjs-azure-storage-blob`: the existing Azure npm package.
- `packages/nestjs-drizzle-pg`: the existing Drizzle npm package.
- `packages/nestjs-pg-listen`: the PostgreSQL notifications adapter.
- `.github/workflows`: CI, dependency maintenance, and releases.
- `docs`: migration and maintainer guides.

Keep public exports in each package's `src/index.ts`; avoid importing another package's internal source files. A package must declare the dependencies its consumers need.

Each package's `build` command invokes tsdown directly with the shared `tsdown.config.mts`. Outputs are `dist/index.mjs`, `dist/index.cjs`, and their `.d.mts`/`.d.cts` declarations. Preserve the format-specific `exports` branches and keep dependencies external. Builds run strict publint and Are the Types Wrong checks directly through tsdown; no separate build or package-check wrapper is needed. When changing build settings, also verify real CJS/ESM imports and Nest dependency injection from the generated outputs.
