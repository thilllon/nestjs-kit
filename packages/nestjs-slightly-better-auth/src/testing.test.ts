import {
  type CanActivate,
  Controller,
  Get,
  type ExecutionContext,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthHandle,
  AuthorizationContext,
  AuthorizationPolicy,
  PolicyInvoker,
  PrincipalResolver,
  TransportCall,
} from "./auth-contracts.js";
import { Require, requirement } from "./auth-decorators.js";
import { BetterAuthModule } from "./auth-module.js";
import {
  GUARD_CORE,
  getBetterAuthHandleToken,
  POLICY_INVOKER,
  PRINCIPAL_RESOLVER,
} from "./auth-tokens.js";
import type { AuthPrincipal } from "./auth-types.js";
import { allow, deny } from "./authorization-evaluator.js";
import { BRIDGE_HANDLE, type BridgeHandle } from "./bridge-protocol.js";
import {
  CapturingLogger,
  createConformanceAuth,
  kitIdentity,
  probeOf,
} from "./conformance-fixtures.js";
import { expressPlatform } from "./express.js";
import { fastifyPlatform } from "./fastify.js";
import { nestjs } from "./plugin.js";
import { PrincipalReadings } from "./principal-readings.js";
import { RequestScope } from "./request-scope.js";
import {
  authHeadersFor,
  initTestApp,
  overrideAuthGuard,
  overrideDecisions,
  overridePrincipal,
  stampPrincipal,
  testPrincipal,
} from "./testing.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) {
    await close().catch(() => undefined);
  }
});

function principal(userId: string, extra: object = {}): AuthPrincipal {
  return {
    kind: "session",
    source: "better-auth:session",
    userId,
    session: { user: { id: userId }, session: { id: `s-${userId}` } },
    ...extra,
  } as unknown as AuthPrincipal;
}

function context(args: unknown[]): ExecutionContext {
  return { getArgs: () => args } as unknown as ExecutionContext;
}

function call(): TransportCall {
  const key = {};
  return {
    key,
    invocation: key,
    headers: () => new Headers(),
    clientIp: null,
    cookies: null,
    param: () => undefined,
  };
}

async function compiled(builder: ReturnType<typeof Test.createTestingModule>) {
  const moduleRef = await builder.compile();
  moduleRef.useLogger(false);
  await moduleRef.init();
  closes.push(() => moduleRef.close());
  return moduleRef;
}

async function bridgeOf(auth: {
  $context: Promise<unknown>;
}): Promise<BridgeHandle> {
  const context = (await auth.$context) as { getPlugin(id: string): object };
  return Reflect.get(
    context.getPlugin("nestjs-slightly-better-auth"),
    BRIDGE_HANDLE,
  ) as BridgeHandle;
}

describe("stampPrincipal", () => {
  it("publishes a stamp only to invocations with the same argument elements", () => {
    const readings = new PrincipalReadings(new RequestScope());
    const request = { url: "/a" };
    const response = {};
    stampPrincipal(context([request, response]), principal("u1"));
    expect(readings.read({ args: [request, response] })).toEqual({
      outcome: "authenticated",
      principal: principal("u1"),
      instance: "default",
    });
    expect(() => readings.read({ args: [request, {}] })).toThrow(
      expect.objectContaining({ code: "NO_AUTH_RESULT" }),
    );
    expect(() => readings.read({ args: [{ url: "/a" }, response] })).toThrow(
      expect.objectContaining({ code: "NO_AUTH_RESULT" }),
    );
  });

  it("keeps stamps per instance and records absence as an absent reading", () => {
    const readings = new PrincipalReadings(new RequestScope());
    const args = [{}, {}];
    stampPrincipal(context(args), principal("admin-user"), {
      instance: "admin",
    });
    stampPrincipal(context(args), null);
    const plan = (instance: string) => ({
      access: "required" as const,
      instance,
      site: "Test.handler",
    });
    expect(readings.read({ args, plan: plan("admin") })).toMatchObject({
      outcome: "authenticated",
      instance: "admin",
    });
    expect(readings.read({ args, plan: plan("default") })).toEqual({
      outcome: "absent",
      instance: "default",
    });
  });
});

describe("stamp matching for shared connection objects", () => {
  it("never matches another invocation through a lone shared element", () => {
    const readings = new PrincipalReadings(new RequestScope());
    const socket = {};
    // A WS message with a primitive payload and no ack: [client, data, ack, pattern].
    const first = [socket, "ping", undefined, "whoami"];
    stampPrincipal(context(first), principal("alice"));
    expect(readings.read({ args: first })).toMatchObject({
      principal: { userId: "alice" },
    });
    const second = [socket, "ping", undefined, "whoami"];
    expect(() => readings.read({ args: second })).toThrow(
      expect.objectContaining({ code: "NO_AUTH_RESULT" }),
    );
    stampPrincipal(context(second), principal("bob"));
    expect(readings.read({ args: first })).toMatchObject({
      principal: { userId: "alice" },
    });
    expect(readings.read({ args: second })).toMatchObject({
      principal: { userId: "bob" },
    });
  });
});

describe("overrideAuthGuard", () => {
  it("runs a CanActivate that stores its own principal field", async () => {
    class DenyingGuard implements CanActivate {
      principal: AuthPrincipal | null = null;
      calls = 0;

      canActivate(): boolean {
        this.calls++;
        return this.principal !== null;
      }
    }
    const guard = new DenyingGuard();
    const builder = Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth: createConformanceAuth(),
          http: { mount: false },
          logSummary: false,
        } as never),
      ],
    });
    overrideAuthGuard(builder, guard);
    const moduleRef = await compiled(builder);
    const core = moduleRef.get<CanActivate>(GUARD_CORE);
    await expect(core.canActivate(context([{}, {}]))).resolves.toBe(false);
    expect(guard.calls).toBe(1);
  });
});

describe("testPrincipal", () => {
  it("resolves a fixed principal through the real resolver with its declared contract", async () => {
    const auth = createConformanceAuth();
    const delegated = principal("key-owner", {
      kind: "session",
      delegation: { description: "test grant", allows: () => false },
    });
    const moduleRef = await compiled(
      Test.createTestingModule({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            session: false,
            http: { mount: false },
            logSummary: false,
            principals: [testPrincipal(delegated)],
          } as never),
        ],
      }),
    );
    const resolver = moduleRef.get<PrincipalResolver>(PRINCIPAL_RESOLVER);
    const handle = moduleRef.get<AuthHandle>(getBetterAuthHandleToken());
    const result = await resolver.resolve(call(), {
      auth: handle,
      freshness: "default",
      accepts: new Set(["session"]),
      sourceSet: "test",
    });
    expect(result).toEqual({ outcome: "authenticated", principal: delegated });
  });

  it("derives a principal per request and answers absent for null", async () => {
    const source = testPrincipal(
      (request) =>
        request.headers.has("x-user")
          ? principal(request.headers.get("x-user")!)
          : null,
      { kinds: ["session"], acceptance: "explicit" },
    );
    expect(source).toMatchObject({
      kinds: ["session"],
      acceptance: "explicit",
      delegates: false,
    });
    const request = (headers: HeadersInit) =>
      ({ headers: new Headers(headers) }) as never;
    await expect(source.resolve(request({ "x-user": "u7" }))).resolves.toEqual({
      outcome: "authenticated",
      principal: { ...principal("u7"), source: source.id },
    });
    await expect(source.resolve(request({}))).resolves.toEqual({
      outcome: "absent",
    });
  });
});

describe("overridePrincipal", () => {
  it("answers the fixed principal per instance, absent for re-classification, and keeps other instances real", async () => {
    const auth = createConformanceAuth();
    const second = createConformanceAuth({
      advanced: { cookiePrefix: "second" },
    });
    const builder = Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          http: { mount: false },
          logSummary: false,
        } as never),
        BetterAuthModule.forRoot({
          name: "second",
          auth: second,
          http: { mount: false },
          logSummary: false,
        } as never),
      ],
    });
    const fixed = principal("fixed");
    overridePrincipal(builder, fixed);
    overridePrincipal(builder, (value) => principal(`call-${typeof value}`), {
      instance: "second",
    });
    const moduleRef = await compiled(builder);
    const resolver = moduleRef.get<PrincipalResolver>(PRINCIPAL_RESOLVER);
    const request = (name?: string, reclassify = false) => ({
      auth: moduleRef.get<AuthHandle>(getBetterAuthHandleToken(name)),
      freshness: "default" as const,
      accepts: new Set(["session"]),
      sourceSet: "0",
      ...(reclassify
        ? { reclassify: { sourceId: "better-auth:session" } }
        : {}),
    });
    await expect(resolver.resolve(call(), request())).resolves.toEqual({
      outcome: "authenticated",
      principal: fixed,
    });
    await expect(
      resolver.resolve(call(), request(undefined, true)),
    ).resolves.toEqual({ outcome: "absent" });
    await expect(resolver.resolve(call(), request("second"))).resolves.toEqual({
      outcome: "authenticated",
      principal: principal("call-object"),
    });
  });

  it("leaves instances it does not name on the real resolver", async () => {
    const auth = createConformanceAuth();
    const probe = await probeOf(auth);
    const identity = await kitIdentity(auth);
    const builder = Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          http: { mount: false },
          logSummary: false,
        } as never),
      ],
    });
    overridePrincipal(builder, principal("elsewhere"), { instance: "other" });
    const moduleRef = await compiled(builder);
    const resolver = moduleRef.get<PrincipalResolver>(PRINCIPAL_RESOLVER);
    const request = {
      ...call(),
      headers: () => new Headers({ cookie: identity.cookie }),
    };
    const result = await resolver.resolve(request, {
      auth: moduleRef.get<AuthHandle>(getBetterAuthHandleToken()),
      freshness: "default",
      accepts: new Set(["session"]),
      sourceSet: "0",
    });
    expect(result).toMatchObject({
      outcome: "authenticated",
      principal: { userId: identity.userId },
    });
    expect(probe.calls).toContain("/get-session");
  });
});

describe("overrideDecisions", () => {
  it("consults deciders in order and falls back to the real policy", async () => {
    const auth = createConformanceAuth();
    const builder = Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          http: { mount: false },
          logSummary: false,
        } as never),
      ],
    });
    const first = vi.fn((id: string) =>
      id === "first" ? deny({ reason: "FIRST" }) : undefined,
    );
    const second = vi.fn(async (id: string, params: unknown) =>
      id === "second" ? allow() : (params as { fallback?: undefined }).fallback,
    );
    overrideDecisions(builder, first);
    overrideDecisions(builder, second);
    const moduleRef = await compiled(builder);
    const invoker = moduleRef.get<PolicyInvoker>(POLICY_INVOKER);
    const evaluate = vi.fn(() => deny({ reason: "REAL" }));
    const policy = (id: string): AuthorizationPolicy<object> => ({
      id,
      evaluate,
    });
    const authorization = {
      principal: principal("u1"),
    } as unknown as AuthorizationContext;
    await expect(
      invoker.invoke(policy("first"), {}, authorization),
    ).resolves.toEqual(deny({ reason: "FIRST" }));
    expect(second).not.toHaveBeenCalled();
    await expect(
      invoker.invoke(policy("second"), {}, authorization),
    ).resolves.toEqual(allow());
    await expect(
      invoker.invoke(policy("real"), { fallback: undefined }, authorization),
    ).resolves.toEqual(deny({ reason: "REAL" }));
    expect(evaluate).toHaveBeenCalledOnce();
    expect(second).toHaveBeenLastCalledWith(
      "real",
      { fallback: undefined },
      principal("u1"),
    );
  });
});

describe("authHeadersFor", () => {
  it("creates real session headers through testUtils()", async () => {
    const auth = createConformanceAuth();
    const identity = await kitIdentity(auth);
    const headers = await authHeadersFor(auth, identity.userId);
    const session = await (
      auth.api as unknown as {
        getSession(input: { headers: Headers }): Promise<{
          user: { id: string };
        } | null>;
      }
    ).getSession({ headers });
    expect(session?.user.id).toBe(identity.userId);
  });

  it("rejects an instance without testUtils()", async () => {
    const auth = betterAuth({
      secret: crypto.randomUUID().repeat(2),
      baseURL: "http://localhost:3000",
      logger: { disabled: true },
      database: memoryAdapter({}),
      plugins: [nestjs()],
    });
    await expect(authHeadersFor(auth, "u1")).rejects.toMatchObject({
      code: "TEST_UTILS_MISSING",
    });
  });
});

describe("initTestApp", () => {
  async function appFor(
    auth: ReturnType<typeof createConformanceAuth>,
    platform: "express" | "fastify",
  ) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          platforms: [
            platform === "express" ? expressPlatform() : fastifyPlatform(),
          ],
          logSummary: false,
        } as never),
      ],
    }).compile();
    return moduleRef.createNestApplication(
      platform === "express" ? new ExpressAdapter() : new FastifyAdapter(),
      { logger: false },
    );
  }

  it("closes the previous bound test app of the same instance before initializing", async () => {
    const auth = createConformanceAuth();
    const bridge = await bridgeOf(auth);
    const registered: (() => Promise<void>)[] = [];
    const closeWith = (close: () => Promise<void>) => {
      registered.push(close);
      closes.push(close);
    };
    const first = await initTestApp(await appFor(auth, "express"), {
      closeWith,
    });
    expect(bridge.state).toBe("bound");
    const close = vi.spyOn(first, "close");
    const second = await appFor(auth, "express");
    await initTestApp(second, { closeWith });
    expect(close).toHaveBeenCalledOnce();
    expect(bridge.state).toBe("bound");
    expect(registered).toHaveLength(2);
    await second.close();
    expect(bridge.state).toBe("closed");
  });

  it("runs an app's shutdown once when a registered close follows the helper's close", async () => {
    const auth = createConformanceAuth();
    const destroyed: string[] = [];
    const appNamed = async (name: string) => {
      @Injectable()
      class Resource implements OnModuleDestroy {
        onModuleDestroy(): void {
          destroyed.push(name);
        }
      }
      const moduleRef = await Test.createTestingModule({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            platforms: [expressPlatform()],
            logSummary: false,
          } as never),
        ],
        providers: [Resource],
      }).compile();
      return moduleRef.createNestApplication(new ExpressAdapter(), {
        logger: false,
      });
    };
    const registered: (() => Promise<void>)[] = [];
    const closeWith = (close: () => Promise<void>) => {
      registered.push(close);
    };
    await initTestApp(await appNamed("first"), { closeWith });
    await initTestApp(await appNamed("second"), { closeWith });
    expect(destroyed).toEqual(["first"]);
    for (const close of registered) {
      await close();
    }
    expect(destroyed).toEqual(["first", "second"]);
  });

  it("lets the next app take over the binding of a failed init with W_INSTANCE_TAKEN_OVER", async () => {
    const auth = createConformanceAuth();
    const bridge = await bridgeOf(auth);
    const logger = new CapturingLogger();
    const good = async () => {
      const moduleRef = await Test.createTestingModule({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            platforms: [expressPlatform()],
            logSummary: false,
          } as never),
        ],
      }).compile();
      return moduleRef.createNestApplication(new ExpressAdapter(), { logger });
    };
    class UnregisteredPolicy {}
    @Controller("failing")
    class FailingController {
      @Require(requirement(UnregisteredPolicy as never, {}))
      @Get()
      handle(): void {}
    }
    const failingModule = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          platforms: [expressPlatform()],
          logSummary: false,
        } as never),
      ],
      controllers: [FailingController],
    }).compile();
    const failing = failingModule.createNestApplication(new ExpressAdapter(), {
      logger,
    });
    const first = await initTestApp(await good(), {
      closeWith: (close) => closes.push(close),
    });
    const firstClose = vi.spyOn(first, "close");
    await expect(initTestApp(failing)).rejects.toThrow(/UNRESOLVED_POLICY/);
    closes.push(() => failing.close());
    expect(firstClose).toHaveBeenCalledOnce();
    await initTestApp(await good(), {
      closeWith: (close) => closes.push(close),
    });
    expect(firstClose).toHaveBeenCalledOnce();
    expect(bridge.state).toBe("bound");
    expect(logger.text()).toMatch(/W_INSTANCE_TAKEN_OVER/);
  });

  it("rejects a second bound app without the helper and readies Fastify with it", async () => {
    const auth = createConformanceAuth();
    const first = await initTestApp(await appFor(auth, "fastify"), {
      closeWith: (fn) => closes.push(fn),
    });
    const unmanaged = await appFor(auth, "fastify");
    closes.push(() => unmanaged.close());
    await expect(unmanaged.init()).rejects.toThrow(/INSTANCE_ALREADY_BOUND/);
    const third = await appFor(auth, "fastify");
    const server = third.getHttpAdapter().getInstance() as {
      ready(): Promise<unknown>;
    };
    const ready = vi.spyOn(server, "ready");
    const close = vi.spyOn(first, "close");
    await initTestApp(third, { closeWith: (fn) => closes.push(fn) });
    expect(close).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalled();
  });
});
