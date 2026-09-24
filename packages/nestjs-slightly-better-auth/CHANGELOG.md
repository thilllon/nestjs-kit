# nestjs-slightly-better-auth

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
