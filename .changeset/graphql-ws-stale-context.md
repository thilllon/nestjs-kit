---
"nestjs-slightly-better-auth": patch
---

Fail closed with `GRAPHQL_CONTEXT_STALE_REQUEST` for an Apollo graphql-ws operation whose GraphQL context carries the graphql-ws connection of a socket that is no longer open when the operation starts, such as a context function that returns a cached object. The operation no longer authenticates with the earlier connection's upgrade credentials, while a connection that closes during authentication stays a socket operation. `T-stale-context` now runs its cached-context row on connection-shaped legs, and `invokeConnection` resolves after the server has observed the connection's close.
