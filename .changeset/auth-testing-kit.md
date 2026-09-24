---
"nestjs-slightly-better-auth": minor
---

Add the `./testing` and `./testing/conformance` entry points. `./testing` provides `overrideAuthGuard`, `overridePrincipal`, `overrideDecisions`, `stampPrincipal`, `testPrincipal`, `authHeadersFor` and `initTestApp`: one override replaces the guard at the global and every `@UseBetterAuth()` call site, fixed principals keep real acceptance, origin checks and policies, and decision stubs fall back to the real policy. `./testing/conformance` provides runner-agnostic `httpPlatformConformance`, `transportConformance`, `principalSourceConformance` and `policyConformance` kits, `runConformance`, `conformanceProbePlugin` and `createConformanceAuth`, using `node:assert/strict` and no test runner. The kits decide which cases apply from the unit under test, fail required capabilities whose helper is missing, and report cases that do not apply as skipped. Both entries need the optional peer `@nestjs/testing`; the root entry does not load it.
