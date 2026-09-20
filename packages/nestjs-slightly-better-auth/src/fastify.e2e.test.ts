import {
  Body,
  Catch,
  Controller,
  Get,
  Post,
  Req,
  Res,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { request as nodeRequest } from "node:http";
import { Test } from "@nestjs/testing";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { describe, expect, it } from "vitest";
import { BeforeAuth } from "./auth-decorators.js";
import type { AuthHookContext } from "./auth-types.js";
import { isInfrastructureError } from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import { FastifyPlatform, fastifyPlatform } from "./fastify.js";
import { createTestAuth, startHttpFixture } from "./test-fixtures.js";

@Catch()
class RecordingFilter implements ExceptionFilter {
  readonly errors: unknown[] = [];

  catch(error: unknown, host: ArgumentsHost): void {
    this.errors.push(error);
    const reply = host.switchToHttp().getResponse<{
      code(status: number): { send(value: unknown): void };
    }>();
    reply.code(598).send({ code: "FILTER_RECORDED" });
  }
}

let accessorPlatform: FastifyPlatform;
let accessorRequest: unknown;

@Controller("platform-probe")
class PlatformProbeController {
  @Get("accessor/:id")
  accessor(
    @Req() request: unknown,
    @Res({ passthrough: true }) reply: unknown,
  ) {
    accessorRequest = request;
    const response = accessorPlatform.requests.responseFor?.(request);
    const sink = accessorPlatform.requests.cookieSink(request, undefined);
    sink?.append(["controller=one; Path=/", "controller=two; Path=/"]);
    return {
      isRequest: accessorPlatform.requests.isRequest(request),
      isLive: accessorPlatform.requests.isLive(request),
      rawIsKey:
        accessorPlatform.requests.key(request) ===
        (request as { raw: unknown }).raw,
      responseMatches: response === reply,
      id: accessorPlatform.requests.param(request, "id"),
      clientIp: accessorPlatform.requests.clientIp(request),
    };
  }
}

@Controller("api/auth")
class ApplicationController {
  @Post("application-json")
  applicationJson(@Body() body: unknown) {
    return { source: "controller", body };
  }
}

class SignInHook {
  calls = 0;

  @BeforeAuth("/sign-in/email")
  run(_context: AuthHookContext<"/sign-in/email">): void {
    this.calls += 1;
  }
}

function sendChunkedBody(
  url: string,
  headers: Record<string, string>,
  chunks: readonly Uint8Array[],
): Promise<{
  status: number;
  headers: import("node:http").IncomingHttpHeaders;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(
      url,
      { method: "POST", headers },
      (response) => {
        const received: Buffer[] = [];
        response.on("data", (chunk: Buffer) =>
          received.push(Buffer.from(chunk)),
        );
        response.once("error", reject);
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(received),
          });
        });
      },
    );
    request.once("error", reject);
    for (const chunk of chunks) {
      request.write(chunk);
    }
    request.end();
  });
}

describe("FastifyPlatform", () => {
  it("returns bounded-body failures through the host CORS layer", async () => {
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new FastifyAdapter(),
      platform: fastifyPlatform(),
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

      const chunked = await sendChunkedBody(
        `${fixture.url}/api/auth/sign-up/email`,
        {
          origin: "https://app.example",
          "content-type": "application/octet-stream",
        },
        [Buffer.from("12345"), Buffer.from("6789")],
      );
      expect(chunked.status).toBe(413);
      expect(chunked.headers["access-control-allow-origin"]).toBe(
        "https://app.example",
      );
      expect(JSON.parse(chunked.body.toString())).toEqual({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the configured limit",
      });
    } finally {
      await fixture.close();
    }
  });

  it("delegates an around failure to the Nest filter installed after auth routes", async () => {
    const failure = new Error("around failed");
    const filter = new RecordingFilter();
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new FastifyAdapter(),
      platform: fastifyPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          around: [async () => Promise.reject(failure)],
        },
      },
      configure: (app) => {
        app.useGlobalFilters(filter);
      },
    });
    try {
      const response = await fetch(`${fixture.url}/api/auth/get-session`);
      expect(response.status).toBe(598);
      expect(await response.json()).toEqual({ code: "FILTER_RECORDED" });
      expect(filter.errors).toHaveLength(1);
      expect(isInfrastructureError(filter.errors[0])).toBe(true);
      expect(
        (filter.errors[0] as Error & { cause?: Error }).cause?.message,
      ).toBe(failure.message);
    } finally {
      await fixture.close();
    }
  });

  it("preserves exact auth bytes, encoded targets, host hooks, CORS, cookies, and HEAD semantics", async () => {
    const calls: Array<{
      method: string;
      url: string;
      headers: Headers;
      bytes: Uint8Array;
    }> = [];
    const adapter = new FastifyAdapter();
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter,
      platform: fastifyPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          around: [
            async ({ request }) => {
              const bytes = new Uint8Array(await request.arrayBuffer());
              calls.push({
                method: request.method,
                url: request.url,
                headers: new Headers(request.headers),
                bytes,
              });
              const headers = new Headers({
                "content-type": "application/octet-stream",
                vary: "Accept-Encoding",
                "x-auth-response": "yes",
              });
              headers.append("set-cookie", "auth-one=1; Path=/");
              headers.append("set-cookie", "auth-two=2; Path=/");
              const body = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(Uint8Array.from([0, 1, 2]));
                  controller.enqueue(Uint8Array.from([253, 254, 255]));
                  controller.close();
                },
              });
              return new Response(body, { status: 207, headers });
            },
          ],
        },
      },
      configure: (app) => {
        app.enableCors({ origin: true, credentials: true });
        adapter
          .getInstance()
          .addHook("onSend", (_request, reply, payload, done) => {
            reply.header("x-host-hook", "seen");
            reply.header("set-cookie", "host-cookie=1; Path=/");
            done(null, payload);
          });
      },
    });
    try {
      const cases = [
        {
          method: "POST",
          path: "/api/auth/json",
          contentType: "application/json",
          bytes: Buffer.from('{\n  "name" : "é"\n}'),
        },
        {
          method: "POST",
          path: "/api/auth/form",
          contentType: "application/x-www-form-urlencoded",
          bytes: Buffer.from("value=%2B+space&utf8=%C3%A9"),
        },
        {
          method: "PUT",
          path: "/api/auth/multipart",
          contentType: "multipart/form-data; boundary=nsba",
          bytes: Buffer.from(
            '--nsba\r\nContent-Disposition: form-data; name="file"\r\n\r\n\u0000raw\r\n--nsba--\r\n',
          ),
        },
        {
          method: "POST",
          path: "/api/auth/no-content-type",
          contentType: undefined,
          bytes: Buffer.from([9, 8, 7, 0, 255]),
        },
        {
          method: "PATCH",
          path: "/api/auth/probe/%2Fkept?q=%2B%20space",
          contentType: "application/custom+binary",
          bytes: Buffer.from([0, 255, 12, 10, 195, 169]),
        },
      ] as const;
      let response!: Response;
      for (const entry of cases) {
        const headers: Record<string, string> = {
          origin: "https://app.example",
          "x-original": "kept",
        };
        if (entry.contentType) {
          headers["content-type"] = entry.contentType;
        }
        response = await fetch(`${fixture.url}${entry.path}`, {
          method: entry.method,
          headers,
          body: entry.bytes,
        });
        expect(response.status).toBe(207);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          Uint8Array.from([0, 1, 2, 253, 254, 255]),
        );
      }
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.example",
      );
      expect(response.headers.get("x-host-hook")).toBe("seen");
      expect(response.headers.get("x-auth-response")).toBe("yes");
      expect(
        response.headers
          .get("vary")
          ?.toLowerCase()
          .split(",")
          .map((value) => value.trim()),
      ).toEqual(expect.arrayContaining(["origin", "accept-encoding"]));
      expect(response.headers.getSetCookie()).toEqual([
        "auth-one=1; Path=/",
        "auth-two=2; Path=/",
        "host-cookie=1; Path=/",
      ]);
      for (const [index, entry] of cases.entries()) {
        expect(calls[index]?.method).toBe(entry.method);
        expect(calls[index]?.bytes).toEqual(Uint8Array.from(entry.bytes));
        expect(calls[index]?.headers.get("x-original")).toBe("kept");
      }
      expect(calls[4]?.url).toBe(
        "http://localhost:3000/api/auth/probe/%2Fkept?q=%2B%20space",
      );

      const head = await fetch(`${fixture.url}/api/auth/probe`, {
        method: "HEAD",
        headers: { origin: "https://app.example" },
      });
      expect(head.status).toBe(207);
      expect(head.headers.get("x-host-hook")).toBe("seen");
      expect(await head.text()).toBe("");
      expect(calls[5]).toMatchObject({
        method: "HEAD",
        bytes: new Uint8Array(),
      });

      for (const method of ["GET", "DELETE"]) {
        const methodResponse = await fetch(`${fixture.url}/api/auth/method`, {
          method,
        });
        expect(methodResponse.status).toBe(207);
        await methodResponse.arrayBuffer();
      }
      expect(calls.slice(6).map((call) => call.method)).toEqual([
        "GET",
        "DELETE",
      ]);

      const preflight = await fetch(`${fixture.url}/api/auth/method`, {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example",
          "access-control-request-method": "POST",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(
        "https://app.example",
      );
      expect(calls).toHaveLength(8);

      const outside = await fetch(`${fixture.url}/api/authx`);
      expect(outside.status).toBe(404);
      expect(calls).toHaveLength(8);
    } finally {
      await fixture.close();
    }
  });

  it("keeps application parsing and exact controller precedence under the auth mount", async () => {
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new FastifyAdapter(),
      platform: fastifyPlatform(),
      controllers: [ApplicationController],
      moduleOptions: { defaultAccess: "public" },
    });
    try {
      const response = await fetch(`${fixture.url}/api/auth/application-json`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{ "spaced": true }',
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        source: "controller",
        body: { spaced: true },
      });
    } finally {
      await fixture.close();
    }
  });

  it("keeps healthy signals live and aborts request handling or response streaming after client disconnect", async () => {
    let healthySignal: AbortSignal | undefined;
    let disconnectReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      disconnectReady = resolve;
    });
    let observedDisconnect!: () => void;
    let disconnectObserved = false;
    const disconnected = new Promise<void>((resolve) => {
      observedDisconnect = () => {
        disconnectObserved = true;
        resolve();
      };
    });
    let streamSignal: AbortSignal | undefined;
    let streamAbortObserved = false;
    let observeStreamAbort!: () => void;
    const streamAborted = new Promise<void>((resolve) => {
      observeStreamAbort = () => {
        streamAbortObserved = true;
        resolve();
      };
    });
    let delayedSourceContinued = false;
    let delayedSourceCancelled = false;
    let settleDelayedSource!: () => void;
    const delayedSourceSettled = new Promise<void>((resolve) => {
      settleDelayedSource = resolve;
    });
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new FastifyAdapter(),
      platform: fastifyPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          around: [
            async ({ request }) => {
              const path = new URL(request.url).pathname;
              if (path.endsWith("/healthy")) {
                healthySignal = request.signal;
                const before = request.signal.aborted;
                return new Promise<Response>((resolve) => {
                  setTimeout(() => {
                    resolve(
                      Response.json({
                        before,
                        after: request.signal.aborted,
                      }),
                    );
                  }, 30);
                });
              }
              if (path.endsWith("/stream-disconnect")) {
                streamSignal = request.signal;
                return new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(Buffer.from("first"));
                      const timer = setTimeout(() => {
                        delayedSourceContinued = true;
                        try {
                          controller.enqueue(Buffer.from("second"));
                          controller.close();
                        } catch {
                          // The transport may already have cancelled its reader.
                        }
                        settleDelayedSource();
                      }, 150);
                      const onAbort = () => {
                        clearTimeout(timer);
                        delayedSourceCancelled = true;
                        observeStreamAbort();
                        settleDelayedSource();
                      };
                      if (request.signal.aborted) {
                        onAbort();
                      } else {
                        request.signal.addEventListener("abort", onAbort, {
                          once: true,
                        });
                      }
                    },
                  }),
                  { headers: { "content-type": "application/octet-stream" } },
                );
              }
              return new Promise<Response>((resolve) => {
                const onAbort = () => {
                  observedDisconnect();
                  resolve(new Response(null, { status: 204 }));
                };
                if (request.signal.aborted) {
                  onAbort();
                } else {
                  request.signal.addEventListener("abort", onAbort, {
                    once: true,
                  });
                  disconnectReady();
                }
              });
            },
          ],
        },
      },
    });
    try {
      const healthy = await fetch(`${fixture.url}/api/auth/healthy`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "healthy request",
      });
      expect(healthy.status).toBe(200);
      expect(await healthy.json()).toEqual({ before: false, after: false });
      expect(healthySignal?.aborted).toBe(false);

      const firstOutputChunk = new Promise<Buffer>((resolve, reject) => {
        const outputRequest = nodeRequest(
          `${fixture.url}/api/auth/stream-disconnect`,
          (response) => {
            response.once("data", (chunk: Buffer) => {
              resolve(Buffer.from(chunk));
              response.destroy();
            });
            response.once("error", () => undefined);
          },
        );
        outputRequest.once("error", reject);
        outputRequest.end();
      });
      await expect(firstOutputChunk).resolves.toEqual(Buffer.from("first"));
      await expect(
        Promise.race([
          streamAborted.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 1_000),
          ),
        ]),
      ).resolves.toBe(true);
      await delayedSourceSettled;
      expect(streamAbortObserved).toBe(true);
      expect(streamSignal?.aborted).toBe(true);
      expect(delayedSourceCancelled).toBe(true);
      expect(delayedSourceContinued).toBe(false);

      let clientRequest!: ReturnType<typeof nodeRequest>;
      const clientFinished = new Promise<void>((resolve, reject) => {
        clientRequest = nodeRequest(
          `${fixture.url}/api/auth/disconnect`,
          { method: "POST", headers: { "content-type": "text/plain" } },
          (response) => {
            response.resume();
            response.once("end", resolve);
          },
        );
        clientRequest.once("error", (error) => {
          if ((error as NodeJS.ErrnoException).code === "ECONNRESET") {
            resolve();
          } else {
            reject(error);
          }
        });
        clientRequest.end("complete body");
      });
      await ready;
      expect(disconnectObserved).toBe(false);
      clientRequest.destroy();
      await expect(
        Promise.race([
          disconnected.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 1_000),
          ),
        ]),
      ).resolves.toBe(true);
      await clientFinished;
    } finally {
      await fixture.close();
    }
  });

  it("provides live request identity, reply lookup, params, and an append-only cookie sink", async () => {
    accessorPlatform = new FastifyPlatform({
      clientIp: () => "203.0.113.9",
    });
    accessorRequest = undefined;
    const fixture = await startHttpFixture({
      auth: createTestAuth(),
      adapter: new FastifyAdapter(),
      platform: accessorPlatform,
      controllers: [PlatformProbeController],
      moduleOptions: { defaultAccess: "public" },
    });
    try {
      const response = await fetch(
        `${fixture.url}/platform-probe/accessor/abc`,
      );
      expect(await response.json()).toEqual({
        isRequest: true,
        isLive: true,
        rawIsKey: true,
        responseMatches: true,
        id: "abc",
        clientIp: "203.0.113.9",
      });
      expect(response.headers.getSetCookie()).toEqual([
        "controller=one; Path=/",
        "controller=two; Path=/",
      ]);
      expect(accessorPlatform.requests.isLive(accessorRequest)).toBe(false);
      expect(accessorPlatform.requests.isRequest(accessorRequest)).toBe(true);
      expect(
        accessorPlatform.requests.responseFor?.(accessorRequest),
      ).toBeDefined();
      expect(
        accessorPlatform.requests
          .cookieSink(accessorRequest, undefined)
          ?.append(["too-late=1"]),
      ).toBe(false);
      expect(accessorPlatform.requests.isRequest({})).toBe(false);
      expect(
        accessorPlatform.requests.isRequest(
          (accessorRequest as { raw: unknown }).raw,
        ),
      ).toBe(false);
    } finally {
      await fixture.close();
    }
  });

  it("uses Fastify native IP resolution without claiming unavailable proxy-trust metadata", async () => {
    const matrix = [
      { trustProxy: false, expected: "127.0.0.1" },
      { trustProxy: true, expected: "203.0.113.10" },
      { trustProxy: "127.0.0.1", expected: "198.51.100.2" },
    ] as const;

    for (const entry of matrix) {
      const platform = new FastifyPlatform();
      expect("proxyTrust" in platform).toBe(false);
      const observed: Array<{ native: string | null; bridged: string | null }> =
        [];
      const fixture = await startHttpFixture({
        auth: createTestAuth(),
        adapter: new FastifyAdapter({ trustProxy: entry.trustProxy }),
        platform,
        controllers: [],
        moduleOptions: {
          http: {
            around: [
              async ({ request, platformRequest }) => {
                const bridge = [...request.headers].find(([name]) =>
                  name.startsWith("x-nsba-ip-"),
                );
                observed.push({
                  native: platform.requests.clientIp(platformRequest),
                  bridged: bridge?.[1] ?? null,
                });
                return new Response(null, { status: 204 });
              },
            ],
          },
        },
      });
      try {
        const response = await fetch(`${fixture.url}/api/auth/ip`, {
          headers: {
            "x-forwarded-for": "203.0.113.10, 198.51.100.2",
          },
        });
        expect(response.status).toBe(204);
        expect(observed).toEqual([
          { native: entry.expected, bridged: entry.expected },
        ]);
      } finally {
        await fixture.close();
      }
    }
  });

  it("prepares a fresh adapter when one compiled TestingModule creates a second application", async () => {
    const platform = new FastifyPlatform();
    const replies: unknown[] = [];
    const requests: unknown[] = [];
    const auth = createTestAuth();
    await auth.api.signUpEmail({
      body: {
        name: "Reuse User",
        email: "reuse@example.com",
        password: "password123",
      },
    });
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          platforms: [platform],
          http: {
            around: [
              async (call, next) => {
                requests.push(call.platformRequest);
                replies.push(
                  platform.requests.responseFor?.(call.platformRequest),
                );
                return next();
              },
            ],
          },
        }),
      ],
      providers: [SignInHook],
    }).compile();
    const hook = module.get(SignInHook);
    const signIn = async (
      app: ReturnType<typeof module.createNestApplication>,
    ) => {
      await app.init();
      await app.listen(0, "127.0.0.1");
      const response = await fetch(
        `${await app.getUrl()}/api/auth/sign-in/email`,
        {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: "reuse@example.com",
            password: "password123",
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
    };

    const first = module.createNestApplication(new FastifyAdapter());
    try {
      await signIn(first);
    } finally {
      await first.close();
    }
    const second = module.createNestApplication(new FastifyAdapter());
    try {
      await signIn(second);
      expect(platform.requests.responseFor?.(requests[0])).toBeUndefined();
      expect(hook.calls).toBe(2);
      expect(replies).toHaveLength(2);
      expect(replies[0]).toBeDefined();
      expect(replies[1]).toBeDefined();
      expect(replies[1]).not.toBe(replies[0]);
    } finally {
      await second.close();
    }
  });
});
