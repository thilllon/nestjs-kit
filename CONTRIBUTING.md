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

The mise `postinstall` hook runs `lefthook install`, including on a repeated `mise install` when the tools are already present. `mise run setup` installs dependencies and refreshes hooks; `mise exec -- lefthook install` can repair hooks explicitly.

## Checks

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm test:packaging
```

Run `pnpm format` to apply formatting. Biome covers all supported files throughout the repository, including root configuration and examples. Markdown and YAML use Prettier because [Biome does not yet support those languages](https://biomejs.dev/internals/language-support/). Generated files and dependencies follow `.gitignore`; source directories are not excluded. Prettier, commitlint, and Vitest use typed `.mts` configuration files.

Run a single package's unit tests with, for example, `pnpm test packages/nestjskit__s3`. Keep unit tests focused on behavior such as error propagation, connection cleanup, configuration isolation, and signing rules. Do not add tests merely to repeat framework behavior or trivial getters. Unit tests run without cloud credentials or a database. Name tests `*.test.ts` and middleware integration tests `*.e2e.test.ts`. Store necessary test assets in `fixtures` directories, and remove unused fixtures and stale configuration exclusions.

Run `pnpm test:packaging` after `pnpm build` to check real Node consumers of the built ESM and CJS artifacts of every package with a `src/packaging.test.ts`. These checks are separate from default unit tests so a clean checkout does not need generated files before running `pnpm test`.

For integration tests against real databases and message brokers, install Docker with Compose and run:

```sh
pnpm docker:up
pnpm test:e2e
pnpm docker:down
```

Compose starts isolated services, binds their client ports to `127.0.0.1`, and waits for health checks:

| Service    | Default port | Override        |
| ---------- | ------------ | --------------- |
| PostgreSQL | 55432        | `PGPORT`        |
| NATS       | 54222        | `NATS_PORT`     |
| Kafka      | 59092        | `KAFKA_PORT`    |
| RabbitMQ   | 55672        | `RABBITMQ_PORT` |
| MQTT 5     | 51883        | `MQTT_PORT`     |
| Redis      | 56379        | `REDIS_PORT`    |

Set an override consistently for Compose and the test command if a port is occupied. The suite covers Drizzle queries, LISTEN/NOTIFY delivery and connection cleanup, HTTP authentication and authorization, and native RPC credential carriers over TCP, gRPC and each broker. Local HTTP/TCP/gRPC listeners use ephemeral ports. Always stop the test services afterward; CI does so even on failure. PostgreSQL and RabbitMQ data are temporary, Redis persistence is disabled, and `docker:down` removes the fixture volumes.

Lefthook checks lint, formatting, and staged secrets before a commit; before a push, it checks builds and types. Commit messages are checked with commitlint. CI runs the repository checks, including tests, with the same mise toolchain.

## Pull requests and commits

Use a Conventional Commit title to describe the change:

- `fix(s3): preserve custom endpoint configuration`
- `feat(cloudinary): support a new upload option`
- `docs: clarify installation`
- `feat(pubnub)!: require the current SDK configuration`

Explain breaking changes in the PR description and update the affected package README. Prefer one concern per PR and squash merge with the Conventional Commit title. Do not add `Co-Authored-By` trailers.

Package versions and changelogs are maintained by release automation. Do not manually bump versions for ordinary feature or fix PRs. Include an explicit Changeset in every PR with publishable package changes. Run `pnpm exec changeset` to select affected packages, bump types and a user-facing summary. Packages awaiting their first npm release are held in Changesets `ignore` and are not offered there; write their Changesets by hand in a separate file that names only held packages (see [packages awaiting first publication](docs/releases.md#packages-awaiting-first-publication)). Commit messages do not determine versions. Documentation, tests and repository-only tooling changes need no Changeset. See [releases](docs/releases.md).

## Repository layout

- `packages/nestjskit__*`: packages published under `@nestjs-kit/*`.
- `packages/nestjs-azure-storage-blob`: the existing Azure npm package.
- `packages/nestjs-drizzle-pg`: the existing Drizzle npm package.
- `packages/nestjs-pg-listen`: the PostgreSQL notifications adapter.
- `packages/nestjs-sendbird`: the Sendbird Platform API adapter.
- `packages/nestjs-sendgrid`: the Twilio SendGrid adapter.
- `packages/nestjs-slightly-better-auth`: the Better Auth integration, with its design workspace, research and historical adapter reference.
- `packages/nestjs-strategy`: strategy-pattern registries for Nest providers.
- `examples/better-auth-*`: private example applications for `nestjs-slightly-better-auth` on Express, Fastify, Socket.IO and a TCP microservice. Their unit tests boot each application, and releases skip them.
- `.github/workflows`: CI, dependency maintenance, and releases.
- `docs`: maintainer guides.

Keep public exports in each package's `src/index.ts`; avoid importing another package's internal source files. A package must declare the dependencies its consumers need.

A workspace package resolves its peer dependencies through its own `devDependencies`, so an example application and the package it imports share one `@nestjs/core` instance only when both resolve the same `@nestjs/core` peer variant. The root `devDependencies` therefore include every optional peer of `@nestjs/core` (`@nestjs/microservices`, `@nestjs/platform-express` and `@nestjs/websockets`); pnpm resolves peers from the workspace root, so every project links the same variant. The example tests fail to boot when the variants diverge.

Each package's `build` command invokes tsdown directly with the shared `tsdown.config.mts`. Outputs are `dist/index.mjs`, `dist/index.cjs`, and their `.d.mts`/`.d.cts` declarations. Preserve the format-specific `exports` branches and keep dependencies external. Builds run strict publint and Are the Types Wrong checks directly through tsdown; no separate build or package-check wrapper is needed. When changing build settings, also verify real CJS/ESM imports and Nest dependency injection from the generated outputs.

The authentication workspace additionally puts `module-sync` first in its exports. Supported Node consumers then share one ESM identity for both `import` and `require()`, while the real CJS branch remains available when synchronous ESM loading is disabled. Keep its legacy code outside the active source graph and package archive; historical tests are reference material, not executed coverage.

Package TypeScript settings live in root `tsconfig.base.json`. Its `${configDir}` paths resolve relative to each package, so package configs only need `extends`. Root `tsconfig.test.json` extends the base and enables checking tests without emitting files; each package’s test config inherits it. Root tooling uses `tsconfig.tools.json` for its different source layout.
