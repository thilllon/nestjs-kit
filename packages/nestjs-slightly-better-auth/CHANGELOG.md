# nestjs-slightly-better-auth

## 1.3.0

### Minor Changes

- e5e68ee: Add the `./testing` and `./testing/conformance` entry points. `./testing` provides `overrideAuthGuard`, `overridePrincipal`, `overrideDecisions`, `stampPrincipal`, `testPrincipal`, `authHeadersFor` and `initTestApp`: one override replaces the guard at the global and every `@UseBetterAuth()` call site, fixed principals keep real acceptance, origin checks and policies, and decision stubs fall back to the real policy. `./testing/conformance` provides runner-agnostic `httpPlatformConformance`, `transportConformance`, `principalSourceConformance` and `policyConformance` kits, `runConformance`, `conformanceProbePlugin` and `createConformanceAuth`, using `node:assert/strict` and no test runner. The kits decide which cases apply from the unit under test, fail required capabilities whose helper is missing, and report cases that do not apply as skipped. Both entries need the optional peer `@nestjs/testing`; the root entry does not load it.

## 1.2.0

### Minor Changes

- 7302594: Add the `./websockets` entry point for Socket.IO and raw `ws` gateways.

  Register `socketIoTransport()` or `wsTransport()` in the module's `transports` and decorate gateways with `@UseBetterAuth()`; startup reports message handlers without guard and scope coverage as `GATEWAY_UNGUARDED`. Message handlers use the existing access, session and authorization decorators. Socket.IO reads the handshake headers and maps a string `auth.token` to a bearer credential; raw `ws` reads the upgrade request recorded by `withUpgradeRequest(WsAdapter)`. A `credentials(client)` mapper can replace those credentials, while the browser-origin check keeps using the original handshake. Malformed credentials fail with a 401 `MALFORMED_CREDENTIALS` that does not quote the rejected value.

  `WsConnectionAuth` (also injectable as `WS_CONNECTION_AUTH`) authenticates connections through `socketIoMiddleware()` or `authenticate()`, and `wsCloseCodeFor()` maps failures to close codes 4401, 4403 and 4429. `principalTtlMs` (default 0) reuses a successful authentication on the same connection. The entry requires the optional peer `@nestjs/websockets` 12 and `@nestjs/platform-socket.io` or `@nestjs/platform-ws`.

## 1.1.0

### Minor Changes

- 1df26ab: Add the `./microservices` entry point for authenticating Nest microservice messages.

  `rpcTransport()` authenticates every message in standalone and hybrid microservices through the shared Better Auth kernel. Credential carriers read gRPC metadata, NATS and Kafka headers, RabbitMQ message headers and MQTT 5 user properties; TCP and Redis messages carry credentials in a payload envelope (`auth` by default). Carriers accept only `authorization`, `cookie` and `x-api-key` by default and never forward host or forwarding metadata. Message authentication requires a static base URL or a hostless fallback, never refreshes cookies, and rejects malformed credential values with `MALFORMED_CREDENTIALS` without logging them. Failures become `RpcException` payloads, and gRPC calls receive native status codes 16, 7, 8 and 13. Hybrid applications either assert `inheritAppConfig` or apply `@UseBetterAuth()`, and startup rejects uncovered message and event handlers with `RPC_HANDLER_UNGUARDED`.

  `@nestjs/microservices` 12 is a new optional peer dependency, required only when importing `./microservices`.

## 1.0.0

### Major Changes

- bcdd5b1: Release the first public version of the Better Auth integration for NestJS.

  The package ships the Nest authentication kernel, the Better Auth construction plugin with hook and cookie bridging, request scopes with caller-origin evidence, the Express and Fastify HTTP platforms, and the admin, organization and API-key authorization units. GraphQL, WebSocket and RPC transports and the conformance testing kit are not part of this release; they arrive in later minor versions through their own entry points.

## 0.0.1

### Patch Changes

- Reserve the package name and prove the release pipeline. The package exports nothing yet: the rewrite is still in design (see `docs/design`).
