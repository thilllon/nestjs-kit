import { apiKey } from "@better-auth/api-key";
import {
  createParamDecorator,
  Inject,
  Injectable,
  Module,
  SetMetadata,
  type ExecutionContext,
  type INestApplication,
  type Type,
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
  ExtensionRef,
  PrincipalSource,
  RoutePlan,
  TransportCall,
  TransportValidationContext,
} from "./auth-contracts.js";
import {
  type AuthFailure,
  AuthFailures,
  BetterAuthConfigurationError,
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
import { ROUTE_PLANNER } from "./auth-tokens.js";
import { orgMember, organizationRef, orgPermission } from "./organization.js";
import { authenticated, rejected } from "./principal-resolver.js";
import type { RoutePlanner } from "./route-planner.js";
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

/** The class (REFERENCE_HANDLERS) and handler (REFERENCE_HANDLER) markers the reference transport claims by. */
const REFERENCE_HANDLER = "nestjs-slightly-better-auth:reference-handler";

/**
 * An in-process transport with a custom context type: one operation (the logical request) carries one or more
 * invocations, like aliased fields. `sharedInvocation` reproduces the defect of reusing the operation as the invocation;
 * `readsWithoutBrowserLeg` the defect of describing no browser leg for safe operations. `connectionLeg` describes the
 * operation's connection as its browser leg, like a WebSocket handshake. `failsClosedWhenComplete` rejects reading the
 * browser leg of a completed operation, as the GraphQL transports reject a completed request. `handlesEveryContext`
 * claims contexts of every type; `noCanary` skips the metadata canary; `claimsClasses` also claims each handler class;
 * `dropsHost` extracts credentials without the Host header while declaring no hostless calls.
 */
class ReferenceTransport implements AuthTransport {
  readonly id = "reference";

  constructor(
    private readonly defects: {
      sharedInvocation?: boolean;
      readsWithoutBrowserLeg?: boolean;
      connectionLeg?: boolean;
      failsClosedWhenComplete?: boolean;
      handlesEveryContext?: boolean;
      noCanary?: boolean;
      claimsClasses?: boolean;
      dropsHost?: boolean;
    } = {},
  ) {}

  handles(context: ExecutionContext): boolean {
    return (
      this.defects.handlesEveryContext === true ||
      context.getType<string>() === REFERENCE
    );
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
    const dropsHost = this.defects.dropsHost;
    return {
      key: operation,
      invocation: this.defects.sharedInvocation ? operation : message,
      headers: () => {
        const headers = new Headers(operation.headers);
        if (dropsHost) {
          headers.delete("host");
        }
        return headers;
      },
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
    if (!this.defects.noCanary) {
      class Probe {
        handler(): void {}
      }
      SetMetadata(REFERENCE_HANDLER, true)(
        Probe.prototype,
        "handler",
        Object.getOwnPropertyDescriptor(Probe.prototype, "handler")!,
      );
      if (
        Reflect.getMetadata(REFERENCE_HANDLER, Probe.prototype.handler) !== true
      ) {
        throw new BetterAuthConfigurationError(
          "NEST_METADATA_KEY_CHANGED",
          "Reference handler metadata failed its canary",
        );
      }
    }
    const scanner = new MetadataScanner();
    for (const wrapper of context.discovery.getProviders()) {
      const target = wrapper.metatype as
        | (abstract new (
            ...args: never[]
          ) => unknown)
        | undefined;
      if (
        !target?.prototype ||
        !Reflect.getMetadata(REFERENCE_HANDLERS, target)
      ) {
        continue;
      }
      if (this.defects.claimsClasses) {
        context.claim(target, undefined, "global", {
          code: "REFERENCE_UNGUARDED",
          hint: "Register the global guard or add @UseBetterAuth().",
        });
      }
      for (const method of scanner.getAllMethodNames(target.prototype)) {
        if (
          Reflect.getMetadata(REFERENCE_HANDLER, target.prototype[method]) !==
          true
        ) {
          continue;
        }
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
  @SetMetadata(REFERENCE_HANDLERS, true)
  class ReferenceHandlers {
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
    for (const decorator of [
      SetMetadata(REFERENCE_HANDLER, true),
      ...fixture.decorators,
    ].reverse()) {
      decorator(ReferenceHandlers.prototype, name, descriptor);
    }
  }
  return ReferenceHandlers;
}

/** The `inherited` fixture as one method of an abstract base class, served by two subclasses (T-inherited-handler). */
function inheritedClasses(fixtures: TransportFixtures) {
  const fixture = fixtures.inherited;
  @SetMetadata(REFERENCE_HANDLERS, true)
  abstract class InheritedBase {
    inherited(...args: unknown[]): unknown {
      return fixture.handle([], (args[0] ?? {}) as Record<string, unknown>, {
        service: undefined as never,
      });
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    InheritedBase.prototype,
    "inherited",
  )!;
  Input()(InheritedBase.prototype, "inherited", 0);
  for (const decorator of [
    SetMetadata(REFERENCE_HANDLER, true),
    ...fixture.decorators,
  ].reverse()) {
    decorator(InheritedBase.prototype, "inherited", descriptor);
  }
  @Injectable()
  class PublicInherited extends InheritedBase {}
  @Injectable()
  class DeniedInherited extends InheritedBase {}
  for (const decorator of fixture.subclasses.public) {
    decorator(PublicInherited);
  }
  for (const decorator of fixture.subclasses.denied) {
    decorator(DeniedInherited);
  }
  return { public: PublicInherited, denied: DeniedInherited };
}

const dispatchers = new WeakMap<
  object,
  {
    handlers: object;
    inherited: { public: object; denied: object };
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
    target?: "public" | "denied",
  ) => {
    const dispatcher = dispatchers.get(app)!;
    const { creator } = dispatcher;
    const handlers = target
      ? dispatcher.inherited[target]
      : dispatcher.handlers;
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
      const inherited = inheritedClasses(fixtures);
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
        providers: [
          Handlers,
          inherited.public,
          inherited.denied,
          ...(options.appEnhancers ? appEnhancers : []),
        ],
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
        inherited: {
          public: moduleRef.get(inherited.public),
          denied: moduleRef.get(inherited.denied),
        },
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
    async invokeInherited(app, subclass, headers) {
      const operation: ReferenceOperation = {
        headers: new Headers(headers),
        setCookies: [],
        connection: {},
        completed: false,
      };
      const result = await settle(
        call(
          app,
          "inherited",
          { input: {}, operation: "read" },
          operation,
          subclass,
        ),
      );
      operation.completed = true;
      return { ...result, setCookies: operation.setCookies };
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

/** A harness whose apps plan requests through `change`, a faulty planner, from the first request on. */
function withPlans(
  harness: TransportConformanceOptions,
  change: (plan: RoutePlan, target: Type, method: string) => RoutePlan,
): TransportConformanceOptions {
  return {
    ...harness,
    async createApp(fixtures, auth, options) {
      const app = await harness.createApp(fixtures, auth, options);
      const planner = app.get<RoutePlanner>(ROUTE_PLANNER, { strict: false });
      const plan = planner.plan.bind(planner);
      planner.plan = (target, method) =>
        change(plan(target, method), target, method);
      return app;
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

  it("fails T-public-unclaimed-context for a transport that claims contexts of every type", async () => {
    await expect(
      caseById(
        transportConformance(
          referenceHarness(
            new ReferenceTransport({ handlesEveryContext: true }),
          ),
        ),
        "T-public-unclaimed-context",
      ).run(),
    ).rejects.toThrow(/expected NO_TRANSPORT/);
  });

  it("fails T-metadata-canary for a transport without a canary and for one that claims classes", async () => {
    await expect(
      caseById(
        transportConformance(
          referenceHarness(new ReferenceTransport({ noCanary: true })),
        ),
        "T-metadata-canary",
      ).run(),
    ).rejects.toThrow(/the transport runs no metadata canary/);
    await expect(
      caseById(
        transportConformance(
          referenceHarness(new ReferenceTransport({ claimsClasses: true })),
        ),
        "T-metadata-canary",
      ).run(),
    ).rejects.toThrow(/claimed a class without handlers/);
  });

  it("fails T-dynamic-base-url for a transport that drops the Host header without declaring hostless calls", async () => {
    await expect(
      caseById(
        transportConformance(
          referenceHarness(new ReferenceTransport({ dropsHost: true })),
        ),
        "T-dynamic-base-url",
      ).run(),
    ).rejects.toThrow(/a session credential \(cookie\): expected success/);
  });

  it("fails T-inherited-handler for a planner that caches plans by handler function", async () => {
    const byHandler = new Map<unknown, RoutePlan>();
    await expect(
      caseById(
        transportConformance(
          withPlans(
            referenceHarness(new ReferenceTransport()),
            (plan, target, method) => {
              const handler = Reflect.get(target.prototype, method);
              if (!byHandler.has(handler)) {
                byHandler.set(handler, plan);
              }
              return byHandler.get(handler)!;
            },
          ),
        ),
        "T-inherited-handler",
      ).run(),
    ).rejects.toThrow(
      /public first, then denied, round 1: the denied subclass: expected a 403 denial/,
    );
  });

  it("fails the T-csrf-http-unsafe opt-out rows for a planner that ignores @SkipOriginCheck()", async () => {
    await expect(
      caseById(
        transportConformance(
          withPlans(referenceHarness(new ReferenceTransport()), (plan) =>
            plan.originCheck === "off"
              ? { ...plan, originCheck: "cookie" }
              : plan,
          ),
        ),
        "T-csrf-http-unsafe",
      ).run(),
    ).rejects.toThrow(
      /@SkipOriginCheck\(\): a cookie from an untrusted Origin: expected success/,
    );
  });

  it("fails the direct caller-session rows of T-csrf-safe-methods when safe operations skip the origin check", async () => {
    await expect(
      caseById(
        transportConformance(
          withPlans(referenceHarness(new ReferenceTransport()), (plan) =>
            plan.originCheck === "cookie"
              ? { ...plan, originCheck: "off" }
              : plan,
          ),
        ),
        "T-csrf-safe-methods",
      ).run(),
    ).rejects.toThrow(
      /direct caller-session call from an untrusted Origin: expected a generic internal error/,
    );
  });

  it("fails T-carrier when invocations of one request share their invocation object", async () => {
    await expect(
      caseById(
        transportConformance(
          referenceHarness(new ReferenceTransport({ sharedInvocation: true })),
        ),
        "T-carrier",
      ).run(),
    ).rejects.toThrow(/with the scope interceptor, aliases/);
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
            Reflect.getMetadata(REFERENCE_HANDLERS, target) &&
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
      // One source per case: the source shares one outage probe per second (S-apikey-outage), so an earlier case's
      // healthy probe would otherwise answer S-infra-throws.
      source: defineExtension({ use: { useFactory: () => apiKeyPrincipal() } }),
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
});
