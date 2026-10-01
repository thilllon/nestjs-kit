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
pnpm test:packaging
```

Run `pnpm format` to apply formatting. Biome covers all supported files throughout the repository, including root configuration and examples. Markdown and YAML use Prettier because [Biome does not yet support those languages](https://biomejs.dev/internals/language-support/). Generated files and dependencies follow `.gitignore`; source directories are not excluded. Prettier, commitlint, and Vitest use typed `.mts` configuration files.

Run a single package's unit tests with, for example, `pnpm test packages/nestjskit__s3`. Keep unit tests focused on behavior such as error propagation, connection cleanup, configuration isolation, and signing rules. Do not add tests merely to repeat framework behavior or trivial getters. Unit tests run without cloud credentials or a database. Name tests `*.test.ts` and middleware integration tests `*.e2e.test.ts`. Store necessary test assets in `fixtures` directories, and remove unused fixtures and stale configuration exclusions.

Run `pnpm test:packaging` after `pnpm build` to check real Node consumers of the built ESM and CJS artifacts of every package with a `src/packaging.test.ts`. These checks are separate from default unit tests so a clean checkout does not need generated files before running `pnpm test`. CI runs them again on the Node.js version at the floor of each package's `engines.node` range.

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
| Valkey     | 56380        | `VALKEY_PORT`   |

Set an override consistently for Compose and the test command if a port is occupied. The suite covers Drizzle queries, LISTEN/NOTIFY delivery and connection cleanup, HTTP authentication and authorization, native RPC credential carriers over TCP, gRPC and each broker, and Redis client registrations against Redis and Valkey. Local HTTP/TCP/gRPC listeners use ephemeral ports. Always stop the test services afterward; CI does so even on failure. PostgreSQL and RabbitMQ data are temporary, Redis and Valkey persistence is disabled, and `docker:down` removes the fixture volumes.

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

Each workspace project declares its own dependencies. The root `devDependencies` hold only shared tooling: the tools that root scripts, configuration files, Git hooks and workflows run, and the compiler, bundler and script runner that packages invoke from the root. A project resolves its peer dependencies through its own `devDependencies`, so an example application and the package it imports share one `@nestjs/core` instance only when both resolve the same `@nestjs/core` peer variant. The example tests fail to boot when the variants diverge.

Each package's `build` command invokes tsdown directly with the shared `tsdown.config.mts`. Outputs are `dist/index.mjs`, `dist/index.cjs`, and their `.d.mts`/`.d.cts` declarations. Preserve the format-specific `exports` branches and keep dependencies external. Builds run strict publint and Are the Types Wrong checks directly through tsdown; no separate build or package-check wrapper is needed. When changing build settings, also verify real CJS/ESM imports and Nest dependency injection from the generated outputs.

Package TypeScript settings live in root `tsconfig.base.json`. Its `${configDir}` paths resolve relative to each package, so package configs only need `extends`. Root `tsconfig.test.json` extends the base and enables checking tests without emitting files; each package’s test config inherits it. Root tooling uses `tsconfig.tools.json` for its different source layout.
