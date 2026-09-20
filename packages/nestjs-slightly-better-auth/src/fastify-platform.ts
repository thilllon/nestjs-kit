import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { AbstractHttpAdapter } from "@nestjs/core";
import type {
  CookieSink,
  ExtensionRef,
  FastifyPlatformOptions,
  HttpPlatform,
  HttpRequestAccessor,
  PlatformMountContext,
  PlatformPrepareContext,
} from "./auth-contracts.js";
import { toWebHeaders } from "./platform.js";

interface RawReplyLike {
  headersSent?: boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
  writableFinished?: boolean;
  once(event: "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "close", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
}

interface FastifyReplyLike {
  readonly raw: RawReplyLike;
  readonly request: FastifyRequestLike;
  readonly sent: boolean;
  code(status: number): FastifyReplyLike;
  header(name: string, value: string | readonly string[]): FastifyReplyLike;
  getHeader(name: string): string | number | readonly string[] | undefined;
  removeHeader(name: string): FastifyReplyLike;
  send(payload?: unknown): unknown;
}

interface FastifyRequestLike {
  readonly body?: unknown;
  readonly headers: IncomingHttpHeaders;
  readonly host: string;
  readonly ip?: string;
  readonly method: string;
  readonly originalUrl: string;
  readonly params?: unknown;
  readonly protocol: string;
  readonly raw: IncomingMessage;
}

interface FastifyInstanceLike {
  readonly errorHandler: (
    this: FastifyInstanceLike,
    error: unknown,
    request: FastifyRequestLike,
    reply: FastifyReplyLike,
  ) => unknown;
  readonly supportedMethods: readonly string[];
  addContentTypeParser(
    contentType: string,
    options: { readonly parseAs: "buffer"; readonly bodyLimit: number },
    parser: (
      request: FastifyRequestLike,
      body: Buffer,
      done: (error: Error | null, value?: Buffer) => void,
    ) => void,
  ): unknown;
  addHook(
    name: "onRequest",
    hook: (
      request: FastifyRequestLike,
      reply: FastifyReplyLike,
      done: (error?: Error) => void,
    ) => void,
  ): unknown;
  register(
    plugin: (scope: FastifyInstanceLike) => void | Promise<void>,
    options: { readonly prefix: string },
  ): PromiseLike<unknown>;
  removeAllContentTypeParsers(): unknown;
  route(options: {
    readonly method: readonly string[];
    readonly url: string;
    readonly exposeHeadRoute: false;
    readonly handler: (
      request: FastifyRequestLike,
      reply: FastifyReplyLike,
    ) => Promise<unknown>;
  }): unknown;
  setErrorHandler(
    handler: (
      this: FastifyInstanceLike,
      error: unknown,
      request: FastifyRequestLike,
      reply: FastifyReplyLike,
    ) => unknown,
  ): unknown;
}

function instanceOf(adapter: AbstractHttpAdapter): FastifyInstanceLike {
  return adapter.getInstance() as FastifyInstanceLike;
}

function asRequest(value: unknown): FastifyRequestLike | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const request = value as Partial<FastifyRequestLike>;
  return typeof request.raw === "object" && request.raw !== null
    ? (request as FastifyRequestLike)
    : undefined;
}

function varyParts(value: string | number | readonly string[] | undefined) {
  const values = Array.isArray(value)
    ? value
    : value === undefined
      ? []
      : [value];
  return values.flatMap((item) => String(item).split(","));
}

function mergedVary(
  current: string | number | readonly string[] | undefined,
  added: string,
): string {
  const values = [...varyParts(current), ...varyParts(added)]
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.includes("*")) {
    return "*";
  }
  const seen = new Set<string>();
  return values
    .filter((item) => {
      const key = item.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join(", ");
}

function abortOnDisconnect(
  request: IncomingMessage,
  response: RawReplyLike,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let disposed = false;
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const onRequestAborted = () => abort();
  const onRequestError = () => abort();
  const onResponseClose = () => {
    if (!response.writableFinished) {
      abort();
    }
  };
  const onResponseError = () => abort();
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    request.removeListener("aborted", onRequestAborted);
    request.removeListener("error", onRequestError);
    response.removeListener("close", onResponseClose);
    response.removeListener("error", onResponseError);
  };

  request.once("aborted", onRequestAborted);
  request.once("error", onRequestError);
  response.once("close", onResponseClose);
  response.once("error", onResponseError);
  if (
    request.aborted ||
    response.destroyed ||
    (request.socket.destroyed && !response.writableFinished)
  ) {
    abort();
  }
  return { signal: controller.signal, dispose };
}

async function sendWebResponse(
  reply: FastifyReplyLike,
  response: Response,
  head: boolean,
): Promise<unknown> {
  reply.code(response.status);
  for (const [name, value] of response.headers) {
    if (name === "set-cookie") {
      continue;
    }
    reply.header(
      name,
      name === "vary" ? mergedVary(reply.getHeader(name), value) : value,
    );
  }
  for (const cookie of response.headers.getSetCookie()) {
    reply.header("set-cookie", cookie);
  }
  if (reply.request.raw.httpVersionMajor === 2) {
    for (const name of [
      "connection",
      "keep-alive",
      "proxy-connection",
      "transfer-encoding",
      "upgrade",
    ]) {
      reply.removeHeader(name);
    }
  }
  if (head && response.body !== null) {
    await response.body.cancel().catch(() => undefined);
  }
  return reply.send(head ? undefined : (response.body ?? undefined));
}

/**
 * Fastify's encapsulated auth-route platform adapter.
 *
 * Fastify applies `trustProxy` to `request.ip`, but does not expose that option
 * through its public instance metadata. Proxy-trust reporting is therefore
 * intentionally unavailable instead of guessing a diagnostic mode.
 */
export class FastifyPlatform implements HttpPlatform {
  readonly id = "fastify";
  readonly capabilities = { http2: true, prepareAtInit: true } as const;
  readonly requests: HttpRequestAccessor;
  #replies = new WeakMap<object, FastifyReplyLike>();

  constructor(private readonly options: FastifyPlatformOptions = {}) {
    this.requests = {
      isRequest: (value) => {
        const request = asRequest(value);
        return request !== undefined && this.#replies.has(request.raw);
      },
      isLive: (value) => {
        const request = asRequest(value);
        const reply = request && this.#replies.get(request.raw);
        return reply !== undefined && !reply.sent;
      },
      key: (value) => {
        const request = asRequest(value);
        return request?.raw ?? (value as object);
      },
      headers: (value) => {
        const request = asRequest(value);
        return request ? toWebHeaders(request.raw.headers) : new Headers();
      },
      request: (value) => {
        const request = asRequest(value);
        if (!request) {
          return { method: "GET", url: "" };
        }
        return {
          method: request.method,
          url: `${request.protocol}://${request.host}${request.originalUrl}`,
        };
      },
      clientIp: (value) => {
        const request = asRequest(value);
        return request
          ? (this.options.clientIp?.(request) ?? request.ip ?? null)
          : null;
      },
      param: (value, name) => {
        const request = asRequest(value);
        if (
          !request ||
          typeof request.params !== "object" ||
          request.params === null
        ) {
          return undefined;
        }
        const parameter = Reflect.get(request.params, name);
        return typeof parameter === "string" ? parameter : undefined;
      },
      cookieSink: (value, response) => {
        const request = asRequest(value);
        if (!request) {
          return null;
        }
        const supplied = response as Partial<FastifyReplyLike> | null;
        const reply =
          supplied &&
          typeof supplied.header === "function" &&
          typeof supplied.sent === "boolean"
            ? (supplied as FastifyReplyLike)
            : this.#replies.get(request.raw);
        if (!reply) {
          return null;
        }
        const sink: CookieSink = {
          append: (cookies) => {
            if (reply.sent || reply.raw.headersSent) {
              return false;
            }
            for (const cookie of cookies) {
              reply.header("set-cookie", cookie);
            }
            return true;
          },
        };
        return sink;
      },
      responseFor: (value) => {
        const request = asRequest(value);
        return request ? this.#replies.get(request.raw) : undefined;
      },
    };
  }

  supports(adapter: AbstractHttpAdapter): boolean {
    return adapter.getType() === "fastify";
  }

  prepare(context: PlatformPrepareContext): void {
    const root = instanceOf(context.adapter);
    this.#replies = new WeakMap<object, FastifyReplyLike>();
    root.addHook("onRequest", (request, reply, done) => {
      this.#replies.set(request.raw, reply);
      done();
    });
  }

  async mount(context: PlatformMountContext): Promise<void> {
    const root = instanceOf(context.adapter);
    const { binding } = context;
    await root.register(
      async (scope) => {
        scope.removeAllContentTypeParsers();
        scope.addContentTypeParser(
          "*",
          { parseAs: "buffer", bodyLimit: binding.bodyLimit },
          (_request, body, done) => done(null, body),
        );
        scope.setErrorHandler(function (error, request, reply) {
          if (
            typeof error === "object" &&
            error !== null &&
            Reflect.get(error, "code") === "FST_ERR_CTP_BODY_TOO_LARGE"
          ) {
            return sendWebResponse(reply, binding.payloadTooLarge(), false);
          }
          return root.errorHandler.call(this, error, request, reply);
        });
        const handler = async (
          request: FastifyRequestLike,
          reply: FastifyReplyLike,
        ) => {
          const cancellation = abortOnDisconnect(request.raw, reply.raw);
          try {
            const response = await binding.handle({
              method: request.method,
              url: `${request.protocol}://${request.host}${request.originalUrl}`,
              headers: toWebHeaders(request.raw.headers),
              body: request.body instanceof Uint8Array ? request.body : null,
              clientIp: this.options.clientIp?.(request) ?? request.ip ?? null,
              platformRequest: request,
              signal: cancellation.signal,
            });
            if (cancellation.signal.aborted) {
              return undefined;
            }
            return await sendWebResponse(
              reply,
              response,
              request.method.toUpperCase() === "HEAD",
            );
          } catch (error) {
            if (cancellation.signal.aborted) {
              return undefined;
            }
            throw error;
          } finally {
            cancellation.dispose();
          }
        };
        const methods = [...scope.supportedMethods];
        scope.route({
          method: methods,
          url: "/",
          handler,
          exposeHeadRoute: false,
        });
        scope.route({
          method: methods,
          url: "/*",
          handler,
          exposeHeadRoute: false,
        });
      },
      { prefix: binding.basePath },
    );
  }
}

export function fastifyPlatform(
  options?: FastifyPlatformOptions,
): ExtensionRef<HttpPlatform> {
  return new FastifyPlatform(options);
}
