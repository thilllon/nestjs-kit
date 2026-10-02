# Contributing

Choose the package you want to improve from the [package directory](README.md#packages). For bugs, include the package version, Node.js version, and a minimal reproduction. For changes to public behavior, explain the expected behavior before opening a large pull request.

## Setup

Install [mise](https://mise.jdx.dev/getting-started.html) and [activate it in your shell](https://mise.jdx.dev/getting-started.html#activate-mise), then:

```sh
git clone https://github.com/thilllon/nestjs-kit.git
cd nestjs-kit
mise trust
mise install
pnpm install
```

`mise.toml` selects the latest Node.js LTS and pins stable pnpm, Lefthook, and Gitleaks; the activated shell runs every command with these versions. Do not update the lockfile with another package manager.

The mise `postinstall` hook runs `lefthook install`, including on a repeated `mise install` when the tools are already present. `mise run setup` installs dependencies and refreshes hooks; `lefthook install` can repair hooks explicitly.

## Checks

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test
pnpm exec turbo run test:packaging
```

Run `pnpm format` to apply formatting. Biome covers all supported files throughout the repository, including root configuration and examples. Markdown and YAML use Prettier because [Biome does not yet support those languages](https://biomejs.dev/internals/language-support/). Generated files and dependencies follow `.gitignore`; source directories are not excluded. Prettier, commitlint, and Vitest use typed `.mts` configuration files.

`pnpm test` runs every workspace project's `test` script through Turbo. Run a single project's unit tests with, for example, `pnpm --filter @nestjs-kit/s3 test`, and a single file with `pnpm --filter @nestjs-kit/s3 test src/s3.module.test.ts`. Each project's `vitest.config.mts` combines the options in root `vitest.shared.mts` with the project's own `vitest` and `unplugin-swc`, and defines the `unit`, `e2e` and `packaging` Vitest projects that the `test`, `test:e2e` and `test:packaging` scripts select. Keep unit tests focused on behavior such as error propagation, connection cleanup, configuration isolation, and signing rules. Do not add tests merely to repeat framework behavior or trivial getters. Unit tests run without cloud credentials or a database. Name tests `*.test.ts` and middleware integration tests `*.e2e.test.ts`. Store necessary test assets in `fixtures` directories, and remove unused fixtures and stale configuration exclusions.

Each package with `src/packaging*.test.ts` files has a `test:packaging` script that checks real Node consumers of its built ESM and CJS artifacts. `pnpm exec turbo run test:packaging` builds and checks every such package; `pnpm --filter nestjs-strategy test:packaging` checks one package after its build. These checks are separate from default unit tests so a clean checkout does not need generated files before running `pnpm test`. CI runs each package's script again on the Node.js version at the floor of that package's `engines.node` range.

Each package with `*.e2e.test.ts` files has a `compose.yaml` that declares only the services its tests use, and `docker:up`, `docker:down` and `test:e2e` scripts. For integration tests against real databases and message brokers, install Docker with Compose and run one package at a time:

```sh
pnpm --filter nestjs-drizzle-pg docker:up
pnpm --filter nestjs-drizzle-pg test:e2e
pnpm --filter nestjs-drizzle-pg docker:down
```

| Package                       | Services                                         |
| ----------------------------- | ------------------------------------------------ |
| `nestjs-drizzle-pg`           | PostgreSQL                                       |
| `nestjs-pg-listen`            | PostgreSQL                                       |
| `@nestjs-kit/redis`           | Redis, Valkey                                    |
| `nestjs-slightly-better-auth` | PostgreSQL, NATS, Kafka, RabbitMQ, MQTT 5, Redis |

Packages share the default ports, so stop one package's services before starting another's. Compose starts isolated services, binds their client ports to `127.0.0.1`, and waits for health checks:

| Service    | Default port | Override        |
| ---------- | ------------ | --------------- |
| PostgreSQL | 55432        | `PGPORT`        |
| NATS       | 54222        | `NATS_PORT`     |
| Kafka      | 59092        | `KAFKA_PORT`    |
| RabbitMQ   | 55672        | `RABBITMQ_PORT` |
| MQTT 5     | 51883        | `MQTT_PORT`     |
| Redis      | 56379        | `REDIS_PORT`    |
| Valkey     | 56380        | `VALKEY_PORT`   |

Set an override consistently for Compose and the test command if a port is occupied. The suites cover Drizzle queries, LISTEN/NOTIFY delivery and connection cleanup, HTTP authentication and authorization, native RPC credential carriers over TCP, gRPC and each broker, and Redis client registrations against Redis and Valkey. Local HTTP/TCP/gRPC listeners use ephemeral ports. Always stop the test services afterward; CI runs each package's services in that package's own E2E job and stops them even on failure. PostgreSQL and RabbitMQ data are temporary, Redis and Valkey persistence is disabled, and `docker:down` removes the fixture volumes.

Lefthook checks lint, formatting, and staged secrets before a commit; before a push, it checks builds and types. Commit messages are checked with commitlint. CI uses the same mise toolchain.

### CI

`.github/workflows/ci.yml` runs on pull requests, pushes to `main` and Release workflow dispatches:

| Job                                           | Runs                                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Detect affected packages`                    | Builds the package and E2E matrices                                                                                                                            |
| `Repository checks`                           | PR title, `pnpm lint`, `pnpm format:check`, `tsc --project tsconfig.tools.json`, Gitleaks                                                                      |
| One job per package                           | The Turbo `typecheck`, `test`, `build` and `test:packaging` tasks for the package and its examples, then `test:packaging` on the engines-floor Node.js version |
| One E2E job per package with a `compose.yaml` | Build, `docker:up`, `test:e2e`, `docker:down`                                                                                                                  |
| `Validate`                                    | Fails unless every job above succeeds; a matrix job may be skipped only when its matrix is empty                                                               |

Package and E2E jobs run in parallel. A pull request runs only the packages that `turbo ls --affected` reports against its base, which includes the dependents of a changed package; a change in an example selects its package. A pull request that changes a file outside `packages/` runs every package, unless the file is Markdown or is in `docs/`, `LICENSE`, `.github/ISSUE_TEMPLATE/` or `.github/dependabot.yml`. A pull request that changes only Markdown runs no package or E2E job. Pushes to `main` and Release dispatches run every package.

Branch protection requires `Validate` only. A new push to a pull request cancels that pull request's running checks.

## Pull requests and commits

Use a Conventional Commit title to describe the change:

- `fix(s3): preserve custom endpoint configuration`
- `feat(cloudinary): support a new upload option`
- `docs: clarify installation`
- `feat(pubnub)!: require the current SDK configuration`

Explain breaking changes in the PR description and update the affected package README. Prefer one concern per PR and squash merge with the Conventional Commit title. Do not add `Co-Authored-By` trailers.

Package versions and changelogs are maintained by release automation. Do not manually bump versions for ordinary feature or fix PRs. Include an explicit Changeset in every PR with publishable package changes. Run `pnpm exec changeset` to select affected packages, bump types and a user-facing summary. Packages awaiting their first npm release are held in Changesets `ignore` and are not offered there; write their Changesets by hand in a separate file that names only held packages (see [packages awaiting first publication](docs/releases.md#packages-awaiting-first-publication)). Commit messages do not determine versions. Documentation, tests and repository-only tooling changes need no Changeset. See [releases](docs/releases.md).

## Repository layout

- `packages/nestjs-azure-storage-blob`: the Azure Blob Storage adapter.
- `packages/nestjs-drizzle-pg`: the Drizzle ORM adapter for PostgreSQL.
- `packages/nestjs-pg-listen`: the PostgreSQL notifications adapter.
- `packages/nestjs-pubnub`: the PubNub realtime messaging adapter.
- `packages/nestjs-sendbird`: the Sendbird Platform API adapter.
- `packages/nestjs-sendgrid`: the Twilio SendGrid adapter.
- `packages/nestjs-slightly-better-auth`: the Better Auth integration, with its design workspace, research and historical adapter reference. Its `examples` directory holds private Express, Fastify, Apollo GraphQL, Socket.IO and TCP microservice applications; their unit tests boot each application, and releases skip them.
- `packages/nestjs-strategy`: strategy-pattern registries for Nest providers.
- `packages/nestjskit__cloudinary`: `@nestjs-kit/cloudinary`, the Cloudinary upload adapter.
- `packages/nestjskit__nodemailer`: `@nestjs-kit/nodemailer`, the Nodemailer email adapter.
- `packages/nestjskit__redis`: `@nestjs-kit/redis`, Redis and Valkey client registrations.
- `packages/nestjskit__s3`: `@nestjs-kit/s3`, the S3-compatible storage adapter.
- `.github/workflows`: CI, dependency maintenance, and releases.
- `docs`: maintainer guides.

Keep public exports in each package's `src/index.ts`; avoid importing another package's internal source files. A package must declare the dependencies its consumers need.

Each workspace project declares its own dependencies. A package or example application lists every tool its scripts and configuration files use: `typescript`, `@types/node`, `vitest`, `unplugin-swc` and `@swc/core`, plus `tsdown` and its checkers in a library. The root `devDependencies` hold only repository-wide tooling:

| Root dependency                                      | Reason                                                                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@biomejs/biome`                                     | `pnpm lint`, `pnpm format` and the pre-commit hook                                                                                                                                   |
| `prettier`                                           | Markdown and YAML formatting in `pnpm format` and `pnpm format:check`                                                                                                                |
| `@changesets/cli`                                    | versioning and `pnpm release:publish`                                                                                                                                                |
| `@commitlint/cli`, `@commitlint/config-conventional` | the commit-msg hook and the CI pull request title check                                                                                                                              |
| `@commitlint/types`                                  | types `commitlint.config.mts`                                                                                                                                                        |
| `turbo`                                              | runs the `build`, `typecheck`, `test` and `test:packaging` tasks                                                                                                                     |
| `typescript`, `@types/node`                          | commitlint loads `commitlint.config.mts` through a loader that requires both as peers, and `tsc --project tsconfig.tools.json` typechecks every `.mts` configuration file and script |

Root files that packages share import nothing but Node.js built-ins, so the root needs neither a bundler nor a test runner. A project resolves its peer dependencies through its own `devDependencies`, so an example application and the package it imports share one `@nestjs/core` instance only when both resolve the same `@nestjs/core` peer variant. The example tests fail to boot when the variants diverge.

Each package's `build` command invokes tsdown directly with the shared `tsdown.config.mts`. Outputs are `dist/index.mjs`, `dist/index.cjs`, and their `.d.mts`/`.d.cts` declarations. Preserve the format-specific `exports` branches and keep dependencies external. Builds run strict publint and Are the Types Wrong checks directly through tsdown; no separate build or package-check wrapper is needed. tsdown resolves both checkers as its optional peers, so each package declares `tsdown`, `publint` and `@arethetypeswrong/core` in its own `devDependencies`. When changing build settings, also verify real CJS/ESM imports and Nest dependency injection from the generated outputs.

Package TypeScript settings live in root `tsconfig.base.json`. Its `${configDir}` paths resolve relative to each package, so package configs only need `extends`. Root `tsconfig.test.json` extends the base and enables checking tests without emitting files; each package’s test config inherits it. Root `tsconfig.tools.json` typechecks the `.mts` configuration files and scripts of the root, the packages and the example applications; each file resolves its imports from its own project's dependencies.
