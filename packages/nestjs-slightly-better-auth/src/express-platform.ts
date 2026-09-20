import type {
  IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import type { AbstractHttpAdapter } from "@nestjs/core";
import type {
  AuthRouteBinding,
  ExpressPlatformOptions,
  HttpPlatform,
  PlatformMountContext,
  PlatformPrepareContext,
  ProxyTrust,
} from "./auth-contracts.js";
import {
  appendSetCookie,
  bindAsyncContext,
  mayHaveBody,
  readBoundedBody,
  recoverConsumedBody,
  toWebHeaders,
  writeWebResponse,
} from "./platform.js";

const RAW_BODY = Symbol.for("nestjs-slightly-better-auth:raw-body");

type Next = (error?: unknown) => void;
type CapturedBody = Awaited<ReturnType<typeof readBoundedBody>>;
type ExpressResponse = ServerResponse & { req?: ExpressRequest };
type ExpressRequest = IncomingMessage & {
  readonly originalUrl?: string;
  readonly protocol?: string;
  readonly host?: string;
  readonly ip?: string;
  readonly res?: ExpressResponse;
  readonly params?: Record<string, unknown>;
  readonly body?: unknown;
  readonly rawBody?: Buffer;
  [RAW_BODY]?: CapturedBody;
};
type ExpressApplication = {
  use(
    handler: (req: ExpressRequest, res: ExpressResponse, next: Next) => void,
  ): unknown;
  get(setting: string): unknown;
};

function application(adapter: AbstractHttpAdapter): ExpressApplication {
  return adapter.getInstance() as ExpressApplication;
}

function rawTarget(req: ExpressRequest): string {
  return req.originalUrl ?? req.url ?? "/";
}

function rawPath(req: ExpressRequest): string {
  const target = rawTarget(req);
  const query = target.indexOf("?");
  return query === -1 ? target : target.slice(0, query);
}

function declaredLength(
  headers: IncomingHttpHeaders,
  limit: number,
): number | undefined {
  const value = headers["content-length"];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "string" || !/^\d+$/.test(first)) {
    return undefined;
  }
  const parsed = Number(first);
  return Number.isSafeInteger(parsed) ? parsed : limit + 1;
}

function requestUrl(req: ExpressRequest): string {
  const socket = req.socket as typeof req.socket & { encrypted?: boolean };
  return `${req.protocol ?? (socket.encrypted ? "https" : "http")}://${req.host ?? ""}${rawTarget(req)}`;
}

function isExpressRequest(value: unknown): value is ExpressRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const req = value as Partial<ExpressRequest>;
  return (
    typeof req.method === "string" &&
    typeof req.headers === "object" &&
    typeof req.res === "object" &&
    req.res !== null &&
    (req.res.req === undefined || req.res.req === value)
  );
}

function nativeResponse(value: unknown): ServerResponse | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const response = value as Partial<ServerResponse>;
  return typeof response.setHeader === "function" &&
    typeof response.getHeader === "function"
    ? (value as ServerResponse)
    : null;
}

function proxyTrustOf(value: unknown): ProxyTrust {
  if (value === false || value === undefined) {
    return { mode: "none", detail: "trust proxy = false" };
  }
  if (value === true) {
    return { mode: "all", detail: "trust proxy = true" };
  }
  const rendered =
    typeof value === "function"
      ? "<function>"
      : Array.isArray(value)
        ? JSON.stringify(value)
        : String(value);
  return { mode: "partial", detail: `trust proxy = ${rendered}` };
}

function abortOnDisconnect(
  req: ExpressRequest,
  res: ExpressResponse,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  res.once("close", abort);
  if (req.aborted || res.destroyed) {
    abort();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      req.removeListener("aborted", abort);
      res.removeListener("close", abort);
    },
  };
}

/** Express-specific two-phase HTTP integration. */
export class ExpressPlatform implements HttpPlatform {
  readonly id = "express";
  #warnedConsumedBody = false;

  constructor(private readonly options: ExpressPlatformOptions = {}) {}

  readonly requests = {
    isRequest: (value: unknown): boolean => isExpressRequest(value),
    isLive: (value: unknown): boolean =>
      isExpressRequest(value) && value.res?.writableEnded === false,
    key: (value: unknown): object => value as object,
    headers: (value: unknown): Headers =>
      toWebHeaders((value as ExpressRequest).headers),
    request: (value: unknown) => {
      const req = value as ExpressRequest;
      return { method: req.method ?? "GET", url: requestUrl(req) };
    },
    clientIp: (value: unknown): string | null =>
      this.clientIp(value as ExpressRequest),
    param: (value: unknown, name: string): string | undefined => {
      const parameter = (value as ExpressRequest).params?.[name];
      return typeof parameter === "string" ? parameter : undefined;
    },
    cookieSink: (request: unknown, response: unknown) => {
      const req = request as ExpressRequest;
      const res = nativeResponse(response) ?? nativeResponse(req.res);
      return res === null
        ? null
        : {
            append: (cookies: readonly string[]) =>
              appendSetCookie(res, cookies),
          };
    },
  };

  supports(adapter: AbstractHttpAdapter): boolean {
    return adapter.getType?.() === "express";
  }

  prepare(ctx: PlatformPrepareContext): void {
    application(ctx.adapter).use((req, _res, next) => {
      const binding = ctx.route(rawPath(req));
      const method = (req.method ?? "GET").toUpperCase();
      if (
        !binding ||
        method === "GET" ||
        method === "HEAD" ||
        method === "OPTIONS" ||
        !mayHaveBody(method, req.headers)
      ) {
        next();
        return;
      }

      const continueRequest = bindAsyncContext(next);
      if (req.readableEnded || req.readable === false) {
        const recovered = recoverConsumedBody(req);
        req[RAW_BODY] = {
          ok: true,
          bytes: recovered ?? new Uint8Array(),
        };
        if (!this.#warnedConsumedBody) {
          this.#warnedConsumedBody = true;
          ctx.logger.warn(
            "W_BODY_ALREADY_CONSUMED: an Express body parser ran before the auth capture; raw-signature webhooks may receive re-serialized bytes.",
          );
        }
        continueRequest();
        return;
      }

      void readBoundedBody(req, {
        limit: binding.bodyLimit,
        declaredLength: declaredLength(req.headers, binding.bodyLimit),
        drainOnOverflow: true,
        drainCap: Math.min(Number.MAX_SAFE_INTEGER, binding.bodyLimit * 8),
      }).then(
        (captured) => {
          req[RAW_BODY] = captured;
          continueRequest();
        },
        (error: unknown) => continueRequest(error),
      );
    });
  }

  mount(ctx: PlatformMountContext): void {
    application(ctx.adapter).use((req, res, next) => {
      if (!ctx.binding.matches(rawPath(req))) {
        next();
        return;
      }
      const disconnect = abortOnDisconnect(req, res);
      void this.dispatch(ctx.binding, req, res, disconnect.signal).then(
        () => disconnect.dispose(),
        (error: unknown) => {
          disconnect.dispose();
          if (!disconnect.signal.aborted) {
            next(error);
          }
        },
      );
    });
  }

  proxyTrust(adapter: AbstractHttpAdapter): ProxyTrust {
    return proxyTrustOf(application(adapter).get("trust proxy"));
  }

  private clientIp(req: ExpressRequest): string | null {
    if (this.options.clientIp) {
      return this.options.clientIp(req);
    }
    return req.ip ?? null;
  }

  private async dispatch(
    binding: AuthRouteBinding,
    req: ExpressRequest,
    res: ExpressResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const captured = req[RAW_BODY];
    if (
      (captured && !captured.ok && captured.reason === "aborted") ||
      signal.aborted
    ) {
      return;
    }
    const response =
      captured && !captured.ok && captured.reason === "too-large"
        ? binding.payloadTooLarge()
        : await binding.handle({
            method: req.method ?? "GET",
            url: requestUrl(req),
            headers: toWebHeaders(req.headers),
            body: captured?.ok ? captured.bytes : null,
            clientIp: this.clientIp(req),
            platformRequest: req,
            signal,
          });
    if (signal.aborted) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await writeWebResponse(res, response, {
      head: req.method?.toUpperCase() === "HEAD",
    });
  }
}

export function expressPlatform(
  options?: ExpressPlatformOptions,
): ExpressPlatform {
  return new ExpressPlatform(options);
}
