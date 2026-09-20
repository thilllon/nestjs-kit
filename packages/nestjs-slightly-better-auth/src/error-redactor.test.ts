import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { ErrorRedactor } from "./error-redactor.js";

describe("credential redaction", () => {
  it("removes cookie, decoded, signed, bearer, and declared header credentials", () => {
    const token = "0123456789abcdef+session";
    const signed = `${token}.signature`;
    const raw = encodeURIComponent(signed);
    const redactor = new ErrorRedactor({
      headers: new Headers({
        cookie: `session=${raw}; theme=private-theme`,
        authorization: "Bearer bearer-secret",
        "X-Api-Key": "api-secret",
      }),
      credentialHeaders: ["x-API-key"],
    });
    const cause = new Error(
      `${raw} ${signed} ${token} Bearer bearer-secret api-secret private-theme`,
    );
    const redacted = redactor.redact(cause);
    for (const secret of [
      raw,
      signed,
      token,
      "bearer-secret",
      "api-secret",
      "private-theme",
    ]) {
      expect(inspect(redacted)).not.toContain(secret);
      expect(JSON.stringify(redacted)).not.toContain(secret);
    }
    expect(redacted.message).toContain("[REDACTED]");
    expect(cause.message).toContain(token);
  });

  it("redacts before truncation and drops multiline messages and non-frame stack data", () => {
    const secret = "secret-token";
    const cause = new Error(`${"a".repeat(295)}${secret}\nquery params`);
    cause.stack = `Error: ${cause.message}\n    at lookup (/app/file.ts:12:4)\n    at token_${secret} (/app/file.ts:13:4)\nheaders: ${secret}`;
    const result = new ErrorRedactor({ secrets: [secret] }).redact(cause);
    expect(result.message.length).toBeLessThanOrEqual(300);
    expect(result.stack).toContain("/app/file.ts:12:4");
    expect(result.stack).not.toContain(secret);
    expect(result.stack).not.toContain("query params");
    expect(result.stack).not.toContain("headers:");
    expect(result.stack).toMatch(/^Error: a/);
  });

  it("copies only sanitized primitive diagnostic fields and at most three nested causes", () => {
    const secret = "diagnostic-secret";
    const tail = new Error(`tail ${secret}`);
    const cause = Object.assign(
      new Error(`top ${secret}`, {
        cause: new Error("one", {
          cause: new Error("two", {
            cause: new Error("three", { cause: tail }),
          }),
        }),
      }),
      {
        name: `Driver${secret}`,
        code: "08006",
        errno: -1,
        syscall: `connect ${secret}`,
        query: secret,
        parameters: [secret],
        request: { headers: { authorization: secret } },
      },
    );
    const result = new ErrorRedactor({ secrets: [secret] }).redact(cause);
    expect(result).toMatchObject({
      code: "08006",
      errno: -1,
      syscall: "connect [REDACTED]",
    });
    expect(inspect(result, { depth: 10 })).not.toContain(secret);
    expect(result).not.toHaveProperty("query");
    expect(result).not.toHaveProperty("parameters");
    expect(result).not.toHaveProperty("request");
    expect(((result.cause as Error).cause as Error).cause).toBeInstanceOf(
      Error,
    );
    expect(
      (((result.cause as Error).cause as Error).cause as Error).cause,
    ).toBeUndefined();
  });

  it("handles cyclic and malformed causes without retaining arbitrary objects", () => {
    const cause = Object.assign(new Error("cycle"), {
      code: { password: "opaque-password-57b192" },
    });
    cause.cause = cause;
    const result = new ErrorRedactor().redact(cause);
    expect(result).not.toHaveProperty("code");
    expect(inspect(result, { depth: 10 })).not.toContain(
      "opaque-password-57b192",
    );
    expect(JSON.stringify(result)).not.toContain("opaque-password-57b192");
    const hostile = Object.defineProperty({}, "message", {
      get() {
        throw new Error("getter secret");
      },
    });
    expect(() => new ErrorRedactor().redact(hostile)).not.toThrow();
    expect(
      new ErrorRedactor().redact({ password: "opaque-password-57b192" })
        .message,
    ).not.toContain("opaque-password-57b192");
    expect(
      new ErrorRedactor({ secrets: ["token"] }).redact("fault token").message,
    ).toBe("fault [REDACTED]");
  });
});
