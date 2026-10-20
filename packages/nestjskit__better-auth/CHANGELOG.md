# nestjs-slightly-better-auth

## 2.0.0

### Major Changes

- 9206294: The `isGlobal` registration option is now `global`.

## 1.12.1

### Patch Changes

- 34fef52: Expose only the upgrade URL's path, without its query string or fragment, as the request URL of an Apollo graphql-ws operation whose socket is not open when the operation starts. Principal sources receive that URL as `PrincipalRequest.request` and policies as the context's `request`, so a cached GraphQL context of a closed connection no longer hands them the closed connection's query-string credential, such as `?access_token=`. Operations of an open connection keep the full upgrade URL, the origin check still reads the connection's handshake, and Mercurius socket operations are unchanged.
- e752255: Run an Apollo graphql-ws operation anonymously when its graphql-ws socket is not open at the start of the operation. The transport classifies the socket once per operation; an operation whose socket is closed or closing then reads no connection parameter, `subscriptionCredentials`, upgrade-header or cookie credential of that connection, so required operations answer the unauthenticated denial, optional and public operations run without a principal, and nothing is logged at ERROR. A cached GraphQL context of a closed connection therefore authenticates nothing, and a client that closes its connection while graphql-ws prepares an operation no longer logs a configuration error. An operation whose socket closes after it started keeps its connection's credentials, and Mercurius socket operations are unchanged. `T-stale-context` now runs its cached-context row on connection-shaped legs, where a later caller must never receive the first caller's principal and nothing may be logged at ERROR, and `invokeConnection` resolves after the server has observed the connection's close.

## 1.12.0

### Minor Changes

- cacc5c7: Add conformance rows to `./testing/conformance`:

  - `createConformanceAuth(options, settings)` takes `ConformanceAuthSettings`, which sets Better Auth's `disableOriginCheck` and `disableCSRFCheck` explicitly. Both still default to `false`.
  - `T-csrf-http-unsafe` asserts that an unsafe cookie operation from an untrusted `Origin` stays denied under `disableOriginCheck: true` with `disableCSRFCheck: false`, and that boot warns `W_ORIGIN_CHECK`.
  - `T-coverage-claims` asserts the boot summary's `scope: global` and `scope: off — see W_NO_GLOBAL_SCOPE` lines through the new `createApp` `logSummary` option.
  - `T-internal-error-logged-once` asserts one ERROR entry per request and distinct error for reader configuration errors (`SESSION_REQUIRED`, `NO_INVOCATION_VALUE`, `NO_AUTH_RESULT`) and service `getSession()` reads under 20 GraphQL list items. These boots use the `'filters'` field resolver enhancer, a `graph.roots.items` list root and the `organizationReader` and `serviceSession` fields.
  - With `http`, the principal-source kit runs `S-cookie-forwarded` and `S-infra-throws` through a guarded HTTP route.

## 1.11.0

### Minor Changes

- afbb78a: `policyConformance` accepts `deliveries`, a list of `PolicyDelivery` adapters that route its transport-specific rows through real transports. For each delivery, the kit runs `Z-admin-rejects-api-key-session`, `Z-org-ref-types` with junk inputs in the transport's payload, the API-key session setup of `Z-apikey-quota-per-request` and, for connection deliveries with a principal TTL, `Z-admin-banned` on one connection. It also accepts `variant(overrides)`, which builds the instances the kit needs in another configuration on the storage under test. The default is `createConformanceAuth(overrides)`. `./testing/conformance` exports the `PolicyDelivery` and `PolicyDeliveryConnection` types.

## 1.10.0

### Minor Changes

- f1d7182: Add `createTrustingHttpAdapter` and `http2.createTrustingHttpAdapter` to the HTTP platform conformance kit options, so
  platforms that fix proxy trust at adapter construction, such as Fastify, run the trusted-hop rows of `H-ip-platform`,
  `H-url-trust-proxy` and `H-proxy-untrusted-warning`. The trusted-hop rows also run over HTTP/2, and the trusted-hop row
  of `H-proxy-untrusted-warning` runs on platforms without `proxyTrust()`.

## 1.9.2

### Patch Changes

- ac86111: Keep the package source type-valid in programs whose `Register` augmentation names an instance with plugin or required additional user fields, such as `admin()`, `organization()` and `apiKey()`. The database hook dispatchers take better-auth's own hook parameters, while hook methods keep `DatabaseHookData` with the registered instance's fields, partial update payloads, delete hooks that can only abort and nullable endpoint contexts. The API-key conformance kit's fixture permission no longer depends on the registered instance's admin statements.

## 1.9.1

### Patch Changes

- 385ab01: Fail closed on ambiguous authorization state. When two requirements of one handler publish different values for an invocation parameter, such as a default `orgMember()` and an `orgPermission()` for a route organization, `@ActiveOrganizationId()` and `@ActiveMemberRole()` throw the request-time configuration error `AMBIGUOUS_INVOCATION_VALUE` instead of returning whichever policy ran last, and values published inside a denied requirement branch are discarded. Empty `anyOf()` and `allOf()` requirement groups fail planning with `EMPTY_REQUIREMENT_GROUP` instead of allowing every caller. An application whose `init()` is still running when another application binds the same Better Auth instance now fails at bootstrap with `INSTANCE_ALREADY_BOUND` instead of serving without its hooks.
- a4f8f4b: Align app-surface origin checks with Better Auth's router and with in-band credentials. A function-valued `trustedOrigins` option is evaluated per request only, as the router does, so its no-request result no longer widens the origins that cookie-mode app routes, GraphQL mutations and WebSocket legs trust. A guarded safe cookie request with `Sec-Fetch-Site: same-origin` and neither `Origin` nor `Referer` (for example under `Referrer-Policy: no-referrer`) keeps a passing advisory verdict, so its caller-session `auth.api` calls succeed. A session cookie that graphql-ws connection parameters or a WebSocket `credentials` mapping supply no longer triggers the caller-session check. `createConformanceAuth()` also forces `advanced.disableCSRFCheck: false`.
- 9153010: Deliver infrastructure errors that a principal source or policy classifies itself, such as API-key outage-probe failures, with the request's cookie, authorization and declared credential values redacted from the cause, and keep the original cause reachable through `getRawCause()` when `errors.exposeRawCause` is set. The Express and Fastify cookie sinks and auth-route responses skip a `Set-Cookie` line identical to the latest line already set for the same cookie, so a call's cookies that both the bridge and a source forward arrive once. The WebSocket README example lists `bearer()` before `nestjs()`.

## 1.9.0

### Minor Changes

- dec40b6: The transport conformance kit adds `T-public-unclaimed-context`, `T-inherited-handler`, `T-metadata-canary`, `T-dynamic-base-url`, `T-stale-context`, `T-carrier`, `T-subscription-credentials`, `T-subscription-origin` and `T-subscription-origin-junk-connection-params`. It also adds the `@SkipOriginCheck()` and `disableCSRFCheck` rows of `T-csrf-http-unsafe`, direct caller-session rows to `T-csrf-safe-methods`, the inherited forwarding field to `T-csrf-login-proxy`, and the nested, session-reader and `forwardDirectCalls` boots to `T-stamp-per-plan`. `T-inherit-no-lookup` gains `W_FIELD_RESOLVER_INHERITS` and class-level acceptance boots, and `T-reference-resolver` gains the reference-omitted and class-level requirement boots. Harnesses can pass `invokeInherited`, `graphqlContexts` and `invokeConnection`'s `connectionParams` option, and `createApp` receives `forwardDirectCalls`, `fieldResolverCoverage` and `graphqlContext`. `TransportFixtures` adds `callerSession`, `publicCallerSession` and the `inherited` subclass decorators, and `GraphFixtures` adds `forwarding` and `classDecorators`.

  On Fastify, `@CurrentPrincipal()` and the other principal parameters now read the guard's result without the scope interceptor (`globalScope: false`), because the HTTP transport's invocation is the request object the handler receives. `I_CLASS_METADATA_OPERATIONS_ONLY` names the resolver class.

## 1.8.0

### Minor Changes

- 42b26a0: Complete the principal-source conformance kit with the unit-specific cases of design v7 §14.1: `S-apikey-results`, `S-apikey-outage`, `S-apikey-write-outage` and `S-apikey-org-key` for API-key sources, `S-short-circuit-session` and the cookie-bridge cases `S-bridge-third-party-signup` and `S-bridge-foreign-credentials` for session-backed sources, `S-jwt-claims` for sources of the `jwt` plugin, and `S-dynamic-base-url` and `S-log-redaction` for every source. `principalSourceConformance()` passes the case's instance to `credentials.valid(auth)` and `credentials.rateLimited(auth)`, and accepts `variant()`, `credentials.apiKey()`, `credentials.organizationKey()` and an `http` platform harness. A case that does not apply to the source is skipped with the reason.

## 1.7.0

### Minor Changes

- f669992: Complete the policy conformance kit. `policyConformance` adds `Z-policy-session-lost`, `Z-singleton`, `Z-class-policy-requires` and a warm-cookie-cache variant of `Z-infra-throws`. It also adds unit-specific rows that run when the requirement contains a built-in policy: `Z-admin-rejects-api-key`, `Z-admin-rejects-api-key-session`, `Z-admin-banned`, `Z-admin-custom-session-role`, `Z-admin-deleted-user`, `Z-admin-null-role`, `Z-admin-dynamic-base-url`, `Z-org-ref-types` and `Z-apikey-quota-per-request`. Cases that need route planning and principal resolution send in-process requests through the real guard, and the new `sources` option registers the sources of the requirement's other principal kinds, such as `apiKeyPrincipal()`. The transport kit's `org` fixture uses `orgPermission` with `fromParam('orgId')` on organizations that the kit seeds. The session unit's `W_API_KEY_SESSION_MULTIPLIER` advice lists the credential-presenting policies and follows the `session.apiKeySessions` wording.

## 1.6.0

### Minor Changes

- 728ecd3: Complete the HTTP platform conformance kit. `httpPlatformConformance()` adds `H-close-keeps-hooks` and `H-proxy-untrusted-warning`. It also adds the production-mode per-IP rate-limit and Better Auth `trustedProxies` variants of `H-ip-platform`, the dynamic `allowedHosts` variant of `H-mount-custom-path`, and HTTP/2 rows for platforms that declare `capabilities.http2`. The new optional `microservice` option supplies transport options for the `NestFactory.createMicroservice()` and `Test.createNestMicroservice()` rows of `H-no-adapter`. The probe's `/probe/ip` endpoint also reports the IP Better Auth resolves without its development and test localhost fallback, and `H-ip-platform` asserts that value.

## 1.5.2

### Patch Changes

- eaed90f: `@BeforeAuth()`, `@AfterAuth()`, `@BeforeDatabase()` and `@AfterDatabase()` accept every method whose signature fits the hook: a method may declare fewer parameters, such as a one-parameter database hook or a parameterless endpoint hook, and return a narrower result, such as a `boolean` inferred from a delete hook. `HookMethodDecorator` and `DbHookMethodDecorator` infer the decorated method type and constrain it to `(ctx: AuthHookContext<P>) => unknown` or `DatabaseHookMethod<E, Ph>`. Before-hook bodies stay unvalidated, update payloads stay partial, a delete hook still cannot return replacement data, and a database hook must still accept a missing endpoint context.
- c4a3fc4: The package loads Nest only through the `@nestjs/common` and `@nestjs/core` package roots, never through internal module paths such as `@nestjs/core/router/route-path-factory.js`. Boot validation composes application route paths from the public `ApplicationConfig` prefix, exclusion and versioning settings with the rules of Nest's router, and `WsConnectionAuth` builds its connection execution context from the public `ExecutionContext` interface. Route paths, shadowing warnings and connection authentication results are unchanged.
- 9441944: The Apollo transport recognizes a graphql-ws operation whose `connection_init` message has no payload. The upgrade request's credential headers authenticate it, and a connection without credentials is anonymous: guarded operations fail with `UNAUTHENTICATED` and public operations run, instead of every guarded operation failing with `INTERNAL_SERVER_ERROR` (`AUTH_MISCONFIGURED`).

## 1.5.1

### Patch Changes

- 0b4c59b: `transportConformance` reads each call's browser leg while its invocation runs, so transports that reject a completed request, such as the Apollo and Mercurius transports of `./graphql`, run every applicable case, including the GraphQL cases `T-inherit-no-lookup`, `T-stamp-per-plan` and `T-reference-resolver`.

## 1.5.0

### Minor Changes

- 60bec2f: `transportConformance` runs the WebSocket origin cases `T-ws-origin-untrusted`, `T-ws-origin-junk-token`, `T-ws-origin-dynamic-baseurl`, `T-ws-origin-forwarded-host` and `T-ws-origin-function-trusted-origins` for transports whose browser leg is a connection's handshake: a cookie handshake from an untrusted or missing `Origin` is denied on every message and at connection time, whatever token or forwarding headers it carries, and a function-valued `trustedOrigins` receives the handshake's absolute URL once per connection. Harnesses of such transports pass the new `invokeConnection` helper, and `authenticateConnection` when the app provides `WS_CONNECTION_AUTH`. The `T-csrf-*` cases apply to browser legs that follow each operation, and `T-selection` fails `expectBrowserLeg: false` for a transport that describes a browser leg.

## 1.4.0

### Minor Changes

- b71c65a: Add the `./graphql` entry with `apolloTransport()` for `@nestjs/apollo` and `mercuriusTransport()` for `@nestjs/mercurius`.

  Queries, mutations, subscriptions and federation reference resolvers use the same access decorators, principal parameters and authorization units as HTTP controllers. Each root field and alias receives its own authorization decision while one request shares a single session read, and nested field resolvers inherit the principal of their actual ancestor operation. Socket operations authenticate from the WebSocket upgrade request, with `connection_init` credentials selected by `connectionParamHeaders` or mapped by `subscriptionCredentials`; malformed credentials are rejected as `MALFORMED_CREDENTIALS` without echoing their values, and browser-origin checks always use the original upgrade headers. Apollo recognizes socket operations only through the graphql-ws connection and its WebSocket, and Mercurius keeps every operation that carries its route's Fastify reply on the HTTP path, so neither a client-sent `Upgrade: websocket` header nor client fields spread into a custom context can move an HTTP operation onto the socket path. `subscriptionPrincipalTtlMs` optionally reuses a connection's principal, and `mercuriusSubscriptionContext()` carries the upgrade request through Mercurius socket contexts. Apollo and Mercurius federation work with schema-first schemas and code-first federation versions 1 and 2.

  Denials become GraphQL errors with `code`, `statusCode` and `reason` extensions, and authentication infrastructure failures surface as a generic internal error. Startup validation reports mismatched drivers, static contexts and field or reference resolvers that Nest does not guard.

  The entry adds optional peer dependencies on `@nestjs/graphql` ^14.0.2 and `graphql` ^16.14.2; applications that do not import `./graphql` do not need them.

## 1.3.0

### Minor Changes

- e5e68ee: Add the `./testing` and `./testing/conformance` entry points. `./testing` provides `overrideAuthGuard`, `overridePrincipal`, `overrideDecisions`, `stampPrincipal`, `testPrincipal`, `authHeadersFor` and `initTestApp`: one override replaces the guard at the global and every `@UseBetterAuth()` call site, fixed principals keep real acceptance, origin checks and policies, and decision stubs fall back to the real policy. `./testing/conformance` provides runner-agnostic `httpPlatformConformance`, `transportConformance`, `principalSourceConformance` and `policyConformance` kits, `runConformance`, `conformanceProbePlugin` and `createConformanceAuth`, using `node:assert/strict` and no test runner. The kits decide which cases apply from the unit under test, fail required capabilities whose helper is missing, and report cases that do not apply as skipped. Both entries need the optional peer `@nestjs/testing`; the root entry does not load it.

## 1.2.0

### Minor Changes

- 7302594: Add the `./websockets` entry point for Socket.IO and raw `ws` gateways.

  Register `socketIoTransport()` or `wsTransport()` in the module's `transports` and decorate gateways with `@UseBetterAuth()`; startup reports message handlers without guard and scope coverage as `GATEWAY_UNGUARDED`. Message handlers use the existing access, session and authorization decorators. Socket.IO reads the handshake headers and maps a string `auth.token` to a bearer credential; raw `ws` reads the upgrade request recorded by `withUpgradeRequest(WsAdapter)`. A `credentials(client)` mapper can replace those credentials, while the browser-origin check keeps using the original handshake. Malformed credentials fail with a 401 `MALFORMED_CREDENTIALS` that does not quote the rejected value.

  `WsConnectionAuth` (also injectable as `WS_CONNECTION_AUTH`) authenticates connections through `socketIoMiddleware()` or `authenticate()`, and `wsCloseCodeFor()` maps failures to close codes 4401, 4403 and 4429. `principalTtlMs` (default 0) reuses a successful authentication on the same connection. The entry requires the optional peer `@nestjs/websockets` 12 and `@nestjs/platform-socket.io` or `@nestjs/platform-ws`.

## 1.1.0

### Minor Changes

- 1df26ab: Add the `./microservices` entry point for authenticating Nest microservice messages.

  `rpcTransport()` authenticates every message in standalone and hybrid microservices through the shared Better Auth kernel. Credential carriers read gRPC metadata, NATS and Kafka headers, RabbitMQ message headers and MQTT 5 user properties; TCP and Redis messages carry credentials in a payload envelope (`auth` by default). Carriers accept only `authorization`, `cookie` and `x-api-key` by default and never forward host or forwarding metadata. Message authentication requires a static base URL or a hostless fallback, never refreshes cookies, and rejects malformed credential values with `MALFORMED_CREDENTIALS` without logging them. Failures become `RpcException` payloads, and gRPC calls receive native status codes 16, 7, 8 and 13. Hybrid applications either assert `inheritAppConfig` or apply `@UseBetterAuth()`, and startup rejects uncovered message and event handlers with `RPC_HANDLER_UNGUARDED`.

  `@nestjs/microservices` 12 is a new optional peer dependency, required only when importing `./microservices`.

## 1.0.0

### Major Changes

- bcdd5b1: Release the first public version of the Better Auth integration for NestJS.

  The package ships the Nest authentication kernel, the Better Auth construction plugin with hook and cookie bridging, request scopes with caller-origin evidence, the Express and Fastify HTTP platforms, and the admin, organization and API-key authorization units. GraphQL, WebSocket and RPC transports and the conformance testing kit are not part of this release; they arrive in later minor versions through their own entry points.

## 0.0.1

### Patch Changes

- Reserve the package name and prove the release pipeline. The package exports nothing yet: the rewrite is still in design (see `docs/design`).
