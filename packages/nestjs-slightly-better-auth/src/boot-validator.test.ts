import { randomBytes } from "node:crypto";
import {
  Controller,
  Get,
  Injectable,
  Inject,
  forwardRef,
  Logger,
  Scope,
  UseGuards,
  UseInterceptors,
  type Provider,
  type Type,
} from "@nestjs/common";
import {
  APP_GUARD,
  HttpAdapterHost,
  type AbstractHttpAdapter,
} from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BeforeAuth,
  ForwardAuthCookies,
  Public,
  Require,
  RequireAuth,
  UseBetterAuth,
} from "./auth-decorators.js";
import type {
  AuthContextView,
  AuthTransport,
  BetterAuthModuleOptions,
  BootAdviceContext,
  PrincipalSource,
  HttpPlatform,
} from "./auth-contracts.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { defineExtension } from "./auth-module-definition.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { AUTH_ENHANCER } from "./auth-tokens.js";
import type { AuthLike, AuthHookContext } from "./auth-types.js";
import { BRIDGE_HANDLE } from "./bridge-protocol.js";
import { nestjs } from "./plugin.js";
import { createTestAuth } from "./test-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const base = {
  baseURL: "http://localhost:3000",
  secret: randomBytes(32).toString("hex"),
  logger: { disabled: true },
} satisfies BetterAuthOptions;
function contextAuth(
  change: (context: AuthContextView) => AuthContextView,
): AuthLike {
  const auth = createTestAuth();
  return {
    api: auth.api,
    handler: auth.handler,
    $context: auth.$context.then((context) =>
      change(context as unknown as AuthContextView),
    ),
  };
}
async function boot(
  options: BetterAuthModuleOptions<AuthLike> & { name?: "default" },
  extras: {
    providers?: Provider[];
    controllers?: Type[];
    transports?: AuthTransport[];
    platforms?: HttpPlatform[];
    imports?: ReturnType<typeof BetterAuthModule.forRoot>[];
    host?: HttpAdapterHost;
  } = {},
) {
  const builder = Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        ...options,
        transports: extras.transports,
        platforms: extras.platforms,
      }),
      ...(extras.imports ?? []),
    ],
    providers: extras.providers,
    controllers: extras.controllers,
  });
  if (extras.host) {
    builder.overrideProvider(HttpAdapterHost).useValue(extras.host);
  }
  const module = await builder.compile();
  try {
    await module.init();
  } finally {
    await module.close().catch(() => undefined);
  }
}
function claimTransport(
  reach: "global" | "explicit" | "none",
  target: Type,
  method = "run",
): AuthTransport {
  return {
    id: "claimed",
    handles: () => false,
    describe: () => {
      throw new Error("not called at boot");
    },
    toException: (failure) => failure,
    validate(ctx) {
      ctx.claim(target, method, reach, {
        code: "FIXTURE_UNGUARDED",
        hint: "Add @UseBetterAuth()",
        everyHandler: true,
      });
    },
  };
}

describe("aggregated boot validation", () => {
  it("rejects invalid SDK shapes without crashing provider construction (B01)", async () => {
    await expect(boot({ auth: {} as AuthLike })).rejects.toThrow(
      "NOT_AN_AUTH_INSTANCE",
    );
  });
  it("preserves failed initialization as a caused B02 issue", async () => {
    const cause = new Error("adapter unavailable");
    const rejected = Promise.reject(cause);
    void rejected.catch(() => undefined);
    const auth = { ...createTestAuth(), $context: rejected };
    await expect(boot({ auth })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "AUTH_CONTEXT_FAILED", cause }),
      ]),
    });
  });
  it("requires the construction-time plugin (B03)", async () => {
    await expect(boot({ auth: betterAuth(base) })).rejects.toThrow(
      "PLUGIN_MISSING",
    );
  });
  it("rejects shared plugin handles before either instance binds (B03)", async () => {
    const plugin = nestjs();
    const primary = betterAuth({ ...base, plugins: [plugin] });
    const admin = betterAuth({
      ...base,
      advanced: { cookiePrefix: "admin" },
      plugins: [plugin],
    });
    await expect(
      boot(
        { auth: primary },
        { imports: [BetterAuthModule.forRoot({ name: "admin", auth: admin })] },
      ),
    ).rejects.toThrow("PLUGIN_SHARED_BETWEEN_INSTANCES");
    expect(Reflect.get(plugin, BRIDGE_HANDLE).state).toBe("unbound");
  });
  it("rejects a mismatched bridge protocol (B04)", async () => {
    const auth = contextAuth((context) => ({
      ...context,
      getPlugin: () => ({ [BRIDGE_HANDLE]: { protocol: 99, bind() {} } }),
    }));
    await expect(boot({ auth })).rejects.toThrow("PLUGIN_PROTOCOL_MISMATCH");
  });
  it("reports independent duplicate name, global guard and cookie errors together (B07/B24)", async () => {
    const auth = createTestAuth();
    await expect(
      boot(
        { auth },
        {
          imports: [
            BetterAuthModule.forRoot({ auth: createTestAuth() }),
            BetterAuthModule.forRoot({ name: "admin", auth: createTestAuth() }),
          ],
        },
      ),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "DUPLICATE_INSTANCE" }),
        expect.objectContaining({ code: "DUPLICATE_GLOBAL_GUARD" }),
        expect.objectContaining({ code: "COOKIE_NAME_COLLISION" }),
      ]),
    });
  });
  it("rejects non-singleton hook dependencies and unknown hook patterns (B11/B12)", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class ScopedHook {
      @BeforeAuth("/get-session") run(_ctx: AuthHookContext<"/get-session">) {}
    }
    class WrongPath {
      @BeforeAuth("/get-sesion") run(_ctx: AuthHookContext<"/get-sesion">) {}
    }
    await expect(
      boot({ auth: createTestAuth() }, { providers: [ScopedHook, WrongPath] }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "NON_SINGLETON_EXTENSION" }),
        expect.objectContaining({
          code: "UNKNOWN_HOOK_PATH",
          hint: "Did you mean '/get-session'?",
        }),
      ]),
    });
  });
  it("reports a hook's unknown named instance (B12)", async () => {
    class Hooks {
      @BeforeAuth(undefined, { instance: "missing" }) run(
        _ctx: AuthHookContext,
      ) {}
    }
    await expect(
      boot({ auth: createTestAuth() }, { providers: [Hooks] }),
    ).rejects.toThrow("UNKNOWN_INSTANCE");
  });
  it("checks source prerequisites and DI policy resolution before plan compilation (B13/B14)", async () => {
    @Controller("policy")
    class ControllerWithPolicy {
      @Get() @Require({ policy: "unregistered-policy", params: {} }) run() {}
    }
    await expect(
      boot(
        {
          auth: createTestAuth(),
          principals: [
            {
              id: "source",
              kinds: ["session"],
              requires: { plugins: ["missing-plugin"] },
              resolve: async () => ({ outcome: "absent" }),
            },
          ],
        },
        { controllers: [ControllerWithPolicy] },
      ),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "PLUGIN_PREREQUISITE" }),
        expect.objectContaining({ code: "UNRESOLVED_POLICY" }),
      ]),
    });
  });
  it("validates a policy's params using the same resolved instance and initialized handle (B14)", async () => {
    const validate = vi.fn();
    const policy = {
      id: "policy",
      evaluate: async () => ({ effect: "allow" as const }),
      validate,
    };
    @Controller("policy")
    class PolicyController {
      @Get() @Require({ policy: "policy", params: { value: 1 } }) run() {}
    }
    await boot(
      { auth: createTestAuth() },
      {
        controllers: [PolicyController],
        providers: [{ provide: "policy", useValue: policy }],
      },
    );
    expect(validate).toHaveBeenCalledWith(
      { value: 1 },
      expect.objectContaining({
        site: "PolicyController.run",
        auth: expect.objectContaining({ name: "default" }),
        context: expect.objectContaining({ secret: expect.any(String) }),
      }),
    );
  });
  it("rejects required access combined with impossible accepted kinds (B15)", async () => {
    @Controller("kinds")
    class Kinds {
      @Get()
      @Require({
        policy: {
          id: "policy",
          requires: { principals: ["missing"] },
          evaluate: async () => ({ effect: "allow" as const }),
        },
        params: {},
      })
      run() {}
    }
    await expect(
      boot({ auth: createTestAuth() }, { controllers: [Kinds] }),
    ).rejects.toThrow("UNKNOWN_PRINCIPAL_KIND");
  });
});

describe("coverage and global scope", () => {
  it("accepts global guard-only coverage and warns for globalScope:false (B16/B31)", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    @Controller("protected")
    class Protected {
      @Get() @RequireAuth() run() {}
    }
    await boot(
      { auth: createTestAuth(), globalScope: false },
      { controllers: [Protected] },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("W_NO_GLOBAL_SCOPE"),
    );
  });
  it("recognizes an actual overridden global guard by provider identity", async () => {
    @Controller("protected")
    class Protected {
      @Get() @RequireAuth() run() {}
    }
    const module = await Test.createTestingModule({
      imports: [BetterAuthModule.forRoot({ auth: createTestAuth() })],
      controllers: [Protected],
    })
      .overrideProvider(BetterAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();
    try {
      await module.init();
    } finally {
      await module.close();
    }
  });
  it("recognizes manual global guard registration and cross-copy brands", async () => {
    @Controller("protected")
    class Protected {
      @Get() @RequireAuth() run() {}
    }
    await boot(
      { auth: createTestAuth(), globalGuard: false },
      {
        controllers: [Protected],
        providers: [
          {
            provide: APP_GUARD,
            useValue: { [AUTH_ENHANCER]: "guard", canActivate: () => true },
          },
        ],
      },
    );
  });
  it("requires both explicit enhancers for gateway/hybrid claims", async () => {
    @UseGuards(BetterAuthGuard)
    class Gateway {
      @RequireAuth() run() {}
    }
    await expect(
      boot(
        { auth: createTestAuth() },
        {
          providers: [Gateway],
          transports: [claimTransport("explicit", Gateway)],
        },
      ),
    ).rejects.toThrow("FIXTURE_UNGUARDED");
    @UseGuards(BetterAuthGuard)
    @UseInterceptors(BetterAuthScopeInterceptor)
    class Covered {
      @RequireAuth() run() {}
    }
    await boot(
      { auth: createTestAuth() },
      {
        providers: [Covered],
        transports: [claimTransport("explicit", Covered)],
      },
    );
  });
  it("does not exempt public form-forwarding handlers from guard coverage", async () => {
    class PublicForwarding {
      @Public() @ForwardAuthCookies() run() {}
    }
    await expect(
      boot(
        { auth: createTestAuth(), globalGuard: false },
        {
          providers: [PublicForwarding],
          transports: [claimTransport("none", PublicForwarding)],
        },
      ),
    ).rejects.toThrow("FIXTURE_UNGUARDED");
  });
  it("detects unclaimed auth metadata without treating hook-only providers as routes", async () => {
    class Unclaimed {
      @RequireAuth() run() {}
    }
    await expect(
      boot({ auth: createTestAuth() }, { providers: [Unclaimed] }),
    ).rejects.toThrow("UNGUARDED_AUTH_METADATA");
    class HookOnly {
      @BeforeAuth("/get-session") run(_ctx: AuthHookContext<"/get-session">) {}
    }
    await boot({ auth: createTestAuth() }, { providers: [HookOnly] });
  });
  it("supports the explicit combined decorator", async () => {
    @UseBetterAuth()
    class Gateway {
      @RequireAuth() run() {}
    }
    await boot(
      { auth: createTestAuth() },
      {
        providers: [Gateway],
        transports: [claimTransport("explicit", Gateway)],
      },
    );
  });
});

describe("effective security options and extension advice", () => {
  it("aggregates unsafe URL and public default signing secret in production (B23/B29)", async () => {
    vi.stubEnv("NODE_ENV", "staging");
    const auth = contextAuth((context) => ({
      ...context,
      baseURL: "",
      secret: "better-auth-secret-12345678901234567890",
      options: { ...context.options, baseURL: undefined },
    }));
    await expect(boot({ auth })).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "UNSAFE_BASE_URL" }),
        expect.objectContaining({ code: "DEFAULT_SECRET" }),
      ]),
    });
  });
  it("enforces default instance ownership for app-wide extensions (B25)", async () => {
    const named = BetterAuthModule.forRoot({
      name: "admin",
      auth: createTestAuth(),
      transports: [],
    } as never);
    const module = await Test.createTestingModule({
      imports: [named],
    }).compile();
    try {
      await expect(module.init()).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({ code: "NO_DEFAULT_INSTANCE" }),
          expect.objectContaining({ code: "APP_EXTENSIONS_ON_NAMED_INSTANCE" }),
        ]),
      });
    } finally {
      await module.close().catch(() => undefined);
    }
  });
  it("validates hostless calls against dynamic baseURL fallback (B20)", async () => {
    const auth = contextAuth((context) => ({
      ...context,
      baseURL: "",
      options: { ...context.options, baseURL: { allowedHosts: ["localhost"] } },
    }));
    await expect(
      boot({
        auth,
        principals: [
          {
            id: "hostless",
            kinds: ["session"],
            requires: { hostlessCalls: true },
            resolve: async () => ({ outcome: "absent" }),
          },
        ],
      }),
    ).rejects.toThrow("DYNAMIC_BASE_URL_WITHOUT_FALLBACK");
  });
  it("calls advice with compiled plans, claimed input names, and initialized context (B21)", async () => {
    class Handler {
      @Public() run() {}
    }
    const advise = vi.fn(() => [
      { level: "info" as const, code: "I_FIXTURE", message: "fixture advice" },
    ]);
    const transport = claimTransport("global", Handler);
    transport.validate = (ctx) =>
      ctx.claim(Handler, "run", "global", {
        code: "COVERAGE",
        hint: "fix",
        inputs: ["organizationId"],
      });
    transport.advise = advise;
    await boot(
      { auth: createTestAuth() },
      { providers: [Handler], transports: [transport] },
    );
    expect(advise).toHaveBeenCalledWith(
      expect.objectContaining({
        instance: "default",
        handlers: expect.arrayContaining([
          expect.objectContaining({
            inputs: ["organizationId"],
            transports: ["claimed"],
          }),
        ]),
      }),
    );
  });
  it("warns from resolved origin flags, path skips, forwarding and effective rate limiter (B19/B28/B30)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(Logger.prototype, "warn");
    const log = vi.spyOn(Logger.prototype, "log");
    const auth = contextAuth((context) => ({
      ...context,
      skipOriginCheck: true,
      skipCSRFCheck: false,
      rateLimit: { enabled: false },
      options: {
        ...context.options,
        advanced: { ...context.options.advanced, disableCSRFCheck: false },
      },
    }));
    await boot({ auth, cookies: { forwardDirectCalls: true } });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("app-route checks remain on"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("W_FORWARD_DIRECT_CALLS"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("while process.env.NODE_ENV is production"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "Better Auth saw no NODE_ENV=production at import time",
      ),
    );
    const pathAuth = contextAuth((context) => ({
      ...context,
      skipCSRFCheck: false,
      skipOriginCheck: ["/callback/*"],
    }));
    await boot({ auth: pathAuth });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("I_AUTH_ORIGIN_PATH_SKIPS"),
    );
  });
  it("warns when dispatches precede hook binding (B26)", async () => {
    const auth = createTestAuth();
    await auth.api.getSession({ headers: new Headers() });
    const warn = vi.spyOn(Logger.prototype, "warn");
    class Hooks {
      @BeforeAuth("/get-session") run(_ctx: AuthHookContext<"/get-session">) {}
    }
    await boot({ auth }, { providers: [Hooks] });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("W_CALLS_BEFORE_BIND"),
    );
  });
});

function httpFixture() {
  const server = {};
  const host = new HttpAdapterHost();
  host.httpAdapter = { getInstance: () => server } as AbstractHttpAdapter;
  const platform: HttpPlatform = {
    id: "fixture",
    supports: () => true,
    mount: vi.fn(),
    requests: {
      isRequest: () => false,
      isLive: () => false,
      key: (request) => request as object,
      headers: () => new Headers(),
      request: () => ({ method: "GET", url: "http://localhost/" }),
      clientIp: () => null,
      param: () => undefined,
      cookieSink: () => null,
    },
  };
  return { host, platform, server };
}

describe("platform and mount boot checks", () => {
  it("requires exactly one platform for a present adapter (B08)", async () => {
    const { host, platform } = httpFixture();
    await expect(
      boot({ auth: createTestAuth() }, { host, platforms: [] }),
    ).rejects.toThrow("NO_PLATFORM");
    await expect(
      boot(
        { auth: createTestAuth() },
        { host, platforms: [platform, { ...platform, id: "other" }] },
      ),
    ).rejects.toThrow("AMBIGUOUS_PLATFORM");
  });
  it("aggregates platform validation failure (B09)", async () => {
    const { host, platform } = httpFixture();
    platform.validate = () => {
      throw new Error("platform prerequisite failed");
    };
    await expect(
      boot({ auth: createTestAuth() }, { host, platforms: [platform] }),
    ).rejects.toThrow("PLATFORM_VALIDATION_FAILED");
    expect(platform.mount).not.toHaveBeenCalled();
  });
  it("rejects root paths, invalid body limits, overlapping and duplicate server mounts (B10)", async () => {
    const { host, platform } = httpFixture();
    const root = contextAuth((context) => ({
      ...context,
      baseURL: "http://localhost/",
    }));
    await expect(
      boot({ auth: root }, { host, platforms: [platform] }),
    ).rejects.toThrow("INVALID_MOUNT_PATH");
    await expect(
      boot(
        { auth: createTestAuth(), http: { bodyLimit: -1 } },
        { host, platforms: [platform] },
      ),
    ).rejects.toThrow("INVALID_BODY_LIMIT");
    await expect(
      boot(
        { auth: createTestAuth() },
        {
          host,
          platforms: [platform],
          imports: [
            BetterAuthModule.forRoot({
              name: "admin",
              auth: createTestAuth({ advanced: { cookiePrefix: "admin" } }),
            }),
          ],
        },
      ),
    ).rejects.toThrow("OVERLAPPING_MOUNTS");
    await boot({ auth: createTestAuth() }, { host, platforms: [platform] });
    await expect(
      boot({ auth: createTestAuth() }, { host, platforms: [platform] }),
    ).rejects.toThrow("DUPLICATE_MOUNT");
  });
  it("warns about shadow routes and resolved proxy/IP risks (B17/B18/B27)", async () => {
    vi.stubEnv("NODE_ENV", "staging");
    const warn = vi.spyOn(Logger.prototype, "warn");
    @Controller("api/auth")
    class Shadows {
      @Get("session") run() {}
    }
    const { host, platform } = httpFixture();
    platform.proxyTrust = () => ({ mode: "all", detail: "all hops" });
    const auth = contextAuth((context) => ({
      ...context,
      options: {
        ...context.options,
        advanced: {
          ...context.options.advanced,
          ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
        },
      },
    }));
    await boot(
      { auth },
      { host, platforms: [platform], controllers: [Shadows] },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("W_ROUTE_SHADOWS_AUTH"),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("W_CLIENT_IP"));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("W_PROXY_TRUST_ALL"),
    );
  });
  it("warns when a later plugin has after hooks (B05)", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    const auth = contextAuth((context) => ({
      ...context,
      options: {
        ...context.options,
        plugins: [
          ...(context.options.plugins ?? []),
          { id: "later", hooks: { after: [{}] } },
        ],
      },
    }));
    await boot({ auth });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("W_PLUGIN_NOT_LAST"),
    );
  });
});

it("accepts class-only public claims but still requires guards for their forwarding", async () => {
  @Public()
  class ClassOnly {}
  const transport = claimTransport("explicit", ClassOnly);
  transport.validate = (context) =>
    context.claim(ClassOnly, undefined, "explicit", {
      code: "CLASS_UNGUARDED",
      hint: "Use a class decorator",
      everyHandler: true,
    });
  await boot(
    { auth: createTestAuth() },
    { providers: [ClassOnly], transports: [transport] },
  );
  @Public()
  @ForwardAuthCookies()
  class ForwardingClass {}
  transport.validate = (context) =>
    context.claim(ForwardingClass, undefined, "explicit", {
      code: "CLASS_UNGUARDED",
      hint: "Use @UseBetterAuth()",
      everyHandler: true,
    });
  await expect(
    boot(
      { auth: createTestAuth() },
      { providers: [ForwardingClass], transports: [transport] },
    ),
  ).rejects.toThrow("CLASS_UNGUARDED");
});

it("fails closed when Nest enhancer metadata canaries fail, before consulting claims", async () => {
  class Handler {
    run() {}
  }
  const validate = vi.fn();
  const transport = { ...claimTransport("global", Handler), validate };
  const original = Reflect.getOwnMetadata;
  vi.spyOn(Reflect, "getOwnMetadata").mockImplementation(
    (key, target, propertyKey) => {
      if (
        key === "__guards__" &&
        typeof target === "function" &&
        target.name === "Probe"
      ) {
        return undefined;
      }
      return propertyKey === undefined
        ? original(key, target)
        : original(key, target, propertyKey);
    },
  );
  await expect(
    boot(
      { auth: createTestAuth() },
      { providers: [Handler], transports: [transport] },
    ),
  ).rejects.toThrow("NEST_METADATA_KEY_CHANGED");
  expect(validate).not.toHaveBeenCalled();
});

describe("review regressions: singleton dependency graphs", () => {
  @Injectable({ scope: Scope.TRANSIENT })
  class TransientDependency {}

  it.each([
    ["transient", Scope.TRANSIENT],
    ["request-scoped", Scope.REQUEST],
  ] as const)(
    "rejects a %s source reached through an existing-provider alias",
    async (_label, scope) => {
      @Injectable({ scope })
      class Source {
        readonly id = "transient-source";
        readonly kinds = ["session"] as const;

        async resolve() {
          return { outcome: "absent" } as const;
        }
      }
      await expect(
        boot({
          auth: createTestAuth(),
          principals: [
            defineExtension({
              providers: [Source],
              use: { useExisting: Source },
            }),
          ],
        }),
      ).rejects.toThrow("NON_SINGLETON_EXTENSION");
    },
  );

  it.each(["constructor", "property"])(
    "rejects a singleton source's transient %s dependency",
    async (injection) => {
      class ConstructorSource {
        readonly id = "constructor-source";
        readonly kinds = ["session"] as const;

        constructor(
          @Inject(TransientDependency) readonly dependency: TransientDependency,
        ) {}

        async resolve() {
          return { outcome: "absent" } as const;
        }
      }
      class PropertySource {
        readonly id = "property-source";
        readonly kinds = ["session"] as const;
        @Inject(TransientDependency) readonly dependency!: TransientDependency;

        async resolve() {
          return { outcome: "absent" } as const;
        }
      }
      const useClass: Type<PrincipalSource> =
        injection === "constructor" ? ConstructorSource : PropertySource;
      await expect(
        boot({
          auth: createTestAuth(),
          principals: [
            defineExtension({
              providers: [TransientDependency],
              use: { useClass },
            }),
          ],
        }),
      ).rejects.toThrow("NON_SINGLETON_EXTENSION");
    },
  );

  it("rejects transient dependencies of policy aliases and hook providers", async () => {
    class Policy {
      readonly id = "transient-backed-policy";

      constructor(
        @Inject(TransientDependency) readonly dependency: TransientDependency,
      ) {}

      async evaluate() {
        return { effect: "allow" } as const;
      }
    }
    class Hooks {
      constructor(
        @Inject(TransientDependency) readonly dependency: TransientDependency,
      ) {}

      @BeforeAuth("/get-session") run(
        _context: AuthHookContext<"/get-session">,
      ) {}
    }
    @Controller("policy")
    class Protected {
      @Get() @Require({ policy: "policy-alias", params: {} }) run() {}
    }
    await expect(
      boot(
        { auth: createTestAuth() },
        {
          controllers: [Protected],
          providers: [
            TransientDependency,
            Policy,
            Hooks,
            { provide: "policy-alias", useExisting: Policy },
          ],
        },
      ),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "NON_SINGLETON_EXTENSION",
          detail: expect.stringContaining("policy-alias"),
        }),
        expect.objectContaining({
          code: "NON_SINGLETON_EXTENSION",
          detail: expect.stringContaining("Hooks"),
        }),
      ]),
    });
  });

  it("does not reject unrelated application transient providers", async () => {
    await boot(
      { auth: createTestAuth() },
      { providers: [TransientDependency] },
    );
  });
});

describe("review regressions: actual handler planning", () => {
  it("omits provider/helper methods and unused default policies from public-only apps", async () => {
    const validate = vi.fn();
    const advise = vi.fn((_context: BootAdviceContext) => []);
    const unused = {
      id: "unused",
      requires: { plugins: ["not-installed"] },
      evaluate: async () => ({ effect: "allow" as const }),
      validate,
    };
    @Controller("public")
    class PublicController {
      @Get() @Public() run() {}

      helper() {}
    }
    class ApplicationHelper {
      helper() {}
    }
    await boot(
      {
        auth: createTestAuth(),
        defaultRequirements: [{ policy: unused, params: {} }],
      },
      {
        controllers: [PublicController],
        providers: [ApplicationHelper],
        transports: [{ ...claimTransport("global", PublicController), advise }],
      },
    );
    expect(validate).not.toHaveBeenCalled();
    expect(advise).toHaveBeenCalledOnce();
    expect(
      advise.mock.calls[0]![0].handlers.map((handler) => handler.plan.site),
    ).toEqual(["PublicController.run"]);
    expect(advise.mock.calls[0]![0].policies).toEqual([]);
  });

  it("prepares and validates handlers requested by transport planOf before claim", async () => {
    const validate = vi.fn();
    const advise = vi.fn((_context: BootAdviceContext) => []);
    const policy = {
      id: "actual",
      requires: { principals: ["session"] },
      evaluate: async () => ({ effect: "allow" as const }),
      validate,
    };
    class Handler {
      run() {}
    }
    const transport = claimTransport("global", Handler);
    transport.validate = (context) => {
      expect(context.planOf(Handler, "run").requirements).toHaveLength(1);
      context.claim(Handler, "run", "global", {
        code: "COVERAGE",
        hint: "Apply auth",
      });
    };
    transport.advise = advise;
    await boot(
      {
        auth: createTestAuth(),
        defaultRequirements: [
          { policy: "actual-policy", params: { key: "actual" } },
        ],
      },
      {
        providers: [Handler, { provide: "actual-policy", useValue: policy }],
        transports: [transport],
      },
    );
    expect(validate).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledWith(
      { key: "actual" },
      expect.objectContaining({ site: "Handler.run" }),
    );
    expect(
      advise.mock.calls[0]![0].handlers.map((handler) => handler.plan.site),
    ).toEqual(["Handler.run"]);
  });

  it("prioritizes declared forwarding handlers before the B31 warning cap", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    class ManyHandlers {}
    const names = [
      ...Array.from({ length: 22 }, (_, index) => `required${index}`),
      "undeclared",
      "forwarding",
    ];
    for (const name of names) {
      Object.defineProperty(ManyHandlers.prototype, name, {
        value() {},
        configurable: true,
      });
      const descriptor = Object.getOwnPropertyDescriptor(
        ManyHandlers.prototype,
        name,
      )!;
      if (name === "forwarding") {
        ForwardAuthCookies()(ManyHandlers.prototype, name, descriptor);
      } else if (name !== "undeclared") {
        RequireAuth()(ManyHandlers.prototype, name, descriptor);
      }
    }
    const transport = claimTransport("global", ManyHandlers);
    transport.validate = (context) => {
      for (const name of names) {
        context.claim(ManyHandlers, name, "global", {
          code: "COVERAGE",
          hint: "Apply auth",
        });
      }
    };
    await boot(
      { auth: createTestAuth(), globalScope: false },
      { providers: [ManyHandlers], transports: [transport] },
    );
    const message = String(
      warn.mock.calls.find((call) =>
        String(call[0]).includes("W_NO_GLOBAL_SCOPE"),
      )![0],
    );
    const listed = message.match(/ManyHandlers\.\w+/g)!;
    expect(listed).toHaveLength(20);
    expect(listed[0]).toBe("ManyHandlers.forwarding");
    expect(listed).not.toContain("ManyHandlers.undeclared");
  });
});

it("accepts singleton extension dependency cycles without following unrelated providers", async () => {
  class Left {
    constructor(@Inject(forwardRef(() => Right)) readonly right: object) {}
  }
  class Right {
    constructor(@Inject(forwardRef(() => Left)) readonly left: object) {}
  }
  class Source {
    readonly id = "cycle-source";
    readonly kinds = ["session"] as const;

    constructor(@Inject(Left) readonly dependency: Left) {}

    async resolve() {
      return { outcome: "absent" } as const;
    }
  }
  await boot({
    auth: createTestAuth(),
    principals: [
      defineExtension({ providers: [Left, Right], use: { useClass: Source } }),
    ],
  });
});
