import "reflect-metadata";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host.js";
import { UseGuards, UseInterceptors } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SubscribeMessage, WebSocketGateway } from "@nestjs/websockets";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { Public, UseBetterAuth } from "./auth-decorators.js";
import { createTestAuth } from "./test-fixtures.js";
import { describe, expect, it } from "vitest";
import type { AuthTransport, ExtensionDefinition } from "./auth-contracts.js";
import {
  AuthFailures,
  BetterAuthConfigurationError,
  createInfrastructureError,
} from "./auth-errors.js";
import { connectionErrorLog } from "./ws-connection-auth.js";
import {
  socketIoTransport,
  wsTransport,
  recordUpgradeRequest,
  UPGRADE_REQUEST,
  wsCloseCodeFor,
  WS_CONNECTION_AUTH,
} from "./websockets.js";

function unit(definition: ExtensionDefinition<AuthTransport>): AuthTransport {
  if (!("useFactory" in definition.use)) {
    throw new Error("Expected transport factory");
  }
  return definition.use.useFactory() as AuthTransport;
}
function context(client: unknown, data: unknown = {}) {
  const value = new ExecutionContextHost([client, data]);
  value.setType("ws");
  return value;
}
describe("WebSocket structural transport contracts", () => {
  it("describes public raw ws messages without consuming unavailable authentication capabilities", () => {
    const transport = unit(wsTransport());
    const ctx = context({}, { ticker: "TEST" });
    const call = transport.describe(ctx, { http: null });
    expect(call.key).toBe(ctx.getArgs());
    expect(call.invocation).toBe(ctx.getArgs());
    expect(call.param("ticker")).toBe("TEST");
    expect(() => call.headers()).toThrow("Authentication is misconfigured");
    expect(() => call.browser).toThrow("Authentication is misconfigured");
  });
  it("keeps mapped credentials separate from the browser leg and forwarding headers out of its URL", () => {
    const transport = unit(
      socketIoTransport({
        credentials: () => ({
          cookie: "mapped=1",
          authorization: "Bearer mapped",
          origin: "https://trusted.example",
        }),
      }),
    );
    const client = {
      handshake: {
        headers: {
          host: "api.example",
          cookie: "victim=1",
          origin: "https://evil.example",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        },
        url: "/socket.io/",
        secure: false,
      },
    };
    const call = transport.describe(context(client), { http: null });
    expect(call.headers().get("cookie")).toBe("mapped=1");
    expect(call.browser?.headers().get("cookie")).toBe("victim=1");
    expect(call.browser?.headers().get("origin")).toBe("https://evil.example");
    expect(call.browser?.url).toBe("http://api.example/socket.io/");
    expect(call.principalTtlMs).toBe(0);
    expect(call.cookies).toBeNull();
  });
  it("maps auth.token only when an authorization header is absent", () => {
    const transport = unit(socketIoTransport());
    for (const authorization of [undefined, "Bearer original"]) {
      const client = {
        handshake: {
          headers: { host: "api.example", authorization },
          auth: { token: "mapped" },
        },
      };
      expect(
        transport
          .describe(context(client), { http: null })
          .headers()
          .get("authorization"),
      ).toBe(authorization ?? "Bearer mapped");
    }
  });
  it("records snapshots and keeps raw ws mapping isolated from handshake origin", () => {
    const client = {};
    const headers = {
      host: "api.example",
      cookie: "victim=1",
      origin: "https://evil.example",
    };
    recordUpgradeRequest(client, {
      headers,
      url: "/?token=mapped",
      socket: { encrypted: true, remoteAddress: "127.0.0.1" },
    });
    headers.cookie = "later=1";
    const call = unit(
      wsTransport({ credentials: () => ({ authorization: "Bearer mapped" }) }),
    ).describe(context(client), { http: null });
    expect(call.headers().get("cookie")).toBe("victim=1");
    expect(call.headers().get("authorization")).toBe("Bearer mapped");
    expect(call.browser?.url).toBe("https://api.example/?token=mapped");
    expect(call.clientIp).toBe("127.0.0.1");
    expect(UPGRADE_REQUEST).toBe(
      Symbol.for("nestjs-slightly-better-auth:upgrade-request"),
    );
    expect(WS_CONNECTION_AUTH).toBe(
      Symbol.for("nestjs-slightly-better-auth:ws-connection-auth"),
    );
  });
  it("maps close codes and rejects invalid cache durations", () => {
    expect(wsCloseCodeFor(AuthFailures.unauthenticated())).toBe(4401);
    expect(wsCloseCodeFor(AuthFailures.forbidden("DENIED"))).toBe(4403);
    expect(wsCloseCodeFor(AuthFailures.rejected({ status: 429 }))).toBe(4429);
    for (const principalTtlMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => wsTransport({ principalTtlMs })).toThrow();
    }
  });
});
describe.each([
  ["socket.io", socketIoTransport],
  ["ws", wsTransport],
] as const)("native gateway coverage (%s)", (_id, transport) => {
  it.each([
    "missing",
    "guard-only",
    "scope-only",
    "both",
    "combined",
    "public",
    "push-only",
  ])("enforces explicit guard and scope coverage: %s", async (coverage) => {
    @WebSocketGateway()
    class Gateway {
      message() {
        return true;
      }
    }
    if (coverage !== "push-only") {
      SubscribeMessage("test")(
        Gateway.prototype,
        "message",
        Object.getOwnPropertyDescriptor(Gateway.prototype, "message")!,
      );
    }
    if (coverage === "guard-only" || coverage === "both") {
      UseGuards(BetterAuthGuard)(Gateway);
    }
    if (coverage === "scope-only" || coverage === "both") {
      UseInterceptors(BetterAuthScopeInterceptor)(Gateway);
    }
    if (coverage === "combined") {
      UseBetterAuth()(Gateway);
    }
    if (coverage === "public") {
      Public()(Gateway);
    }
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth: createTestAuth(),
          http: { mount: false },
          transports: [transport()],
          globalGuard: false,
          globalScope: false,
        }),
      ],
      providers: [Gateway],
    }).compile();
    try {
      if (["missing", "guard-only", "scope-only"].includes(coverage)) {
        await expect(module.init()).rejects.toMatchObject({
          detail: expect.stringContaining("GATEWAY_UNGUARDED"),
        });
      } else {
        await expect(module.init()).resolves.toBe(module);
        expect(module.get(WS_CONNECTION_AUTH)).toBeDefined();
      }
    } finally {
      await module.close().catch(() => undefined);
    }
  });
});
describe.each(["socket.io", "ws"] as const)(
  "malformed mapped credentials (%s)",
  (kind) => {
    const secret = "MAPPED_CREDENTIAL_SECRET";
    function call(credentials: () => HeadersInit | undefined) {
      const client = {
        handshake: {
          headers: {
            host: "localhost:3000",
            cookie: "valid=credential",
            authorization: "Bearer valid-fallback",
          },
        },
      };
      const raw = {};
      recordUpgradeRequest(raw, {
        headers: client.handshake.headers,
        url: "/",
      });
      return unit(
        kind === "socket.io"
          ? socketIoTransport({ credentials })
          : wsTransport({ credentials }),
      ).describe(context(kind === "socket.io" ? client : raw), { http: null });
    }
    it.each([
      { authorization: `${secret}\rsecond` },
      { authorization: `${secret}\nsecond` },
      { authorization: `${secret}\0second` },
      { authorization: `${secret}\r\n` },
      { authorization: `${secret}\u0100` },
      { [`${secret} invalid`]: "token" },
      { authorization: 42 },
      { authorization: null },
      { authorization: undefined },
      { authorization: [secret] },
      { authorization: { toString: () => secret } },
      [["authorization", secret, "extra"]],
      [["authorization"]],
      null,
      secret,
    ])(
      "rejects invalid HeaderInit without retaining raw cause or allowing fallback (%#)",
      (mapped) => {
        let failure: unknown;
        try {
          call(() => mapped as HeadersInit).headers();
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({
          status: 401,
          reason: "MALFORMED_CREDENTIALS",
        });
        expect(failure).not.toHaveProperty("cause");
        expect(failure).not.toHaveProperty("stack");
        expect(JSON.stringify(failure)).not.toContain(secret);
      },
    );
    it("preserves arbitrary mapper and mapped-getter programming errors", () => {
      const error = new TypeError("mapper programming error");
      expect(() =>
        call(() => {
          throw error;
        }).headers(),
      ).toThrow(error);
      expect(() =>
        call(() => ({
          get authorization(): string {
            throw error;
          },
        })).headers(),
      ).toThrow(error);
    });
    it("retains valid HeadersInit forms and keeps the browser leg untouched", () => {
      for (const mapped of [
        new Headers({ authorization: "Bearer mapped" }),
        [["authorization", "Bearer mapped"]],
        { authorization: "Bearer mapped" },
      ]) {
        const transportCall = call(() => mapped as HeadersInit);
        expect(transportCall.headers().get("authorization")).toBe(
          "Bearer mapped",
        );
        expect(transportCall.browser?.headers().get("authorization")).toBe(
          "Bearer valid-fallback",
        );
      }
    });
  },
);
it.each([null, 42, {}, [], true])(
  "rejects a supplied non-string default Socket.IO token without falling back to cookies (%#)",
  (token) => {
    const transport = unit(socketIoTransport());
    expect(() =>
      transport
        .describe(
          context({
            handshake: {
              headers: { cookie: "valid=credential", host: "localhost" },
              auth: { token },
            },
          }),
          { http: null },
        )
        .headers(),
    ).toThrow(
      expect.objectContaining({ status: 401, reason: "MALFORMED_CREDENTIALS" }),
    );
  },
);
it.each(["\r", "\n", "\0", "\u0100"])(
  "rejects a malformed default Socket.IO token string without quoting it (%j)",
  (character) => {
    const secret = "DEFAULT_TOKEN_SECRET";
    let failure: unknown;
    try {
      unit(socketIoTransport())
        .describe(
          context({
            handshake: {
              headers: { cookie: "valid=credential", host: "localhost" },
              auth: { token: `${secret}${character}suffix` },
            },
          }),
          { http: null },
        )
        .headers();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      status: 401,
      reason: "MALFORMED_CREDENTIALS",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(secret);
  },
);
describe("connection middleware error log", () => {
  const secret = "CONNECTION_LOG_SECRET";
  it("withholds foreign error messages, which can quote credentials", () => {
    for (const error of [
      new TypeError(`Headers.append: "${secret}" is an invalid header name.`),
      `thrown ${secret}`,
    ]) {
      const log = connectionErrorLog(error);
      expect(`${log.message}\n${log.stack ?? ""}`).not.toContain(secret);
      expect(log.message).toContain("(message withheld)");
    }
    const log = connectionErrorLog(new TypeError(secret));
    expect(log.message).toContain("TypeError (message withheld)");
    expect(log.stack).toMatch(/\n\s+at /);
  });
  it("keeps package diagnostics and already-redacted infrastructure causes", () => {
    expect(
      connectionErrorLog(
        BetterAuthConfigurationError.atRequest(
          "WS_UPGRADE_REQUEST_MISSING",
          "WebSocket authentication requires its upgrade request.",
        ),
      ).message,
    ).toContain(
      "WS_UPGRADE_REQUEST_MISSING: WebSocket authentication requires its upgrade request.",
    );
    const log = connectionErrorLog(
      createInfrastructureError(new Error(`connect failed for ${secret}`), {
        secrets: [secret],
      }),
    );
    expect(log.message).toContain(
      "Authentication service unavailable (Error: connect failed for [REDACTED])",
    );
    expect(`${log.message}\n${log.stack ?? ""}`).not.toContain(secret);
  });
});
