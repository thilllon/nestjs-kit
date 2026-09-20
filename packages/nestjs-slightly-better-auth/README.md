# nestjs-slightly-better-auth

[![npm version](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![Monthly downloads](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

A planned NestJS integration for [Better Auth](https://www.better-auth.com), developed in the NestJS Kit monorepo.

> **Design phase — no authentication API is implemented yet.** This workspace is private and is not currently available on npm. Its entry point exports nothing. The npm badges will become available after the first real release.

## What is being designed

The proposal separates a Better Auth plugin, a NestJS integration kernel and optional transport integrations. It aims to support Express, Fastify, GraphQL, WebSockets and microservices without making every application install every transport.

The design covers named authentication instances, dependency injection, authorization, lifecycle management, request bodies and cookie forwarding. These are proposed capabilities, not features of the current scaffold.

Start with the [design workspace](docs/design/README.md), [current proposal](docs/design/design-v6.md) and [review ledger](docs/design/ledger.md). The sixth review round still has findings to resolve before implementation.

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
