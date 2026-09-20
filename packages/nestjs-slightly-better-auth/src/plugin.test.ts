import { betterAuth, type BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  getShouldSkipSessionRefresh,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BridgeBinding,
  BridgeHandle,
  CompiledHook,
  ScopeView,
} from "./bridge-protocol.js";
import { nestjs } from "./plugin.js";

function binding(): BridgeBinding {
  return {
    owner: { description: "first app" },
    instance: "default",
    state: "initialized",
    current: () => undefined,
    credentialHeaders: [],
    before: [],
    after: [],
    database: {
      "user.create": { before: [], after: [] },
      "user.update": { before: [], after: [] },
      "user.delete": { before: [], after: [] },
      "session.create": { before: [], after: [] },
      "session.update": { before: [], after: [] },
      "session.delete": { before: [], after: [] },
      "account.create": { before: [], after: [] },
      "account.update": { before: [], after: [] },
      "account.delete": { before: [], after: [] },
      "verification.create": { before: [], after: [] },
      "verification.update": { before: [], after: [] },
      "verification.delete": { before: [], after: [] },
    },
    onDropped: () => undefined,
  };
}

function handle(plugin: ReturnType<typeof nestjs>): BridgeHandle {
  return (plugin as unknown as Record<symbol, BridgeHandle>)[
    Symbol.for("nestjs-slightly-better-auth:bridge")
  ];
}

describe("construction-time bridge", () => {
  it("retains security hooks after close and rejects a second live owner", () => {
    const bridge = handle(nestjs());
    const first = binding();
    const registration = bridge.bind(first);
    first.state = "bootstrapped";
    expect(() =>
      bridge.bind({ ...first, owner: { description: "other app" } }),
    ).toThrow("INSTANCE_ALREADY_BOUND");
    registration.close();
    expect(bridge.state).toBe("closed");
    expect(
      bridge.bind({ ...binding(), owner: { description: "next app" } })
        .tookOverFrom,
    ).toBeUndefined();
  });
});

const base = {
  baseURL: "https://bridge.test",
  secret: "bridge-test-secret-at-least-thirty-two-characters",
  logger: { disabled: true },
} as const;
function probe(plugin: BetterAuthPlugin, effect: () => void = () => undefined) {
  return betterAuth({
    ...base,
    advanced: {
      useSecureCookies: true,
      cookies: { session_token: { name: "custom_session" } },
    },
    plugins: [
      {
        id: "probe",
        endpoints: {
          probe: createAuthEndpoint(
            "/probe",
            { method: "GET" },
            async (ctx) => {
              effect();
              ctx.setCookie("endpoint", "one");
              return ctx.json({ endpoint: true });
            },
          ),
        },
      },
      plugin,
    ],
  });
}
function scope(overrides: Partial<ScopeView> = {}): ScopeView {
  return {
    cookies: { append: () => true },
    forward: "same-credential",
    inbound: () => new Headers(),
    browserHeaders: undefined,
    internal: false,
    ...overrides,
  };
}

describe("fixed plugin entries with the SDK", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps fixed hook arrays, returns the same registration and warns only on failed-init takeover", async () => {
    const plugin = nestjs();
    const bridge = handle(plugin);
    const before = plugin.hooks!.before!;
    const after = plugin.hooks!.after!;
    Object.freeze(before);
    Object.freeze(after);
    const auth = probe(plugin);
    await auth.api.probe({});
    expect(bridge.unboundDispatches).toBe(1);
    expect(bridge.state).toBe("unbound");
    const first = binding();
    const registration = bridge.bind(first);
    expect(bridge.unboundDispatches).toBe(0);
    expect(bridge.bind({ ...first })).toBe(registration);
    expect(() => bridge.bind({ ...first, instance: "other" })).toThrow(
      "PLUGIN_SHARED_BETWEEN_INSTANCES",
    );
    const second = bridge.bind({
      ...binding(),
      owner: { description: "replacement" },
    });
    expect(second.tookOverFrom).toBe("first app");
    registration.close();
    expect(bridge.state).toBe("bound");
    second.close();
    expect(bridge.state).toBe("closed");
    expect(plugin.hooks!.before).toBe(before);
    expect(plugin.hooks!.after).toBe(after);
    expect(before).toHaveLength(3);
    expect(after).toHaveLength(3);
    expect(auth.options).not.toHaveProperty("databaseHooks");
  });

  it("retains endpoint security hooks after close and exposes the same symbol handle via getPlugin", async () => {
    const plugin = nestjs();
    const bridge = handle(plugin);
    const auth = probe(plugin);
    const registration = bridge.bind({
      ...binding(),
      before: [
        {
          matches: () => true,
          run: async () => {
            throw new APIError("FORBIDDEN", { message: "security rule" });
          },
        },
      ],
    });
    expect((await auth.$context).getPlugin(plugin.id)).toBe(plugin);
    await expect(auth.api.probe({})).rejects.toMatchObject({ statusCode: 403 });
    registration.close();
    await expect(auth.api.probe({})).rejects.toMatchObject({ statusCode: 403 });
  });

  it("observes only direct endpoint objects, including Nest after replacements", async () => {
    const plugin = nestjs();
    const bridge = handle(plugin);
    const replacement = { replaced: true };
    bridge.bind({
      ...binding(),
      after: [{ matches: () => true, run: async () => replacement }],
    });
    const auth = probe(plugin);
    expect(await auth.api.probe({})).toBe(replacement);
    expect(bridge.producedByEndpoint(replacement)).toBe(true);
    expect(bridge.producedByEndpoint(null)).toBe(false);
    expect(bridge.producedByEndpoint("primitive")).toBe(false);
    const routerOnly = { routerOnly: true };
    const routerPlugin = nestjs();
    handle(routerPlugin).bind({
      ...binding(),
      after: [{ matches: () => true, run: async () => routerOnly }],
    });
    await probe(routerPlugin).handler(
      new Request("https://bridge.test/api/auth/probe"),
    );
    expect(handle(routerPlugin).producedByEndpoint(routerOnly)).toBe(false);
  });

  it.each([
    ["matcher", "Error"],
    ["matcher", "APIError"],
    ["handler", "Error"],
    ["handler", "APIError"],
  ] as const)(
    "matches native after %s failures for %s across all later entries",
    async (location, kind) => {
      const execute = async (native: boolean) => {
        const plugin = nestjs();
        const bridge = handle(plugin);
        const events: string[] = [];
        const failure =
          kind === "APIError"
            ? new APIError("FORBIDDEN", { message: "hook failed" })
            : new Error("hook failed");
        const endpointResult = { endpoint: true };
        const recovered = { recovered: true };
        const hooks: CompiledHook[] = [
          {
            matches: () => {
              events.push("matcher");
              if (location === "matcher") {
                throw failure;
              }
              return true;
            },
            run: async () => {
              events.push("handler");
              throw failure;
            },
          },
          {
            matches: () => {
              events.push("later matcher");
              return true;
            },
            run: async (ctx) => {
              events.push("later handler");
              expect(ctx.context.returned).toBe(failure);
            },
          },
        ];
        bridge.bind({
          ...binding(),
          after: native ? [] : hooks,
          current: () =>
            scope({
              cookies: {
                append: (cookies) => {
                  events.push("cookies");
                  expect(cookies).toEqual(["endpoint=one"]);
                  return true;
                },
              },
            }),
        });
        Object.freeze(plugin.hooks!.after!);
        const auth = betterAuth({
          ...base,
          plugins: [
            {
              id: "probe",
              endpoints: {
                probe: createAuthEndpoint(
                  "/probe",
                  { method: "GET" },
                  async (ctx) => {
                    events.push("endpoint");
                    ctx.setCookie("endpoint", "one");
                    return ctx.json(endpointResult);
                  },
                ),
              },
            },
            ...(native
              ? [
                  {
                    id: "native-hooks",
                    hooks: {
                      after: hooks.map((item) => ({
                        matcher: (ctx) => item.matches(ctx, undefined),
                        handler: createAuthMiddleware(item.run),
                      })),
                    },
                  } satisfies BetterAuthPlugin,
                ]
              : []),
            plugin,
            {
              id: "later-sdk-plugin",
              hooks: {
                after: [
                  {
                    matcher: () => {
                      events.push("sdk matcher");
                      return true;
                    },
                    handler: createAuthMiddleware(async () => {
                      events.push("sdk handler");
                      return recovered;
                    }),
                  },
                ],
              },
            },
          ],
        });
        const recoverable = location === "handler" && kind === "APIError";
        if (recoverable) {
          expect(await auth.api.probe({})).toBe(recovered);
        } else {
          await expect(auth.api.probe({})).rejects.toBe(failure);
        }
        expect(bridge.producedByEndpoint(endpointResult)).toBe(false);
        expect(bridge.producedByEndpoint(failure)).toBe(recoverable);
        return events;
      };
      const native = await execute(true);
      expect(await execute(false)).toEqual(native);
      expect(native).toEqual(
        location === "handler" && kind === "APIError"
          ? [
              "endpoint",
              "matcher",
              "handler",
              "later matcher",
              "later handler",
              "cookies",
              "sdk matcher",
              "sdk handler",
            ]
          : location === "handler"
            ? ["endpoint", "matcher", "handler"]
            : ["endpoint", "matcher"],
      );
    },
  );

  it.each(["Error", "APIError", "undefined"] as const)(
    "isolates %s matcher failures between concurrent and nested dispatches",
    async (kind) => {
      const execute = async (native: boolean) => {
        const plugin = nestjs();
        const bridge = handle(plugin);
        const failure =
          kind === "APIError"
            ? new APIError("FORBIDDEN")
            : kind === "Error"
              ? new Error("matcher failed")
              : undefined;
        const results = new Map<string, object>();
        const matched: string[] = [];
        const delivered: string[] = [];
        const hooks: CompiledHook[] = [
          {
            matches: (ctx) => {
              const call = ctx.headers!.get("x-call")!;
              matched.push(call);
              if (call === "nested" || call === "concurrent") {
                throw failure;
              }
              return true;
            },
            run: async (ctx) => {
              if (ctx.headers!.get("x-call") === "parent") {
                await expect(
                  auth.api.probe({
                    headers: new Headers({ "x-call": "nested" }),
                  }),
                ).rejects.toBe(failure);
              }
            },
          },
        ];
        bridge.bind({
          ...binding(),
          after: native ? [] : hooks,
          current: () =>
            scope({
              cookies: {
                append: (cookies) => {
                  delivered.push(...cookies);
                  return true;
                },
              },
            }),
        });
        const auth = betterAuth({
          ...base,
          plugins: [
            {
              id: "probe",
              endpoints: {
                probe: createAuthEndpoint(
                  "/probe",
                  { method: "GET" },
                  async (ctx) => {
                    const call = ctx.headers!.get("x-call")!;
                    const result = { call };
                    results.set(call, result);
                    ctx.setCookie("endpoint", call);
                    return ctx.json(result);
                  },
                ),
              },
            },
            ...(native
              ? [
                  {
                    id: "native-hooks",
                    hooks: {
                      after: hooks.map((item) => ({
                        matcher: (ctx) => item.matches(ctx, undefined),
                        handler: createAuthMiddleware(item.run),
                      })),
                    },
                  } satisfies BetterAuthPlugin,
                ]
              : []),
            plugin,
          ],
        });
        const settled = await Promise.allSettled(
          ["parent", "concurrent", "success"].map((call) =>
            auth.api.probe({ headers: new Headers({ "x-call": call }) }),
          ),
        );
        expect(settled[0]).toEqual({
          status: "fulfilled",
          value: { call: "parent" },
        });
        expect(settled[1]).toEqual({ status: "rejected", reason: failure });
        if (settled[1]!.status === "rejected") {
          expect(settled[1]!.reason).toBe(failure);
        }
        expect(settled[2]).toEqual({
          status: "fulfilled",
          value: { call: "success" },
        });
        for (const [call, result] of results) {
          expect(bridge.producedByEndpoint(result)).toBe(
            call === "parent" || call === "success",
          );
        }
        expect(bridge.producedByEndpoint(failure)).toBe(false);
        return { matched: matched.sort(), delivered: delivered.sort() };
      };
      const native = await execute(true);
      expect(await execute(false)).toEqual(native);
      expect(native).toEqual({
        matched: ["concurrent", "nested", "parent", "success"],
        delivered: ["endpoint=parent", "endpoint=success"],
      });
    },
  );

  it.each([
    ["none", {}, true],
    ["same secure cookie", { cookie: "__Secure-custom_session=own" }, true],
    [
      "foreign secure cookie",
      { cookie: "__Secure-custom_session=foreign" },
      false,
    ],
    ["same authorization", { authorization: "Bearer own" }, true],
    ["foreign authorization", { authorization: "Bearer foreign" }, false],
    ["same source header", { "x-api-key": "own" }, true],
    ["foreign source header", { "x-api-key": "foreign" }, false],
  ] as const)(
    "forwards only matching credentials: %s",
    async (_name, headers, expected) => {
      const plugin = nestjs();
      const delivered: string[] = [];
      const dropped: string[] = [];
      const inbound = new Headers(headers);
      if (inbound.has("cookie")) {
        inbound.set("cookie", "__Secure-custom_session=own");
      }
      if (inbound.has("authorization")) {
        inbound.set("authorization", "Bearer own");
      }
      if (inbound.has("x-api-key")) {
        inbound.set("x-api-key", "own");
      }
      handle(plugin).bind({
        ...binding(),
        credentialHeaders: ["X-API-Key"],
        current: () =>
          scope({
            inbound: () => inbound,
            cookies: {
              append: (values) => {
                delivered.push(...values);
                return true;
              },
            },
          }),
        onDropped: (path) => {
          dropped.push(path);
        },
        after: [
          {
            matches: () => true,
            run: async (ctx) => {
              ctx.setCookie!("nest", "two");
            },
          },
        ],
      });
      const auth = probe(plugin);
      expect((await auth.$context).authCookies.sessionToken.name).toBe(
        "__Secure-custom_session",
      );
      await auth.api.probe({ headers: new Headers(headers) });
      expect(delivered).toEqual(expected ? ["endpoint=one", "nest=two"] : []);
      expect(dropped).toEqual(expected ? [] : ["/probe"]);
    },
  );

  it.each(["none", "any"] as const)(
    "honors forwarding mode %s and never bridges router responses",
    async (forward) => {
      const plugin = nestjs();
      const delivered: string[] = [];
      handle(plugin).bind({
        ...binding(),
        current: () =>
          scope({
            forward,
            cookies: {
              append: (cookies) => {
                delivered.push(...cookies);
                return true;
              },
            },
          }),
      });
      const auth = probe(plugin);
      await auth.api.probe({
        headers: new Headers({ authorization: "foreign" }),
      });
      expect(delivered).toEqual(forward === "any" ? ["endpoint=one"] : []);
      delivered.length = 0;
      await auth.handler(new Request("https://bridge.test/api/auth/probe"));
      expect(delivered).toEqual([]);
    },
  );

  it.each([
    "cookies",
    "checkCallerSession",
    "inbound",
    "browserHeaders",
  ] as const)(
    "fails lazy %s extraction before credential-free endpoint effects",
    async (property) => {
      const plugin = nestjs();
      const current = scope();
      Object.defineProperty(current, property, {
        get: () => {
          throw new Error("deferred extraction failed");
        },
      });
      handle(plugin).bind({ ...binding(), current: () => current });
      const effects = vi.fn();
      await expect(probe(plugin, effects).api.probe({})).rejects.toMatchObject({
        statusCode: 500,
      });
      expect(effects).not.toHaveBeenCalled();
    },
  );

  it("checks the browser's ambient cookie even when transport credentials replaced inbound headers", async () => {
    const plugin = nestjs();
    const check = vi.fn(() => {
      throw new Error("PUBLIC_HANDLER_USED_CALLER_SESSION");
    });
    const nestBefore = vi.fn(async () => undefined);
    let internal = false;
    handle(plugin).bind({
      ...binding(),
      current: () =>
        scope({
          internal,
          inbound: () =>
            new Headers({ cookie: "__Secure-custom_session=mapped" }),
          browserHeaders: () =>
            new Headers({ cookie: "__Secure-custom_session=ambient" }),
          checkCallerSession: check,
        }),
      before: [{ matches: () => true, run: nestBefore }],
    });
    const effects = vi.fn();
    const auth = probe(plugin, effects);
    await expect(
      auth.api.probe({
        headers: new Headers({ cookie: "__Secure-custom_session=ambient" }),
      }),
    ).rejects.toThrow("PUBLIC_HANDLER_USED_CALLER_SESSION");
    expect(check).toHaveBeenCalledWith("/probe", "default");
    expect(nestBefore).not.toHaveBeenCalled();
    expect(effects).not.toHaveBeenCalled();
    await auth.api.probe({
      headers: new Headers({ cookie: "__Secure-custom_session=foreign" }),
    });
    expect(check).toHaveBeenCalledTimes(1);
    internal = true;
    await auth.api.probe({
      headers: new Headers({ cookie: "__Secure-custom_session=ambient" }),
    });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("suppresses stateless refresh-cache, including nested session reads, before Nest hooks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-01-01T00:00:00Z");
    vi.setSystemTime(now);
    const plugin = nestjs();
    let current: ScopeView | undefined;
    const flags: (boolean | null)[] = [];
    handle(plugin).bind({
      ...binding(),
      current: () => current,
      before: [
        {
          matches: () => true,
          run: async () => {
            flags.push(await getShouldSkipSessionRefresh());
          },
        },
      ],
    });
    const auth = betterAuth({
      ...base,
      session: {
        cookieCache: {
          enabled: true,
          maxAge: 300,
          refreshCache: { updateAge: 60 },
        },
      },
      plugins: [
        {
          id: "session-fixture",
          endpoints: {
            seed: createAuthEndpoint(
              "/seed",
              { method: "GET" },
              async (ctx) => {
                await setSessionCookie(ctx, {
                  user: {
                    id: "user",
                    name: "Test",
                    email: "test@example.test",
                    emailVerified: true,
                    createdAt: now,
                    updatedAt: now,
                  },
                  session: {
                    id: "session",
                    userId: "user",
                    token: "test-session-token",
                    createdAt: now,
                    updatedAt: now,
                    expiresAt: new Date(now.getTime() + 86400000),
                  },
                });
                return ctx.json({ ok: true });
              },
            ),
            nested: createAuthEndpoint(
              "/nested",
              { method: "GET" },
              async (ctx) => ctx.json(await getSessionFromCtx(ctx)),
            ),
          },
        },
        plugin,
      ],
    });
    const seeded = await auth.api.seed({ returnHeaders: true });
    const headers = new Headers({
      cookie: seeded.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .join("; "),
    });
    vi.setSystemTime(new Date(now.getTime() + 250000));
    const control = await auth.api.getSession({
      headers,
      query: { disableRefresh: true },
      returnHeaders: true,
    });
    expect(control.response?.user.id).toBe("user");
    expect(control.headers.getSetCookie().length).toBeGreaterThan(0);
    current = scope({ cookies: null, forward: "none", inbound: () => headers });
    flags.length = 0;
    const suppressed = await auth.api.getSession({
      headers,
      query: { disableRefresh: true },
      returnHeaders: true,
    });
    expect(suppressed.response?.user.id).toBe("user");
    expect(suppressed.headers.getSetCookie()).toEqual([]);
    const nested = await auth.api.nested({ headers, returnHeaders: true });
    expect(nested.response?.user.id).toBe("user");
    expect(nested.headers.getSetCookie()).toEqual([]);
    expect(flags).toEqual([true, true]);
  });
});
