import "reflect-metadata";
import { inspect } from "node:util";
import { Inject, Logger, UseGuards } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { IoAdapter } from "@nestjs/platform-socket.io";
import {
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Server } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { betterAuth } from "better-auth";
import { nestjs } from "./plugin.js";
import { admin, bearer, organization } from "better-auth/plugins";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it, vi } from "vitest";
import {
  OptionalAuth,
  Public,
  RequireAuth,
  UseAuthInstance,
  UseBetterAuth,
} from "./auth-decorators.js";
import { getBetterAuthServiceToken } from "./auth-tokens.js";
import type { BetterAuthService } from "./auth-service.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { RequirePermission } from "./admin.js";
import { CurrentSession } from "./session-principal.js";
import { expressPlatform } from "./express.js";
import {
  ActiveMemberRole,
  ActiveOrganizationId,
  fromParam,
  RequireOrgMember,
} from "./organization.js";
import { createTestAuth, startHttpFixture } from "./test-fixtures.js";
import {
  socketIoTransport,
  WS_CONNECTION_AUTH,
  WsConnectionAuth,
  type WsTransportOptions,
  type SocketIoClientLike,
} from "./websockets.js";

async function connect(
  url: string,
  options: {
    headers?: Record<string, string>;
    token?: string;
    polling?: boolean;
  } = {},
): Promise<Socket> {
  const socket = io(url, {
    transports: [options.polling ? "polling" : "websocket"],
    extraHeaders: options.headers,
    auth: options.token ? { token: options.token } : undefined,
    forceNew: true,
    reconnection: false,
    timeout: 2000,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        socket.off("connect_error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        socket.off("connect", done);
        reject(error);
      };
      socket.once("connect", done);
      socket.once("connect_error", failed);
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}
function message(
  socket: Socket,
  event: string,
  data: unknown = {},
): Promise<any> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("exception", exception);
    };
    const exception = (error: unknown) => {
      cleanup();
      resolve(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Socket.IO ${event} reply timeout`));
    }, 2000);
    socket.once("exception", exception);
    socket.emit(event, data, (reply: unknown) => {
      cleanup();
      resolve(reply);
    });
  });
}
async function fixture(
  options: {
    ttl?: number;
    required?: boolean;
    connectionInstance?: string;
    credentials?: WsTransportOptions<SocketIoClientLike>["credentials"];
    dynamic?: boolean;
    trustedProxyHeaders?: boolean;
    allowMissing?: boolean;
  } = {},
) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  let fail: "rejected" | "outage" | undefined;
  let reads = 0;
  let effects = 0;
  let originCalls = 0;
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    baseURL: options.dynamic
      ? { allowedHosts: ["localhost:3000"], fallback: "http://localhost:3000" }
      : "http://localhost:3000",
    advanced: {
      trustedProxyHeaders: options.trustedProxyHeaders ?? true,
      disableOriginCheck: false,
    },
    trustedOrigins: () => {
      originCalls++;
      return ["https://trusted.example"];
    },
    database: memoryAdapter(database),
    plugins: [bearer(), admin(), organization(), nestjs()],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/get-session") {
          reads++;
          if (fail === "outage") {
            throw new Error("database unavailable secret");
          }
          if (fail === "rejected") {
            throw new APIError("UNAUTHORIZED", {
              message: "rejected credential",
            });
          }
        }
      }),
    },
  });
  const named = createTestAuth({
    basePath: "/other/auth",
    advanced: { cookiePrefix: "other" },
  });
  @WebSocketGateway()
  @UseBetterAuth()
  class Gateway {
    constructor(
      @Inject(WS_CONNECTION_AUTH) readonly connectionAuth: WsConnectionAuth,
      @Inject(getBetterAuthServiceToken())
      private readonly authService: BetterAuthService<typeof auth>,
    ) {}

    afterInit(server: Server) {
      if (options.required !== undefined) {
        server.use(
          this.connectionAuth.socketIoMiddleware({
            required: options.required,
            instance: options.connectionInstance,
          }),
        );
      }
    }

    @Public()
    @SubscribeMessage("ticker")
    ticker() {
      return { public: true };
    }

    @RequireAuth()
    @SubscribeMessage("identity")
    identity(@CurrentSession() session: { user: { email: string } }) {
      effects++;
      return { email: session.user.email };
    }

    @RequireAuth({ authoritative: true })
    @SubscribeMessage("fresh")
    fresh(@CurrentSession() session: { user: { email: string } }) {
      return { email: session.user.email };
    }

    @RequireAuth()
    @SubscribeMessage("direct")
    async direct(@MessageBody() body: { token: string }) {
      const session = await this.authService.api.getSession({
        headers: new Headers({ authorization: `Bearer ${body.token}` }),
      });
      return { email: session?.user.email };
    }

    @RequirePermission({ user: ["list"] })
    @SubscribeMessage("admin")
    admin() {
      return { ok: true };
    }

    @OptionalAuth()
    @SubscribeMessage("optional")
    optional(@CurrentSession() session: { user: { email: string } } | null) {
      effects++;
      return { email: session?.user.email ?? null };
    }

    @UseAuthInstance("other")
    @RequireAuth()
    @SubscribeMessage("other")
    other(@CurrentSession() session: { user: { email: string } }) {
      return { email: session.user.email };
    }

    @RequireOrgMember({ organization: fromParam("orgId") })
    @SubscribeMessage("organization")
    async org(
      @ActiveOrganizationId() orgId: string,
      @ActiveMemberRole() role: string,
      @MessageBody() body: { delay: number },
    ) {
      await new Promise((resolve) => setTimeout(resolve, body.delay));
      return { orgId, role };
    }
  }
  const http = await startHttpFixture({
    auth,
    adapter: new ExpressAdapter(),
    platform: expressPlatform(),
    controllers: [],
    providers: [Gateway],
    transports: [
      socketIoTransport({
        principalTtlMs: options.ttl,
        credentials: options.credentials,
      }),
    ],
    imports: [
      BetterAuthModule.forRoot({
        name: "other",
        auth: named,
        http: { mount: false },
      }),
    ],
    moduleOptions: options.allowMissing
      ? { originCheck: { missingOrigin: "allow-non-browser" } }
      : {},
    configure: (app) => {
      app.useWebSocketAdapter(new IoAdapter(app));
    },
  });
  async function login(
    instance: typeof auth | typeof named = auth,
    email = "socket@example.com",
  ) {
    const response = await instance.api.signUpEmail({
      body: { email, name: "Socket", password: "password1234" },
      asResponse: true,
    });
    if (response.status !== 200) {
      throw new Error(
        `Signup failed ${response.status}: ${await response.text()}`,
      );
    }
    const body = await response.json();
    return {
      cookie: response.headers
        .getSetCookie()
        .map((value) => value.split(";")[0])
        .join("; "),
      token: body.token as string,
      id: body.user.id as string,
    };
  }
  return {
    ...http,
    auth,
    named,
    database,
    login,
    helper: http.app.get<WsConnectionAuth>(WS_CONNECTION_AUTH),
    setFailure: (value: typeof fail) => {
      fail = value;
    },
    reads: () => reads,
    effects: () => effects,
    origins: () => originCalls,
  };
}

describe("native Socket.IO authentication", () => {
  it("authenticates mapped tokens, preserves authorization precedence, and isolates named instances", async () => {
    const f = await fixture();
    const clients: Socket[] = [];
    try {
      const a = await f.login();
      const b = await f.login(f.named, "other@example.com");
      const tokenClient = await connect(f.url, { token: a.token });
      clients.push(tokenClient);
      expect(await message(tokenClient, "identity")).toEqual({
        email: "socket@example.com",
      });
      const namedClient = await connect(f.url, {
        headers: {
          cookie: `${a.cookie}; ${b.cookie}`,
          origin: "http://localhost:3000",
        },
      });
      clients.push(namedClient);
      expect(await message(namedClient, "identity")).toEqual({
        email: "socket@example.com",
      });
      expect(await message(namedClient, "other")).toEqual({
        email: "other@example.com",
      });
      const browser = await connect(f.url, {
        token: "junk",
        headers: { authorization: `Bearer ${a.token}` },
      });
      clients.push(browser);
      expect(await message(browser, "identity")).toEqual({
        email: "socket@example.com",
      });
    } finally {
      for (const client of clients) {
        client.close();
      }
      await f.close();
    }
  });
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "denies cookie CSWSH with junk token and forwarded spoof (polling=%s, SDK proxy=%s)",
    async (polling, trustedProxyHeaders) => {
      const f = await fixture({ dynamic: true, trustedProxyHeaders });
      const clients: Socket[] = [];
      try {
        const a = await f.login();
        for (const origin of ["https://evil.example", "null", undefined]) {
          const headers = {
            cookie: a.cookie,
            host: "localhost:3000",
            "x-forwarded-host": "evil.example",
            "x-forwarded-proto": "https",
            ...(origin ? { origin } : {}),
          };
          const client = await connect(f.url, {
            headers,
            token: "a.b",
            polling,
          });
          clients.push(client);
          for (let i = 0; i < 2; i++) {
            expect(await message(client, "identity")).toMatchObject({
              statusCode: 403,
            });
          }
          await expect(
            f.helper.authenticate({
              handshake: {
                headers,
                auth: { token: "a.b" },
                url: "/socket.io/",
              },
            }),
          ).resolves.toMatchObject({
            outcome: "rejected",
            failure: { status: 403 },
          });
        }
      } finally {
        for (const client of clients) {
          client.close();
        }
        await f.close();
      }
    },
  );
  it("uses one trusted-origin verdict per connection and revalidates sessions on every message by default", async () => {
    const f = await fixture();
    let client: Socket | undefined;
    try {
      const a = await f.login();
      client = await connect(f.url, {
        headers: { cookie: a.cookie, origin: "https://trusted.example" },
      });
      const before = f.origins();
      expect(await message(client, "identity")).toEqual({
        email: "socket@example.com",
      });
      const checked = f.origins();
      const reads = f.reads();
      expect(await message(client, "identity")).toEqual({
        email: "socket@example.com",
      });
      expect(f.reads()).toBe(reads + 1);
      expect(f.origins()).toBe(checked);
      expect(checked).toBeGreaterThan(before);
      f.database.session.splice(0);
      expect(await message(client, "identity")).toMatchObject({
        statusCode: 401,
      });
    } finally {
      client?.close();
      await f.close();
    }
  });
  it("suppresses refresh for connection resolution, message resolution, and scoped direct SDK calls", async () => {
    const f = await fixture({ required: true });
    let client: Socket | undefined;
    try {
      const a = await f.login();
      const expiry = new Date(Date.now() + 60_000);
      f.database.session[0]!.expiresAt = expiry;
      client = await connect(f.url, { token: a.token });
      expect(await message(client, "direct", { token: a.token })).toEqual({
        email: "socket@example.com",
      });
      expect(f.database.session[0]!.expiresAt).toEqual(expiry);
    } finally {
      client?.close();
      await f.close();
    }
  });
  it("requires a session only when connection middleware requests it and rejects unsafe cookies", async () => {
    const f = await fixture({ required: true });
    let client: Socket | undefined;
    try {
      await expect(connect(f.url)).rejects.toMatchObject({
        data: { statusCode: 401 },
      });
      const a = await f.login();
      await expect(
        connect(f.url, {
          token: "junk",
          headers: { cookie: a.cookie, origin: "https://evil.example" },
        }),
      ).rejects.toMatchObject({ data: { statusCode: 403 } });
      client = await connect(f.url, { token: a.token });
      expect(await message(client, "identity")).toEqual({
        email: "socket@example.com",
      });
    } finally {
      client?.close();
      await f.close();
    }
    const optional = await fixture({ required: false });
    let anonymous: Socket | undefined;
    try {
      anonymous = await connect(optional.url);
      expect(await message(anonymous, "optional")).toEqual({ email: null });
      expect(await message(anonymous, "identity")).toMatchObject({
        statusCode: 401,
      });
    } finally {
      anonymous?.close();
      await optional.close();
    }
  });
  it.each(["ban", "revoke"] as const)(
    "shares positive TTL from connection auth but authoritative messages observe %s",
    async (action) => {
      const f = await fixture({ ttl: 60_000, required: true });
      let client: Socket | undefined;
      try {
        const a = await f.login();
        client = await connect(f.url, { token: a.token });
        const reads = f.reads();
        expect(await message(client, "identity")).toEqual({
          email: "socket@example.com",
        });
        expect(f.reads()).toBe(reads);
        f.database.user[0]!.role = "admin";
        expect(await message(client, "admin")).toEqual({ ok: true });
        if (action === "ban") {
          const operator = await f.login(f.auth, "operator@example.com");
          f.database.user.find((user) => user.id === operator.id)!.role =
            "admin";
          await f.auth.api.banUser({
            headers: new Headers({ cookie: operator.cookie }),
            body: { userId: a.id },
          });
        } else {
          await f.auth.api.revokeSession({
            headers: new Headers({ cookie: a.cookie }),
            body: { token: a.token },
          });
        }
        expect(await message(client, "admin")).toMatchObject({
          statusCode: 401,
        });
        expect(await message(client, "identity")).toEqual({
          email: "socket@example.com",
        });
        expect(await message(client, "fresh")).toMatchObject({
          statusCode: 401,
        });
      } finally {
        client?.close();
        await f.close();
      }
    },
  );
  it("never persists rejected credentials or SDK outages in a positive connection cache", async () => {
    const f = await fixture({ ttl: 60_000 });
    let client: Socket | undefined;
    try {
      const a = await f.login();
      client = await connect(f.url, { token: a.token });
      f.setFailure("rejected");
      expect(await message(client, "identity")).toMatchObject({
        statusCode: 401,
      });
      f.setFailure("outage");
      expect(await message(client, "identity")).toMatchObject({
        message: "Internal server error",
      });
      f.setFailure(undefined);
      expect(await message(client, "identity")).toEqual({
        email: "socket@example.com",
      });
    } finally {
      client?.close();
      await f.close();
    }
  });
  it("isolates concurrent policy parameters and invocation values on one socket", async () => {
    const f = await fixture({ ttl: 60_000 });
    let client: Socket | undefined;
    try {
      const a = await f.login();
      const headers = new Headers({ cookie: a.cookie });
      const one = await f.auth.api.createOrganization({
        headers,
        body: { name: "One", slug: "one" },
      });
      const two = await f.auth.api.createOrganization({
        headers,
        body: { name: "Two", slug: "two" },
      });
      if (!one || !two) {
        throw new Error("Missing organizations");
      }
      f.database.member.find(
        (member) => member.organizationId === two.id,
      )!.role = "member";
      client = await connect(f.url, { token: a.token });
      const replies = await Promise.all([
        message(client, "organization", { orgId: one.id, delay: 25 }),
        message(client, "organization", { orgId: two.id, delay: 0 }),
      ]);
      expect(replies).toEqual([
        { orgId: one.id, role: "owner" },
        { orgId: two.id, role: "member" },
      ]);
      expect(
        await message(client, "organization", { orgId: "unrelated", delay: 0 }),
      ).toMatchObject({ statusCode: 403 });
    } finally {
      client?.close();
      await f.close();
    }
  });
  it("uses the selected named instance for real connection middleware", async () => {
    const f = await fixture({ required: true, connectionInstance: "other" });
    let client: Socket | undefined;
    try {
      const a = await f.login();
      const b = await f.login(f.named, "named@example.com");
      await expect(
        connect(f.url, {
          headers: { cookie: a.cookie, origin: "http://localhost:3000" },
        }),
      ).rejects.toMatchObject({ data: { statusCode: 401 } });
      client = await connect(f.url, {
        headers: { cookie: b.cookie, origin: "http://localhost:3000" },
      });
      expect(await message(client, "other")).toEqual({
        email: "named@example.com",
      });
    } finally {
      client?.close();
      await f.close();
    }
  });
  it("allows explicitly configured missing origins only for non-browser cookie clients", async () => {
    const f = await fixture({ allowMissing: true });
    let client: Socket | undefined;
    try {
      const a = await f.login();
      client = await connect(f.url, { headers: { cookie: a.cookie } });
      expect(await message(client, "identity")).toEqual({
        email: "socket@example.com",
      });
    } finally {
      client?.close();
      await f.close();
    }
  });
  it("rejects gateway coverage that has only a guard and no scope interceptor", async () => {
    @WebSocketGateway()
    @UseGuards(BetterAuthGuard)
    class Gateway {
      @SubscribeMessage("identity") @RequireAuth() identity() {
        return true;
      }
    }
    await expect(
      startHttpFixture({
        auth: createTestAuth(),
        adapter: new ExpressAdapter(),
        platform: expressPlatform(),
        controllers: [],
        providers: [Gateway],
        transports: [socketIoTransport()],
        configure: (app) => {
          app.useWebSocketAdapter(new IoAdapter(app));
        },
      }),
    ).rejects.toMatchObject({
      detail: expect.stringContaining("GATEWAY_UNGUARDED"),
    });
  });
});
it.each([false, true])(
  "rejects polling forwarded-origin spoof with request-derived baseURL (SDK proxy=%s)",
  async (trustedProxyHeaders) => {
    @WebSocketGateway()
    @UseBetterAuth()
    class Gateway {
      @RequireAuth() @SubscribeMessage("identity") identity() {
        return { ok: true };
      }
    }
    const auth = createTestAuth({
      baseURL: undefined,
      advanced: { trustedProxyHeaders },
      plugins: [bearer()],
    });
    const f = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      providers: [Gateway],
      transports: [socketIoTransport()],
      moduleOptions: { http: { allowRequestDerivedBaseURL: true } },
      configure: (app) => {
        app.useWebSocketAdapter(new IoAdapter(app));
      },
    });
    let client: Socket | undefined;
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
      const headers = {
        cookie,
        host: new URL(f.url).host,
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      };
      client = await connect(f.url, { headers, token: "a.b", polling: true });
      expect(await message(client, "identity")).toMatchObject({
        statusCode: 403,
      });
      expect(
        await f.app.get<WsConnectionAuth>(WS_CONNECTION_AUTH).authenticate({
          handshake: { headers, auth: { token: "a.b" }, url: "/socket.io/" },
        }),
      ).toMatchObject({ outcome: "rejected", failure: { status: 403 } });
    } finally {
      client?.close();
      await f.close();
    }
  },
);
it.each([
  ["default", undefined],
  ["custom", undefined],
  ["default", false],
  ["custom", false],
  ["default", true],
  ["custom", true],
] as const)(
  "safely denies malformed Socket.IO credentials (%s mapping, required=%s)",
  async (mapping, required) => {
    const secret = "SOCKET_IO_MALFORMED_SECRET";
    const malformed = `${secret}\r\nInjected: value`;
    const logs = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);
    const f = await fixture({
      required,
      credentials:
        mapping === "custom" ? () => ({ cookie: malformed }) : undefined,
    });
    let client: Socket | undefined;
    try {
      const login = await f.login();
      const reads = f.reads();
      const headers = {
        cookie: login.cookie,
        origin: "http://localhost:3000",
        ...(mapping === "custom"
          ? { authorization: `Bearer ${login.token}` }
          : {}),
      };
      if (required === undefined) {
        client = await connect(f.url, { headers, token: malformed });
        expect(await message(client, "ticker")).toEqual({ public: true });
        for (const event of ["identity", "optional"]) {
          const response = await message(client, event);
          expect(inspect(logs.mock.calls, { depth: 10 })).not.toContain(secret);
          expect(inspect(response, { depth: 10 })).not.toContain(secret);
          expect(response).toMatchObject({
            statusCode: 401,
            reason: "MALFORMED_CREDENTIALS",
          });
        }
      } else {
        const failure = await connect(f.url, {
          headers,
          token: malformed,
        }).then(
          (connected) => {
            client = connected;
            return null;
          },
          (error: unknown) => error,
        );
        expect(inspect(logs.mock.calls, { depth: 10 })).not.toContain(secret);
        expect(inspect(failure, { depth: 10 })).not.toContain(secret);
        expect(failure).toMatchObject({
          data: { statusCode: 401, reason: "MALFORMED_CREDENTIALS" },
        });
      }
      expect(f.reads()).toBe(reads);
      expect(f.effects()).toBe(0);
      expect(logs).not.toHaveBeenCalled();
    } finally {
      client?.close();
      await f.close();
      logs.mockRestore();
    }
  },
);
