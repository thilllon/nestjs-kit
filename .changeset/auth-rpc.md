---
"nestjs-slightly-better-auth": minor
---

Add the `./microservices` entry point for authenticating Nest microservice messages.

`rpcTransport()` authenticates every message in standalone and hybrid microservices through the shared Better Auth kernel. Credential carriers read gRPC metadata, NATS and Kafka headers, RabbitMQ message headers and MQTT 5 user properties; TCP and Redis messages carry credentials in a payload envelope (`auth` by default). Carriers accept only `authorization`, `cookie` and `x-api-key` by default and never forward host or forwarding metadata. Message authentication requires a static base URL or a hostless fallback, never refreshes cookies, and rejects malformed credential values with `MALFORMED_CREDENTIALS` without logging them. Failures become `RpcException` payloads, and gRPC calls receive native status codes 16, 7, 8 and 13. Hybrid applications either assert `inheritAppConfig` or apply `@UseBetterAuth()`, and startup rejects uncovered message and event handlers with `RPC_HANDLER_UNGUARDED`.

`@nestjs/microservices` 12 is a new optional peer dependency, required only when importing `./microservices`.
