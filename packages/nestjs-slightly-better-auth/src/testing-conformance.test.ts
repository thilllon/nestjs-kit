import { apiKey } from "@better-auth/api-key";
import {
  createParamDecorator,
  Inject,
  Injectable,
  Module,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants.js";
import { IntrinsicException } from "@nestjs/common/exceptions/intrinsic.exception.js";
import {
  APP_GUARD,
  APP_INTERCEPTOR,
  ExternalContextCreator,
  MetadataScanner,
} from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, customSession, organization } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { role } from "better-auth/plugins/access";
import { describe, expect, it, vi } from "vitest";
import { adminPermissionPolicy, permission } from "./admin.js";
import { apiKeyPermission, apiKeyPrincipal } from "./api-key.js";
import type {
  AuthorizationPolicy,
  AuthTransport,
  ConformanceCase,
  ExtensionRef,
  PrincipalSource,
  TransportCall,
  TransportValidationContext,
} from "./auth-contracts.js";
import {
  type AuthFailure,
  AuthFailures,
  BetterAuthConfigurationError,
  BetterAuthInfrastructureError,
} from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { defineExtension } from "./auth-module-definition.js";
import { BetterAuthService } from "./auth-service.js";
import type { AuthLike, AuthPrincipal } from "./auth-types.js";
import { allow } from "./authorization-evaluator.js";
import {
  createConformanceAuth,
  kitIdentity,
  runConformance,
} from "./conformance-fixtures.js";
import { policyConformance } from "./conformance-policy.js";
import { principalSourceConformance } from "./conformance-principal.js";
import {
  type FixtureHandler,
  type TransportConformanceOptions,
  type TransportFixtures,
  type TransportInvocationResult,
  transportConformance,
} from "./conformance-transport.js";
import { BootValidator } from "./boot-validator.js";
import { jwtPrincipal } from "./jwt-extension-fixture.js";
import {
  orgMember,
  orgMemberPolicy,
  organizationRef,
  orgPermission,
  orgPermissionPolicy,
} from "./organization.js";
import { PolicyResolver } from "./policy-resolver.js";
import { authenticated, rejected } from "./principal-resolver.js";
import { freshSession, sessionPrincipal } from "./session-principal.js";

const REFERENCE = "nestjs-slightly-better-auth:reference";
const REFERENCE_HANDLERS = Symbol("reference-handlers");

interface ReferenceOperation {
  readonly headers: Headers;
  readonly setCookies: string[];
  /** The connection that carries the operation, when the transport describes a connection-shaped browser leg. */
  readonly connection: object;
  /** Set by the harness once every invocation of the operation has answered. */
  completed: boolean;
}
interface ReferenceMessage {
  readonly input: Record<string, unknown>;
  readonly operation: "read" | "unsafe";
}

class ReferenceDenial extends IntrinsicException {
  constructor(readonly failure: AuthFailure) {
    super(failure.message);
  }
}

/**
 * An in-process transport with a custom context type: one operation (the logical request) carries one or more
 * invocations, like aliased fields. `sharedInvocation` reproduces the defect of reusing the operation as the invocation;
 * `readsWithoutBrowserLeg` the defect of describing no browser leg for safe operations. `connectionLeg` describes the
 * operation's connection as its browser leg, like a WebSocket handshake. `failsClosedWhenComplete` rejects reading the
 * browser leg of a completed operation, as the GraphQL transports reject a completed request.
 */
class ReferenceTransport implements AuthTransport {
  readonly id = "reference";

  constructor(
    private readonly defects: {
      sharedInvocation?: boolean;
      readsWithoutBrowserLeg?: boolean;
      connectionLeg?: boolean;
      failsClosedWhenComplete?: boolean;
    } = {},
  ) {}

  handles(context: ExecutionContext): boolean {
    return context.getType<string>() === REFERENCE;
  }

  describe(context: ExecutionContext): TransportCall {
    const [message, operation] = context.getArgs() as [
      ReferenceMessage,
      ReferenceOperation,
    ];
    const url = "http://localhost:3000/reference";
    const readsWithoutBrowserLeg = this.defects.readsWithoutBrowserLeg;
    const failsClosedWhenComplete = this.defects.failsClosedWhenComplete;
    const leg = this.defects.connectionLeg ? operation.connection : operation;
    return {
      key: operation,
      invocation: this.defects.sharedInvocation ? operation : message,
      headers: () => new Headers(operation.headers),
      clientIp: null,
      get cookies() {
        return {
          append: (lines: readonly string[]) => {
            operation.setCookies.push(...lines);
            return true;
          },
        };
      },
      get request() {
        return {
          method: message.operation === "unsafe" ? "POST" : "GET",
          url,
        };
      },
      param: (name) => message.input[name],
      get browser() {
        if (failsClosedWhenComplete && operation.completed) {
          throw BetterAuthConfigurationError.atRequest(
            "REFERENCE_OPERATION_COMPLETED",
            "The reference operation has completed",
          );
        }
        if (readsWithoutBrowserLeg && message.operation === "read") {
          return undefined;
        }
        return {
          enforce: message.operation === "unsafe",
          headers: () => new Headers(operation.headers),
          url,
          key: leg,
        };
      },
    };
  }

  toException(failure: AuthFailure): unknown {
    return new ReferenceDenial(failure);
  }

  toInternalException(
    error: Error,
    _context: ExecutionContext,
    info: { readonly repeated: boolean },
  ): unknown {
    return info.repeated ? new IntrinsicException(error.message) : error;
  }

  validate(context: TransportValidationContext): void {
    const scanner = new MetadataScanner();
    for (const wrapper of context.discovery.getProviders()) {
      const target = wrapper.metatype as
        | (abstract new (
            ...args: never[]
          ) => unknown)
        | undefined;
      if (!target?.prototype || !Reflect.get(target, REFERENCE_HANDLERS)) {
        continue;
      }
      for (const method of scanner.getAllMethodNames(target.prototype)) {
        context.claim(target, method, "global", {
          code: "REFERENCE_UNGUARDED",
          hint: "Register the global guard or add @UseBetterAuth().",
          inputs: ["orgId"],
        });
      }
    }
  }
}

const Input = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    (context.getArgs()[0] as ReferenceMessage).input,
);

function flatten(fixtures: TransportFixtures): Map<string, FixtureHandler> {
  const handlers = new Map<string, FixtureHandler>();
  for (const [name, value] of Object.entries(fixtures)) {
    if (name === "graph") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        handlers.set(`${name}${index}`, item);
      }
    } else {
      handlers.set(name, value as FixtureHandler);
    }
  }
  return handlers;
}

function handlerClass(fixtures: TransportFixtures, federation = false) {
  @Injectable()
  class ReferenceHandlers {
    static readonly [REFERENCE_HANDLERS] = true;

    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  const handlers = flatten(fixtures);
  if (federation && fixtures.graph.reference) {
    handlers.set("reference", fixtures.graph.reference);
  }
  for (const [name, fixture] of handlers) {
    const method = async function (
      this: ReferenceHandlers,
      ...args: unknown[]
    ) {
      const count = fixture.params.length;
      return fixture.handle(
        args.slice(0, count),
        args[count] as Record<string, unknown>,
        { service: this.service },
      );
    };
    Object.defineProperty(method, "name", { value: name });
    Object.defineProperty(ReferenceHandlers.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      ReferenceHandlers.prototype,
      name,
    )!;
    for (const [index, param] of fixture.params.entries()) {
      param(ReferenceHandlers.prototype, name, index);
    }
    Input()(ReferenceHandlers.prototype, name, fixture.params.length);
    for (const decorator of [...fixture.decorators].reverse()) {
      decorator(ReferenceHandlers.prototype, name, descriptor);
    }
  }
  return ReferenceHandlers;
}

const dispatchers = new WeakMap<
  object,
  {
    handlers: object;
    creator: ExternalContextCreator;
    fixtures: Map<string, FixtureHandler>;
  }
>();

/** App enhancers registered by the harness (T-coverage-claims with globalGuard: false). */
const appEnhancers = [
  { provide: APP_GUARD, useClass: BetterAuthGuard },
  { provide: APP_INTERCEPTOR, useClass: BetterAuthScopeInterceptor },
];

function referenceHarness(
  transport: ExtensionRef<AuthTransport>,
): TransportConformanceOptions {
  const call = async (
    app: INestApplication,
    name: string,
    message: ReferenceMessage,
    operation: ReferenceOperation,
  ) => {
    const { handlers, creator } = dispatchers.get(app)!;
    const callback = Reflect.get(handlers, name) as (
      ...args: unknown[]
    ) => unknown;
    const run = creator.create(
      handlers,
      callback,
      name,
      ROUTE_ARGS_METADATA,
      { exchangeKeyForValue: () => undefined },
      undefined,
      undefined,
      { guards: true, interceptors: true, filters: true },
      REFERENCE,
    );
    return run(message, operation);
  };
  const settle = async (
    promise: Promise<unknown>,
  ): Promise<Omit<TransportInvocationResult, "setCookies">> => {
    try {
      return { ok: true, body: await promise };
    } catch (error) {
      if (error instanceof ReferenceDenial) {
        return {
          ok: false,
          error: {
            statusCode: error.failure.status,
            code: error.failure.code,
            reason: error.failure.reason,
            message: error.failure.message,
          },
        };
      }
      return {
        ok: false,
        error: { statusCode: 500, message: "Internal server error" },
      };
    }
  };
  const names = (handler: string) =>
    handler === "triple" || handler === "tripleMixed"
      ? [0, 1, 2].map((index) => `${handler}${index}`)
      : [handler];
  return {
    transport,
    expectCookieCapable: true,
    expectBrowserLeg: true,
    invocationShapes: ["aliases"],
    async createApp(fixtures, auth, options) {
      const Handlers = handlerClass(fixtures, options.federation);
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            globalGuard: options.globalGuard,
            principals: options.principals,
            ...(options.defaultRequirements
              ? { defaultRequirements: options.defaultRequirements }
              : {}),
            ...(options.globalScope === undefined
              ? {}
              : { globalScope: options.globalScope }),
            transports: [transport],
            http: { mount: false },
            logSummary: false,
          } as never),
        ],
        providers: [Handlers, ...(options.appEnhancers ? appEnhancers : [])],
      })
      class ReferenceModule {}
      let builder = Test.createTestingModule({ imports: [ReferenceModule] });
      if (options.override) {
        builder = options.override(builder);
      }
      const moduleRef = await builder.compile();
      moduleRef.useLogger(options.logger ?? false);
      try {
        await moduleRef.init();
      } catch (error) {
        await moduleRef.close();
        throw error;
      }
      dispatchers.set(moduleRef, {
        handlers: moduleRef.get(Handlers),
        creator: moduleRef.get(ExternalContextCreator),
        fixtures: flatten(fixtures),
      });
      return moduleRef as unknown as INestApplication;
    },
    async invoke(app, handler, headers, input = {}) {
      const operation: ReferenceOperation = {
        headers: new Headers(headers),
        setCookies: [],
        connection: {},
        completed: false,
      };
      const { fixtures } = dispatchers.get(app)!;
      const results = await Promise.all(
        names(handler).map((name) =>
          settle(
            call(
              app,
              name,
              { input, operation: fixtures.get(name)!.operation },
              operation,
            ),
          ),
        ),
      );
      operation.completed = true;
      const failed = results.find((result) => !result.ok);
      return {
        ...(failed ?? results[0]!),
        setCookies: operation.setCookies,
      };
    },
    async invokeTwice(app, _shape, inputs, headers) {
      const operation: ReferenceOperation = {
        headers: new Headers(headers),
        setCookies: [],
        connection: {},
        completed: false,
      };
      const [first, second] = await Promise.all(
        inputs.map((input) =>
          settle(call(app, "org", { input, operation: "read" }, operation)),
        ),
      );
      operation.completed = true;
      return [first!, second!];
    },
  };
}

function caseById(cases: readonly ConformanceCase[], id: string) {
  const found = cases.find((item) => item.id === id);
  if (!found) {
    throw new Error(`no case ${id}`);
  }
  return found;
}

describe("transport kit on the in-process reference transport", () => {
  runConformance(
    transportConformance(referenceHarness(new ReferenceTransport())),
    { describe, it },
  );
});

describe("transport kit mutations", () => {
  it("fails T-invocation-decisions when aliases share one invocation object", async () => {
    const cases = transportConformance(
      referenceHarness(new ReferenceTransport({ sharedInvocation: true })),
    );
    await expect(
      caseById(cases, "T-invocation-decisions").run(),
    ).rejects.toThrow(/was not decided independently/);
  });

  it("fails the safe forwarding rows for a transport without a browser leg on reads", async () => {
    const cases = transportConformance(
      referenceHarness(
        new ReferenceTransport({ readsWithoutBrowserLeg: true }),
      ),
    );
    await expect(caseById(cases, "T-csrf-login-proxy").run()).rejects.toThrow(
      /expected a 403 denial/,
    );
    await expect(caseById(cases, "T-csrf-safe-methods").run()).rejects.toThrow(
      /expected a 403 denial/,
    );
  });

  it("decides the origin cases from the transport's browser leg, not from the helpers", async () => {
    const cases = transportConformance(
      referenceHarness(new ReferenceTransport({ connectionLeg: true })),
    );
    for (const id of [
      "T-ws-origin-untrusted",
      "T-ws-origin-junk-token",
      "T-ws-origin-dynamic-baseurl",
      "T-ws-origin-forwarded-host",
      "T-ws-origin-function-trusted-origins",
    ]) {
      expect(caseById(cases, id).skip).toBeUndefined();
      await expect(caseById(cases, id).run()).rejects.toThrow(
        /browser leg is its connection's handshake, so invokeConnection is required/,
      );
    }
    for (const id of [
      "T-csrf-http-unsafe",
      "T-csrf-http-cookie-plus-token",
      "T-csrf-login-proxy",
      "T-csrf-safe-methods",
    ]) {
      await expect(caseById(cases, id).run()).resolves.toEqual({
        skipped:
          "the browser leg is the connection's handshake, enforced on every message (T-ws-origin-* cover it)",
      });
    }
    await expect(
      caseById(
        transportConformance({
          ...referenceHarness(new ReferenceTransport()),
          expectBrowserLeg: false,
        }),
        "T-selection",
      ).run(),
    ).rejects.toThrow(
      /describes a browser leg, so expectBrowserLeg must be true/,
    );
  });

  it("reads browser legs while each invocation runs, for a transport that fails closed on completed operations", async () => {
    for (const connectionLeg of [false, true]) {
      const cases = transportConformance(
        referenceHarness(
          new ReferenceTransport({
            connectionLeg,
            failsClosedWhenComplete: true,
          }),
        ),
      );
      await expect(
        caseById(cases, "T-selection").run(),
      ).resolves.toBeUndefined();
      await expect(
        caseById(
          cases,
          connectionLeg ? "T-csrf-http-unsafe" : "T-ws-origin-untrusted",
        ).run(),
      ).resolves.toEqual({
        skipped: connectionLeg
          ? "the browser leg is the connection's handshake, enforced on every message (T-ws-origin-* cover it)"
          : "the browser leg follows each operation (T-csrf-* cover it)",
      });
    }
    await expect(
      caseById(
        transportConformance({
          ...referenceHarness(
            new ReferenceTransport({ failsClosedWhenComplete: true }),
          ),
          expectBrowserLeg: false,
        }),
        "T-selection",
      ).run(),
    ).rejects.toThrow(
      /describes a browser leg, so expectBrowserLeg must be true/,
    );
  });

  it("decides required capabilities from the transport a definition resolves, not from the helpers", async () => {
    class NestingTransport extends ReferenceTransport {
      // Instance fields: invisible on the prototype.
      readonly lineage = (): undefined => undefined;

      readonly defaultAccessFor = (): undefined => undefined;

      override validate(context: TransportValidationContext): void {
        super.validate(context);
        for (const wrapper of context.discovery.getProviders()) {
          const target = wrapper.metatype as { prototype?: object } | undefined;
          if (
            target?.prototype &&
            Reflect.get(target, REFERENCE_HANDLERS) &&
            typeof Reflect.get(target.prototype, "reference") === "function"
          ) {
            context.claim(target as never, "reference", "global", {
              code: "REFERENCE_RESOLVER_UNGUARDED",
              hint: "Serve federation with field resolver guards.",
              everyHandler: true,
            });
          }
        }
      }
    }
    const cases = transportConformance({
      ...referenceHarness(
        defineExtension({ use: { useFactory: () => new NestingTransport() } }),
      ),
      invokeTwice: undefined,
      invocationShapes: undefined,
    });
    await expect(
      caseById(cases, "T-invocation-decisions").run(),
    ).rejects.toThrow(/has a lineage, so invokeTwice/);
    await expect(
      caseById(cases, "T-internal-error-logged-once").run(),
    ).rejects.toThrow(/has a lineage, so invokeTwice/);
    await expect(caseById(cases, "T-inherit-no-lookup").run()).rejects.toThrow(
      /nests handlers \(defaultAccessFor\), so invokeGraph/,
    );
    await expect(caseById(cases, "T-stamp-per-plan").run()).rejects.toThrow(
      /so invokeGraph is required/,
    );
    await expect(caseById(cases, "T-reference-resolver").run()).rejects.toThrow(
      /claims the federation reference resolver/,
    );
    for (const id of [
      "T-invocation-decisions",
      "T-inherit-no-lookup",
      "T-reference-resolver",
    ]) {
      expect(caseById(cases, id).skip).toBeUndefined();
    }
  });
});

async function apiKeyAuth(): Promise<{
  auth: AuthLike;
  owner: string;
  key: (
    permissions?: Record<string, string[]>,
    extra?: object,
  ) => Promise<string>;
}> {
  const auth = createConformanceAuth({ plugins: [apiKey()] });
  const owner = (await kitIdentity(auth)).userId;
  return {
    auth,
    owner,
    async key(permissions, extra = {}) {
      const created = await (
        auth.api as unknown as {
          createApiKey(input: { body: object }): Promise<{ key: string }>;
        }
      ).createApiKey({
        body: {
          userId: owner,
          ...(permissions ? { permissions } : {}),
          ...extra,
        },
      });
      return created.key;
    },
  };
}

/** Headers that let an auth.api call resolve a variant instance's dynamic baseURL (S-dynamic-base-url). */
const KIT_HOST = { host: "localhost:3000" };

interface KeyCreation {
  createApiKey(input: {
    body: object;
    headers?: Headers;
  }): Promise<{ id: string; key: string }>;
  createOrganization(input: {
    body: { name: string; slug: string };
    headers: Headers;
  }): Promise<{ id: string }>;
}

/** A key of a new user, created through a session call so that it also works on a dynamic-baseURL instance. */
async function sessionKey(auth: AuthLike): Promise<Headers> {
  const identity = await kitIdentity(auth);
  const created = await (auth.api as unknown as KeyCreation).createApiKey({
    body: {},
    headers: new Headers({ ...KIT_HOST, cookie: identity.cookie }),
  });
  return new Headers({ "x-api-key": created.key });
}

/** A key owned by a new organization. Server-only fields (remaining, rate limits) need a server call. */
async function organizationKey(
  auth: AuthLike,
  fields: Readonly<Record<string, unknown>> = {},
): Promise<{ id: string; headers: Headers }> {
  const identity = await kitIdentity(auth);
  const api = auth.api as unknown as KeyCreation;
  const session = new Headers({ ...KIT_HOST, cookie: identity.cookie });
  const organization = await api.createOrganization({
    headers: session,
    body: {
      name: "Conformance organization",
      slug: `org-${globalThis.crypto.randomUUID()}`,
    },
  });
  const created = Object.keys(fields).length
    ? await api.createApiKey({
        body: {
          userId: identity.userId,
          organizationId: organization.id,
          ...fields,
        },
      })
    : await api.createApiKey({
        body: { organizationId: organization.id },
        headers: session,
      });
  return { id: created.id, headers: new Headers({ "x-api-key": created.key }) };
}

function organizationKeyAuth(): AuthLike {
  return createConformanceAuth({
    plugins: [organization(), admin(), apiKey({ references: "organization" })],
  });
}

function sessionCredentials(auth: AuthLike) {
  return {
    valid: async (instance: AuthLike) =>
      new Headers({ cookie: (await kitIdentity(instance)).cookie }),
    invalid: () =>
      new Headers({ cookie: "better-auth.session_token=invalid.value" }),
    auth,
  };
}

async function jwtBearer(auth: AuthLike, subject = "conformance-jwt") {
  const { token } = await (
    auth.api as unknown as {
      signJWT(input: {
        body: { payload: Record<string, unknown> };
        headers: Headers;
      }): Promise<{ token: string }>;
    }
  ).signJWT({
    body: { payload: { sub: subject } },
    headers: new Headers(KIT_HOST),
  });
  return new Headers({ authorization: `Bearer ${token}` });
}

describe("principal source kit on the built-in session source", () => {
  const { auth, ...credentials } = sessionCredentials(createConformanceAuth());
  runConformance(
    principalSourceConformance({
      source: sessionPrincipal(),
      auth,
      credentials,
    }),
    { describe, it },
  );
});

describe("principal source kit on the built-in API-key source", async () => {
  const keys = await apiKeyAuth();
  runConformance(
    principalSourceConformance({
      // One source per case: the source shares one outage probe per second (S-apikey-outage), so an earlier case's
      // healthy probe would otherwise answer S-infra-throws.
      source: defineExtension({ use: { useFactory: () => apiKeyPrincipal() } }),
      auth: keys.auth,
      credentials: {
        valid: sessionKey,
        invalid: () => new Headers({ "x-api-key": "conformance-unknown" }),
        rateLimited: async () =>
          new Headers({
            "x-api-key": await keys.key(undefined, { remaining: 0 }),
          }),
      },
    }),
    { describe, it },
  );
});

describe("principal source kit on organization-owned API keys", () => {
  runConformance(
    principalSourceConformance({
      source: defineExtension({
        use: {
          useFactory: () => apiKeyPrincipal({ references: "organization" }),
        },
      }),
      auth: organizationKeyAuth(),
      credentials: {
        valid: async (auth) => (await organizationKey(auth)).headers,
        invalid: () => new Headers({ "x-api-key": "conformance-unknown" }),
        apiKey: organizationKey,
        organizationKey: async (auth) => (await organizationKey(auth)).headers,
      },
    }),
    { describe, it },
  );
});

describe("principal source kit on the JWT extension fixture (design v7 §4.3.4)", () => {
  runConformance(
    principalSourceConformance({
      // One source per case: the source caches the key set per instance (S-jwt-claims outage row).
      source: defineExtension({ use: { useFactory: () => jwtPrincipal() } }),
      auth: createConformanceAuth({ plugins: [jwt()] }),
      credentials: {
        valid: (auth) => jwtBearer(auth),
        invalid: () => new Headers({ authorization: "Bearer a.b.c" }),
      },
    }),
    { describe, it },
  );
});

describe("principal source kit on the JWT extension fixture with explicit claims", () => {
  // Explicit issuer and audience let the source verify tokens under a dynamic baseURL (S-dynamic-base-url).
  const claims = {
    issuer: "https://issuer.conformance.example",
    audience: "https://audience.conformance.example",
  };
  runConformance(
    principalSourceConformance({
      source: defineExtension({
        use: { useFactory: () => jwtPrincipal(claims) },
      }),
      auth: createConformanceAuth({ plugins: [jwt({ jwt: claims })] }),
      credentials: {
        valid: (auth) => jwtBearer(auth),
        invalid: () => new Headers({ authorization: "Bearer a.b.c" }),
      },
    }),
    { describe, it },
  );
});

function caseByTitle(
  cases: readonly ConformanceCase[],
  id: string,
  title: string,
): ConformanceCase {
  const found = cases.find(
    (item) => item.id === id && item.title.includes(title),
  );
  if (!found) {
    throw new Error(`no case ${id} titled ${title}`);
  }
  return found;
}

/** The kit on an API-key instance for a (faulty) source. */
async function apiKeyCases(source: PrincipalSource) {
  const keys = await apiKeyAuth();
  return principalSourceConformance({
    source,
    auth: keys.auth,
    credentials: {
      valid: sessionKey,
      invalid: () => new Headers({ "x-api-key": "conformance-unknown" }),
    },
  });
}

/** A source that behaves like `real` with a replaced resolve(). */
function faulty(
  real: PrincipalSource<never> | PrincipalSource,
  resolve: PrincipalSource["resolve"],
): PrincipalSource {
  return { ...(real as unknown as PrincipalSource), resolve };
}

describe("principal source kit mutations for the unit-specific rows", () => {
  it("fails S-apikey-results for a source that reports every failure as an invalid key", async () => {
    const real = apiKeyPrincipal();
    const cases = await apiKeyCases(
      faulty(real, async (request) => {
        const result = await real.resolve(request);
        return result.outcome === "rejected"
          ? rejected(
              AuthFailures.rejected({ status: 401, reason: "INVALID_API_KEY" }),
            )
          : (result as never);
      }),
    );
    await expect(caseById(cases, "S-apikey-results").run()).rejects.toThrow(
      /a rate-limited key/,
    );
  });

  it("fails S-apikey-results for a source that verifies a key once per call instead of once per request", async () => {
    const real = apiKeyPrincipal();
    const cases = await apiKeyCases(
      faulty(real, (request) =>
        real.resolve({ ...request, memo: (_key, compute) => compute() }),
      ),
    );
    await expect(caseById(cases, "S-apikey-results").run()).rejects.toThrow(
      /one request verified its key 3 times/,
    );
  });

  it("fails S-apikey-outage for sources without the outage probe or the latency signal", async () => {
    const withoutProbe = await apiKeyCases(
      apiKeyPrincipal({ outageProbe: false }),
    );
    await expect(
      caseByTitle(withoutProbe, "S-apikey-outage", "key reads failing").run(),
    ).rejects.toThrow(/during a read outage resolved/);
    const withoutLatency = await apiKeyCases(
      apiKeyPrincipal({ outageProbe: { slowMs: false } }),
    );
    await expect(
      caseByTitle(withoutLatency, "S-apikey-outage", "stalled").run(),
    ).rejects.toThrow(/stalled and failed resolved/);
  });

  it("fails S-apikey-outage for a source that probes storage on every invalid key", async () => {
    const real = apiKeyPrincipal();
    const cases = await apiKeyCases(
      faulty(real, async (request) => {
        const result = await real.resolve(request);
        if (result.outcome === "rejected") {
          const context = await request.auth.context();
          await context.adapter.updateMany({
            model: "apikey",
            where: [{ field: "key", value: crypto.randomUUID() }],
            update: { updatedAt: new Date() },
          });
        }
        return result as never;
      }),
    );
    await expect(
      caseByTitle(cases, "S-apikey-outage", "flood").run(),
    ).rejects.toThrow(/a flood of 12 invalid keys wrote 1[3-9] times/);
  });

  it("fails S-apikey-write-outage without the write probe and for a probe that touches key rows", async () => {
    const withoutProbe = await apiKeyCases(
      apiKeyPrincipal({ outageProbe: false }),
    );
    await expect(
      caseByTitle(withoutProbe, "S-apikey-write-outage", "every write").run(),
    ).rejects.toThrow(/during a write outage resolved/);
    const real = apiKeyPrincipal();
    const touching = await apiKeyCases(
      faulty(real, async (request) => {
        const result = await real.resolve(request);
        const context = await request.auth.context();
        await context.adapter.updateMany({
          model: "apikey",
          where: [{ field: "enabled", value: true }],
          update: { updatedAt: new Date(Date.now() + 60_000) },
        });
        return result as never;
      }),
    );
    await expect(
      caseByTitle(touching, "S-apikey-write-outage", "no key row").run(),
    ).rejects.toThrow(/an invalid key changed a stored key/);
  });

  it("fails S-apikey-org-key for a source that maps organization keys to users", async () => {
    const cases = principalSourceConformance({
      source: apiKeyPrincipal(),
      auth: organizationKeyAuth(),
      credentials: {
        valid: async (auth) => (await organizationKey(auth)).headers,
        invalid: () => new Headers({ "x-api-key": "conformance-unknown" }),
        apiKey: organizationKey,
        organizationKey: async (auth) => (await organizationKey(auth)).headers,
      },
    });
    await expect(caseById(cases, "S-apikey-org-key").run()).rejects.toThrow(
      /an organization-owned key produced a user principal/,
    );
  });

  it("fails S-short-circuit-session for a session source that trusts hook answers on authoritative routes", async () => {
    const { auth, ...credentials } = sessionCredentials(
      createConformanceAuth(),
    );
    const real = sessionPrincipal();
    const cases = principalSourceConformance({
      source: faulty(real as never, (request) =>
        real.resolve({
          ...request,
          auth: { ...request.auth, producedByEndpoint: () => true },
        }),
      ),
      auth,
      credentials,
    });
    await expect(
      caseById(cases, "S-short-circuit-session").run(),
    ).rejects.toThrow(/accepted a session no endpoint produced/);
  });

  it("fails S-log-redaction for a source that wraps storage errors without the request's credentials", async () => {
    const { auth, ...credentials } = sessionCredentials(
      createConformanceAuth(),
    );
    const real = sessionPrincipal();
    const cases = principalSourceConformance({
      source: faulty(real as never, async (request) => {
        try {
          return await real.resolve(request);
        } catch (error) {
          throw new BetterAuthInfrastructureError(error);
        }
      }),
      auth,
      credentials,
    });
    await expect(caseById(cases, "S-log-redaction").run()).rejects.toThrow(
      /a credential reached the logs/,
    );
  });

  it("fails S-jwt-claims for a JWT source that expects the basePath URL or denies a key-set outage", async () => {
    const auth = createConformanceAuth({ plugins: [jwt()] });
    const credentials = {
      valid: (instance: AuthLike) => jwtBearer(instance),
      invalid: () => new Headers({ authorization: "Bearer a.b.c" }),
    };
    const basePath = principalSourceConformance({
      source: jwtPrincipal({
        issuer: "http://localhost:3000/api/auth",
        audience: "http://localhost:3000/api/auth",
      }),
      auth,
      credentials,
    });
    await expect(
      caseByTitle(basePath, "S-jwt-claims", "signJWT minted").run(),
    ).rejects.toThrow(/did not verify/);
    const real = jwtPrincipal();
    const denying = principalSourceConformance({
      source: faulty(real as never, async (request) => {
        try {
          return await real.resolve(request);
        } catch {
          return rejected(
            AuthFailures.rejected({ status: 401, reason: "INVALID_JWT" }),
          );
        }
      }),
      auth,
      credentials,
    });
    await expect(
      caseByTitle(denying, "S-jwt-claims", "key-set read").run(),
    ).rejects.toThrow(/a key-set outage resolved/);
  });

  it("fails S-dynamic-base-url for sources that drop the host or forwarded headers", async () => {
    const real = apiKeyPrincipal();
    const keep = (headers: Headers, names: readonly string[]) =>
      new Headers(
        names.flatMap((name) => {
          const value = headers.get(name);
          return value === null ? [] : [[name, value] as [string, string]];
        }),
      );
    const hostless = await apiKeyCases(
      faulty(real, (request) =>
        real.resolve({
          ...request,
          headers: keep(request.headers, ["x-api-key"]),
        }),
      ),
    );
    await expect(
      caseByTitle(hostless, "S-dynamic-base-url", "without fallback").run(),
    ).rejects.toThrow(/threw with a dynamic baseURL/);
    const unforwarded = await apiKeyCases(
      faulty(real, (request) =>
        real.resolve({
          ...request,
          headers: keep(request.headers, ["x-api-key", "host"]),
        }),
      ),
    );
    await expect(
      caseByTitle(unforwarded, "S-dynamic-base-url", "trusted proxy").run(),
    ).rejects.toThrow(/a forwarded request threw/);
  });
});

describe("principal source kit mutations", () => {
  it("fails S-rejected-not-thrown for a source that throws its denial", async () => {
    const keys = await apiKeyAuth();
    const real = apiKeyPrincipal();
    const throwing: PrincipalSource = {
      ...(real as unknown as PrincipalSource),
      async resolve(request) {
        const result = await real.resolve(request);
        if (result.outcome === "rejected") {
          throw new APIError("UNAUTHORIZED", { code: "INVALID_API_KEY" });
        }
        return result as never;
      },
    };
    const cases = principalSourceConformance({
      source: throwing,
      auth: keys.auth,
      credentials: {
        valid: async () => new Headers({ "x-api-key": await keys.key() }),
        invalid: () => new Headers({ "x-api-key": "conformance-unknown" }),
      },
    });
    await expect(
      caseById(cases, "S-rejected-not-thrown").run(),
    ).rejects.toThrow(/resolve threw for an invalid credential/);
  });

  it("fails S-cookie-forwarded for a source that drops the refresh cookie it forwards by hand", async () => {
    const auth = createConformanceAuth();
    const real = sessionPrincipal();
    const dropping: PrincipalSource = {
      ...(real as unknown as PrincipalSource),
      resolve: (request) =>
        real.resolve({
          ...request,
          cookies: request.cookies ? { append: () => true } : null,
        }) as never,
    };
    const cases = principalSourceConformance({
      source: dropping,
      auth,
      credentials: {
        valid: async () =>
          new Headers({ cookie: (await kitIdentity(auth)).cookie }),
        invalid: () =>
          new Headers({ cookie: "better-auth.session_token=invalid.value" }),
      },
    });
    await expect(caseById(cases, "S-cookie-forwarded").run()).rejects.toThrow(
      /the sink received 0/,
    );
  });

  it("fails S-infra-throws for sources that turn a storage outage into a 401", async () => {
    const keys = await apiKeyAuth();
    const naive: PrincipalSource = {
      id: "conformance:naive-api-key",
      kinds: ["api-key" as never],
      acceptance: "explicit",
      delegates: true,
      credentialHeaders: ["x-api-key"],
      appliesTo: (request) => request.headers.has("x-api-key"),
      async resolve(request) {
        const key = request.headers.get("x-api-key")!;
        const result = (await (
          request.auth.api as unknown as {
            verifyApiKey(input: { body: { key: string } }): Promise<{
              valid: boolean;
              key: { userId: string } | null;
            }>;
          }
        ).verifyApiKey({ body: { key } })) as {
          valid: boolean;
          key: { userId: string } | null;
        };
        return result.valid
          ? authenticated({
              kind: "api-key",
              source: "conformance:naive-api-key",
              userId: result.key?.userId ?? null,
              delegation: { description: "naive", allows: () => false },
            } as never)
          : rejected(
              AuthFailures.rejected({ status: 401, reason: "INVALID_API_KEY" }),
            );
      },
    };
    const direct: PrincipalSource = {
      id: "conformance:direct-session-read",
      kinds: ["session"],
      acceptance: "default",
      credentialHeaders: ["x-session-token"],
      appliesTo: (request) => request.headers.has("x-session-token"),
      async resolve(request) {
        const context = (await request.auth.context()) as unknown as {
          internalAdapter: {
            findSession(
              token: string,
            ): Promise<{ user: { id: string } } | null>;
          };
        };
        try {
          const found = await context.internalAdapter.findSession(
            request.headers.get("x-session-token")!,
          );
          return found
            ? authenticated({
                kind: "session",
                source: "conformance:direct-session-read",
                userId: found.user.id,
                session: found,
              } as never)
            : rejected(AuthFailures.rejected({ status: 401 }));
        } catch {
          return rejected(AuthFailures.rejected({ status: 401 }));
        }
      },
    };
    const naiveCases = principalSourceConformance({
      source: naive,
      auth: keys.auth,
      credentials: {
        valid: async () => new Headers({ "x-api-key": await keys.key() }),
        invalid: () => new Headers({ "x-api-key": "conformance-unknown" }),
      },
    });
    await expect(caseById(naiveCases, "S-infra-throws").run()).rejects.toThrow(
      /a storage outage resolved/,
    );
    const directCases = principalSourceConformance({
      source: direct,
      auth: keys.auth,
      credentials: {
        valid: async () =>
          new Headers({
            "x-session-token": (await kitIdentity(keys.auth)).token,
          }),
        invalid: () => new Headers({ "x-session-token": "unknown" }),
      },
    });
    await expect(caseById(directCases, "S-infra-throws").run()).rejects.toThrow(
      /a storage outage resolved/,
    );
  });

  it("rejects an instance without session.updateAge 0", async () => {
    const auth = createConformanceAuth();
    const context = (await auth.$context) as {
      options: { session: { updateAge?: number } };
    };
    context.options.session.updateAge = 86_400;
    const cases = principalSourceConformance({
      source: sessionPrincipal(),
      auth,
      credentials: {
        valid: async () =>
          new Headers({ cookie: (await kitIdentity(auth)).cookie }),
        invalid: () => new Headers(),
      },
    });
    await expect(caseById(cases, "S-cookie-forwarded").run()).rejects.toThrow(
      expect.objectContaining({ code: "CONFORMANCE_SESSION_REFRESH" }),
    );
  });

  it("fails S-dynamic-base-url, instead of skipping it, for a variant() without session.updateAge 0", async () => {
    const { auth, ...credentials } = sessionCredentials(
      createConformanceAuth(),
    );
    const cases = principalSourceConformance({
      source: sessionPrincipal(),
      auth,
      credentials,
      variant: (overrides) => {
        const variant = createConformanceAuth(overrides);
        void (
          variant.$context as Promise<{
            options: { session: { updateAge?: number } };
          }>
        ).then((context) => {
          context.options.session.updateAge = 86_400;
        });
        return variant;
      },
    });
    for (const item of cases.filter(
      (value) => value.id === "S-dynamic-base-url",
    )) {
      await expect(item.run()).rejects.toThrow(
        expect.objectContaining({ code: "CONFORMANCE_SESSION_REFRESH" }),
      );
    }
  });
});

function sessionPrincipalOf(user: {
  id: string;
  createdAt?: Date;
}): AuthPrincipal {
  return {
    kind: "session",
    source: "better-auth:session",
    userId: user.id,
    session: {
      user: { id: user.id },
      session: { id: "conformance", createdAt: user.createdAt ?? new Date() },
    },
  } as unknown as AuthPrincipal;
}

function keyPrincipal(
  userId: string,
  permissions: Record<string, string[]>,
): AuthPrincipal {
  const grant = role(permissions);
  return {
    kind: "api-key",
    source: "better-auth:api-key",
    keyId: "conformance-key",
    configId: null,
    referenceId: userId,
    userId,
    organizationId: null,
    permissions,
    delegation: {
      description: "api-key permissions",
      allows: (requested: Record<string, string[]>) =>
        grant.authorize(requested).success,
    },
  } as unknown as AuthPrincipal;
}

async function adminFixture() {
  const auth = createConformanceAuth({
    session: { cookieCache: { enabled: true } },
    plugins: [admin(), apiKey({ enableSessionForAPIKeys: true })],
  });
  const administrator = await kitIdentity(auth, { role: "admin" });
  const member = await kitIdentity(auth, { role: "user" });
  return { auth, administrator, member };
}

describe("policy kit on the built-in admin permission policy", async () => {
  const fixture = await adminFixture();
  runConformance(
    policyConformance({
      requirement: permission(
        { user: ["ban"] },
        { principals: ["session", "api-key" as never] },
      ),
      auth: fixture.auth,
      allowingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.administrator.userId }),
      denyingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.member.userId }),
      delegatedPrincipal: async () =>
        keyPrincipal(fixture.administrator.userId, { user: ["ban"] }),
    }),
    { describe, it },
  );
});

describe("policy kit on the session-only admin permission", async () => {
  const fixture = await adminFixture();
  runConformance(
    policyConformance({
      requirement: permission({ user: ["list"] }),
      auth: fixture.auth,
      allowingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.administrator.userId }),
      denyingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.member.userId }),
      delegatedPrincipal: async () =>
        keyPrincipal(fixture.administrator.userId, { user: ["list"] }),
    }),
    { describe, it },
  );
});

async function organizationFixture(plugins: BetterAuthPlugin[] = []) {
  const auth = createConformanceAuth({
    session: { cookieCache: { enabled: true } },
    plugins: [organization(), ...plugins],
  });
  const owner = await kitIdentity(auth);
  const outsider = await kitIdentity(auth);
  const created = await (
    auth.api as unknown as {
      createOrganization(input: {
        headers: Headers;
        body: { name: string; slug: string };
      }): Promise<{ id: string }>;
    }
  ).createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { name: "Conformance", slug: `conformance-${crypto.randomUUID()}` },
  });
  const ref = organizationRef(() => created.id);
  return { auth, owner, outsider, ref };
}

describe("policy kit on the built-in organization policies", async () => {
  const { auth, owner, outsider, ref } = await organizationFixture([
    apiKey({ enableSessionForAPIKeys: true }),
  ]);
  for (const [name, requirement] of [
    [
      "permission",
      orgPermission({ organization: ["update"] }, { organization: ref }),
    ],
    ["member", orgMember({ organization: ref })],
  ] as const) {
    describe(name, () => {
      runConformance(
        policyConformance({
          requirement,
          auth,
          allowingPrincipal: async () =>
            sessionPrincipalOf({ id: owner.userId }),
          denyingPrincipal: async () =>
            sessionPrincipalOf({ id: outsider.userId }),
        }),
        { describe, it },
      );
    });
  }
});

describe("policy kit on the organization permission policy with customSession", async () => {
  const { auth, owner, outsider, ref } = await organizationFixture([
    customSession(async ({ user, session }) => ({ user, session })),
  ]);
  runConformance(
    policyConformance({
      requirement: orgPermission(
        { organization: ["update"] },
        { organization: ref },
      ),
      auth,
      allowingPrincipal: async () => sessionPrincipalOf({ id: owner.userId }),
      denyingPrincipal: async () => sessionPrincipalOf({ id: outsider.userId }),
    }),
    { describe, it },
  );
});

describe("policy kit on the built-in API-key permission policy", async () => {
  const keys = await apiKeyAuth();
  runConformance(
    policyConformance({
      requirement: apiKeyPermission({ project: ["read"] }),
      auth: keys.auth,
      allowingPrincipal: async () =>
        keyPrincipal(keys.owner, { project: ["read"] }),
      denyingPrincipal: async () =>
        keyPrincipal(keys.owner, { project: ["write"] }),
      delegatedPrincipal: async () =>
        keyPrincipal(keys.owner, { project: ["read"] }),
      sources: [apiKeyPrincipal()],
    }),
    { describe, it },
  );
});

describe("policy kit on the built-in fresh-session policy", () => {
  const auth = createConformanceAuth();
  runConformance(
    policyConformance({
      requirement: freshSession({ maxAgeSeconds: 60 }),
      auth,
      allowingPrincipal: async () =>
        sessionPrincipalOf({ id: (await kitIdentity(auth)).userId }),
      denyingPrincipal: async () =>
        sessionPrincipalOf({
          id: (await kitIdentity(auth)).userId,
          createdAt: new Date(Date.now() - 3_600_000),
        }),
    }),
    { describe, it },
  );
});

describe("policy kit mutations", () => {
  it("fails Z-delegation-scope for a policy that widens delegated principals", async () => {
    const fixture = await adminFixture();
    const widening: AuthorizationPolicy<
      Parameters<typeof adminPermissionPolicy.evaluate>[0],
      AuthPrincipal
    > = {
      ...adminPermissionPolicy,
      id: "conformance:widening-admin",
      evaluate: (params, context) =>
        adminPermissionPolicy.evaluate(params, {
          ...context,
          principal: { ...context.principal, delegation: undefined },
        } as never),
    };
    const cases = policyConformance({
      requirement: {
        policy: widening,
        params: { permissions: { user: ["ban"] } },
        principals: ["session", "api-key"],
      },
      auth: fixture.auth,
      allowingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.administrator.userId }),
      denyingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.member.userId }),
      delegatedPrincipal: async () =>
        keyPrincipal(fixture.administrator.userId, { user: ["ban"] }),
    });
    await expect(caseById(cases, "Z-delegation-scope").run()).rejects.toThrow(
      /widened a delegated principal/,
    );
  });

  it("rejects a requirement whose policy is a class reference", async () => {
    const fixture = await adminFixture();
    class ClassPolicy {
      readonly id = "conformance:class-policy";

      evaluate() {
        return allow();
      }
    }
    expect(() =>
      policyConformance({
        requirement: { policy: ClassPolicy as never, params: {} },
        auth: fixture.auth,
        allowingPrincipal: async () =>
          sessionPrincipalOf({ id: fixture.administrator.userId }),
        denyingPrincipal: async () =>
          sessionPrincipalOf({ id: fixture.member.userId }),
      }),
    ).toThrow(
      expect.objectContaining({ code: "CONFORMANCE_POLICY_OBJECT_REQUIRED" }),
    );
  });

  type AdminPolicy = typeof adminPermissionPolicy;

  /** The admin kit's options with the given stand-in for the built-in admin policy (same id, so the admin rows run). */
  async function adminCases(policy: AdminPolicy) {
    const fixture = await adminFixture();
    return policyConformance({
      requirement: {
        policy,
        params: { permissions: { user: ["ban"] } },
        principals: ["session", "api-key" as never],
      },
      auth: fixture.auth,
      allowingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.administrator.userId }),
      denyingPrincipal: async () =>
        sessionPrincipalOf({ id: fixture.member.userId }),
      delegatedPrincipal: async () =>
        keyPrincipal(fixture.administrator.userId, { user: ["ban"] }),
    });
  }

  function adminVariant(
    requires: Partial<NonNullable<AdminPolicy["requires"]>>,
    evaluate: AdminPolicy["evaluate"] = adminPermissionPolicy.evaluate,
  ): AdminPolicy {
    return {
      ...adminPermissionPolicy,
      requires: { ...adminPermissionPolicy.requires, ...requires },
      evaluate,
    };
  }

  interface AdminCall {
    userHasPermission(input: {
      body: { userId?: string; role?: string; permissions: object };
    }): Promise<{ success: boolean }>;
  }

  it("fails Z-admin-rejects-api-key for an admin policy that admits API keys by default", async () => {
    const cases = await adminCases(
      adminVariant({ principals: ["session", "api-key" as never] }),
    );
    await expect(
      caseById(cases, "Z-admin-rejects-api-key").run(),
    ).rejects.toThrow(/"effect":"allow"/);
  });

  it("fails Z-admin-rejects-api-key-session and Z-admin-banned for an admin policy without fresh identity", async () => {
    const cases = await adminCases(adminVariant({ freshIdentity: false }));
    await expect(
      caseById(cases, "Z-admin-rejects-api-key-session").run(),
    ).rejects.toThrow(/x-api-key alone on @RequirePermission.*: allowed/);
    await expect(caseById(cases, "Z-admin-banned").run()).rejects.toThrow(
      /banned: the warm cookie cache still admitted the admin: allowed/,
    );
  });

  it("fails Z-admin-banned for an admin policy that ignores a key owner's ban", async () => {
    const cases = await adminCases(
      adminVariant({}, async ({ permissions }, context) => {
        const result = await (
          context.auth.api as unknown as AdminCall
        ).userHasPermission({
          body: { userId: context.principal.userId!, permissions },
        });
        return result.success &&
          (!context.principal.delegation ||
            context.principal.delegation.allows(permissions))
          ? { effect: "allow" }
          : { effect: "deny", reason: "MISSING_PERMISSION" };
      }),
    );
    await expect(caseById(cases, "Z-admin-banned").run()).rejects.toThrow(
      /a banned owner's key was not denied USER_BANNED/,
    );
  });

  it("fails Z-admin-custom-session-role for an admin policy that reads the session's role", async () => {
    const cases = await adminCases(
      adminVariant({}, async ({ permissions }, context) => {
        const role = (
          context.principal as { session?: { user?: { role?: unknown } } }
        ).session?.user?.role;
        const result = await (
          context.auth.api as unknown as AdminCall
        ).userHasPermission({
          body: {
            role: Array.isArray(role) ? role.join(",") : String(role),
            permissions,
          },
        });
        return result.success
          ? { effect: "allow" }
          : { effect: "deny", reason: "MISSING_PERMISSION" };
      }),
    );
    await expect(
      caseById(cases, "Z-admin-custom-session-role").run(),
    ).rejects.toThrow(/listUsers/);
  });

  it("fails Z-admin-deleted-user and Z-admin-null-role for an admin policy that trusts the stored user", async () => {
    const cases = await adminCases(
      adminVariant({}, async ({ permissions }, context) => {
        const owner = await (
          await context.auth.context()
        ).internalAdapter.findUserById(context.principal.userId!);
        const roles = (owner as { role: string }).role.split(",");
        const result = await (
          context.auth.api as unknown as AdminCall
        ).userHasPermission({
          body: { role: roles.join(","), permissions },
        });
        return result.success
          ? { effect: "allow" }
          : { effect: "deny", reason: "MISSING_PERMISSION" };
      }),
    );
    await expect(caseById(cases, "Z-admin-deleted-user").run()).rejects.toThrow(
      /a key whose owner was deleted/,
    );
    await expect(caseById(cases, "Z-admin-null-role").run()).rejects.toThrow(
      /the policy threw|a NULL role/,
    );
  });

  it("fails Z-admin-dynamic-base-url for an admin policy that does not declare hostless calls", async () => {
    const cases = await adminCases(adminVariant({ hostlessCalls: false }));
    await expect(
      caseById(cases, "Z-admin-dynamic-base-url").run(),
    ).rejects.toThrow(/a dynamic baseURL without fallback booted/);
  });

  it("fails Z-singleton when boot validation accepts request-scoped policies", async () => {
    const spy = vi
      .spyOn(
        BootValidator.prototype as unknown as {
          singletonChecks(...args: unknown[]): void;
        },
        "singletonChecks",
      )
      .mockImplementation(() => undefined);
    try {
      const cases = await adminCases(adminPermissionPolicy);
      await expect(caseById(cases, "Z-singleton").run()).rejects.toThrow(
        /boot did not report NON_SINGLETON_EXTENSION/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("fails Z-class-policy-requires when route planning ignores a class policy's requires field", async () => {
    const resolve = PolicyResolver.prototype.resolve;
    const spy = vi
      .spyOn(PolicyResolver.prototype, "resolve")
      .mockImplementation(function (this: PolicyResolver, reference) {
        const policy = resolve.call(this, reference);
        return policy.id.includes("conformance/class-")
          ? { ...policy, requires: undefined }
          : policy;
      });
    try {
      const cases = await adminCases(adminPermissionPolicy);
      await expect(
        caseById(cases, "Z-class-policy-requires").run(),
      ).rejects.toThrow(/an API key was not admitted/);
    } finally {
      spy.mockRestore();
    }
  });

  async function organizationCases(policy: typeof orgPermissionPolicy) {
    const { auth, owner, outsider, ref } = await organizationFixture([
      apiKey({ enableSessionForAPIKeys: true }),
    ]);
    return policyConformance({
      requirement: {
        policy,
        params: {
          permissions: { organization: ["update"] },
          organization: ref,
        },
      },
      auth,
      allowingPrincipal: async () => sessionPrincipalOf({ id: owner.userId }),
      denyingPrincipal: async () => sessionPrincipalOf({ id: outsider.userId }),
    });
  }

  it("fails Z-policy-session-lost and both Z-infra-throws variants for a policy that turns errors into denials", async () => {
    const cases = await organizationCases({
      ...orgPermissionPolicy,
      async evaluate(params, context) {
        try {
          return await orgPermissionPolicy.evaluate(params, context);
        } catch {
          return { effect: "deny", reason: "MISSING_PERMISSION" };
        }
      },
    });
    await expect(
      caseById(cases, "Z-policy-session-lost").run(),
    ).rejects.toThrow(/must deny 401 UNAUTHENTICATED/);
    const infra = cases.filter((item) => item.id === "Z-infra-throws");
    expect(infra.map((item) => item.title)).toEqual([
      expect.stringContaining("cookie cache off"),
      expect.stringContaining("warm cookie cache"),
    ]);
    for (const item of infra) {
      await expect(item.run()).rejects.toThrow(/a storage outage was decided/);
    }
  });

  it("fails Z-org-ref-types for an organization policy that coerces inputs to strings", async () => {
    const cases = await organizationCases({
      ...orgPermissionPolicy,
      evaluate: (params, context) =>
        orgPermissionPolicy.evaluate(
          {
            ...params,
            organization: organizationRef(async (inner) => {
              const value = await params.organization(inner);
              return typeof value === "string" ? value : JSON.stringify(value);
            }),
          },
          context,
        ),
    });
    await expect(caseById(cases, "Z-org-ref-types").run()).rejects.toThrow(
      /orgId \{"\$ne":null\}/,
    );
  });

  it("fails Z-apikey-quota-per-request for an organization policy that repeats its Better Auth call", async () => {
    const evaluate = orgMemberPolicy.evaluate;
    const spy = vi
      .spyOn(orgMemberPolicy, "evaluate")
      .mockImplementation(async (params, context) => {
        const uncached = {
          ...context,
          memo: <T>(_key: unknown, fn: () => Promise<T>) => fn(),
        };
        await evaluate(params, uncached);
        return evaluate(params, uncached);
      });
    try {
      const cases = await organizationCases(orgPermissionPolicy);
      await expect(
        caseById(cases, "Z-apikey-quota-per-request").run(),
      ).rejects.toThrow(/must spend 3/);
    } finally {
      spy.mockRestore();
    }
  });
});
