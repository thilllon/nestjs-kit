---
"@nestjs-kit/better-auth": patch
---

Document that a `'cached'` GraphQL context of the transport conformance kit keeps its first call's request at `context.req`, so `T-stale-context` still serves a later caller the closed connection's context under `@nestjs/apollo` 14.0.3 and later, which copy a returned context object without `req` for every operation. Over a graphql-ws connection, `T-stale-context` resolves skipped with the reason when a later caller reads its own principal, because the driver then built a new context instead of serving the cached one, and the case has checked no stale context. The README states how `@nestjs/apollo` 14.0.2 and 14.0.3 or later treat a cached context object.
