# nestjs-slightly-better-auth

[![npm version](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![Monthly downloads](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

A NestJS integration for [Better Auth](https://www.better-auth.com), built on an independently reviewed specification.

> **Scope.** The package covers HTTP, WebSocket and RPC authentication. HTTP support comprises the Nest authentication kernel, the Better Auth construction plugin, the Express and Fastify platforms, and the admin, organization and API-key authorization units. The `./websockets` entry authenticates Socket.IO and raw `ws` gateways, and the `./microservices` entry authenticates Nest microservice messages. The GraphQL transport and the conformance testing kit are not included; they arrive in later minor versions behind their own entry points. The [changelog](CHANGELOG.md) records the version that introduces each entry point.

## Install

```sh
pnpm add nestjs-slightly-better-auth better-auth
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` 12, `better-auth` 1.7.5 or newer, `reflect-metadata` and `rxjs`. Node.js 24.11 or newer.

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

The GraphQL integration has separate implementation and end-to-end acceptance gates. It will use an optional entry point so applications install only the transports they use.

Start with the [design workspace](docs/design/README.md), [reviewed specification](docs/design/design-v7.md), [review ledger](docs/design/ledger.md) and [implementation plan](../../docs/superpowers/plans/2026-09-21-better-auth.md). Independent Better Auth, NestJS and security reviews approved the final v7 snapshot after resolving the round-6 and round-7 findings. The remaining entry points are tracked in [issue #534](https://github.com/thilllon/nestjs-kit/issues/534).

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
