---
"nestjs-slightly-better-auth": patch
---

The Apollo transport recognizes a graphql-ws operation whose `connection_init` message has no payload. The upgrade request's credential headers authenticate it, and a connection without credentials is anonymous: guarded operations fail with `UNAUTHENTICATED` and public operations run, instead of every guarded operation failing with `INTERNAL_SERVER_ERROR` (`AUTH_MISCONFIGURED`).
