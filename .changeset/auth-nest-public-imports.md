---
"nestjs-slightly-better-auth": patch
---

The package loads Nest only through the `@nestjs/common` and `@nestjs/core` package roots, never through internal module paths such as `@nestjs/core/router/route-path-factory.js`. Boot validation composes application route paths from the public `ApplicationConfig` prefix, exclusion and versioning settings with the rules of Nest's router, and `WsConnectionAuth` builds its connection execution context from the public `ExecutionContext` interface. Route paths, shadowing warnings and connection authentication results are unchanged.
