# Better Auth Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement, verify, and prepare the complete `nestjs-slightly-better-auth` library for its first intended release, including all 13 designed entry points.

**Architecture:** A construction-time Better Auth plugin communicates through a versioned bridge with a singleton Nest kernel; the kernel owns instance isolation, request state, planning, and enforcement. HTTP platforms, transports, principal sources, and authorization policies implement public contracts and remain independent extension units. Active source files are flat, optional framework dependencies stay in their subpaths, and `module-sync` gives supported Node consumers one canonical ESM identity with a real CJS fallback.

**Tech Stack:** mise Node 24 LTS (`>=24.11.0`), pnpm 12.4.2, TypeScript 7.0.2, tsdown 0.23.0, Vitest 5.0.1, Nest 12.0.3, Better Auth 1.7.5, `@nestjs/graphql`/Apollo/Mercurius 14.0.1, defu 6.1.7. Proposed Nest 11 and Better Auth 1.7.0 compatibility remain test gates. Mercurius requires GraphQL 16.

**Spec:** [Design v7](../../../packages/nestjs-slightly-better-auth/docs/design/design-v7.md), especially §§2–14 and §17.3; [parent issue #534](https://github.com/thilllon/nestjs-kit/issues/534). The three independent round-7 reports approve the final design snapshot. Neither this plan nor historical experiments establish an implemented authentication API.

## Global Constraints

- Keep `private: true` until a reviewed implementation and its first intended release are ready. Never publish the empty scaffold to reserve an npm name.
- Do not mutate a Better Auth instance's options after construction. Keep optional platform integrations out of the root dependency graph when implementing them.
- Preserve `module-sync` ahead of `import` and `require` in package exports. Supported Node consumers must share one ESM module identity while real CommonJS output remains available as a fallback.
- Use Nest `@Inject()` directly; public helpers are `getBetterAuthInstanceToken(alias?)`, `getBetterAuthOptionsToken(alias?)`, `getBetterAuthServiceToken(alias?)`, and `getBetterAuthHandleToken(alias?)`, each returning `string`. Named tokens append `_<alias>` to the unchanged default base token. Keep `MODULE_OPTIONS_TOKEN` internal. Do not introduce injection-decorator aliases or `getAuthToken(kind, name)`.
- Async aliases, app platforms/transports, principal registrations, and enhancer registration flags are static extras outside `useFactory`. Named instances isolate options, credentials, endpoints, service objects, cookie names/scopes, hooks, caches, mounts, and cleanup.
- All active source and colocated tests belong directly in `packages/nestjs-slightly-better-auth/src/`. Tests use `*.test.ts`; middleware/network E2E uses `*.e2e.test.ts`. Historical `legacy/` code is reference-only.
- Use root shared TypeScript, tsdown, Biome, Prettier, Vitest, mise, and Changesets conventions. Prettier handles Markdown/YAML only. Include necessary `.mts` configuration in root typechecking.
- Preserve MIT licenses and historical design material. Write repository content in English. Do not recreate the retired migration guide.
- Default `pnpm test` requires neither network services, cloud credentials, nor built artifacts. Run artifact checks separately after build. Use isolated Compose services with health checks for middleware/storage/broker E2E and always clean up.
- Every implementation PR links its checklist issue and includes an explicit Changeset for publishable package changes. While this workspace is private and unreleased, its intermediate implementation PRs do not add release Changesets; Task 12 adds the single major Changeset for the first intended public release. This prevents automatic private-version churn between foundation slices. Do not append `Co-Authored-By` trailers. Merge only protected, verified revisions; use `gh pr merge --body ''`.
- Do not narrow the requested feature set to an HTTP adapter. Root, plugin, platform, Express, Fastify, GraphQL, WebSockets, RPC, admin, organization, API-key, testing, and conformance entries all have completion gates below.

---

## Execution status and review gates

Task 1 is implemented and independently reviewed, including the SDK database-hook context correction at `c97f0bdaa25cde594288b90f9cdae54c293bfcdd`, and merged in [PR #547](https://github.com/thilllon/nestjs-kit/pull/547). Repository lint, formatting, tools/package typecheck, 120 unit tests, eight package builds with strict publint/attw, and four artifact tests passed. This establishes contracts, safe errors, named token injection and CJS/ESM declaration consumption; it does not establish runtime authentication or transport behavior. Task 2 and Task 3's isolated primitives are implemented and independently reviewed in [PR #548](https://github.com/thilllon/nestjs-kit/pull/548), including the after-matcher exception-boundary and advisory extraction-error regressions. Updated validation passed 289 unit tests and five artifact tests. Task 3's concrete transport integration assertions remain open.

Task 4a and Task 4b's kernel implementation are independently reviewed in [PR #549](https://github.com/thilllon/nestjs-kit/pull/549), including the review fixes at `32746824cf8827ed46939384c4a4e912df4f6c06`. Verification passed 409 unit tests, seven built ESM/CJS artifact tests, repository lint/format/typecheck and all eight package builds with strict publint/attw. The reviews closed singleton dependency escapes, phantom handler planning, empty required principal sets, request memo identity retention and diagnostic findings. Existing tsdown CJS-output and experimental TypeScript 7 warnings remain visible. Real Nest enhancer and SDK tests now establish the core scope/origin behavior; concrete GraphQL field coverage and native platform/transport acceptance remain open in Tasks 5–10.

- [x] Record the independent v7 reviewers' decisions and close all round-6 findings in the design and parent issue before production implementation. Final design SHA-256: `a653719b8a48ff049b9c47ef9cf9a03d845948dab0314e083ee350041706175b`; see the three round-7 reports, including their final snapshot confirmations.
- [x] Freeze the reviewed v7 commit and the dependency-source evidence: design/plan commit `a6b720b98114c4c6701ee2d7b92509bf507cd966`, SDK 1.7.5 source commit `5468e6bfcdff799848537cf5ad06ebab15aad9dd`, Node 24.21.0 and Nest 12.0.3. Subsequent plan-only corrections do not change the reviewed design hash.
- [ ] Keep the linked issue checklists below current before each implementation starts; record the reviewed v7 commit in #535 and keep issue state, PR scope, and Changesets aligned.
- [ ] Execute each task's red/green cycle and preserve the actual failure/pass output or CI run link. A test that fails only because of an unavailable broker is not its intended red result.
- [ ] Independently review each task's behavior and code; integrate dependencies before declaring its acceptance gate complete.

The linked issue checklists already exist; their existence is planning evidence, not completed implementation:

| Issue                                                     | Owned plan work                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| [#535](https://github.com/thilllon/nestjs-kit/issues/535) | Reviewed design and dependency evidence gate                           |
| [#536](https://github.com/thilllon/nestjs-kit/issues/536) | Task 2: construction plugin and hooks                                  |
| [#537](https://github.com/thilllon/nestjs-kit/issues/537) | Task 3: scopes, origin evidence and scoped error delivery              |
| [#538](https://github.com/thilllon/nestjs-kit/issues/538) | Task 1 and Task 4a: contracts, foundation errors, module and lifecycle |
| [#539](https://github.com/thilllon/nestjs-kit/issues/539) | Task 4b: planner, resolver and evaluator                               |
| [#540](https://github.com/thilllon/nestjs-kit/issues/540) | Tasks 5–6: Express and Fastify                                         |
| [#541](https://github.com/thilllon/nestjs-kit/issues/541) | Task 7: admin, organization and API-key                                |
| [#542](https://github.com/thilllon/nestjs-kit/issues/542) | Task 8: GraphQL                                                        |
| [#543](https://github.com/thilllon/nestjs-kit/issues/543) | Task 9: WebSockets                                                     |
| [#544](https://github.com/thilllon/nestjs-kit/issues/544) | Task 10: RPC                                                           |
| [#545](https://github.com/thilllon/nestjs-kit/issues/545) | Tasks 11–12: testing, artifacts and release                            |

Task 3's isolated primitives are reviewed before Task 4 consumes them. Its end-to-end guard, scope-interceptor and SDK-call assertions depend on Task 4b, so they remain explicit acceptance gates there and in transport integration; passing primitive tests does not check those assertions off. Issue #537 stays open until that integration evidence exists.

The task groups are separate review boundaries within one plan because the requested release spans independently implementable subsystems. Parallel work is authorized only after the shared contracts are frozen. Task 2 and Task 3 can proceed together; after Tasks 4a–4b, Tasks 5–10 can use separate worktrees and file ownership. Task 11 can develop kits alongside the transport owners using those same frozen contracts. The integrator owns public barrels, manifests, shared configuration, lockfile, Compose, CI, and cross-task changes; a worker requests an interface change through the integrator instead of editing another worker's files.

## File structure and ownership

Paths below are repository-relative. For readability, `P` in explanatory prose means `packages/nestjs-slightly-better-auth`; commands and file lists use actual paths.

| Owner                | Flat source files                                                                                                                                                                                                                                               | Responsibility                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Task 1 / integrator  | `index.ts`, `auth-contracts.ts`, `auth-types.ts`, `auth-tokens.ts`, `bridge-protocol.ts`, `auth-errors.ts`, `error-redactor.ts`                                                                                                                                 | Public contracts, derived types, stable tokens, safe errors/redaction and explicit root exports.        |
| Task 2               | `plugin.ts`, `hook-dispatcher.ts`, `database-hook-dispatcher.ts`                                                                                                                                                                                                | Pure construction plugin, hook parity, binding protocol.                                                |
| Task 3               | `request-scope.ts`, `principal-readings.ts`, `origin-check.ts`, `trusted-origins.ts`, `platform.ts`                                                                                                                                                             | Async context, request/invocation caches, lazy capabilities, origin evidence and scoped error delivery. |
| Task 4a              | `auth-module.ts`, `auth-core-module.ts`, `auth-module-definition.ts`, `instance-registry.ts`, `bridge-client.ts`, `hook-binder.ts`, `boot-validator.ts`, `mount-coordinator.ts`, `auth-service.ts`, `auth-exchange.ts`, `http-transport.ts`, `test-fixtures.ts` | Nest instance composition, lifecycle, service assembly, exchange and test fixtures.                     |
| Task 4b              | `auth-decorators.ts`, `route-planner.ts`, `transport-registry.ts`, `policy-resolver.ts`, `principal-resolver.ts`, `authorization-evaluator.ts`, `auth-guard.ts`, `auth-scope-interceptor.ts`, `session-principal.ts`                                            | Plans, principal resolution, policy evaluation, readers and enhancer collaborators.                     |
| Task 5               | `express.ts`, `express-platform.ts`                                                                                                                                                                                                                             | Express capture, dispatch, and actual shared HTTP contract evidence.                                    |
| Task 6               | `fastify.ts`, `fastify-platform.ts`                                                                                                                                                                                                                             | Fastify parser isolation, reply/cookie mapping, HTTP/2, request-time errors.                            |
| Task 7               | `admin.ts`, `organization.ts`, `api-key.ts`                                                                                                                                                                                                                     | SDK-backed authorization, organization references, delegated API-key identity.                          |
| Task 8               | `graphql.ts`, `graphql-transport.ts`, `graphql-lineage.ts`                                                                                                                                                                                                      | Apollo/Mercurius, HTTP/WebSocket operations, federation and invocation lineage.                         |
| Task 9               | `websockets.ts`, `socket-io-transport.ts`, `ws-transport.ts`, `ws-connection-auth.ts`                                                                                                                                                                           | Socket transports, upgrade recording, connect-time authentication.                                      |
| Task 10              | `microservices.ts`, `rpc-transport.ts`, `rpc-carriers.ts`                                                                                                                                                                                                       | RPC transport, six metadata/envelope carriers, native errors and coverage.                              |
| Task 11              | `testing.ts`, `testing-conformance.ts`, `conformance-http.ts`, `conformance-transport.ts`, `conformance-principal.ts`, `conformance-policy.ts`, `conformance-fixtures.ts`                                                                                       | Consumer overrides and runner-agnostic conformance kits.                                                |
| Task 12 / integrator | `packaging.test.ts` (existing), `architecture.test.ts`, `consumer-types.test.ts`, explicit example files below                                                                                                                                                  | Integrated release evidence and supported consumer behavior.                                            |

Every source owner also owns the colocated tests named in its task. No nested active source directory is introduced; the exported `testing/conformance` entry maps to `src/testing-conformance.ts`.

## Frozen interface handoff

Use the final reviewed v7 declarations, not inferred copies of the legacy adapter. These sections identify complete signatures without duplicating the specification:

| Consumer                                | Contract source in design v7                                                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module and extension factories          | §2.2.1: `BetterAuthModule`, static/runtime/async options, `ExtensionRef`, `ExtensionDefinition`, `defineExtension`.                                            |
| Guards, services, planner and overrides | §2.2.2: `RoutePlan`, `PrincipalReading`, `ResolutionRequest`, `PrincipalResolver`, `PolicyInvoker`; §2.2.8 and §2.3: tokens.                                   |
| Platforms and exchange                  | §4.1.1: `HttpPlatform`, prepare/mount contexts, binding, inbound request, mandatory `HttpRequestAccessor.isLive`, `CookieSink`; §2.2.10–11: helpers/factories. |
| Transports                              | §4.2.1: `AuthTransport`, `TransportCall`, `BrowserExposure`, `InvocationLineage`, `TransportKit`, claims; §4.2.2 T1–T11.                                       |
| Principal sources and policies          | §4.3.1: `PrincipalSource`, `PrincipalRequest`, `AuthHandle`, `ScopeInit`, context view; §4.4.1: policy, requirements, decisions and context.                   |
| Plugin                                  | §10.2: protocol-4 `BridgeHandle`, `BridgeBinding`, lazy `ScopeView`, `CompiledHook`; §10.5–6: endpoint/DB return and lifecycle semantics.                      |
| Optional entries                        | §2.2.12–16, with behavior in §§8–9 and §14.8.                                                                                                                  |
| Derived public types                    | §11.3–5; do not replace instance-derived session, hook, permission, or registry types with `any`.                                                              |

The following invariants are part of those interfaces, not optional implementation choices:

```ts
interface PrincipalResolver {
  resolve(
    call: TransportCall,
    request: ResolutionRequest,
  ): Promise<PrincipalResult>;
}

interface PolicyInvoker {
  invoke<P>(
    policy: AuthorizationPolicy<P, any>,
    params: P,
    context: AuthorizationContext,
  ): Promise<AuthorizationDecision>;
}

interface CookieSink {
  append(setCookies: readonly string[]): boolean;
}
```

`TransportCall.key` identifies a logical request, `invocation` identifies one handler invocation, and `connection` is used only for optional principal TTL. `describe()` must be a nonthrowing structural envelope for a context accepted by `handles()`. Its request-dependent `headers()`, `browser`, `cookies`, `request`, and `clientIp` capabilities may throw the original extraction error only when consumed. Scope creation must preserve deferred getters without object spreading, destructuring, null fallbacks, or automatic `runOutsideScope`. Public work can run without extraction; guarded work and direct scoped auth calls must fail before side effects if extraction is unavailable.

## Task 1: Implement foundation contracts, safe errors, tokens, and build ownership

**Files:**

- Create: `packages/nestjs-slightly-better-auth/src/auth-contracts.ts`, `auth-types.ts`, `auth-tokens.ts`, `bridge-protocol.ts`, `auth-errors.ts`, `error-redactor.ts`, `auth-token-injection.test.ts`, `auth-errors.test.ts`, `error-redactor.test.ts`.
- Modify: `packages/nestjs-slightly-better-auth/src/index.ts`, `packages/nestjs-slightly-better-auth/package.json`, `tsdown.config.mts`, `tsconfig.tools.json`, `pnpm-lock.yaml`.
- Create: `packages/nestjs-slightly-better-auth/tsdown.config.mts`.
- Retain package privacy; defer its first release Changeset to Task 12.

**Interfaces:** Produces all frozen v7 contracts/types, the four public token helpers, and the complete public error contract in v7 §2.2.6/§13: `AuthFailure`/`AuthErrorCode`, `AuthFailures`, configuration/infrastructure classes and predicates, `getRawCause`, and the error payload/mapping types. Error normalization and redaction are complete foundation implementations, not deferred declarations. The bridge's runtime brand stays `Symbol.for('nestjs-slightly-better-auth:bridge')`; public instance tokens are stable readable strings. Only implemented entry files enter the build at this stage; the final 13-entry acceptance gate is Task 12.

The foundation dependency direction is fixed: `auth-contracts.ts`, `auth-types.ts`, and `bridge-protocol.ts` import error shapes with `import type` from `auth-errors.ts`; `auth-errors.ts` owns those shapes and imports only the independent `error-redactor.ts`, SDK error detection, and type-only Nest context definitions. `error-redactor.ts` consumes supplied credential values/header names, never request scope, registry, module, transport, or plugin state. Neither foundation file imports Task 3 or a later implementation. Root explicitly exports the completed runtime errors; do not add stub classes, deferred throwing bodies, or ambient runtime declarations to satisfy compilation.

- [x] Add this actual redaction regression in `auth-errors.test.ts`:

```ts
it("does not serialize session credentials in an infrastructure cause", () => {
  const credential = crypto.randomUUID();
  const cause = Object.assign(
    new Error(`query failed for ${credential}\nSQL params`),
    {
      code: "08006",
    },
  );
  const error = new BetterAuthInfrastructureError(cause, {
    secrets: [credential],
  });
  expect(error.message).toBe("Authentication service unavailable");
  expect(error.cause.message).not.toContain(credential);
  expect(error.cause.message).not.toContain("SQL params");
  expect(inspect(error)).not.toContain(credential);
  expect(JSON.stringify(error)).not.toContain(credential);
  expect(getRawCause(error)).toBeUndefined();
});
```

Import `inspect` from `node:util`. Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/auth-errors.test.ts`; verify failure, then implement branded, cross-copy-safe errors and credential redaction. Preserve allow-listed error fields, redacted nested causes, generic client messages, and raw-cause opt-in under a non-enumerable symbol.

- [x] Add `error-redactor.test.ts` cases for URL-decoded and signed cookie secrets, bearer credentials, declared API-key headers, nested cause depth, 300-character/first-line truncation, stack header redaction, and raw-cause visibility. Callers supply credential headers and secrets; Task 3 later gathers them from scopes. Verify serialized/inspected default errors never expose secrets and explicit raw-cause opt-in is non-enumerable.
- [x] Implement `AuthFailures.fromAPIError` and internal normalization against §13.2 using actual SDK `APIError` objects. Test 401/403/429 denials, Retry-After extraction, policy generic-401 session-loss candidates, unexpected 4xx configuration failures, unknown/5xx infrastructure failures, unchanged already-classified errors, and cross-copy branding. A storage error must never become an authentication denial. Request/operation deduplication belongs to Task 3, not these foundation classes.
- [x] Write this real Nest provider-coexistence regression in `auth-token-injection.test.ts`; it needs no not-yet-implemented auth module. Import `Inject`, `Injectable` from `@nestjs/common`, `Test` from `@nestjs/testing`, and the token helpers from `auth-tokens.ts`:

```ts
it("resolves default and named collaborators independently through Nest DI", async () => {
  const primary = { endpoint: "https://primary.example" };
  const admin = { endpoint: "https://admin.example" };
  const adminOptions = { cookiePrefix: "admin" };
  @Injectable()
  class Consumer {
    constructor(
      @Inject(getBetterAuthInstanceToken())
      readonly primary: { endpoint: string },
      @Inject(getBetterAuthInstanceToken("admin"))
      readonly admin: { endpoint: string },
      @Inject(getBetterAuthOptionsToken("admin"))
      readonly options: typeof adminOptions,
    ) {}
  }
  const module = await Test.createTestingModule({
    providers: [
      Consumer,
      { provide: getBetterAuthInstanceToken(), useValue: primary },
      { provide: getBetterAuthInstanceToken("admin"), useValue: admin },
      { provide: getBetterAuthOptionsToken("admin"), useValue: adminOptions },
    ],
  }).compile();
  try {
    const consumer = module.get(Consumer);
    expect(consumer.primary).toBe(primary);
    expect(consumer.admin).toBe(admin);
    expect(consumer.options).toBe(adminOptions);
  } finally {
    await module.close();
  }
});
```

- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/auth-token-injection.test.ts`; observe the missing implementation failure, then implement the named/default token helpers. This regression must also fail if aliases collide or the options namespace reuses the instance token. Reject empty aliases during module option validation in Task 4a. Preserve exact v7 base strings. Full module lifecycle and compiled consumer metadata are verified in Tasks 4a and 12.
- [x] Copy the reviewed declarations from the contract sections above into their owning flat files. Keep imports type-only where they are types; derive registered session/permission/hook types from the SDK instance. Root exports are explicit, without injection aliases, optional framework imports, or internal module-options token.
- [x] Export reusable build options from root `tsdown.config.mts` and consume them in the package config; keep the root default build behavior for the established integrations. The foundation uses an explicit entry map. Add the separate pure-plugin build when the plugin lands in Task 2; no unimplemented entry is declared. Include `packages/*/*.mts` in root tooling typecheck. Preserve `module-sync`, strict publint/attw, matching declarations and external dependencies.
- [x] Install dependencies through pnpm only, with reviewed runtime/optional-peer separation; run `mise exec -- pnpm --filter nestjs-slightly-better-auth typecheck` and `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/auth-token-injection.test.ts packages/nestjs-slightly-better-auth/src/auth-errors.test.ts packages/nestjs-slightly-better-auth/src/error-redactor.test.ts`. These files must compile and pass before Task 2 or Task 3 starts, without any later source files. Before promising Nest 11, SDK 1.7.0, or a GraphQL major, attach actual compatibility evidence from Task 12.
- [x] Commit the scoped private-package changes with `feat(auth): add typed contracts safe errors and isolated tokens`; keep this task open until typecheck and contract review pass.

## Task 2: Implement the pure plugin and faithful hook dispatch

**Files:** Create `packages/nestjs-slightly-better-auth/src/plugin.ts`, `hook-dispatcher.ts`, `database-hook-dispatcher.ts`, `plugin.test.ts`, `hook-dispatcher.test.ts`, `database-hook-dispatcher.test.ts`.

**Interfaces:** Consumes `bridge-protocol.ts` types only. Produces `nestjs(options?: NestjsPluginOptions): BetterAuthPlugin & { id: typeof NESTJS_PLUGIN_ID }` and the protocol-4 handle from v7 §10.2. Module code reaches the handle only through the symbol on `$context.getPlugin(id)`.

- [x] Add the binding regression below. Construct a complete test-local `BridgeBinding` with all 12 database targets (`user|session|account|verification` × `create|update|delete`) mapped to empty before/after arrays, empty endpoint arrays, no credentials, `current: () => undefined`, and `onDropped: () => undefined`.

```ts
it("retains security hooks after close and rejects a second live owner", () => {
  const plugin = nestjs();
  const bridge = (plugin as unknown as Record<symbol, BridgeHandle>)[
    Symbol.for("nestjs-slightly-better-auth:bridge")
  ];
  const registration = bridge.bind(binding);
  binding.state = "bootstrapped";
  expect(() =>
    bridge.bind({ ...binding, owner: { description: "other app" } }),
  ).toThrow("INSTANCE_ALREADY_BOUND");
  registration.close();
  expect(bridge.state).toBe("closed");
  expect(
    bridge.bind({ ...binding, owner: { description: "next app" } })
      .tookOverFrom,
  ).toBeUndefined();
});
```

- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/plugin.test.ts`; verify the intended failure, then implement the binding state machine. A same-owner/same-instance bind is idempotent; a shared plugin object across instances fails; failed-init takeover warns; closing never nulls the binding.
- [x] Add differential tests that register identical hooks as native SDK plugins and as compiled Nest hooks. Compare returned values, response headers, and memory-adapter rows for before context/array/header merges, short circuits, throwing predicates, after replacement/APIError, DB create chaining, update/updateMany original-input deltas, delete abort, and after-commit effects. Explicitly assert native before-hook cookies are lost on normal endpoint execution but preserved on short circuit. For BA-r7-02, separately exercise a thrown direct `APIError`: preserve its symbol-attached response headers and cookies even when ordinary enumerable headers are absent. Compare router delivery separately; router header loss must not be generalized to direct thrown errors.
- [x] Implement fixed entries in v7 §10.2 order: refresh suppression, caller-session capability check, Nest before dispatcher; Nest after dispatcher, endpoint-result observer, cookie bridge. Test with real `betterAuth()` on SDK 1.7.5; later floor matrix repeats on 1.7.0. No post-construction options mutation and no per-hook array mutation at bind time.
- [x] Verify credential matching uses the resolved secure-prefixed cookie name, authorization, and source-declared headers; foreign direct-call cookies are dropped. A lazy capability extraction error must surface before any SDK endpoint side effect, including calls that carry no browser credential. Stateless and nested endpoint refresh suppression must use `setShouldSkipSessionRefresh(true)`, not only `disableRefresh`.
- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/plugin.test.ts packages/nestjs-slightly-better-auth/src/hook-dispatcher.test.ts packages/nestjs-slightly-better-auth/src/database-hook-dispatcher.test.ts` and package typecheck. Commit the scoped changes as `feat(auth): add construction-time hook and cookie bridge`.

## Task 3: Implement request state, lazy capability safety, origin evidence, and scoped error delivery

**Files:** Create `packages/nestjs-slightly-better-auth/src/request-scope.ts`, `principal-readings.ts`, `origin-check.ts`, `trusted-origins.ts`, `platform.ts`, `request-scope.test.ts`, `principal-readings.test.ts`, `origin-check.test.ts`, `trusted-origins.test.ts`, and `platform.test.ts`. Consume Task 1's completed `auth-errors.ts` and `error-redactor.ts`; do not duplicate or move their implementation/tests.

**Interfaces:** Consumes Task 1's v7 `ScopeInit`, `ScopeView`, `TransportCall`, `PrincipalReading`, `AuthContextView`, and implemented public error/redaction foundation. Produces kernel-local `RequestScope` with the exact internal signatures below, implementing v7 §3.1 U3 and §§7.2/7.8. Consumers use these types rather than accessing the ALS or WeakMap directly. Uses Task 1's error constructors/predicates and adds only credential gathering, origin-error handling and request-level delivery/deduplication from §§7.8/13.4. Also produces the Node/Web helpers in §2.2.10; these depend only on Node built-ins and contract types, so Task 4a can build its Web exchange without importing a concrete platform.

Freeze this internal handoff with the contract PR. `ScopeState.view` retains the original lazy getters; `reading` is absent outside handler scopes. Calling `stateFor` with request, invocation, connection, or browser-leg keys obtains distinct state; every string memo key includes the instance name and the concrete inputs specified by v7 §7.2.

```ts
export interface ScopeState {
  readonly view: ScopeView;
  readonly call?: TransportCall;
  readonly plan?: RoutePlan;
  readonly reading?: () => PrincipalReading;
}
export interface RequestState {
  readonly principal: Map<string, Promise<PrincipalResult>>;
  readonly policyIo: Map<string, Promise<unknown>>;
  readonly decisions: Map<string, Promise<AuthorizationDecision>>;
  readonly values: Map<symbol, unknown>;
  readonly authorizationCalls: Set<string>;
  readonly origins: Map<string, Promise<AuthFailure | null>>;
  readonly surfaced: Set<string>;
  readonly connections: Map<
    string,
    {
      value: Extract<PrincipalResult, { outcome: "authenticated" | "absent" }>;
      expiresAt: number;
    }
  >;
}
export interface RequestScope {
  run<T>(state: ScopeState, fn: () => T): T;
  current(): ScopeState | undefined;
  stateFor(key: object): RequestState;
}
```

The concrete class and interface can share `RequestScope` through TypeScript declaration merging. Keep invocation values isolated by instance as v7 requires (namespace their symbol keys); do not use the request object's state for invocation decisions. Origin records use the browser leg's key, and connection entries use the connection's key.

- [x] Write this lazy-capability regression in `request-scope.test.ts`, importing `RequestScope`, `ScopeView`, and Task 1's `BetterAuthConfigurationError`:

```ts
it("opens harmless work without reading a missing transport capability", () => {
  const scope = new RequestScope();
  const extractionError = BetterAuthConfigurationError.atRequest(
    "GRAPHQL_CONTEXT_UNRECOGNIZED",
    "No live request is present in the GraphQL context",
  );
  let reads = 0;
  const view: ScopeView = {
    get cookies() {
      reads += 1;
      throw extractionError;
    },
    forward: "same-credential",
    inbound: undefined,
    internal: false,
    browserHeaders: undefined,
  };
  expect(scope.run({ view }, () => "public result")).toBe("public result");
  expect(reads).toBe(0);
  expect(() =>
    scope.run({ view }, () => scope.current()!.view.cookies),
  ).toThrow(extractionError);
  expect(reads).toBe(1);
  expect(scope.current()).toBeUndefined();
});
```

- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/request-scope.test.ts`; verify failure, then implement the ALS/WeakMap scope with unchanged lazy property descriptors and automatic context restoration even when capability extraction throws. The direct SDK-call enforcement regression follows through the real plugin in Task 4b/transport acceptance; this regression establishes the shared scope primitive.
- [x] Add concurrency tests with deferred promises for one logical request vs two requests, two named instances, two source-set content keys, two invocations, and connection TTL. Store promises before awaiting; cache request failures; connection entries contain only authenticated/absent and authoritative reads bypass them. Authorization I/O budget counts distinct keys atomically, including reclassification; policy decisions/values never cross invocation boundaries.
- [x] Add lazy-capability tests using an object with getters that increment counters and throw `BetterAuthConfigurationError.atRequest('GRAPHQL_CONTEXT_UNRECOGNIZED', ...)`. Creating/opening a public scope must read none of those getters; consuming auth capabilities must throw rather than return undefined/null; an authenticated inherited reading checks liveness, a no-identity reading does not. Deduplicate reader configuration errors by logical-request/carrier and reason/site alongside guard errors.
- [ ] Implement v7 §7.10 origin matching and §7.5 caller-session evidence. Test unsafe denial before resolver I/O; advisory safe-method verdict only in cookie mode without denying pure reads; form mode always enforces, including cookie-free GET/HEAD/OPTIONS and GraphQL queries on forwarding handlers; cross-site guarded GET direct `signOut` blocked; cookie plus junk token and ambient cookie shadowed by connectionParams still protected. Use the single kernel skip predicate and explicit stricter SDK divergence for `disableOriginCheck: true` with defined `disableCSRFCheck`.
- [x] Differentially compare cookie/form verdicts with real SDK routes, including cross-site no-cookie GET form forwarding (denied before endpoint effects), same-origin success, no-cookie form navigation, null/missing origins, trustedOrigins function/plugin contribution, path-array skips and boolean skip combinations. Set `advanced.disableOriginCheck: false` explicitly in security fixtures; Vitest's `TEST=true` must not invalidate the test.
- [x] Implement `platform.ts` helpers from v7 §2.2.10. Add `platform.test.ts` covering bounded Node/Web streams, declared/chunked overflow, aborts, pseudo-header filtering, individual cookies, HEAD/backpressure and TLS-plus-Host upgrade URLs. These are stream/object tests without a listening server.
- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/request-scope.test.ts packages/nestjs-slightly-better-auth/src/principal-readings.test.ts packages/nestjs-slightly-better-auth/src/origin-check.test.ts packages/nestjs-slightly-better-auth/src/trusted-origins.test.ts packages/nestjs-slightly-better-auth/src/platform.test.ts` and package typecheck, then commit the scoped changes as `feat(auth): isolate request state and enforce origin-safe scopes`.

## Task 4a: Implement Nest registration, lifecycle, and extension assembly (#538)

**Files:** Create `auth-module.ts`, `auth-core-module.ts`, `auth-module-definition.ts`, `instance-registry.ts`, `bridge-client.ts`, `hook-binder.ts`, `boot-validator.ts`, `mount-coordinator.ts`, `auth-service.ts`, `auth-exchange.ts`, `http-transport.ts`, and `test-fixtures.ts` in `packages/nestjs-slightly-better-auth/src/`, plus `auth-module.test.ts`, `auth-lifecycle.test.ts`, `boot-validator.test.ts`, and `auth-exchange.test.ts`. The integrator updates explicit root exports. Task 4b owns the enforcement files listed in Task 4b.

**Interfaces:** Consumes Tasks 1–3. Produces the `BetterAuthModule`, service, app registries, lifecycle and extension assembly from v7 §§2.2.1, 2.2.3, 5 and 6.3. Task 4b consumes only the frozen v7 `PrincipalResolver`/`PolicyInvoker` ports, Task 3 `RequestScope`, and the instance handles from §4.3.1. Task 4a wires its completed collaborators after their integration; a test-local resolver may prove lifecycle assembly but cannot establish auth behavior. Module/service publication and B16 acceptance remain open until Task 4b passes. No production permissive placeholder guard is allowed.

Create `test-fixtures.ts` with these test-only exports; never export it publicly or include it as a tsdown entry:

```ts
export function createTestAuth(
  options?: BetterAuthOptions,
): ReturnType<typeof betterAuth>;
export interface HttpFixture {
  readonly app: INestApplication;
  readonly url: string;
  close(): Promise<void>;
}
export function startHttpFixture(options: {
  auth: AuthLike;
  adapter: AbstractHttpAdapter;
  platform: ExtensionRef<HttpPlatform>;
  controllers: readonly Type[];
  providers?: readonly Provider[];
  moduleOptions?: Partial<BetterAuthRuntimeOptions<AuthLike>>;
  configure?: (app: INestApplication) => void | Promise<void>;
}): Promise<HttpFixture>;
```

`createTestAuth` creates a fresh memory-adapter store, random secret, static localhost baseURL, enabled email/password, `advanced.disableOriginCheck: false`, and a fresh `nestjs()` last in the plugin list; supplied SDK options compose before that final plugin. `startHttpFixture` builds a fresh TestingModule, imports the real library, runs configure before init, listens on a random loopback port, and returns `app.close` cleanup. It accepts no cloud credentials. Network-backed callers belong to `.e2e.test.ts`, while module/context and direct memory-adapter tests remain ordinary unit tests.

- [x] Start with a real Nest injection/isolation failure in `auth-module.test.ts`:

```ts
it("injects distinct named services around the original auth objects", async () => {
  const primary = createTestAuth();
  const admin = createTestAuth({ advanced: { cookiePrefix: "admin" } });
  const module = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({ auth: primary, http: { mount: false } }),
      BetterAuthModule.forRoot({
        name: "admin",
        auth: admin,
        http: { mount: false },
      }),
    ],
  }).compile();
  try {
    await module.init();
    expect(
      module.get<BetterAuthService>(getBetterAuthServiceToken()).instance,
    ).toBe(primary);
    expect(
      module.get<BetterAuthService>(getBetterAuthServiceToken("admin"))
        .instance,
    ).toBe(admin);
  } finally {
    await module.close();
  }
});
```

- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/auth-module.test.ts`; verify failure. Implement static singleton core plus per-instance providers, app-level registries and explicit `@Inject` constructor parameters. The default service class alias must not be overwritten by a named registration.
- [x] Add and implement lifecycle tests: adapter/platform arrival in either order, async factory, adapter-less context, duplicate lifecycle calls, live second app rejected, failed-init takeover, shared plugin object rejected, and security DB hooks still active while a later shutdown hook drains. Implement preparation before Nest parsers, aggregate boot sequence, bootstrapped/closed ownership and named hook discovery exactly as §5.7/§10.6 require. Actual HTTP adapter reuse cases finish in Tasks 5–6.
- [x] Implement `auth-exchange.ts` from v7 §6.3 over Task 3 helpers and the built-in `http-transport.ts` from §9.1 over `HttpRequestAccessor`. `MountCoordinator` constructs complete bindings without importing Express/Fastify. Unit-test raw path boundaries, static-origin substitution, body limits, IP/header hygiene, SDK APIError handling and around-chain order with real Web Request/Response objects; actual platform behavior follows in Tasks 5–6.
- [x] Add and implement all B01–B31 boot checks from v7 §5.4. Cover actual enhancer identity plus cross-copy brands; global guard-only coverage with globalScope:false warns, explicit gateway/hybrid coverage requires both enhancers. Check metadata canaries before enumerating claims. Validate effective SDK origin/rate-limit/secret values, unsafe baseURL, cookie-scope collisions, default/named structure, plugin prerequisites, singleton dependency trees, hook paths, and extension advice. Aggregate failures once.
- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/auth-module.test.ts packages/nestjs-slightly-better-auth/src/auth-lifecycle.test.ts packages/nestjs-slightly-better-auth/src/boot-validator.test.ts packages/nestjs-slightly-better-auth/src/auth-exchange.test.ts` and package typecheck after Task 4b's ports are integrated. Commit the scoped changes as `feat(auth): assemble isolated Nest instances and lifecycle`. Do not mark HTTP mounting or optional transports complete here.

## Task 4b: Implement planning, resolution, policies, and readers (#539)

**Files:** Create `packages/nestjs-slightly-better-auth/src/auth-decorators.ts`, `route-planner.ts`, `transport-registry.ts`, `policy-resolver.ts`, `principal-resolver.ts`, `authorization-evaluator.ts`, `auth-guard.ts`, `auth-scope-interceptor.ts`, `session-principal.ts`, `route-planner.test.ts`, `principal-resolver.test.ts`, `authorization-evaluator.test.ts`, and `auth-readers.test.ts`. Coordinate service/module/boot-validator integration with Task 4a; do not independently edit its files.

**Interfaces:** Consume Tasks 1–3, the exact v7 §§2.2.2/4.3.1/4.4.1 ports and Task 3 scope signatures. Produce the root decorators/enhancers, planner, resolver/evaluator and built-in session source in §§2.2.2–8/7/8. `BetterAuthGuard` and `BetterAuthScopeInterceptor` are thin delegates over `GUARD_CORE`/`SCOPE_CORE`; test overrides use those collaborator tokens. Task 4b can develop pure planning/source/evaluator tests alongside Task 4a after contract freeze; real Nest integration is the shared acceptance gate.

- [x] Start the red regression in `auth-readers.test.ts` using a real module application context from Task 4a. Outside a handler scope, obtain its actual `BetterAuthService` and assert:

```ts
expect(() => service.getSession()).toThrowError(
  expect.objectContaining({ code: "NO_AUTH_SCOPE" }),
);
expect(() => service.getPrincipal()).toThrowError(
  expect.objectContaining({ code: "NO_AUTH_SCOPE" }),
);
```

Inside a real scoped handler with an authenticated non-session principal, both the session parameter and service session reader must instead fail with `SESSION_REQUIRED`. A GraphQL field without the scope interceptor follows the absent-scope contract; it must not be reported as an authenticated kind mismatch.

- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/auth-readers.test.ts`; verify the reader behavior fails before implementing it. Use the Task 3 scope port, and never initiate principal resolution from a reader.
      Implementation clarification: v7 §7.6 step 3 omits method-level `@AcceptPrincipals` from its required-access trigger, while the `RoutePlan.access` contract and planner acceptance section say inheritance applies only without method-level access, acceptance or requirements. For nested handlers, explicit method acceptance therefore selects `required` when there is no explicit access decorator. This prevents an explicit kind restriction from being ignored by the inherit early return and coverage exemption. Explicit `@Public`/`@OptionalAuth`/`@RequireAuth` still wins; class-level acceptance remains ignored for nested handlers. Add compiler and coverage regressions. This may require field guards where a consumer explicitly restricts field kinds; it does not change undecorated field inheritance. The reviewed design snapshot remains unchanged.

- [x] Add and implement planner/resolver tests: inherited handler function on public vs protected subclasses, append-only base/class/method/default requirements, unknown/unsatisfiable principal kinds, explicit-source opt-in, source-set memo by content, rejected credential stopping the chain, public zero lookup, optional absence vs rejection, and authoritative endpoint-produced session provenance. A short-circuit session with undefined headers must work normally and fail authoritative access.
- [x] Add and implement evaluator/readers tests: per-invocation decisions, per-request I/O memo and 100-call budget, generic policy 401 reclassification once/request, coded 401→403, unexpected 4xx→configuration500, outage → 500. Service `getSession()` and session parameters throw `SESSION_REQUIRED` for an authenticated wrong kind inside a real scope; service readers without scope throw `NO_AUTH_SCOPE`. Missing scope/result is never anonymous. Public/inherit reading semantics and cross-instance lineage match v7 §7.8.
- [x] Complete Task 3's real integration assertions: origin denial precedes resolver I/O; pure safe reads remain allowed while cross-site guarded GET `auth.api.signOut` fails before effects; public scopes preserve deferred capability getters; ambient browser cookies remain protected when transport credentials are remapped. Exercise actual service/guard/interceptor/plugin composition, and carry concrete GraphQL/WebSocket extraction cases into their transport tasks. Share scoped error deduplication between guard mappings and synchronous readers, retaining native execution context.
- [ ] Apply SEC-r7-01 before the guard's inherit return: form-mode origin checks always execute, without a new principal lookup. Test an inheriting GraphQL field with cookie-free cross-site GET/query forwarding, a same-origin positive control, and one shared principal read. B16 exempts inheritance only for non-form plans; a forwarding inheriting field without field guards must fail boot. The core behavior is verified through the actual Nest ExternalContextCreator pipeline; this checkbox stays open for the concrete GraphQL driver/field regression in Task 8.
- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/route-planner.test.ts packages/nestjs-slightly-better-auth/src/principal-resolver.test.ts packages/nestjs-slightly-better-auth/src/authorization-evaluator.test.ts packages/nestjs-slightly-better-auth/src/auth-readers.test.ts` plus Task 4a's real Nest suite and package typecheck. Commit the scoped changes as `feat(auth): enforce planned principals and invocation permissions`. Review this separately from lifecycle before enabling transport acceptance.

## Task 5: Implement Express integration and the shared HTTP acceptance suite

**Files:** Create `packages/nestjs-slightly-better-auth/src/express.ts`, `express-platform.ts`, and `express.e2e.test.ts`. Consume the completed `platform.ts`, `auth-exchange.ts`, and `http-transport.ts` from Tasks 3, 4a and 4b; the integrator coordinates any necessary corrections to those files. Integrator owns Compose/E2E changes needed by the middleware gate.

**Interfaces:** Consumes Tasks 3, 4a and 4b helpers/exchange/HTTP transport and produces v7 §2.2.11 Express factories implementing the full §4.1 platform contract. `AuthRouteBinding.handle(inbound: InboundAuthRequest): Promise<Response>` owns platform-neutral request construction; `CookieSink.append` preserves existing cookies and returns false after headers are sent. Root exports only built-in HTTP transport, not Express.

- [x] Add this real endpoint fixture to `express.e2e.test.ts` using `ExpressAdapter`, `expressPlatform()`, `createTestAuth`, and `startHttpFixture`:

```ts
it("rejects an oversized auth body with the host CORS header", async () => {
  const fixture = await startHttpFixture({
    auth: createTestAuth(),
    adapter: new ExpressAdapter(),
    platform: expressPlatform(),
    controllers: [],
    moduleOptions: { http: { bodyLimit: 8 } },
    configure: (app) =>
      app.enableCors({ origin: "https://app.example", credentials: true }),
  });
  try {
    const response = await fetch(`${fixture.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        origin: "https://app.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "too large" }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(await response.json()).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds the configured limit",
    });
  } finally {
    await fixture.close();
  }
});
```

- [x] Run `mise exec -- pnpm exec vitest run --config vitest.e2e.config.mts packages/nestjs-slightly-better-auth/src/express.e2e.test.ts`; confirm intended failure. Implement prepare-time bounded capture and init-time dispatch; capture never answers early before CORS. Overflow drains to the cap, then destroys the socket; non-auth application parsers remain unchanged.
- [x] Integrate the shared helpers and exchange through Express using raw undecoded path boundaries, post-init baseURL/basePath, exact bytes/query/encoding, static-origin substitution, hop-header removal and trusted platform IP injection. Add tests for JSON spacing, URL-encoded/multipart/binary/chunked bodies, limits, consumed-body fallback warning, pseudo headers, and Host/forwarding spoofing. No broad `toNodeHandler` shortcut.
- [x] Implement response write-back with individual cookie values, Vary union, retained host headers, backpressure, aborts, redirect preservation and no HEAD body. Verify SDK APIError hidden headers and unchanged rethrow with `onAPIError.throw`; actual Nest exception filters observe failures. Test all methods, controller precedence, prefix/versioning independence, async bootstrap, and Express reused-container failure.
- [x] Add real signup/login/protected/optional/public controller flows with cookie refresh and cleanup. Compare direct foreign credential forwarding, declared login proxy form-CSRF enforced even on cookie-free GET/HEAD/OPTIONS, safe-method advisory origin only for cookie-mode routes, and SDK router behavior under v7 security defaults; do not return a synthetic session fixture as authentication evidence.
- [x] Run targeted unit/E2E tests, package typecheck/build, and Tasks 4a–4b regression tests after integration. Commit the scoped changes as `feat(auth): preserve Express auth body and cookie semantics`.

**Controller ownership correction:** Bounded capture must skip native controller-owned routes before the body parser. Core provides immutable method/path descriptors resolved through Nest `RoutePathFactory`, including module paths, excluded global prefixes and URI versions. Express matches with the installed native routing grammar. Conditional body-capable host/non-URI-version overlaps fail boot with `CONDITIONAL_ROUTE_SHADOW`, because ownership cannot safely be decided before parsing. Bodyless and unrelated conditional routes remain supported.

Express 5 materializes its router before later application-setting changes. Read the documented `app.router` reference's effective `caseSensitive` and `strict` flags through a narrow, read-only, feature-checked compatibility seam; those fields are not documented public getters. Reject an unsupported shape instead of guessing. Do not traverse/mutate the router stack. Native regressions must cover partial-segment parameters and settings applied both before and after adapter construction. Final compatibility testing owns this explicit dependency boundary.

## Task 6: Implement Fastify integration and HTTP/2 parity

**Files:** Create `packages/nestjs-slightly-better-auth/src/fastify.ts`, `fastify-platform.ts`, `fastify.e2e.test.ts`, `fastify-http2.e2e.test.ts`.

**Interfaces:** Consumes the platform/exchange contracts from Tasks 3/4a; implement independently of Express once those ports are frozen. Produces `fastifyPlatform`, `FastifyPlatform`, structural options, mandatory live request accessor, reply lookup, `http2: true`, and `prepareAtInit: true` from v7 §§2.2.11 and 6.4.2.

**Verified platform limitation:** Fastify 5.12.4 does not expose `trustProxy` in its public `initialConfig`; the [Fastify server reference](https://fastify.dev/docs/latest/Reference/Server/#initialconfig) confirms the exposed fields. The frozen design's proposed read cannot determine that setting. Omit the optional `proxyTrust()` capability, so the existing boot summary reports `unknown` and setting-dependent diagnostics remain unavailable. Continue using native request IP resolution. Do not guess `none`, inspect private symbols, or add a second trust configuration that could disagree with the actual server.

- [x] Add this real Fastify regression to `fastify.e2e.test.ts`; import `FastifyAdapter`, `fastifyPlatform`, and the Task 4a test fixtures:

```ts
it("returns bounded-body failures through the host CORS layer", async () => {
  const fixture = await startHttpFixture({
    auth: createTestAuth(),
    adapter: new FastifyAdapter(),
    platform: fastifyPlatform(),
    controllers: [],
    moduleOptions: { http: { bodyLimit: 8 } },
    configure: (app) =>
      app.enableCors({ origin: "https://app.example", credentials: true }),
  });
  try {
    const response = await fetch(`${fixture.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: {
        origin: "https://app.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "too large" }),
    });
    expect(response.status).toBe(413);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
    expect(await response.json()).toEqual({
      code: "PAYLOAD_TOO_LARGE",
      message: "Request body exceeds the configured limit",
    });
  } finally {
    await fixture.close();
  }
});
```

Add another test where an `http.around` callback throws and an actual Nest global filter configured before `app.init()` records that error. The auth child mounts during `onModuleInit`, before Nest installs the root error handler later in the same initialization; resolve that handler at request time. Calling Nest `useGlobalFilters()` after completed initialization is not retroactive and is not a supported filter-registration contract here.

- [x] Run `mise exec -- pnpm exec vitest run --config vitest.e2e.config.mts packages/nestjs-slightly-better-auth/src/fastify.e2e.test.ts`; confirm failures. Implement root `onRequest` reply recording and an auth-only child plugin with buffer parser, unchanged application parsers, canonical limit error, and child error handler delegating to the current root error handler at request time.
- [x] Apply exact response merge logic through Fastify reply; do not bypass CORS by writing raw response headers prematurely. Implement request identity/liveness, raw request key, cookie sink and `responseFor` for Apollo on Fastify.
- [x] Add HTTP/2 tests using Node's HTTP/2 client for pseudo-header handling, authority fallback, cookies, HEAD, raw bytes and errors. Add a real second application created from the same compiled TestingModule after closing the first: both apps authenticate and bind hooks, with a fresh adapter and no stale reply map.
- [x] Run both Fastify E2E files plus shared helper/exchange tests and package typecheck. Compare Express/Fastify outputs for raw bytes, limits, cookies, CORS, method routing and filter behavior. Commit the scoped changes as `feat(auth): add isolated Fastify and HTTP2 support`.

## Task 7: Implement admin, organization, and API-key authorization

**Files:** Create `packages/nestjs-slightly-better-auth/src/admin.ts`, `organization.ts`, `api-key.ts`, `admin.test.ts`, `organization.test.ts`, `api-key.test.ts`, `authorization.e2e.test.ts`, `api-key-postgres.e2e.test.ts`. Integrator owns required PostgreSQL fixture/Compose configuration changes.

**Interfaces:** Implements public builders/policies/principal/ref types from v7 §2.2.15 and behavior in §8.3. Only these units know SDK plugin/kind names. Root imports none of these concrete units. `ApiKeyPrincipal` augments root `PrincipalKinds` only when the subpath is imported.

- [x] In `api-key.test.ts`, build a real memory-backed SDK auth with `apiKey()` and the library plugin, create a user and a key granting only `{ project: ['read'] }`, and resolve it through the real source/handle fixture. Assert this boundary before implementing it:

```ts
expect(result.outcome).toBe("authenticated");
if (result.outcome !== "authenticated") {
  throw new Error("expected a verified API-key principal");
}
expect(result.principal.delegation.allows({ project: ["read"] })).toBe(true);
expect(result.principal.delegation.allows({ user: ["ban"] })).toBe(false);
expect(JSON.stringify(result.principal)).not.toContain(createdKey.key);
```

The fixture obtains the registered `AuthHandle` through `getBetterAuthHandleToken()` from a real `BetterAuthModule` application context; its `PrincipalRequest` uses the created key header, `cookies: null`, authoritative/default freshness as the case requires, and a request-scoped memo. Use SDK `createApiKey` and signup APIs from the installed peer, not fabricated success results.

- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/api-key.test.ts`; confirm failure. Implement explicit acceptance, one verify call/request with host/forwarding context only, user/organization references and config IDs, SDK access primitive, and exact rate-limit/expiry/disabled/unknown-code mapping.
- [x] Add admin parity tests against real SDK `listUsers`/permission decisions: warm cookie cache revocation, synthetic API-key session rejected authoritatively, delegated owner ban/deletion, NULL/empty roles, adminUserIds, customSession role transformations and narrow scope. Implement headerless `userHasPermission`, authoritative identity and delegated owner+grant checks without copying SDK role logic.
- [x] Add org tests for malformed/empty refs denied before I/O, explicit organization ID, active member revalidation, customSession fallback, nonmember codes and missing roles, and separate A/B invocation values. Implement SDK hasPermission/getActiveMemberRole calls and input-keyed memo; expose required `ActiveOrganizationId`/`ActiveMemberRole` only after policy publication. Validate empty permission maps and plugin prerequisites at boot.
- [x] Implement API-key outage latency plus throttled shared read/no-op-write probe keyed by the logical `key` column, never an assumed ID type. Add PostgreSQL E2E for read-only writes and row lock timeout, with SDK default/UUID/serial IDs; assert no row changed by healthy probe and at most one probe/second/instance under concurrent invalid keys. Document fast row-specific/secondary-store residual limits accurately.
- [x] Run `mise exec -- pnpm exec vitest run packages/nestjs-slightly-better-auth/src/admin.test.ts packages/nestjs-slightly-better-auth/src/organization.test.ts packages/nestjs-slightly-better-auth/src/api-key.test.ts`; then `mise exec -- pnpm docker:up`, targeted authorization/storage E2E, and `mise exec -- pnpm docker:down` in cleanup even on failure. Commit the scoped changes as `feat(auth): enforce admin organization and API-key permissions`.

## Task 8: Implement Apollo and Mercurius across HTTP, sockets, and federation

**Files:** Create `packages/nestjs-slightly-better-auth/src/graphql.ts`, `graphql-transport.ts`, `graphql-lineage.ts`, `graphql-lineage.test.ts`, `graphql-http.e2e.test.ts`, `graphql-websocket.e2e.test.ts`, `graphql-federation.e2e.test.ts`.

**Interfaces:** Implements `apolloTransport`, `mercuriusTransport`, subscription helper and error classes from v7 §2.2.12. Both implement the §4.2 transport contract, particularly structural description/lazy extraction, claims and lineage. Only this subpath imports `@nestjs/graphql`/`graphql`.

**Verified framework prerequisites:** Nest GraphQL 14.0.1 enables exception filters for field and reference resolvers only when `fieldResolverEnhancers` includes `'filters'`. The frozen design assumed that guards/interceptors also entered Nest's exception pipeline. Require `['guards', 'filters']` for the documented nested-error logging guarantee; add `'interceptors'` for scoped service readers. Test one ERROR for repeated reader failures both with and without interceptors, and separately test that omitting filters still denies every field but produces no Nest ERROR. Emit `W_FIELD_EXCEPTION_FILTERS_DISABLED` with this prerequisite; preserve application-owned exception filters and do not add a second logger. The recorded correction does not change authentication decisions or silently satisfy an unconditional logging assertion.

Nest GraphQL 14.0.1's code-first federation factory also accesses an Apollo subgraph internal module removed in 2.15.1. Track the incompatible upstream pair in [#552](https://github.com/thilllon/nestjs-kit/issues/552); use actual schema-first Apollo/Mercurius federation for this task and ordinary code-first GraphQL separately. Task 12 must verify a supported code-first federation pair or document that limitation before release. Do not patch vendor internals or substitute a mock federation executor.

**Session-read measurement:** The organization permission SDK performs its own session handling. The one-storage-read fixture enables the SDK's signed session cookie cache while the guard performs the authoritative identity read. Count guard resolution and actual storage reads separately; do not imply that arbitrary SDK policy calls never read a session again.

- [ ] Add an actual driver fixture with a root `projects(orgId)` handler protected by `orgPermission(..., { organization: fromParam('orgId') })`, an inheriting reader field, real user/session, and membership only in A. Send this HTTP GraphQL operation through each driver and assert distinct outcomes:

```ts
const query =
  '{ a: projects(orgId: "A") { id } b: projects(orgId: "B") { id } }';
const response = await fetch(`${fixture.url}/graphql`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ query }),
});
const body = await response.json();
expect(body.data.a).not.toBeNull();
expect(
  body.errors.some((error: { path: string[] }) => error.path[0] === "b"),
).toBe(true);
expect(sessionReads).toBe(1);
```

Here `fixture`, `cookie`, and `sessionReads` are produced in the test by the real Nest driver app, signup response cookie, and a counting memory-adapter `findOne` wrapper. Define GraphQL fixture DTO/resolver classes in this E2E file; do not count a stubbed principal resolver as SDK session evidence.

- [ ] Run `mise exec -- pnpm exec vitest run --config vitest.e2e.config.mts packages/nestjs-slightly-better-auth/src/graphql-http.e2e.test.ts`; verify failure. Implement driver boot validation, positive live-platform HTTP recognition, cookie sink mapping, shared HTTP principal key and distinct field invocation identities.
- [ ] Implement operation/path lineage and nested planning. Test aliases, list indexes, batched operations, cross-instance ancestors, different source-set settlement orders, public nested fields and wrong-kind readers. Class access/requirements apply to operations/reference entry points, not inheriting field resolvers. Inherited form-forwarding plans enforce origin before inheriting without additional principal I/O, and absence of field guards fails B16. Missing guard coverage, static/stale context, and unguarded federation entry points fail as v7 specifies; warnings are schema-wide where readings cross instances.
- [ ] Add actual graphql-ws client tests for Apollo default and custom contexts and Mercurius subscriptions/fullWsTransport. Cover queries, mutations and subscriptions over sockets: operation-scoped keys, allow-listed credential replacement, untouched ambient browser leg, forwarding-host preservation for SDK dynamic URLs, origin enforcement on every socket operation, no refresh, TTL authoritative bypass. Mercurius runs GraphQL 16; do not install GraphQL 17 under its incompatible peer.
- [ ] Add actual Apollo and Mercurius federation subgraphs. `_entities` with two representations must yield separate policy decisions even when `info` is shared; absent guarded ancestor fails for inherited sensitive fields. Require appropriate field guards, test class-level org param mismatch advice, and count other global enhancer multiplication. Remove historical unverified status only when those drivers' runtime assertions pass.
- [ ] Verify HTTP 200 GraphQL error extensions 401/403/429, generic infrastructure/config messages, and exactly one ERROR log for 20 aliases/list items including reader-thrown wrong-kind errors. Public unknown context must run harmless work; its direct auth call and guarded neighbor must fail before side effects.
- [ ] Run the three GraphQL E2E files, lineage unit tests and package typecheck; commit the scoped changes as `feat(auth): support GraphQL operations subscriptions and federation`.

## Task 9: Implement socket.io and ws with connect-time authentication

**Files:** Create `packages/nestjs-slightly-better-auth/src/websockets.ts`, `socket-io-transport.ts`, `ws-transport.ts`, `ws-connection-auth.ts`, `websockets.test.ts`, `socket-io.e2e.test.ts`, `ws.e2e.test.ts`.

**Interfaces:** Implements v7 §2.2.13 and §9.3, including `WS_CONNECTION_AUTH`, `WsConnectionAuth`, `UPGRADE_REQUEST`, upgrade mixin/recording and close-code mapping. Uses the same AuthHandle origin/resolution scope as message transport; no separate authentication algorithm for connection middleware.

- [ ] Add a real ws fixture with `@UseBetterAuth()` gateway, public `ticker` method and protected `portfolio` method, deliberately without `withUpgradeRequest`. Assert the key regression:

```ts
expect(await sendMessage(client, "ticker", { symbol: "TEST" })).toEqual({
  event: "ticker",
  data: { symbol: "TEST" },
});
client.send(JSON.stringify({ event: "portfolio", data: {} }));
await expect(observedException).resolves.toMatchObject({
  message: "Internal server error",
});
expect(endpointSideEffects).toBe(0);
```

Define `sendMessage(client: WebSocket, event: string, data: unknown): Promise<unknown>` in `ws.e2e.test.ts`: install one message listener before sending JSON `{event,data}`, parse the reply, remove listeners on completion and reject on socket error/timeout. Install a real Nest ws exception filter that records the exception and delegates to the native base filter; `observedException` resolves from that filter. Do not assume raw ws serializes socket.io exception events: verify each adapter's actual native error behavior separately, with any explicit consumer filter documented. The protected fixture uses the real session parameter; a separate public fixture attempts `auth.api` and must fail before its probe side-effect counter increments. The error assertion targets the transport's client-safe exception mapping; native delivery must be verified with the supported adapter/filter configuration, not a fabricated wire payload.

- [ ] Run `mise exec -- pnpm exec vitest run --config vitest.e2e.config.mts packages/nestjs-slightly-better-auth/src/ws.e2e.test.ts`; verify intended failure. Implement lazy ws description and upgrade recording; add the wrapped-adapter success variant with real login cookie.
- [ ] Implement socket.io handshake headers/auth-token mapping and untouched browser exposure. Test junk mapped token with victim cookie, origin spoofing through forwarding headers, missing/null/trusted origin, concurrent messages with different policy params, and default TTL 0. Rejections/outages never persist in connection cache; authoritative routes bypass positive TTL on the next message after ban/revocation.
- [ ] Implement `WsConnectionAuth.authenticate` and socket.io middleware using same mapping/origin/suppression. Test actual rejected connection, required/optional behavior, named instances, stable exported token injection and close codes 4401/4403/4429. Guard coverage is explicit on every supported Nest major; guard alone is insufficient without scope.
- [ ] Run both socket E2E files, unit tests and typecheck; commit the scoped changes as `feat(auth): secure socket messages and connection authentication`.

## Task 10: Implement RPC and all six credential carrier families

**Files:** Create `packages/nestjs-slightly-better-auth/src/microservices.ts`, `rpc-transport.ts`, `rpc-carriers.ts`, `rpc-carriers.test.ts`, `rpc-tcp.e2e.test.ts`, `rpc-grpc.e2e.test.ts`, `rpc-brokers.e2e.test.ts`. Create `packages/nestjs-slightly-better-auth/fixtures/auth.proto`. Integrator owns Compose services/health checks and package dev dependencies.

**Interfaces:** Implements v7 §2.2.14 and §9.4: RPC transport plus grpc/nats/kafka/rmq/mqtt/payload carriers. `matches` is independent of auth success; no carrier still means an RPC context with absent credentials. Transport declares hostless calls and suppresses refresh.

- [ ] Write a real Nest TCP client/server fixture with required and public message patterns and real module/plugin. Assert the protected/public no-credential distinction:

```ts
await expect(
  firstValueFrom(client.send("private", { value: 1 })),
).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
await expect(
  firstValueFrom(client.send("public", { value: 1 })),
).resolves.toEqual({ value: 1 });
```

The server uses `NestFactory.createMicroservice` with TCP transport and closes both client/server in `finally`. The public handler is explicitly `@Public`; the protected one uses actual session resolution, not a mock carrier.

- [ ] Run `mise exec -- pnpm exec vitest run --config vitest.e2e.config.mts packages/nestjs-slightly-better-auth/src/rpc-tcp.e2e.test.ts`; verify failure. Implement ordered carriers, case-normalized allowlists, Buffer decoding and safe envelope extraction. Cookie/header absence must produce 401, never NO_TRANSPORT 500.
- [ ] Add hybrid boots with and without inheritAppConfig and explicit enhancer pairs; unguarded decorated message/event handlers fail boot. Run actual standalone `listen()` and `init()` then `listen()` to verify double lifecycle callbacks do not duplicate binding/hooks. Dynamic baseURL without fallback fails boot for the hostless transport.
- [ ] Implement actual gRPC proto/service/client tests for status 16/7/8 and infrastructure 13 with credential metadata; use optional newer Nest error exports only by capability detection, never to relax guard coverage.
- [ ] Add isolated Compose-backed NATS, Kafka, RabbitMQ, MQTT5 and Redis/TCP payload tests using the six public carrier factories; health-check services and clean them up in all paths. Assert allowed credential fields only, per-message identity, native payloads, no Set-Cookie/refresh, and credential-less behavior. Unit carrier shapes supplement these tests; they do not replace broker evidence.
- [ ] Run carrier unit tests, `mise exec -- pnpm docker:up`, the three RPC E2E files, `mise exec -- pnpm docker:down` in cleanup and package typecheck. Commit the scoped changes as `feat(auth): authenticate standalone and hybrid RPC transports`.

## Task 11: Ship consumer testing helpers and reusable conformance kits

**Files:** Create the Task 11 flat source files in the ownership table plus `testing.test.ts`, `testing.e2e.test.ts`, and `testing-conformance.test.ts` in `packages/nestjs-slightly-better-auth/src/`.

**Interfaces:** Implements v7 §2.2.16 and §14.1/§14.8. `ConformanceCase` has `id`, `title`, optional explicit `skip` reason, `run(): Promise<void>`; `ConformanceRunner` has `describe` and `it`. Kits return cases and use `node:assert/strict`, with no Vitest/Jest runtime import. Keep module/object helper tests in `testing.test.ts`; actual route invocation and listening-app tests belong in `testing.e2e.test.ts`.

- [ ] In `testing.e2e.test.ts`, add a real TestingModule fixture with one globally guarded route and one explicit `@UseBetterAuth()` route. Override the collaborator once and assert both call sites use it:

```ts
const calls: string[] = [];
const builder = Test.createTestingModule({ imports: [FixtureModule] });
overrideAuthGuard(builder, {
  canActivate(ctx) {
    calls.push(ctx.getHandler().name);
    stampPrincipal(ctx, null);
    return true;
  },
});
```

Boot the fixture through its real transport, call both routes, assert both names occur and the real SDK resolver call counter stays 0. `FixtureModule` is defined in the test with the real module and two controllers. Add the negative control showing `overrideProvider(BetterAuthGuard)` plus `overrideGuard(BetterAuthGuard)` cannot simultaneously override both Nest collections.

- [ ] Run `mise exec -- pnpm exec vitest run --config vitest.e2e.config.mts packages/nestjs-slightly-better-auth/src/testing.e2e.test.ts`; verify failure. Implement `overrideAuthGuard` through GUARD_CORE/SCOPE_CORE, plus fixed/function principals, decision overrides with real fallback, stamp isolation, and `initTestApp` closing prior bound test apps before initialization. Public test helper behavior must work for named instances and transport scopes.
- [ ] Implement the real probe plugin and all four conformance kits with the exact option/fixture contracts in v7 §14.1. Every built-in platform, transport, principal source and policy runs its applicable cases. Required capabilities such as HTTP2/lineage/federation cannot be skipped by omitting an invocation helper; report unsupported optional third-party capabilities explicitly.
- [ ] Add mutation tests supplying faulty implementations: platform merging Set-Cookie, transport sharing invocation across aliases, source throwing denial, policy widening delegation. The corresponding conformance case must fail for the intended reason and pass for the production implementation. Include all round-6 cases in v7 §14.5, including lazy scope/direct-call safety and safe-method origin evidence.
- [ ] Run default helper/conformance tests plus each platform/transport E2E kit and package typecheck. Inspect the `/testing` and `/testing/conformance` import graphs to ensure root users need neither testing peers nor test runners. Commit the scoped changes as `feat(auth): publish reusable authentication conformance kits`.

## Task 12: Verify the entire artifact, document usage, and complete the protected release path

**Files:** Modify `packages/nestjs-slightly-better-auth/package.json`, `src/index.ts`, `src/packaging.test.ts`, `README.md`, `AGENTS.md`, package config and current design status as evidence becomes true. Create `src/architecture.test.ts`, `src/consumer-types.test.ts`, and real consumer files under `packages/nestjs-slightly-better-auth/fixtures/`. Integrator may modify root `tsdown.config.mts`, `tsconfig.tools.json`, `docker-compose.yml`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`, and `.github/workflows/release.yml` only where the new verified package requires it.

Create working example workspaces at `examples/better-auth-express/`, `examples/better-auth-fastify/`, `examples/better-auth-graphql/`, `examples/better-auth-websockets/`, and `examples/better-auth-rpc/`, each with its own `package.json`, `src/auth.ts`, `src/app.module.ts`, `src/main.ts`, and README. Use the root toolchain and current APIs; no migration guide or published-availability claim before registry confirmation.

**Interfaces:** Final export keys are exactly `.`, `./plugin`, `./platform`, `./express`, `./fastify`, `./graphql`, `./websockets`, `./microservices`, `./admin`, `./organization`, `./api-key`, `./testing`, `./testing/conformance`, plus `./package.json`. Each runtime entry has `.mjs`, `.cjs`, `.d.mts`, `.d.cts`, correct condition order and external peers.

- [ ] Expand the actual packed-consumer test before filling missing artifact conditions. From an installed tarball in a temporary consumer directory, execute:

```ts
const imported = await import("nestjs-slightly-better-auth");
const required = createRequire(import.meta.url)("nestjs-slightly-better-auth");
assert.equal(imported.BetterAuthModule, required.BetterAuthModule);
assert.equal(
  imported.getBetterAuthServiceToken("admin"),
  required.getBetterAuthServiceToken("admin"),
);
```

Then boot a real Nest consumer using each format, inject default and named services, authenticate both instances, and close them. Run a separate Node process with `--no-experimental-require-module` and assert the `.cjs` path loads. A namespace-equality check alone is insufficient after runtime code exists.

- [ ] Keep `architecture.test.ts` limited to source/import boundaries and `consumer-types.test.ts` limited to source-based assertions so default tests work without `dist`. Packed declaration/consumer and emitted-chunk checks run from `packaging.test.ts` after build.
- [ ] Verify exact entry/export lists, archive contents/declarations/source maps/licenses, no stale public names, no default export, and no top-level await. Walk emitted chunks for plugin purity and optional-peer isolation. Load root and plugin in consumers lacking GraphQL/websocket/microservice/testing peers; install only the relevant optional peers to exercise each subpath. Never fix purity by bundling SDK/Nest peers.
- [ ] Complete type fixtures for registered/unregistered auth, named instances, customSession mapper requirement, admin/org permissions, unknown principal kinds, hook raw-body safety/DB update/delete types, static options outside async factories, and conditional API-key augmentation. Test supported Node 24 floor/current, proposed Nest 11/12, SDK 1.7.0/current, module-sync/CJS fallback and TypeScript resolution modes. Mercurius GraphQL 16 support and Apollo GraphQL compatibility have separate dependency installations; an unverified major is not advertised.
- [ ] Add the documented JWT extension/conformance fixture from v7 §4.3.4 using real `getJwks` and jose verification. Under dynamic baseURL without fallback, pass the current request URL/headers to `getJwks` and prove key lookup succeeds; with no configured baseURL, require explicit issuer/audience. Storage failure must remain infrastructure failure rather than invalid-token absence. This verifies BA-r7-01 without adding an undesigned built-in JWT source.
- [ ] Run the full integrated checks from repository root:

```bash
mise exec -- pnpm lint
mise exec -- pnpm format:check
mise exec -- pnpm typecheck
mise exec -- pnpm test
mise exec -- pnpm build
mise exec -- pnpm test:packaging
mise exec -- pnpm docker:up
mise exec -- pnpm test:e2e
mise exec -- pnpm docker:down
```

Arrange cleanup with the process runner's `finally` or a shell EXIT trap so `docker:down` runs after a failing E2E command too. Fix failures, then rerun the affected checks and integrated checks justified by changes; preserve actual successful run links rather than copying historical results.

- [ ] Document the complete API and working examples: plugin-last construction, default/named sync+async call shapes, body/cookie constraints, direct-call form-CSRF/rate-limit caveat, safe-method advisory protection only in cookie mode and always-enforced forwarding form mode, admin/API-key delegation, GraphQL lineage/federation and subscription lifetime, explicit gateway/hybrid coverage, TTL revocation tradeoff, origin/native client escapes, storage outage limitations and shutdown binding behavior. Package README header has exactly npm version, npm monthly downloads, CI badges in that order, with clear unreleased status until publication.
- [ ] Obtain independent implementation/security review, reconcile all open review conversations, inspect Code scanning, and file/fix actionable findings in linked issues/PRs. A final full-scope checklist must show each subpath's runtime, types and artifact evidence; do not close #534 for a subset.
- [ ] Confirm npm name availability/ownership and the intended first version with registry evidence. Only after implementation/review/release readiness is established change privacy/version via the approved Changesets path. New-package first publication must be owner-authenticated before trusted publisher setup. Coordinate the new package's publication gate so CI cannot attempt its first publish before trust is ready; preserve the established packages' enabled release workflow. Any temporary global pause must be explicit, brief and restored after the exact release commit is verified.
- [ ] Merge only the exact verified revision through a squash PR with required `Validate`, resolved conversations, up-to-date base and head/base/tree guards. Use `gh pr merge --body ''`. Do not weaken protection or synthesize success; if a dispatched run needs Checks API reporting, verify actual repository/workflow/commit/successful jobs and link that run.
- [ ] Publish only the workflow event commit. Never publish in the run that merges the version PR; dispatch a fresh release run after its protected merge, verify event SHA/preparation base/checkout, provenance and registry versions, then update README/status/issues using observed publication facts. The final response states any owner-authenticated first-publication gate that remains unmet.

## Completion audit

- [ ] All 13 substantive entries implement the reviewed v7 contracts; no stub, hidden unsupported path, or skipped promised driver/broker is counted as completion.
- [ ] Round-6 BA-r6-01–03, NEST-r6-01–04, SEC-r6-01–03 and round-7 BA-r7-01–02/SEC-r7-01 have linked regression evidence on the promised SDK/transport matrix.
- [ ] Default/named coexistence, real authentication, authorization, body/cookie handling, infrastructure failures, and shutdown pass in both real ESM and CJS consumers.
- [ ] SDK auth objects remain unchanged; plugin/optional dependency boundaries and internal-token privacy pass artifact inspection.
- [ ] Documentation, Changesets, issues, protected PRs, Code scanning, first-publication ownership and release provenance reflect actual state.

Execution is already authorized. Start the first implementation task only after the independent design-review gate passes; continue through the remaining authorized tasks without a redundant execution-choice prompt.
