import type { ExecutionContext } from "@nestjs/common";
import { isAPIError } from "better-auth/api";
import { ErrorRedactor, readErrorProperty } from "./error-redactor.js";

const FAILURE_BRAND = Symbol.for("nestjs-slightly-better-auth:auth-failure");
const INFRASTRUCTURE_BRAND = Symbol.for(
  "nestjs-slightly-better-auth:infrastructure-error",
);
const CONFIGURATION_BRAND = Symbol.for(
  "nestjs-slightly-better-auth:configuration-error",
);
const RAW_CAUSE = Symbol.for("nestjs-slightly-better-auth:raw-cause");
const SDK_HEADERS = Symbol.for("better-call:api-error-headers");

export type AuthErrorCode = "UNAUTHENTICATED" | "FORBIDDEN" | "RATE_LIMITED";

/** A transport-neutral denial. Only transports make it throwable. */
export interface AuthFailure {
  readonly status: 401 | 403 | 429;
  readonly code: AuthErrorCode;
  readonly reason?: string;
  readonly message: string;
  readonly challenge?: string;
  readonly headers?: Headers;
}

export interface AuthErrorBody {
  statusCode: 401 | 403 | 429;
  error: string;
  code: AuthErrorCode;
  reason?: string;
  message: string;
}

export interface AuthGraphqlExtensions {
  code: AuthErrorCode | "INTERNAL_SERVER_ERROR";
  reason?: string;
  statusCode: number;
}

export interface AuthTransportErrorPayload {
  status: "error";
  statusCode: number;
  code: AuthErrorCode;
  reason?: string;
  message: string;
}

export interface ErrorMappingOptions {
  map?: (
    failure: AuthFailure,
    context: ExecutionContext,
    transport: string,
  ) => unknown;
  exposeRawCause?: boolean;
}

function branded<T extends object>(value: T, brand: symbol): T {
  Object.defineProperty(value, brand, { value: true });
  return value;
}

export function isAuthFailure(value: unknown): value is AuthFailure {
  return readErrorProperty(value, FAILURE_BRAND) === true;
}

export function isInfrastructureError(
  value: unknown,
): value is BetterAuthInfrastructureError {
  return readErrorProperty(value, INFRASTRUCTURE_BRAND) === true;
}

export function isConfigurationError(
  value: unknown,
): value is BetterAuthConfigurationError {
  return readErrorProperty(value, CONFIGURATION_BRAND) === true;
}

function sdkStatus(error: unknown): number | undefined {
  try {
    if (!isAPIError(error)) {
      return undefined;
    }
    const status = readErrorProperty(error, "statusCode");
    return typeof status === "number" &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
      ? status
      : undefined;
  } catch {
    return undefined;
  }
}

function sdkReason(error: unknown): string | undefined {
  const reason = readErrorProperty(readErrorProperty(error, "body"), "code");
  return typeof reason === "string" ? reason : undefined;
}

/** Internal: preserve cookie lines for the exchange's separately governed cleanup. */
export function getAPIErrorHeaders(error: unknown): Headers {
  const result = new Headers();
  for (const value of [
    readErrorProperty(error, SDK_HEADERS),
    readErrorProperty(error, "headers"),
  ]) {
    if (value === undefined || value === null) {
      continue;
    }
    try {
      const headers = new Headers(value as HeadersInit);
      for (const [name, value] of headers) {
        if (name !== "set-cookie") {
          result.set(name, value);
        }
      }
      for (const cookie of headers.getSetCookie()) {
        result.append("set-cookie", cookie);
      }
    } catch {
      // A malformed optional header collection must not mask the original fault.
    }
  }
  return result;
}

function rejection(input: {
  status: 401 | 403 | 429;
  reason?: string;
  message?: string;
  challenge?: string;
  retryAfterSeconds?: number;
}): AuthFailure {
  const codes = {
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    429: "RATE_LIMITED",
  } as const;
  const messages = {
    401: "Unauthorized",
    403: "Forbidden",
    429: "Too Many Requests",
  } as const;
  const headers = new Headers();
  const retry = input.retryAfterSeconds;
  if (retry !== undefined && Number.isFinite(retry) && retry >= 0) {
    headers.set("retry-after", String(Math.ceil(retry)));
  }
  return branded(
    {
      status: input.status,
      code: codes[input.status],
      reason: input.reason,
      message: input.message ?? messages[input.status],
      challenge: input.challenge,
      ...(headers.has("retry-after") ? { headers } : {}),
    },
    FAILURE_BRAND,
  );
}

export const AuthFailures = {
  unauthenticated(message?: string): AuthFailure {
    return rejection({ status: 401, message });
  },
  rejected: rejection,
  forbidden(reason: string, message?: string): AuthFailure {
    return rejection({ status: 403, reason, message });
  },
  fromAPIError(error: unknown): AuthFailure | null {
    const status = sdkStatus(error);
    if (status !== 401 && status !== 403 && status !== 429) {
      return null;
    }
    const originalHeaders = getAPIErrorHeaders(error);
    const details = readErrorProperty(
      readErrorProperty(error, "body"),
      "details",
    );
    const delay = readErrorProperty(details, "tryAgainIn");
    const failure = rejection({
      status,
      reason: sdkReason(error),
      challenge: originalHeaders.get("www-authenticate") ?? undefined,
      retryAfterSeconds:
        status === 429 && typeof delay === "number" ? delay / 1000 : undefined,
    });
    const retryAfter = originalHeaders.get("retry-after");
    if (retryAfter !== null) {
      const headers = new Headers(failure.headers);
      headers.set("retry-after", retryAfter);
      return branded({ ...failure, headers }, FAILURE_BRAND);
    }
    return failure;
  },
};

export class BetterAuthConfigurationError extends Error {
  readonly code: string;
  readonly detail: string;
  readonly site?: string;
  readonly hint?: string;
  readonly phase: "boot" | "request";
  readonly extensions = {
    code: "INTERNAL_SERVER_ERROR",
    reason: "AUTH_MISCONFIGURED",
    statusCode: 500,
  } as const;
  readonly issues?: readonly BetterAuthConfigurationError[];

  constructor(code: string, detail: string, hint?: string) {
    super(detail);
    this.name = "BetterAuthConfigurationError";
    this.code = code;
    this.detail = detail;
    this.hint = hint;
    this.phase = "boot";
    branded(this, CONFIGURATION_BRAND);
  }

  static atRequest(
    code: string,
    detail: string,
    options?: { site?: string; hint?: string },
  ): BetterAuthConfigurationError {
    const error = new BetterAuthConfigurationError(
      code,
      "Authentication is misconfigured",
      options?.hint,
    );
    Object.defineProperties(error, {
      detail: { value: detail, enumerable: true },
      site: { value: options?.site, enumerable: true },
      phase: { value: "request", enumerable: true },
    });
    return error;
  }
}

export class BetterAuthInfrastructureError extends Error {
  readonly cause: Error;
  readonly extensions = {
    code: "INTERNAL_SERVER_ERROR",
    reason: "AUTH_UNAVAILABLE",
    statusCode: 500,
  } as const;

  constructor(cause: unknown, options?: { secrets?: readonly string[] }) {
    super("Authentication service unavailable");
    this.name = "BetterAuthInfrastructureError";
    this.cause = new ErrorRedactor(options).redact(cause);
    branded(this, INFRASTRUCTURE_BRAND);
  }
}

/** Internal factory for an instance's explicit diagnostic opt-in, never global state. */
export function createInfrastructureError(
  cause: unknown,
  options?: { secrets?: readonly string[]; exposeRawCause?: boolean },
): BetterAuthInfrastructureError {
  const error = new BetterAuthInfrastructureError(cause, options);
  if (options?.exposeRawCause === true) {
    Object.defineProperty(error, RAW_CAUSE, {
      value: cause,
      enumerable: false,
    });
  }
  return error;
}

export function getRawCause(error: BetterAuthInfrastructureError): unknown {
  return readErrorProperty(error, RAW_CAUSE);
}

/** Internal: evaluation must distinguish session loss from a failed session read. */
export interface SessionLossCandidate {
  readonly sessionLoss: unknown;
  readonly reason?: string;
}

/** Internal safety net. Evaluation performs the authoritative session-loss recheck. */
export function normalizeThrown(
  error: unknown,
  where: "source" | "policy",
  site: string,
  secrets: readonly string[],
  options?: { exposeRawCause?: boolean },
): AuthFailure | SessionLossCandidate {
  if (isAuthFailure(error)) {
    return error;
  }
  if (isInfrastructureError(error) || isConfigurationError(error)) {
    throw error;
  }
  const status = sdkStatus(error);
  const reason = sdkReason(error);
  if (status === 429) {
    return AuthFailures.fromAPIError(error)!;
  }
  if (
    status === 401 &&
    where === "policy" &&
    (reason === undefined || reason === "UNAUTHORIZED")
  ) {
    return { sessionLoss: error, reason };
  }
  if (status === 401 || status === 403) {
    return where === "source"
      ? AuthFailures.fromAPIError(error)!
      : AuthFailures.forbidden(reason ?? "FORBIDDEN");
  }
  if (status !== undefined && status < 500) {
    throw BetterAuthConfigurationError.atRequest(
      "BETTER_AUTH_REJECTED_CALL",
      `better-auth rejected the library's call (${status} ${reason})`,
      { site },
    );
  }
  throw createInfrastructureError(error, {
    secrets,
    exposeRawCause: options?.exposeRawCause,
  });
}
