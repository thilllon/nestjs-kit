import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { ConsoleLogger } from "@nestjs/common";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import {
  AuthFailures,
  BetterAuthConfigurationError,
  BetterAuthInfrastructureError,
  createInfrastructureError,
  getAPIErrorHeaders,
  getRawCause,
  isAuthFailure,
  isConfigurationError,
  isInfrastructureError,
  normalizeThrown,
} from "./auth-errors.js";

describe("infrastructure diagnostics", () => {
  it("does not serialize session credentials in an infrastructure cause", () => {
    const credential = randomUUID();
    const cause = Object.assign(
      new Error(`query failed for ${credential}\nSQL params`),
      { code: "08006" },
    );
    const error = new BetterAuthInfrastructureError(cause, {
      secrets: [credential],
    });
    expect(error.message).toBe("Authentication service unavailable");
    expect(error.cause.message).not.toContain(credential);
    expect(error.cause.message).not.toContain("SQL params");
    expect(inspect(error)).not.toContain(credential);
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(getRawCause(error)).toBeUndefined();
    expect(error.cause).not.toBe(cause);
    expect(
      Object.getOwnPropertySymbols(error).map((key) => Reflect.get(error, key)),
    ).not.toContain(cause);
  });

  it("redacts request-owned credentials while retaining only an explicitly opted-in raw cause", () => {
    const session = randomUUID();
    const bearer = randomUUID();
    const apiKey = randomUUID();
    const headers = new Headers({
      cookie: `session=${session}`,
      authorization: `Bearer ${bearer}`,
      "x-api-key": apiKey,
    });
    const cause = new Error(`lookup ${session} ${bearer} ${apiKey}`);
    for (const exposeRawCause of [false, true]) {
      const error = createInfrastructureError(cause, {
        headers,
        credentialHeaders: ["x-api-key"],
        exposeRawCause,
      });
      expect(error.cause.message).toBe(
        "lookup [REDACTED] [REDACTED] [REDACTED]",
      );
      expect(getRawCause(error)).toBe(exposeRawCause ? cause : undefined);
      for (const secret of [session, bearer, apiKey]) {
        expect(inspect(error)).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
      }
    }
  });

  it("keeps raw causes only for explicit local debugging without printing them", () => {
    const secret = randomUUID();
    const cause = new Error(`database ${secret}`);
    const error = createInfrastructureError(cause, {
      secrets: [secret],
      exposeRawCause: true,
    });
    expect(getRawCause(error)).toBe(cause);
    expect(
      Object.getOwnPropertyDescriptor(
        error,
        Symbol.for("nestjs-slightly-better-auth:raw-cause"),
      )?.enumerable,
    ).toBe(false);
    expect(inspect(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    const output: string[] = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
    try {
      new ConsoleLogger("auth", { colors: false }).error(error);
    } finally {
      write.mockRestore();
    }
    expect(output.join("")).toContain("Authentication service unavailable");
    expect(output.join("")).not.toContain(secret);
  });
});

describe("error classification", () => {
  it.each([
    [401, "UNAUTHENTICATED"],
    [403, "FORBIDDEN"],
    [429, "RATE_LIMITED"],
  ] as const)("recognizes actual SDK %i denials", (status, code) => {
    const error = new APIError(status, {
      code: "SDK_REASON",
      message: "private SDK detail",
    });
    const failure = AuthFailures.fromAPIError(error);
    expect(failure).toMatchObject({ status, code, reason: "SDK_REASON" });
    expect(isAuthFailure(failure)).toBe(true);
    expect(failure?.message).not.toContain("private SDK detail");
  });

  it("preserves challenges and rounds explicit retry delays up to seconds", () => {
    const failure = AuthFailures.rejected({
      status: 429,
      reason: "LIMIT",
      retryAfterSeconds: 1.2,
      challenge: "Bearer",
    });
    expect(failure.headers?.get("retry-after")).toBe("2");
    expect(failure.challenge).toBe("Bearer");
    expect(AuthFailures.unauthenticated()).toMatchObject({
      status: 401,
      code: "UNAUTHENTICATED",
    });
    expect(AuthFailures.forbidden("MISSING_PERMISSION")).toMatchObject({
      status: 403,
      reason: "MISSING_PERMISSION",
    });
  });

  it("takes Retry-After from SDK headers before millisecond retry details", () => {
    const error = new APIError(
      429,
      { details: { tryAgainIn: 1501 } },
      {
        "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT",
        "set-cookie": "session=; Max-Age=0",
      },
    );
    expect(AuthFailures.fromAPIError(error)?.headers?.get("retry-after")).toBe(
      "Wed, 21 Oct 2026 07:28:00 GMT",
    );
    expect(
      AuthFailures.fromAPIError(
        new APIError(429, { details: { tryAgainIn: 1501 } }),
      )?.headers?.get("retry-after"),
    ).toBe("2");
    expect(AuthFailures.fromAPIError(error)?.headers?.has("set-cookie")).toBe(
      false,
    );
    expect(new Headers(error.headers).get("set-cookie")).toBe(
      "session=; Max-Age=0",
    );
  });

  it("keeps SDK cleanup headers intact and reads middleware symbol headers", () => {
    const error = new APIError(429, {}, { "set-cookie": "public=; Max-Age=0" });
    const hidden = new Headers({ "retry-after": "7" });
    hidden.append("set-cookie", "first=; Max-Age=0");
    hidden.append("set-cookie", "second=; Max-Age=0");
    Object.defineProperty(error, Symbol.for("better-call:api-error-headers"), {
      value: hidden,
    });
    expect(AuthFailures.fromAPIError(error)?.headers?.get("retry-after")).toBe(
      "7",
    );
    expect(getAPIErrorHeaders(error).getSetCookie()).toEqual([
      "first=; Max-Age=0",
      "second=; Max-Age=0",
      "public=; Max-Age=0",
    ]);
    expect(hidden.getSetCookie()).toHaveLength(2);
  });

  it.each([400, 404, 500, 503] as const)(
    "does not convert SDK %i into an auth denial",
    (status) => {
      expect(AuthFailures.fromAPIError(new APIError(status))).toBeNull();
    },
  );

  it.each([
    null,
    undefined,
    "outage",
    { statusCode: 401 },
    { status: 401, body: { code: "UNAUTHORIZED" } },
  ])("does not trust unknown fault shapes: %j", (fault) => {
    expect(AuthFailures.fromAPIError(fault)).toBeNull();
    expect(() => normalizeThrown(fault, "source", "Session", [])).toThrow(
      BetterAuthInfrastructureError,
    );
  });

  it("defers only a policy's generic 401 for authoritative session rechecking", () => {
    for (const reason of [undefined, "UNAUTHORIZED"]) {
      const error = new APIError(401, { code: reason });
      expect(normalizeThrown(error, "policy", "permission", [])).toEqual({
        sessionLoss: error,
        reason,
      });
      expect(normalizeThrown(error, "source", "session", [])).toMatchObject({
        status: 401,
        code: "UNAUTHENTICATED",
      });
    }
    expect(
      normalizeThrown(
        new APIError(401, { code: "MISSING_PERMISSION" }),
        "policy",
        "permission",
        [],
      ),
    ).toMatchObject({ status: 403, reason: "MISSING_PERMISSION" });
    expect(
      normalizeThrown(
        new APIError(429, { details: { tryAgainIn: 1 } }),
        "policy",
        "permission",
        [],
      ),
    ).toMatchObject({ status: 429 });
  });

  it("reports bad library calls as generic request-time configuration errors", () => {
    let caught: unknown;
    try {
      normalizeThrown(
        new APIError(400, { code: "VALIDATION_ERROR" }),
        "policy",
        "Roles.read",
        [],
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "BETTER_AUTH_REJECTED_CALL",
      phase: "request",
      message: "Authentication is misconfigured",
      site: "Roles.read",
      extensions: { reason: "AUTH_MISCONFIGURED", statusCode: 500 },
    });
    expect(isConfigurationError(caught)).toBe(true);
    const boot = new BetterAuthConfigurationError(
      "NO_PLUGIN",
      "Install plugin",
      "Add plugin last",
    );
    expect(boot.message).toBe("Install plugin");
    expect(boot.phase).toBe("boot");
  });

  it("never treats database or SDK server outages as authentication denial", () => {
    for (const error of [new Error("connection refused"), new APIError(503)]) {
      expect(() => normalizeThrown(error, "policy", "read", [])).toThrow(
        BetterAuthInfrastructureError,
      );
    }
  });

  it("recognizes library brands across copies and preserves classified values", async () => {
    vi.resetModules();
    const other = await import("./auth-errors.js");
    const denial = other.AuthFailures.forbidden("DENIED");
    const infra = new other.BetterAuthInfrastructureError(new Error("offline"));
    const config = other.BetterAuthConfigurationError.atRequest(
      "NO_TRANSPORT",
      "Missing transport",
    );
    expect(isAuthFailure(denial)).toBe(true);
    expect(isInfrastructureError(infra)).toBe(true);
    expect(isConfigurationError(config)).toBe(true);
    expect(normalizeThrown(denial, "source", "read", [])).toBe(denial);
    for (const error of [infra, config]) {
      try {
        normalizeThrown(error, "source", "read", []);
        expect.fail("classified error must be thrown");
      } catch (caught) {
        expect(caught).toBe(error);
      }
    }
    expect(isAuthFailure({ status: 401, code: "UNAUTHENTICATED" })).toBe(false);
    expect(isInfrastructureError(new Error())).toBe(false);
    expect(isConfigurationError(null)).toBe(false);
  });
});
