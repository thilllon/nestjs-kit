import {
  betterAuth,
  type BetterAuthPlugin,
  type HookEndpointContext,
} from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
} from "better-auth/api";
import { describe, expect, it } from "vitest";
import type {
  BridgeBinding,
  BridgeHandle,
  CompiledHook,
} from "./bridge-protocol.js";
import { nestjs } from "./plugin.js";
import { runAfter } from "./hook-dispatcher.js";

const targets = ["user", "session", "account", "verification"].flatMap(
  (model) => ["create", "update", "delete"].map((op) => `${model}.${op}`),
);
function makeBinding(
  before: CompiledHook[],
  after: CompiledHook[],
): BridgeBinding {
  return {
    owner: { description: "parity" },
    instance: "default",
    state: "bootstrapped",
    current: () => undefined,
    credentialHeaders: [],
    before,
    after,
    database: Object.fromEntries(
      targets.map((target) => [target, { before: [], after: [] }]),
    ) as unknown as BridgeBinding["database"],
    onDropped: () => undefined,
  };
}

function hook(
  run: (ctx: HookEndpointContext) => unknown,
  matches: CompiledHook["matches"] = () => true,
): CompiledHook {
  return { matches, run: async (ctx) => run(ctx) };
}

function setup(native: boolean, before: CompiledHook[], after: CompiledHook[]) {
  const plugin = nestjs();
  const bridge = (plugin as unknown as Record<symbol, BridgeHandle>)[
    Symbol.for("nestjs-slightly-better-auth:bridge")
  ];
  bridge.bind(makeBinding(before, after));
  const nativePlugins: BetterAuthPlugin[] = [
    ...before.map((item, index) => ({
      id: `before-${index}`,
      hooks: {
        before: [
          {
            matcher: (ctx: HookEndpointContext) => item.matches(ctx, undefined),
            handler: createAuthMiddleware(item.run),
          },
        ],
      },
    })),
    ...after.map((item, index) => ({
      id: `after-${index}`,
      hooks: {
        after: [
          {
            matcher: (ctx: HookEndpointContext) => item.matches(ctx, undefined),
            handler: createAuthMiddleware(item.run),
          },
        ],
      },
    })),
  ];
  const endpoint = createAuthEndpoint(
    "/probe",
    {
      method: "POST",
      body: {
        "~standard": {
          version: 1,
          vendor: "parity",
          validate: (value: unknown) => ({
            value: value as Record<string, unknown>,
          }),
        },
      },
    },
    async (ctx) => {
      ctx.setHeader("x-endpoint", "yes");
      return ctx.json({
        body: ctx.body,
        input: ctx.headers?.get("x-input"),
        original: ctx.headers?.get("x-original"),
      });
    },
  );
  const auth = betterAuth({
    baseURL: "https://auth.test",
    secret: "parity-secret-at-least-thirty-two-characters",
    logger: { disabled: true },
    plugins: [
      { id: "probe", endpoints: { probe: endpoint } },
      ...(native ? nativePlugins : [plugin]),
    ],
  });
  return { auth, bridge };
}

async function dispatch(
  native: boolean,
  before: CompiledHook[],
  after: CompiledHook[] = [],
) {
  const { auth } = setup(native, before, after);
  const result = await auth.api.probe({
    body: { original: true, items: [0] },
    headers: new Headers({ "x-original": "kept" }),
    returnHeaders: true,
  });
  return { response: result.response, headers: [...result.headers] };
}

describe("native SDK endpoint hook parity", () => {
  it("merges context, replaces arrays, and gives every before method original input", async () => {
    const execute = async (native: boolean) => {
      const seen: unknown[] = [];
      const result = await dispatch(native, [
        hook((ctx) => {
          seen.push(ctx.body);
          return {
            context: {
              body: { first: true, items: [1, 2] },
              headers: new Headers({ "x-input": "first" }),
            },
          };
        }),
        hook((ctx) => {
          seen.push(ctx.body);
          return {
            context: {
              body: { second: true, items: [3] },
              headers: new Headers({ "x-input": "second" }),
            },
          };
        }),
      ]);
      return { result, seen };
    };
    const native = await execute(true);
    expect(await execute(false)).toEqual(native);
    expect(native.result.response).toEqual({
      body: { original: true, first: true, second: true, items: [3] },
      input: "second",
      original: "kept",
    });
    expect(native.seen).toEqual([
      { original: true, items: [0] },
      { original: true, items: [0] },
    ]);
  });

  it.each([false, true])(
    "matches before cookie/header loss with short circuit = %s",
    async (shortCircuit) => {
      const hooks = [
        hook((ctx) => {
          ctx.setCookie!("before", "one");
          ctx.setHeader!("x-before", "yes");
        }),
      ];
      if (shortCircuit) {
        hooks.push(hook(() => ({ short: true })));
      }
      const native = await dispatch(true, hooks);
      expect(await dispatch(false, hooks)).toEqual(native);
      expect(new Headers(native.headers).get("x-before")).toBe(
        shortCircuit ? "yes" : null,
      );
      expect(new Headers(native.headers).getSetCookie()).toHaveLength(
        shortCircuit ? 1 : 0,
      );
    },
  );

  it("short circuits remaining before hooks and all after hooks", async () => {
    for (const native of [true, false]) {
      const { auth, bridge } = setup(
        native,
        [
          hook(() => ({ short: true })),
          hook(() => {
            throw new Error("must skip");
          }),
        ],
        [
          hook(() => {
            throw new Error("must skip");
          }),
        ],
      );
      const result = await auth.api.probe({ body: {} });
      expect(result).toEqual({ short: true });
      expect(bridge.producedByEndpoint(result)).toBe(false);
    }
  });

  it("preserves direct thrown APIError symbol headers even without enumerable headers", async () => {
    const execute = async (native: boolean) => {
      const error = new APIError("FORBIDDEN", { message: "blocked" });
      const { auth } = setup(
        native,
        [
          hook((ctx) => {
            ctx.setCookie!("cleanup", "done");
            ctx.setHeader!("x-denial", "yes");
            throw error;
          }),
        ],
        [],
      );
      const caught = await auth.api
        .probe({ body: {} })
        .catch((failure: unknown) => failure);
      expect(caught).toBe(error);
      expect([...new Headers(error.headers)]).toEqual([]);
      const attached = (error as unknown as Record<symbol, Headers>)[
        Symbol.for("better-call:api-error-headers")
      ];
      expect(attached.getSetCookie()).toEqual(["cleanup=done"]);
      return [...attached];
    };
    expect(await execute(false)).toEqual(await execute(true));
  });

  it("compares router delivery separately from direct APIError header preservation", async () => {
    const execute = async (native: boolean) => {
      let afterRuns = 0;
      const { auth } = setup(
        native,
        [
          hook((ctx) => {
            ctx.setCookie!("cleanup", "done");
            throw new APIError("FORBIDDEN", { message: "blocked" });
          }),
        ],
        [
          hook(() => {
            afterRuns++;
          }),
        ],
      );
      // A thrown before-hook skips every after-hook, so the cookie bridge never sees its headers. [R7:BA-r7-02]
      await auth.api.probe({ body: {} }).catch(() => undefined);
      const response = await auth.handler(
        new Request("https://auth.test/api/auth/probe", {
          method: "POST",
          headers: {
            origin: "https://auth.test",
            "content-type": "application/json",
          },
          body: "{}",
        }),
      );
      return {
        status: response.status,
        cookies: response.headers.getSetCookie(),
        body: await response.json(),
        afterRuns,
      };
    };
    const native = await execute(true);
    expect(await execute(false)).toEqual(native);
    expect(native.status).toBe(403);
    expect(native.cookies).toEqual([]);
    expect(native.afterRuns).toBe(0);
    // Control: the same after-hook runs on both paths when no before-hook throws.
    for (const nativeHooks of [true, false]) {
      let runs = 0;
      const { auth } = setup(
        nativeHooks,
        [],
        [
          hook(() => {
            runs++;
          }),
        ],
      );
      await auth.api.probe({ body: {} });
      expect(runs).toBe(1);
    }
  });

  it("replaces after values and exposes earlier replacement to later hooks", async () => {
    const hooks = [
      hook((ctx) => {
        ctx.setCookie!("after", "one");
        return { replaced: 1 };
      }),
      hook((ctx) => ({ previous: ctx.context.returned, replaced: 2 })),
    ];
    const native = await dispatch(true, [], hooks);
    expect(await dispatch(false, [], hooks)).toEqual(native);
    expect(native.response).toEqual({ previous: { replaced: 1 }, replaced: 2 });
    expect(new Headers(native.headers).getSetCookie()).toEqual(["after=one"]);
  });

  it("evaluates each after predicate once against preceding replacements", async () => {
    const execute = async (native: boolean) => {
      const events: unknown[] = [];
      const { auth } = setup(
        native,
        [],
        [
          hook(
            () => ({ replaced: true }),
            () => {
              events.push("first predicate");
              return true;
            },
          ),
          hook(
            () => undefined,
            (ctx) => {
              events.push(ctx.context.returned);
              return false;
            },
          ),
          hook(
            () => ({ final: true }),
            (ctx) => {
              events.push(ctx.context.returned);
              return true;
            },
          ),
        ],
      );
      expect(await auth.api.probe({ body: {} })).toEqual({ final: true });
      return events;
    };
    const native = await execute(true);
    expect(await execute(false)).toEqual(native);
    expect(native).toEqual([
      "first predicate",
      { replaced: true },
      { replaced: true },
    ]);
  });

  it.each([new Error("predicate"), new APIError("FORBIDDEN"), undefined])(
    "propagates a standalone dispatcher matcher failure without a relay: %s",
    async (failure) => {
      const { auth } = setup(
        true,
        [],
        [
          hook(async (ctx) => {
            await expect(
              runAfter(
                makeBinding(
                  [],
                  [
                    hook(
                      () => {
                        throw new Error("must skip handler");
                      },
                      () => {
                        throw failure;
                      },
                    ),
                  ],
                ),
                ctx,
                undefined,
              ),
            ).rejects.toBe(failure);
          }),
        ],
      );
      await auth.api.probe({ body: {} });
    },
  );

  it("continues after APIError and merges attached and explicit error headers once", async () => {
    const execute = async (native: boolean) => {
      const seen: unknown[] = [];
      const { auth } = setup(
        native,
        [],
        [
          hook((ctx) => {
            ctx.setCookie!("first", "one");
            throw new APIError(
              "FORBIDDEN",
              { message: "blocked" },
              new Headers({ "x-error": "yes", "set-cookie": "explicit=two" }),
            );
          }),
          hook((ctx) => {
            seen.push((ctx.context.returned as APIError).statusCode);
            ctx.setCookie!("later", "three");
          }),
        ],
      );
      const error = await auth.api
        .probe({ body: {} })
        .catch((failure: APIError) => failure);
      const headers = (error as unknown as Record<symbol, Headers>)[
        Symbol.for("better-call:api-error-headers")
      ];
      return {
        seen,
        status: (error as APIError).statusCode,
        headers: [...headers],
      };
    };
    const native = await execute(true);
    expect(await execute(false)).toEqual(native);
    expect(native.seen).toEqual([403]);
    expect(new Headers(native.headers).getSetCookie()).toEqual([
      "first=one",
      "explicit=two",
      "later=three",
    ]);
  });

  it.each(["before", "after"] as const)(
    "matches throwing %s predicates",
    async (phase) => {
      const execute = async (native: boolean) => {
        const failure = new Error("predicate failure");
        const hooks = [
          hook(
            () => undefined,
            () => {
              throw failure;
            },
          ),
        ];
        const { auth } = setup(
          native,
          phase === "before" ? hooks : [],
          phase === "after" ? hooks : [],
        );
        const error = await auth.api
          .probe({ body: {} })
          .catch((value: unknown) => value);
        if (phase === "after") {
          expect(error).toBe(failure);
        }
        return {
          message: (error as Error).message,
          status: (error as APIError).statusCode,
        };
      };
      expect(await execute(false)).toEqual(await execute(true));
    },
  );

  it("exposes earlier before response headers without duplicating cookies", async () => {
    const hooks = [
      hook((ctx) => {
        ctx.setCookie!("first", "one");
        ctx.setHeader!("x-before", "visible");
      }),
      hook((ctx) => ({
        previous: [...ctx.context.responseHeaders!],
        local: [...ctx.responseHeaders!],
      })),
    ];
    const native = await dispatch(true, hooks);
    expect(await dispatch(false, hooks)).toEqual(native);
    expect(native.response).toEqual({
      previous: [
        ["set-cookie", "first=one"],
        ["x-before", "visible"],
      ],
      local: [],
    });
    expect(new Headers(native.headers).getSetCookie()).toEqual(["first=one"]);
  });

  it("does not attach previous before hooks' headers to a later APIError", async () => {
    const execute = async (native: boolean) => {
      const { auth } = setup(
        native,
        [
          hook((ctx) => {
            ctx.setCookie!("previous", "one");
          }),
          hook((ctx) => {
            ctx.setCookie!("throwing", "two");
            throw new APIError("FORBIDDEN");
          }),
        ],
        [],
      );
      const error = await auth.api
        .probe({ body: {} })
        .catch((value: unknown) => value);
      return (error as Record<symbol, Headers>)[
        Symbol.for("better-call:api-error-headers")
      ].getSetCookie();
    };
    expect(await execute(false)).toEqual(await execute(true));
    expect(await execute(false)).toEqual(["throwing=two"]);
  });

  it("deduplicates redirect cookies when APIError headers alias the attached symbol", async () => {
    const execute = async (native: boolean) => {
      const { auth } = setup(
        native,
        [],
        [
          hook((ctx) => {
            ctx.setCookie!("redirect", "one");
            throw ctx.redirect!("https://bridge.test/done");
          }),
        ],
      );
      const error = await auth.api
        .probe({ body: {} })
        .catch((value: unknown) => value);
      return [
        ...(error as Record<symbol, Headers>)[
          Symbol.for("better-call:api-error-headers")
        ],
      ];
    };
    const native = await execute(true);
    expect(await execute(false)).toEqual(native);
    expect(new Headers(native).getSetCookie()).toEqual(["redirect=one"]);
    expect(new Headers(native).get("location")).toBe(
      "https://bridge.test/done",
    );
  });

  it.each(["before", "after"] as const)(
    "propagates raw %s method failures and skips unmatched methods",
    async (phase) => {
      for (const native of [true, false]) {
        const error = new Error("raw hook error");
        const hooks = [
          hook(
            () => {
              throw new Error("unmatched");
            },
            () => false,
          ),
          hook(() => {
            throw error;
          }),
        ];
        const { auth } = setup(
          native,
          phase === "before" ? hooks : [],
          phase === "after" ? hooks : [],
        );
        await expect(auth.api.probe({ body: {} })).rejects.toBe(error);
      }
    },
  );

  it("matches many generated context and replacement sequences", async () => {
    for (let seed = 0; seed < 18; seed++) {
      const before = Array.from({ length: 1 + (seed % 5) }, (_, index) =>
        hook(() => ({
          context: {
            body: { [`key${index % 3}`]: seed + index, items: [seed, index] },
            headers: new Headers({
              [`x-generated-${index % 2}`]: String(index),
            }),
          },
        })),
      );
      const after = Array.from({ length: seed % 4 }, (_, index) =>
        hook((ctx) => {
          ctx.setCookie!(`generated${index}`, String(seed));
          return { seed, index };
        }),
      );
      expect(await dispatch(false, before, after)).toEqual(
        await dispatch(true, before, after),
      );
    }
  });
});
