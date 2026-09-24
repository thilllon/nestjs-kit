# nestjs-slightly-better-auth

[![npm version](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![Monthly downloads](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

A NestJS integration for [Better Auth](https://www.better-auth.com), built on an independently reviewed specification.

> **Scope.** The package covers HTTP and GraphQL: the Nest authentication kernel, the Better Auth construction plugin, the Express and Fastify platforms, the admin, organization and API-key authorization units, and the Apollo and Mercurius transports of the `./graphql` entry. WebSocket and RPC transports and the conformance testing kit are not included; they ship in later minor versions behind their own entry points. The [changelog](CHANGELOG.md) records the version that adds each entry point.

## Install

```sh
pnpm add nestjs-slightly-better-auth better-auth
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` 12, `better-auth` 1.7.5 or newer, `reflect-metadata` and `rxjs`. Node.js 24.11 or newer.

The `./graphql` entry has two optional peer dependencies, `@nestjs/graphql` ^14.0.2 and `graphql` ^16.14.2, plus the Nest driver of your GraphQL server:

```sh
# Apollo on Express
pnpm add @nestjs/graphql graphql @nestjs/apollo @apollo/server @as-integrations/express5
# Mercurius on Fastify
pnpm add @nestjs/graphql graphql @nestjs/mercurius mercurius @nestjs/platform-fastify
```

## What the package covers

The library separates a Better Auth construction plugin, a NestJS integration kernel and optional transports. The `./plugin` entry installs the hook and cookie bridge before Better Auth creates its pipeline. The `./platform` entry provides Node/Web request and response helpers. Neither entry requires Express, Fastify, GraphQL or WebSocket packages.

The root entry provides synchronous and asynchronous module registration, default and named instances, service readers, guards, scoped execution and compositional authorization. Tests exercise actual Nest dependency injection and Better Auth sessions, including isolation between instances, caller-origin enforcement and application shutdown. Built ESM and CommonJS consumers verify the same registration and type contracts.

The `./express` and `./fastify` entries connect native Nest applications to Better Auth. Their end-to-end tests cover raw bodies, size limits, cookies, CORS, request cancellation, exception filters and real authentication. Fastify also supports HTTP/2. The platform entries have no runtime imports of Express or Fastify; install the Nest platform adapter used by your application.

Express preserves native controller parsing for unconditional routes that overlap the auth mount. Body-capable controller routes that also depend on host or non-URI version conditions are rejected at startup with `CONDITIONAL_ROUTE_SHADOW`; move them outside the auth mount. The integration checks the effective Express router flags because changing application settings after router creation does not change existing route matching. This is a tested Express 5 compatibility boundary, not an inspection of the router stack.

Fastify does not expose its configured `trustProxy` value through a public inspection API. The boot summary therefore reports proxy trust as `unknown`, and diagnostics that depend on the setting are unavailable. Client IP resolution still uses the native Fastify request. Configure proxy trust on your Nest Fastify adapter and verify it against your deployment topology.

WebSocket and microservice integrations have separate implementation and end-to-end acceptance gates. They will use optional entry points so applications can install the transports they use. HTTP and GraphQL tests do not establish that those integrations are ready.

Start with the [design workspace](docs/design/README.md), [reviewed specification](docs/design/design-v7.md), [review ledger](docs/design/ledger.md) and [implementation plan](../../docs/superpowers/plans/2026-09-21-better-auth.md). Independent Better Auth, NestJS and security reviews approved the final v7 snapshot after resolving the round-6 and round-7 findings. The remaining entry points are tracked in [issue #534](https://github.com/thilllon/nestjs-kit/issues/534).

## GraphQL

The `./graphql` entry provides `apolloTransport()` for `@nestjs/apollo` and `mercuriusTransport()` for `@nestjs/mercurius`. Queries, mutations, subscriptions and federation reference resolvers use the same access decorators, principal parameters and authorization units as controllers. Only this entry imports `@nestjs/graphql` and `graphql`.

Create the Better Auth instance with the construction plugin. The example stores data in PostgreSQL through `pg`, which the commands above do not install; add it with `pnpm add pg` or pass another [Better Auth database](https://www.better-auth.com/docs/concepts/database):

```ts
// auth.ts
import { betterAuth } from "better-auth";
import { nestjs } from "nestjs-slightly-better-auth/plugin";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  emailAndPassword: { enabled: true },
  plugins: [nestjs()],
});
```

Register the GraphQL module and the transport that matches its driver:

```ts
// app.module.ts
import { ApolloDriver, type ApolloDriverConfig } from "@nestjs/apollo";
import { Module } from "@nestjs/common";
import { GraphQLModule, Query, Resolver } from "@nestjs/graphql";
import {
  type AuthPrincipal,
  BetterAuthModule,
  CurrentPrincipal,
  Public,
} from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { apolloTransport } from "nestjs-slightly-better-auth/graphql";
import { auth } from "./auth";

@Resolver()
export class ViewerResolver {
  @Query(() => String)
  viewer(@CurrentPrincipal() principal: AuthPrincipal) {
    return principal.userId;
  }

  @Query(() => String)
  @Public()
  health() {
    return "ok";
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      subscriptions: { "graphql-ws": true },
      fieldResolverEnhancers: ["guards", "filters"],
    }),
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      transports: [apolloTransport()],
    }),
  ],
  providers: [ViewerResolver],
})
export class AppModule {}
```

For Mercurius, use `MercuriusDriver`, `fastifyPlatform()` from `nestjs-slightly-better-auth/fastify` and `mercuriusTransport()`. `mercuriusSubscriptionContext()` returns a Mercurius `subscription.context` function that keeps the upgrade request and its original browser headers with every socket operation; the socket tests cover Mercurius with and without it. A custom GraphQL `context` must be a function that returns a fresh object for every operation; for Apollo, it keeps the native request at `context.req` or `context.extra.request`. Startup fails with `GRAPHQL_STATIC_CONTEXT` for a static context object and with `GRAPHQL_DRIVER_MISMATCH` when the transport does not match the configured driver.

### Operations and fields

Each root field of an operation is authorized independently, so aliases and batched operations can share one session read while receiving different organization decisions. A denied field produces a GraphQL error whose `extensions` contain `code`, `statusCode` and, where applicable, `reason`. Authentication infrastructure failures surface as `Internal server error` with `code: "INTERNAL_SERVER_ERROR"` and `reason` `AUTH_UNAVAILABLE` or `AUTH_MISCONFIGURED`; the underlying error never reaches the client. Better Auth's browser-origin check applies to HTTP mutations and to every socket operation.

Field resolvers without access decorators inherit the principal of their actual ancestor operation, including across named instances. Protecting field and reference resolvers requires Nest to run guards on them: set `fieldResolverEnhancers: ["guards", "filters"]`, and add `"interceptors"` when those fields use scoped service readers. With `"guards"` enabled, Nest runs every global guard once per field invocation, and the boot advice `W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS` names the affected guards and interceptors. A field resolver that declares access metadata without field guards fails startup with `FIELD_RESOLVER_UNGUARDED`; `fieldResolverCoverage: "warn" | "off"` relaxes that check. Without `"filters"`, Nest does not route field errors through its exception pipeline, so they are not logged; the library then emits `W_FIELD_EXCEPTION_FILTERS_DISABLED`. With filters enabled, repeated infrastructure and reader errors produce one Nest ERROR per logical request while every affected field receives a safe error.

### Subscriptions and socket operations

Socket operations authenticate each operation independently from the WebSocket upgrade request and never refresh the session. Browser-origin checks always use the original upgrade headers, before any session read, so connection parameters cannot replace the browser's `Origin`. The platform's own request predicate classifies HTTP operations before socket detection, so a client-sent `Upgrade: websocket` header on an HTTP operation keeps the platform client IP, response cookie forwarding and the completed-request check. Mercurius identifies sockets only through its subscription context, never through request headers.

By default, `authorization` and `cookie` values in the `connection_init` payload replace the matching upgrade headers. `connectionParamHeaders` replaces that list of keys, matched case-insensitively. A selected value that is not a string or is not a valid header value rejects the operation with `UNAUTHENTICATED` and `reason: "MALFORMED_CREDENTIALS"`, without falling back to another credential and without echoing the value in errors or logs.

`subscriptionCredentials(connectionContext)` replaces this mapping. The `HeadersInit` it returns becomes the operation's credentials, and `host`, `x-forwarded-host` and `x-forwarded-proto` are copied from the upgrade request when absent. Returning `undefined` presents no credentials, and `connectionParamHeaders` is not consulted. Invalid header values reject with `MALFORMED_CREDENTIALS`; errors thrown by the function are application errors, not credential denials.

`subscriptionPrincipalTtlMs` reuses a connection's principal for that many milliseconds. The default `0` resolves the principal for every socket operation. A positive value delays the effect of session revocation on open connections by up to the TTL; routes with `@RequireAuth({ authoritative: true })` always resolve a fresh principal.

### Federation

Both transports support `ApolloFederationDriver` and `MercuriusFederationDriver` with schema-first schemas and code-first federation versions 1 and 2. `@ResolveReference()` resolvers are always checked: without field guards, startup fails with `FEDERATION_FIELD_GUARDS_REQUIRED` or `REFERENCE_RESOLVER_UNGUARDED`, and `federationCoverage` relaxes the check.

Federation schema generation in `@nestjs/graphql` loads `@apollo/subgraph`, which the install commands above do not include. Federation applications must install a compatible version, for example `pnpm add @apollo/subgraph@^2.15.1`; otherwise startup fails before authentication runs. `@apollo/subgraph` 2.15 requires `@nestjs/graphql` 14.0.2 or newer, as described under [Supported versions](#supported-versions).

### Supported versions

The native GraphQL tests run Nest 12.0.3 with `@nestjs/graphql`, `@nestjs/apollo` and `@nestjs/mercurius` 14.0.2, `graphql` 16.14.2, `@apollo/server` 5.5.1, `mercurius` 16.10.0, `@mercuriusjs/federation` 5.1.1 and `@apollo/subgraph` 2.15.1. Code-first federation with `@apollo/subgraph` 2.15 requires `@nestjs/graphql` 14.0.2 or newer. With `@nestjs/graphql` 14.0.1, schema generation fails before authentication runs: federation 1 cannot load the subgraph directives module that 2.15 removed, and federation 2 fails with `TypeError: doc.definitions is not iterable`. The `@nestjs/graphql` peer range therefore starts at 14.0.2.

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

## Releases

Versions come from Changesets, and publication runs from the monorepo's release workflow with npm trusted publishing and provenance; see [release automation](../../docs/releases.md). New entry points are additive, so they ship as minor versions.

## License

[MIT](LICENSE). The archived upstream adapter retains its [original MIT notice](legacy/LICENSE).
