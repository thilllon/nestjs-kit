---
"nestjs-slightly-better-auth": minor
---

Add conformance rows to `./testing/conformance`:

- `createConformanceAuth(options, settings)` takes `ConformanceAuthSettings`, which sets Better Auth's `disableOriginCheck` and `disableCSRFCheck` explicitly. Both still default to `false`.
- `T-csrf-http-unsafe` asserts that an unsafe cookie operation from an untrusted `Origin` stays denied under `disableOriginCheck: true` with `disableCSRFCheck: false`, and that boot warns `W_ORIGIN_CHECK`.
- `T-coverage-claims` asserts the boot summary's `scope: global` and `scope: off — see W_NO_GLOBAL_SCOPE` lines through the new `createApp` `logSummary` option.
- `T-internal-error-logged-once` asserts one ERROR entry per request and distinct error for reader configuration errors (`SESSION_REQUIRED`, `NO_INVOCATION_VALUE`, `NO_AUTH_RESULT`) and service `getSession()` reads under 20 GraphQL list items. These boots use the `'filters'` field resolver enhancer, a `graph.roots.items` list root and the `organizationReader` and `serviceSession` fields.
- With `http`, the principal-source kit runs `S-cookie-forwarded` and `S-infra-throws` through a guarded HTTP route.
