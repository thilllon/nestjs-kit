# nestjs-slightly-better-auth

[![npm version](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![Monthly downloads](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

A NestJS integration for [Better Auth](https://www.better-auth.com), built on an independently reviewed specification.

> **Scope.** The package covers HTTP, GraphQL, WebSocket and RPC authentication: the Nest authentication kernel, the Better Auth construction plugin, the Express and Fastify platforms, the admin, organization and API-key authorization units, the Apollo and Mercurius transports of the `./graphql` entry, the Socket.IO and raw `ws` gateway transports of the `./websockets` entry and the Nest microservice transport of the `./microservices` entry. The `./testing` entry provides consumer testing helpers and `./testing/conformance` reusable conformance kits. The [changelog](CHANGELOG.md) records the version that introduces each entry point.

## Install

```sh
pnpm add nestjs-slightly-better-auth better-auth
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` 12, `better-auth` 1.7.5 or newer, `reflect-metadata` and `rxjs`. Node.js 24.11 or newer. The `./testing` and `./testing/conformance` entries also need the optional peer `@nestjs/testing` 12; the root entry never loads it or a test runner.

The `./graphql` entry has two optional peer dependencies, `@nestjs/graphql` ^14.0.2 and `graphql` ^16.14.2, plus the Nest driver of your GraphQL server:

```sh
# Apollo on Express
pnpm add @nestjs/graphql graphql @nestjs/apollo @apollo/server @as-integrations/express5
# Mercurius on Fastify
pnpm add @nestjs/graphql graphql @nestjs/mercurius mercurius @nestjs/platform-fastify
```

The `./websockets` entry also needs the optional peer `@nestjs/websockets` 12 and the Nest adapter for your socket library:

```sh
pnpm add @nestjs/websockets @nestjs/platform-socket.io # Socket.IO
pnpm add @nestjs/websockets @nestjs/platform-ws # raw ws
```

The `./microservices` entry also needs the optional peer `@nestjs/microservices` 12 and the client library Nest uses for your transport, for example:

```sh
pnpm add @nestjs/microservices @nats-io/transport-node
```

Nest's gRPC transport uses `@grpc/grpc-js` and `@grpc/proto-loader`, Kafka uses `kafkajs`, RabbitMQ uses `amqplib` and `amqp-connection-manager`, MQTT uses `mqtt`, and Redis uses `ioredis`. TCP needs no client library. Applications that do not import `./microservices` do not need any of these packages.

## What this release covers

The library separates a Better Auth construction plugin, a NestJS integration kernel and optional transports. The `./plugin` entry installs the hook and cookie bridge before Better Auth creates its pipeline. The `./platform` entry provides Node/Web request and response helpers. Neither entry requires Express, Fastify, GraphQL, WebSocket or microservice packages.

The root entry provides synchronous and asynchronous module registration, default and named instances, service readers, guards, scoped execution and compositional authorization. Tests exercise actual Nest dependency injection and Better Auth sessions, including isolation between instances, caller-origin enforcement and application shutdown. Built ESM and CommonJS consumers verify the same registration and type contracts.

The `./express` and `./fastify` entries connect native Nest applications to Better Auth. Their end-to-end tests cover raw bodies, size limits, cookies, CORS, request cancellation, exception filters and real authentication. Fastify also supports HTTP/2. The platform entries have no runtime imports of Express or Fastify; install the Nest platform adapter used by your application.

Express preserves native controller parsing for unconditional routes that overlap the auth mount. Body-capable controller routes that also depend on host or non-URI version conditions are rejected at startup with `CONDITIONAL_ROUTE_SHADOW`; move them outside the auth mount. The integration checks the effective Express router flags because changing application settings after router creation does not change existing route matching. This is a tested Express 5 compatibility boundary, not an inspection of the router stack.

Fastify does not expose its configured `trustProxy` value through a public inspection API. The boot summary therefore reports proxy trust as `unknown`, and diagnostics that depend on the setting are unavailable. Client IP resolution still uses the native Fastify request. Configure proxy trust on your Nest Fastify adapter and verify it against your deployment topology.

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

For Mercurius, use `MercuriusDriver`, `fastifyPlatform()` from `nestjs-slightly-better-auth/fastify` and `mercuriusTransport()`. `mercuriusSubscriptionContext()` returns a Mercurius `subscription.context` function that keeps the upgrade request and its original browser headers with every socket operation; the socket tests cover Mercurius with and without it. A custom GraphQL `context` must be a function that returns a fresh object for every operation. For Apollo HTTP operations, it keeps the platform request at `context.req`: the Express request, or the Fastify request that the context function receives as its first argument, not that request's `raw` `IncomingMessage`. For Apollo socket operations, it either leaves `context.req` unset, so Nest assigns the graphql-ws context, or keeps graphql-ws's `extra` at `context.extra` and the connection parameters at `context.connectionParams`; the upgrade request alone is not recognized. An operation whose context carries neither fails closed with `AUTH_MISCONFIGURED` (`GRAPHQL_CONTEXT_UNRECOGNIZED`). Startup fails with `GRAPHQL_STATIC_CONTEXT` for a static context object and with `GRAPHQL_DRIVER_MISMATCH` when the transport does not match the configured driver.

### Operations and fields

Each root field of an operation is authorized independently, so aliases and batched operations can share one session read while receiving different organization decisions. A denied field produces a GraphQL error whose `extensions` contain `code`, `statusCode` and, where applicable, `reason`. Authentication infrastructure failures surface as `Internal server error` with `code: "INTERNAL_SERVER_ERROR"` and `reason` `AUTH_UNAVAILABLE` or `AUTH_MISCONFIGURED`; the underlying error never reaches the client. Better Auth's browser-origin check applies to HTTP mutations and to every socket operation.

Field resolvers without access decorators inherit the principal of their actual ancestor operation, including across named instances. Protecting field and reference resolvers requires Nest to run guards on them: set `fieldResolverEnhancers: ["guards", "filters"]`, and add `"interceptors"` when those fields use scoped service readers. With `"guards"` enabled, Nest runs every global guard once per field invocation, and the boot advice `W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS` names the affected guards and interceptors. A field resolver that declares access metadata without field guards fails startup with `FIELD_RESOLVER_UNGUARDED`; `fieldResolverCoverage: "warn" | "off"` relaxes that check. Without `"filters"`, Nest does not route field errors through its exception pipeline, so they are not logged; the library then emits `W_FIELD_EXCEPTION_FILTERS_DISABLED`. With filters enabled, repeated infrastructure and reader errors produce one Nest ERROR per logical request while every affected field receives a safe error.

### Subscriptions and socket operations

Socket operations authenticate each operation independently from the WebSocket upgrade request and never refresh the session. Browser-origin checks always use the original upgrade headers, before any session read, so connection parameters cannot replace the browser's `Origin`. The platform's own request predicate classifies HTTP operations first, and Apollo recognizes a socket operation only through the graphql-ws connection and its WebSocket. A client-sent `Upgrade: websocket` header therefore never selects the socket path: an HTTP operation keeps the platform client IP, response cookie forwarding and the completed-request check, and an unrecognized context still fails closed. Mercurius treats an operation whose context carries the route's own Fastify reply as HTTP before any socket detection, and otherwise identifies sockets only through its subscription context, so neither request headers nor client fields spread into a custom context select the socket path.

By default, `authorization` and `cookie` values in the `connection_init` payload replace the matching upgrade headers. `connectionParamHeaders` replaces that list of keys, matched case-insensitively. A selected value that is not a string or is not a valid header value rejects the operation with `UNAUTHENTICATED` and `reason: "MALFORMED_CREDENTIALS"`, without falling back to another credential and without echoing the value in errors or logs.

`subscriptionCredentials(connectionContext)` replaces this mapping. The `HeadersInit` it returns becomes the operation's credentials, and `host`, `x-forwarded-host` and `x-forwarded-proto` are copied from the upgrade request when absent. Returning `undefined` presents no credentials, and `connectionParamHeaders` is not consulted. Invalid header values reject with `MALFORMED_CREDENTIALS`; errors thrown by the function are application errors, not credential denials.

`subscriptionPrincipalTtlMs` reuses a connection's principal for that many milliseconds. The default `0` resolves the principal for every socket operation. A positive value delays the effect of session revocation on open connections by up to the TTL; routes with `@RequireAuth({ authoritative: true })` always resolve a fresh principal.

### Federation

Both transports support `ApolloFederationDriver` and `MercuriusFederationDriver` with schema-first schemas and code-first federation versions 1 and 2. `@ResolveReference()` resolvers are always checked: without field guards, startup fails with `FEDERATION_FIELD_GUARDS_REQUIRED` or `REFERENCE_RESOLVER_UNGUARDED`, and `federationCoverage` relaxes the check.

Federation schema generation in `@nestjs/graphql` loads `@apollo/subgraph`, which the install commands above do not include. Federation applications must install a compatible version, for example `pnpm add @apollo/subgraph@^2.15.1`; otherwise startup fails before authentication runs. `@apollo/subgraph` 2.15 requires `@nestjs/graphql` 14.0.2 or newer, as described under [Supported versions](#supported-versions).

### Supported versions

The native GraphQL tests run Nest 12.0.3 with `@nestjs/graphql`, `@nestjs/apollo` and `@nestjs/mercurius` 14.0.2, `graphql` 16.14.2, `@apollo/server` 5.5.1, `mercurius` 16.10.0, `@mercuriusjs/federation` 5.1.1 and `@apollo/subgraph` 2.15.1. Code-first federation with `@apollo/subgraph` 2.15 requires `@nestjs/graphql` 14.0.2 or newer. With `@nestjs/graphql` 14.0.1, schema generation fails before authentication runs: federation 1 cannot load the subgraph directives module that 2.15 removed, and federation 2 fails with `TypeError: doc.definitions is not iterable`. The `@nestjs/graphql` peer range therefore starts at 14.0.2.

## WebSocket gateways

The `./websockets` entry authenticates Socket.IO and raw `ws` gateways. Register `socketIoTransport()` or `wsTransport()` in the module's `transports`, and decorate every gateway with `@UseBetterAuth()` so both the guard and the invocation scope run for its message handlers. Startup fails with `GATEWAY_UNGUARDED` when a message handler lacks that coverage; `@Public()` opts a gateway or handler out, and the transports' `gatewayCoverage` option downgrades the check to `"warn"` or `"off"`. Message handlers use the same access, session and authorization decorators as controllers.

```ts
import { Inject, Module } from "@nestjs/common";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import type { Server } from "socket.io";
import {
  BetterAuthModule,
  CurrentSession,
  RequireAuth,
  UseBetterAuth,
} from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import {
  socketIoTransport,
  WS_CONNECTION_AUTH,
  type WsConnectionAuth,
} from "nestjs-slightly-better-auth/websockets";
import { auth } from "./auth"; // betterAuth({ plugins: [nestjs(), bearer()], ... })

@WebSocketGateway()
@UseBetterAuth()
export class EventsGateway {
  constructor(
    @Inject(WS_CONNECTION_AUTH)
    private readonly connectionAuth: WsConnectionAuth,
  ) {}

  afterInit(server: Server) {
    // Optional: reject unauthenticated handshakes before any message arrives.
    server.use(this.connectionAuth.socketIoMiddleware({ required: true }));
  }

  @RequireAuth()
  @SubscribeMessage("whoami")
  whoami(@CurrentSession() session: { user: { email: string } }) {
    return { email: session.user.email };
  }
}

@Module({
  imports: [
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      transports: [socketIoTransport()],
    }),
  ],
  providers: [EventsGateway],
})
export class AppModule {}
```

Socket.IO reads credentials from the handshake headers. When the handshake has no `Authorization` header, a string `auth.token` becomes `Authorization: Bearer <token>`, which Better Auth's `bearer()` plugin accepts. Raw `ws` reads the upgrade request, so wrap Nest's adapter to record it: `app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app))`. Without that record, public messages still run and protected messages fail with a 500 `WS_UPGRADE_REQUEST_MISSING` configuration error.

A `credentials(client)` option on either transport replaces the default mapping: the entries of the `HeadersInit` it returns override the handshake headers of the same name for authentication. The browser-origin check always uses the original handshake, so mapped credentials cannot bypass it. A non-string `auth.token`, or mapped credentials that are not string pairs or contain CR, LF, NUL or other invalid header characters, fail with a 401 `MALFORMED_CREDENTIALS` before any Better Auth call. Other credentials on the connection are not tried in their place, and the failure does not carry the rejected value. Errors thrown by the mapper itself are not converted into authentication failures.

Connection authentication runs the same origin check and default credential sources as messages, for the default instance or the one named by `instance`. `socketIoMiddleware({ required, instance })` rejects a Socket.IO handshake with a `connect_error` whose `data` holds `statusCode`, `code` and `reason`; `required: false` admits connections without credentials but still rejects invalid ones. Unexpected errors reach the client as a 500 `Internal server error`, and the server logs a summary that omits foreign error messages because they can quote credentials. For raw `ws`, call `authenticate(client)` in `handleConnection` and close rejected connections with `wsCloseCodeFor(result.failure)`, which maps 401, 403 and 429 failures to close codes 4401, 4403 and 4429.

Principal caching is off by default. A positive `principalTtlMs` reuses a successful authentication on the same connection and therefore delays revocation for ordinary handlers; handlers declared with `@RequireAuth({ authoritative: true })` always revalidate. Neither message nor connection authentication refreshes cookies.

Tests run real Socket.IO 4.8.3 and ws 8.21.3 clients against Nest 12.0.3, where Nest delivers raw `ws` authentication failures as native `exception` messages.

## RPC authentication

The `./microservices` entry authenticates messages in standalone and hybrid Nest microservices. `rpcTransport()` reads credentials from the transport's native carrier: gRPC metadata, NATS headers, Kafka headers, RabbitMQ message headers and MQTT 5 user properties. TCP and Redis messages have no header carrier, so they send credentials in a payload envelope field, `auth` by default. Every message is authenticated separately.

```ts
import { Controller, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  MessagePattern,
  Transport,
  type MicroserviceOptions,
} from "@nestjs/microservices";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import {
  BetterAuthModule,
  CurrentUser,
  Public,
} from "nestjs-slightly-better-auth";
import { rpcTransport } from "nestjs-slightly-better-auth/microservices";
import { nestjs } from "nestjs-slightly-better-auth/plugin";

const auth = betterAuth({
  // RPC messages have no HTTP origin, so the base URL must be static.
  baseURL: "https://auth.example.com",
  // Add your database adapter and other Better Auth options.
  plugins: [bearer(), nestjs()],
});

@Controller()
class ProfileController {
  @MessagePattern("profile.get")
  profile(@CurrentUser() user: { id: string }) {
    return { userId: user.id };
  }

  @Public()
  @MessagePattern("health")
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [BetterAuthModule.forRoot({ auth, transports: [rpcTransport()] })],
  controllers: [ProfileController],
})
class AppModule {}

const app = await NestFactory.createMicroservice<MicroserviceOptions>(
  AppModule,
  { transport: Transport.TCP, options: { host: "127.0.0.1", port: 4000 } },
);
await app.listen();
```

A TCP client puts credentials in the envelope, for example `{ auth: { authorization: "Bearer <token>" }, id: 1 }`; a NATS client sets an `authorization` header through `NatsRecordBuilder`. Carriers accept only the `authorization`, `cookie` and `x-api-key` fields by default. Pass carrier factories such as `grpcCarrier({ metadata: ["authorization"] })` or `payloadCarrier({ field: "credentials" })` in `rpcTransport({ carriers })` to change the accepted fields or the envelope. Host, forwarding and `set-cookie` metadata never reach Better Auth, so a broker message cannot claim an HTTP origin.

Configure a static Better Auth base URL, or a fallback for a dynamic one: RPC transports have no request host, and startup fails with `DYNAMIC_BASE_URL_WITHOUT_FALLBACK` otherwise. Message authentication never refreshes or sets cookies. Public messages run without credentials; protected messages without a matching carrier are rejected as unauthenticated. Malformed credential values, such as values containing CR, LF or NUL, are rejected with reason `MALFORMED_CREDENTIALS` without reaching Better Auth, the handler or logs.

In a hybrid application, Nest applies global guards to microservice handlers only when `connectMicroservice()` receives `{ inheritAppConfig: true }`. Either pass that option to every `connectMicroservice()` call and pass `rpcTransport({ inheritAppConfig: true })`, or apply `@UseBetterAuth()` to message controllers and `@Public()` to public handlers. Startup verifies the explicit form and fails with `RPC_HANDLER_UNGUARDED` for an uncovered message or event handler; `hybridCoverage: "warn"` or `"off"` lowers that check. The inheritance option is an assertion that the application passes the same flag to Nest, and startup logs the `W_RPC_INHERIT_APP_CONFIG_ASSERTED` warning for it.

Failures become `RpcException` payloads with `statusCode`, `code` and, where present, `reason`. gRPC calls receive native status codes: 16 for authentication, 7 for authorization, 8 for throttling and 13 for redacted infrastructure failures. End-to-end tests run real TCP and gRPC servers and real NATS, Kafka, RabbitMQ, MQTT 5 and Redis brokers against Nest 12.0.3, including hybrid applications with both coverage modes and default plus named instances.

## Testing helpers (`./testing`)

The helpers replace one collaborator at a time in a `TestingModuleBuilder`, so the rest of the pipeline stays real.

```ts
import { Test } from "@nestjs/testing";
import { allow } from "nestjs-slightly-better-auth";
import {
  initTestApp,
  overrideAuthGuard,
  overrideDecisions,
  overridePrincipal,
  stampPrincipal,
} from "nestjs-slightly-better-auth/testing";

// Fixed principal: acceptance, the origin check and policies still run; Better Auth is not called for resolution.
const builder = overridePrincipal(
  Test.createTestingModule({ imports: [AppModule] }),
  {
    kind: "session",
    source: "better-auth:session",
    userId: "u1",
    session,
  },
);

// Stub a policy decision; returning undefined runs the real policy.
overrideDecisions(
  builder,
  (policyId) =>
    policyId === "better-auth:organization/permission" ? allow() : undefined, // gitleaks:allow: public policy identifier
);

// Replace the guard everywhere: the global APP_GUARD and every @UseBetterAuth()/@UseGuards(BetterAuthGuard) site.
overrideAuthGuard(builder, {
  canActivate(ctx) {
    stampPrincipal(ctx, testUser); // publishes the principal to @CurrentPrincipal(), @CurrentSession() and the service
    return true;
  },
});

// Inside a Vitest test or beforeEach: onTestFinished closes this app when the test ends (node:test: t.after).
const app = await initTestApp(
  (await builder.compile()).createNestApplication(),
  { closeWith: onTestFinished },
);
```

- `overridePrincipal(builder, principal, { instance })` overrides `PRINCIPAL_RESOLVER` for one instance (default `'default'`). A policy's re-classification read of a generic 401 answers absent, so organization policies deny 401 under a fixed principal; stub them with `overrideDecisions` or use real sessions from `authHeadersFor`. The admin policy judges the stored user row of the fixed `userId`.
- `overrideAuthGuard(builder, guard | { principal })` overrides `GUARD_CORE` and `SCOPE_CORE` once each. `overrideProvider(BetterAuthGuard)` and `overrideGuard(BetterAuthGuard)` cannot be combined: `TestingModuleBuilder` keeps one override per token, so one set of call sites would keep the real guard. An object with a `canActivate` method always runs as the guard, even when it also has a `principal` property. The stand-in scope reads the test stamp first; `{ principal }` stamps for the handler's instance, including named instances.
- `stampPrincipal(ctx, principal, { instance })` records the principal on the invocation's argument array and its object elements. Readers accept it from the same array (WebSocket, RPC and GraphQL guards and interceptors share it) or from another array with the same elements when at least two elements are objects (an HTTP request and its response). A lone shared element, such as a socket beside a primitive payload, never identifies an invocation, so concurrent invocations do not see each other's stamps. A stand-in that stamps nothing makes principal readers fail with the generic `NO_AUTH_RESULT` error.
- `testPrincipal(principal | (request) => principal | null, { kinds, acceptance, delegates })` is a principal source for composed test modules.
- `authHeadersFor(auth, userId)` creates real session headers through Better Auth's `testUtils()` plugin.
- `initTestApp(app, { closeWith })` runs `init()` and Fastify `ready()`. A Better Auth instance binds to one application at a time (a second bound application fails with `INSTANCE_ALREADY_BOUND`), so the helper first closes the previous application that it initialized for the same instance; a failed `init()` leaves its binding to the next application, which takes it over with `W_INSTANCE_TAKEN_OVER`. The helper makes `app.close()` idempotent and passes it to `closeWith`, a per-test cleanup such as Vitest's `onTestFinished` or node:test's `t.after`. Jest cannot register hooks while a test runs, so collect the closes and run them in a suite-level `afterEach`. Without `closeWith`, close the last application yourself. On Express, compile one `TestingModule` per application.

Better Auth treats a process with `NODE_ENV=test` or a truthy `TEST` variable (Vitest sets it; Jest sets `NODE_ENV=test`) as a test run and then skips its origin checks, and this library's origin check follows the same flags. Set `advanced.disableOriginCheck: false` on test instances that exercise origin rules.

## Conformance kits (`./testing/conformance`)

The kits verify extension units against the invariants of the [reviewed specification](docs/design/design-v7.md) (§4 and §14.1). Each kit returns `ConformanceCase[]` (`{ id, title, skip?, run() }`) that `runConformance(cases, { describe, it })` registers with Vitest, Jest or `node:test`. Assertions use `node:assert/strict`; the kits import no test runner.

Applicability comes from the unit, not from the options a harness passes. A platform that declares `capabilities.http2` needs the `http2` option. A transport with a lineage needs `invokeTwice`, one that nests handlers (`defaultAccessFor`) needs `invokeGraph`, and one that claims the kit's federation reference resolver needs `invokeEntities`. Such a case fails when the helper is missing. A case whose optional capability is absent is skipped with the reason. The kits read these members from unit objects before running; for classes and `defineExtension()` definitions they boot once and read the resolved unit. A case known to be inapplicable registers with its reason in the test name. A case that finds out at run time resolves with `{ skipped: reason }`, which `runConformance` reports through the runner's `context.skip(reason)` (Vitest, `node:test`; Jest has no runtime skip, so the test passes).

```ts
import { ExpressAdapter } from "@nestjs/platform-express";
import { describe, it } from "vitest";
import {
  createConformanceAuth,
  httpPlatformConformance,
  policyConformance,
  principalSourceConformance,
  runConformance,
} from "nestjs-slightly-better-auth/testing/conformance";

runConformance(
  httpPlatformConformance({
    platform: myPlatform(),
    createHttpAdapter: () => new ExpressAdapter(),
  }),
  { describe, it },
);

const auth = createConformanceAuth({ plugins: [myPlugin()] });
runConformance(
  principalSourceConformance({
    source: myTokenSource(),
    auth,
    credentials: {
      valid: issueToken,
      invalid: () => new Headers({ authorization: "Bearer invalid" }),
    },
  }),
  { describe, it },
);
```

| Kit                          | Unit                  | Covers                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpPlatformConformance`    | `HttpPlatform`        | Mounting, byte-exact bodies, limits with host CORS, URL and header facts, client IP, HTTP/2, write-back, request accessors, error delivery, lifecycle (no adapter, late adapter, reused `TestingModule`, double `forRoot`), diagnostics and log hygiene                                                                                                                                |
| `transportConformance`       | `AuthTransport`       | Selection, credentials, per-request memoization, per-invocation decisions, acceptance, cookie forwarding or refresh suppression, origin and form-CSRF rules including forwarding on safe operations, error shapes and logging, the exact coverage report of the transport's claims, `globalScope: false`, mixed-kind session reads, lazy scope construction and fail-closed extraction |
| `principalSourceConformance` | `PrincipalSource`     | Rejection without throwing, storage outages, delivery of every own-credential `Set-Cookie` exactly once, refresh suppression, clean absence, principal shape, declared credential headers, `sessionBacked` and `delegates` declarations                                                                                                                                                |
| `policyConformance`          | `AuthorizationPolicy` | Deny values, storage outages, APIError mapping and re-classification, delegation scope, unnamed-kind gating, per-invocation decisions with shared I/O and plugin prerequisites; requirements name policy objects (construct a DI policy with its dependencies)                                                                                                                         |

Every case boots real Nest applications or modules with a real Better Auth instance that includes `conformanceProbePlugin()`. The probe counts and faults every operation of the instance's database adapter, so storage outages reach endpoints that would swallow them, and records the `Set-Cookie` lines each call produces. `createConformanceAuth({ plugins })` builds such an instance: memory adapter, `testUtils()`, `bearer()`, the probe plugin, `nestjs()` last, and `session.updateAge: 0` and origin checks on, whatever `options` says. The principal-source and policy kits take that instance as `auth`; the principal-source kit rejects an instance without `session.updateAge: 0`. The transport kit creates its own instance and passes it to your `createApp` harness together with the kit's API-key source in `principals`, a `logger` to boot with, and the `globalScope`, `appEnhancers`, `fieldResolverEnhancers` and `federation` settings of each boot. Apply every fixture decorator, including the kit's `SetMetadata()` marker, which maps the transport's claims to fixtures.

This repository runs the platform kit against Express and Fastify, the transport kit against the built-in HTTP transport and an in-process reference transport, the principal-source kit against the session and API-key sources, and the policy kit against the admin, organization, API-key and fresh-session policies. Mutation tests confirm that each of these defects fails the intended case: a platform merging `Set-Cookie`, a transport sharing invocation state across aliases, a transport without a browser leg on safe operations, a `defineExtension()` transport with a lineage or nesting and no helper, a source throwing its denial, a source dropping its refresh cookie, a source turning a storage outage into a 401, and a policy widening delegated principals.

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

## Examples

The [Express](../../examples/better-auth-express/README.md) and [Fastify](../../examples/better-auth-fastify/README.md) example applications register a default and a named instance, guard routes and read the signed-in user through a principal parameter. They start without external services.

## Releases

Versions come from Changesets, and publication runs from the monorepo's release workflow with npm trusted publishing and provenance; see [release automation](../../docs/releases.md). New entry points are additive, so they ship as minor versions.

## License

[MIT](LICENSE). The archived upstream adapter retains its [original MIT notice](legacy/LICENSE).
