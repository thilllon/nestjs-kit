import { request as nodeRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  All,
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  Logger,
  Module,
  Post,
  Req,
  RequestMethod,
  VersioningType,
} from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { AbstractHttpAdapter } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { APIError } from "better-auth/api";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CurrentPrincipal,
  ForwardAuthCookies,
  OptionalAuth,
  Public,
  RequireAuth,
} from "./auth-decorators.js";
import type { AuthRouteBinding } from "./auth-contracts.js";
import type { AuthPrincipal } from "./auth-types.js";
import {
  BetterAuthConfigurationError,
  isInfrastructureError,
} from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthService } from "./auth-service.js";
import { expressPlatform } from "./express.js";
import { CurrentUser } from "./session-principal.js";
import { createTestAuth, startHttpFixture } from "./test-fixtures.js";

interface NodeResult {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

function sendNodeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    chunks?: readonly Uint8Array[];
  } = {},
): Promise<NodeResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = nodeRequest(
      target,
      {
        method: options.method,
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    request.once("error", reject);
    for (const chunk of options.chunks ?? []) {
      request.write(chunk);
    }
    request.end();
  });
}

function byteEcho() {
  return async (call: { request: Request }) => {
    const bytes = new Uint8Array(await call.request.arrayBuffer());
    return Response.json({
      bytes: [...bytes],
      contentType: call.request.headers.get("content-type"),
      method: call.request.method,
      url: call.request.url,
      headers: Object.fromEntries(call.request.headers),
    });
  };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

async function signUp(
  baseUrl: string,
  identity: { name: string; email: string; password: string },
): Promise<Response> {
  return fetch(`${baseUrl}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      origin: "http://localhost:3000",
      "content-type": "application/json",
    },
    body: JSON.stringify(identity),
  });
}

describe("ExpressPlatform", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects an oversized auth body with the host CORS header", async () => {
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: { http: { bodyLimit: 8 } },
      configure: (app) =>
        app.enableCors({
          origin: "https://app.example",
          credentials: true,
        }),
    });
    try {
      const response = await fetch(`${fixture.url}/api/auth/sign-up/email`, {
        method: "POST",
        headers: {
          origin: "https://app.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ payload: "too large" }),
      });
      expect(response.status).toBe(413);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.example",
      );
      expect(await response.json()).toEqual({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the configured limit",
      });
    } finally {
      await fixture.close();
    }
  });

  it("lets host CORS answer preflight before the auth dispatcher", async () => {
    let dispatched = 0;
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          around: [
            async () => {
              dispatched += 1;
              return new Response("auth");
            },
          ],
        },
      },
      configure: (app) =>
        app.enableCors({
          origin: "https://app.example",
          credentials: true,
        }),
    });
    try {
      const response = await fetch(`${fixture.url}/api/auth/sign-in/email`, {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example",
          "access-control-request-method": "POST",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.example",
      );
      expect(dispatched).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it.each([
    ["JSON spacing", "application/json", Buffer.from('{  "value" : "한글"  }')],
    [
      "URL encoded",
      "application/x-www-form-urlencoded",
      Buffer.from("a=1&a=two%20words"),
    ],
    [
      "multipart",
      "multipart/form-data; boundary=x",
      Buffer.from(
        '--x\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--x--\r\n',
      ),
    ],
    ["text", "text/plain", Buffer.from("plain\u0000text")],
    [
      "vendor JSON",
      "application/scim+json",
      Buffer.from('{\n"active":true\n}'),
    ],
    ["binary", "application/octet-stream", Buffer.from([0, 255, 1, 2])],
    ["empty", "application/octet-stream", Buffer.alloc(0)],
  ])("preserves exact %s bytes", async (_name, contentType, body) => {
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: { http: { around: [byteEcho()] } },
    });
    try {
      const response = await fetch(`${fixture.url}/api/auth/byte-echo`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": contentType,
        },
        body,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        bytes: [...body],
        contentType,
      });
    } finally {
      await fixture.close();
    }
  });

  it("preserves chunked bytes and the encoded path and query", async () => {
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: { http: { around: [byteEcho()] } },
    });
    try {
      const result = await sendNodeRequest(
        `${fixture.url}/api/auth/a%2Fb?return=%2Finside%3Fx%3D1`,
        {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/octet-stream",
          },
          chunks: [Buffer.from([0, 1]), Buffer.from([254, 255])],
        },
      );
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body.toString())).toMatchObject({
        bytes: [0, 1, 254, 255],
        url: "http://localhost:3000/api/auth/a%2Fb?return=%2Finside%3Fx%3D1",
      });
    } finally {
      await fixture.close();
    }
  });

  it("answers chunked overflow canonically and destroys input past the drain cap", async () => {
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: { http: { bodyLimit: 8, around: [byteEcho()] } },
      configure: (app) => {
        app.enableCors({ origin: "https://app.example" });
      },
    });
    try {
      const overflow = await sendNodeRequest(
        `${fixture.url}/api/auth/chunked-overflow`,
        {
          method: "POST",
          headers: {
            origin: "https://app.example",
            "content-type": "application/octet-stream",
          },
          chunks: [Buffer.alloc(4), Buffer.alloc(5)],
        },
      );
      expect(overflow.status).toBe(413);
      expect(overflow.headers["access-control-allow-origin"]).toBe(
        "https://app.example",
      );
      expect(JSON.parse(overflow.body.toString())).toEqual({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the configured limit",
      });
      await expect(
        sendNodeRequest(`${fixture.url}/api/auth/drain-cap`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          chunks: [Buffer.alloc(65)],
        }),
      ).rejects.toMatchObject({ code: "ECONNRESET" });
    } finally {
      await fixture.close();
    }
  });

  it("keeps host middleware headers, appends cookies, merges Vary, and preserves redirects", async () => {
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          around: [
            async () => {
              const headers = new Headers({
                location: "/signed-in",
                vary: "Accept-Encoding",
              });
              headers.append("set-cookie", "auth_a=one; Path=/; HttpOnly");
              headers.append("set-cookie", "auth_b=two; Path=/; HttpOnly");
              return new Response("redirect body", { status: 302, headers });
            },
          ],
        },
      },
      configure: (app) => {
        const express = app.getHttpAdapter().getInstance() as {
          use(
            handler: (
              req: IncomingMessage,
              res: ServerResponse,
              next: () => void,
            ) => void,
          ): void;
        };
        express.use((_req, res, next) => {
          res.setHeader("vary", "Origin");
          res.setHeader("x-host", "retained");
          res.setHeader("set-cookie", "host=kept; Path=/");
          next();
        });
      },
    });
    try {
      const response = await fetch(`${fixture.url}/api/auth/redirect`, {
        redirect: "manual",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/signed-in");
      expect(response.headers.get("x-host")).toBe("retained");
      expect(response.headers.get("vary")).toBe("Origin, Accept-Encoding");
      expect(response.headers.getSetCookie()).toEqual([
        "host=kept; Path=/",
        "auth_a=one; Path=/; HttpOnly",
        "auth_b=two; Path=/; HttpOnly",
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("routes every method, strips HEAD bodies, and leaves the adjacent path alone", async () => {
    let handled = 0;
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          around: [
            async (call) => {
              handled += 1;
              return new Response(`handled ${call.request.method}`, {
                status: 207,
                headers: { "x-method": call.request.method },
              });
            },
          ],
        },
      },
    });
    try {
      for (const method of [
        "GET",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "HEAD",
        "OPTIONS",
        "PURGE",
      ]) {
        const response = await fetch(`${fixture.url}/api/auth/method`, {
          method,
          body: ["POST", "PUT", "PATCH"].includes(method) ? "x" : undefined,
        });
        expect(response.status).toBe(207);
        expect(response.headers.get("x-method")).toBe(method);
        expect(await response.text()).toBe(
          method === "HEAD" ? "" : `handled ${method}`,
        );
      }
      const adjacent = await fetch(`${fixture.url}/api/authx/method`);
      expect(adjacent.status).toBe(404);
      expect(handled).toBe(8);
    } finally {
      await fixture.close();
    }
  });

  it("uses Express trust-proxy URL and IP values while removing spoofed bridge headers", async () => {
    const fixture = await startHttpFixture({
      auth: createTestAuth({ baseURL: undefined }),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: { http: { around: [byteEcho()] } },
    });
    try {
      const result = await sendNodeRequest(`${fixture.url}/api/auth/headers`, {
        headers: {
          host: "safe.example",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
          "x-forwarded-for": "198.51.100.9",
          "x-nsba-ip-spoof": "chosen",
          connection: "x-remove",
          "x-remove": "secret",
        },
      });
      expect(result.status).toBe(200);
      const body = JSON.parse(result.body.toString());
      expect(body.url).toBe("http://safe.example/api/auth/headers");
      expect(body.headers["x-forwarded-host"]).toBe("evil.example");
      expect(body.headers["x-forwarded-proto"]).toBe("https");
      expect(body.headers["x-nsba-ip-spoof"]).toBeUndefined();
      expect(body.headers.connection).toBeUndefined();
      expect(body.headers["x-remove"]).toBeUndefined();
      const injected = Object.entries(body.headers).find(([name]) =>
        name.startsWith("x-nsba-ip-"),
      );
      expect(injected?.[1]).toBe("127.0.0.1");
    } finally {
      await fixture.close();
    }
  });

  it("reports the effective Express trust-proxy setting", () => {
    const adapter = new ExpressAdapter();
    const platform = expressPlatform();
    expect(platform.proxyTrust(adapter)).toEqual({
      mode: "none",
      detail: "trust proxy = false",
    });
    adapter.set("trust proxy", true);
    expect(platform.proxyTrust(adapter)).toEqual({
      mode: "all",
      detail: "trust proxy = true",
    });
    adapter.set("trust proxy", 1);
    expect(platform.proxyTrust(adapter)).toEqual({
      mode: "partial",
      detail: "trust proxy = 1",
    });
  });

  it("rejects an unknown initialized Express router shape", () => {
    const platform = expressPlatform();
    const app = {
      get: () => undefined,
      router: {},
      use: () => undefined,
    };
    platform.prepare({
      adapter: {
        getInstance: () => app,
      } as unknown as AbstractHttpAdapter,
      logger: new Logger("test"),
      route: () => undefined,
    });
    expect(() =>
      platform.applicationRoutes(
        [
          {
            method: "POST",
            paths: Object.freeze(["/api/auth/owned"]),
            conditions: Object.freeze([]),
            source: "OwnerController.owned",
          },
        ],
        [{ basePath: "/api/auth" } as AuthRouteBinding],
      ),
    ).toThrow(expect.objectContaining({ code: "UNSUPPORTED_EXPRESS_ROUTER" }));
  });

  it("returns the canonical invalid URL response for an invalid trusted protocol", async () => {
    const adapter = new ExpressAdapter();
    const fixture = await startHttpFixture({
      auth: createTestAuth({ baseURL: undefined }),
      adapter,
      platform: expressPlatform(),
      controllers: [],
      configure: () => {
        adapter.set("trust proxy", true);
      },
    });
    try {
      const response = await sendNodeRequest(
        `${fixture.url}/api/auth/get-session`,
        { headers: { "x-forwarded-proto": "javascript" } },
      );
      expect(response.status).toBe(400);
      expect(JSON.parse(response.body.toString())).toEqual({
        code: "INVALID_REQUEST_URL",
        message: "Invalid request URL",
      });
    } finally {
      await fixture.close();
    }
  });

  it("recovers a body consumed before capture and warns once", async () => {
    const warnings = vi.spyOn(Logger.prototype, "warn");
    const adapter = new ExpressAdapter();
    const express = adapter.getInstance() as {
      use(
        handler: (
          req: IncomingMessage & { body?: unknown },
          res: ServerResponse,
          next: (error?: unknown) => void,
        ) => void,
      ): void;
    };
    express.use((req, _res, next) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          req.body = JSON.parse(Buffer.concat(chunks).toString());
          next();
        } catch (error) {
          next(error);
        }
      });
    });
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter,
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: { http: { around: [byteEcho()], bodyLimit: 8 } },
    });
    try {
      for (const body of ['{  "a": 1 }', '{ "b" : 2 }']) {
        const response = await fetch(`${fixture.url}/api/auth/consumed`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          bytes: [...Buffer.from(JSON.stringify(JSON.parse(body)))],
        });
      }
      const overLimit = await fetch(`${fixture.url}/api/auth/consumed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"long":"12345"}',
      });
      expect(overLimit.status).toBe(413);
      expect(await overLimit.json()).toEqual({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the configured limit",
      });
      expect(
        warnings.mock.calls.filter(([message]) =>
          String(message).includes("W_BODY_ALREADY_CONSUMED"),
        ),
      ).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("keeps controller precedence and mounts outside global prefix and versioning", async () => {
    @Controller("api/auth")
    class HostController {
      @Public()
      @Get("owned")
      owned() {
        return { source: "controller" };
      }
    }
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [HostController],
      moduleOptions: {
        http: { around: [async () => Response.json({ source: "auth" })] },
      },
      configure: (app) => {
        app.setGlobalPrefix("v1");
        app.enableVersioning({ type: VersioningType.URI });
      },
    });
    try {
      const auth = await fetch(`${fixture.url}/api/auth/unowned`);
      expect(await auth.json()).toEqual({ source: "auth" });
      const controller = await fetch(`${fixture.url}/v1/api/auth/owned`);
      expect(await controller.json()).toEqual({ source: "controller" });
    } finally {
      await fixture.close();
    }
  });

  it("serves an exact controller route before the auth dispatcher", async () => {
    @Controller("api/auth")
    class OwnerController {
      @Public()
      @Get("owned")
      owned() {
        return { source: "controller" };
      }

      @Public()
      @Post("owned")
      ownedPost(
        @Body() body: unknown,
        @Req() req: IncomingMessage & { rawBody?: Buffer },
      ) {
        return {
          body,
          raw: req.rawBody?.toString("utf8"),
          source: "controller",
        };
      }

      @Public()
      @Post("teams/:teamId")
      ownedDynamic(
        @Body() body: unknown,
        @Req() req: IncomingMessage & { rawBody?: Buffer },
      ) {
        return { body, raw: req.rawBody?.toString("utf8") };
      }
    }
    @Controller("api/au:tail")
    class PartialSegmentOwnerController {
      @Public()
      @Post("partial")
      owned(
        @Body() body: unknown,
        @Req() req: IncomingMessage & { rawBody?: Buffer },
      ) {
        return { body, raw: req.rawBody?.toString("utf8") };
      }
    }
    let dispatched = 0;
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth: createTestAuth(),
          platforms: [expressPlatform()],
          http: {
            around: [
              async () => {
                dispatched += 1;
                return Response.json({ source: "auth" });
              },
            ],
          },
        }),
      ],
      controllers: [OwnerController, PartialSegmentOwnerController],
    }).compile();
    const app = module.createNestApplication<NestExpressApplication>(
      new ExpressAdapter(),
      { rawBody: true },
    );
    app.useBodyParser("json", {
      reviver: (key, value: unknown) =>
        key === "value" && typeof value === "number" ? value + 1 : value,
    });
    app.setGlobalPrefix("v1", {
      exclude: [
        { path: "api/auth/owned", method: RequestMethod.GET },
        { path: "api/auth/owned", method: RequestMethod.POST },
        { path: "api/auth/teams/:teamId", method: RequestMethod.POST },
        { path: "api/au:tail/partial", method: RequestMethod.POST },
      ],
    });
    try {
      await app.init();
      await app.listen(0, "127.0.0.1");
      const url = await app.getUrl();
      const response = await fetch(`${url}/api/auth/owned`);
      expect(await response.json()).toEqual({ source: "controller" });
      const raw = '{  "value" : 42 }';
      const post = await fetch(`${url}/api/auth/owned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(await post.json()).toEqual({
        body: { value: 43 },
        raw,
        source: "controller",
      });
      const dynamic = await fetch(`${url}/api/auth/teams/example`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(await dynamic.json()).toEqual({
        body: { value: 43 },
        raw,
      });
      const partial = await fetch(`${url}/api/auth/partial`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      });
      expect(await partial.json()).toEqual({
        body: { value: 43 },
        raw,
      });
      expect(dispatched).toBe(0);
    } finally {
      await app.close();
      await module.close();
    }
  });

  it("preserves URI-versioned controller bodies under the matching auth mount", async () => {
    @Controller({ path: "api/auth", version: "1" })
    class VersionedOwnerController {
      @Public()
      @Post("owned")
      owned(@Body() body: unknown) {
        return { body, source: "controller" };
      }
    }
    let dispatched = 0;
    const fixture = await startHttpFixture({
      auth: createTestAuth({ baseURL: "http://localhost:3000/v1/api/auth" }),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [VersionedOwnerController],
      moduleOptions: {
        http: {
          around: [
            async () => {
              dispatched += 1;
              return Response.json({ source: "auth" });
            },
          ],
        },
      },
      configure: (app) => {
        app.enableVersioning({ type: VersioningType.URI });
      },
    });
    try {
      const controller = await fetch(`${fixture.url}/v1/api/auth/owned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"versioned":true}',
      });
      expect(await controller.json()).toEqual({
        body: { versioned: true },
        source: "controller",
      });
      expect(dispatched).toBe(0);

      const auth = await fetch(`${fixture.url}/v1/api/auth/unowned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{  "exact" : true }',
      });
      expect(await auth.json()).toEqual({ source: "auth" });
      expect(dispatched).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("rejects host-conditional controller overlap before match or fallback can lose bytes", async () => {
    @Controller({ path: "api/au:tail", host: "admin.example" })
    class HostOwnerController {
      @Public()
      @Post("owned")
      owned(@Body() body: unknown) {
        return body;
      }
    }
    await expect(
      startHttpFixture({
        auth: createTestAuth(),
        adapter: new ExpressAdapter(),
        platform: expressPlatform(),
        controllers: [HostOwnerController],
      }),
    ).rejects.toThrow("CONDITIONAL_ROUTE_SHADOW");
  });

  it("rejects header-version controller overlap before a version mismatch can lose bytes", async () => {
    @Controller({ path: "api/auth", version: "1" })
    class HeaderVersionOwnerController {
      @Public()
      @Post("owned")
      owned(@Body() body: unknown) {
        return body;
      }
    }
    await expect(
      startHttpFixture({
        auth: createTestAuth(),
        adapter: new ExpressAdapter(),
        platform: expressPlatform(),
        controllers: [HeaderVersionOwnerController],
        configure: (app) => {
          app.enableVersioning({
            type: VersioningType.HEADER,
            header: "x-api-version",
          });
        },
      }),
    ).rejects.toThrow("CONDITIONAL_ROUTE_SHADOW");
  });

  it("allows unrelated conditional routes and bodyless conditional precedence", async () => {
    @Controller({ path: "outside", host: "admin.example" })
    class ConditionalOutsideController {
      @Public()
      @Post("owned")
      owned(@Body() body: unknown) {
        return body;
      }
    }
    @Controller({ path: "api/au\\:tail", host: "admin.example" })
    class EscapedLiteralConditionalController {
      @Public()
      @Post("owned")
      owned(@Body() body: unknown) {
        return body;
      }
    }
    @Controller({ path: "api/auth", host: "admin.example" })
    class ConditionalReadController {
      @Public()
      @Get("owned-read")
      owned() {
        return { source: "controller" };
      }
    }
    const echo = byteEcho();
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [
        ConditionalOutsideController,
        EscapedLiteralConditionalController,
        ConditionalReadController,
      ],
      moduleOptions: {
        http: {
          around: [
            (call) =>
              call.request.method === "GET"
                ? Promise.resolve(Response.json({ source: "auth" }))
                : echo(call),
          ],
        },
      },
    });
    try {
      const response = await fetch(`${fixture.url}/api/auth/unowned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{  "exact" : true }',
      });
      expect(await response.json()).toMatchObject({
        bytes: [...Buffer.from('{  "exact" : true }')],
      });
      const matched = await sendNodeRequest(
        `${fixture.url}/api/auth/owned-read`,
        { headers: { host: "admin.example" } },
      );
      expect(JSON.parse(matched.body.toString())).toEqual({
        source: "controller",
      });
      const mismatched = await sendNodeRequest(
        `${fixture.url}/api/auth/owned-read`,
        { headers: { host: "user.example" } },
      );
      expect(JSON.parse(mismatched.body.toString())).toEqual({
        source: "auth",
      });
    } finally {
      await fixture.close();
    }
  });

  it("matches controller ownership with Express case, trailing-slash, and ALL semantics", async () => {
    @Controller("api/auth")
    class AllOwnerController {
      @Public()
      @All("Owned")
      owned(@Body() body: unknown) {
        return { body, source: "controller" };
      }
    }
    const loose = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [AllOwnerController],
      moduleOptions: { http: { around: [byteEcho()] } },
    });
    try {
      const response = await fetch(`${loose.url}/api/auth/owned/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"native":true}',
      });
      expect(await response.json()).toEqual({
        body: { native: true },
        source: "controller",
      });
    } finally {
      await loose.close();
    }

    const strictApplication = express();
    strictApplication.set("case sensitive routing", true);
    strictApplication.set("strict routing", true);
    const strictAdapter = new ExpressAdapter(strictApplication);
    const strict = await startHttpFixture({
      auth: createTestAuth(),
      adapter: strictAdapter,
      platform: expressPlatform(),
      controllers: [AllOwnerController],
      moduleOptions: { http: { around: [byteEcho()] } },
      configure: () => {
        strictAdapter.set("case sensitive routing", false);
        strictAdapter.set("strict routing", false);
      },
    });
    try {
      const exact = await fetch(`${strict.url}/api/auth/Owned`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"native":true}',
      });
      expect(await exact.json()).toEqual({
        body: { native: true },
        source: "controller",
      });
      const fallback = await fetch(`${strict.url}/api/auth/owned/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{  "exact" : true }',
      });
      expect(await fallback.json()).toMatchObject({
        bytes: [...Buffer.from('{  "exact" : true }')],
      });
    } finally {
      await strict.close();
    }

    const looseAdapter = new ExpressAdapter();
    const lateStrict = await startHttpFixture({
      auth: createTestAuth(),
      adapter: looseAdapter,
      platform: expressPlatform(),
      controllers: [AllOwnerController],
      moduleOptions: { http: { around: [byteEcho()] } },
      configure: () => {
        looseAdapter.set("case sensitive routing", true);
        looseAdapter.set("strict routing", true);
      },
    });
    try {
      const nativeLoose = await fetch(`${lateStrict.url}/api/auth/owned/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"native":true}',
      });
      expect(await nativeLoose.json()).toEqual({
        body: { native: true },
        source: "controller",
      });
    } finally {
      await lateStrict.close();
    }
  });

  it("captures before parsers with async options while app JSON and rawBody stay native", async () => {
    const auth = createTestAuth();
    @Module({
      providers: [{ provide: "ASYNC_AUTH", useValue: auth }],
      exports: ["ASYNC_AUTH"],
    })
    class FactoryModule {}
    @Controller("app")
    class AppBodyController {
      @Public()
      @Post("body")
      body(
        @Body() body: unknown,
        @Req() req: IncomingMessage & { rawBody?: Buffer },
      ) {
        return { body, raw: req.rawBody?.toString("utf8") };
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRootAsync({
          imports: [FactoryModule],
          inject: ["ASYNC_AUTH"],
          platforms: [expressPlatform()],
          useFactory: async (resolved: typeof auth) => {
            await Promise.resolve();
            return { auth: resolved, http: { around: [byteEcho()] } };
          },
        }),
      ],
      controllers: [AppBodyController],
    }).compile();
    const app = module.createNestApplication(new ExpressAdapter(), {
      rawBody: true,
    });
    try {
      await app.init();
      await app.listen(0, "127.0.0.1");
      const url = await app.getUrl();
      const authBody = Buffer.from('{  "exact" : true }');
      const captured = await fetch(`${url}/api/auth/async`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: authBody,
      });
      expect(await captured.json()).toMatchObject({ bytes: [...authBody] });
      const ordinary = await fetch(`${url}/app/body`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{  "ordinary" : true }',
      });
      expect(await ordinary.json()).toEqual({
        body: { ordinary: true },
        raw: '{  "ordinary" : true }',
      });
    } finally {
      await app.close();
      await module.close();
    }
  });

  it("streams responses and aborts the inbound request signal on disconnect", async () => {
    let observedAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve;
    });
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          around: [
            async (call) => {
              if (new URL(call.request.url).pathname.endsWith("/disconnect")) {
                await new Promise<void>((resolve) => {
                  call.request.signal.addEventListener(
                    "abort",
                    () => {
                      observedAbort();
                      resolve();
                    },
                    { once: true },
                  );
                });
                return new Response("late");
              }
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(64 * 1024).fill(1));
                    controller.enqueue(new Uint8Array(64 * 1024).fill(2));
                    controller.close();
                  },
                }),
              );
            },
          ],
        },
      },
    });
    try {
      const streamed = await fetch(`${fixture.url}/api/auth/stream`);
      const bytes = new Uint8Array(await streamed.arrayBuffer());
      expect(bytes).toHaveLength(128 * 1024);
      expect(bytes[0]).toBe(1);
      expect(bytes.at(-1)).toBe(2);

      const pending = nodeRequest(`${fixture.url}/api/auth/disconnect`);
      pending.once("error", () => undefined);
      pending.end();
      setTimeout(() => pending.destroy(), 10);
      await expect(
        Promise.race([
          aborted.then(() => "aborted"),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve("timeout"), 1_000),
          ),
        ]),
      ).resolves.toBe("aborted");
    } finally {
      await fixture.close();
    }
  });

  it("runs real signup, session, protected, optional, public, sign-out, and login flows", async () => {
    const auth = createTestAuth({ session: { updateAge: 0 } });
    @Controller("account")
    class AccountController {
      @RequireAuth()
      @Get("protected")
      protected(@CurrentUser() user: { email: string }) {
        return { email: user.email };
      }

      @OptionalAuth()
      @Get("optional")
      optional(@CurrentPrincipal() principal: AuthPrincipal | null) {
        return { authenticated: principal !== null };
      }

      @Public()
      @Get("public")
      publicRoute() {
        return { public: true };
      }
    }
    const fixture = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [AccountController],
    });
    try {
      const anonymous = await fetch(`${fixture.url}/account/protected`);
      expect(anonymous.status).toBe(401);
      expect(
        await (await fetch(`${fixture.url}/account/optional`)).json(),
      ).toEqual({ authenticated: false });
      expect(
        await (await fetch(`${fixture.url}/account/public`)).json(),
      ).toEqual({ public: true });

      const registered = await signUp(fixture.url, {
        name: "Express User",
        email: "express@example.com",
        password: "correct horse battery staple",
      });
      expect(registered.status).toBe(200);
      let cookie = cookieHeader(registered);
      expect(cookie).toContain("session_token=");
      const protectedResponse = await fetch(
        `${fixture.url}/account/protected`,
        { headers: { cookie } },
      );
      expect(await protectedResponse.json()).toEqual({
        email: "express@example.com",
      });
      expect(
        await (
          await fetch(`${fixture.url}/account/optional`, {
            headers: { cookie },
          })
        ).json(),
      ).toEqual({ authenticated: true });

      const session = await fetch(`${fixture.url}/api/auth/get-session`, {
        headers: { cookie },
      });
      expect(session.status).toBe(200);
      expect((await session.json()).user.email).toBe("express@example.com");
      expect(session.headers.getSetCookie().length).toBeGreaterThan(0);

      const signedOut = await fetch(`${fixture.url}/api/auth/sign-out`, {
        method: "POST",
        headers: { cookie, origin: "http://localhost:3000" },
      });
      expect(signedOut.status).toBe(200);
      expect(signedOut.headers.getSetCookie().join(";")).toMatch(/Max-Age=0/i);
      expect(
        (
          await fetch(`${fixture.url}/account/protected`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(401);

      const loggedIn = await fetch(`${fixture.url}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "express@example.com",
          password: "correct horse battery staple",
        }),
      });
      expect(loggedIn.status).toBe(200);
      cookie = cookieHeader(loggedIn);
      expect(
        (
          await fetch(`${fixture.url}/account/protected`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(200);
    } finally {
      await fixture.close();
    }
  });

  it("enforces form CSRF on a cookie-free direct login proxy for every method", async () => {
    const auth = createTestAuth();
    @Controller("proxy")
    class LoginProxyController {
      constructor(private readonly service: BetterAuthService<typeof auth>) {}

      @Public()
      @ForwardAuthCookies()
      @All("login")
      login() {
        return this.service.api.signInEmail({
          body: {
            email: "proxy@example.com",
            password: "proxy password long enough",
          },
        });
      }
    }
    const fixture = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [LoginProxyController],
    });
    try {
      await signUp(fixture.url, {
        name: "Proxy User",
        email: "proxy@example.com",
        password: "proxy password long enough",
      });
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const denied = await fetch(`${fixture.url}/proxy/login`, { method });
        expect(denied.status).toBe(403);
      }
      const allowed = await fetch(`${fixture.url}/proxy/login`, {
        headers: { origin: "http://localhost:3000" },
      });
      expect(allowed.status).toBe(200);
      expect(cookieHeader(allowed)).toContain("session_token=");
    } finally {
      await fixture.close();
    }
  });

  it("allows safe cookie reads but requires an advisory origin pass for direct session calls", async () => {
    const auth = createTestAuth();
    @Catch(BetterAuthConfigurationError)
    class ExpectedConfigurationFilter implements ExceptionFilter {
      catch(_exception: unknown, host: ArgumentsHost) {
        const response = host.switchToHttp().getResponse<ServerResponse>();
        response.statusCode = 500;
        response.end();
      }
    }
    @Controller("safe")
    class SafeController {
      constructor(private readonly service: BetterAuthService<typeof auth>) {}

      @RequireAuth()
      @Get("read")
      read() {
        return { ok: true };
      }

      @RequireAuth()
      @Get("direct-sign-out")
      directSignOut(@Req() request: IncomingMessage) {
        return this.service.api.signOut({
          headers: this.service.headersFrom(request),
          returnHeaders: true,
        });
      }
    }
    const fixture = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [SafeController],
      providers: [ExpectedConfigurationFilter],
      configure: (app) => {
        app.useGlobalFilters(app.get(ExpectedConfigurationFilter));
      },
    });
    try {
      const cookie = cookieHeader(
        await signUp(fixture.url, {
          name: "Safe User",
          email: "safe@example.com",
          password: "safe password long enough",
        }),
      );
      const crossSite = {
        cookie,
        "sec-fetch-site": "cross-site",
      };
      expect(
        (await fetch(`${fixture.url}/safe/read`, { headers: crossSite }))
          .status,
      ).toBe(200);
      expect(
        (
          await fetch(`${fixture.url}/safe/direct-sign-out`, {
            headers: crossSite,
          })
        ).status,
      ).toBe(500);
      expect(
        (
          await fetch(`${fixture.url}/safe/read`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${fixture.url}/safe/direct-sign-out`, {
            headers: { cookie, origin: "http://localhost:3000" },
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await fetch(`${fixture.url}/safe/read`, {
            headers: { cookie },
          })
        ).status,
      ).toBe(401);
    } finally {
      await fixture.close();
    }
  });

  it("forwards foreign credential cookies only through the explicit service scope", async () => {
    const auth = createTestAuth();
    let firstForeign = "";
    let secondForeign = "";
    @Controller("proxy")
    class ForeignCredentialController {
      constructor(private readonly service: BetterAuthService<typeof auth>) {}

      @RequireAuth()
      @ForwardAuthCookies()
      @Post("direct-foreign")
      directForeign() {
        return this.service.api.signOut({
          headers: new Headers({ cookie: firstForeign }),
          returnHeaders: true,
        });
      }

      @RequireAuth()
      @ForwardAuthCookies()
      @Post("explicit-foreign")
      explicitForeign() {
        return this.service.forwardForeignCookies(() =>
          this.service.api.signOut({
            headers: new Headers({ cookie: secondForeign }),
            returnHeaders: true,
          }),
        );
      }
    }
    const fixture = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [ForeignCredentialController],
    });
    try {
      const caller = cookieHeader(
        await signUp(fixture.url, {
          name: "Caller",
          email: "caller@example.com",
          password: "caller password long enough",
        }),
      );
      firstForeign = cookieHeader(
        await signUp(fixture.url, {
          name: "First Foreign",
          email: "first-foreign@example.com",
          password: "foreign password long enough",
        }),
      );
      secondForeign = cookieHeader(
        await signUp(fixture.url, {
          name: "Second Foreign",
          email: "second-foreign@example.com",
          password: "foreign password long enough",
        }),
      );
      const headers = {
        cookie: caller,
        origin: "http://localhost:3000",
      };
      const dropped = await fetch(`${fixture.url}/proxy/direct-foreign`, {
        method: "POST",
        headers,
      });
      expect(dropped.status).toBe(201);
      expect(dropped.headers.getSetCookie()).toEqual([]);
      const forwarded = await fetch(`${fixture.url}/proxy/explicit-foreign`, {
        method: "POST",
        headers,
      });
      expect(forwarded.status).toBe(201);
      expect(forwarded.headers.getSetCookie().join(";")).toMatch(/Max-Age=0/i);
    } finally {
      await fixture.close();
    }
  });

  it("routes infrastructure and thrown API errors through Nest filters", async () => {
    const apiError = new APIError(
      "BAD_REQUEST",
      { code: "FILTERED", message: "filtered" },
      { "x-visible": "public" },
    );
    const hidden = new Headers({ "set-cookie": "cleared=; Max-Age=0" });
    Object.defineProperty(
      apiError,
      Symbol.for("better-call:api-error-headers"),
      {
        value: hidden,
      },
    );
    @Catch()
    class ProbeFilter implements ExceptionFilter {
      static readonly seen: unknown[] = [];

      catch(exception: unknown, host: ArgumentsHost) {
        ProbeFilter.seen.push(exception);
        const response = host.switchToHttp().getResponse<ServerResponse>();
        response.statusCode = 598;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ filtered: true }));
      }
    }
    const auth = createTestAuth({ onAPIError: { throw: true } });
    const fixture = await startHttpFixture({
      auth,
      adapter: new ExpressAdapter(),
      platform: expressPlatform(),
      controllers: [],
      providers: [ProbeFilter],
      moduleOptions: {
        http: {
          around: [
            async (call) => {
              if (new URL(call.request.url).pathname.endsWith("/api-error")) {
                throw apiError;
              }
              throw new Error("storage offline");
            },
          ],
        },
      },
      configure: (app) => {
        app.useGlobalFilters(app.get(ProbeFilter));
      },
    });
    try {
      for (const path of ["infrastructure", "api-error"]) {
        const response = await fetch(`${fixture.url}/api/auth/${path}`);
        expect(response.status).toBe(598);
        expect(await response.json()).toEqual({ filtered: true });
      }
      expect(isInfrastructureError(ProbeFilter.seen[0])).toBe(true);
      expect(ProbeFilter.seen[1]).toBe(apiError);
      expect(
        Reflect.get(
          ProbeFilter.seen[1] as object,
          Symbol.for("better-call:api-error-headers"),
        ),
      ).toBe(hidden);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a second Express application from one compiled container", async () => {
    const auth = createTestAuth();
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] }),
      ],
    }).compile();
    const first = module.createNestApplication(new ExpressAdapter());
    let second: ReturnType<typeof module.createNestApplication> | undefined;
    try {
      await first.init();
      await first.close();
      second = module.createNestApplication(new ExpressAdapter());
      await expect(second.init()).rejects.toThrow("APP_ADAPTER_CHANGED");
    } finally {
      await second?.close().catch(() => undefined);
      await first.close().catch(() => undefined);
      await module.close();
    }
  });
});
