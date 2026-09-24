import "reflect-metadata";
import { inspect } from "node:util";
import {
  Catch,
  Inject,
  Logger,
  UseFilters,
  type ArgumentsHost,
} from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import { ExpressAdapter } from "@nestjs/platform-express";
import {
  BaseWsExceptionFilter,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import {
  createAuthEndpoint,
  createAuthMiddleware,
  APIError,
} from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { WebSocket } from "ws";
import { expect, it, vi } from "vitest";
import {
  OptionalAuth,
  Public,
  RequireAuth,
  UseBetterAuth,
} from "./auth-decorators.js";
import { CurrentSession } from "./session-principal.js";
import { getBetterAuthServiceToken } from "./auth-tokens.js";
import type { BetterAuthService } from "./auth-service.js";
import { expressPlatform } from "./express.js";
import { createTestAuth, startHttpFixture } from "./test-fixtures.js";
import {
  wsTransport,
  withUpgradeRequest,
  UPGRADE_REQUEST,
  WS_CONNECTION_AUTH,
  WsConnectionAuth,
  wsCloseCodeFor,
} from "./websockets.js";

export function sendMessage(
  client: WebSocket,
  event: string,
  data: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.off("message", message);
      client.off("error", error);
    };
    const error = (failure: Error) => {
      cleanup();
      reject(failure);
    };
    const message = (raw: Buffer) => {
      cleanup();
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (failure) {
        reject(failure);
      }
    };
    const timer = setTimeout(
      () => error(new Error("WebSocket reply timeout")),
      2000,
    );
    client.once("message", message);
    client.once("error", error);
    client.send(JSON.stringify({ event, data }));
  });
}
async function connect(
  url: string,
  headers?: Record<string, string>,
): Promise<WebSocket> {
  const client = new WebSocket(url.replace("http", "ws"), { headers });
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.off("open", opened);
      client.off("error", failed);
    };
    const opened = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      client.terminate();
      reject(error);
    };
    const timer = setTimeout(
      () => failed(new Error("WebSocket connection timeout")),
      2000,
    );
    client.once("open", opened);
    client.once("error", failed);
  });
  return client;
}
it("keeps public ws lazy, denies protected and public direct calls before effects without an upgrade record", async () => {
  let effects = 0;
  const exceptions: unknown[] = [];
  let observed!: (error: unknown) => void;
  @Catch()
  class RecordingFilter extends BaseWsExceptionFilter {
    override catch(exception: unknown, host: ArgumentsHost) {
      exceptions.push(exception);
      super.catch(exception, host);
    }

    protected override emitMessage<
      // biome-ignore lint/complexity/noBannedTypes: Matches the native Nest filter generic signature.
      TClient extends { emit?: Function; send?: Function },
    >(client: TClient, event: string, payload: unknown) {
      observed?.(payload);
      super.emitMessage(client, event, payload);
    }
  }
  @WebSocketGateway()
  @UseBetterAuth()
  @UseFilters(new RecordingFilter())
  class Gateway {
    constructor(
      @Inject(getBetterAuthServiceToken())
      private readonly auth: BetterAuthService,
    ) {}

    @Public()
    @SubscribeMessage("ticker")
    ticker(@MessageBody() data: unknown) {
      return { event: "ticker", data };
    }

    @RequireAuth()
    @SubscribeMessage("portfolio")
    portfolio(@CurrentSession() session: unknown) {
      effects++;
      return { event: "portfolio", data: session };
    }

    @Public()
    @SubscribeMessage("direct")
    async direct() {
      await (
        this.auth.api as unknown as { probe: () => Promise<unknown> }
      ).probe();
    }
  }
  const fixture = await startHttpFixture({
    auth: createTestAuth({
      plugins: [
        {
          id: "ws-probe",
          endpoints: {
            probe: createAuthEndpoint(
              "/ws-probe",
              { method: "GET" },
              async () => {
                effects++;
                return { ok: true };
              },
            ),
          },
        },
      ],
    }),
    adapter: new ExpressAdapter(),
    platform: expressPlatform(),
    controllers: [],
    providers: [Gateway],
    transports: [wsTransport()],
    configure: (app) => {
      app.useWebSocketAdapter(new WsAdapter(app));
    },
  });
  let client: WebSocket | undefined;
  try {
    client = await connect(fixture.url);
    expect(await sendMessage(client, "ticker", { symbol: "TEST" })).toEqual({
      event: "ticker",
      data: { symbol: "TEST" },
    });
    for (const event of ["portfolio", "direct"]) {
      const observedException = new Promise((resolve) => {
        observed = resolve;
      });
      await expect(sendMessage(client, event, {})).resolves.toMatchObject({
        event: "exception",
        data: { message: "Internal server error" },
      });
      await expect(observedException).resolves.toMatchObject({
        message: "Internal server error",
      });
      expect(effects).toBe(0);
      expect(exceptions).toHaveLength(event === "portfolio" ? 1 : 2);
    }
  } finally {
    client?.terminate();
    await fixture.close();
  }
});
it("records a real upgrade and authenticates a real SDK login cookie", async () => {
  @WebSocketGateway()
  @UseBetterAuth()
  class Gateway {
    @RequireAuth()
    @SubscribeMessage("portfolio")
    portfolio(@CurrentSession() session: { user: { email: string } }) {
      return { event: "portfolio", data: session.user.email };
    }
  }
  const auth = createTestAuth();
  const fixture = await startHttpFixture({
    auth,
    adapter: new ExpressAdapter(),
    platform: expressPlatform(),
    controllers: [],
    providers: [Gateway],
    transports: [wsTransport()],
    configure: (app) => {
      app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app));
    },
  });
  let client: WebSocket | undefined;
  try {
    const response = await auth.api.signUpEmail({
      body: { email: "ws@example.com", name: "WS", password: "password1234" },
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    client = await connect(fixture.url, {
      cookie,
      origin: "http://localhost:3000",
    });
    expect(await sendMessage(client, "portfolio", {})).toEqual({
      event: "portfolio",
      data: "ws@example.com",
    });
  } finally {
    client?.terminate();
    await fixture.close();
  }
});
it.each([false, true])(
  "rejects raw-ws cookie origins despite query/forwarding overrides (SDK proxy=%s)",
  async (trustedProxyHeaders) => {
    @WebSocketGateway()
    @UseBetterAuth()
    class Gateway {
      @RequireAuth()
      @SubscribeMessage("identity")
      identity(@CurrentSession() session: { user: { email: string } }) {
        return { event: "identity", data: session.user.email };
      }
    }
    const auth = createTestAuth({
      baseURL: {
        allowedHosts: ["localhost:3000"],
        fallback: "http://localhost:3000",
      },
      advanced: { trustedProxyHeaders },
      plugins: [bearer()],
    });
    const fixture = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      providers: [Gateway],
      transports: [
        wsTransport({
          credentials: (client) => {
            const token = new URL(
              client[UPGRADE_REQUEST]!.url!,
              "http://localhost",
            ).searchParams.get("token");
            return token ? { authorization: `Bearer ${token}` } : undefined;
          },
        }),
      ],
      configure: (app) => {
        app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app));
      },
    });
    const clients: WebSocket[] = [];
    try {
      const response = await auth.api.signUpEmail({
        body: {
          email: "raw@example.com",
          name: "Raw",
          password: "password1234",
        },
        asResponse: true,
      });
      const cookie = response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      const { token } = await response.json();
      for (const origin of [
        "https://evil.example",
        "null",
        undefined,
        "http://localhost:3000",
      ]) {
        const client = await connect(`${fixture.url}/?token=a.b`, {
          cookie,
          host: "localhost:3000",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
          ...(origin ? { origin } : {}),
        });
        clients.push(client);
        const reply = await sendMessage(client, "identity", {});
        if (origin === "http://localhost:3000") {
          expect(reply).toEqual({ event: "identity", data: "raw@example.com" });
        } else {
          expect(reply).toMatchObject({
            event: "exception",
            data: { statusCode: 403 },
          });
        }
      }
      const native = await connect(
        `${fixture.url}/?token=${encodeURIComponent(token)}`,
        { host: "localhost:3000", origin: "https://evil.example" },
      );
      clients.push(native);
      expect(await sendMessage(native, "identity", {})).toEqual({
        event: "identity",
        data: "raw@example.com",
      });
    } finally {
      for (const client of clients) {
        client.terminate();
      }
      await fixture.close();
    }
  },
);
it("authenticates native ws connections and emits actual close codes for missing, forbidden, and rate-limited credentials", async () => {
  let rateLimited = false;
  @WebSocketGateway()
  @UseBetterAuth()
  class Gateway {
    constructor(
      @Inject(WS_CONNECTION_AUTH) private readonly connection: WsConnectionAuth,
    ) {}

    async handleConnection(client: WebSocket) {
      const result = await this.connection.authenticate(client);
      if (result.outcome !== "authenticated") {
        client.close(
          result.outcome === "rejected" ? wsCloseCodeFor(result.failure) : 4401,
          "UNAUTHENTICATED",
        );
      } else {
        client.send(JSON.stringify({ event: "ready", data: true }));
      }
    }

    @RequireAuth()
    @SubscribeMessage("identity")
    identity() {
      return { event: "identity", data: true };
    }
  }
  const auth = createTestAuth({
    plugins: [bearer()],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (rateLimited && ctx.path === "/get-session") {
          throw new APIError("TOO_MANY_REQUESTS", { message: "Rate limited" });
        }
      }),
    },
  });
  const fixture = await startHttpFixture({
    auth,
    adapter: new ExpressAdapter(),
    platform: expressPlatform(),
    controllers: [],
    providers: [Gateway],
    transports: [wsTransport()],
    configure: (app) => {
      app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app));
    },
  });
  const clients: WebSocket[] = [];
  const result = (headers?: Record<string, string>) =>
    new Promise<unknown>((resolve, reject) => {
      const client = new WebSocket(fixture.url.replace("http", "ws"), {
        headers,
      });
      clients.push(client);
      const cleanup = () => {
        clearTimeout(timer);
        client.off("error", failed);
        client.off("close", closed);
        client.off("message", received);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const closed = (code: number) => {
        cleanup();
        resolve(code);
      };
      const received = (raw: Buffer) => {
        cleanup();
        resolve(JSON.parse(raw.toString()));
      };
      const timer = setTimeout(
        () => failed(new Error("Connection result timeout")),
        2000,
      );
      client.once("error", failed);
      client.once("close", closed);
      client.once("message", received);
    });
  try {
    expect(await result()).toBe(4401);
    const response = await auth.api.signUpEmail({
      body: {
        email: "connection@example.com",
        name: "Connect",
        password: "password1234",
      },
      asResponse: true,
    });
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    expect(await result({ cookie, origin: "https://evil.example" })).toBe(4403);
    expect(await result({ cookie, origin: "http://localhost:3000" })).toEqual({
      event: "ready",
      data: true,
    });
    rateLimited = true;
    expect(await result({ cookie, origin: "http://localhost:3000" })).toBe(
      4429,
    );
  } finally {
    for (const client of clients) {
      client.terminate();
    }
    await fixture.close();
  }
});
it.each([false, true])(
  "rejects raw-ws forwarded-origin spoof with request-derived baseURL (SDK proxy=%s)",
  async (trustedProxyHeaders) => {
    @WebSocketGateway()
    @UseBetterAuth()
    class Gateway {
      @RequireAuth() @SubscribeMessage("identity") identity() {
        return { event: "identity", data: true };
      }
    }
    const auth = createTestAuth({
      baseURL: undefined,
      advanced: { trustedProxyHeaders },
    });
    const f = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      providers: [Gateway],
      transports: [
        wsTransport({ credentials: () => ({ authorization: "Bearer a.b" }) }),
      ],
      moduleOptions: { http: { allowRequestDerivedBaseURL: true } },
      configure: (app) => {
        app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app));
      },
    });
    let client: WebSocket | undefined;
    try {
      const response = await fetch(`${f.url}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: f.url },
        body: JSON.stringify({
          name: "Derived",
          email: "derived@example.com",
          password: "password1234",
        }),
      });
      expect(response.status).toBe(200);
      const cookie = response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      client = await connect(f.url, {
        cookie,
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      });
      expect(await sendMessage(client, "identity", {})).toMatchObject({
        event: "exception",
        data: { statusCode: 403 },
      });
    } finally {
      client?.terminate();
      await f.close();
    }
  },
);
it.each([false, true])(
  "safely denies malformed raw-ws mapped credentials (connect=%s)",
  async (authenticateConnection) => {
    const secret = "RAW_WS_MALFORMED_SECRET";
    const malformed = `${secret}\r\nInjected: value`;
    let reads = 0;
    let effects = 0;
    let connectionResult: unknown;
    const logs = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    @WebSocketGateway()
    @UseBetterAuth()
    class Gateway {
      constructor(
        @Inject(WS_CONNECTION_AUTH)
        private readonly connection: WsConnectionAuth,
      ) {}

      async handleConnection(client: WebSocket) {
        if (!authenticateConnection) {
          return;
        }
        try {
          const result = await this.connection.authenticate(client);
          connectionResult = result;
          client.close(
            result.outcome === "rejected"
              ? wsCloseCodeFor(result.failure)
              : 4501,
          );
        } catch (error) {
          connectionResult = error;
          client.close(4500);
        }
      }

      @Public()
      @SubscribeMessage("ticker")
      ticker() {
        return { event: "ticker", data: true };
      }

      @RequireAuth()
      @SubscribeMessage("identity")
      identity() {
        effects++;
        return { event: "identity", data: true };
      }

      @OptionalAuth()
      @SubscribeMessage("optional")
      optional() {
        effects++;
        return { event: "optional", data: true };
      }
    }
    const auth = createTestAuth({
      plugins: [bearer()],
      hooks: {
        before: createAuthMiddleware(async (ctx) => {
          if (ctx.path === "/get-session") {
            reads++;
          }
        }),
      },
    });
    const f = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      providers: [Gateway],
      transports: [
        wsTransport({
          credentials: (client) => ({
            cookie: new URL(
              client[UPGRADE_REQUEST]!.url!,
              "http://localhost",
            ).searchParams.get("credential")!,
          }),
        }),
      ],
      configure: (app) => {
        app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app));
      },
    });
    let client: WebSocket | undefined;
    try {
      const response = await auth.api.signUpEmail({
        body: {
          name: "Malformed",
          email: "malformed@example.com",
          password: "password1234",
        },
        asResponse: true,
      });
      const cookie = response.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; ");
      const { token } = await response.json();
      const options = {
        headers: {
          cookie,
          authorization: `Bearer ${token}`,
          origin: "http://localhost:3000",
        },
      };
      const url = `${f.url.replace("http", "ws")}/?credential=${encodeURIComponent(malformed)}`;
      if (authenticateConnection) {
        client = new WebSocket(url, options);
        const socket = client;
        const code = await new Promise<number>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            socket.off("close", closed);
            socket.off("error", failed);
          };
          const closed = (code: number) => {
            cleanup();
            resolve(code);
          };
          const failed = (error: Error) => {
            cleanup();
            reject(error);
          };
          const timer = setTimeout(
            () => failed(new Error("WebSocket close timeout")),
            2000,
          );
          socket.once("close", closed);
          socket.once("error", failed);
        });
        expect(inspect(connectionResult, { depth: 10 })).not.toContain(secret);
        expect(connectionResult).toMatchObject({
          outcome: "rejected",
          failure: { status: 401, reason: "MALFORMED_CREDENTIALS" },
        });
        expect(code).toBe(4401);
      } else {
        client = await connect(url, options.headers);
        expect(await sendMessage(client, "ticker", {})).toEqual({
          event: "ticker",
          data: true,
        });
        for (const event of ["identity", "optional"]) {
          const result = await sendMessage(client, event, {});
          expect(inspect(logs.mock.calls, { depth: 10 })).not.toContain(secret);
          expect(inspect(result, { depth: 10 })).not.toContain(secret);
          expect(result).toMatchObject({
            event: "exception",
            data: { statusCode: 401, reason: "MALFORMED_CREDENTIALS" },
          });
        }
      }
      expect(reads).toBe(0);
      expect(effects).toBe(0);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      client?.terminate();
      await f.close();
      logs.mockRestore();
    }
  },
);
