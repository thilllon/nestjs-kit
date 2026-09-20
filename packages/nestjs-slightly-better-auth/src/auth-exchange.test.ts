import { Get, UnauthorizedException } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthContextView,
  HttpRequestAccessor,
  InboundAuthRequest,
} from "./auth-contracts.js";
import { AuthFailures, isInfrastructureError } from "./auth-errors.js";
import { AuthExchange, betterAuthCorsOrigin } from "./auth-exchange.js";
import { HttpTransport, httpTransport } from "./http-transport.js";
import type { AuthLike } from "./auth-types.js";
import type { InstanceEntry } from "./instance-registry.js";
import { RequestScope } from "./request-scope.js";
import { nestjs } from "./plugin.js";
import { BRIDGE_HANDLE, type BridgeHandle } from "./bridge-protocol.js";

function fixture(overrides: Partial<InstanceEntry> = {}) {
  const scope = new RequestScope();
  const handler = vi.fn(async (_request: Request) => new Response("ok"));
  const entry = {
    name: "default",
    instance: { handler, api: {} },
    options: { http: {} },
    context: {
      secret: "server-secret",
      options: {},
      rateLimit: { enabled: true },
    },
    bridge: { clientIpHeader: "x-nsba-ip-private" },
    credentialHeaders: ["x-api-key"],
    ...overrides,
  } as unknown as InstanceEntry;
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };
  const exchange = new AuthExchange(scope);
  const init = {
    basePath: "/api/auth",
    bodyLimit: 8,
    staticOrigin: "https://auth.example",
    logger,
  };
  return {
    scope,
    handler,
    entry,
    logger,
    exchange,
    init,
    binding: exchange.create(entry, init),
  };
}
function inbound(
  overrides: Partial<InboundAuthRequest> = {},
): InboundAuthRequest {
  return {
    method: "POST",
    url: "http://untrusted.example/api/auth/a%2Fb?x=%2F",
    headers: new Headers(),
    body: null,
    clientIp: "203.0.113.1",
    platformRequest: {},
    ...overrides,
  };
}

describe("AuthExchange", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("wraps arbitrary thrown values without exposing an error from classification", async () => {
    const { handler, binding } = fixture();
    for (const cause of [
      null,
      undefined,
      new Proxy(
        {},
        {
          get() {
            throw new Error("unsafe getter");
          },
        },
      ),
    ]) {
      handler.mockRejectedValue(cause);
      await expect(binding.handle(inbound())).rejects.toMatchObject({
        message: "Authentication service unavailable",
      });
    }
  });

  it("dispatches the original SDK instance without mutating construction options", async () => {
    const plugin = nestjs();
    const instance = betterAuth({
      baseURL: "https://auth.example",
      advanced: { disableOriginCheck: false },
      secret: "exchange-test-secret-at-least-thirty-two-characters",
      logger: { disabled: true },
      plugins: [plugin],
    });
    const context = (await instance.$context) as unknown as AuthContextView;
    const bridge = Reflect.get(plugin, BRIDGE_HANDLE) as BridgeHandle;
    const { exchange, entry, init } = fixture();
    const originalOptions = instance.options;
    const originalAdvanced = instance.options.advanced;
    const binding = exchange.create(
      { ...entry, instance, context, bridge },
      init,
    );
    const response = await binding.handle(
      inbound({
        method: "GET",
        url: "http://hostile.example/api/auth/get-session",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(instance.options).toBe(originalOptions);
    expect(instance.options.advanced).toBe(originalAdvanced);
  });

  it("warns about untrusted proxies once per app and describes disabled rate limiting accurately", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { exchange, entry, init, logger } = fixture();
    const options = {
      ...init,
      proxyTrust: { mode: "none" as const, detail: "trust proxy = false" },
    };
    const first = exchange.create(
      {
        ...entry,
        context: { ...entry.context, rateLimit: { enabled: false } },
      },
      options,
    );
    const second = exchange.create({ ...entry, name: "other" }, options);
    const request = inbound({
      headers: new Headers({ "x-forwarded-for": "203.0.113.7" }),
    });
    await first.handle(request);
    await second.handle(request);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]![0]).toContain("W_PROXY_UNTRUSTED");
    expect(logger.warn.mock.calls[0]![0]).toContain("sessions only");
  });

  it("redacts credentials introduced by around interceptors and handles aborted streams", async () => {
    const { exchange, entry, init, handler } = fixture();
    handler.mockRejectedValue(new Error("replacement-secret"));
    const binding = exchange.create(
      {
        ...entry,
        options: {
          ...entry.options,
          http: {
            around: [
              async (call, next) =>
                next(
                  new Request(call.request, {
                    headers: { authorization: "Bearer replacement-secret" },
                  }),
                ),
            ],
          },
        },
      },
      init,
    );
    await expect(binding.handle(inbound())).rejects.toMatchObject({
      cause: { message: "[REDACTED]" },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("aborted"));
      },
    });
    await expect(
      binding.handle(inbound({ body: stream })),
    ).rejects.toMatchObject({ message: "Authentication service unavailable" });
  });

  it("matches undecoded path boundaries and supports explicitly selected root mounts", () => {
    const { binding, exchange, entry, init } = fixture();
    expect(binding.matches("/api/auth")).toBe(true);
    expect(binding.matches("/api/auth/x")).toBe(true);
    expect(binding.matches("/api/authentic")).toBe(false);
    expect(binding.matches("/api/auth%2Fx")).toBe(false);
    expect(
      exchange.create(entry, { ...init, basePath: "/" }).matches("/anything"),
    ).toBe(true);
  });
  it("substitutes only the origin and sanitizes IP and hop-by-hop headers without changing input", async () => {
    const { handler, binding } = fixture();
    const headers = new Headers({
      connection: "keep-alive, x-hop",
      "x-hop": "remove",
      "keep-alive": "timeout=5",
      "transfer-encoding": "chunked",
      "x-nsba-ip-private": "spoof",
      "x-nsba-ip-other": "spoof",
      origin: "https://browser.example",
      "x-forwarded-host": "proxy.example",
      cookie: "session=abc",
    });
    await binding.handle(
      inbound({ headers, body: new TextEncoder().encode("hello") }),
    );
    const request = handler.mock.calls[0]![0];
    expect(request.url).toBe("https://auth.example/api/auth/a%2Fb?x=%2F");
    expect(await request.text()).toBe("hello");
    expect(request.headers.get("x-nsba-ip-private")).toBe("203.0.113.1");
    for (const name of [
      "connection",
      "keep-alive",
      "transfer-encoding",
      "x-hop",
      "x-nsba-ip-other",
    ]) {
      expect(request.headers.has(name)).toBe(false);
    }
    expect(request.headers.get("origin")).toBe("https://browser.example");
    expect(request.headers.get("x-forwarded-host")).toBe("proxy.example");
    expect(headers.get("x-nsba-ip-private")).toBe("spoof");
  });
  it("retains dynamic origins, rejects invalid URLs, and clears IP spoofing without an address", async () => {
    const { exchange, entry, init, handler } = fixture();
    const binding = exchange.create(entry, {
      ...init,
      staticOrigin: undefined,
    });
    await binding.handle(
      inbound({
        clientIp: null,
        headers: new Headers({ "x-nsba-ip-private": "spoof" }),
      }),
    );
    expect(handler.mock.calls[0]![0].url).toContain(
      "http://untrusted.example/",
    );
    expect(handler.mock.calls[0]![0].headers.has("x-nsba-ip-private")).toBe(
      false,
    );
    const response = await binding.handle(inbound({ url: "not a url" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "INVALID_REQUEST_URL",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it("bounds bytes and streamed bytes, cancels overflow, and removes GET/HEAD bodies", async () => {
    const { binding, handler } = fixture();
    const cancel = vi.fn();
    for (const body of [
      new Uint8Array(9),
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(9));
        },
        cancel,
      }),
    ]) {
      const response = await binding.handle(inbound({ body }));
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        code: "PAYLOAD_TOO_LARGE",
      });
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
    for (const method of ["GET", "HEAD"]) {
      await binding.handle(inbound({ method, body: new Uint8Array(9) }));
      expect(handler.mock.calls.at(-1)![0].body).toBeNull();
    }
  });
  it("runs around interceptors outermost first and SDK dispatch outside the existing scope", async () => {
    const order: string[] = [];
    const { scope, handler, exchange, entry, init } = fixture();
    const original = {
      view: {
        cookies: null,
        forward: "none",
        inbound: () => new Headers(),
        internal: false,
        browserHeaders: () => new Headers(),
      },
    } satisfies Parameters<RequestScope["run"]>[0];
    handler.mockImplementation(async (request) => {
      await Promise.resolve();
      expect(scope.current()).toBeUndefined();
      order.push(await request.text());
      return new Response("result");
    });
    const binding = exchange.create(
      {
        ...entry,
        options: {
          ...entry.options,
          http: {
            around: [
              async (_call, next) => {
                order.push("outer");
                const response = await next();
                order.push("outer-done");
                return response;
              },
              async (call, next) => {
                order.push("inner");
                expect(call.platformRequest).toBe(original);
                return next(new Request(call.request, { body: "changed" }));
              },
            ],
          },
        },
      },
      init,
    );
    await scope.run(original, async () => {
      await binding.handle(inbound({ platformRequest: original }));
      expect(scope.current()).toBe(original);
    });
    expect(order).toEqual(["outer", "inner", "changed", "outer-done"]);
  });
  it("converts SDK APIErrors with hidden cookies or rethrows the exact error by policy", async () => {
    const { handler, binding, exchange, entry, init } = fixture();
    const error = new APIError(
      "UNAUTHORIZED",
      { code: "DENIED", message: "denied" },
      { "www-authenticate": "Bearer" },
    );
    Object.defineProperty(error, Symbol.for("better-call:api-error-headers"), {
      value: new Headers({ "set-cookie": "cleared=; Max-Age=0" }),
    });
    handler.mockRejectedValue(error);
    const response = await binding.handle(inbound());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "DENIED",
      message: "denied",
    });
    expect(response.headers.getSetCookie()).toEqual(["cleared=; Max-Age=0"]);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    const throwing = exchange.create(
      {
        ...entry,
        context: { ...entry.context, options: { onAPIError: { throw: true } } },
      },
      init,
    );
    await expect(throwing.handle(inbound())).rejects.toBe(error);
  });
  it("redacts signing secrets, inbound credentials and around replacement credentials", async () => {
    const { handler, binding } = fixture();
    handler.mockRejectedValue(
      new Error("server-secret bearer-secret cookie-secret key-secret"),
    );
    const error = await binding
      .handle(
        inbound({
          headers: new Headers({
            authorization: "Bearer bearer-secret",
            cookie: "s=cookie-secret",
            "x-api-key": "key-secret",
          }),
        }),
      )
      .catch((error: unknown) => error);
    expect(isInfrastructureError(error)).toBe(true);
    expect((error as Error & { cause: Error }).cause.message).toBe(
      "[REDACTED] [REDACTED] [REDACTED] [REDACTED]",
    );
  });
  it("preserves responses and caps method/path diagnostics without logging query secrets", async () => {
    const { handler, entry, init, exchange, logger } = fixture();
    const response = new Response(null, { status: 404 });
    handler.mockResolvedValue(response);
    Object.assign(entry.instance.api, { signIn: { path: "/sign-in/email" } });
    const binding = exchange.create(
      { ...entry, options: { ...entry.options, http: { diagnostics: true } } },
      init,
    );
    expect(
      await binding.handle(
        inbound({ url: "http://local/api/auth/signin/email?token=secret" }),
      ),
    ).toBe(response);
    await binding.handle(
      inbound({ url: "http://local/api/auth/signin/email?token=other" }),
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn.mock.calls[0]![0]).toContain("/api/auth/sign-in/email");
    expect(logger.warn.mock.calls[0]![0]).not.toContain("token");
    for (let index = 0; index < 110; index++) {
      await binding.handle(
        inbound({ url: `http://local/api/auth/missing-${index}` }),
      );
    }
    expect(logger.warn).toHaveBeenCalledTimes(100);
  });
});

function httpContext(req: object, res: object = {}): ExecutionContext {
  return {
    getType: () => "http",
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getArgs: () => [req, res],
  } as unknown as ExecutionContext;
}

describe("HttpTransport", () => {
  it("defers credential access and delegates identity, params and browser semantics to the platform", () => {
    const req = {};
    const key = {};
    const read = vi.fn(() => new Headers({ cookie: "s=value" }));
    const cookieSink = { append: vi.fn(() => true) };
    const accessor: HttpRequestAccessor = {
      isRequest: () => true,
      isLive: () => true,
      key: () => key,
      headers: read,
      request: () => ({ method: "POST", url: "https://example/app" }),
      clientIp: () => "203.0.113.2",
      param: (_req, name) => (name === "id" ? "123" : undefined),
      cookieSink: () => cookieSink,
    };
    const transport = new HttpTransport(new HttpAdapterHost());
    expect(httpTransport()).toBe(HttpTransport);
    const call = transport.describe(httpContext(req), { http: accessor });
    expect(read).not.toHaveBeenCalled();
    expect(call.key).toBe(key);
    expect(call.invocation).toBe(key);
    expect(call.cookies).toBe(cookieSink);
    expect(call.clientIp).toBe("203.0.113.2");
    expect(call.browser?.enforce).toBe(true);
    expect(call.param("id")).toBe("123");
    expect(call.headers().get("cookie")).toBe("s=value");
    const missing = transport.describe(httpContext(req), { http: null });
    expect(missing.key).toBe(req);
    expect(() => missing.headers()).toThrow("Authentication is misconfigured");
  });
  it("preserves Nest exception types and writes challenge and retry headers through the adapter", () => {
    const host = new HttpAdapterHost();
    const setHeader = vi.fn();
    host.httpAdapter = {
      setHeader,
    } as unknown as HttpAdapterHost["httpAdapter"];
    const transport = new HttpTransport(host);
    const response = {};
    const context = httpContext({}, response);
    const unauthorized = transport.toException(
      AuthFailures.rejected({
        status: 401,
        challenge: "Bearer",
        reason: "INVALID_TOKEN",
      }),
      context,
    );
    expect(unauthorized).toBeInstanceOf(UnauthorizedException);
    expect((unauthorized as UnauthorizedException).getResponse()).toMatchObject(
      { statusCode: 401, code: "UNAUTHENTICATED", reason: "INVALID_TOKEN" },
    );
    expect(setHeader).toHaveBeenCalledWith(
      response,
      "WWW-Authenticate",
      "Bearer",
    );
    transport.toException(
      AuthFailures.rejected({ status: 429, retryAfterSeconds: 3 }),
      context,
    );
    expect(setHeader).toHaveBeenCalledWith(response, "Retry-After", "3");
  });
  it("canary-checks real route metadata and claims inherited routes with controller and method params", () => {
    class Base {
      read() {}
    }
    Get("/:item")(
      Base.prototype,
      "read",
      Object.getOwnPropertyDescriptor(Base.prototype, "read")!,
    );
    class Controller extends Base {}
    Reflect.defineMetadata("path", "/:tenant", Controller);
    const claim = vi.fn();
    const transport = new HttpTransport(new HttpAdapterHost());
    transport.validate({
      discovery: { getControllers: () => [{ metatype: Controller }] },
      claim,
    } as unknown as Parameters<HttpTransport["validate"]>[0]);
    expect(claim).toHaveBeenCalledWith(
      Controller,
      "read",
      "global",
      expect.objectContaining({
        inputs: ["tenant", "item"],
        code: "ROUTE_UNGUARDED",
      }),
    );
  });
});

describe("betterAuthCorsOrigin", () => {
  function auth(options: Partial<AuthContextView> = {}): AuthLike {
    const context = {
      trustedOrigins: [
        "https://app.example",
        "https://*.preview.example",
        "exp://",
      ],
      options: { trustedOrigins: ["https://plugin.example"] },
      isTrustedOrigin(this: { trustedOrigins: string[] }, origin: string) {
        return this.trustedOrigins.some(
          (candidate) =>
            candidate === origin ||
            (candidate === "https://*.preview.example" &&
              origin === "https://a.preview.example") ||
            (candidate === "exp://" && origin.startsWith("exp://")),
        );
      },
      ...options,
    };
    return {
      $context: Promise.resolve(context),
      handler: async () => new Response(),
      api: { getSession: async () => null },
    };
  }
  function allow(
    instance: AuthLike,
    origin: string | undefined,
    options?: { allowPatterns: boolean },
  ): Promise<boolean | undefined> {
    return new Promise((resolve, reject) => {
      betterAuthCorsOrigin(instance, options)(origin, (error, allowed) =>
        error ? reject(error) : resolve(allowed),
      );
    });
  }
  it("uses post-init contributions and permits only exact HTTP origins by default", async () => {
    const instance = auth();
    expect(await allow(instance, "https://app.example")).toBe(true);
    expect(await allow(instance, "https://plugin.example")).toBe(true);
    for (const origin of [
      undefined,
      "https://a.preview.example",
      "exp://app",
      "https://app.example.evil",
      "https://app.example/path",
    ]) {
      expect(await allow(instance, origin)).toBe(false);
    }
  });
  it("delegates explicit pattern opt-in to the SDK matcher", async () => {
    expect(
      await allow(auth(), "https://a.preview.example", { allowPatterns: true }),
    ).toBe(true);
    expect(await allow(auth(), "exp://app", { allowPatterns: true })).toBe(
      true,
    );
  });
  it("fails function-valued origins without invoking a requestless resolver", async () => {
    const resolver = vi.fn(() => ["https://app.example"]);
    await expect(
      allow(
        auth({ options: { trustedOrigins: resolver } }),
        "https://app.example",
      ),
    ).rejects.toMatchObject({ code: "DYNAMIC_CORS_ORIGIN" });
    expect(resolver).not.toHaveBeenCalled();
  });
});
