import { AsyncResource } from "node:async_hooks";
import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { headerLines, setCookieAdditions } from "./set-cookies.js";

function appendHeaderValue(
  headers: Headers,
  name: string,
  value: unknown,
): void {
  if (typeof value === "string") {
    headers.append(name, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        headers.append(name, item);
      }
    }
  }
}

/** Convert Node headers to Web headers without exposing HTTP/2 metadata. */
export function toWebHeaders(
  raw: IncomingHttpHeaders | Record<string | symbol, unknown>,
): Headers {
  const headers = new Headers();
  let authority: unknown;
  for (const [name, value] of Object.entries(raw)) {
    if (name === ":authority") {
      authority = value;
    }
    if (name.startsWith(":")) {
      continue;
    }
    appendHeaderValue(headers, name, value);
  }
  if (!headers.has("host")) {
    appendHeaderValue(headers, "host", authority);
  }
  return headers;
}

/** Determine whether Node request framing permits a request body. */
export function mayHaveBody(
  method: string,
  headers: IncomingHttpHeaders,
): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD") {
    return false;
  }
  if (headers["transfer-encoding"] !== undefined) {
    return true;
  }
  const declaredLength = headers["content-length"]?.trim();
  return (
    declaredLength !== undefined &&
    /^\d+$/.test(declaredLength) &&
    BigInt(declaredLength) > 0n
  );
}

interface ReadBoundedBodyOptions {
  limit: number;
  declaredLength?: number;
  drainOnOverflow?: boolean;
  drainCap?: number;
}

type ReadBoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too-large" | "aborted" };

function assertByteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function joinBytes(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedWebBody(
  stream: ReadableStream<Uint8Array>,
  options: ReadBoundedBodyOptions,
): Promise<ReadBoundedBodyResult> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (
      options.declaredLength !== undefined &&
      options.declaredLength > options.limit
    ) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, reason: "too-large" };
    }
    while (true) {
      const next = await reader.read();
      if (next.done) {
        return { ok: true, bytes: joinBytes(chunks, length) };
      }
      length += next.value.byteLength;
      if (length > options.limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too-large" };
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, reason: "aborted" };
  } finally {
    reader.releaseLock();
  }
}

type DestroyableReadable = NodeJS.ReadableStream & {
  destroyed?: boolean;
  destroy?: () => unknown;
};

function nodeChunkBytes(chunk: unknown): Uint8Array | null {
  if (typeof chunk === "string") {
    return Buffer.from(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  return null;
}

function readBoundedNodeBody(
  stream: DestroyableReadable,
  options: ReadBoundedBodyOptions,
): Promise<ReadBoundedBodyResult> {
  const drainCap = options.drainCap ?? options.limit * 8;
  assertByteLimit(drainCap, "drainCap");

  return new Promise((resolve) => {
    const chunks: Uint8Array[] = [];
    let length = 0;
    let overflow =
      options.declaredLength !== undefined &&
      options.declaredLength > options.limit;
    let settled = false;

    const cleanup = () => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("aborted", onAborted);
      stream.removeListener("error", onAborted);
      stream.removeListener("close", onClose);
    };
    const destroy = () => {
      if (!stream.destroyed) {
        const absorbDestroyError = () => undefined;
        const removeDestroyErrorHandler = () => {
          stream.removeListener("error", absorbDestroyError);
        };
        stream.once("error", absorbDestroyError);
        stream.once("close", removeDestroyErrorHandler);
        try {
          stream.destroy?.();
        } catch {
          stream.removeListener("error", absorbDestroyError);
          stream.removeListener("close", removeDestroyErrorHandler);
        }
      }
    };
    const finish = (result: ReadBoundedBodyResult, destroyStream = false) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
      if (destroyStream) {
        destroy();
      }
    };
    const tooLarge = () => {
      finish({ ok: false, reason: "too-large" }, true);
    };
    const onData = (chunk: unknown) => {
      const bytes = nodeChunkBytes(chunk);
      if (bytes === null) {
        finish({ ok: false, reason: "aborted" }, true);
        return;
      }
      length += bytes.byteLength;
      if (!overflow && length <= options.limit) {
        chunks.push(bytes);
        return;
      }
      overflow = true;
      chunks.length = 0;
      if (!options.drainOnOverflow || length > drainCap) {
        tooLarge();
      }
    };
    const onEnd = () => {
      if (overflow) {
        finish({ ok: false, reason: "too-large" });
        return;
      }
      finish({ ok: true, bytes: joinBytes(chunks, length) });
    };
    const onAborted = () => {
      finish({ ok: false, reason: "aborted" }, true);
    };
    const onClose = () => {
      finish({ ok: false, reason: "aborted" });
    };

    stream.once("end", onEnd);
    stream.once("aborted", onAborted);
    stream.once("error", onAborted);
    stream.once("close", onClose);

    if (overflow && !options.drainOnOverflow) {
      tooLarge();
      return;
    }
    if (
      overflow &&
      options.declaredLength !== undefined &&
      options.declaredLength > drainCap
    ) {
      tooLarge();
      return;
    }
    stream.on("data", onData);
  });
}

/** Read a Node or Web body stream without retaining bytes past the limit. */
export function readBoundedBody(
  stream: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
  options: {
    limit: number;
    declaredLength?: number;
    drainOnOverflow?: boolean;
    drainCap?: number;
  },
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too-large" | "aborted" }
> {
  assertByteLimit(options.limit, "limit");
  if (
    options.declaredLength !== undefined &&
    (!Number.isSafeInteger(options.declaredLength) ||
      options.declaredLength < 0)
  ) {
    throw new RangeError("declaredLength must be a non-negative safe integer");
  }
  if ("getReader" in stream) {
    return readBoundedWebBody(stream, options);
  }
  return readBoundedNodeBody(stream, options);
}

/** Append response cookies without replacing values already set by the host. */
export function appendSetCookie(
  res: ServerResponse,
  values: readonly string[],
): boolean {
  if (res.headersSent) {
    return false;
  }
  const existing = headerLines(res.getHeader("set-cookie"));
  const additions = setCookieAdditions(existing, values);
  if (additions.length > 0) {
    res.setHeader("set-cookie", [...existing, ...additions]);
  }
  return true;
}

function varyValues(value: string | number | readonly string[] | undefined) {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw.flatMap((item) => String(item).split(","));
}

function mergeVary(
  current: string | number | readonly string[] | undefined,
  added: string,
): string {
  const values = [...varyValues(current), ...varyValues(added)]
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.includes("*")) {
    return "*";
  }
  const seen = new Set<string>();
  return values
    .filter((value) => {
      const normalized = value.toLowerCase();
      if (seen.has(normalized)) {
        return false;
      }
      seen.add(normalized);
      return true;
    })
    .join(", ");
}

function endServerResponse(res: ServerResponse): Promise<void> {
  if (res.writableEnded) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.removeListener("error", onError);
      res.removeListener("close", onClose);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onError = (error: Error) => {
      finish(error);
    };
    const onClose = () => {
      finish();
    };
    res.once("error", onError);
    res.once("close", onClose);
    res.end(() => finish());
  });
}

type ReadOutcome =
  | { type: "read"; value: ReadableStreamReadResult<Uint8Array> }
  | { type: "read-error"; error: unknown }
  | { type: "stopped" };

function waitForDrainOrStop(
  res: ServerResponse,
  stopped: Promise<void>,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      res.removeListener("drain", finish);
      resolve();
    };
    res.once("drain", finish);
    void stopped.then(finish);
  });
}

/** Write a Web response while retaining host headers and Node backpressure. */
export async function writeWebResponse(
  res: ServerResponse,
  response: Response,
  options?: { head?: boolean },
): Promise<void> {
  res.statusCode = response.status;
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") {
      continue;
    }
    if (name === "vary") {
      res.setHeader("vary", mergeVary(res.getHeader("vary"), value));
    } else {
      res.setHeader(name, value);
    }
  }
  appendSetCookie(res, response.headers.getSetCookie());

  if (options?.head || response.body === null) {
    if (options?.head && response.body !== null) {
      await response.body.cancel().catch(() => undefined);
    }
    await endServerResponse(res);
    return;
  }

  const reader = response.body.getReader();
  let stopped = false;
  let writeError: Error | undefined;
  let stop!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const onClose = () => {
    stopped = true;
    stop();
    void reader.cancel().catch(() => undefined);
  };
  const onError = (error: Error) => {
    writeError = error;
    stopped = true;
    stop();
    void reader.cancel(error).catch(() => undefined);
  };
  res.once("close", onClose);
  res.once("error", onError);

  try {
    while (!stopped) {
      const read: Promise<ReadOutcome> = reader.read().then(
        (value): ReadOutcome => ({ type: "read", value }),
        (error: unknown): ReadOutcome => ({ type: "read-error", error }),
      );
      const outcome = await Promise.race<ReadOutcome>([
        read,
        stoppedPromise.then(() => ({ type: "stopped" })),
      ]);
      if (outcome.type === "stopped") {
        break;
      }
      if (outcome.type === "read-error") {
        throw outcome.error;
      }
      if (outcome.value.done) {
        break;
      }
      if (!res.write(outcome.value.value)) {
        await waitForDrainOrStop(res, stoppedPromise);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    res.removeListener("close", onClose);
    res.removeListener("error", onError);
    reader.releaseLock();
  }

  if (writeError) {
    throw writeError;
  }
  if (!stopped) {
    await endServerResponse(res);
  }
}

/** Capture the active async resource for a later stream continuation. */
export function bindAsyncContext<F extends (...args: any[]) => any>(fn: F): F {
  return AsyncResource.bind(fn) as F;
}

function contentTypeOf(req: IncomingMessage): string {
  const raw = req.headers["content-type"];
  return (
    (Array.isArray(raw) ? raw[0] : raw)
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? ""
  );
}

function serializeFormBody(body: unknown): string | null {
  if (typeof body === "string" || body instanceof URLSearchParams) {
    return new URLSearchParams(body).toString();
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        parameters.append(name, String(item));
      }
    } else {
      parameters.append(name, String(value));
    }
  }
  return parameters.toString();
}

/** Recover bytes after an earlier host parser consumed the request stream. */
export function recoverConsumedBody(
  req: IncomingMessage & { body?: unknown; rawBody?: Buffer },
): Uint8Array | null {
  if (Buffer.isBuffer(req.rawBody)) {
    return Uint8Array.from(req.rawBody);
  }
  const contentType = contentTypeOf(req);
  try {
    if (contentType === "application/json" || contentType.endsWith("+json")) {
      const serialized = JSON.stringify(req.body);
      return serialized === undefined
        ? null
        : new TextEncoder().encode(serialized);
    }
    if (contentType === "application/x-www-form-urlencoded") {
      const serialized = serializeFormBody(req.body);
      return serialized === null ? null : new TextEncoder().encode(serialized);
    }
  } catch {
    return null;
  }
  return null;
}

function hostHeader(headers: IncomingHttpHeaders | Headers): string | null {
  if (headers instanceof Headers) {
    return headers.get("host");
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== "host") {
      continue;
    }
    if (typeof value === "string") {
      return value;
    }
    if (Array.isArray(value) && typeof value[0] === "string") {
      return value[0];
    }
  }
  return null;
}

/** Build an upgrade URL from socket TLS state, Host, and the raw target. */
export function upgradeRequestUrl(request: {
  headers: IncomingHttpHeaders | Headers;
  url?: string;
  secure?: boolean;
  socket?: { encrypted?: boolean };
}): string {
  const scheme = request.secure || request.socket?.encrypted ? "https" : "http";
  const host = hostHeader(request.headers);
  if (
    host === null ||
    host.length === 0 ||
    [...host].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || "/\\?#@".includes(character);
    })
  ) {
    throw new TypeError("A valid Host header is required for an upgrade URL");
  }
  let origin: URL;
  try {
    origin = new URL(`${scheme}://${host}`);
  } catch {
    throw new TypeError("A valid Host header is required for an upgrade URL");
  }
  if (
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    origin.host === ""
  ) {
    throw new TypeError("A valid Host header is required for an upgrade URL");
  }
  const target = request.url ?? "/";
  if (
    [...target].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f || character === "#";
    })
  ) {
    throw new TypeError(
      "A valid request target is required for an upgrade URL",
    );
  }
  const path = target.startsWith("/") ? target : `/${target}`;
  return `${scheme}://${host}${path}`;
}
