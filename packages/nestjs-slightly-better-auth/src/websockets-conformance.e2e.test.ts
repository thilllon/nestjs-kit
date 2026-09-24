import {
  Inject,
  Module,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { WsAdapter } from "@nestjs/platform-ws";
import { Test } from "@nestjs/testing";
import {
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import type { Namespace } from "socket.io";
import { io, type Socket } from "socket.io-client";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type {
  AuthTransport,
  BrowserExposure,
  ExtensionDefinition,
  TransportCall,
} from "./auth-contracts.js";
import { UseBetterAuth } from "./auth-decorators.js";
import { AuthFailures } from "./auth-errors.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { BetterAuthService } from "./auth-service.js";
import { runConformance } from "./conformance-fixtures.js";
import {
  type ConnectionAuthenticationResult,
  type FixtureHandler,
  type TransportConformanceOptions,
  type TransportFixtures,
  type TransportInvocationResult,
  transportConformance,
} from "./conformance-transport.js";
import { readErrorProperty } from "./error-redactor.js";
import { expressPlatform } from "./express.js";
import {
  socketIoTransport,
  UPGRADE_REQUEST,
  WS_CONNECTION_AUTH,
  withUpgradeRequest,
  type WsClientLike,
  WsConnectionAuth,
  wsCloseCodeFor,
  wsTransport,
} from "./websockets.js";

type FixtureName = Exclude<keyof TransportFixtures, "graph">;
type Flavor = "socket.io" | "ws";

/** The namespace (Socket.IO) or path (ws) of the gateway that authenticates connections through WS_CONNECTION_AUTH. */
const CONNECTION_ROUTE = "/nsba-connection";
const REPLY_TIMEOUT_MS = 5000;

function flatten(fixtures: TransportFixtures): Map<string, FixtureHandler> {
  const handlers = new Map<string, FixtureHandler>();
  for (const [name, value] of Object.entries(fixtures)) {
    if (name === "graph") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        handlers.set(`${name}${index}`, item);
      }
    } else {
      handlers.set(name, value as FixtureHandler);
    }
  }
  return handlers;
}

/** A gateway with one message handler per kit fixture, named after it; the message body is the fixture's input. */
function fixtureGateway(
  flavor: Flavor,
  handlers: Map<string, FixtureHandler>,
  globalGuard: boolean,
) {
  @WebSocketGateway()
  class KitGateway {
    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  if (globalGuard) {
    // Gateways need explicit coverage on every Nest major (design v7 §9.3).
    UseBetterAuth()(KitGateway);
  }
  for (const [name, fixture] of handlers) {
    const method = async function (this: KitGateway, ...args: unknown[]) {
      const count = fixture.params.length;
      const body = await fixture.handle(
        args.slice(0, count),
        (args[count] ?? {}) as Record<string, unknown>,
        { service: this.service },
      );
      // Socket.IO answers through the acknowledgement; ws sends the returned event.
      return flavor === "ws" ? { event: name, data: body } : body;
    };
    Object.defineProperty(method, "name", { value: name });
    Object.defineProperty(KitGateway.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      KitGateway.prototype,
      name,
    )!;
    for (const [index, param] of fixture.params.entries()) {
      param(KitGateway.prototype, name, index);
    }
    MessageBody()(KitGateway.prototype, name, fixture.params.length);
    for (const decorator of [
      SubscribeMessage(name),
      ...fixture.decorators,
    ].reverse()) {
      decorator(KitGateway.prototype, name, descriptor);
    }
  }
  return KitGateway;
}

/** Connection-time authentication through the documented Socket.IO middleware, on its own namespace. */
@WebSocketGateway({ namespace: CONNECTION_ROUTE })
class IoConnectionGateway implements OnGatewayInit {
  constructor(
    @Inject(WS_CONNECTION_AUTH) private readonly connections: WsConnectionAuth,
  ) {}

  afterInit(server: Namespace): void {
    server.use(this.connections.socketIoMiddleware({ required: true }));
  }
}

/** Connection-time authentication in handleConnection, on its own path: the outcome, then the close code. */
@WebSocketGateway({ path: CONNECTION_ROUTE })
class WsConnectionGateway implements OnGatewayConnection {
  constructor(
    @Inject(WS_CONNECTION_AUTH) private readonly connections: WsConnectionAuth,
  ) {}

  async handleConnection(client: WebSocket): Promise<void> {
    try {
      const result = await this.connections.authenticate(client);
      if (result.outcome === "authenticated") {
        client.send(JSON.stringify({ event: "connection", data: true }));
        return;
      }
      const failure =
        result.outcome === "rejected"
          ? result.failure
          : AuthFailures.unauthenticated();
      client.send(
        JSON.stringify({
          event: "exception",
          data: {
            status: "error",
            statusCode: failure.status,
            code: failure.code,
            reason: failure.reason,
            message: failure.message,
          },
        }),
      );
      client.close(wsCloseCodeFor(failure));
    } catch {
      client.send(
        JSON.stringify({
          event: "exception",
          data: { status: "error", message: "Internal server error" },
        }),
      );
      client.close(1011);
    }
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A WsException payload (`exception` event or connect_error data) as the kit's error. */
function failureOf(payload: unknown): TransportInvocationResult {
  const value = (payload ?? {}) as Record<string, unknown>;
  return {
    ok: false,
    error: {
      statusCode:
        typeof value.statusCode === "number" ? value.statusCode : undefined,
      code: text(value.code),
      reason: text(value.reason),
      message: text(value.message),
    },
    setCookies: [],
  };
}

interface Client {
  send(event: string, data: unknown): Promise<TransportInvocationResult>;
  close(): void;
}

/** The handshake headers, with a bearer token moved to where browsers put it: Socket.IO `auth.token`, a ws `?token=`. */
function handshake(headers: HeadersInit): {
  headers: Record<string, string>;
  token?: string;
} {
  const values: Record<string, string> = {};
  let token: string | undefined;
  for (const [name, value] of new Headers(headers)) {
    const bearer =
      name === "authorization" ? /^Bearer (.+)$/i.exec(value) : null;
    if (bearer) {
      token = bearer[1];
    } else {
      values[name] = value;
    }
  }
  return { headers: values, token };
}

async function ioConnect(
  url: string,
  headers: HeadersInit,
  namespace = "/",
): Promise<Socket> {
  const { headers: extraHeaders, token } = handshake(headers);
  const socket = io(new URL(namespace, url).href, {
    transports: ["websocket"],
    extraHeaders,
    ...(token === undefined ? {} : { auth: { token } }),
    forceNew: true,
    reconnection: false,
    timeout: REPLY_TIMEOUT_MS,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", reject);
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

async function ioClient(url: string, headers: HeadersInit): Promise<Client> {
  const socket = await ioConnect(url, headers);
  return {
    send: (event, data) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          socket.off("exception", exception);
        };
        const exception = (payload: unknown) => {
          cleanup();
          resolve(failureOf(payload));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Socket.IO ${event}: no reply`));
        }, REPLY_TIMEOUT_MS);
        socket.on("exception", exception);
        socket.emit(event, data, (reply: unknown) => {
          cleanup();
          resolve({ ok: true, body: reply, setCookies: [] });
        });
      }),
    close: () => socket.close(),
  };
}

function wsUrl(url: string, path: string, token: string | undefined): URL {
  const target = new URL(path, url.replace(/^http/, "ws"));
  if (token !== undefined) {
    target.searchParams.set("token", token);
  }
  return target;
}

/** The next message of a ws client as parsed JSON. */
function nextMessage(client: WebSocket, label: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      client.off("message", message);
      client.off("error", failed);
      client.off("close", closed);
    };
    const message = (raw: Buffer) => {
      cleanup();
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (error) {
        reject(error);
      }
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = (code: number) => {
      cleanup();
      reject(new Error(`${label}: closed ${code} before replying`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label}: no reply`));
    }, REPLY_TIMEOUT_MS);
    client.on("message", message);
    client.on("error", failed);
    client.on("close", closed);
  });
}

async function wsConnect(
  url: string,
  headers: HeadersInit,
  path: string,
): Promise<{ client: WebSocket; opened: Promise<void> }> {
  const { headers: upgrade, token } = handshake(headers);
  const client = new WebSocket(wsUrl(url, path, token), { headers: upgrade });
  const opened = new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return { client, opened };
}

async function wsClient(url: string, headers: HeadersInit): Promise<Client> {
  const { client, opened } = await wsConnect(url, headers, "/");
  try {
    await opened;
  } catch (error) {
    client.terminate();
    throw error;
  }
  return {
    async send(event, data) {
      const reply = nextMessage(client, `ws ${event}`);
      client.send(JSON.stringify({ event, data }));
      const value = (await reply) as { event?: string; data?: unknown };
      return value.event === "exception"
        ? failureOf(value.data)
        : { ok: true, body: value.data, setCookies: [] };
    },
    close: () => client.terminate(),
  };
}

async function ioAuthenticate(
  url: string,
  headers: HeadersInit,
): Promise<ConnectionAuthenticationResult> {
  try {
    const socket = await ioConnect(url, headers, CONNECTION_ROUTE);
    socket.close();
    return { ok: true };
  } catch (error) {
    const { error: failure } = failureOf(readErrorProperty(error, "data"));
    return { ok: false, error: failure };
  }
}

async function wsAuthenticate(
  url: string,
  headers: HeadersInit,
): Promise<ConnectionAuthenticationResult> {
  const { client, opened } = await wsConnect(url, headers, CONNECTION_ROUTE);
  try {
    const outcome = nextMessage(client, "ws connection authentication");
    await opened;
    const value = (await outcome) as { event?: string; data?: unknown };
    return value.event === "exception"
      ? { ok: false, error: failureOf(value.data).error }
      : { ok: true };
  } finally {
    client.terminate();
  }
}

const apps = new WeakMap<object, string>();

/**
 * A built-in WebSocket transport, exposed through a real gateway on a listening Express app: one connection per
 * invocation, handshake headers from the kit's headers, bearer tokens where browsers put them.
 */
function websocketHarness(
  flavor: Flavor,
  transport: ExtensionDefinition<AuthTransport>,
): TransportConformanceOptions {
  const connect = flavor === "ws" ? wsClient : ioClient;
  const entry = (handler: FixtureName) =>
    handler === "triple" || handler === "tripleMixed" ? `${handler}0` : handler;
  const session = async <T>(
    app: INestApplication,
    headers: HeadersInit,
    run: (client: Client) => Promise<T>,
  ): Promise<T> => {
    const client = await connect(apps.get(app)!, headers);
    try {
      return await run(client);
    } finally {
      client.close();
    }
  };
  return {
    transport,
    expectCookieCapable: false,
    expectBrowserLeg: true,
    invocationShapes: ["messages"],
    async createApp(fixtures, auth, options) {
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            platforms: [expressPlatform()],
            transports: [transport],
            globalGuard: options.globalGuard,
            principals: options.principals,
            ...(options.defaultRequirements
              ? { defaultRequirements: options.defaultRequirements }
              : {}),
            ...(options.globalScope === undefined
              ? {}
              : { globalScope: options.globalScope }),
            logSummary: false,
          } as never),
        ],
        providers: [
          fixtureGateway(flavor, flatten(fixtures), options.globalGuard),
          flavor === "ws" ? WsConnectionGateway : IoConnectionGateway,
          ...(options.appEnhancers
            ? [
                { provide: APP_GUARD, useClass: BetterAuthGuard },
                {
                  provide: APP_INTERCEPTOR,
                  useClass: BetterAuthScopeInterceptor,
                },
              ]
            : []),
        ],
      })
      class WebSocketFixtureModule {}
      let builder = Test.createTestingModule({
        imports: [WebSocketFixtureModule],
      });
      if (options.override) {
        builder = options.override(builder);
      }
      const moduleRef = await builder.compile();
      const app = moduleRef.createNestApplication(new ExpressAdapter(), {
        logger: options.logger ?? false,
      });
      app.useWebSocketAdapter(
        flavor === "ws"
          ? new (withUpgradeRequest(WsAdapter))(app)
          : new IoAdapter(app),
      );
      try {
        await app.init();
        await app.listen(0, "127.0.0.1");
      } catch (error) {
        await app.close();
        throw error;
      }
      apps.set(app, await app.getUrl());
      return app;
    },
    invoke: (app, handler, headers, input = {}) =>
      session(app, headers, (client) => client.send(entry(handler), input)),
    invokeTwice: (app, _shape, [first, second], headers) =>
      session(app, headers, async (client) => [
        await client.send("org", first),
        await client.send("org", second),
      ]),
    invokeConnection: (app, handlers, headers) =>
      session(app, headers, async (client) => {
        const results: TransportInvocationResult[] = [];
        for (const handler of handlers) {
          results.push(await client.send(entry(handler), {}));
        }
        return results;
      }),
    authenticateConnection: (app, headers) =>
      (flavor === "ws" ? wsAuthenticate : ioAuthenticate)(
        apps.get(app)!,
        headers,
      ),
  };
}

/** Reads a bearer token from the upgrade URL's `?token=`, where browser ws clients put it. */
const queryToken = (client: WsClientLike) => {
  const token = new URL(
    client[UPGRADE_REQUEST]?.url ?? "/",
    "http://localhost",
  ).searchParams.get("token");
  return token === null ? undefined : { authorization: `Bearer ${token}` };
};

describe("transport kit on the built-in Socket.IO transport", () => {
  runConformance(
    transportConformance(websocketHarness("socket.io", socketIoTransport())),
    { describe, it },
  );
});

describe("transport kit on the built-in Socket.IO transport with a principal TTL", () => {
  runConformance(
    transportConformance(
      websocketHarness(
        "socket.io",
        socketIoTransport({ principalTtlMs: 60_000 }),
      ),
    ),
    { describe, it },
  );
});

describe("transport kit on the built-in ws transport", () => {
  runConformance(
    transportConformance(
      websocketHarness("ws", wsTransport({ credentials: queryToken })),
    ),
    { describe, it },
  );
});

describe("transport kit on the built-in ws transport with a principal TTL", () => {
  runConformance(
    transportConformance(
      websocketHarness(
        "ws",
        wsTransport({ credentials: queryToken, principalTtlMs: 60_000 }),
      ),
    ),
    { describe, it },
  );
});

/** A Socket.IO transport whose calls pass through `change`, with getters kept lazy. */
function faultySocketIo(
  change: (call: TransportCall, context: ExecutionContext) => TransportCall,
  overrides: Partial<AuthTransport> = {},
): ExtensionDefinition<AuthTransport> {
  const definition = socketIoTransport();
  const real = (definition.use as { useFactory(): AuthTransport }).useFactory();
  return {
    ...definition,
    use: {
      useFactory: (): AuthTransport => ({
        ...real,
        describe: (context, kit) =>
          change(real.describe(context, kit), context),
        ...overrides,
      }),
    },
  };
}

function withBrowser(
  call: TransportCall,
  browser: (leg: BrowserExposure | undefined) => BrowserExposure | undefined,
): TransportCall {
  return {
    key: call.key,
    invocation: call.invocation,
    connection: call.connection,
    principalTtlMs: call.principalTtlMs,
    headers: () => call.headers(),
    param: (name) => call.param(name),
    get clientIp() {
      return call.clientIp;
    },
    get cookies() {
      return call.cookies;
    },
    get request() {
      return call.request;
    },
    get browser() {
      return browser(call.browser);
    },
  };
}

function handshakeOf(context: ExecutionContext) {
  return context.switchToWs().getClient<{
    handshake: {
      auth?: Record<string, unknown>;
      headers: Record<string, string | undefined>;
      url: string;
    };
  }>().handshake;
}

describe("WebSocket origin row mutations", () => {
  const caseOf = (transport: ExtensionDefinition<AuthTransport>, id: string) =>
    transportConformance(websocketHarness("socket.io", transport)).find(
      (item) => item.id === id,
    )!;

  it("passes every T-ws-origin row for the production Socket.IO transport", async () => {
    for (const id of [
      "T-ws-origin-untrusted",
      "T-ws-origin-junk-token",
      "T-ws-origin-dynamic-baseurl",
      "T-ws-origin-forwarded-host",
      "T-ws-origin-function-trusted-origins",
    ]) {
      await expect(caseOf(socketIoTransport(), id).run()).resolves.toBe(
        undefined,
      );
    }
  });

  it("fails T-selection for a harness that declares no browser leg for a WebSocket transport", async () => {
    const cases = transportConformance({
      ...websocketHarness("socket.io", socketIoTransport()),
      expectBrowserLeg: false,
    });
    await expect(
      cases.find((item) => item.id === "T-selection")!.run(),
    ).rejects.toThrow(
      /describes a browser leg, so expectBrowserLeg must be true/,
    );
    expect(
      cases.find((item) => item.id === "T-ws-origin-untrusted")!.skip,
    ).toBe("the transport declares no browser leg");
  });

  it("fails the T-ws-origin rows for a harness without connection-time authentication when the app provides it", async () => {
    const cases = transportConformance({
      ...websocketHarness("socket.io", socketIoTransport()),
      authenticateConnection: undefined,
    });
    await expect(
      cases.find((item) => item.id === "T-ws-origin-junk-token")!.run(),
    ).rejects.toThrow(
      /provides WS_CONNECTION_AUTH, so authenticateConnection is required/,
    );
  });

  it("fails T-ws-origin-untrusted for a transport that enforces its handshake only like a safe read", async () => {
    const lenient = faultySocketIo((call) =>
      withBrowser(call, (leg) => leg && { ...leg, enforce: false }),
    );
    await expect(
      caseOf(lenient, "T-ws-origin-untrusted").run(),
    ).rejects.toThrow(
      /a cookie handshake from an untrusted Origin, required: expected a 403 denial, got success/,
    );
  });

  it("fails T-ws-origin-junk-token for a transport that exempts handshakes carrying a token", async () => {
    const exempting = faultySocketIo((call, context) =>
      withBrowser(call, (leg) =>
        handshakeOf(context).auth?.token === undefined ? leg : undefined,
      ),
    );
    await expect(
      caseOf(exempting, "T-ws-origin-junk-token").run(),
    ).rejects.toThrow(
      /a cookie plus a junk bearer token from an untrusted Origin, required: expected a 403 denial, got success/,
    );
  });

  it("fails T-ws-origin-dynamic-baseurl for a transport whose leg URL is the handshake's bare path", async () => {
    const relative = faultySocketIo((call, context) =>
      withBrowser(
        call,
        (leg) => leg && { ...leg, url: handshakeOf(context).url },
      ),
    );
    await expect(
      caseOf(relative, "T-ws-origin-dynamic-baseurl").run(),
    ).rejects.toThrow(
      /a same-origin cookie handshake, required: expected success/,
    );
  });

  it("fails T-ws-origin-forwarded-host for a transport that builds its leg URL from forwarded headers", async () => {
    const forwarded = faultySocketIo((call, context) =>
      withBrowser(call, (leg) => {
        const headers = handshakeOf(context).headers;
        const host = headers["x-forwarded-host"] ?? headers.host;
        const scheme = headers["x-forwarded-proto"] ?? "http";
        return leg && { ...leg, url: `${scheme}://${host}/socket.io/` };
      }),
    );
    await expect(
      caseOf(forwarded, "T-ws-origin-forwarded-host").run(),
    ).rejects.toThrow(
      /unset baseURL, trustedProxyHeaders false: a forwarded-host spoof, required: expected a 403 denial, got success/,
    );
  });

  it("fails T-ws-origin-function-trusted-origins for a transport that answers internal errors with their cause", async () => {
    const detailed = faultySocketIo((call) => call, {
      toInternalException: (error) =>
        new WsException({
          status: "error",
          message: String(
            readErrorProperty(readErrorProperty(error, "cause"), "message"),
          ),
        }),
    });
    await expect(
      caseOf(detailed, "T-ws-origin-function-trusted-origins").run(),
    ).rejects.toThrow(/the client saw the trustedOrigins\(\) error/);
  });
});
