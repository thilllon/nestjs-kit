import { betterAuth } from "better-auth";
import { describe, expect, it, vi } from "vitest";
import type { AuthContextView } from "./auth-contracts.js";
import { originChecksDisabled, TrustedOrigins } from "./trusted-origins.js";

const secret = "a-test-secret-long-enough-for-better-auth";
async function context(
  options: Parameters<typeof betterAuth>[0] = {},
): Promise<AuthContextView> {
  return (await betterAuth({
    baseURL: "https://app.example",
    secret,
    logger: { disabled: true },
    advanced: { disableOriginCheck: false },
    ...options,
  }).$context) as unknown as AuthContextView;
}

describe("TrustedOrigins with better-auth 1.7.5", () => {
  it("uses SDK matching for full Referers, wildcard hosts and custom schemes", async () => {
    const ctx = await context({
      trustedOrigins: ["https://*.example.org", "mobile://"],
    });
    const origins = new TrustedOrigins(async () => ctx);
    expect(
      await origins.isTrusted("https://app.example/reset?token=private"),
    ).toBe(true);
    expect(await origins.isTrusted("https://team.example.org/path")).toBe(true);
    expect(await origins.isTrusted("mobile://callback")).toBe(true);
    expect(await origins.isTrusted("https://app.example.evil.test")).toBe(
      false,
    );
    expect(await origins.isTrusted("/relative")).toBe(false);
  });

  it("merges post-init plugin origins and invokes function options with the actual request", async () => {
    const dynamic = vi.fn((request?: Request) =>
      request?.headers.get("x-tenant") === "a"
        ? ["https://tenant.example"]
        : [],
    );
    const ctx = await context({
      trustedOrigins: dynamic,
      plugins: [
        {
          id: "origin-test",
          init: () => ({
            options: { trustedOrigins: ["https://plugin.example"] },
          }),
        },
      ],
    });
    const origins = new TrustedOrigins(async () => ctx);
    const request = new Request("https://app.example/resource", {
      headers: { "x-tenant": "a" },
    });
    expect(await origins.isTrusted("https://tenant.example", request)).toBe(
      true,
    );
    expect(dynamic).toHaveBeenCalledWith(request);
    expect(await origins.isTrusted("https://plugin.example", request)).toBe(
      true,
    );
    expect(
      await origins.isTrusted(
        "https://tenant.example",
        new Request("https://app.example/"),
      ),
    ).toBe(false);
  });

  it("never trusts a request-dependent function's no-request result", async () => {
    const calls: (string | null)[] = [];
    const tenants = (request?: Request) => {
      calls.push(request ? new URL(request.url).host : null);
      return request
        ? [`https://app.${new URL(request.url).hostname}`]
        : ["https://app.a.example", "https://app.b.example"];
    };
    const request = new Request("https://b.example/transfer");
    for (const options of [
      { baseURL: "https://b.example" },
      {
        baseURL: {
          allowedHosts: ["b.example", "localhost:3000"],
          fallback: "https://fallback.example",
        },
      },
    ] satisfies Parameters<typeof betterAuth>[0][]) {
      const ctx = await context({ ...options, trustedOrigins: tenants });
      expect(calls).toEqual([null]);
      calls.length = 0;
      const origins = new TrustedOrigins(async () => ctx);
      expect(await origins.isTrusted("https://app.a.example", request)).toBe(
        false,
      );
      expect(await origins.isTrusted("https://app.b.example", request)).toBe(
        true,
      );
      expect(await origins.isTrusted("https://b.example", request)).toBe(true);
      expect(calls.every((host) => host === "b.example")).toBe(true);
      calls.length = 0;
    }
    const dynamic = await context({
      baseURL: {
        allowedHosts: ["b.example", "localhost:3000"],
        fallback: "https://fallback.example",
      },
      trustedOrigins: tenants,
    });
    const list = await new TrustedOrigins(async () => dynamic).list(request);
    expect(list).toEqual(
      expect.arrayContaining([
        "https://b.example",
        "https://localhost:3000",
        "http://localhost:3000",
        "https://fallback.example",
        "https://app.b.example",
      ]),
    );
    expect(list).not.toContain("http://b.example");
    expect(list).not.toContain("https://app.a.example");
  });

  it("keeps plugin and environment origins beside a function option", async () => {
    const previous = process.env.BETTER_AUTH_TRUSTED_ORIGINS;
    process.env.BETTER_AUTH_TRUSTED_ORIGINS = "https://env.example";
    try {
      const ctx = await context({
        trustedOrigins: (request?: Request) =>
          request ? [] : ["https://init-only.example"],
        plugins: [
          {
            id: "origin-test",
            init: () => ({
              options: { trustedOrigins: ["https://plugin.example"] },
            }),
          },
        ],
      });
      const request = new Request("https://app.example/");
      const origins = new TrustedOrigins(async () => ctx);
      for (const [origin, trusted] of [
        ["https://app.example", true],
        ["https://plugin.example", true],
        ["https://env.example", true],
        ["https://init-only.example", false],
      ] as const) {
        expect(await origins.isTrusted(origin, request)).toBe(trusted);
      }
    } finally {
      if (previous === undefined) {
        delete process.env.BETTER_AUTH_TRUSTED_ORIGINS;
      } else {
        process.env.BETTER_AUTH_TRUSTED_ORIGINS = previous;
      }
    }
  });

  it("trusts a leg's origin only for a genuinely unset baseURL", async () => {
    const fixed = await context();
    const unset = {
      ...fixed,
      baseURL: "",
      trustedOrigins: [],
      options: { ...fixed.options, baseURL: undefined },
    };
    const request = new Request("https://leg.example/path");
    expect(
      await new TrustedOrigins(async () => unset).isTrusted(
        "https://leg.example",
        request,
      ),
    ).toBe(true);
    const dynamic = await context({
      baseURL: {
        allowedHosts: ["app.example"],
        protocol: "https",
        fallback: "https://app.example",
      },
    });
    expect(
      await new TrustedOrigins(async () => dynamic).isTrusted(
        "https://leg.example",
        request,
      ),
    ).toBe(false);
  });

  it.each([
    [false, false, undefined, false],
    [true, false, undefined, true],
    [true, false, false, false],
    [true, true, true, true],
    [false, true, true, true],
    [["/sign-out"], false, undefined, false],
  ] as const)(
    "uses one kernel skip predicate: %s / %s / %s",
    async (skipOriginCheck, skipCSRFCheck, disableCSRFCheck, disabled) => {
      const ctx = await context();
      expect(
        originChecksDisabled({
          ...ctx,
          skipOriginCheck,
          skipCSRFCheck,
          options: { ...ctx.options, advanced: { disableCSRFCheck } },
        }),
      ).toBe(disabled);
    },
  );
});
