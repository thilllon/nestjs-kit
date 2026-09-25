import {
  Controller,
  createParamDecorator,
  Get,
  Inject,
  Module,
  Post,
  type ExecutionContext,
  type INestApplication,
  type Type,
} from "@nestjs/common";
import {
  type AbstractHttpAdapter,
  APP_GUARD,
  APP_INTERCEPTOR,
} from "@nestjs/core";
import {
  ExpressAdapter,
  type NestExpressApplication,
} from "@nestjs/platform-express";
import { Transport } from "@nestjs/microservices";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthRouteBinding,
  AuthTransport,
  ConformanceCase,
  HttpPlatform,
  InboundAuthRequest,
  PlatformMountContext,
  PrincipalRequest,
  PrincipalResult,
  PrincipalSource,
  ProxyTrust,
  TransportCall,
} from "./auth-contracts.js";
import { AuthFailures } from "./auth-errors.js";
import { BetterAuthCoreModule } from "./auth-core-module.js";
import { defineExtension } from "./auth-module-definition.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { BetterAuthService } from "./auth-service.js";
import {
  createConformanceAuth,
  kitIdentity,
  type RawResponse,
  runConformance,
  sendRaw,
  setCookieLines,
} from "./conformance-fixtures.js";
import {
  type HttpConformanceOptions,
  httpPlatformConformance,
} from "./conformance-http.js";
import { principalSourceConformance } from "./conformance-principal.js";
import {
  type FixtureHandler,
  type InheritedFixture,
  type TransportConformanceOptions,
  type TransportFixtures,
  type TransportInvocationResult,
  transportConformance,
} from "./conformance-transport.js";
import { expressPlatform } from "./express.js";
import { fastifyPlatform } from "./fastify.js";
import { BridgeClient } from "./bridge-client.js";
import type { BridgeBinding } from "./bridge-protocol.js";
import { HttpTransport, httpTransport } from "./http-transport.js";
import { rejected } from "./principal-resolver.js";
import { RoutePlanner } from "./route-planner.js";
import { sessionPrincipal } from "./session-principal.js";

const tcpMicroservice = () => ({
  transport: Transport.TCP,
  options: { host: "127.0.0.1", port: 0 },
});

describe("Express platform conformance", () => {
  runConformance(
    httpPlatformConformance({
      platform: expressPlatform(),
      createHttpAdapter: () => new ExpressAdapter(),
      trustOneProxy: (app) => {
        (app as NestExpressApplication).set("trust proxy", 1);
      },
      microservice: tcpMicroservice,
    }),
    { describe, it },
  );
});

/**
 * Fastify fixes trustProxy when the adapter constructs its instance, so the trusted-hop rows boot on adapters that
 * trust the loopback hop the kit's requests come from. Fastify 5 fails closed for a numeric hop count, and it exposes
 * no public trustProxy metadata, so FastifyPlatform has no proxyTrust() and the rows that need one skip.
 */
const fastifyHarness = {
  createHttpAdapter: () => new FastifyAdapter(),
  createTrustingHttpAdapter: () =>
    new FastifyAdapter({ trustProxy: "loopback" }),
  http2: {
    createHttpAdapter: () => new FastifyAdapter({ http2: true }),
    createTrustingHttpAdapter: () =>
      new FastifyAdapter({ http2: true, trustProxy: "loopback" }),
  },
} satisfies Omit<HttpConformanceOptions, "platform">;

describe("Fastify platform conformance", () => {
  runConformance(
    httpPlatformConformance({
      platform: fastifyPlatform(),
      ...fastifyHarness,
      microservice: tcpMicroservice,
    }),
    { describe, it },
  );
});

/** A platform that routes every auth request of `real` through `handle`. */
function wrappedPlatform(
  real: HttpPlatform,
  handle: (
    binding: AuthRouteBinding,
    inbound: InboundAuthRequest,
  ) => Promise<Response>,
): HttpPlatform {
  const wrap = (binding: AuthRouteBinding): AuthRouteBinding => ({
    instance: binding.instance,
    basePath: binding.basePath,
    bodyLimit: binding.bodyLimit,
    staticOrigin: binding.staticOrigin,
    matches: (pathname) => binding.matches(pathname),
    payloadTooLarge: () => binding.payloadTooLarge(),
    handle: (inbound) => handle(binding, inbound),
  });
  return {
    id: real.id,
    capabilities: real.capabilities,
    requests: real.requests,
    supports: (adapter) => real.supports(adapter),
    prepare: real.prepare && ((context) => real.prepare!(context)),
    mount: (context: PlatformMountContext) =>
      real.mount({ ...context, binding: wrap(context.binding) }),
    proxyTrust: real.proxyTrust && ((adapter) => real.proxyTrust!(adapter)),
    validate: real.validate && ((adapter) => real.validate!(adapter)),
    applicationRoutes:
      real.applicationRoutes &&
      ((routes, bindings) => real.applicationRoutes!(routes, bindings)),
  };
}

/** A defective platform: it joins every Set-Cookie value into one header line. */
function mergingSetCookie(real: HttpPlatform): HttpPlatform {
  return wrappedPlatform(real, async (binding, inbound) => {
    const response = await binding.handle(inbound);
    const headers = new Headers();
    for (const [name, value] of response.headers) {
      if (name !== "set-cookie") {
        headers.append(name, value);
      }
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      headers.set("set-cookie", cookies.join(", "));
    }
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });
}

/** A defective Express platform that rewrites the inbound request it hands the core. */
function rewritingExpress(
  rewrite: (inbound: InboundAuthRequest) => InboundAuthRequest,
): HttpPlatform {
  return wrappedPlatform(
    expressPlatform() as unknown as HttpPlatform,
    (binding, inbound) => binding.handle(rewrite(inbound)),
  );
}

/** The one Fastify case of the kit whose title matches, booted through the testing bootstrap. */
function fastifyKitCase(
  platform: HttpPlatform,
  id: string,
  title: RegExp,
): ConformanceCase {
  const found = httpPlatformConformance({
    platform,
    ...fastifyHarness,
    bootstrap: ["testing"],
  }).find((item) => item.id === id && title.test(item.title));
  expect(found?.skip).toBeUndefined();
  return found!;
}

/** A Fastify platform whose proxyTrust() answers with `report`. */
function reportingFastify(
  report: (adapter: AbstractHttpAdapter) => ProxyTrust,
): HttpPlatform {
  return {
    ...wrappedPlatform(fastifyPlatform() as HttpPlatform, (binding, inbound) =>
      binding.handle(inbound),
    ),
    proxyTrust: report,
  };
}

/** A defective Fastify platform that reports proxy trust 'none' whatever its adapter trusts. */
const untrustingFastify = () =>
  reportingFastify(() => ({ mode: "none", detail: "trustProxy = false" }));

function kitCase(
  options: Omit<HttpConformanceOptions, "createHttpAdapter" | "bootstrap">,
  id: string,
  title: RegExp,
): ConformanceCase {
  const found = httpPlatformConformance({
    createHttpAdapter: () => new ExpressAdapter(),
    bootstrap: ["testing"],
    trustOneProxy: (app) => {
      (app as NestExpressApplication).set("trust proxy", 1);
    },
    microservice: tcpMicroservice,
    ...options,
  }).find((item) => item.id === id && title.test(item.title));
  expect(found?.skip).toBeUndefined();
  return found!;
}

describe("platform kit mutations", () => {
  it("fails H-resp-multicookie for a platform that merges Set-Cookie lines", async () => {
    const cases = httpPlatformConformance({
      platform: mergingSetCookie(expressPlatform() as unknown as HttpPlatform),
      createHttpAdapter: () => new ExpressAdapter(),
      bootstrap: ["testing"],
    });
    const multicookie = cases.find((item) => item.id === "H-resp-multicookie");
    await expect(multicookie!.run()).rejects.toThrow(/Set-Cookie lines/);
  });

  it("fails H-ip-platform for a platform that hands Better Auth no client IP", async () => {
    const platform = rewritingExpress((inbound) => ({
      ...inbound,
      clientIp: null,
    }));
    await expect(
      kitCase({ platform }, "H-ip-platform", /^Better Auth's getIP/).run(),
    ).rejects.toThrow(/resolved no client IP/);
  });

  it("fails the trusted-hop H-ip-platform bucket row for a platform that ignores its proxy trust", async () => {
    const platform = rewritingExpress((inbound) => ({
      ...inbound,
      clientIp: "127.0.0.1",
    }));
    await expect(
      kitCase({ platform }, "H-ip-platform", /behind a trusted hop/).run(),
    ).rejects.toThrow(/shared the first client's bucket/);
  });

  it.each([
    { title: /^in production mode behind a trusted hop/ },
    { title: /^over HTTP\/2, in production mode behind a trusted hop/ },
  ])(
    "fails the Fastify trusted-hop H-ip-platform bucket row $title for a platform that ignores its proxy trust",
    async ({ title }) => {
      const platform = wrappedPlatform(
        fastifyPlatform() as HttpPlatform,
        (binding, inbound) =>
          binding.handle({ ...inbound, clientIp: "127.0.0.1" }),
      );
      await expect(
        fastifyKitCase(platform, "H-ip-platform", title).run(),
      ).rejects.toThrow(/shared the first client's bucket/);
    },
  );

  it.each([
    {
      id: "H-proxy-untrusted-warning",
      title: /^in production behind a trusted hop/,
      error: /W_PROXY_UNTRUSTED/,
    },
    {
      id: "H-proxy-untrusted-warning",
      title: /^over HTTP\/2, in production behind a trusted hop/,
      error: /W_PROXY_UNTRUSTED/,
    },
    {
      id: "H-ip-platform",
      title: /^with trustedProxies covering the proxy and trust on/,
      error: /W_CLIENT_IP/,
    },
    {
      id: "H-ip-platform",
      title:
        /^over HTTP\/2, with trustedProxies covering the proxy and trust on/,
      error: /W_CLIENT_IP/,
    },
  ])(
    "fails the Fastify trusted-hop $id row $title for a platform that reports 'none' behind a trusted hop",
    async ({ id, title, error }) => {
      await expect(
        fastifyKitCase(untrustingFastify(), id, title).run(),
      ).rejects.toThrow(error);
    },
  );

  it("decides H-proxy-trust from a trusting adapter when trust is fixed at construction, and fails a platform that ignores it", async () => {
    const trusting = new WeakSet<AbstractHttpAdapter>();
    const harness = {
      ...fastifyHarness,
      createTrustingHttpAdapter: () => {
        const adapter = new FastifyAdapter({ trustProxy: "loopback" });
        trusting.add(adapter);
        return adapter;
      },
      bootstrap: ["testing"] as const,
    };
    const row = (platform: HttpPlatform) => {
      const found = httpPlatformConformance({ platform, ...harness }).find(
        (item) => item.id === "H-proxy-trust",
      );
      expect(found?.skip).toBeUndefined();
      return found!;
    };
    const reporting = reportingFastify((adapter) =>
      trusting.has(adapter)
        ? { mode: "partial", detail: "trustProxy = loopback" }
        : { mode: "none", detail: "trustProxy = false" },
    );
    await expect(row(reporting).run()).resolves.toBeUndefined();
    await expect(row(untrustingFastify()).run()).rejects.toThrow(
      /did not reflect the trusted hop/,
    );
  });

  it("fails the dynamic H-mount-custom-path row for a platform that drops the request host", async () => {
    const platform = rewritingExpress((inbound) => ({
      ...inbound,
      url: new URL(new URL(inbound.url).pathname, "http://localhost:3000").href,
    }));
    await expect(
      kitCase(
        { platform },
        "H-mount-custom-path",
        /^a dynamic allowedHosts/,
      ).run(),
    ).rejects.toThrow(/lost the allowed host tenant\.example/);
  });

  it("fails H-proxy-untrusted-warning for a platform that strips forwarding headers", async () => {
    const platform = rewritingExpress((inbound) => {
      const headers = new Headers(inbound.headers);
      for (const name of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
        headers.delete(name);
      }
      return { ...inbound, headers };
    });
    await expect(
      kitCase(
        { platform },
        "H-proxy-untrusted-warning",
        /with proxy trust off/,
      ).run(),
    ).rejects.toThrow(/logged no W_PROXY_UNTRUSTED/);
  });

  it("fails H-close-keeps-hooks for a kernel that unbinds hooks on close", async () => {
    const bindings: BridgeBinding[] = [];
    const bind = BridgeClient.prototype.bind;
    const close = BridgeClient.prototype.close;
    const spies = [
      vi.spyOn(BridgeClient.prototype, "bind").mockImplementation(function (
        this: BridgeClient,
        entry,
        binding,
      ) {
        bindings.push(binding);
        return bind.call(this, entry, binding);
      }),
      vi.spyOn(BridgeClient.prototype, "close").mockImplementation(function (
        this: BridgeClient,
      ) {
        close.call(this);
        for (const binding of bindings) {
          Object.assign(binding, { before: [], after: [] });
        }
      }),
    ];
    try {
      await expect(
        kitCase(
          { platform: expressPlatform() },
          "H-close-keeps-hooks",
          /./,
        ).run(),
      ).rejects.toThrow(/after app\.close\(\) skipped/);
    } finally {
      for (const spy of spies) {
        spy.mockRestore();
      }
    }
  });

  it("fails H-close-keeps-hooks for a kernel that reports taking over a closed binding", async () => {
    const bind = BridgeClient.prototype.bind;
    const spy = vi
      .spyOn(BridgeClient.prototype, "bind")
      .mockImplementation(function (this: BridgeClient, entry, binding) {
        const closed = entry.bridge.state === "closed";
        const result = bind.call(this, entry, binding);
        return closed
          ? { ...result, tookOverFrom: "a closed application" }
          : result;
      });
    try {
      await expect(
        kitCase(
          { platform: expressPlatform() },
          "H-close-keeps-hooks",
          /./,
        ).run(),
      ).rejects.toThrow(/warned while taking over the closed binding/);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails the microservice H-no-adapter row for a kernel that keeps the binding open on shutdown", async () => {
    const spy = vi
      .spyOn(BetterAuthCoreModule.prototype, "onApplicationShutdown")
      .mockImplementation(() => undefined);
    try {
      await expect(
        kitCase(
          { platform: expressPlatform() },
          "H-no-adapter",
          /microservice/,
        ).run(),
      ).rejects.toThrow(/close\(\) left the binding bound/);
    } finally {
      spy.mockRestore();
    }
  });

  it("decides capability cases of a definition platform from the resolved platform", async () => {
    const byId = (cases: ConformanceCase[], id: string) =>
      cases.find((item) => item.id === id)!;
    const fastify = httpPlatformConformance({
      platform: defineExtension<HttpPlatform>({
        use: { useFactory: () => fastifyPlatform() as HttpPlatform },
      }),
      createHttpAdapter: () => new FastifyAdapter(),
      bootstrap: ["testing"],
      trustOneProxy: () => {
        throw new Error("a platform without proxyTrust() needs no trust hook");
      },
    });
    for (const id of ["H-proxy-trust", "H-h2-pseudo"]) {
      expect(byId(fastify, id).skip).toBeUndefined();
    }
    await expect(byId(fastify, "H-proxy-trust").run()).resolves.toEqual({
      skipped: "the platform does not implement the optional proxyTrust()",
    });
    // The resolved platform declares http2, so the kit requires the http2 option.
    await expect(byId(fastify, "H-h2-pseudo").run()).rejects.toThrow(
      /requires the http2 option/,
    );
    const express = httpPlatformConformance({
      platform: defineExtension<HttpPlatform>({
        use: { useFactory: () => expressPlatform() as unknown as HttpPlatform },
      }),
      createHttpAdapter: () => new ExpressAdapter(),
      bootstrap: ["testing"],
    });
    await expect(byId(express, "H-h2-pseudo").run()).resolves.toEqual({
      skipped: "the platform declares no http2 capability",
    });
  });
});

const Input = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<{
      query?: Record<string, unknown>;
      body?: Record<string, unknown>;
      params?: Record<string, unknown>;
    }>();
    return { ...request.query, ...request.body, ...request.params };
  },
);

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

function fixtureController(handlers: Map<string, FixtureHandler>) {
  @Controller("kit")
  class HttpFixtureController {
    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  for (const [name, fixture] of handlers) {
    const method = async function (
      this: HttpFixtureController,
      ...args: unknown[]
    ) {
      const count = fixture.params.length;
      return fixture.handle(
        args.slice(0, count),
        args[count] as Record<string, unknown>,
        { service: this.service },
      );
    };
    Object.defineProperty(method, "name", { value: name });
    Object.defineProperty(HttpFixtureController.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      HttpFixtureController.prototype,
      name,
    )!;
    for (const [index, param] of fixture.params.entries()) {
      param(HttpFixtureController.prototype, name, index);
    }
    Input()(HttpFixtureController.prototype, name, fixture.params.length);
    const path = name === "org" ? "org/:orgId" : name;
    const route = fixture.operation === "unsafe" ? Post(path) : Get(path);
    for (const decorator of [route, ...fixture.decorators].reverse()) {
      decorator(HttpFixtureController.prototype, name, descriptor);
    }
  }
  return HttpFixtureController;
}

/** Controller paths of the two subclasses that serve the `inherited` fixture. */
const INHERITED_PATHS = {
  public: "kit-inherited-public",
  denied: "kit-inherited-denied",
} as const;

/** The `inherited` fixture as one route method of an abstract base controller, served by two subclasses. */
function inheritedControllers(fixture: InheritedFixture) {
  abstract class InheritedBase {
    inherited(input: Record<string, unknown>): unknown {
      return fixture.handle([], input, { service: undefined as never });
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(
    InheritedBase.prototype,
    "inherited",
  )!;
  Input()(InheritedBase.prototype, "inherited", 0);
  for (const decorator of [Get("inherited"), ...fixture.decorators].reverse()) {
    decorator(InheritedBase.prototype, "inherited", descriptor);
  }
  @Controller(INHERITED_PATHS.public)
  class PublicInheritedController extends InheritedBase {}
  @Controller(INHERITED_PATHS.denied)
  class DeniedInheritedController extends InheritedBase {}
  for (const decorator of fixture.subclasses.public) {
    decorator(PublicInheritedController);
  }
  for (const decorator of fixture.subclasses.denied) {
    decorator(DeniedInheritedController);
  }
  return [PublicInheritedController, DeniedInheritedController];
}

/** The outcome of one kit request as the transport kit's result. */
function outcome(response: RawResponse): TransportInvocationResult {
  const text = response.body.toString("utf8");
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  const ok = response.status >= 200 && response.status < 300;
  return {
    ok,
    body: ok ? body : undefined,
    ...(ok
      ? {}
      : {
          error: {
            statusCode: Number(body?.statusCode ?? response.status),
            code: body?.code as string | undefined,
            reason: body?.reason as string | undefined,
            message: body?.message as string | undefined,
          },
        }),
    setCookies: setCookieLines(response.headers),
  };
}

const booted = new WeakMap<
  object,
  { url: string; handlers: Map<string, FixtureHandler> }
>();

/**
 * The built-in HTTP transport, exposed through controllers on a real listening platform. `unit` registers another HTTP
 * transport ahead of the built-in one (mutation tests).
 */
function httpHarness(
  platform: () => HttpPlatform,
  adapter: () => AbstractHttpAdapter,
  unit?: Type<AuthTransport>,
): TransportConformanceOptions {
  return {
    transport: unit ?? httpTransport(),
    expectCookieCapable: true,
    expectBrowserLeg: true,
    async createApp(fixtures, auth, options) {
      const handlers = flatten(fixtures);
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            platforms: [platform()],
            ...(unit ? { transports: [unit] } : {}),
            globalGuard: options.globalGuard,
            principals: options.principals,
            ...(options.defaultRequirements
              ? { defaultRequirements: options.defaultRequirements }
              : {}),
            ...(options.globalScope === undefined
              ? {}
              : { globalScope: options.globalScope }),
            logSummary: options.logSummary ?? false,
          } as never),
        ],
        controllers: [
          fixtureController(handlers),
          ...inheritedControllers(fixtures.inherited),
        ],
        providers: options.appEnhancers
          ? [
              { provide: APP_GUARD, useClass: BetterAuthGuard },
              {
                provide: APP_INTERCEPTOR,
                useClass: BetterAuthScopeInterceptor,
              },
            ]
          : [],
      })
      class HttpFixtureModule {}
      let builder = Test.createTestingModule({ imports: [HttpFixtureModule] });
      if (options.override) {
        builder = options.override(builder);
      }
      const moduleRef = await builder.compile();
      const app = moduleRef.createNestApplication(adapter(), {
        logger: options.logger ?? false,
      });
      try {
        await app.init();
        await app.listen(0, "127.0.0.1");
      } catch (error) {
        await app.close();
        throw error;
      }
      booted.set(app, { url: await app.getUrl(), handlers });
      return app;
    },
    async invoke(app: INestApplication, handler, headers, input = {}) {
      const { url, handlers } = booted.get(app)!;
      const name =
        handler === "triple" || handler === "tripleMixed"
          ? `${handler}0`
          : handler;
      const fixture = handlers.get(name)!;
      const unsafe = fixture.operation === "unsafe";
      const query = new URLSearchParams(
        Object.entries(input).map(([key, value]) => [key, String(value)]),
      );
      const path =
        name === "org"
          ? `org/${encodeURIComponent(String(input.orgId ?? ""))}`
          : name;
      const response = await sendRaw(
        `${url}/kit/${path}${unsafe ? "" : `?${query}`}`,
        {
          method: unsafe ? "POST" : "GET",
          headers: {
            ...Object.fromEntries(new Headers(headers)),
            ...(unsafe ? { "content-type": "application/json" } : {}),
          },
          ...(unsafe ? { body: JSON.stringify(input) } : {}),
        },
      );
      return outcome(response);
    },
    async invokeInherited(app, subclass, headers) {
      const { url } = booted.get(app)!;
      return outcome(
        await sendRaw(`${url}/${INHERITED_PATHS[subclass]}/inherited`, {
          headers: Object.fromEntries(new Headers(headers)),
        }),
      );
    },
  };
}

describe("transport kit on the built-in HTTP transport with Express", () => {
  runConformance(
    transportConformance(
      httpHarness(
        () => expressPlatform() as unknown as HttpPlatform,
        () => new ExpressAdapter(),
      ),
    ),
    { describe, it },
  );
});

describe("transport kit on the built-in HTTP transport with Fastify", () => {
  runConformance(
    transportConformance(
      httpHarness(
        () => fastifyPlatform() as unknown as HttpPlatform,
        () => new FastifyAdapter(),
      ),
    ),
    { describe, it },
  );
});

/** An HTTP transport whose invocation is the platform's request key, which Fastify keeps apart from the handler's request. */
class KeyInvocationTransport extends HttpTransport {
  override describe(
    context: ExecutionContext,
    kit: Parameters<HttpTransport["describe"]>[1],
  ): TransportCall {
    const call = super.describe(context, kit);
    return {
      key: call.key,
      invocation: call.key,
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
        return call.browser;
      },
    };
  }
}

describe("HTTP transport kit mutations", () => {
  it("fails T-carrier on Fastify for a transport whose invocation is not the handler's request", async () => {
    const carrier = transportConformance(
      httpHarness(
        () => fastifyPlatform() as unknown as HttpPlatform,
        () => new FastifyAdapter(),
        KeyInvocationTransport,
      ),
    ).find((item) => item.id === "T-carrier")!;
    await expect(carrier.run()).rejects.toThrow(
      /with globalScope: false: a cookie: expected success/,
    );
  });
});

/**
 * The principal kit's HTTP rows: S-bridge-* and the HTTP-route rows of S-cookie-forwarded and S-infra-throws (the
 * other rows run in testing-conformance.test.ts without a server).
 */
function sessionHttpCases(
  platform: () => HttpPlatform,
  createHttpAdapter: () => AbstractHttpAdapter,
  source: PrincipalSource = sessionPrincipal() as unknown as PrincipalSource,
): ConformanceCase[] {
  const auth = createConformanceAuth();
  return principalSourceConformance({
    source,
    auth,
    credentials: {
      valid: async (instance) =>
        new Headers({ cookie: (await kitIdentity(instance)).cookie }),
      invalid: () =>
        new Headers({ cookie: "better-auth.session_token=invalid.value" }),
    },
    http: { platform: platform(), createHttpAdapter },
  }).filter(
    (item) =>
      item.id.startsWith("S-bridge-") ||
      item.title.startsWith("through an HTTP route"),
  );
}

describe("principal source kit HTTP rows on Express", () => {
  runConformance(
    sessionHttpCases(
      () => expressPlatform() as unknown as HttpPlatform,
      () => new ExpressAdapter(),
    ),
    { describe, it },
  );
});

describe("principal source kit HTTP rows on Fastify", () => {
  runConformance(
    sessionHttpCases(
      () => fastifyPlatform() as unknown as HttpPlatform,
      () => new FastifyAdapter(),
    ),
    { describe, it },
  );
});

describe("principal source kit HTTP mutations", () => {
  const bridgeCase = (id: string, source?: PrincipalSource) => {
    const found = sessionHttpCases(
      () => expressPlatform() as unknown as HttpPlatform,
      () => new ExpressAdapter(),
      source,
    ).find((item) => item.id === id);
    if (!found) {
      throw new Error(`no case ${id}`);
    }
    return found;
  };

  /** The session source with a replaced resolve(). */
  const faultySession = (
    resolve: (
      real: PrincipalSource,
      request: PrincipalRequest,
    ) => Promise<PrincipalResult>,
  ): PrincipalSource => {
    const real = sessionPrincipal() as unknown as PrincipalSource;
    return { ...real, resolve: (request) => resolve(real, request) };
  };

  it("fails the HTTP-route row of S-cookie-forwarded for a source that drops its refresh cookies", async () => {
    // The session still refreshes, but the source never appends the refresh cookie it forwards by hand.
    const dropping = faultySession((real, request) =>
      real.resolve({ ...request, cookies: { append: () => true } }),
    );
    await expect(
      bridgeCase("S-cookie-forwarded", dropping).run(),
    ).rejects.toThrow(/the client received it 0 times/);
  });

  it("fails the HTTP-route row of S-infra-throws for a source that reports storage outages as invalid sessions", async () => {
    const denying = faultySession(async (real, request) => {
      try {
        return await real.resolve(request);
      } catch {
        return rejected(
          AuthFailures.rejected({ status: 401, reason: "INVALID_SESSION" }),
        );
      }
    });
    await expect(bridgeCase("S-infra-throws", denying).run()).rejects.toThrow(
      /answered 401 for a storage outage instead of 5xx/,
    );
  });

  /** A defective planner: every handler forwards the cookies of its direct calls. */
  function forwardEveryHandler() {
    const plan = RoutePlanner.prototype.plan;
    return vi
      .spyOn(RoutePlanner.prototype, "plan")
      .mockImplementation(function (this: RoutePlanner, ...args) {
        return Object.freeze({
          ...plan.apply(this, args),
          forwardDirectCalls: true,
        });
      });
  }

  it("fails S-bridge-third-party-signup when every handler forwards direct-call cookies", async () => {
    forwardEveryHandler();
    await expect(
      bridgeCase("S-bridge-third-party-signup").run(),
    ).rejects.toThrow(/set the new user's session cookie on the caller/);
  });

  it("fails S-bridge-foreign-credentials when forwardForeignCookies runs without a declaration", async () => {
    forwardEveryHandler();
    await expect(
      bridgeCase("S-bridge-foreign-credentials").run(),
    ).rejects.toThrow(/ran outside a forwarding handler/);
  });

  it("fails S-bridge-foreign-credentials when forwardForeignCookies forwards nothing", async () => {
    vi.spyOn(
      BetterAuthService.prototype,
      "forwardForeignCookies",
    ).mockImplementation((fn) => fn());
    await expect(
      bridgeCase("S-bridge-foreign-credentials").run(),
    ).rejects.toThrow(/did not forward the foreign refresh cookie/);
  });
});
