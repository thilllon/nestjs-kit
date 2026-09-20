import type { LoggerService } from "@nestjs/common";
import { isAPIError, type APIError } from "better-auth/api";
import type {
  AuthContextView,
  AuthRouteBinding,
  CorsOriginOptions,
  InboundAuthRequest,
  ProxyTrust,
} from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  createInfrastructureError,
  getAPIErrorHeaders,
} from "./auth-errors.js";
import { ErrorRedactor } from "./error-redactor.js";
import type { InstanceEntry } from "./instance-registry.js";
import { readBoundedBody } from "./platform.js";
import type { RequestScope } from "./request-scope.js";
import type { AuthLike } from "./auth-types.js";
import { TrustedOrigins } from "./trusted-origins.js";

export interface AuthExchangeInit {
  readonly basePath: string;
  readonly bodyLimit: number;
  readonly staticOrigin: string | undefined;
  readonly logger: LoggerService;
  readonly proxyTrust?: ProxyTrust;
}

const HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
];

function sdkAPIError(error: unknown): error is APIError {
  try {
    return isAPIError(error);
  } catch {
    return false;
  }
}

function production(): boolean {
  return !["development", "dev", "test"].includes(process.env.NODE_ENV ?? "");
}

function distance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 0; row < left.length; row++) {
    const current = [row + 1];
    for (let column = 0; column < right.length; column++) {
      current.push(
        Math.min(
          current[column]! + 1,
          previous[column + 1]! + 1,
          previous[column]! + Number(left[row] !== right[column]),
        ),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/** App-owned exchange; all platform request and response operations stay outside core. */
export class AuthExchange {
  #warnedProxy = false;

  constructor(private readonly scope: RequestScope) {}

  create(entry: InstanceEntry, init: AuthExchangeInit): AuthRouteBinding {
    const paths = [
      ...new Set(
        Object.values(entry.instance.api).flatMap((endpoint) => {
          const path = Reflect.get(endpoint, "path");
          return typeof path === "string" ? [path] : [];
        }),
      ),
    ];
    const seen = new Set<string>();
    const binding: AuthRouteBinding = Object.freeze({
      instance: entry.name,
      basePath: init.basePath,
      bodyLimit: init.bodyLimit,
      staticOrigin: init.staticOrigin,
      matches: (pathname: string) =>
        init.basePath === "/"
          ? pathname.startsWith("/")
          : pathname === init.basePath ||
            pathname.startsWith(`${init.basePath}/`),
      payloadTooLarge: () =>
        Response.json(
          {
            code: "PAYLOAD_TOO_LARGE",
            message: "Request body exceeds the configured limit",
          },
          { status: 413 },
        ),
      handle: async (inbound: InboundAuthRequest) => {
        const response = await this.handle(entry, init, binding, inbound);
        if (
          response.status === 404 &&
          (entry.options.http?.diagnostics ?? !production())
        ) {
          const pathname = new URL(inbound.url).pathname;
          const key = `${inbound.method.toUpperCase()} ${pathname}`;
          if (binding.matches(pathname) && !seen.has(key) && seen.size < 100) {
            seen.add(key);
            const requested = pathname.slice(
              init.basePath === "/" ? 0 : init.basePath.length,
            );
            const closest = paths.reduce<string | undefined>(
              (best, path) =>
                best === undefined ||
                distance(requested, path) < distance(requested, best)
                  ? path
                  : best,
              undefined,
            );
            const suggestion = closest
              ? ` Did you mean ${init.basePath === "/" ? "" : init.basePath}${closest}?`
              : "";
            init.logger.warn(
              `better-auth has no route for ${key} (mounted at ${init.basePath}).${suggestion}`,
            );
          }
        }
        return response;
      },
    });
    return binding;
  }

  private async handle(
    entry: InstanceEntry,
    init: AuthExchangeInit,
    binding: AuthRouteBinding,
    inbound: InboundAuthRequest,
  ): Promise<Response> {
    const redactors = [
      new ErrorRedactor({
        secrets: [entry.context.secret],
        headers: inbound.headers,
        credentialHeaders: entry.credentialHeaders,
      }),
    ];
    try {
      const method = inbound.method.toUpperCase();
      let body: Uint8Array | null = null;
      if (method !== "GET" && method !== "HEAD") {
        if (inbound.body instanceof Uint8Array) {
          if (inbound.body.byteLength > init.bodyLimit) {
            return binding.payloadTooLarge();
          }
          body = inbound.body;
        } else if (inbound.body !== null) {
          const bounded = await readBoundedBody(inbound.body, {
            limit: init.bodyLimit,
          });
          if (!bounded.ok) {
            if (bounded.reason === "too-large") {
              return binding.payloadTooLarge();
            }
            throw new Error("Authentication request body was aborted");
          }
          body = bounded.bytes;
        }
      }
      let url: URL;
      try {
        url = new URL(inbound.url);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          throw new TypeError("Invalid request URL");
        }
        if (init.staticOrigin) {
          url = new URL(`${init.staticOrigin}${url.pathname}${url.search}`);
        }
      } catch {
        return Response.json(
          { code: "INVALID_REQUEST_URL", message: "Invalid request URL" },
          { status: 400 },
        );
      }
      const headers = new Headers(inbound.headers);
      const nominated = (headers.get("connection") ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      for (const name of [...HOP_HEADERS, ...nominated]) {
        headers.delete(name);
      }
      const ipHeader = entry.bridge.clientIpHeader;
      for (const name of [...headers.keys()]) {
        if (name.startsWith("x-nsba-ip-") || name === ipHeader?.toLowerCase()) {
          headers.delete(name);
        }
      }
      if (ipHeader && inbound.clientIp !== null) {
        headers.set(ipHeader, inbound.clientIp);
      }
      this.warnProxy(entry, init, inbound);
      const request = new Request(url, {
        method,
        headers,
        body: body === null ? null : Uint8Array.from(body),
        signal: inbound.signal,
      });
      const interceptors = entry.options.http?.around ?? [];
      const dispatch = (index: number, current: Request): Promise<Response> => {
        redactors.push(
          new ErrorRedactor({
            headers: current.headers,
            credentialHeaders: entry.credentialHeaders,
          }),
        );
        const interceptor = interceptors[index];
        return interceptor
          ? interceptor(
              {
                request: current,
                platformRequest: inbound.platformRequest,
                instance: entry.name,
              },
              (replacement = current) => dispatch(index + 1, replacement),
            )
          : this.scope.exit(() => entry.instance.handler(current));
      };
      return await dispatch(0, request);
    } catch (error) {
      if (sdkAPIError(error)) {
        if (entry.context.options.onAPIError?.throw) {
          throw error;
        }
        return Response.json(error.body ?? { message: error.message }, {
          status: error.statusCode,
          headers: getAPIErrorHeaders(error),
        });
      }
      let cause: unknown = error;
      for (const redactor of redactors) {
        cause = redactor.redact(cause);
      }
      const wrapped = createInfrastructureError(cause);
      if (entry.options.errors?.exposeRawCause) {
        // The opt-in retains the original separately while the ordinary cause stays redacted.
        const raw = createInfrastructureError(error, { exposeRawCause: true });
        Object.defineProperty(raw, "cause", { value: wrapped.cause });
        throw raw;
      }
      throw wrapped;
    }
  }

  private warnProxy(
    entry: InstanceEntry,
    init: AuthExchangeInit,
    inbound: InboundAuthRequest,
  ): void {
    if (
      this.#warnedProxy ||
      !production() ||
      init.proxyTrust?.mode !== "none" ||
      !["x-forwarded-for", "forwarded", "x-real-ip"].some((name) =>
        inbound.headers.has(name),
      )
    ) {
      return;
    }
    this.#warnedProxy = true;
    const ip = entry.context.options.advanced?.ipAddress;
    const bridgeHeader = entry.bridge.clientIpHeader;
    const bridgeHeaderFirst =
      bridgeHeader !== null &&
      ip?.ipAddressHeaders?.[0]?.toLowerCase() === bridgeHeader.toLowerCase();
    let effect: string;
    if (!entry.context.rateLimit.enabled) {
      if (bridgeHeader === null) {
        effect =
          "Rate limiting is disabled; the bridge does not insert this socket IP, so better-auth's configured IP resolution determines the session IP.";
      } else if (!bridgeHeaderFirst) {
        effect =
          "Rate limiting is disabled; a configured better-auth IP header precedes the bridge header, so this socket IP is not necessarily recorded on sessions.";
      } else {
        effect =
          "Rate limiting is disabled; this IP is recorded on sessions only.";
      }
    } else if (bridgeHeader === null) {
      effect =
        "The bridge does not insert this socket IP; better-auth's configured IP resolution determines the rate-limit key.";
    } else if (!bridgeHeaderFirst) {
      effect =
        "A configured better-auth IP header precedes the bridge header, so this socket IP is not necessarily the rate-limit key.";
    } else if (ip?.trustedProxies?.length) {
      effect =
        "If better-auth trustedProxies covers this address, no client IP remains and all clients share one rate-limit bucket. Otherwise this socket IP is the rate-limit key.";
    } else {
      effect =
        "This socket IP is the rate-limit key, so clients behind the proxy share its bucket.";
    }
    init.logger.warn(
      `W_PROXY_UNTRUSTED: platform resolved socket IP ${inbound.clientIp ?? "unknown"}. ${effect} Configure platform proxy trust (${init.proxyTrust.detail}).`,
    );
  }
}

/** Credentialed CORS for the auth mount, using the initialized SDK trusted origins. */
export function betterAuthCorsOrigin(
  auth: AuthLike,
  options?: CorsOriginOptions,
): (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void {
  const context = async () => (await auth.$context) as AuthContextView;
  const trusted = new TrustedOrigins(context);
  return (origin, callback) => {
    void (async () => {
      const initialized = await context();
      if (typeof initialized.options.trustedOrigins === "function") {
        throw new BetterAuthConfigurationError(
          "DYNAMIC_CORS_ORIGIN",
          "Function-valued trustedOrigins needs a request that a CORS origin callback cannot provide",
          "Supply a request-aware CORS origin function instead of betterAuthCorsOrigin.",
        );
      }
      if (!origin) {
        return false;
      }
      if (options?.allowPatterns) {
        return trusted.isTrusted(origin);
      }
      return (await trusted.list()).some((candidate) => {
        try {
          const parsed = new URL(candidate);
          return (
            (parsed.protocol === "http:" || parsed.protocol === "https:") &&
            !candidate.includes("*") &&
            candidate === parsed.origin &&
            origin === candidate
          );
        } catch {
          return false;
        }
      });
    })().then(
      (allow) => callback(null, allow),
      (error: unknown) =>
        callback(
          error instanceof Error
            ? error
            : new Error("Failed to resolve trusted CORS origins"),
        ),
    );
  };
}
