# nestjs-slightly-better-auth

[![npm version](https://img.shields.io/npm/v/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![Monthly downloads](https://img.shields.io/npm/dm/nestjs-slightly-better-auth)](https://www.npmjs.com/package/nestjs-slightly-better-auth)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main&label=CI)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

A NestJS integration for [Better Auth](https://www.better-auth.com). A construction-time Better Auth plugin bridges hooks and cookies into Nest; the Nest module mounts Better Auth's routes on Express or Fastify, authenticates controllers, GraphQL operations, WebSocket messages and microservice messages through one guard, and evaluates admin, organization and API-key permissions through Better Auth's own endpoints.

- [Install](#install)
- [Entry points](#entry-points)
- [Construct the Better Auth instance](#construct-the-better-auth-instance)
- [Register the module](#register-the-module)
- [HTTP platforms](#http-platforms)
- [Access, principals and readers](#access-principals-and-readers)
- [Authorization](#authorization)
- [Hooks](#hooks)
- [Direct `auth.api` calls](#direct-authapi-calls)
- [Origin checks](#origin-checks)
- [Lifecycle and operational limits](#lifecycle-and-operational-limits)
- [GraphQL](#graphql), [WebSocket gateways](#websocket-gateways), [RPC authentication](#rpc-authentication)
- [Testing helpers](#testing-helpers-testing), [Conformance kits](#conformance-kits-testingconformance), [Examples](#examples)

## Install

```sh
pnpm add nestjs-slightly-better-auth better-auth
```

Peer dependencies: `@nestjs/common` and `@nestjs/core` 12, `better-auth` 1.7.5 or newer (below 2), `reflect-metadata` and `rxjs`. The package requires Node.js 24.11 or newer (`engines.node` is `>=24.11.0`). Install the Nest platform adapter your application uses, `@nestjs/platform-express` or `@nestjs/platform-fastify`; the `./express` and `./fastify` entries import neither at runtime.

The `./testing` and `./testing/conformance` entries also need the optional peer `@nestjs/testing` 12; the root entry never loads it or a test runner. API keys use Better Auth's `@better-auth/api-key` plugin, which the application installs and registers itself (`pnpm add @better-auth/api-key`); the `./api-key` entry never imports it.

The `./graphql` entry has two optional peer dependencies, `@nestjs/graphql` ^14.0.2 and `graphql` ^16.14.2, plus the Nest driver of your GraphQL server:

```sh
# Apollo on Express
pnpm add @nestjs/graphql graphql @nestjs/apollo @apollo/server @as-integrations/express5
# Mercurius on Fastify
pnpm add @nestjs/graphql graphql @nestjs/mercurius mercurius @nestjs/platform-fastify
```

The `./websockets` entry also needs the optional peer `@nestjs/websockets` 12 and the Nest adapter for your socket library:

```sh
pnpm add @nestjs/websockets @nestjs/platform-socket.io # Socket.IO
pnpm add @nestjs/websockets @nestjs/platform-ws # raw ws
```

The `./microservices` entry also needs the optional peer `@nestjs/microservices` 12 and the client library Nest uses for your transport, for example:

```sh
pnpm add @nestjs/microservices @nats-io/transport-node
```

Nest's gRPC transport uses `@grpc/grpc-js` and `@grpc/proto-loader`, Kafka uses `kafkajs`, RabbitMQ uses `amqplib` and `amqp-connection-manager`, MQTT uses `mqtt`, and Redis uses `ioredis`. TCP needs no client library. Applications that do not import `./microservices` do not need any of these packages.

## Entry points

Every entry ships ESM and CommonJS builds with declarations. The `module-sync` export condition gives Node `import` and `require()` consumers one shared ESM module identity, and optional peers load only through the entry that needs them. The [changelog](CHANGELOG.md) records the version that introduces each entry.

| Entry                   | Provides                                                                                                                                                                                                                                          | Extra peers                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `.`                     | `BetterAuthModule`, `BetterAuthService`, `BetterAuthGuard`, `BetterAuthScopeInterceptor`, access, principal and hook decorators, requirement composition, token helpers, errors, the session unit, `httpTransport()` and `betterAuthCorsOrigin()` | none                         |
| `./plugin`              | `nestjs()`, the Better Auth construction plugin                                                                                                                                                                                                   | none                         |
| `./platform`            | Node/Web helpers for third-party platforms and transports: `toWebHeaders()`, `readBoundedBody()`, `writeWebResponse()`, `appendSetCookie()`, `upgradeRequestUrl()` and related functions                                                          | none                         |
| `./express`             | `expressPlatform()`, `ExpressPlatform`                                                                                                                                                                                                            | none                         |
| `./fastify`             | `fastifyPlatform()`, `FastifyPlatform`                                                                                                                                                                                                            | none                         |
| `./graphql`             | `apolloTransport()`, `mercuriusTransport()`, `mercuriusSubscriptionContext()`                                                                                                                                                                     | `@nestjs/graphql`, `graphql` |
| `./websockets`          | `socketIoTransport()`, `wsTransport()`, `withUpgradeRequest()`, `WsConnectionAuth`, `WS_CONNECTION_AUTH`, `wsCloseCodeFor()`                                                                                                                      | `@nestjs/websockets`         |
| `./microservices`       | `rpcTransport()` and the credential carriers `grpcCarrier()`, `natsCarrier()`, `kafkaCarrier()`, `rmqCarrier()`, `mqttCarrier()`, `payloadCarrier()`                                                                                              | `@nestjs/microservices`      |
| `./admin`               | `permission()`, `RequirePermission()`                                                                                                                                                                                                             | none                         |
| `./organization`        | `orgPermission()`, `RequireOrgPermission()`, `orgMember()`, `RequireOrgMember()`, `activeOrganization()`, `fromParam()`, `fromHeader()`, `organizationRef()`, `ActiveOrganizationId()`, `ActiveMemberRole()`                                      | none                         |
| `./api-key`             | `apiKeyPrincipal()`, `apiKeyPermission()`, `RequireApiKeyPermission()`, `API_KEY_PRINCIPAL_KIND`                                                                                                                                                  | none                         |
| `./testing`             | `overrideAuthGuard()`, `overridePrincipal()`, `overrideDecisions()`, `stampPrincipal()`, `testPrincipal()`, `authHeadersFor()`, `initTestApp()`                                                                                                   | `@nestjs/testing`            |
| `./testing/conformance` | Runner-agnostic conformance kits for platforms, transports, principal sources and policies                                                                                                                                                        | `@nestjs/testing`            |

The [design workspace](docs/design/README.md) holds the reviewed [specification](docs/design/design-v7.md), its [review ledger](docs/design/ledger.md) and the [implementation plan](../../docs/superpowers/plans/2026-09-21-better-auth.md).

## Construct the Better Auth instance

Add `nestjs()` from `./plugin` to every `betterAuth()` call, as the last entry of `plugins`:

```ts
// auth.ts
import { apiKey } from "@better-auth/api-key";
import { betterAuth } from "better-auth";
import { admin, bearer, organization } from "better-auth/plugins";
import { nestjs } from "nestjs-slightly-better-auth/plugin";
import { Pool } from "pg";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: new Pool({ connectionString: process.env.DATABASE_URL }),
  emailAndPassword: { enabled: true },
  // nestjs() comes last, after every plugin with hooks.
  plugins: [admin(), organization(), apiKey(), bearer(), nestjs()],
});

declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: typeof auth;
  }
}
```

The example stores data in PostgreSQL through `pg` (`pnpm add pg`); any [Better Auth database](https://www.better-auth.com/docs/concepts/database) works. The plugin is pure construction-time configuration: it adds fixed hook entries and database-hook dispatchers when Better Auth builds its pipeline, and the Nest module binds its hook tables to them later. The module never wraps, clones or mutates the `auth` object. Startup fails with `PLUGIN_MISSING` when an instance has no `nestjs()`, and with `PLUGIN_SHARED_BETWEEN_INSTANCES` when two instances share one plugin object, so call `nestjs()` inside each `betterAuth()` call. When a plugin after `nestjs()` declares after-hooks, startup logs `W_PLUGIN_NOT_LAST`: those hooks would run after the plugin's cookie bridge and endpoint-result observer, which then miss their changes. Nest `@BeforeAuth()` and `@AfterAuth()` hooks run after the application's own `hooks` option and after the hooks of earlier plugins.

`nestjs({ clientIpHeader })` controls how Better Auth learns the client IP. By default the plugin adds a random header name per `nestjs()` call (`x-nsba-ip-<32 hex characters>`) to `advanced.ipAddress.ipAddressHeaders`, the platform sets it from its own trust-proxy-aware client IP, and the kernel deletes any client-sent copy, so a client cannot choose its rate-limit bucket or the IP recorded on its sessions. A string pins a fixed header name for a trusted sidecar that calls `auth.handler` itself; `false` contributes nothing, and Better Auth's own `advanced.ipAddress` settings apply.

The `Register` augmentation types `BetterAuthService`, `AuthSession`, `AuthUser`, `AuthPrincipal`, hook contexts and permission maps from `typeof auth`. Named instances go under `instances: { admin: typeof adminAuth }`. Without the augmentation, types fall back to Better Auth's default session shape and permission maps accept any resource. With it, the default instance's `forRoot()` rejects an `auth` of another type.

## Register the module

Register the default instance once, in the root module:

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { apiKeyPrincipal } from "nestjs-slightly-better-auth/api-key";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { auth } from "./auth";

@Module({
  imports: [
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      principals: [apiKeyPrincipal()],
    }),
  ],
})
export class AppModule {}
```

`forRoot()` returns a global module by default. It registers `BetterAuthGuard` as `APP_GUARD` and `BetterAuthScopeInterceptor` as `APP_INTERCEPTOR`, so every controller route requires a session unless it opts out. Undecorated handlers follow `defaultAccess` (`"authenticated"` by default; `"public"` makes the application opt-in).

### Static and runtime options

Options that decide which providers exist are static. Everything else is a runtime option, which `forRootAsync()` can compute from injected providers.

| Kind                                    | Options                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App-level static, default instance only | `platforms`, `transports`                                                                                                                                                                                                                                                                                                            |
| Instance static                         | `name`, `isGlobal` (default `true`), `globalGuard` (default `true` for the default instance, `false` for named ones), `globalScope` (default `true`, default instance only), `principals`                                                                                                                                            |
| Runtime                                 | `auth`, `defaultAccess`, `defaultRequirements`, `session`, `http` (`mount`, `bodyLimit`, `around`, `allowRootMount`, `allowRequestDerivedBaseURL`, `diagnostics`), `cookies.forwardDirectCalls`, `originCheck` (`mode`, `missingOrigin`), `errors` (`map`, `exposeRawCause`), `limits.maxAuthorizationCallsPerRequest`, `logSummary` |

`forRootAsync()` takes the static options next to `useFactory`; the factory returns runtime options only. Returning a static key from the factory is a compile-time error with a readable message, and a runtime error (`STATIC_OPTION_IN_FACTORY`) for untyped callers:

```ts
import { Injectable, Module } from "@nestjs/common";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { fastifyPlatform } from "nestjs-slightly-better-auth/fastify";
import { auth } from "./auth";

@Injectable()
export class AuthSettings {
  readonly bodyLimit = Number(process.env.AUTH_BODY_LIMIT ?? 1_048_576);
}

@Module({
  providers: [AuthSettings],
  exports: [AuthSettings],
})
export class AuthSettingsModule {}

@Module({
  imports: [
    BetterAuthModule.forRootAsync({
      platforms: [fastifyPlatform()],
      imports: [AuthSettingsModule],
      inject: [AuthSettings],
      useFactory: (settings: AuthSettings) => ({
        auth,
        http: { bodyLimit: settings.bodyLimit },
      }),
    }),
  ],
})
export class AppModule {}
```

The factory can also build the instance from injected providers, for example a database pool. Register its type through the factory's return type, `interface Register { auth: ReturnType<typeof createAuth> }`, and give the Better Auth CLI its own module-level instance.

### Default and named instances

An application has one default instance and any number of named instances. Each named instance has its own injection tokens, `nestjs()` binding, mount path, principal sources and runtime options; `platforms` and `transports` are app-wide and belong to the default instance only (`APP_EXTENSIONS_ON_NAMED_INSTANCE` otherwise). Named registrations require a default registration (`NO_DEFAULT_INSTANCE`). Two instances must not share a mount path (`OVERLAPPING_MOUNTS`) or cookie names on overlapping scopes (`COOKIE_NAME_COLLISION`), so give the second instance its own `basePath` and `advanced.cookiePrefix`:

```ts
import { Controller, Get, Inject, Module } from "@nestjs/common";
import { betterAuth } from "better-auth";
import {
  type AuthOf,
  type AuthUser,
  BetterAuthModule,
  BetterAuthService,
  CurrentUser,
  getBetterAuthServiceToken,
  UseAuthInstance,
} from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { nestjs } from "nestjs-slightly-better-auth/plugin";
import { auth } from "./auth";

export const adminAuth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  basePath: "/api/admin-auth",
  advanced: { cookiePrefix: "admin-auth" },
  emailAndPassword: { enabled: true },
  plugins: [nestjs()],
});

declare module "nestjs-slightly-better-auth" {
  interface Register {
    instances: { admin: typeof adminAuth };
  }
}

@UseAuthInstance("admin")
@Controller("admin")
export class AdminController {
  constructor(
    @Inject(getBetterAuthServiceToken("admin"))
    private readonly adminAuth: BetterAuthService<AuthOf<"admin">>,
  ) {}

  @Get("me")
  me(@CurrentUser() operator: AuthUser<"admin">) {
    return { id: operator.id };
  }

  @Get("session")
  async session() {
    const session = await this.adminAuth.getSession();
    return { expiresAt: session?.session.expiresAt };
  }
}

@Module({
  imports: [
    BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] }),
    BetterAuthModule.forRoot({ name: "admin", auth: adminAuth }),
  ],
  controllers: [AdminController],
})
export class AppModule {}
```

The one global guard evaluates each handler against the instance named by `@UseAuthInstance()` (method over class, default `"default"`). Named instances do not register a second global guard; at most one registration may set `globalGuard: true` (`DUPLICATE_GLOBAL_GUARD`). A named instance registers the same way through `forRootAsync({ name: "admin", useFactory })`.

### Injection tokens

Inject with Nest's `@Inject()` and the token helpers; the default instance also resolves by class (`BetterAuthService`). An empty alias or `"default"` returns the default token, and a named alias returns `<BASE_TOKEN>_<alias>`.

| Helper                               | Resolves to                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `getBetterAuthServiceToken(alias?)`  | `BetterAuthService` for the instance                                                                                 |
| `getBetterAuthInstanceToken(alias?)` | the exact object `betterAuth()` returned                                                                             |
| `getBetterAuthOptionsToken(alias?)`  | the instance's resolved runtime options                                                                              |
| `getBetterAuthHandleToken(alias?)`   | the instance's `AuthHandle`, which runs `auth.api` calls inside an explicit scope and checks origins, for extensions |

`BetterAuthService` exposes `instance`, `api` and `context()` (the awaited `$context`), `mount()` (base path, body limit and platform id, or `undefined` when unmounted), the readers described under [Access, principals and readers](#access-principals-and-readers), `headersFrom(request)` and the direct-call helpers described under [Direct `auth.api` calls](#direct-authapi-calls).

## HTTP platforms

Pass exactly one platform that supports the application's HTTP adapter (`NO_PLATFORM` or `AMBIGUOUS_PLATFORM` otherwise). Microservice-only and application-context bootstraps have no HTTP adapter and mount nothing.

```ts
// main.ts
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { betterAuthCorsOrigin } from "nestjs-slightly-better-auth";
import { AppModule } from "./app.module";
import { auth } from "./auth";

const app = await NestFactory.create(AppModule, new ExpressAdapter());
// Optional: follow Better Auth's exact trusted origins for credentialed CORS.
app.enableCors({ origin: betterAuthCorsOrigin(auth), credentials: true });
app.enableShutdownHooks();
await app.listen(3000);
```

For Fastify, pass `fastifyPlatform()` from `nestjs-slightly-better-auth/fastify` and create the application with `new FastifyAdapter()`. Both factories accept `{ clientIp }`, a function that returns the client IP from the native request; the default is Express `req.ip` or Fastify `request.ip`, which honor the adapter's proxy trust setting.

**Mount path.** Each instance's routes are mounted at the path Better Auth routes: the pathname of its resolved base URL, which is `baseURL` with `basePath` (default `/api/auth`) appended when `baseURL` has no path of its own, or `basePath` alone when the base URL is unset or dynamic. Auth routes live outside `setGlobalPrefix()` and `enableVersioning()`; put a prefix into `basePath` or `baseURL` instead. Everything below the base path goes to Better Auth, which answers unknown paths, methods and trailing slashes itself. A root mount (`/`) requires `http.allowRootMount`, and `http.mount: false` keeps an instance guard-only. `http.diagnostics` (on by default outside production) logs each auth path Better Auth answers 404 for once, with the closest endpoint path. A Nest controller route under an auth base path takes precedence and logs `W_ROUTE_SHADOWS_AUTH`.

**Bodies.** Auth routes receive exactly the bytes the client sent, bounded by `http.bodyLimit` (default 1 MiB; a number of bytes or a string such as `"2mb"`). A larger body receives `413 { code: "PAYLOAD_TOO_LARGE" }` on both platforms, with the host's CORS headers, and an unparsable request URL receives `400 { code: "INVALID_REQUEST_URL" }`. Application routes keep Nest's parsers, `rawBody`, `useBodyParser()` limits and Fastify's secure JSON parser. Express captures auth-route bodies before Nest registers its parsers; global middleware that reads the raw request stream without checking whether it already ended waits on a finished stream for auth routes. When an Express instance passed to `new ExpressAdapter(app)` already parsed the body, the platform recovers it from `req.rawBody` or re-serializes `req.body` and logs `W_BODY_ALREADY_CONSUMED` once, because raw-signature endpoints such as webhooks then receive different bytes. Fastify parses auth routes in its own encapsulated context and never reaches that path.

**Responses and cookies.** Responses are written verbatim, including redirects, streams and arbitrary content types. Every `Set-Cookie` line is appended to any cookies already set, `Vary` values are merged, and host headers such as CORS are kept. Nest interceptors, pipes and serializers never run on auth routes; exception filters receive only failures that reach the host error pipeline, such as `BetterAuthInfrastructureError` or an `APIError` rethrown under Better Auth's `onAPIError: { throw: true }`. `http.around` wraps every auth-route exchange for request contexts or tracing:

```ts
BetterAuthModule.forRoot({
  auth,
  platforms: [expressPlatform()],
  http: {
    around: [
      async (call, next) => {
        const started = Date.now();
        const response = await next();
        console.log(call.instance, call.request.url, Date.now() - started);
        return response;
      },
    ],
  },
});
```

**Base URL.** In production (any `NODE_ENV` other than `development`, `dev` or `test`, including an unset one), startup fails with `UNSAFE_BASE_URL` when Better Auth has no static base URL and no dynamic `baseURL.allowedHosts` configuration: Better Auth would otherwise derive token links and a trusted origin from each request's `Host` header. `http.allowRequestDerivedBaseURL: true` accepts that behavior explicitly. A production instance that signs with Better Auth's public default secret fails with `DEFAULT_SECRET`.

**Proxies and rate limits.** Configure proxy trust on the Nest adapter: Express `app.set("trust proxy", ...)` or Fastify `trustProxy`. The boot summary prints each platform's trust mode; Express reports it from its settings, and Fastify reports `unknown` because it exposes no public inspection API, which disables the diagnostics that depend on it. `W_PROXY_TRUST_ALL` warns when the platform trusts every proxy in production. Better Auth enables its rate limiter only when it saw `NODE_ENV=production` at import time; `W_RATE_LIMIT_DISABLED` reports a production deployment where the limiter resolved off, for example because `.env` set `NODE_ENV` after `auth.ts` was imported. Set `rateLimit.enabled` explicitly in that case.

**Express specifics.** The platform recognizes a request by Node object identity: an `http.IncomingMessage` or stream request whose `res` is the `http.ServerResponse` bound to it. Requests dispatched with light-my-request's `inject(app.getHttpAdapter().getInstance(), ...)` are supported. `inject()` re-parents Express's shared request and response prototypes for the whole process, and a listening Express server in the same process then fails inside light-my-request, so keep injected and listening tests in separate test files. Express preserves native controller parsing for unconditional routes that overlap the auth mount. Body-capable controller routes that also depend on host or non-URI version conditions are rejected at startup with `CONDITIONAL_ROUTE_SHADOW`; move them outside the auth mount. The integration checks the effective Express router flags, because changing application settings after router creation does not change existing route matching.

**HTTP/2.** Fastify adapters created with `http2: true` are supported: HTTP/2 pseudo-headers never reach Better Auth, and `host` is taken from `:authority` when absent. Nest's Express adapter has no HTTP/2 server.

**CORS.** The library configures no CORS. Host CORS middleware and `@fastify/cors` apply to auth routes, including preflight and the 413 response. `betterAuthCorsOrigin(auth, { allowPatterns })` returns an origin callback that accepts Better Auth's exact trusted `http(s)` origins, including plugin-contributed ones; wildcard and custom-scheme entries need `allowPatterns: true`, and a function-valued `trustedOrigins` throws at first use because a CORS callback has no request. Every origin the callback accepts gains credentialed read access to the routes it covers, so prefer to scope it to the auth mount and give application routes their own allow-list.

## Access, principals and readers

The guard compiles one plan per controller class and handler at startup and validates every plan before the application starts: contradictory decorators, unknown instances, unsatisfiable principal kinds and uncovered transport handlers fail boot with one aggregated `AUTH_BOOT_FAILED` error that lists every problem.

```ts
import { Controller, Delete, Get } from "@nestjs/common";
import {
  AcceptPrincipals,
  type AuthPrincipal,
  type AuthSession,
  type AuthUser,
  CurrentPrincipal,
  CurrentSession,
  CurrentUser,
  OptionalAuth,
  Public,
  RequireAuth,
} from "nestjs-slightly-better-auth";
import "nestjs-slightly-better-auth/api-key";

@Controller("projects")
export class ProjectsController {
  @Public()
  @Get("health")
  health() {
    return { ok: true };
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return { owner: user.id };
  }

  @OptionalAuth()
  @Get("feed")
  feed(@CurrentSession() session: AuthSession | null) {
    return { signedIn: session !== null };
  }

  @AcceptPrincipals("session", "api-key")
  @Get("export")
  export(@CurrentPrincipal() principal: AuthPrincipal) {
    return { kind: principal.kind, userId: principal.userId };
  }

  @RequireAuth({ authoritative: true })
  @Delete(":id")
  remove() {
    return { removed: true };
  }
}
```

| Decorator                                     | Effect                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@Public()`                                   | No principal I/O. A presented credential is not inspected, and principal readers return `null`. Principal parameter decorators on the same handler fail boot.                                                                           |
| `@OptionalAuth()`                             | Resolves a principal when credentials are present; a missing credential is anonymous, an invalid one is still denied.                                                                                                                   |
| `@RequireAuth({ authoritative })`             | Requires a principal (the default access). `authoritative: true` bypasses Better Auth's cookie cache for that route, so a revoked session fails on the next request.                                                                    |
| `@AcceptPrincipals(...kinds)`                 | Principal kinds the route admits, in addition to the kinds its requirements name. Without it, a route admits the kinds of sources with default acceptance: sessions only. A source whose kinds a route does not admit is not consulted. |
| `@UseAuthInstance(name)`                      | Evaluates the handler against a named instance.                                                                                                                                                                                         |
| `@UseBetterAuth()`                            | Applies the guard and the scope interceptor locally, for applications with `globalGuard: false` and for gateways.                                                                                                                       |
| `@Require(...)`, `@SkipDefaultRequirements()` | Authorization requirements; see [Authorization](#authorization).                                                                                                                                                                        |
| `@ForwardAuthCookies()`, `@SkipOriginCheck()` | Direct-call cookie forwarding and origin-check opt-out; see [Direct `auth.api` calls](#direct-authapi-calls) and [Origin checks](#origin-checks).                                                                                       |

The method level wins over the class level; `@Public()` or `@OptionalAuth()` on a method is a visible opt-out of class-level requirements. The boot summary counts public, optional and inheriting handlers and handlers that skip default requirements.

Failures answer `401 UNAUTHENTICATED`, `403 FORBIDDEN` or `429 RATE_LIMITED` with a `reason` such as Better Auth's error code. On HTTP the body is `{ statusCode, error, code, reason?, message }`, with `WWW-Authenticate` and `Retry-After` headers where applicable; `errors.map(failure, context, transport)` replaces the thrown object per instance. Infrastructure failures (storage, network, Better Auth 5xx) throw `BetterAuthInfrastructureError` (message `Authentication service unavailable`, redacted cause) and are never reported as 401 or 403. Request-time configuration errors throw `BetterAuthConfigurationError` with the fixed message `Authentication is misconfigured`; its `code`, `detail` and `hint` are logged, not sent. Nest's exception layer answers both with a 500.

### Readers

`@CurrentSession()` returns the Better Auth session, `@CurrentUser()` its user, and `@CurrentPrincipal()` the principal of any kind (`AuthPrincipal`, narrowed by `kind`). All three return `null` on an optional route without a principal. `@CurrentSession()` and `@CurrentUser()` accept only session principals: a route that could admit another kind fails boot with `PRINCIPAL_PARAM_CONFLICT`. `definePrincipalParam({ kind, reason, project })` builds kind-constrained parameter decorators of the same shape, and `defineInvocationParam(slot, { missing })` exposes a value a policy published for the current invocation.

`BetterAuthService.getSession()` and `getPrincipal()` return what the guard recorded for the current handler; they never start a resolution and cost no I/O. They return `null` in public handlers. `getSession()` throws `SESSION_REQUIRED` for an authenticated principal of another kind; use `getPrincipal()` and narrow `kind` on mixed-kind routes. Outside a handler scope (middleware, other guards, background jobs) they throw `NO_AUTH_SCOPE`, and in a handler the guard never ran for they throw `NO_AUTH_RESULT`.

Guards and interceptors read the principal with `principalFor(context)`. It is synchronous and returns a `PrincipalReading`: `{ outcome: "no-identity" }` on public plans, otherwise the recorded `authenticated`, `absent` or `rejected` result, each tagged with its instance:

```ts
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
} from "@nestjs/common";
import {
  BetterAuthService,
  getBetterAuthServiceToken,
} from "nestjs-slightly-better-auth";

@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  constructor(
    @Inject(getBetterAuthServiceToken())
    private readonly auth: BetterAuthService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const reading = this.auth.principalFor(context);
    if (reading.outcome === "no-identity") {
      return true;
    }
    return (
      reading.outcome === "authenticated" &&
      reading.principal.kind === "session" &&
      reading.principal.session.user.emailVerified
    );
  }
}
```

A guard that reads the principal must run after `BetterAuthGuard`, or `principalFor()` throws `PRINCIPAL_READ_BEFORE_GUARD`. Nest runs an `APP_GUARD` declared in `AppModule` before the global guard that `BetterAuthModule.forRoot()` contributes, so register such a guard with `@UseGuards()`, in a module imported after `BetterAuthModule`, or after your own `{ provide: APP_GUARD, useExisting: BetterAuthGuard }` with `globalGuard: false`. The boot summary prints the global guards in the order Nest runs them.

## Authorization

Requirements are values that carry a policy. `@Require(...requirements)` appends them to the class or method; stacked decorators and base-class requirements accumulate instead of overwriting each other. Every required plan evaluates the instance's `defaultRequirements` first, then class requirements (base class first), then method requirements, and stops at the first denial. `anyOf()` allows when any child allows and `allOf()` groups requirements inside `anyOf()`.

```ts
import { Controller, Get, Post } from "@nestjs/common";
import {
  anyOf,
  Require,
  RequireFreshSession,
} from "nestjs-slightly-better-auth";
import {
  permission,
  RequirePermission,
} from "nestjs-slightly-better-auth/admin";
import {
  ActiveOrganizationId,
  fromParam,
  orgPermission,
  RequireOrgMember,
} from "nestjs-slightly-better-auth/organization";

@RequireFreshSession()
@Controller("members")
export class MembersController {
  @RequirePermission({ user: ["list"] })
  @Get()
  list() {
    return [];
  }

  @Require(
    anyOf(
      permission({ user: ["ban"] }),
      orgPermission(
        { member: ["delete"] },
        { organization: fromParam("orgId") },
      ),
    ),
  )
  @Post(":orgId/remove")
  remove() {
    return { removed: true };
  }

  @RequireOrgMember()
  @Get("active")
  active(@ActiveOrganizationId() organizationId: string) {
    return { organizationId };
  }
}
```

| Requirement (entry)                                                                | Delegates to                                                                                                                                                                          | Principals                        | Denials                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `freshSession({ maxAgeSeconds })`, `@RequireFreshSession()` (`.`)                  | the session's `createdAt` against `maxAgeSeconds` or Better Auth's `session.freshAge`                                                                                                 | `session`                         | 403 `SESSION_NOT_FRESH`                                                                                                                                          |
| `permission(p, { principals })`, `@RequirePermission()` (`./admin`)                | `auth.api.userHasPermission` with the user id and no headers, so Better Auth reads the stored user's role, `defaultRole` and `adminUserIds`; the route reads identity authoritatively | `session`; opt in to more kinds   | 403 `MISSING_PERMISSION`; delegated principals: 401 `USER_BANNED` or `USER_NOT_FOUND`, 403 `INSUFFICIENT_SCOPE`, 403 `USER_REQUIRED` for organization-owned keys |
| `orgPermission(p, { organization })`, `@RequireOrgPermission()` (`./organization`) | `auth.api.hasPermission` with the request's headers and an explicit organization id                                                                                                   | `session`                         | 403 with the organization reference's missing reason, Better Auth's membership code or `MISSING_PERMISSION`                                                      |
| `orgMember({ organization })`, `@RequireOrgMember()` (`./organization`)            | `auth.api.getActiveMemberRole` for the organization id                                                                                                                                | `session`                         | 403 with the missing reason or `YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION`                                                                                       |
| `apiKeyPermission(p)`, `@RequireApiKeyPermission()` (`./api-key`)                  | the verified key's own permissions through Better Auth's access-control `role().authorize()`                                                                                          | `api-key` (admits keys by itself) | 403 `MISSING_PERMISSION`                                                                                                                                         |

Permission maps are typed from the registered instance's access-control statements, so unknown resources and actions are compile errors, and each requirement's plugin (`admin`, `organization`, `api-key`) is checked at startup (`PLUGIN_PREREQUISITE`). Empty permission maps fail boot. Named instances pass the instance name as a type argument, for example `permission<"admin">({ ... })`. The admin policy calls Better Auth without request headers, so an instance with a dynamic `baseURL.allowedHosts` configuration needs a `fallback` (`DYNAMIC_BASE_URL_WITHOUT_FALLBACK`).

**Organization references.** The organization policies always send an explicit organization id. `activeOrganization()` (the default) reads `session.activeOrganizationId`; with Better Auth's `custom-session` plugin and a session shape without it, it asks `getActiveMember`. `fromParam(name)` reads a route parameter, GraphQL argument or WebSocket/RPC payload field, `fromHeader(name)` reads a header, and `organizationRef(fn, { missingReason })` wraps any function. Only a non-empty string counts as an organization id; anything else denies with the reference's `missingReason` (`NO_ACTIVE_ORGANIZATION` for the active organization, `ORGANIZATION_REQUIRED` otherwise) without calling Better Auth. Slugs are not ids: map a slug to an id in your own `organizationRef()`, for example through `auth.api.listOrganizations({ headers })`. Startup warns with `W_ORG_PARAM_IGNORED` when a handler takes an `orgId`-like input while its requirement checks the active organization, and with `W_ORG_PARAM_MISSING` when `fromParam()` names an input the handler does not have. `@ActiveOrganizationId()` and `@ActiveMemberRole()` return the organization id and member role the policy resolved for the current invocation.

**API keys and delegation.** `apiKeyPrincipal({ header, configId, references, outageProbe, acceptance })` is a principal source for Better Auth's API-key plugin. It reads `x-api-key` by default, calls `verifyApiKey` once per request and only on routes that admit `"api-key"`, and never exposes the raw key. Its acceptance is explicit: a route admits keys through `@AcceptPrincipals("session", "api-key")` or a requirement that names the kind, such as `@RequireApiKeyPermission()`. Each verification counts against the key's usage and rate limit; `RATE_LIMITED` answers 429 with `Retry-After`, `USAGE_EXCEEDED` answers 429, and `KEY_NOT_FOUND`, `KEY_DISABLED`, `KEY_EXPIRED` and `INVALID_API_KEY` answer 401. Keys that belong to an organization need `references: "organization"` (or a function of the key's `configId`), because the plugin object does not expose its configuration.

An API-key principal is delegated: it acts with a narrower grant than its owner. A policy that does not name the principal's kind never judges it; the requirement denies `403 PRINCIPAL_NOT_SUPPORTED`, so a user-level policy never extends a key to its owner's full rights. `permission(p, { principals: ["session", "api-key"] })` opts keys into an admin check: the policy reads the owner's stored user row on every request, denies an owner under an active ban (`banUser` revokes sessions but not API keys), evaluates the owner's stored role, and additionally requires the key's own permissions. The organization policies never accept API keys, because Better Auth's organization endpoints need a session.

With `apiKey({ enableSessionForAPIKeys: true })`, Better Auth itself turns a key into a user session on every endpoint that sees the header. Such keys authenticate ordinary routes as `session` principals with the owner's full rights and spend their quota on every Better Auth call that carries them, including each organization check; authoritative routes and the admin policy reject them. When the API-key plugin is present, the session unit's boot advice (`W_API_KEY_FULL_SESSION`, and `W_API_KEY_SESSION_MULTIPLIER` listing the policies that present the request's credentials) describes this, worded conditionally by default. `session: { apiKeySessions: true }` states that a configuration enables the option and words the advice as fact; `session: { apiKeySessions: false }` states that none does and drops the advice. Prefer `apiKeyPrincipal()` with `@RequireApiKeyPermission()` for key traffic.

**Default requirements.** `defaultRequirements: [orgMember()]` adds a company-wide rule to every required plan of the instance. `@SkipDefaultRequirements()` opts one handler or controller out of the defaults while keeping its own requirements; startup fails with `UNSATISFIABLE_PRINCIPAL_KINDS` when the AND-ed requirements of a plan admit no common principal kind.

**Custom policies.** `definePolicy({ id, requires, evaluate, validate })` returns a requirement builder. Policies return `allow()` or `deny({ reason, status })` and throw only for infrastructure faults. `context.memo(key, compute)` deduplicates Better Auth calls per logical request; `limits.maxAuthorizationCallsPerRequest` (default 100, `false` disables it) bounds the distinct memoized calls of one request, past which a requirement answers `429 TOO_MANY_AUTHORIZATION_CHECKS` without calling Better Auth. For DI-backed policies use `requirement(PolicyClass, params)`. A policy call that meets Better Auth's generic 401 for a session principal re-reads the session once: a session that still resolves turns the failure into a 5xx, a session that ended into 401; a 401 with another code becomes a 403 denial.

Decisions are made per invocation: each GraphQL field, alias and WebSocket message gets its own decision, while Better Auth I/O is shared per logical request.

## Hooks

Hook providers are ordinary singleton providers; any provider in the application can declare hooks, without a class marker. Hooks bind to the default instance unless `instance` names another one.

```ts
import { Injectable } from "@nestjs/common";
import { APIError } from "better-auth/api";
import {
  AfterAuth,
  AfterDatabase,
  type AuthAfterHookContext,
  type AuthHookContext,
  BeforeAuth,
  BeforeDatabase,
  type DatabaseHookData,
} from "nestjs-slightly-better-auth";

@Injectable()
export class AccountHooks {
  @BeforeAuth("/sign-up/email")
  checkDomain(ctx: AuthHookContext<"/sign-up/email">) {
    const email = ctx.body.email;
    if (typeof email !== "string" || !email.endsWith("@example.com")) {
      throw new APIError("FORBIDDEN", { message: "Unsupported domain" });
    }
  }

  @AfterAuth(["/sign-in/email", "/sign-in/social", "/callback/:id"], {
    calls: "http",
    skipInternal: true,
  })
  signedIn(
    ctx: AuthAfterHookContext<
      "/sign-in/email" | "/sign-in/social" | "/callback/:id"
    >,
  ) {
    console.log("sign-in", ctx.context.newSession?.user.id);
  }

  @BeforeDatabase("user.create")
  normalize(user: DatabaseHookData<"user.create">) {
    return { data: { name: user.name.trim() } };
  }

  @BeforeDatabase("user.delete")
  protectOwner(user: DatabaseHookData<"user.delete">) {
    return user.email !== "owner@example.com";
  }

  @AfterDatabase("session.create")
  audit(session: DatabaseHookData<"session.create", "after">) {
    console.log("session", session.userId);
  }
}
```

| Decorator                           | Signature                                                                                                          | Return value                                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@BeforeAuth(match?, options?)`     | `(ctx: AuthHookContext<P>) => unknown`                                                                             | `undefined` continues; `{ context }` merges into the endpoint input; any other object short-circuits and becomes the response; a thrown `APIError` rejects |
| `@AfterAuth(match?, options?)`      | `(ctx: AuthAfterHookContext<P>) => unknown`                                                                        | `undefined` keeps the result; another value replaces `ctx.context.returned`; a thrown `APIError` replaces the response and later hooks still run           |
| `@BeforeDatabase(target, options?)` | `(data: DatabaseHookData<E>, ctx: GenericEndpointContext \| null \| undefined) => DatabaseHookResult<E, "before">` | `create` and `update`: `void`, `false` (abort) or `{ data }` (merged); `delete`: `void` or `false` only                                                    |
| `@AfterDatabase(target, options?)`  | `(data: DatabaseHookData<E, "after">, ctx: GenericEndpointContext \| null \| undefined) => void`                   | ignored; runs after the write commits                                                                                                                      |

A decorated method may declare fewer parameters than the signature and may return a narrower result. `match` is an endpoint route pattern such as `"/callback/:id"` (not the concrete URL), an array of patterns or a predicate `(ctx) => boolean`; without it, the hook runs for every endpoint. Patterns autocomplete from the registered instance and are validated at startup with a "did you mean" (`UNKNOWN_HOOK_PATH`). Database targets are `user`, `session`, `account` and `verification` with `create`, `update` or `delete`.

Hook methods receive Better Auth's own context objects. Before-hook bodies are typed `unknown` per field, because Better Auth validates the body only after before-hooks ran. Update payloads are partial, and every `update` hook sees the original payload while `create` hooks see the data earlier hooks returned. A database hook receives `null` or `undefined` as its context outside an endpoint. As in Better Auth, `ctx.setCookie()` and `ctx.setHeader()` in a before-hook have no effect when the endpoint runs; set response cookies and headers in `@AfterAuth()`.

`HookOptions` are `calls` (`"all"` by default, `"http"` for requests routed through the mount, `"server"` for direct `auth.api` calls), `skipInternal` (default `false`: hooks also run for the library's own calls, such as the guard's `getSession`; set it for audit hooks), `order` (ascending, default `0`) and `instance`. Database hooks take `order` and `instance`.

Security rules belong where every path passes. A `@BeforeAuth("/get-session")` rule sees the original request and fails open for bearer and API-key callers, and an `@AfterAuth("/get-session")` rule applies to Nest routes and direct `getSession` calls only, because Better Auth's own endpoints read the session without dispatching hooks. Rules that must hold everywhere change state Better Auth consults on every path: Better Auth's admin ban, session revocation, or a `@BeforeDatabase("session.create")` hook.

## Direct `auth.api` calls

A direct `auth.api.*` call in a handler behaves as in plain Better Auth: its `Set-Cookie` does not reach the caller's response. `service.headersFrom(request)` returns the platform request's headers with the client-IP header set and HTTP/2 pseudo-headers removed, for direct calls on the caller's behalf.

**Forwarding cookies.** `@ForwardAuthCookies()` on a handler or controller (and `@ForwardAuthCookies(false)` to opt one handler back out), or `cookies.forwardDirectCalls: true` for a whole instance (`W_FORWARD_DIRECT_CALLS`), forwards the `Set-Cookie` of direct calls that carry no credential, such as a sign-in, or the caller's own credential (session cookie, `Authorization` and the principal sources' credential headers). Calls with another credential have their cookies dropped. `service.forwardForeignCookies(fn)` forwards every call inside `fn`, for deliberate account switching, and throws `FORWARDING_NOT_DECLARED` in a handler without forwarding. Cookies from the library's own calls (principal sources and policies) always reach the caller, so session refreshes during authorization are delivered. A handler that already sent its response through `@Res()` drops them.

A forwarding handler is in form mode: the guard enforces Better Auth's form-CSRF rule before the handler runs, on every HTTP method and GraphQL operation kind, with or without an inbound cookie, and for public and optional handlers too. A forwarding handler therefore needs a guard that reaches it, even when it is public; startup reports forwarding handlers that no guard covers.

```ts
import { Body, Controller, Inject, Post, Req } from "@nestjs/common";
import {
  BetterAuthService,
  ForwardAuthCookies,
  getBetterAuthServiceToken,
  OptionalAuth,
} from "nestjs-slightly-better-auth";

@Controller("session")
export class SessionController {
  constructor(
    @Inject(getBetterAuthServiceToken())
    private readonly auth: BetterAuthService,
  ) {}

  @OptionalAuth()
  @ForwardAuthCookies()
  @Post("sign-in")
  signIn(
    @Req() request: unknown,
    @Body() body: { email: string; password: string },
  ) {
    return this.auth.api.signInEmail({
      body,
      headers: this.auth.headersFrom(request),
    });
  }
}
```

**Rate limits and origin checks on direct calls.** Better Auth applies its rate limiter and its own origin check only to requests routed through `auth.handler`. A direct `signInEmail`, `signUpEmail` or password call from a handler bypasses both. Prefer letting clients call Better Auth's routes through the mount for sign-in, sign-up and password flows, keep direct credential calls for trusted back-office code, and throttle proxy handlers in the application. The form-mode origin rule above protects forwarding handlers against login CSRF; it does not replace the rate limiter.

**Caller-session check.** A direct call that carries the caller's own session cookie on a browser leg must have a passing origin verdict for that leg and instance. Otherwise the call fails before the endpoint runs with `PUBLIC_HANDLER_USED_CALLER_SESSION` (a generic 500 with a logged hint). This covers public handlers, which run no origin check, safe methods such as a `GET /logout` proxy, and handlers the guard never ran for. Calls without the caller's session cookie (a sign-up without headers, bearer or API-key calls), cookie-less transports and `@SkipOriginCheck()` handlers are unaffected. A cross-site state-changing proxy therefore needs a state-changing method, `@OptionalAuth()` or a stricter access mode, `@ForwardAuthCookies()` when it returns auth cookies, and a trusted `Origin`.

**Scopes.** The global scope interceptor opens a scope for every handler a transport recognizes, independently of `globalGuard`. The scope carries the cookie bridge, refresh suppression on cookie-less transports and the caller-session check. `globalScope: false` removes it and logs `W_NO_GLOBAL_SCOPE`. Code outside a handler scope (middleware, guards, policies, background jobs, GraphQL field resolvers without the `"interceptors"` enhancer) gets plain Better Auth semantics. `service.withoutCookies(fn)` runs calls with no cookie capability, which also suppresses session refresh, and `service.runOutsideScope(fn)` runs `fn` as if no scope existed: no forwarding, no refresh suppression and no caller-session check, so an unsafe public handler that uses it is open to cross-site requests.

## Origin checks

Better Auth's origin check protects cookie-carrying requests on its own routes only. The guard applies the same rule to application routes, GraphQL operations and WebSocket messages through `originCheck`.

- **Cookie mode** (`originCheck.mode: "cookie"`, the default). An unsafe operation whose browser leg carries a cookie must come from a trusted origin, whatever credential authenticated it: HTTP methods other than GET, HEAD and OPTIONS, GraphQL mutations over HTTP, every WebSocket message and every GraphQL operation over a WebSocket. Denials are `403` with reason `INVALID_ORIGIN` or `MISSING_OR_NULL_ORIGIN`.
- **Advisory verdict on safe methods.** In cookie mode, a guarded safe request that carries a cookie also computes the origin verdict, without denying the request. An untrusted origin still reads its data; only a later direct call with the caller's session cookie consults the verdict and fails. Public handlers compute no verdict.
- **Form mode** (forwarding handlers). Always enforced, on every method and operation kind, following Better Auth's form-CSRF rule: with a cookie, the cookie-mode rule; without one, a cross-site navigation is denied with `CROSS_SITE_NAVIGATION_LOGIN_BLOCKED`, a present `Origin` or `Referer` must be trusted, and a request without any browser signal is allowed.

Trusted origins are the instance's post-init `trustedOrigins`, including plugin-contributed ones and function-valued `trustedOrigins`, matched with Better Auth's own matcher. The request's own origin counts as trusted only when `baseURL` is unset, never from forwarding headers. A verdict is memoized per browser leg, so a socket evaluates a function-valued `trustedOrigins` once. The first denial per reason and origin within an hour logs a warning with the sanitized origin.

**Escapes for non-browser and native clients.**

- Server-side callers that forward a user's cookie on unsafe requests, such as an SSR server, send a trusted `Origin` header, as Better Auth's own routes require. Node's built-in `fetch` sends none by default.
- Machine clients use bearer tokens or API keys without cookies; cookie mode does not inspect them.
- Native apps that send the session cookie themselves (Better Auth's Expo client calling your routes) send no `Origin`, `Referer` or `Sec-Fetch-*` headers. Either set `originCheck.missingOrigin: "allow-non-browser"`, which admits requests without all three signals, or send `Origin: <app scheme>://` and list it in `trustedOrigins`. With the Expo plugin present and `missingOrigin: "reject"`, startup logs `W_ORIGIN_CHECK_NATIVE_CLIENTS`.
- `@SkipOriginCheck()` removes the check from a handler or controller that deliberately serves cookie-bearing server-to-server calls, and `originCheck.mode: "off"` removes it from the instance (`W_ORIGIN_CHECK` in production).

Better Auth skips its own origin checks under `NODE_ENV=test` or a truthy `TEST` variable, and the kernel follows the same resolved flags (`advanced.disableCSRFCheck`, `advanced.disableOriginCheck`); startup logs `W_ORIGIN_CHECK` whenever they are off. Set `advanced.disableOriginCheck: false` on test instances that exercise origin rules.

## Lifecycle and operational limits

**Binding and shutdown.** At `onModuleInit`, each instance's `nestjs()` plugin binds to the application; the binding records the application's hook tables. One live application binds an instance at a time: a second application initialized while the first is bootstrapped fails with `INSTANCE_ALREADY_BOUND`. An application whose `init()` failed never bootstrapped, and the next application takes its binding over with `W_INSTANCE_TAKEN_OVER`; a closed application's binding is taken over silently. `app.close()` marks the binding closed but keeps its hooks dispatching until another application binds the instance, so work that other modules drain during shutdown, such as queue workers or outbox relays, still runs the application's `@BeforeDatabase()` rules; a hook whose own dependencies already shut down throws, and that Better Auth call fails. Call `app.enableShutdownHooks()` so process signals run this sequence. Better Auth calls and database writes made before the binding, for example seeding in another global module's `onModuleInit`, run without Nest hooks; when the application declares hooks, startup logs `W_CALLS_BEFORE_BIND`. Seed in `onApplicationBootstrap`. Hybrid applications with `deferInitialization: true` initialize the HTTP application (`app.init()` or `app.listen()`) before `app.startAllMicroservices()`.

**Revocation and caching.** Identity reads honor Better Auth's cookie cache: when `session.cookieCache` is enabled, a revoked session keeps working on ordinary routes until the cached cookie expires (`session.cookieCache.maxAge`), as in Better Auth. `@RequireAuth({ authoritative: true })`, `session: { freshness: "authoritative" }` or any admin `permission()` requirement read identity past the cache. WebSocket transports (`principalTtlMs`) and GraphQL socket operations (`subscriptionPrincipalTtlMs`) resolve the principal for every message or operation by default; a positive TTL reuses a connection's principal and delays revocation by up to the TTL, except on authoritative plans. A GraphQL subscription is authorized when it starts; events it delivers afterwards are not re-authorized, so revoking a session does not end an open subscription.

**Storage outages.** An outage never turns into a 401 or 403 where the library can tell it apart: resolution and policy failures surface as 5xx. Better Auth hides some outages itself:

- With the `customSession` plugin, Better Auth catches storage errors inside `getSession`, so an outage during the guard's session read or a policy's re-read answers 401 instead of a 5xx.
- `verifyApiKey` reports storage failures as `INVALID_API_KEY`. `apiKeyPrincipal()` treats an `INVALID_API_KEY` that took longer than `outageProbe.slowMs` (default 500 ms) as an outage, and otherwise runs a probe (a read and a zero-row write on the key table, at most once per second per instance) before answering 401. Failures confined to the key's own row that return faster than `slowMs`, and keys stored only in secondary storage, still answer 401; set `slowMs` below your pool's lock and statement timeouts and above the cost of a custom key hasher. Better Auth logs `Failed to validate API key` at ERROR for every rejected key.
- Public routes perform no principal I/O and keep working during an outage.

**Coverage checks.** Transports report the handlers they reach, and startup fails when a claimed handler is not covered by `BetterAuthGuard`: an HTTP route that declares access metadata or cookie forwarding while no guard reaches it (`ROUTE_UNGUARDED`, for example under `globalGuard: false` without `@UseBetterAuth()`), every WebSocket message handler without `@UseBetterAuth()` (`GATEWAY_UNGUARDED`), every hybrid microservice handler without explicit coverage unless `inheritAppConfig` is asserted (`RPC_HANDLER_UNGUARDED`), GraphQL field resolvers that declare access metadata without field guards (`FIELD_RESOLVER_UNGUARDED`), and federation reference resolvers (`FEDERATION_FIELD_GUARDS_REQUIRED`, `REFERENCE_RESOLVER_UNGUARDED`). `gatewayCoverage`, `hybridCoverage`, `fieldResolverCoverage` and `federationCoverage` lower the transport checks to `"warn"` or `"off"` for deployments that cover the handlers another way. The transport sections below describe each case.

**Boot summary.** With `logSummary` (default `true`), each instance logs one line with its mount, platform and proxy trust, transports, principal sources, hook counts, default access, origin-check mode, handler counts by access, environment, rate-limit state, whether the global scope is on and the order of global guards.

## GraphQL

The `./graphql` entry provides `apolloTransport()` for `@nestjs/apollo` and `mercuriusTransport()` for `@nestjs/mercurius`. Queries, mutations, subscriptions and federation reference resolvers use the same access decorators, principal parameters and authorization units as controllers. Only this entry imports `@nestjs/graphql` and `graphql`.

Create the Better Auth instance with the construction plugin as shown under [Construct the Better Auth instance](#construct-the-better-auth-instance), then register the GraphQL module and the transport that matches its driver:

```ts
// app.module.ts
import { ApolloDriver, type ApolloDriverConfig } from "@nestjs/apollo";
import { Module } from "@nestjs/common";
import { GraphQLModule, Query, Resolver } from "@nestjs/graphql";
import {
  type AuthPrincipal,
  BetterAuthModule,
  CurrentPrincipal,
  Public,
} from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { apolloTransport } from "nestjs-slightly-better-auth/graphql";
import { auth } from "./auth";

@Resolver()
export class ViewerResolver {
  @Query(() => String)
  viewer(@CurrentPrincipal() principal: AuthPrincipal) {
    return principal.userId;
  }

  @Query(() => String)
  @Public()
  health() {
    return "ok";
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      subscriptions: { "graphql-ws": true },
      fieldResolverEnhancers: ["guards", "filters"],
    }),
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      transports: [apolloTransport()],
    }),
  ],
  providers: [ViewerResolver],
})
export class AppModule {}
```

For Mercurius, use `MercuriusDriver`, `fastifyPlatform()` from `nestjs-slightly-better-auth/fastify` and `mercuriusTransport()`. `mercuriusSubscriptionContext()` returns a Mercurius `subscription.context` function that keeps the upgrade request and its original browser headers with every socket operation; the socket tests cover Mercurius with and without it. A custom GraphQL `context` must be a function that returns a fresh object for every operation. For Apollo HTTP operations, it keeps the platform request at `context.req`: the Express request, or the Fastify request that the context function receives as its first argument, not that request's `raw` `IncomingMessage`. For Apollo socket operations, it either leaves `context.req` unset, so Nest assigns the graphql-ws context, or keeps graphql-ws's `extra` at `context.extra` and the connection parameters at `context.connectionParams`; the upgrade request alone is not recognized. An operation whose context carries neither fails closed with `AUTH_MISCONFIGURED` (`GRAPHQL_CONTEXT_UNRECOGNIZED`). Startup fails with `GRAPHQL_STATIC_CONTEXT` for a static context object and with `GRAPHQL_DRIVER_MISMATCH` when the transport does not match the configured driver.

### Operations and fields

Each root field of an operation is authorized independently, so aliases and batched operations can share one session read while receiving different organization decisions. A denied field produces a GraphQL error whose `extensions` contain `code`, `statusCode` and, where applicable, `reason`. Authentication infrastructure failures surface as `Internal server error` with `code: "INTERNAL_SERVER_ERROR"` and `reason` `AUTH_UNAVAILABLE` or `AUTH_MISCONFIGURED`; the underlying error never reaches the client. Better Auth's browser-origin check applies to HTTP mutations and to every socket operation.

Field resolvers without access decorators inherit the principal of their actual ancestor operation, including across named instances: the reading comes from the operation's lineage, not from sibling fields, and does not depend on the order in which their guards settle. Class-level access metadata does not apply to field resolvers; method-level metadata gives a field resolver its own plan. Protecting field and reference resolvers requires Nest to run guards on them: set `fieldResolverEnhancers: ["guards", "filters"]`, and add `"interceptors"` when those fields use scoped service readers. With `"guards"` enabled, Nest runs every global guard once per field invocation, and the boot advice `W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS` names the affected guards and interceptors. A field resolver that declares access metadata without field guards fails startup with `FIELD_RESOLVER_UNGUARDED`; `fieldResolverCoverage: "warn" | "off"` relaxes that check. Without `"filters"`, Nest does not route field errors through its exception pipeline, so they are not logged; the library then emits `W_FIELD_EXCEPTION_FILTERS_DISABLED`. With filters enabled, repeated infrastructure and reader errors produce one Nest ERROR per logical request while every affected field receives a safe error.

`@CurrentSession()` on a field resolver under an operation that admits other principal kinds receives the enclosing principal at run time, so it fails with `SESSION_REQUIRED` for an API-key principal; startup warns with `W_NESTED_PRINCIPAL_PARAM`. Use `@CurrentPrincipal()` and narrow `kind` there. `limits.maxAuthorizationCallsPerRequest` bounds the distinct policy calls of many aliased fields, but not their concurrency; keep GraphQL depth or complexity limits in place.

### Subscriptions and socket operations

Socket operations authenticate each operation independently from the WebSocket upgrade request and never refresh the session. A subscription is authorized when it starts, and the events it delivers are not re-authorized. Browser-origin checks always use the original upgrade headers, before any session read, so connection parameters cannot replace the browser's `Origin`. The platform's own request predicate classifies HTTP operations first, and Apollo recognizes a socket operation only through the graphql-ws connection and its WebSocket. A client-sent `Upgrade: websocket` header therefore never selects the socket path: an HTTP operation keeps the platform client IP, response cookie forwarding and the completed-request check, and an unrecognized context still fails closed. Mercurius treats an operation whose context carries the route's own Fastify reply as HTTP before any socket detection, and otherwise identifies sockets only through its subscription context, so neither request headers nor client fields spread into a custom context select the socket path.

By default, `authorization` and `cookie` values in the `connection_init` payload replace the matching upgrade headers. `connectionParamHeaders` replaces that list of keys, matched case-insensitively. A `connection_init` message without a payload, which a graphql-ws `createClient()` without `connectionParams` sends, carries no connection parameters: the upgrade request's own credential headers apply, and a connection without them is anonymous. A selected value that is not a string or is not a valid header value rejects the operation with `UNAUTHENTICATED` and `reason: "MALFORMED_CREDENTIALS"`, without falling back to another credential and without echoing the value in errors or logs.

`subscriptionCredentials(connectionContext)` replaces this mapping. The `HeadersInit` it returns becomes the operation's credentials, and `host`, `x-forwarded-host` and `x-forwarded-proto` are copied from the upgrade request when absent. Returning `undefined` presents no credentials, and `connectionParamHeaders` is not consulted. Invalid header values reject with `MALFORMED_CREDENTIALS`; errors thrown by the function are application errors, not credential denials.

`subscriptionPrincipalTtlMs` reuses a connection's principal for that many milliseconds. The default `0` resolves the principal for every socket operation. A positive value delays the effect of session revocation on open connections by up to the TTL; routes with `@RequireAuth({ authoritative: true })` always resolve a fresh principal.

### Federation

Both transports support `ApolloFederationDriver` and `MercuriusFederationDriver` with schema-first schemas and code-first federation versions 1 and 2. `@ResolveReference()` resolvers are always checked: without field guards, startup fails with `FEDERATION_FIELD_GUARDS_REQUIRED` or `REFERENCE_RESOLVER_UNGUARDED`, and `federationCoverage` relaxes the check. `federationCoverage: "warn"` suits a subgraph that only an authenticating router can reach. Field resolvers under an entity inherit the reading of its type's reference resolver.

Federation schema generation in `@nestjs/graphql` loads `@apollo/subgraph`, which the install commands above do not include. Federation applications must install a compatible version, for example `pnpm add @apollo/subgraph@^2.15.1`; otherwise startup fails before authentication runs. `@apollo/subgraph` 2.15 requires `@nestjs/graphql` 14.0.2 or newer, as described under [Supported versions](#supported-versions).

### Supported versions

The native GraphQL tests run Nest 12.0.3 with `@nestjs/graphql`, `@nestjs/apollo` and `@nestjs/mercurius` 14.0.2, `graphql` 16.14.2, `@apollo/server` 5.5.1, `mercurius` 16.10.0, `@mercuriusjs/federation` 5.1.1 and `@apollo/subgraph` 2.15.1. Code-first federation with `@apollo/subgraph` 2.15 requires `@nestjs/graphql` 14.0.2 or newer. With `@nestjs/graphql` 14.0.1, schema generation fails before authentication runs: federation 1 cannot load the subgraph directives module that 2.15 removed, and federation 2 fails with `TypeError: doc.definitions is not iterable`. The `@nestjs/graphql` peer range therefore starts at 14.0.2.

## WebSocket gateways

The `./websockets` entry authenticates Socket.IO and raw `ws` gateways. Register `socketIoTransport()` or `wsTransport()` in the module's `transports`, and decorate every gateway with `@UseBetterAuth()` so both the guard and the invocation scope run for its message handlers. Startup fails with `GATEWAY_UNGUARDED` when a message handler lacks that coverage; `@Public()` opts a gateway or handler out, and the transports' `gatewayCoverage` option downgrades the check to `"warn"` or `"off"`. Message handlers use the same access, session and authorization decorators as controllers.

```ts
import { Inject, Module } from "@nestjs/common";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import type { Server } from "socket.io";
import {
  BetterAuthModule,
  CurrentSession,
  RequireAuth,
  UseBetterAuth,
} from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import {
  socketIoTransport,
  WS_CONNECTION_AUTH,
  type WsConnectionAuth,
} from "nestjs-slightly-better-auth/websockets";
import { auth } from "./auth"; // betterAuth({ plugins: [bearer(), nestjs()], ... })

@WebSocketGateway()
@UseBetterAuth()
export class EventsGateway {
  constructor(
    @Inject(WS_CONNECTION_AUTH)
    private readonly connectionAuth: WsConnectionAuth,
  ) {}

  afterInit(server: Server) {
    // Optional: reject unauthenticated handshakes before any message arrives.
    server.use(this.connectionAuth.socketIoMiddleware({ required: true }));
  }

  @RequireAuth()
  @SubscribeMessage("whoami")
  whoami(@CurrentSession() session: { user: { email: string } }) {
    return { email: session.user.email };
  }
}

@Module({
  imports: [
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      transports: [socketIoTransport()],
    }),
  ],
  providers: [EventsGateway],
})
export class AppModule {}
```

Socket.IO reads credentials from the handshake headers. When the handshake has no `Authorization` header, a string `auth.token` becomes `Authorization: Bearer <token>`, which Better Auth's `bearer()` plugin accepts. Raw `ws` reads the upgrade request, so wrap Nest's adapter to record it: `app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app))`. Without that record, public messages still run and protected messages fail with a 500 `WS_UPGRADE_REQUEST_MISSING` configuration error.

A `credentials(client)` option on either transport replaces the default mapping: the entries of the `HeadersInit` it returns override the handshake headers of the same name for authentication. The browser-origin check always uses the original handshake, so mapped credentials cannot bypass it. A non-string `auth.token`, or mapped credentials that are not string pairs or contain CR, LF, NUL or other invalid header characters, fail with a 401 `MALFORMED_CREDENTIALS` before any Better Auth call. Other credentials on the connection are not tried in their place, and the failure does not carry the rejected value. Errors thrown by the mapper itself are not converted into authentication failures.

Connection authentication runs the same origin check and default credential sources as messages, for the default instance or the one named by `instance`. `socketIoMiddleware({ required, instance })` rejects a Socket.IO handshake with a `connect_error` whose `data` holds `statusCode`, `code` and `reason`; `required: false` admits connections without credentials but still rejects invalid ones. Unexpected errors reach the client as a 500 `Internal server error`, and the server logs a summary that omits foreign error messages because they can quote credentials. For raw `ws`, call `authenticate(client)` in `handleConnection` and close rejected connections with `wsCloseCodeFor(result.failure)`, which maps 401, 403 and 429 failures to close codes 4401, 4403 and 4429.

Principal caching is off by default. A positive `principalTtlMs` reuses a successful authentication on the same connection and therefore delays revocation for ordinary handlers; handlers declared with `@RequireAuth({ authoritative: true })` always revalidate. Neither message nor connection authentication refreshes cookies. A quota-consuming principal source such as `apiKeyPrincipal()` verifies on every message unless a TTL is set, which startup reports as `W_QUOTA_PER_MESSAGE`.

Tests run real Socket.IO 4.8.3 and ws 8.21.3 clients against Nest 12.0.3, where Nest delivers raw `ws` authentication failures as native `exception` messages.

## RPC authentication

The `./microservices` entry authenticates messages in standalone and hybrid Nest microservices. `rpcTransport()` reads credentials from the transport's native carrier: gRPC metadata, NATS headers, Kafka headers, RabbitMQ message headers and MQTT 5 user properties. TCP and Redis messages have no header carrier, so they send credentials in a payload envelope field, `auth` by default. Every message is authenticated separately.

```ts
import { Controller, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  MessagePattern,
  Transport,
  type MicroserviceOptions,
} from "@nestjs/microservices";
import { betterAuth } from "better-auth";
import { bearer } from "better-auth/plugins";
import {
  BetterAuthModule,
  CurrentUser,
  Public,
} from "nestjs-slightly-better-auth";
import { rpcTransport } from "nestjs-slightly-better-auth/microservices";
import { nestjs } from "nestjs-slightly-better-auth/plugin";

const auth = betterAuth({
  // RPC messages have no HTTP origin, so the base URL must be static.
  baseURL: "https://auth.example.com",
  // Add your database adapter and other Better Auth options.
  plugins: [bearer(), nestjs()],
});

@Controller()
class ProfileController {
  @MessagePattern("profile.get")
  profile(@CurrentUser() user: { id: string }) {
    return { userId: user.id };
  }

  @Public()
  @MessagePattern("health")
  health() {
    return { ok: true };
  }
}

@Module({
  imports: [BetterAuthModule.forRoot({ auth, transports: [rpcTransport()] })],
  controllers: [ProfileController],
})
class AppModule {}

const app = await NestFactory.createMicroservice<MicroserviceOptions>(
  AppModule,
  { transport: Transport.TCP, options: { host: "127.0.0.1", port: 4000 } },
);
await app.listen();
```

A TCP client puts credentials in the envelope, for example `{ auth: { authorization: "Bearer <token>" }, id: 1 }`; a NATS client sets an `authorization` header through `NatsRecordBuilder`. Carriers accept only the `authorization`, `cookie` and `x-api-key` fields by default. Pass carrier factories such as `grpcCarrier({ metadata: ["authorization"] })` or `payloadCarrier({ field: "credentials" })` in `rpcTransport({ carriers })` to change the accepted fields or the envelope. Host, forwarding and `set-cookie` metadata never reach Better Auth, so a broker message cannot claim an HTTP origin.

Configure a static Better Auth base URL, or a fallback for a dynamic one: RPC transports have no request host, and startup fails with `DYNAMIC_BASE_URL_WITHOUT_FALLBACK` otherwise. The admin `permission()` policy calls Better Auth without headers and has the same requirement. Message authentication never refreshes or sets cookies. Public messages run without credentials; protected messages without a matching carrier are rejected as unauthenticated. Malformed credential values, such as values containing CR, LF or NUL, are rejected with reason `MALFORMED_CREDENTIALS` without reaching Better Auth, the handler or logs.

In a hybrid application, Nest applies global guards to microservice handlers only when `connectMicroservice()` receives `{ inheritAppConfig: true }`. Either pass that option to every `connectMicroservice()` call and pass `rpcTransport({ inheritAppConfig: true })`, or apply `@UseBetterAuth()` to message controllers and `@Public()` to public handlers. Startup verifies the explicit form and fails with `RPC_HANDLER_UNGUARDED` for an uncovered message or event handler; `hybridCoverage: "warn"` or `"off"` lowers that check. The inheritance option is an assertion that the application passes the same flag to Nest, and startup logs the `W_RPC_INHERIT_APP_CONFIG_ASSERTED` warning for it.

Failures become `RpcException` payloads with `statusCode`, `code` and, where present, `reason`. gRPC calls receive native status codes: 16 for authentication, 7 for authorization, 8 for throttling and 13 for redacted infrastructure failures. End-to-end tests run real TCP and gRPC servers and real NATS, Kafka, RabbitMQ, MQTT 5 and Redis brokers against Nest 12.0.3, including hybrid applications with both coverage modes and default plus named instances.

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

// Inside a Vitest test or beforeEach: onTestFinished closes this app when the test ends (node:test: t.after).
const app = await initTestApp(
  (await builder.compile()).createNestApplication(),
  { closeWith: onTestFinished },
);
```

- `overridePrincipal(builder, principal, { instance })` overrides `PRINCIPAL_RESOLVER` for one instance (default `'default'`). A policy's re-classification read of a generic 401 answers absent, so organization policies deny 401 under a fixed principal; stub them with `overrideDecisions` or use real sessions from `authHeadersFor`. The admin policy judges the stored user row of the fixed `userId`.
- `overrideAuthGuard(builder, guard | { principal })` overrides `GUARD_CORE` and `SCOPE_CORE` once each. `overrideProvider(BetterAuthGuard)` and `overrideGuard(BetterAuthGuard)` cannot be combined: `TestingModuleBuilder` keeps one override per token, so one set of call sites would keep the real guard. An object with a `canActivate` method always runs as the guard, even when it also has a `principal` property. The stand-in scope reads the test stamp first; `{ principal }` stamps for the handler's instance, including named instances.
- `stampPrincipal(ctx, principal, { instance })` records the principal on the invocation's argument array and its object elements. Readers accept it from the same array (WebSocket, RPC and GraphQL guards and interceptors share it) or from another array with the same elements when at least two elements are objects (an HTTP request and its response). A lone shared element, such as a socket beside a primitive payload, never identifies an invocation, so concurrent invocations do not see each other's stamps. A stand-in that stamps nothing makes principal readers fail with the generic `NO_AUTH_RESULT` error.
- `testPrincipal(principal | (request) => principal | null, { kinds, acceptance, delegates })` is a principal source for composed test modules.
- `authHeadersFor(auth, userId)` creates real session headers through Better Auth's `testUtils()` plugin.
- `initTestApp(app, { closeWith })` runs `init()` and Fastify `ready()`. A Better Auth instance binds to one application at a time (a second bound application fails with `INSTANCE_ALREADY_BOUND`), so the helper first closes the previous application that it initialized for the same instance; a failed `init()` leaves its binding to the next application, which takes it over with `W_INSTANCE_TAKEN_OVER`. The helper makes `app.close()` idempotent and passes it to `closeWith`, a per-test cleanup such as Vitest's `onTestFinished` or node:test's `t.after`. Jest cannot register hooks while a test runs, so collect the closes and run them in a suite-level `afterEach`. Without `closeWith`, close the last application yourself. On Express, compile one `TestingModule` per application; a second application from the same module fails with `APP_ADAPTER_CHANGED`.

Better Auth treats a process with `NODE_ENV=test` or a truthy `TEST` variable (Vitest sets it; Jest sets `NODE_ENV=test`) as a test run and then skips its origin checks, and this library's origin check follows the same flags. Set `advanced.disableOriginCheck: false` on test instances that exercise origin rules.

## Conformance kits (`./testing/conformance`)

The kits verify extension units against the invariants of the [reviewed specification](docs/design/design-v7.md) (§4 and §14.1). Each kit returns `ConformanceCase[]` (`{ id, title, skip?, run() }`) that `runConformance(cases, { describe, it })` registers with Vitest, Jest or `node:test`. Assertions use `node:assert/strict`; the kits import no test runner.

Applicability comes from the unit, not from the options a harness passes. A platform that declares `capabilities.http2` needs the `http2` option. The platform kit's trusted-hop rows need `trustOneProxy`, and its microservice rows of `H-no-adapter` need `microservice`, which returns the transport options to boot with (for example `{ transport: Transport.TCP, options: { host: "127.0.0.1", port: 0 } }`); the kit does not load the optional `@nestjs/microservices` peer itself. The production-mode rows set `process.env.NODE_ENV` to `production` while they run and restore it afterwards, so run the kit's cases sequentially. A transport with a lineage needs `invokeTwice`, one that nests handlers (`defaultAccessFor`) needs `invokeGraph`, and one that claims the kit's federation reference resolver needs `invokeEntities`. A transport whose browser leg is a connection's handshake, shared by the connection's messages (the WebSocket transports), runs the `T-ws-origin-*` cases instead of the `T-csrf-*` cases and needs `invokeConnection`, plus `authenticateConnection` when the app provides `WS_CONNECTION_AUTH`. Such a case fails when the helper is missing, and `T-selection` fails `expectBrowserLeg: false` for a transport that describes a browser leg. A case whose optional capability is absent is skipped with the reason. The kits read these members from unit objects before running; for classes and `defineExtension()` definitions they boot once and read the resolved unit. A case known to be inapplicable registers with its reason in the test name. A case that finds out at run time resolves with `{ skipped: reason }`, which `runConformance` reports through the runner's `context.skip(reason)` (Vitest, `node:test`; Jest has no runtime skip, so the test passes).

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

| Kit                          | Unit                  | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpPlatformConformance`    | `HttpPlatform`        | Mounting (including a dynamic `allowedHosts` base URL), byte-exact bodies, limits with host CORS, URL and header facts, client IP (production-mode per-IP rate-limit buckets, Better Auth `trustedProxies`), HTTP/2, write-back, request accessors, error delivery, lifecycle (no adapter, including microservices, late adapter, reused `TestingModule`, double `forRoot`, hooks kept after `close()`), diagnostics (404 hints, `W_PROXY_UNTRUSTED`) and log hygiene                                                                                                                                                                                                |
| `transportConformance`       | `AuthTransport`       | Selection, credentials, per-request memoization, per-invocation decisions, acceptance, cookie forwarding or refresh suppression, origin and form-CSRF rules including forwarding on safe operations, WebSocket handshake origins on every message and at connection time (untrusted, missing and forwarded origins, junk tokens, dynamic base URLs, function-valued `trustedOrigins`), error shapes and logging, the exact coverage report of the transport's claims, `globalScope: false`, mixed-kind session reads, lazy scope construction and fail-closed extraction                                                                                             |
| `principalSourceConformance` | `PrincipalSource`     | Rejection without throwing, storage outages, delivery of every own-credential `Set-Cookie` exactly once, refresh suppression, clean absence, principal shape, declared credential headers, `sessionBacked` and `delegates` declarations, dynamic base URLs (direct and behind a trusted proxy), credential redaction in logs and raw causes; for API-key sources the verification results, outage and write-outage probes and organization-owned keys; for session-backed sources short-circuited session reads and the cookie bridge (third-party sign-up, foreign credentials); for sources of the `jwt` plugin the issuer and audience claims and key-set outages |
| `policyConformance`          | `AuthorizationPolicy` | Deny values, storage outages with the cookie cache off and warm, APIError mapping and re-classification, sessions lost before the policy's call, delegation scope, unnamed-kind gating, per-invocation decisions with shared I/O, request-scoped class policies, class policies' `requires` fields, plugin prerequisites, and the admin, organization and API-key rows below; requirements name policy objects (construct a DI policy with its dependencies)                                                                                                                                                                                                         |

The principal-source kit passes each credential factory the instance the case runs against: `credentials.valid(auth)` receives `auth`, or for `S-dynamic-base-url` a variant with a dynamic `baseURL` (allowed hosts `localhost:3000` and `public.example`, no fallback) that `variant(overrides)` builds. The default variant is `createConformanceAuth()` with the plugins of `auth`; a call that creates a credential on the variant passes a `host` header. `credentials.apiKey(auth, fields)` creates the keys of the `S-apikey-*` cases (default: `auth.api.createApiKey` for a new user), `credentials.organizationKey(auth)` enables `S-apikey-org-key`, and `http: { platform, createHttpAdapter }` enables the `S-bridge-*` routes. Each case boots its own module, so register a source that keeps state across requests, such as the API-key outage probe or a JWT key cache, as a `defineExtension()` factory.

Every case boots real Nest applications or modules with a real Better Auth instance that includes `conformanceProbePlugin()`. The probe counts and faults every operation of the instance's database adapter, so storage outages reach endpoints that would swallow them, and records the `Set-Cookie` lines each call produces. `createConformanceAuth({ plugins })` builds such an instance: memory adapter, `testUtils()`, `bearer()`, the probe plugin, `nestjs()` last, and `session.updateAge: 0` and origin checks on, whatever `options` says. The principal-source and policy kits take that instance as `auth`; the principal-source kit rejects an instance without `session.updateAge: 0`. The transport kit creates its own instance, with the organization plugin and the organizations its `org` fixture names, and passes it to your `createApp` harness together with the kit's API-key source in `principals`, a `logger` to boot with, and the `globalScope`, `appEnhancers`, `fieldResolverEnhancers` and `federation` settings of each boot. Apply every fixture decorator, including the kit's `SetMetadata()` marker, which maps the transport's claims to fixtures. On a connection-shaped browser leg, the kit's cookie credential carries the instance's base URL, `http://localhost:3000`, as `Origin`, as a browser page of that origin does; the `T-ws-origin-*` cases pass their own `Origin`, `Host` and forwarding headers, which the harness sends in the handshake.

The policy kit judges principals through the real evaluator, and cases that need route planning, acceptance or principal resolution send in-process requests through the real `BetterAuthGuard`. Pass the sources of the requirement's other principal kinds in `sources` (for example `apiKeyPrincipal()`). Unit-specific cases run when the requirement contains the built-in admin policy (`Z-admin-*`), an organization policy (`Z-org-ref-types` and the organization row of `Z-apikey-quota-per-request`) or the API-key permission policy (its `Z-apikey-quota-per-request` row), and skip with the reason otherwise. They use the instance's configuration where it matters: `session.cookieCache.enabled` for the warm-cache rows and `apiKey({ enableSessionForAPIKeys: true })` for the API-key session and quota rows. The kit builds the instances that need another configuration (`customSession` role shapes, `adminUserIds`, a dynamic `baseURL`) with `createConformanceAuth()`.

This repository runs the platform kit against Express and Fastify, including the Fastify HTTP/2 adapter for the HTTP/2 rows; the transport kit against the built-in HTTP transport, an in-process reference transport, Socket.IO and `ws` (each with and without a principal TTL), the RPC transport over TCP (standalone and hybrid), gRPC, NATS, RabbitMQ, MQTT, Redis and Kafka, and the Apollo (Express and Fastify) and Mercurius transports over HTTP and over graphql-ws (with and without a subscription principal TTL; Mercurius also without `mercuriusSubscriptionContext()`), with federation 2 subgraphs and a federation 1 run of `T-reference-resolver`; the principal-source kit against the session source (its `S-bridge-*` rows on Express and Fastify), the API-key source with user-owned and organization-owned keys, and the design's JWT source sketch with derived and explicit claims; and the policy kit against the admin, organization (also with `customSession`), API-key and fresh-session policies. gRPC skips `T-error-shape`, because it delivers only a status and a message. The kit reads each call's browser leg while its invocation runs, because the GraphQL transports reject a completed request. Mutation tests confirm that each of these defects fails the intended case: a platform merging `Set-Cookie`, handing Better Auth no client IP, ignoring its proxy trust, dropping the request host or stripping forwarding headers, a kernel that unbinds hooks on `close()`, reports taking over a closed binding or keeps a microservice's binding open, a transport sharing invocation state across aliases, a transport without a browser leg on safe operations, a `defineExtension()` transport with a lineage or nesting and no helper, a WebSocket transport that enforces its handshake like a safe read, exempts handshakes that carry a token, builds its leg URL from the bare handshake path or from forwarded headers, or answers internal errors with their cause, a GraphQL transport whose aliases share one invocation, whose lineage gives every field of an operation one position, whose field resolvers do not inherit their root's access, or that serves reference resolvers without field guards, a GraphQL harness that omits `invokeGraph`, `invokeEntities` or `invokeConnection`, a source throwing its denial, a source dropping its refresh cookie, a source turning a storage outage into a 401, API-key sources that report every failure as an invalid key, verify once per call, run without the outage probe or latency signal, probe on every invalid key, touch key rows, or map organization keys to users, a session source that trusts hook answers on authoritative routes, a source that wraps errors without the request's credentials, JWT sources that expect the basePath URL as issuer or deny a key-set outage, sources that drop the host or forwarded headers, a route planner that forwards every handler's direct calls, a `forwardForeignCookies()` without a declaration check or without forwarding, a policy widening delegated principals, a policy turning a lost session or a storage outage into a denial, an organization policy coercing non-string inputs or repeating its Better Auth call, admin policies that admit API keys by default, lack fresh identity or hostless calls, ignore a key owner's ban, judge the session's role or trust the stored user row, and boot validation or route planning that ignore request-scoped dependencies or a class policy's `requires` field.

## Develop in this monorepo

From the repository root:

```sh
mise install
mise exec -- pnpm install
mise exec -- pnpm --filter nestjs-slightly-better-auth typecheck
mise exec -- pnpm --filter nestjs-slightly-better-auth build
mise exec -- pnpm test:packaging
```

The shared toolchain uses Node.js LTS, pnpm, tsdown, TypeScript and Vitest. Builds produce ESM and CommonJS artifacts with declarations, checked by strict publint and attw.

[Contributing](../../CONTRIBUTING.md) explains repository checks and PRs. See [package instructions](AGENTS.md) and [import provenance](docs/provenance.md) before working with the historical material.

## Examples

Each example application registers a default and a named instance, reads the signed-in user through the `@CurrentUser()` principal parameter and starts without external services:

- [Express](../../examples/better-auth-express/README.md) and [Fastify](../../examples/better-auth-fastify/README.md) guard HTTP routes on their platforms.
- [Apollo GraphQL](../../examples/better-auth-graphql/README.md) authenticates queries and mutations over HTTP and every graphql-ws operation, with the named instance bound to its own resolver.
- [Socket.IO](../../examples/better-auth-websockets/README.md) authenticates gateway connections and every message, with the named instance on its own namespace.
- [TCP microservice](../../examples/better-auth-rpc/README.md) authenticates the messages of a hybrid application through the payload credential carrier.

## Releases

Versions come from Changesets, and publication runs from the monorepo's release workflow with npm trusted publishing and provenance; see [release automation](../../docs/releases.md). New entry points are additive, so they ship as minor versions.

## License

[MIT](LICENSE). The archived upstream adapter retains its [original MIT notice](legacy/LICENSE).
