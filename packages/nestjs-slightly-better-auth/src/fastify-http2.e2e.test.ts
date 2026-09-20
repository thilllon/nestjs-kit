import {
  connect,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from "node:http2";
import {
  Catch,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { describe, expect, it } from "vitest";
import { isInfrastructureError } from "./auth-errors.js";
import { fastifyPlatform } from "./fastify.js";
import { createTestAuth, startHttpFixture } from "./test-fixtures.js";

interface Http2Result {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

function http2Request(
  origin: string,
  headers: OutgoingHttpHeaders,
  body?: Uint8Array,
): Promise<Http2Result> {
  return new Promise((resolve, reject) => {
    const session = connect(origin);
    const chunks: Buffer[] = [];
    let responseHeaders: IncomingHttpHeaders | undefined;
    const finishWithError = (error: Error) => {
      session.close();
      reject(error);
    };
    session.once("error", finishWithError);
    const stream = session.request(headers);
    stream.once("error", finishWithError);
    stream.once("response", (received) => {
      responseHeaders = received;
    });
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.once("end", () => {
      session.removeListener("error", finishWithError);
      session.close();
      resolve({
        status: Number(responseHeaders?.[":status"] ?? 0),
        headers: responseHeaders ?? {},
        body: Buffer.concat(chunks),
      });
    });
    stream.end(body);
  });
}

@Catch()
class Http2RecordingFilter implements ExceptionFilter {
  readonly errors: unknown[] = [];

  catch(error: unknown, host: ArgumentsHost): void {
    this.errors.push(error);
    const reply = host.switchToHttp().getResponse<{
      code(status: number): { send(value: unknown): void };
    }>();
    reply.code(598).send({ code: "HTTP2_FILTER_RECORDED" });
  }
}

describe("FastifyPlatform HTTP/2", () => {
  it("drops pseudo-headers, uses authority, preserves bytes and cookies, suppresses HEAD bodies, and delegates errors", async () => {
    const filter = new Http2RecordingFilter();
    let healthySignal: AbortSignal | undefined;
    let disconnectReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      disconnectReady = resolve;
    });
    let disconnectObserved = false;
    let observedDisconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      observedDisconnect = () => {
        disconnectObserved = true;
        resolve();
      };
    });
    const fixture = await startHttpFixture({
      auth: createTestAuth({ baseURL: undefined }),
      adapter: new FastifyAdapter({ http2: true }),
      platform: fastifyPlatform(),
      controllers: [],
      moduleOptions: {
        http: {
          allowRequestDerivedBaseURL: true,
          bodyLimit: 8,
          around: [
            async ({ request }) => {
              switch (request.headers.get("x-probe")) {
                case "inspect":
                  return Response.json({
                    url: request.url,
                    host: request.headers.get("host"),
                    pseudoHeaders: [...request.headers.keys()].filter((name) =>
                      name.startsWith(":"),
                    ),
                  });
                case "bytes":
                  return new Response(await request.arrayBuffer(), {
                    status: 206,
                    headers: { "content-type": "application/octet-stream" },
                  });
                case "cookies": {
                  const headers = new Headers({ "x-http2": "yes" });
                  headers.append("set-cookie", "h2-one=1; Path=/");
                  headers.append("set-cookie", "h2-two=2; Path=/");
                  return new Response("cookies", { status: 207, headers });
                }
                case "head":
                  return new Response("must-not-be-sent", {
                    status: 208,
                    headers: { "x-head": "kept" },
                  });
                case "healthy-signal": {
                  healthySignal = request.signal;
                  const before = request.signal.aborted;
                  await new Promise((resolve) => setTimeout(resolve, 30));
                  return Response.json({
                    before,
                    after: request.signal.aborted,
                  });
                }
                case "disconnect-signal":
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
                    }
                    disconnectReady();
                  });
                case "error":
                  throw new Error("http2 around failed");
                default:
                  return new Response(null, { status: 204 });
              }
            },
          ],
        },
      },
      configure: (app) => {
        app.useGlobalFilters(filter);
      },
    });
    try {
      const inspected = await http2Request(fixture.url, {
        ":method": "GET",
        ":path": "/api/auth/probe/%2Fkept?q=%2B%20space",
        ":authority": "auth.example.test:9443",
        "x-probe": "inspect",
      });
      expect(inspected.status).toBe(200);
      expect(JSON.parse(inspected.body.toString())).toEqual({
        url: "http://auth.example.test:9443/api/auth/probe/%2Fkept?q=%2B%20space",
        host: "auth.example.test:9443",
        pseudoHeaders: [],
      });

      const raw = Uint8Array.from([0, 1, 2, 128, 254, 255]);
      const echoed = await http2Request(
        fixture.url,
        {
          ":method": "POST",
          ":path": "/api/auth/raw",
          "content-type": "application/custom+binary",
          "x-probe": "bytes",
        },
        raw,
      );
      expect(echoed.status).toBe(206);
      expect(echoed.body).toEqual(Buffer.from(raw));

      const overflow = await http2Request(
        fixture.url,
        {
          ":method": "POST",
          ":path": "/api/auth/raw-overflow",
          "content-type": "application/octet-stream",
          "x-probe": "bytes",
        },
        Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]),
      );
      expect(overflow.status).toBe(413);
      expect(JSON.parse(overflow.body.toString())).toEqual({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body exceeds the configured limit",
      });

      const cookies = await http2Request(fixture.url, {
        ":method": "GET",
        ":path": "/api/auth/cookies",
        "x-probe": "cookies",
      });
      expect(cookies.status).toBe(207);
      expect(cookies.headers["set-cookie"]).toEqual([
        "h2-one=1; Path=/",
        "h2-two=2; Path=/",
      ]);
      expect(cookies.headers["x-http2"]).toBe("yes");

      const head = await http2Request(fixture.url, {
        ":method": "HEAD",
        ":path": "/api/auth/head",
        "x-probe": "head",
      });
      expect(head.status).toBe(208);
      expect(head.headers["x-head"]).toBe("kept");
      expect(head.body).toHaveLength(0);

      const healthy = await http2Request(
        fixture.url,
        {
          ":method": "POST",
          ":path": "/api/auth/healthy-signal",
          "content-type": "application/octet-stream",
          "x-probe": "healthy-signal",
        },
        Uint8Array.from([1]),
      );
      expect(healthy.status).toBe(200);
      expect(JSON.parse(healthy.body.toString())).toEqual({
        before: false,
        after: false,
      });
      expect(healthySignal?.aborted).toBe(false);

      const disconnectSession = connect(fixture.url);
      disconnectSession.on("error", () => undefined);
      const disconnectStream = disconnectSession.request({
        ":method": "POST",
        ":path": "/api/auth/disconnect-signal",
        "content-type": "application/octet-stream",
        "x-probe": "disconnect-signal",
      });
      disconnectStream.on("error", () => undefined);
      disconnectStream.end(Uint8Array.from([1]));
      await ready;
      expect(disconnectObserved).toBe(false);
      disconnectSession.destroy();
      await expect(
        Promise.race([
          disconnected.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 1_000),
          ),
        ]),
      ).resolves.toBe(true);

      const failed = await http2Request(fixture.url, {
        ":method": "GET",
        ":path": "/api/auth/error",
        "x-probe": "error",
      });
      expect(failed.status).toBe(598);
      expect(JSON.parse(failed.body.toString())).toEqual({
        code: "HTTP2_FILTER_RECORDED",
      });
      expect(filter.errors).toHaveLength(1);
      expect(isInfrastructureError(filter.errors[0])).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
