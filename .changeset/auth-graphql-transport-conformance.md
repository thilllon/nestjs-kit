---
"nestjs-slightly-better-auth": patch
---

`transportConformance` reads each call's browser leg while its invocation runs, so transports that reject a completed request, such as the Apollo and Mercurius transports of `./graphql`, run every applicable case, including the GraphQL cases `T-inherit-no-lookup`, `T-stamp-per-plan` and `T-reference-resolver`.
