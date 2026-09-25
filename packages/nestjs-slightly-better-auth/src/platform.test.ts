import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerResponse } from "node:http";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  appendSetCookie,
  bindAsyncContext,
  mayHaveBody,
  readBoundedBody,
  recoverConsumedBody,
  toWebHeaders,
  upgradeRequestUrl,
  writeWebResponse,
} from "./platform.js";

class RecordingResponse extends Writable {
  statusCode = 200;
  headersSent = false;
  readonly chunks: Buffer[] = [];
  maxBufferedBytes = 0;
  writeFailure: Error | undefined;
  private readonly headers = new Map<
    string,
    string | number | readonly string[]
  >();

  constructor() {
    super({ highWaterMark: 1 });
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string): string | number | readonly string[] | undefined {
    return this.headers.get(name.toLowerCase());
  }

  write(
    chunk: any,
    callback?: (error: Error | null | undefined) => void,
  ): boolean;
  write(
    chunk: any,
    encoding: BufferEncoding,
    callback?: (error: Error | null | undefined) => void,
  ): boolean;
  override write(
    chunk: any,
    encodingOrCallback?:
      | BufferEncoding
      | ((error: Error | null | undefined) => void),
    callback?: (error: Error | null | undefined) => void,
  ): boolean {
    if (this.writeFailure) {
      throw this.writeFailure;
    }
    const accepted =
      typeof encodingOrCallback === "string"
        ? super.write(chunk, encodingOrCallback, callback)
        : super.write(chunk, encodingOrCallback);
    this.maxBufferedBytes = Math.max(
      this.maxBufferedBytes,
      this.writableLength,
    );
    return accepted;
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));
    setImmediate(callback);
  }
}

class FailingDestroyReadable extends Readable {
  override _read(): void {}

  override _destroy(
    _error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    setImmediate(() => callback(new Error("destroy failed")));
  }
}

function asServerResponse(response: RecordingResponse): ServerResponse {
  return response as unknown as ServerResponse;
}

describe("toWebHeaders", () => {
  it("drops pseudo and symbol headers while preserving repeated values", () => {
    const internal = Symbol("http2-internal");
    const raw: Record<string | symbol, unknown> = {
      ":authority": "auth.example:8443",
      ":method": "POST",
      accept: ["application/json", "text/plain"],
      "set-cookie": ["first=1; Path=/", "second=2; Path=/"],
      [internal]: "secret",
    };

    const headers = toWebHeaders(raw);

    expect(headers.get("host")).toBe("auth.example:8443");
    expect(headers.get("accept")).toBe("application/json, text/plain");
    expect(headers.getSetCookie()).toEqual([
      "first=1; Path=/",
      "second=2; Path=/",
    ]);
    expect([...headers.keys()]).not.toContain(":authority");
    expect([...headers.values()]).not.toContain("secret");
  });

  it("keeps an explicit host instead of HTTP/2 authority", () => {
    const headers = toWebHeaders({
      ":authority": "authority.example",
      host: "host.example",
    });

    expect(headers.get("host")).toBe("host.example");
  });
});

describe("mayHaveBody", () => {
  it.each(["GET", "get", "HEAD", "head"])(
    "rejects %s even when framing headers are present",
    (method) => {
      expect(
        mayHaveBody(method, {
          "content-length": "12",
          "transfer-encoding": "chunked",
        }),
      ).toBe(false);
    },
  );

  it("accepts positive declared lengths and transfer encoding", () => {
    expect(mayHaveBody("POST", { "content-length": "1" })).toBe(true);
    expect(mayHaveBody("OPTIONS", { "transfer-encoding": "chunked" })).toBe(
      true,
    );
  });

  it.each([undefined, "", "0", "-1", "not-a-number"])(
    "rejects a request with only content-length %j",
    (value) => {
      expect(mayHaveBody("PATCH", { "content-length": value })).toBe(false);
    },
  );
});

describe("readBoundedBody", () => {
  it("preserves Node stream bytes at the exact limit", async () => {
    const stream = Readable.from([Buffer.from([0, 1]), Buffer.from([2, 255])]);

    await expect(readBoundedBody(stream, { limit: 4 })).resolves.toEqual({
      ok: true,
      bytes: Uint8Array.from([0, 1, 2, 255]),
    });
  });

  it("reads real Web streams and cancels them on overflow", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(readBoundedBody(stream, { limit: 3 })).resolves.toEqual({
      ok: false,
      reason: "too-large",
    });
    expect(cancelled).toBe(true);
  });

  it("drains a declared Node overflow so downstream sees an ended stream", async () => {
    const stream = Readable.from([Buffer.alloc(3), Buffer.alloc(3)]);

    await expect(
      readBoundedBody(stream, {
        limit: 2,
        declaredLength: 6,
        drainOnOverflow: true,
        drainCap: 8,
      }),
    ).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(stream.readableEnded).toBe(true);
    expect(stream.destroyed).toBe(true);
  });

  it("drains an observed overflow without retaining excess bytes", async () => {
    const stream = Readable.from([Buffer.from("ab"), Buffer.from("cde")]);

    await expect(
      readBoundedBody(stream, {
        limit: 2,
        drainOnOverflow: true,
        drainCap: 5,
      }),
    ).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(stream.readableEnded).toBe(true);
  });

  it("destroys a Node stream after the overflow drain cap", async () => {
    const stream = new PassThrough();
    const result = readBoundedBody(stream, {
      limit: 2,
      drainOnOverflow: true,
      drainCap: 6,
    });

    stream.write(Buffer.alloc(3));
    stream.write(Buffer.alloc(4));

    await expect(result).resolves.toEqual({ ok: false, reason: "too-large" });
    expect(stream.destroyed).toBe(true);
    expect(stream.readableEnded).toBe(false);
  });

  it("returns aborted for an interrupted Node stream", async () => {
    const stream = new PassThrough();
    const result = readBoundedBody(stream, { limit: 8 });

    stream.write(Buffer.from("ab"));
    stream.emit("aborted");

    await expect(result).resolves.toEqual({ ok: false, reason: "aborted" });
    expect(stream.destroyed).toBe(true);
  });

  it("returns aborted when a Web stream errors", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket reset"));
      },
    });

    await expect(readBoundedBody(stream, { limit: 8 })).resolves.toEqual({
      ok: false,
      reason: "aborted",
    });
  });

  it("handles an asynchronous error raised while destroying an overflow", async () => {
    const stream = new FailingDestroyReadable();
    const result = readBoundedBody(stream, { limit: 1 });

    stream.push(Buffer.alloc(2));

    await expect(result).resolves.toEqual({ ok: false, reason: "too-large" });
    const helperHandlesDestroyError = stream.listenerCount("error") > 0;
    if (!helperHandlesDestroyError) {
      stream.once("error", () => undefined);
    }
    expect(helperHandlesDestroyError).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
  });
});

describe("appendSetCookie", () => {
  it("appends each cookie to host-provided values", () => {
    const response = new RecordingResponse();
    response.setHeader("set-cookie", "cors=ready; Path=/");

    expect(
      appendSetCookie(asServerResponse(response), [
        "session=abc; Path=/; HttpOnly",
        "csrf=xyz; Path=/",
      ]),
    ).toBe(true);
    expect(response.getHeader("set-cookie")).toEqual([
      "cors=ready; Path=/",
      "session=abc; Path=/; HttpOnly",
      "csrf=xyz; Path=/",
    ]);
  });

  it("skips a line identical to its cookie's latest line and keeps order-significant repeats", () => {
    const response = new RecordingResponse();
    const session = "better-auth.session_token=abc; Path=/; HttpOnly";
    response.setHeader("set-cookie", session);
    const res = asServerResponse(response);

    expect(appendSetCookie(res, [session, "csrf=xyz; Path=/"])).toBe(true);
    expect(appendSetCookie(res, [session])).toBe(true);
    expect(response.getHeader("set-cookie")).toEqual([
      session,
      "csrf=xyz; Path=/",
    ]);
    const cleared = "better-auth.session_token=; Max-Age=0; Path=/";
    appendSetCookie(res, [cleared, session, session]);
    expect(response.getHeader("set-cookie")).toEqual([
      session,
      "csrf=xyz; Path=/",
      cleared,
      session,
    ]);
  });

  it("does not mutate a response whose headers were sent", () => {
    const response = new RecordingResponse();
    response.setHeader("set-cookie", "existing=1");
    response.headersSent = true;

    expect(appendSetCookie(asServerResponse(response), ["late=1"])).toBe(false);
    expect(response.getHeader("set-cookie")).toBe("existing=1");
  });
});

describe("writeWebResponse", () => {
  it("merges host headers, preserves cookies, and observes backpressure", async () => {
    const response = new RecordingResponse();
    response.setHeader("vary", "Origin, Accept-Encoding");
    response.setHeader("set-cookie", "host=1; Path=/");
    const headers = new Headers({
      vary: "Accept-Encoding, Cookie",
      "x-auth-result": "ok",
    });
    headers.append("set-cookie", "session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "csrf=xyz; Path=/");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4]));
        controller.close();
      },
    });

    await writeWebResponse(
      asServerResponse(response),
      new Response(body, { status: 201, headers }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.getHeader("x-auth-result")).toBe("ok");
    expect(response.getHeader("vary")).toBe("Origin, Accept-Encoding, Cookie");
    expect(response.getHeader("set-cookie")).toEqual([
      "host=1; Path=/",
      "session=abc; Path=/; HttpOnly",
      "csrf=xyz; Path=/",
    ]);
    expect(Buffer.concat(response.chunks)).toEqual(Buffer.from([1, 2, 3, 4]));
    expect(response.maxBufferedBytes).toBe(2);
    expect(response.writableFinished).toBe(true);
  });

  it("writes HEAD status and headers without consuming a response body", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("must not be written"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new RecordingResponse();

    await writeWebResponse(
      asServerResponse(response),
      new Response(body, {
        status: 404,
        headers: { "x-head": "present" },
      }),
      { head: true },
    );

    expect(response.statusCode).toBe(404);
    expect(response.getHeader("x-head")).toBe("present");
    expect(response.chunks).toEqual([]);
    expect(response.writableFinished).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("cancels the Web body when the client closes during backpressure", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from("chunk"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new RecordingResponse();
    const writing = writeWebResponse(
      asServerResponse(response),
      new Response(body),
    );

    setImmediate(() => response.emit("close"));

    await expect(writing).resolves.toBeUndefined();
    expect(cancelled).toBe(true);
    expect(response.writableFinished).toBe(false);
    expect(response.listenerCount("drain")).toBe(0);
  });

  it("cancels the Web body when a response write fails", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("chunk"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new RecordingResponse();
    const failure = new Error("write failed");
    response.writeFailure = failure;

    await expect(
      writeWebResponse(asServerResponse(response), new Response(body)),
    ).rejects.toBe(failure);
    expect(cancelled).toBe(true);
  });
});

describe("bindAsyncContext", () => {
  it("runs a later continuation in the context where it was bound", async () => {
    const storage = new AsyncLocalStorage<string>();
    let continuation: (() => string | undefined) | undefined;
    storage.run("capture-context", () => {
      continuation = bindAsyncContext(() => storage.getStore());
    });

    const observed = await new Promise<string | undefined>((resolve) => {
      storage.run("caller-context", () => {
        setImmediate(() => resolve(continuation?.()));
      });
    });

    expect(observed).toBe("capture-context");
    expect(storage.getStore()).toBeUndefined();
  });
});

describe("recoverConsumedBody", () => {
  it("prefers exact raw bytes over a parsed body", () => {
    const rawBody = Buffer.from([0, 255, 1, 2]);

    expect(
      recoverConsumedBody({
        headers: { "content-type": "application/json" },
        rawBody,
        body: { changed: true },
      } as any),
    ).toEqual(Uint8Array.from([0, 255, 1, 2]));
  });

  it.each([
    ["application/json; charset=utf-8", { b: 2, a: "x" }, '{"b":2,"a":"x"}'],
    ["application/scim+json", { active: true }, '{"active":true}'],
  ])("re-serializes parsed %s bodies", (contentType, body, expected) => {
    const bytes = recoverConsumedBody({
      headers: { "content-type": contentType },
      body,
    } as any);

    expect(new TextDecoder().decode(bytes ?? undefined)).toBe(expected);
  });

  it("re-serializes form values with URLSearchParams", () => {
    const bytes = recoverConsumedBody({
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { email: "a+b@example.com", remember: true },
    } as any);

    expect(new TextDecoder().decode(bytes ?? undefined)).toBe(
      "email=a%2Bb%40example.com&remember=true",
    );
  });

  it("returns null for unsupported or unencodable parsed bodies", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;

    expect(
      recoverConsumedBody({
        headers: { "content-type": "text/plain" },
        body: "hello",
      } as any),
    ).toBeNull();
    expect(
      recoverConsumedBody({
        headers: { "content-type": "application/json" },
        body: cyclic,
      } as any),
    ).toBeNull();
  });
});

describe("upgradeRequestUrl", () => {
  it("uses request TLS and Host while ignoring forwarding headers", () => {
    expect(
      upgradeRequestUrl({
        headers: {
          host: "internal.example:8443",
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "http",
        },
        secure: true,
        socket: { encrypted: false },
        url: "/socket.io/?EIO=4&transport=websocket%20raw",
      }),
    ).toBe(
      "https://internal.example:8443/socket.io/?EIO=4&transport=websocket%20raw",
    );
  });

  it("uses socket encryption with Web Headers", () => {
    expect(
      upgradeRequestUrl({
        headers: new Headers({ host: "auth.example" }),
        socket: { encrypted: true },
        url: "/events",
      }),
    ).toBe("https://auth.example/events");
  });

  it("does not let a network-path request target replace Host", () => {
    const result = upgradeRequestUrl({
      headers: {
        host: "auth.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
      },
      url: "//attacker.example/socket",
    });

    expect(result).toBe("http://auth.example//attacker.example/socket");
    expect(new URL(result).host).toBe("auth.example");
  });

  it("treats an absolute-form request target as a path under Host", () => {
    const result = upgradeRequestUrl({
      headers: { host: "auth.example" },
      socket: { encrypted: true },
      url: "https://attacker.example/socket?token=client",
    });

    expect(result).toBe(
      "https://auth.example/https://attacker.example/socket?token=client",
    );
    expect(new URL(result).host).toBe("auth.example");
  });

  it.each([undefined, "bad.example/path", "user@bad.example", "bad.example#"])(
    "rejects an absent or malformed Host value %j",
    (host) => {
      expect(() =>
        upgradeRequestUrl({
          headers: host === undefined ? {} : { host },
          url: "/socket",
        }),
      ).toThrow(TypeError);
    },
  );
});
