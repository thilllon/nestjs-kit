# nestjs-slightly-better-auth

[![npm version](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![Monthly downloads](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

A NestJS integration for [Better Auth](https://www.better-auth.com), built on an independently reviewed specification.

> **Scope.** The package covers HTTP: the Nest authentication kernel, the Better Auth construction plugin, the Express and Fastify platforms, the admin, organization and API-key authorization units, consumer testing helpers (`./testing`) and reusable conformance kits (`./testing/conformance`). GraphQL, WebSocket and RPC transports are not included; they arrive in later minor versions behind their own entry points.

## Install

```sh
pnpm add nestjs-slightly-better-auth better-auth
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` 12, `better-auth` 1.7.5 or newer, `reflect-metadata` and `rxjs`. Node.js 24.11 or newer. The `./testing` and `./testing/conformance` entries also need the optional peer `@nestjs/testing` 12; the root entry never loads it or a test runner.

## What this release covers

The library separates a Better Auth construction plugin, a NestJS integration kernel and optional transports. The `./plugin` entry installs the hook and cookie bridge before Better Auth creates its pipeline. The `./platform` entry provides Node/Web request and response helpers. Neither entry requires Express, Fastify, GraphQL or WebSocket packages.

The root entry provides synchronous and asynchronous module registration, default and named instances, service readers, guards, scoped execution and compositional authorization. Tests exercise actual Nest dependency injection and Better Auth sessions, including isolation between instances, caller-origin enforcement and application shutdown. Built ESM and CommonJS consumers verify the same registration and type contracts.

The `./express` and `./fastify` entries connect native Nest applications to Better Auth. Their end-to-end tests cover raw bodies, size limits, cookies, CORS, request cancellation, exception filters and real authentication. Fastify also supports HTTP/2. The platform entries have no runtime imports of Express or Fastify; install the Nest platform adapter used by your application.

Express preserves native controller parsing for unconditional routes that overlap the auth mount. Body-capable controller routes that also depend on host or non-URI version conditions are rejected at startup with `CONDITIONAL_ROUTE_SHADOW`; move them outside the auth mount. The integration checks the effective Express router flags because changing application settings after router creation does not change existing route matching. This is a tested Express 5 compatibility boundary, not an inspection of the router stack.

Fastify does not expose its configured `trustProxy` value through a public inspection API. The boot summary therefore reports proxy trust as `unknown`, and diagnostics that depend on the setting are unavailable. Client IP resolution still uses the native Fastify request. Configure proxy trust on your Nest Fastify adapter and verify it against your deployment topology.

GraphQL, WebSocket and microservice integrations have separate implementation and end-to-end acceptance gates. They will use optional entry points so applications can install the transports they use. HTTP platform tests do not establish that those integrations are ready.

Start with the [design workspace](docs/design/README.md), [reviewed specification](docs/design/design-v7.md), [review ledger](docs/design/ledger.md) and [implementation plan](../../docs/superpowers/plans/2026-09-21-better-auth.md). Independent Better Auth, NestJS and security reviews approved the final v7 snapshot after resolving the round-6 and round-7 findings. The remaining entry points are tracked in [issue #534](https://github.com/thilllon/nestjs-kit/issues/534).

## Testing helpers (`./testing`)

The helpers replace one collaborator at a time in a `TestingModuleBuilder`, so the rest of the pipeline stays real.

```ts
import { Test } from "@nestjs/testing";
import { allow } from "nestjs-slightly-better-auth";
import {
  initTestApp,
  overrideAuthGuard,
  overrideDecisions,
  overridePrincipal,
  stampPrincipal,
} from "nestjs-slightly-better-auth/testing";

// Fixed principal: acceptance, the origin check and policies still run; Better Auth is not called for resolution.
const builder = overridePrincipal(
  Test.createTestingModule({ imports: [AppModule] }),
  {
    kind: "session",
    source: "better-auth:session",
    userId: "u1",
    session,
  },
);

// Stub a policy decision; returning undefined runs the real policy.
overrideDecisions(
  builder,
  (policyId) =>
    policyId === "better-auth:organization/permission" ? allow() : undefined, // gitleaks:allow: public policy identifier
);

// Replace the guard everywhere: the global APP_GUARD and every @UseBetterAuth()/@UseGuards(BetterAuthGuard) site.
overrideAuthGuard(builder, {
  canActivate(ctx) {
    stampPrincipal(ctx, testUser); // publishes the principal to @CurrentPrincipal(), @CurrentSession() and the service
    return true;
  },
});

const app = await initTestApp(
  (await builder.compile()).createNestApplication(),
  { closeWith: afterEach },
);
```

- `overridePrincipal(builder, principal, { instance })` overrides `PRINCIPAL_RESOLVER` for one instance (default `'default'`). A policy's re-classification read of a generic 401 answers absent, so organization policies deny 401 under a fixed principal; stub them with `overrideDecisions` or use real sessions from `authHeadersFor`. The admin policy judges the stored user row of the fixed `userId`.
- `overrideAuthGuard(builder, guard | { principal })` overrides `GUARD_CORE` and `SCOPE_CORE` once each. `overrideProvider(BetterAuthGuard)` and `overrideGuard(BetterAuthGuard)` cannot be combined: `TestingModuleBuilder` keeps one override per token, so one set of call sites would keep the real guard. An object with a `canActivate` method always runs as the guard, even when it also has a `principal` property. The stand-in scope reads the test stamp first; `{ principal }` stamps for the handler's instance, including named instances.
- `stampPrincipal(ctx, principal, { instance })` records the principal on the invocation's argument array and its object elements. Readers accept it from the same array (WebSocket, RPC and GraphQL guards and interceptors share it) or from another array with the same elements when at least two elements are objects (an HTTP request and its response). A lone shared element, such as a socket beside a primitive payload, never identifies an invocation, so concurrent invocations do not see each other's stamps. A stand-in that stamps nothing makes principal readers fail with the generic `NO_AUTH_RESULT` error.
- `testPrincipal(principal | (request) => principal | null, { kinds, acceptance, delegates })` is a principal source for composed test modules.
- `authHeadersFor(auth, userId)` creates real session headers through Better Auth's `testUtils()` plugin.
- `initTestApp(app, { closeWith })` runs `init()` and Fastify `ready()`. A Better Auth instance binds to one application at a time (a second bound application fails with `INSTANCE_ALREADY_BOUND`), so the helper first closes the previous application that it initialized for the same instance; a failed `init()` leaves its binding to the next application, which takes it over with `W_INSTANCE_TAKEN_OVER`. The helper makes `app.close()` idempotent and passes it to `closeWith`, for example `afterEach`; without `closeWith`, close the last application yourself. On Express, compile one `TestingModule` per application.

Better Auth treats a process with `NODE_ENV=test` or a truthy `TEST` variable (Vitest sets it; Jest sets `NODE_ENV=test`) as a test run and then skips its origin checks, and this library's origin check follows the same flags. Set `advanced.disableOriginCheck: false` on test instances that exercise origin rules.

## Conformance kits (`./testing/conformance`)

The kits verify extension units against the invariants of the [reviewed specification](docs/design/design-v7.md) (§4 and §14.1). Each kit returns `ConformanceCase[]` (`{ id, title, skip?, run() }`) that `runConformance(cases, { describe, it })` registers with Vitest, Jest or `node:test`. Assertions use `node:assert/strict`; the kits import no test runner.

Applicability comes from the unit, not from the options a harness passes. A platform that declares `capabilities.http2` needs the `http2` option. A transport with a lineage needs `invokeTwice`, one that nests handlers (`defaultAccessFor`) needs `invokeGraph`, and one that claims the kit's federation reference resolver needs `invokeEntities`. Such a case fails when the helper is missing. A case whose optional capability is absent is skipped with the reason. The kits read these members from unit objects before running; for classes and `defineExtension()` definitions they boot once and read the resolved unit. A case known to be inapplicable registers with its reason in the test name. A case that finds out at run time resolves with `{ skipped: reason }`, which `runConformance` reports through the runner's `context.skip(reason)` (Vitest, `node:test`; Jest has no runtime skip, so the test passes).

```ts
import { ExpressAdapter } from "@nestjs/platform-express";
import { describe, it } from "vitest";
import {
  createConformanceAuth,
  httpPlatformConformance,
  policyConformance,
  principalSourceConformance,
  runConformance,
} from "nestjs-slightly-better-auth/testing/conformance";

runConformance(
  httpPlatformConformance({
    platform: myPlatform(),
    createHttpAdapter: () => new ExpressAdapter(),
  }),
  { describe, it },
);

const auth = createConformanceAuth({ plugins: [myPlugin()] });
runConformance(
  principalSourceConformance({
    source: myTokenSource(),
    auth,
    credentials: {
      valid: issueToken,
      invalid: () => new Headers({ authorization: "Bearer invalid" }),
    },
  }),
  { describe, it },
);
```

| Kit                          | Unit                  | Covers                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpPlatformConformance`    | `HttpPlatform`        | Mounting, byte-exact bodies, limits with host CORS, URL and header facts, client IP, HTTP/2, write-back, request accessors, error delivery, lifecycle (no adapter, late adapter, reused `TestingModule`, double `forRoot`), diagnostics and log hygiene                                                                                                                                |
| `transportConformance`       | `AuthTransport`       | Selection, credentials, per-request memoization, per-invocation decisions, acceptance, cookie forwarding or refresh suppression, origin and form-CSRF rules including forwarding on safe operations, error shapes and logging, the exact coverage report of the transport's claims, `globalScope: false`, mixed-kind session reads, lazy scope construction and fail-closed extraction |
| `principalSourceConformance` | `PrincipalSource`     | Rejection without throwing, storage outages, delivery of every own-credential `Set-Cookie` exactly once, refresh suppression, clean absence, principal shape, declared credential headers, `sessionBacked` and `delegates` declarations                                                                                                                                                |
| `policyConformance`          | `AuthorizationPolicy` | Deny values, storage outages, APIError mapping and re-classification, delegation scope, unnamed-kind gating, per-invocation decisions with shared I/O and plugin prerequisites; requirements name policy objects (construct a DI policy with its dependencies)                                                                                                                         |

Every case boots real Nest applications or modules with a real Better Auth instance that includes `conformanceProbePlugin()`. The probe counts and faults every operation of the instance's database adapter, so storage outages reach endpoints that would swallow them, and records the `Set-Cookie` lines each call produces. `createConformanceAuth({ plugins })` builds such an instance: memory adapter, `testUtils()`, `bearer()`, the probe plugin, `nestjs()` last, and `session.updateAge: 0` and origin checks on, whatever `options` says. The principal-source and policy kits take that instance as `auth`; the principal-source kit rejects an instance without `session.updateAge: 0`. The transport kit creates its own instance and passes it to your `createApp` harness together with the kit's API-key source in `principals`, a `logger` to boot with, and the `globalScope`, `appEnhancers`, `fieldResolverEnhancers` and `federation` settings of each boot. Apply every fixture decorator, including the kit's `SetMetadata()` marker, which maps the transport's claims to fixtures.

This repository runs the platform kit against Express and Fastify, the transport kit against the built-in HTTP transport and an in-process reference transport, the principal-source kit against the session and API-key sources, and the policy kit against the admin, organization, API-key and fresh-session policies. Mutation tests confirm that each of these defects fails the intended case: a platform merging `Set-Cookie`, a transport sharing invocation state across aliases, a transport without a browser leg on safe operations, a `defineExtension()` transport with a lineage or nesting and no helper, a source throwing its denial, a source dropping its refresh cookie, a source turning a storage outage into a 401, and a policy widening delegated principals.

## Develop in this monorepo

From the repository root:

```sh
mise install
mise exec -- pnpm install
mise exec -- pnpm --filter nestjs-slightly-better-auth typecheck
mise exec -- pnpm --filter nestjs-slightly-better-auth build
mise exec -- pnpm test:packaging
```

The shared toolchain uses Node.js LTS, pnpm, tsdown, TypeScript and Vitest. Builds produce ESM and CommonJS artifacts with declarations. The `module-sync` export makes supported Node `import` and `require()` consumers share the same ESM module identity.

[Contributing](../../CONTRIBUTING.md) explains repository checks and PRs. See [package instructions](AGENTS.md) and [import provenance](docs/provenance.md) before working with the historical material.

## Releases

Versions come from Changesets, and publication runs from the monorepo's release workflow with npm trusted publishing and provenance; see [release automation](../../docs/releases.md). New entry points are additive, so they ship as minor versions.

## License

[MIT](LICENSE). The archived upstream adapter retains its [original MIT notice](legacy/LICENSE).
