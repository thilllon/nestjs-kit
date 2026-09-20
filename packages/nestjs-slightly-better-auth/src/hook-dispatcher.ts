import type { HookEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { createDefu } from "defu";
import type { BridgeBinding, ScopeView } from "./bridge-protocol.js";

const API_ERROR_HEADERS = Symbol.for("better-call:api-error-headers");
const mergeContext = createDefu((object, key, value) => {
  if (Array.isArray(object[key]) && Array.isArray(value)) {
    object[key] = value;
    return true;
  }
});

function mergeHeaders(
  target: Headers,
  source: Headers | null | undefined,
): void {
  source?.forEach((value, key) => {
    if (key === "set-cookie") {
      target.append(key, value);
    } else {
      target.set(key, value);
    }
  });
}

function errorHeaders(error: APIError): Headers | undefined {
  const attached = (error as unknown as Record<symbol, Headers | undefined>)[
    API_ERROR_HEADERS
  ];
  if (!attached && !error.headers) {
    return undefined;
  }
  const headers = new Headers(attached);
  if (error.headers && error.headers !== attached) {
    mergeHeaders(headers, new Headers(error.headers));
  }
  return headers;
}

/** Run each method through the SDK middleware so its cookie/header state is isolated. */
export async function runBefore(
  binding: BridgeBinding,
  ctx: HookEndpointContext,
  scope: ScopeView | undefined,
): Promise<unknown> {
  let accumulated: Record<string, unknown> = {};
  for (const hook of binding.before) {
    let matched: boolean;
    try {
      matched = hook.matches(ctx, scope);
    } catch (error) {
      ctx.context.logger.error(
        "An error occurred during Nest hook matcher execution:",
        error,
      );
      throw new APIError("INTERNAL_SERVER_ERROR", {
        message:
          "An error occurred during hook matcher execution. Check the logs for more details.",
      });
    }
    if (!matched) {
      continue;
    }
    let result: { response: unknown; headers: Headers };
    try {
      result = (await createAuthMiddleware(hook.run)({
        ...ctx,
        returnHeaders: true,
      })) as { response: unknown; headers: Headers };
    } catch (error) {
      if (isAPIError(error)) {
        // The enclosing SDK middleware reattaches its own header object. Keep
        // the throwing method's headers, including non-enumerable cookie state.
        ctx.responseHeaders =
          (error as unknown as Record<symbol, Headers | undefined>)[
            API_ERROR_HEADERS
          ] ?? new Headers();
      }
      throw error;
    }
    ctx.context.responseHeaders ??= new Headers();
    mergeHeaders(ctx.context.responseHeaders, result.headers);
    const value = result.response;
    if (value && typeof value === "object") {
      if ("context" in value && typeof value.context === "object") {
        const { headers, ...rest } = value.context as Record<string, unknown>;
        if (headers instanceof Headers) {
          const requestHeaders =
            accumulated.headers instanceof Headers
              ? accumulated.headers
              : new Headers();
          headers.forEach((header, key) => {
            requestHeaders.set(key, header);
          });
          accumulated.headers = requestHeaders;
        }
        accumulated = mergeContext(rest, accumulated);
      } else {
        return value;
      }
    }
  }
  return Object.keys(accumulated).length ? { context: accumulated } : undefined;
}

export async function runAfter(
  binding: BridgeBinding,
  ctx: HookEndpointContext,
  scope: ScopeView | undefined,
): Promise<unknown> {
  for (const hook of binding.after) {
    if (!hook.matches(ctx, scope)) {
      continue;
    }
    let result: { response: unknown; headers?: Headers | null };
    try {
      result = (await createAuthMiddleware(hook.run)({
        ...ctx,
        returnHeaders: true,
      })) as { response: unknown; headers: Headers };
    } catch (error) {
      if (!isAPIError(error)) {
        throw error;
      }
      result = { response: error, headers: errorHeaders(error) };
    }
    if (result.headers) {
      ctx.context.responseHeaders ??= new Headers();
      mergeHeaders(ctx.context.responseHeaders, result.headers);
    }
    if (result.response !== undefined) {
      ctx.context.returned = result.response;
    }
  }
  return ctx.context.returned;
}
