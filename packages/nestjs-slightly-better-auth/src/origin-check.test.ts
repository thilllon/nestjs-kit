import { inspect } from "node:util";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import type { AuthContextView, BrowserExposure } from "./auth-contracts.js";
import { getRawCause, isInfrastructureError } from "./auth-errors.js";
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
