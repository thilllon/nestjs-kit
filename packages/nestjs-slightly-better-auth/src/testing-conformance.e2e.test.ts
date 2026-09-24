import {
  Controller,
  createParamDecorator,
  Get,
  Inject,
  Module,
  Post,
  type ExecutionContext,
  type INestApplication,
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
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import type {
  AuthRouteBinding,
  ConformanceCase,
  HttpPlatform,
  PlatformMountContext,
} from "./auth-contracts.js";
import { defineExtension } from "./auth-module-definition.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { BetterAuthService } from "./auth-service.js";
import {
  runConformance,
  sendRaw,
  setCookieLines,
} from "./conformance-fixtures.js";
import { httpPlatformConformance } from "./conformance-http.js";
import {
  type FixtureHandler,
  type TransportConformanceOptions,
  type TransportFixtures,
  transportConformance,
} from "./conformance-transport.js";
import { expressPlatform } from "./express.js";
import { fastifyPlatform } from "./fastify.js";
import { httpTransport } from "./http-transport.js";

describe("Express platform conformance", () => {
  runConformance(
    httpPlatformConformance({
      platform: expressPlatform(),
      createHttpAdapter: () => new ExpressAdapter(),
      trustOneProxy: (app) => {
        (app as NestExpressApplication).set("trust proxy", 1);
      },
    }),
    { describe, it },
  );
});

describe("Fastify platform conformance", () => {
  runConformance(
    httpPlatformConformance({
      platform: fastifyPlatform(),
      createHttpAdapter: () => new FastifyAdapter(),
      http2: { createHttpAdapter: () => new FastifyAdapter({ http2: true }) },
    }),
    { describe, it },
  );
});

/** A defective platform: it joins every Set-Cookie value into one header line. */
function mergingSetCookie(real: HttpPlatform): HttpPlatform {
  const wrap = (binding: AuthRouteBinding): AuthRouteBinding => ({
    instance: binding.instance,
    basePath: binding.basePath,
    bodyLimit: binding.bodyLimit,
    staticOrigin: binding.staticOrigin,
    matches: (pathname) => binding.matches(pathname),
    payloadTooLarge: () => binding.payloadTooLarge(),
    async handle(inbound) {
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
    },
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

const booted = new WeakMap<
  object,
  { url: string; handlers: Map<string, FixtureHandler> }
>();

/** The built-in HTTP transport, exposed through controllers on a real listening platform. */
function httpHarness(
  platform: () => HttpPlatform,
  adapter: () => AbstractHttpAdapter,
): TransportConformanceOptions {
  return {
    transport: httpTransport(),
    expectCookieCapable: true,
    expectBrowserLeg: true,
    async createApp(fixtures, auth, options) {
      const handlers = flatten(fixtures);
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            platforms: [platform()],
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
        controllers: [fixtureController(handlers)],
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
