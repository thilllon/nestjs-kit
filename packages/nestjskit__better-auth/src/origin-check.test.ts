import { inspect } from "node:util";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import type { AuthContextView, BrowserExposure } from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  BetterAuthInfrastructureError,
  getRawCause,
  isInfrastructureError,
} from "./auth-errors.js";
import { OriginCheck, OriginDiagnostics } from "./origin-check.js";
import { RequestScope } from "./request-scope.js";

function browser(headers: HeadersInit = {}, enforce = true): BrowserExposure {
  return {
    headers: () => new Headers(headers),
    enforce,
    key: {},
    url: "https://app.example/resource",
  };
}
async function fixture(
  options: BetterAuthOptions = {},
  instance = "default",
  scope = new RequestScope(),
) {
  const effects = vi.fn();
  const auth = betterAuth({
    baseURL: "https://app.example",
    secret: "a-test-secret-long-enough-for-better-auth",
    logger: { disabled: true },
    advanced: { disableOriginCheck: false },
    ...options,
    plugins: [
      {
        id: "origin-probe",
        endpoints: {
          cookieProbe: createAuthEndpoint(
            "/cookie-probe",
            { method: "POST" },
            async (ctx) => {
              effects();
              return ctx.json({ ok: true });
            },
          ),
          formProbe: createAuthEndpoint(
            "/form-probe",
            { method: ["GET", "POST"], use: [formCsrfMiddleware] },
            async (ctx) => {
              effects();
              return ctx.json({ ok: true });
            },
          ),
        },
      },
      ...(options.plugins ?? []),
    ],
  });
  const context = (await auth.$context) as unknown as AuthContextView;
  const check = new OriginCheck(scope, { context, instance });
  return { auth, context, check, effects, scope };
}

const cases: {
  name: string;
  headers: Record<string, string>;
  cookie?: string;
  form?: string;
}[] = [
  {
    name: "same origin",
    headers: { origin: "https://app.example", cookie: "session=opaque" },
  },
  {
    name: "cross origin cookie",
    headers: { origin: "https://evil.example", cookie: "session=opaque" },
    cookie: "INVALID_ORIGIN",
    form: "INVALID_ORIGIN",
  },
  {
    name: "missing origin cookie",
    headers: { cookie: "session=opaque" },
    cookie: "MISSING_OR_NULL_ORIGIN",
    form: "MISSING_OR_NULL_ORIGIN",
  },
  {
    name: "null origin cookie",
    headers: { origin: "null", cookie: "session=opaque" },
    cookie: "MISSING_OR_NULL_ORIGIN",
    form: "MISSING_OR_NULL_ORIGIN",
  },
  {
    name: "same-origin null inference",
    headers: {
      origin: "null",
      cookie: "session=opaque",
      "sec-fetch-site": "same-origin",
    },
  },
  {
    name: "Referer",
    headers: {
      referer: "https://app.example/path?token=private",
      cookie: "session=opaque",
    },
  },
  {
    name: "cookie and junk token",
    headers: {
      origin: "https://evil.example",
      cookie: "session=opaque",
      authorization: "Bearer junk",
    },
    cookie: "INVALID_ORIGIN",
    form: "INVALID_ORIGIN",
  },
  { name: "cookie-free native", headers: {} },
  {
    name: "cookie-free cross origin",
    headers: { origin: "https://evil.example" },
    form: "INVALID_ORIGIN",
  },
  {
    name: "cookie-free navigation",
    headers: {
      origin: "https://app.example",
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "navigate",
    },
    form: "CROSS_SITE_NAVIGATION_LOGIN_BLOCKED",
  },
  {
    name: "metadata without origin",
    headers: { "sec-fetch-mode": "cors" },
    form: "MISSING_OR_NULL_ORIGIN",
  },
];

describe("origin parity with real SDK routes", () => {
  for (const mode of ["cookie", "form"] as const) {
    it.each(cases)(`${mode}: $name`, async (row) => {
      const { auth, check, effects } = await fixture();
      const leg = browser(row.headers);
      const result = await check.check(leg, mode);
      expect(result?.reason).toBe(row[mode]);
      const response = await auth.handler(
        new Request(`https://app.example/api/auth/${mode}-probe`, {
          method: "POST",
          headers: row.headers,
        }),
      );
      expect(response.status).toBe(row[mode] ? 403 : 200);
      if (row[mode]) {
        expect(await response.json()).toMatchObject({ code: row[mode] });
      }
      expect(effects).toHaveBeenCalledTimes(row[mode] ? 0 : 1);
    });
  }

  it.each(["GET", "HEAD", "OPTIONS"])(
    "always enforces cookie-free form mode for %s forwarding handlers",
    async (method) => {
      const { auth, check, effects } = await fixture();
      const result = await check.check(
        browser({ origin: "https://evil.example" }, false),
        "form",
      );
      expect(result?.reason).toBe("INVALID_ORIGIN");
      if (method === "GET") {
        const response = await auth.handler(
          new Request("https://app.example/api/auth/form-probe", {
            headers: { origin: "https://evil.example" },
          }),
        );
        expect(response.status).toBe(403);
        expect(effects).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      disableOriginCheck: true,
      disableCSRFCheck: undefined,
      kernelDenies: false,
    },
    { disableOriginCheck: true, disableCSRFCheck: false, kernelDenies: true },
    { disableOriginCheck: true, disableCSRFCheck: true, kernelDenies: false },
    { disableOriginCheck: false, disableCSRFCheck: true, kernelDenies: false },
    {
      disableOriginCheck: ["/cookie-probe"],
      disableCSRFCheck: undefined,
      kernelDenies: true,
    },
  ])(
    "pins SDK skip divergence $disableOriginCheck / $disableCSRFCheck",
    async ({ disableOriginCheck, disableCSRFCheck, kernelDenies }) => {
      const { auth, check } = await fixture({
        advanced: {
          disableOriginCheck: disableOriginCheck as boolean,
          disableCSRFCheck,
        },
      });
      const headers = {
        cookie: "session=opaque",
        origin: "https://evil.example",
      };
      expect((await check.check(browser(headers), "cookie"))?.reason).toBe(
        kernelDenies ? "INVALID_ORIGIN" : undefined,
      );
      const response = await auth.handler(
        new Request("https://app.example/api/auth/cookie-probe", {
          method: "POST",
          headers,
        }),
      );
      expect(response.status).toBe(200);
    },
  );

  it.each([
    { origin: "https://app.a.example", denied: "INVALID_ORIGIN" },
    { origin: "https://app.b.example", denied: undefined },
  ])(
    "agrees on a request-dependent trustedOrigins function: $origin",
    async ({ origin, denied }) => {
      const tenants = (request?: Request) =>
        request
          ? [`https://app.${new URL(request.url).hostname}`]
          : ["https://app.a.example", "https://app.b.example"];
      const { auth, check } = await fixture({
        baseURL: "https://b.example",
        trustedOrigins: tenants,
      });
      const headers = { cookie: "session=opaque", origin };
      const leg = {
        ...browser(headers),
        url: "https://b.example/transfer",
      };
      expect((await check.check(leg, "cookie"))?.reason).toBe(denied);
      const response = await auth.handler(
        new Request("https://b.example/api/auth/cookie-probe", {
          method: "POST",
          headers,
        }),
      );
      expect(response.status).toBe(denied ? 403 : 200);
    },
  );
});

it("records safe cookie verdicts as advisory evidence without treating failure as a passing proof", async () => {
  const { check } = await fixture();
  const evil = browser(
    { cookie: "session=opaque", origin: "https://evil.example" },
    false,
  );
  await expect(check.advisory(evil)).resolves.toBeUndefined();
  expect(() => check.assertCallerSession(evil, "/sign-out", "default")).toThrow(
    "Authentication is misconfigured",
  );
  const good = browser(
    { cookie: "session=opaque", origin: "https://app.example" },
    false,
  );
  await check.advisory(good);
  expect(() =>
    check.assertCallerSession(good, "/sign-out", "default"),
  ).not.toThrow();
  expect(() => check.assertCallerSession(good, "/sign-out", "admin")).toThrow();
});

it("infers a same-origin advisory verdict without Origin and Referer, never on enforcing legs", async () => {
  const { auth, check } = await fixture();
  const sameOrigin = {
    cookie: "session=opaque",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
  };
  const safe = browser(sameOrigin, false);
  await check.advisory(safe);
  expect(await check.check(safe, "cookie")).toBeNull();
  expect(() =>
    check.assertCallerSession(safe, "/list-sessions", "default"),
  ).not.toThrow();
  const unsafe = browser(sameOrigin);
  expect((await check.check(unsafe, "cookie"))?.reason).toBe(
    "MISSING_OR_NULL_ORIGIN",
  );
  const router = await auth.handler(
    new Request("https://app.example/api/auth/cookie-probe", {
      method: "POST",
      headers: sameOrigin,
    }),
  );
  expect(router.status).toBe(403);
  // One batched GraphQL request: a query and a mutation share the leg key.
  const shared = {};
  expect(
    await check.check({ ...browser(sameOrigin, false), key: shared }, "cookie"),
  ).toBeNull();
  expect(
    (await check.check({ ...browser(sameOrigin), key: shared }, "cookie"))
      ?.reason,
  ).toBe("MISSING_OR_NULL_ORIGIN");
  for (const site of ["same-site", "cross-site", "none"]) {
    const other = browser({ ...sameOrigin, "sec-fetch-site": site }, false);
    expect((await check.check(other, "cookie"))?.reason).toBe(
      "MISSING_OR_NULL_ORIGIN",
    );
    expect(() =>
      check.assertCallerSession(other, "/list-sessions", "default"),
    ).toThrow();
  }
  const untrustedLeg = {
    ...browser(sameOrigin, false),
    url: "https://other.example/resource",
  };
  expect((await check.check(untrustedLeg, "cookie"))?.reason).toBe(
    "INVALID_ORIGIN",
  );
  expect(
    (
      await check.check(
        browser({ ...sameOrigin, referer: "https://evil.example/page" }, false),
        "cookie",
      )
    )?.reason,
  ).toBe("INVALID_ORIGIN");
});

it("protects the ambient browser cookie even when transport credentials shadow it", async () => {
  const { check } = await fixture();
  const mappedHeaders = new Headers({
    authorization: "Bearer connection-param",
    cookie: "",
  });
  const leg = browser({
    cookie: "session=ambient",
    origin: "https://evil.example",
  });
  expect(mappedHeaders.get("authorization")).toBe("Bearer connection-param");
  expect((await check.check(leg, "cookie"))?.reason).toBe("INVALID_ORIGIN");
});

it("memoizes function-origin I/O by leg, instance and mode; evicts infrastructure failures", async () => {
  const origins = vi.fn(async () => ["https://allowed.example"]);
  const { context, scope } = await fixture({ trustedOrigins: origins });
  origins.mockClear();
  const check = new OriginCheck(scope, { instance: "default", context });
  const leg = browser({
    cookie: "session=opaque",
    origin: "https://allowed.example",
  });
  const first = check.check(leg, "cookie");
  expect(check.check(leg, "cookie")).toBe(first);
  await first;
  expect(origins).toHaveBeenCalledTimes(1);
  await check.check(leg, "form");
  await new OriginCheck(scope, { instance: "admin", context }).check(
    leg,
    "cookie",
  );
  expect(origins).toHaveBeenCalledTimes(3);
  const secret = "credential-that-must-never-be-logged";
  const cause = new Error(`database failed for ${secret}`);
  origins.mockRejectedValue(cause);
  const retryLeg = browser(
    { cookie: `session=${secret}`, origin: "https://allowed.example" },
    false,
  );
  const raw = new OriginCheck(scope, {
    instance: "default",
    context,
    exposeRawCause: true,
  });
  await raw.advisory(retryLeg);
  expect(() =>
    raw.assertCallerSession(retryLeg, "/sign-out", "default"),
  ).toThrow();
  const error = await raw
    .check(retryLeg, "cookie")
    .catch((error: unknown) => error);
  expect(isInfrastructureError(error)).toBe(true);
  expect(inspect(error)).not.toContain(secret);
  expect(getRawCause(error as Parameters<typeof getRawCause>[0])).toBe(cause);
  origins.mockResolvedValue(["https://allowed.example"]);
  await expect(raw.check(retryLeg, "cookie")).resolves.toBeNull();
  expect(() =>
    raw.assertCallerSession(retryLeg, "/sign-out", "default"),
  ).not.toThrow();
});

it("bounds diagnostics per hour and removes Referer paths and queries", async () => {
  const warn = vi.fn();
  const debug = vi.fn();
  const diagnostics = new OriginDiagnostics({ warn, debug });
  const { context } = await fixture();
  const check = new OriginCheck(new RequestScope(), {
    instance: "default",
    context,
    diagnostics,
  });
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    for (let i = 0; i < 102; i += 1) {
      await check.check(
        browser({
          cookie: "x=y",
          referer: `https://evil-${i}.example/reset?token=private`,
        }),
        "cookie",
      );
    }
    expect(warn).toHaveBeenCalledTimes(100);
    expect(debug).toHaveBeenCalledTimes(102);
    expect(inspect(warn.mock.calls)).not.toContain("token=private");
    expect(inspect(warn.mock.calls)).not.toContain("/reset");
    clock.mockReturnValue(3_601_000);
    await check.check(
      browser({ cookie: "x=y", origin: "https://new.example" }),
      "cookie",
    );
    expect(warn).toHaveBeenCalledTimes(102);
    expect(warn.mock.calls[100]![0]).toContain("window closed");
    expect(warn.mock.calls[100]![0]).toContain("INVALID_ORIGIN");
  } finally {
    clock.mockRestore();
  }
});

it("shares settled proof across checker consumers but never invents proof from nonapplication or in-flight work", async () => {
  let settle!: (origins: string[]) => void;
  const pending = new Promise<string[]>((resolve) => {
    settle = resolve;
  });
  const { context, scope } = await fixture();
  const dynamicContext = {
    ...context,
    options: { ...context.options, trustedOrigins: () => pending },
  };
  const first = new OriginCheck(scope, {
    instance: "default",
    context: dynamicContext,
  });
  const second = new OriginCheck(scope, {
    instance: "default",
    context: dynamicContext,
  });
  const leg = browser({
    cookie: "session=opaque",
    origin: "https://allowed.example",
  });
  const verdict = first.check(leg, "cookie");
  expect(() =>
    second.assertCallerSession(leg, "/sign-out", "default"),
  ).toThrow();
  settle(["https://allowed.example"]);
  await verdict;
  expect(() =>
    second.assertCallerSession(leg, "/sign-out", "default"),
  ).not.toThrow();
  const cookieFree = browser({ origin: "https://evil.example" });
  await first.check(cookieFree, "cookie");
  expect(() =>
    first.assertCallerSession(cookieFree, "/sign-out", "default"),
  ).toThrow();
});

it("allows native missing-origin opt-in only without Origin, Referer and Sec-Fetch-Site", async () => {
  const { context } = await fixture();
  const check = new OriginCheck(new RequestScope(), {
    instance: "default",
    context,
    options: { missingOrigin: "allow-non-browser" },
  });
  expect(await check.check(browser({ cookie: "x=y" }), "cookie")).toBeNull();
  for (const [name, value] of [
    ["origin", "null"],
    ["referer", ""],
    ["sec-fetch-site", "cross-site"],
  ]) {
    expect(
      (await check.check(browser({ cookie: "x=y", [name!]: value! }), "cookie"))
        ?.reason,
    ).toBe("MISSING_OR_NULL_ORIGIN");
  }
});

it("honors the same disable predicate in direct-call proof and guard checks without reading headers", async () => {
  const { context } = await fixture({ advanced: { disableOriginCheck: true } });
  const check = new OriginCheck(new RequestScope(), {
    instance: "default",
    context,
  });
  const leg = {
    ...browser(),
    headers: vi.fn(() => {
      throw new Error("unavailable transport");
    }),
  };
  expect(() =>
    check.assertCallerSession(leg, "/sign-out", "default"),
  ).not.toThrow();
  expect(await check.check(leg, "form")).toBeNull();
  expect(leg.headers).not.toHaveBeenCalled();
});

it.each([false, true])(
  "propagates lazy header extraction failures with diagnostics=%s",
  async (enabled) => {
    const { context } = await fixture();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const check = new OriginCheck(new RequestScope(), {
      instance: "default",
      context,
      diagnostics: enabled ? new OriginDiagnostics(logger) : undefined,
    });
    const failure = BetterAuthConfigurationError.atRequest(
      "GRAPHQL_CONTEXT_UNRECOGNIZED",
      "No live request is present in the GraphQL context",
    );
    const headers = vi.fn(() => {
      throw failure;
    });
    const leg = { ...browser({}, false), headers };
    expect(headers).not.toHaveBeenCalled();
    await expect(check.advisory(leg)).rejects.toBe(failure);
    expect(headers).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
    expect(() =>
      check.assertCallerSession(leg, "/sign-out", "default"),
    ).toThrow();
    expect(headers).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "does not mistake an extraction infrastructure failure for an origin-calculation failure with diagnostics=%s",
  async (enabled) => {
    const { context } = await fixture();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const check = new OriginCheck(new RequestScope(), {
      instance: "default",
      context,
      diagnostics: enabled ? new OriginDiagnostics(logger) : undefined,
    });
    const failure = new BetterAuthInfrastructureError(
      new Error("request extraction failed"),
    );
    const headers = vi.fn(() => {
      throw failure;
    });
    await expect(
      check.advisory({ ...browser({}, false), headers }),
    ).rejects.toBe(failure);
    expect(headers).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "keeps origin outages advisory without re-reading the extracted headers with diagnostics=%s",
  async (enabled) => {
    const { context, scope } = await fixture();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const origins = vi.fn(async () => {
      throw new Error("trusted-origin storage unavailable");
    });
    const init = {
      instance: "default",
      context: {
        ...context,
        options: { ...context.options, trustedOrigins: origins },
      },
      diagnostics: enabled ? new OriginDiagnostics(logger) : undefined,
    };
    const check = new OriginCheck(scope, init);
    const headers = vi
      .fn()
      .mockReturnValueOnce(
        new Headers({
          cookie: "session=opaque",
          origin: "https://app.example",
        }),
      )
      .mockImplementation(() => {
        throw BetterAuthConfigurationError.atRequest(
          "GRAPHQL_CONTEXT_UNRECOGNIZED",
          "Request capability cannot be extracted again",
        );
      });
    const leg = { ...browser({}, false), headers };
    const first = check.advisory(leg);
    const shared = new OriginCheck(scope, init).advisory(leg);
    await expect(Promise.all([first, shared])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(headers).toHaveBeenCalledTimes(1);
    expect(origins).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(() =>
      check.assertCallerSession(leg, "/sign-out", "default"),
    ).toThrow();
  },
);

it.each([false, true])(
  "propagates trusted-origin configuration errors with diagnostics=%s",
  async (enabled) => {
    const { context } = await fixture();
    const failure = BetterAuthConfigurationError.atRequest(
      "INVALID_TRUST_CONFIGURATION",
      "Origin policy is misconfigured",
    );
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const check = new OriginCheck(new RequestScope(), {
      instance: "default",
      context: {
        ...context,
        options: {
          ...context.options,
          trustedOrigins: () => {
            throw failure;
          },
        },
      },
      diagnostics: enabled ? new OriginDiagnostics(logger) : undefined,
    });
    const headers = vi.fn(
      () =>
        new Headers({
          cookie: "session=opaque",
          origin: "https://app.example",
        }),
    );
    await expect(
      check.advisory({ ...browser({}, false), headers }),
    ).rejects.toBe(failure);
    expect(headers).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  },
);

it("does not reuse an earlier calculation-failure classification when extraction later fails", async () => {
  const { context } = await fixture();
  const failure = new BetterAuthInfrastructureError(
    new Error("shared adapter failure"),
  );
  const check = new OriginCheck(new RequestScope(), {
    instance: "default",
    context: {
      ...context,
      options: {
        ...context.options,
        trustedOrigins: () => {
          throw failure;
        },
      },
    },
  });
  const headers = vi
    .fn()
    .mockReturnValueOnce(
      new Headers({ cookie: "session=opaque", origin: "https://app.example" }),
    )
    .mockImplementation(() => {
      throw failure;
    });
  const leg = { ...browser({}, false), headers };
  await expect(check.advisory(leg)).resolves.toBeUndefined();
  await expect(check.advisory(leg)).rejects.toBe(failure);
  expect(headers).toHaveBeenCalledTimes(2);
});
