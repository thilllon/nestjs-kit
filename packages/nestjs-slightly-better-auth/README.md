# nestjs-slightly-better-auth

[![npm version](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![Monthly downloads](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

A NestJS integration for [Better Auth](https://www.better-auth.com), under development in the NestJS Kit monorepo.

> **Private implementation in progress.** This workspace is not currently available on npm. The Nest authentication kernel, construction plugin and Express/Fastify platforms are implemented. Admin, organization, API-key and RPC integrations are implemented on the development branch. Other transports, conformance and release acceptance remain in progress. The npm badges will become available after the first real release.

## Implementation status

The library separates a Better Auth construction plugin, a NestJS integration kernel and optional transports. The `./plugin` entry installs the hook and cookie bridge before Better Auth creates its pipeline. The `./platform` entry provides Node/Web request and response helpers. Neither entry requires Express, Fastify, GraphQL or WebSocket packages.

The root entry provides synchronous and asynchronous module registration, default and named instances, service readers, guards, scoped execution and compositional authorization. Tests exercise actual Nest dependency injection and Better Auth sessions, including isolation between instances, caller-origin enforcement and application shutdown. Built ESM and CommonJS consumers verify the same registration and type contracts.

The `./express` and `./fastify` entries connect native Nest applications to Better Auth. Their end-to-end tests cover raw bodies, size limits, cookies, CORS, request cancellation, exception filters and real authentication. Fastify also supports HTTP/2. The platform entries have no runtime imports of Express or Fastify; install the Nest platform adapter used by your application.

Fastify does not expose its configured `trustProxy` value through a public inspection API. The boot summary therefore reports proxy trust as `unknown`, and diagnostics that depend on the setting are unavailable. Client IP resolution still uses the native Fastify request. Configure proxy trust on your Nest Fastify adapter and verify it against your deployment topology.

GraphQL, WebSocket and microservice integrations have separate implementation and end-to-end acceptance gates. They will use optional entry points so applications can install the transports they use. HTTP platform tests do not establish that those integrations are ready.

The `./microservices` entry supports standalone and hybrid Nest microservices with gRPC, NATS, Kafka, RabbitMQ, MQTT 5 and payload credential carriers. TCP and Redis use an explicit payload envelope, `auth` by default. Carriers allow credential fields only; host and forwarding metadata do not turn a broker message into an HTTP request. Configure a static Better Auth base URL, or a fallback for dynamic URLs, because these transports have no HTTP origin.

For a hybrid application, pass `inheritAppConfig: true` both to Nest's `connectMicroservice()` and to `rpcTransport()`, or explicitly install the authentication guard and scope on message handlers. The latter coverage can be checked at startup; the inheritance option is an application assertion. Public messages remain public without credentials; protected messages with no matching credential carrier are unauthorized. Message authentication never refreshes cookies.

Native tests verify gRPC statuses 16/7/8 for authentication, authorization and throttling, and status 13 for redacted infrastructure failures. The Compose fixture exercises actual NATS, Kafka, RabbitMQ, MQTT 5 and Redis clients and servers. Those checks currently cover Nest 12.0.3; broader compatibility remains a release gate.

Start with the [design workspace](docs/design/README.md), [reviewed specification](docs/design/design-v7.md), [review ledger](docs/design/ledger.md) and [implementation plan](../../docs/superpowers/plans/2026-09-21-better-auth.md). Independent Better Auth, NestJS and security reviews approved the final v7 snapshot after resolving the round-6 and round-7 findings. The complete implementation is tracked in [issue #534](https://github.com/thilllon/nestjs-kit/issues/534); design approval does not make the proposed API available yet.

## Develop in this monorepo

From the repository root:

```sh
mise install
mise exec -- pnpm install
mise exec -- pnpm --filter nestjs-slightly-better-auth typecheck
mise exec -- pnpm --filter nestjs-slightly-better-auth build
mise exec -- pnpm test:packaging
```

The shared toolchain uses Node.js LTS, pnpm, tsdown, TypeScript and Vitest. Builds produce ESM and CommonJS artifacts with declarations. The `module-sync` export makes supported Node `import` and `require()` consumers share the same ESM module identity.

[Contributing](../../CONTRIBUTING.md) explains repository checks and PRs. See [package instructions](AGENTS.md) and [import provenance](docs/provenance.md) before working with the historical material.

## Release readiness

Keep this workspace private until its authentication API, runtime compatibility, security behavior and package contents are reviewed and tested. The first real publication also needs the owner's npm authentication and trusted-publisher setup for `thilllon/nestjs-kit/release.yml`; see [release automation](../../docs/releases.md). Existing integrations continue releasing independently.

## License

[MIT](LICENSE). The archived upstream adapter retains its [original MIT notice](legacy/LICENSE).
