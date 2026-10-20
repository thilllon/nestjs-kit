import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { betterAuth } from "better-auth";
import { expect, it } from "vitest";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthService } from "./auth-service.js";
import { nestjs } from "./plugin.js";

it("the real module service throws synchronously outside a handler scope", async () => {
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "a-private-test-secret-that-is-long-enough",
    plugins: [nestjs()],
    advanced: { disableOriginCheck: false },
  });
  @Module({
    imports: [
      BetterAuthModule.forRoot({
        auth,
        http: { mount: false },
        logSummary: false,
      }),
    ],
  })
  class App {}
  const app = await NestFactory.createApplicationContext(App, {
    logger: false,
    abortOnError: false,
  });
  try {
    const service = app.get(BetterAuthService);
    expect(() => service.getSession()).toThrowError(
      expect.objectContaining({ code: "NO_AUTH_SCOPE" }),
    );
    expect(() => service.getPrincipal()).toThrowError(
      expect.objectContaining({ code: "NO_AUTH_SCOPE" }),
    );
  } finally {
    await app.close();
  }
});

// Nest's actual enhancer/parameter pipeline, with a deterministic transport envelope.
// Transport protocol acceptance itself belongs to the later platform tasks.
import {
  Inject,
  Injectable,
  createParamDecorator,
  type Type,
  type DynamicModule,
} from "@nestjs/common";
import { ROUTE_ARGS_METADATA } from "@nestjs/common/constants.js";
import { ExternalContextCreator } from "@nestjs/core/helpers/external-context-creator.js";
import { Test } from "@nestjs/testing";
import { vi, describe } from "vitest";
import type {
  AuthTransport,
  PrincipalSource,
  InvocationLineage,
} from "./auth-contracts.js";
import {
  AcceptPrincipals,
  CurrentPrincipal,
  ForwardAuthCookies,
  OptionalAuth,
  Public,
  RequireAuth,
  UseAuthInstance,
  UseBetterAuth,
} from "./auth-decorators.js";
import {
  getBetterAuthServiceToken,
  PRINCIPAL_RESOLVER,
} from "./auth-tokens.js";
import { CurrentSession } from "./session-principal.js";
import { createTestAuth } from "./test-fixtures.js";

interface Invocation {
  key: object;
  carrier: object;
  position: string;
  parents: string[];
  headers: Headers;
  browserHeaders?: Headers;
  method: string;
  deferred?: boolean;
}
const Input = createParamDecorator((_data, context) =>
  context.getArgByIndex(0),
);
function invocation(input: Partial<Invocation> = {}): Invocation {
  return {
    key: {},
    carrier: {},
    position: "1:root",
    parents: [],
    headers: new Headers({ origin: "http://localhost:3000" }),
    method: "GET",
    ...input,
  };
}
function lineage(input: Invocation): InvocationLineage {
  return {
    carrier: input.carrier,
    position: input.position,
    enclosing: (args) => (args[0] as Invocation).parents,
  };
}
const machine: PrincipalSource = {
  id: "machine",
  kinds: ["machine"],
  acceptance: "explicit",
  resolve: async () => ({
    outcome: "authenticated",
    principal: { kind: "machine", source: "machine", userId: null },
  }),
};
async function realPipeline(
  controller: Type,
  options: {
    auth?: ReturnType<typeof createTestAuth>;
    sources?: PrincipalSource[];
    extraModules?: DynamicModule[];
  } = {},
) {
  const auth = options.auth ?? createTestAuth();
  const transport: AuthTransport = {
    id: "fixture",
    handles: (context) => context.getType<string>() === "fixture",
    defaultAccessFor: (_target, method) =>
      method.startsWith("nested") ? "inherit" : undefined,
    lineage: (context) => lineage(context.getArgByIndex(0)),
    describe(context) {
      const input = context.getArgByIndex<Invocation>(0);
      const capability = () => {
        if (input.deferred) {
          throw new Error("deferred capability consumed");
        }
      };
      return {
        key: input.key,
        invocation: input,
        lineage: lineage(input),
        headers: () => {
          capability();
          return input.headers;
        },
        get cookies() {
          capability();
          return null;
        },
        get clientIp() {
          capability();
          return null;
        },
        get request() {
          capability();
          return {
            method: input.method,
            url: "http://localhost:3000/application",
          };
        },
        get browser() {
          capability();
          return {
            key: input.key,
            enforce: input.method !== "GET",
            headers: () => input.browserHeaders ?? input.headers,
            url: "http://localhost:3000/application",
          };
        },
        param: () => undefined,
      };
    },
    toException: (failure) => failure,
    validate(context) {
      for (const method of Object.getOwnPropertyNames(
        controller.prototype,
      ).filter((name) => name !== "constructor")) {
        context.claim(controller, method, "explicit", {
          code: "FIXTURE_UNGUARDED",
          hint: "UseBetterAuth",
          coverage: "error",
          everyHandler: true,
        });
      }
    },
  };
  const module = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        auth,
        http: { mount: false },
        globalGuard: false,
        globalScope: false,
        transports: [transport],
        principals: options.sources ?? [],
        logSummary: false,
      }),
      ...(options.extraModules ?? []),
    ],
    providers: [controller],
  }).compile();
  try {
    await module.init();
  } catch (error) {
    await module.close();
    throw error;
  }
  const creator = module.get(ExternalContextCreator);
  const instance = module.get(controller);
  return {
    module,
    auth,
    invoke(method: string, input: Invocation, interceptors = true) {
      const handler = creator.create(
        instance,
        Reflect.get(instance, method),
        method,
        ROUTE_ARGS_METADATA,
        { exchangeKeyForValue: () => undefined },
        undefined,
        undefined,
        { guards: true, interceptors, filters: false },
        "fixture",
      );
      return handler(input, input.carrier);
    },
    close: () => module.close(),
  };
}

describe("real Nest readers and origin enforcement", () => {
  it("projects non-session failures only inside scopes and keeps public capabilities deferred", async () => {
    @Injectable()
    @UseBetterAuth()
    class Reader {
      constructor(
        @Inject(getBetterAuthServiceToken())
        private readonly service: BetterAuthService,
      ) {}
      @AcceptPrincipals("machine") root(
        @CurrentPrincipal() principal: unknown,
      ) {
        return principal;
      }
      @AcceptPrincipals("machine") serviceSession() {
        return this.service.getSession();
      }
      nestedSession(@CurrentSession() session: unknown) {
        return session;
      }
      nestedService() {
        return this.service.getSession();
      }
      @Public() async publicRead() {
        return [
          await this.service.getSession(),
          await this.service.getPrincipal(),
        ];
      }
    }
    const app = await realPipeline(Reader, { sources: [machine] });
    try {
      const root = invocation();
      await expect(app.invoke("root", root)).resolves.toMatchObject({
        kind: "machine",
      });
      await expect(
        app.invoke("serviceSession", invocation()),
      ).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
      const nested = invocation({
        key: root.key,
        carrier: root.carrier,
        position: "1:root.field",
        parents: ["1:root"],
      });
      await expect(app.invoke("nestedSession", nested)).rejects.toMatchObject({
        code: "SESSION_REQUIRED",
      });
      await expect(
        app.invoke(
          "nestedService",
          { ...nested, position: "1:root.service" },
          false,
        ),
      ).rejects.toMatchObject({ code: "NO_AUTH_SCOPE" });
      await expect(
        app.invoke("publicRead", invocation({ deferred: true })),
      ).resolves.toEqual([null, null]);
    } finally {
      await app.close();
    }
  });
  it("enforces form checks before inherit return, with one shared principal read", async () => {
    @Injectable()
    @UseBetterAuth()
    class Reader {
      @OptionalAuth() root() {
        return "root";
      }
      @ForwardAuthCookies() nestedForward() {
        return "forwarded";
      }
    }
    const app = await realPipeline(Reader);
    const resolver = app.module.get<{
      resolve: (...args: any[]) => Promise<unknown>;
    }>(PRINCIPAL_RESOLVER);
    const read = vi.spyOn(resolver, "resolve");
    try {
      const root = invocation();
      await app.invoke("root", root);
      await expect(
        app.invoke(
          "nestedForward",
          invocation({
            key: {},
            carrier: root.carrier,
            position: "1:root.denied",
            parents: ["1:root"],
            headers: new Headers({ origin: "https://evil.example" }),
          }),
        ),
      ).rejects.toMatchObject({ status: 403, reason: "INVALID_ORIGIN" });
      await expect(
        app.invoke(
          "nestedForward",
          invocation({
            key: {},
            carrier: root.carrier,
            position: "1:root.allowed",
            parents: ["1:root"],
          }),
        ),
      ).resolves.toBe("forwarded");
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
  it("blocks origin-denied requests before resolver I/O and checks ambient cookies before remapped credentials", async () => {
    @Injectable()
    @UseBetterAuth()
    class Reader {
      @AcceptPrincipals("machine") root() {
        return true;
      }
    }
    const app = await realPipeline(Reader, { sources: [machine] });
    const read = vi.spyOn(
      app.module.get<{ resolve: (...args: any[]) => Promise<unknown> }>(
        PRINCIPAL_RESOLVER,
      ),
      "resolve",
    );
    try {
      await expect(
        app.invoke(
          "root",
          invocation({
            method: "POST",
            headers: new Headers({ "x-machine": "opaque" }),
            browserHeaders: new Headers({
              cookie: "ambient=credential",
              origin: "https://evil.example",
            }),
          }),
        ),
      ).rejects.toMatchObject({ status: 403 });
      expect(read).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("allows a pure cross-site safe read but stops real SDK signOut before database effects", async () => {
    const effects = vi.fn();
    const auth = createTestAuth({
      databaseHooks: {
        session: {
          delete: {
            before: async () => {
              effects();
            },
          },
        },
      },
    });
    @Injectable()
    @UseBetterAuth()
    class Reader {
      constructor(
        @Inject(getBetterAuthServiceToken())
        private readonly service: BetterAuthService,
      ) {}
      @RequireAuth({ authoritative: true }) root(
        @CurrentSession() session: unknown,
      ) {
        return session;
      }
      async signOut(@Input() input: Invocation) {
        return (this.service.api as typeof auth.api).signOut({
          headers: input.headers,
        });
      }
      @AcceptPrincipals("machine") async remappedSignOut(
        @Input() input: Invocation,
      ) {
        return (this.service.api as typeof auth.api).signOut({
          headers: input.browserHeaders!,
        });
      }
    }
    const app = await realPipeline(Reader, { auth, sources: [machine] });
    try {
      const created = await auth.api.signUpEmail({
        body: {
          email: "reader@example.com",
          password: "a-long-strong-test-password",
          name: "Reader",
        },
        returnHeaders: true,
      });
      const cookie = created.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      const headers = new Headers({ cookie, origin: "https://evil.example" });
      await expect(
        app.invoke("root", invocation({ headers })),
      ).resolves.toMatchObject({ user: { email: "reader@example.com" } });
      await expect(
        app.invoke("signOut", invocation({ headers })),
      ).rejects.toMatchObject({ code: "PUBLIC_HANDLER_USED_CALLER_SESSION" });
      expect(effects).not.toHaveBeenCalled();
      await expect(
        app.invoke(
          "remappedSignOut",
          invocation({
            headers: new Headers({ "x-machine": "opaque" }),
            browserHeaders: headers,
          }),
        ),
      ).rejects.toMatchObject({ code: "PUBLIC_HANDLER_USED_CALLER_SESSION" });
      expect(effects).not.toHaveBeenCalled();
      await expect(
        app.invoke(
          "signOut",
          invocation({
            headers: new Headers({ cookie, origin: "http://localhost:3000" }),
          }),
        ),
      ).resolves.toMatchObject({ success: true });
      expect(effects).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

it("rejects a forwarding inherit handler without explicit enhancer coverage", async () => {
  @Injectable()
  class Uncovered {
    @ForwardAuthCookies() nestedForward() {}
  }
  await expect(realPipeline(Uncovered)).rejects.toMatchObject({
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "FIXTURE_UNGUARDED" }),
    ]),
  });
});

it("keeps concurrent invocation readers isolated and ignores stale args adapters", async () => {
  const source: PrincipalSource = {
    id: "machine",
    kinds: ["machine"],
    acceptance: "explicit",
    resolve: async (request) => ({
      outcome: "authenticated",
      principal: {
        kind: "machine",
        source: "machine",
        userId: null,
        keyId: request.headers.get("x-key"),
      },
    }),
  };
  @Injectable()
  @UseBetterAuth()
  class Reader {
    constructor(
      @Inject(getBetterAuthServiceToken())
      private readonly service: BetterAuthService,
    ) {}
    @AcceptPrincipals("machine") async root(
      @CurrentPrincipal() principal: unknown,
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      expect(await this.service.getPrincipal()).toBe(principal);
      return principal;
    }
    nested(@CurrentPrincipal() principal: unknown) {
      return principal;
    }
  }
  const app = await realPipeline(Reader, { sources: [source] });
  try {
    const carrier = {};
    const a = invocation({
      carrier,
      position: "1:a",
      headers: new Headers({ "x-key": "a" }),
    });
    const b = invocation({
      carrier,
      position: "2:b",
      headers: new Headers({ "x-key": "b" }),
    });
    await expect(
      Promise.all([app.invoke("root", a), app.invoke("root", b)]),
    ).resolves.toMatchObject([{ keyId: "a" }, { keyId: "b" }]);
    // No scope interceptor: carrier metadata from another invocation must not grant its ALS adapter.
    await expect(
      app.invoke(
        "nested",
        invocation({
          carrier,
          key: a.key,
          position: "1:a.child",
          parents: ["1:a"],
        }),
        false,
      ),
    ).resolves.toMatchObject({ keyId: "a" });
    await expect(
      app.invoke(
        "nested",
        invocation({
          carrier,
          key: b.key,
          position: "2:b.child",
          parents: ["2:b"],
        }),
        false,
      ),
    ).resolves.toMatchObject({ keyId: "b" });
  } finally {
    await app.close();
  }
});

it("does not reuse an exact-args reader adapter under a different active invocation", async () => {
  const { readerContext } = await import("./auth-decorators.js");
  const { READER_CONTEXT } = await import("./auth-tokens.js");
  const { RequestScope } = await import("./request-scope.js");
  const { PrincipalReadings } = await import("./principal-readings.js");
  const { ExecutionContextHost } = await import(
    "@nestjs/core/helpers/execution-context-host.js"
  );
  const scope = new RequestScope(),
    readings = new PrincipalReadings(scope),
    arg = {};
  const reading = () => ({
    outcome: "no-identity" as const,
    instance: "first",
  });
  Object.defineProperty(arg, READER_CONTEXT, {
    value: { args: [arg], scope, readings, reading },
  });
  const context = new ExecutionContextHost([arg]);
  const foreign = {
    view: {
      cookies: null,
      forward: "none" as const,
      inbound: undefined,
      internal: false,
      browserHeaders: undefined,
    },
    reading: () => ({ outcome: "no-identity" as const, instance: "second" }),
  };
  scope.run(foreign, () =>
    expect(readerContext(context).readings).not.toBe(readings),
  );
});

it("allows optional absence but never downgrades a rejected presented credential", async () => {
  const { AuthFailures } = await import("./auth-errors.js");
  const source: PrincipalSource = {
    id: "machine",
    kinds: ["machine"],
    acceptance: "explicit",
    resolve: async (request) =>
      request.headers.has("x-key")
        ? {
            outcome: "rejected",
            failure: AuthFailures.forbidden("INVALID_KEY"),
          }
        : { outcome: "absent" },
  };
  @Injectable()
  @UseBetterAuth()
  class Reader {
    @OptionalAuth() @AcceptPrincipals("machine") root(
      @CurrentPrincipal() principal: unknown,
    ) {
      return principal;
    }
  }
  const app = await realPipeline(Reader, { sources: [source] });
  try {
    await expect(app.invoke("root", invocation())).resolves.toBeNull();
    await expect(
      app.invoke(
        "root",
        invocation({ headers: new Headers({ "x-key": "invalid" }) }),
      ),
    ).rejects.toMatchObject({ status: 403, reason: "INVALID_KEY" });
  } finally {
    await app.close();
  }
});

it("deduplicates synchronous projection failures on scope-less nested invocations", async () => {
  const { IntrinsicException } = await import(
    "@nestjs/common/exceptions/intrinsic.exception.js"
  );
  @Injectable()
  @UseBetterAuth()
  class Reader {
    @AcceptPrincipals("machine") root(@CurrentPrincipal() principal: unknown) {
      return principal;
    }
    nested(@CurrentSession() session: unknown) {
      return session;
    }
  }
  const app = await realPipeline(Reader, { sources: [machine] });
  try {
    const root = invocation();
    await app.invoke("root", root);
    const capture = async (position: string) => {
      try {
        await app.invoke(
          "nested",
          invocation({
            key: root.key,
            carrier: root.carrier,
            parents: ["1:root"],
            position,
          }),
          false,
        );
      } catch (error) {
        return error;
      }
      throw new Error("Expected a constrained reader failure");
    };
    const first = await capture("1:root.0.field"),
      second = await capture("1:root.1.field");
    expect(first).toMatchObject({ code: "SESSION_REQUIRED" });
    expect(first).not.toBeInstanceOf(IntrinsicException);
    expect(second).toBeInstanceOf(IntrinsicException);
    expect(second).toMatchObject({
      code: "SESSION_REQUIRED",
      message: "Authentication is misconfigured",
    });
  } finally {
    await app.close();
  }
});

it("inherits another instance identity while direct calls consult the target instance origin rules", async () => {
  const secondary = createTestAuth({ advanced: { cookiePrefix: "secondary" } });
  @Injectable()
  @UseBetterAuth()
  class Reader {
    constructor(
      @Inject(getBetterAuthServiceToken("secondary"))
      private readonly secondaryService: BetterAuthService,
    ) {}
    @UseAuthInstance("secondary") @AcceptPrincipals("machine") root(
      @CurrentPrincipal() principal: unknown,
    ) {
      return principal;
    }
    nestedPrincipal(@CurrentPrincipal() principal: unknown) {
      return principal;
    }
    nestedSession(@CurrentSession() session: unknown) {
      return session;
    }
    @AcceptPrincipals("machine") crossInstanceSignOut(
      @Input() input: Invocation,
    ) {
      return (this.secondaryService.api as typeof secondary.api).signOut({
        headers: input.headers,
      });
    }
  }
  const app = await realPipeline(Reader, {
    sources: [machine],
    extraModules: [
      BetterAuthModule.forRoot({
        name: "secondary",
        auth: secondary,
        principals: [machine],
        http: { mount: false },
        originCheck: { mode: "off" },
        logSummary: false,
      }),
    ],
  });
  try {
    const root = invocation();
    const principal = await app.invoke("root", root);
    const child = invocation({
      key: root.key,
      carrier: root.carrier,
      parents: ["1:root"],
      position: "1:root.child",
    });
    await expect(app.invoke("nestedPrincipal", child)).resolves.toBe(principal);
    await expect(
      app.invoke("nestedSession", { ...child, position: "1:root.session" }),
    ).rejects.toMatchObject({ code: "SESSION_REQUIRED" });
    const created = await secondary.api.signUpEmail({
      body: {
        email: "secondary@example.com",
        password: "another-long-private-password",
        name: "Secondary",
      },
      returnHeaders: true,
    });
    const cookie = created.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    // The default plan's advisory cookie check denies this origin; the target instance's explicit opt-out applies to its direct call.
    await expect(
      app.invoke(
        "crossInstanceSignOut",
        invocation({
          headers: new Headers({ cookie, origin: "https://evil.example" }),
        }),
      ),
    ).resolves.toMatchObject({ success: true });
  } finally {
    await app.close();
  }
});

it("publishes policy values only to their own invocation, never an inheriting child", async () => {
  const { defineInvocationParam, Require, requirement } = await import(
    "./auth-decorators.js"
  );
  const slot = Symbol("selected resource"),
    Resource = defineInvocationParam(slot, {
      missing: "No resource decision on this invocation",
    });
  const policy: import("./auth-contracts.js").AuthorizationPolicy = {
    id: "provide",
    requires: { principals: ["machine"] },
    evaluate(_params, context) {
      context.provide(
        slot,
        context.execution.getArgByIndex<Invocation>(0).position,
      );
      return { effect: "allow" };
    },
  };
  @Injectable()
  @UseBetterAuth()
  class Reader {
    @Require(requirement(policy, {})) root(@Resource() value: unknown) {
      return value;
    }
    nested(@Resource() value: unknown) {
      return value;
    }
  }
  const app = await realPipeline(Reader, { sources: [machine] });
  try {
    const a = invocation({ position: "1:a" }),
      b = invocation({ key: a.key, carrier: a.carrier, position: "1:b" });
    await expect(
      Promise.all([app.invoke("root", a), app.invoke("root", b)]),
    ).resolves.toEqual(["1:a", "1:b"]);
    await expect(
      app.invoke(
        "nested",
        invocation({
          key: a.key,
          carrier: a.carrier,
          position: "1:a.child",
          parents: ["1:a"],
        }),
      ),
    ).rejects.toMatchObject({ code: "NO_INVOCATION_VALUE" });
  } finally {
    await app.close();
  }
});
