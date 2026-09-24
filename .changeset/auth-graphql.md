---
"nestjs-slightly-better-auth": minor
---

Add the `./graphql` entry with `apolloTransport()` for `@nestjs/apollo` and `mercuriusTransport()` for `@nestjs/mercurius`.

Queries, mutations, subscriptions and federation reference resolvers use the same access decorators, principal parameters and authorization units as HTTP controllers. Each root field and alias receives its own authorization decision while one request shares a single session read, and nested field resolvers inherit the principal of their actual ancestor operation. Socket operations authenticate from the WebSocket upgrade request, with `connection_init` credentials selected by `connectionParamHeaders` or mapped by `subscriptionCredentials`; malformed credentials are rejected as `MALFORMED_CREDENTIALS` without echoing their values, and browser-origin checks always use the original upgrade headers. Apollo recognizes socket operations only through the graphql-ws connection and its WebSocket, and Mercurius keeps every operation that carries its route's Fastify reply on the HTTP path, so neither a client-sent `Upgrade: websocket` header nor client fields spread into a custom context can move an HTTP operation onto the socket path. `subscriptionPrincipalTtlMs` optionally reuses a connection's principal, and `mercuriusSubscriptionContext()` carries the upgrade request through Mercurius socket contexts. Apollo and Mercurius federation work with schema-first schemas and code-first federation versions 1 and 2.

Denials become GraphQL errors with `code`, `statusCode` and `reason` extensions, and authentication infrastructure failures surface as a generic internal error. Startup validation reports mismatched drivers, static contexts and field or reference resolvers that Nest does not guard.

The entry adds optional peer dependencies on `@nestjs/graphql` ^14.0.2 and `graphql` ^16.14.2; applications that do not import `./graphql` do not need them.
