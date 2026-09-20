import { Global, Module } from "@nestjs/common";
import { HttpAdapterHost, type AbstractHttpAdapter } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import { BeforeAuth, BeforeDatabase } from "./auth-decorators.js";
import type { HttpPlatform } from "./auth-contracts.js";
import { BetterAuthCoreModule } from "./auth-core-module.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthService } from "./auth-service.js";
import { INSTANCE_REGISTRY, REQUEST_SCOPE } from "./auth-tokens.js";
import type { AuthHookContext, DatabaseHookMethod } from "./auth-types.js";
import { BRIDGE_HANDLE, type BridgeHandle } from "./bridge-protocol.js";
import { InstanceRegistry } from "./instance-registry.js";
import { MountCoordinator } from "./mount-coordinator.js";
import { RequestScope } from "./request-scope.js";
import { createTestAuth } from "./test-fixtures.js";

function adapter(): AbstractHttpAdapter {
  const server = {};
  return { getInstance: () => server } as AbstractHttpAdapter;
}
function platform(prepare = vi.fn()): HttpPlatform {
  return {
    id: "fixture",
    supports: () => true,
    prepare,
    mount: vi.fn(),
    requests: {
      isRequest: () => false,
      isLive: () => false,
      key: (value) => value as object,
      headers: () => new Headers(),
      request: () => ({ method: "GET", url: "http://localhost/" }),
      clientIp: () => null,
      param: () => undefined,
      cookieSink: () => null,
    },
  };
}

describe("application lifecycle", () => {
  it.each(["adapter-first", "platform-first"])(
    "prepares once with %s arrival",
    (order) => {
      const host = new HttpAdapterHost();
      const current = adapter();
      if (order === "adapter-first") {
        host.httpAdapter = current;
      }
      const scope = new RequestScope();
      const registry = new InstanceRegistry(scope);
      const coordinator = new MountCoordinator(host, registry, scope);
      const selected = platform();
      coordinator.registerPlatforms([selected]);
      if (order === "platform-first") {
        host.httpAdapter = current;
      }
      coordinator.prepareAtInit([]);
      expect(selected.prepare).toHaveBeenCalledTimes(1);
      expect(selected.prepare).toHaveBeenCalledWith(
        expect.objectContaining({ adapter: current }),
      );
    },
  );

  it("rejects a changed adapter on a reused context unless prepareAtInit is supported", () => {
    const host = new HttpAdapterHost();
    host.httpAdapter = adapter();
    const scope = new RequestScope();
    const registry = new InstanceRegistry(scope);
    const coordinator = new MountCoordinator(host, registry, scope);
    const selected = platform();
    coordinator.registerPlatforms([selected]);
    registry.begin(host.httpAdapter);
    registry.reset();
    host.httpAdapter = adapter();
    const issues: Error[] = [];
    coordinator.prepareAtInit(issues as never[]);
    expect(issues).toEqual([
      expect.objectContaining({ code: "APP_ADAPTER_CHANGED" }),
    ]);
    const supported = { ...selected, capabilities: { prepareAtInit: true } };
    coordinator.registerPlatforms([supported]);
    expect(selected.prepare).toHaveBeenCalledTimes(2);
  });

  it("keeps one shared scope and ignores duplicate lifecycle calls", async () => {
    const auth = createTestAuth();
    const module = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth, http: { mount: false } })],
    }).compile();
    try {
      await module.init();
      const registry = module.get<InstanceRegistry>(INSTANCE_REGISTRY);
      const owner = registry.owner;
      const core = module.get(BetterAuthCoreModule);
      await core.onModuleInit();
      core.onApplicationBootstrap();
      expect(registry.owner).toBe(owner);
      expect(registry.state).toBe("bootstrapped");
      const scope = module.get<RequestScope>(REQUEST_SCOPE);
      const service = module.get(BetterAuthService);
      await service.withoutCookies(async () => {
        expect(scope.current()?.view.cookies).toBeNull();
        await service.runOutsideScope(async () => {
          await Promise.resolve();
          expect(scope.current()).toBeUndefined();
        });
        expect(scope.current()?.view.cookies).toBeNull();
      });
      expect(scope.current()).toBeUndefined();
    } finally {
      await module.close();
    }
  });

  it("rejects a live second application and permits a closed owner takeover", async () => {
    const auth = createTestAuth();
    const build = () =>
      Test.createTestingModule({
        imports: [BetterAuthModule.forRoot({ auth, http: { mount: false } })],
      }).compile();
    const first = await build();
    const second = await build();
    try {
      await first.init();
      await expect(second.init()).rejects.toThrow("INSTANCE_ALREADY_BOUND");
    } finally {
      await second.close().catch(() => undefined);
      await first.close();
    }
    const third = await build();
    try {
      await expect(third.init()).resolves.toBe(third);
    } finally {
      await third.close();
    }
  });

  it("takes over a binding whose first application failed boot", async () => {
    const auth = createTestAuth();
    const failed = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          http: { mount: false },
          principals: [
            {
              id: "missing",
              kinds: ["session"],
              requires: { plugins: ["uninstalled"] },
              resolve: async () => ({ outcome: "absent" }),
            },
          ],
        }),
      ],
    }).compile();
    await expect(failed.init()).rejects.toThrow("PLUGIN_PREREQUISITE");
    const retry = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth, http: { mount: false } })],
    }).compile();
    try {
      await retry.init();
      await failed.close().catch(() => undefined);
      const context = await auth.$context;
      const handle = Reflect.get(
        context.getPlugin("nestjs-slightly-better-auth")!,
        BRIDGE_HANDLE,
      ) as BridgeHandle;
      expect(handle.state).toBe("bound");
    } finally {
      await retry.close();
    }
  });

  it("compiles ordered named hook methods and honors internal filtering", async () => {
    const calls: string[] = [];
    class Hooks {
      @BeforeAuth("/get-session", { order: 2 }) second(
        _ctx: AuthHookContext<"/get-session">,
      ) {
        calls.push("second");
      }
      @BeforeAuth("/get-session", { order: 1, skipInternal: true }) first(
        _ctx: AuthHookContext<"/get-session">,
      ) {
        calls.push("first");
      }
      @BeforeAuth("/get-session", { instance: "admin" }) admin(
        _ctx: AuthHookContext<"/get-session">,
      ) {
        calls.push("admin");
      }
    }
    const auth = createTestAuth();
    const admin = createTestAuth({ advanced: { cookiePrefix: "admin" } });
    const module = await Test.createTestingModule({
      providers: [Hooks],
      imports: [
        BetterAuthModule.forRoot({ auth, http: { mount: false } }),
        BetterAuthModule.forRoot({
          name: "admin",
          auth: admin,
          http: { mount: false },
        }),
      ],
    }).compile();
    try {
      await module.init();
      await auth.api.getSession({ headers: new Headers() });
      expect(calls).toEqual(["first", "second"]);
      calls.length = 0;
      await module
        .get<InstanceRegistry>(INSTANCE_REGISTRY)
        .get("default")
        .handle.run({ cookies: null, internal: true }, () =>
          auth.api.getSession({ headers: new Headers() }),
        );
      await admin.api.getSession({ headers: new Headers() });
      expect(calls).toEqual(["second", "admin"]);
    } finally {
      await module.close();
    }
  });

  it("keeps security database hooks active while a later shutdown hook drains", async () => {
    const auth = createTestAuth();
    let result: unknown;
    class SecurityHooks {
      @BeforeDatabase("user.create") reject(
        ...[data, _ctx]: Parameters<DatabaseHookMethod<"user.create", "before">>
      ): ReturnType<DatabaseHookMethod<"user.create", "before">> {
        if (data.email === "blocked@example.com") {
          return false;
        }
      }
    }
    @Global()
    @Module({
      providers: [
        {
          provide: "drainer",
          useValue: {
            async onApplicationShutdown() {
              try {
                result = await auth.api.signUpEmail({
                  body: {
                    email: "blocked@example.com",
                    password: "long-enough-password",
                    name: "Blocked",
                  },
                });
              } catch (error) {
                result = error;
              }
            },
          },
        },
      ],
    })
    class DrainerModule {}
    const module = await Test.createTestingModule({
      imports: [
        DrainerModule,
        BetterAuthModule.forRoot({ auth, http: { mount: false } }),
      ],
      providers: [SecurityHooks],
    }).compile();
    await module.init();
    await module.close();
    expect(result).toBeInstanceOf(Error);
    expect(
      await (await auth.$context).internalAdapter.findUserByEmail(
        "blocked@example.com",
      ),
    ).toBeNull();
  });
});

it("derives cookie-less and internal scopes without extracting outer capabilities", async () => {
  const module = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        auth: createTestAuth(),
        http: { mount: false },
      }),
    ],
  }).compile();
  try {
    await module.init();
    const service = module.get(BetterAuthService);
    const scope = module.get<RequestScope>(REQUEST_SCOPE);
    const entry = module
      .get<InstanceRegistry>(INSTANCE_REGISTRY)
      .get("default");
    const eager = vi.fn((): never => {
      throw new Error("eager extraction");
    });
    await scope.run(
      {
        get call() {
          return eager();
        },
        view: {
          get cookies() {
            return eager();
          },
          get inbound() {
            return eager();
          },
          get browserHeaders() {
            return eager();
          },
          get checkCallerSession() {
            return eager();
          },
          internal: false,
          forward: "none",
        },
      },
      async () => {
        await service.withoutCookies(async () => {
          expect(scope.current()?.view.cookies).toBeNull();
        });
        await entry.handle.run({ cookies: null, internal: true }, async () => {
          expect(scope.current()?.view.internal).toBe(true);
        });
        expect(eager).not.toHaveBeenCalled();
      },
    );
  } finally {
    await module.close();
  }
});

it("discovers inherited symbol hooks once and hooks on ready provider objects", async () => {
  const hook = Symbol("before");
  const calls: string[] = [];
  class Hooks {
    @BeforeAuth("/get-session")
    [hook](_context: AuthHookContext<"/get-session">) {
      calls.push("symbol");
    }

    @BeforeAuth("/get-session")
    ready(_context: AuthHookContext<"/get-session">) {
      calls.push("ready");
    }
  }
  class Inherited extends Hooks {
    ready(_context: AuthHookContext<"/get-session">) {}
  }
  const auth = createTestAuth();
  const module = await Test.createTestingModule({
    imports: [BetterAuthModule.forRoot({ auth, http: { mount: false } })],
    providers: [
      Inherited,
      { provide: "ready-hooks", useValue: { ready: Hooks.prototype.ready } },
    ],
  }).compile();
  try {
    await module.init();
    await auth.api.getSession({ headers: new Headers() });
    expect(calls).toEqual(["symbol", "ready"]);
  } finally {
    await module.close();
  }
});
