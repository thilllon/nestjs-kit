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
import { ExternalContextCreator, MetadataScanner } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { APIError } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { role } from "better-auth/plugins/access";
import { describe, expect, it } from "vitest";
import { adminPermissionPolicy, permission } from "./admin.js";
import { apiKeyPermission, apiKeyPrincipal } from "./api-key.js";
import type {
  AuthorizationPolicy,
  AuthTransport,
  ConformanceCase,
  PrincipalSource,
  TransportCall,
  TransportValidationContext,
} from "./auth-contracts.js";
import type { AuthFailure } from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthService } from "./auth-service.js";
import type { AuthLike, AuthPrincipal } from "./auth-types.js";
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
import { orgMember, organizationRef, orgPermission } from "./organization.js";
import { freshSession, sessionPrincipal } from "./session-principal.js";

const REFERENCE = "nestjs-slightly-better-auth:reference";
const REFERENCE_HANDLERS = Symbol("reference-handlers");

interface ReferenceOperation {
  readonly headers: Headers;
  readonly setCookies: string[];
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
 * invocations, like aliased fields. `sharedInvocation` reproduces the defect of reusing the operation as the invocation.
 */
class ReferenceTransport implements AuthTransport {
  readonly id = "reference";

  constructor(private readonly sharedInvocation = false) {}

  handles(context: ExecutionContext): boolean {
    return context.getType<string>() === REFERENCE;
  }

  describe(context: ExecutionContext): TransportCall {
    const [message, operation] = context.getArgs() as [
      ReferenceMessage,
      ReferenceOperation,
    ];
    const url = "http://localhost:3000/reference";
    return {
      key: operation,
      invocation: this.sharedInvocation ? operation : message,
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
        return {
          enforce: message.operation === "unsafe",
          headers: () => new Headers(operation.headers),
          url,
          key: operation,
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

function handlerClass(fixtures: TransportFixtures) {
  @Injectable()
  class ReferenceHandlers {
    static readonly [REFERENCE_HANDLERS] = true;

    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  for (const [name, fixture] of flatten(fixtures)) {
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
  { handlers: object; creator: ExternalContextCreator }
>();

function referenceHarness(
  transport: ReferenceTransport,
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
      const Handlers = handlerClass(fixtures);
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            globalGuard: options.globalGuard,
            principals: options.principals,
            ...(options.defaultRequirements
              ? { defaultRequirements: options.defaultRequirements }
              : {}),
            transports: [transport],
            http: { mount: false },
            logSummary: false,
          } as never),
        ],
        providers: [Handlers],
      })
      class ReferenceModule {}
      let builder = Test.createTestingModule({ imports: [ReferenceModule] });
      if (options.override) {
        builder = options.override(builder);
      }
      const moduleRef = await builder.compile();
      moduleRef.useLogger(false);
      try {
        await moduleRef.init();
      } catch (error) {
        await moduleRef.close();
        throw error;
      }
      dispatchers.set(moduleRef, {
        handlers: moduleRef.get(Handlers),
        creator: moduleRef.get(ExternalContextCreator),
      });
      return moduleRef as unknown as INestApplication;
    },
    async invoke(app, handler, headers, input = {}) {
      const operation: ReferenceOperation = {
        headers: new Headers(headers),
        setCookies: [],
      };
      const results = await Promise.all(
        names(handler).map((name) =>
          settle(
            call(
              app,
              name,
              {
                input,
                operation:
                  name === "unsafe" ||
                  name.startsWith("login") ||
                  name === "publicService"
                    ? "unsafe"
                    : "read",
              },
              operation,
            ),
          ),
        ),
      );
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
      };
      const [first, second] = await Promise.all(
        inputs.map((input) =>
          settle(call(app, "org", { input, operation: "read" }, operation)),
        ),
      );
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
      referenceHarness(new ReferenceTransport(true)),
    );
    await expect(
      caseById(cases, "T-invocation-decisions").run(),
    ).rejects.toThrow(/was not decided independently/);
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

describe("principal source kit on the built-in session source", () => {
  const auth = createConformanceAuth();
  runConformance(
    principalSourceConformance({
      source: sessionPrincipal(),
      auth,
      credentials: {
        valid: async () =>
          new Headers({ cookie: (await kitIdentity(auth)).cookie }),
        invalid: () =>
          new Headers({ cookie: "better-auth.session_token=invalid.value" }),
      },
    }),
    { describe, it },
  );
});

describe("principal source kit on the built-in API-key source", async () => {
  const keys = await apiKeyAuth();
  runConformance(
    principalSourceConformance({
      source: apiKeyPrincipal(),
      auth: keys.auth,
      credentials: {
        valid: async () => new Headers({ "x-api-key": await keys.key() }),
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
  const auth = createConformanceAuth({ plugins: [admin(), apiKey()] });
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

describe("policy kit on the built-in organization policies", async () => {
  const auth = createConformanceAuth({ plugins: [organization()] });
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
});
