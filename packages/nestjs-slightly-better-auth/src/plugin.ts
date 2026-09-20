import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import {
  createAuthMiddleware,
  setShouldSkipSessionRefresh,
} from "better-auth/api";
import { parseCookies } from "better-auth/cookies";
import type { NestjsPluginOptions } from "./auth-contracts.js";
import {
  BRIDGE_HANDLE,
  type BridgeBinding,
  type BridgeHandle,
  type ScopeView,
} from "./bridge-protocol.js";
import { createDatabaseDispatchers } from "./database-hook-dispatcher.js";
import { runAfter, runBefore } from "./hook-dispatcher.js";

export type { NestjsPluginOptions } from "./auth-contracts.js";
export const NESTJS_PLUGIN_ID = "nestjs-slightly-better-auth";

const isRouter = (ctx: object): boolean =>
  "_flag" in ctx && ctx._flag === "router";
const separator = "\u0000";

function sessionToken(
  headers: Headers | undefined,
  ctx: HookEndpointContext,
): string {
  return (
    parseCookies(headers?.get("cookie") ?? "").get(
      ctx.context.authCookies.sessionToken.name,
    ) ?? ""
  );
}

function credential(
  headers: Headers | undefined,
  ctx: HookEndpointContext,
  extra: readonly string[],
): string {
  return [
    sessionToken(headers, ctx),
    headers?.get("authorization") ?? "",
    ...extra.map((name) => headers?.get(name) ?? ""),
  ].join(separator);
}

function sameCredential(
  ctx: HookEndpointContext,
  scope: ScopeView,
  extra: readonly string[],
): boolean {
  const call = credential(ctx.headers, ctx, extra);
  return (
    call === separator.repeat(extra.length + 1) ||
    call === credential(scope.inbound?.(), ctx, extra)
  );
}

/** Pure construction-time Better Auth plugin; the Nest kernel binds through a global symbol. */
export function nestjs(
  options: NestjsPluginOptions = {},
): BetterAuthPlugin & { id: typeof NESTJS_PLUGIN_ID } {
  let binding: BridgeBinding | null = null;
  let registration: ReturnType<BridgeHandle["bind"]> | undefined;
  let unboundDispatches = 0;
  const endpointResults = new WeakSet<object>();
  const afterMatcherErrors = new WeakMap<object, unknown>();
  const scope = () => binding?.current();
  const clientIpHeader =
    options.clientIpHeader === false
      ? null
      : (options.clientIpHeader ??
        `x-nsba-ip-${globalThis.crypto.randomUUID().replaceAll("-", "")}`);
  const handle: BridgeHandle = {
    protocol: 4,
    clientIpHeader,
    get state() {
      return binding === null
        ? "unbound"
        : binding.state === "closed"
          ? "closed"
          : "bound";
    },
    get unboundDispatches() {
      return unboundDispatches;
    },
    bind(next) {
      if (binding && binding.instance !== next.instance) {
        throw new Error(
          `PLUGIN_SHARED_BETWEEN_INSTANCES: '${binding.instance}' and '${next.instance}'`,
        );
      }
      if (binding?.owner === next.owner && registration) {
        return registration;
      }
      if (binding?.state === "bootstrapped") {
        throw new Error(
          `INSTANCE_ALREADY_BOUND: bound to ${binding.owner.description}`,
        );
      }
      const tookOverFrom =
        binding?.state === "initialized"
          ? binding.owner.description
          : undefined;
      binding = next;
      unboundDispatches = 0;
      registration = {
        tookOverFrom,
        close: () => {
          next.state = "closed";
        },
      };
      return registration;
    },
    producedByEndpoint(value) {
      return (
        typeof value === "object" &&
        value !== null &&
        endpointResults.has(value)
      );
    },
  };
  const plugin = {
    id: NESTJS_PLUGIN_ID,
    [BRIDGE_HANDLE]: handle,
    init: () => ({
      options: {
        databaseHooks: createDatabaseDispatchers(
          () => binding,
          () => {
            unboundDispatches++;
          },
        ),
        ...(clientIpHeader
          ? { advanced: { ipAddress: { ipAddressHeaders: [clientIpHeader] } } }
          : {}),
      },
    }),
    hooks: {
      before: [
        {
          matcher: (ctx) => {
            if (!binding) {
              unboundDispatches++;
              return false;
            }
            return !isRouter(ctx) && scope()?.cookies === null;
          },
          handler: createAuthMiddleware(async () => {
            await setShouldSkipSessionRefresh(true);
          }),
        },
        {
          matcher: (ctx) => {
            if (!binding || isRouter(ctx)) {
              return false;
            }
            const current = scope();
            if (!current || current.internal) {
              return false;
            }
            // Access capabilities before testing credentials: extraction errors
            // must fail even a credential-free direct endpoint call.
            const check = current.checkCallerSession;
            const inbound = current.inbound?.();
            const browser = current.browserHeaders?.();
            const token = sessionToken(ctx.headers, ctx);
            return (
              !!check &&
              token !== "" &&
              (token === sessionToken(inbound, ctx) ||
                token === sessionToken(browser, ctx))
            );
          },
          handler: createAuthMiddleware(async (ctx) => {
            scope()?.checkCallerSession?.(ctx.path, binding!.instance);
          }),
        },
        {
          matcher: () => binding !== null && binding.before.length > 0,
          handler: createAuthMiddleware((ctx) =>
            runBefore(binding!, ctx, scope()),
          ),
        },
      ],
      after: [
        {
          matcher: () => binding !== null && binding.after.length > 0,
          handler: createAuthMiddleware((ctx) =>
            runAfter(binding!, ctx, scope(), (error) => {
              afterMatcherErrors.set(ctx.context, error);
            }),
          ),
        },
        {
          matcher: (ctx) => {
            // Each endpoint dispatch owns this shared context, including nested
            // calls. Rethrow outside the SDK's recoverable handler-error catch.
            if (afterMatcherErrors.has(ctx.context)) {
              const error = afterMatcherErrors.get(ctx.context);
              afterMatcherErrors.delete(ctx.context);
              throw error;
            }
            return binding !== null && !isRouter(ctx);
          },
          handler: createAuthMiddleware(async (ctx) => {
            const value = ctx.context.returned;
            if (typeof value === "object" && value !== null) {
              endpointResults.add(value);
            }
          }),
        },
        {
          matcher: (ctx) => {
            if (isRouter(ctx)) {
              return false;
            }
            const current = scope();
            return !!current?.cookies && current.forward !== "none";
          },
          handler: createAuthMiddleware(async (ctx) => {
            const current = scope()!;
            if (
              current.forward === "same-credential" &&
              !sameCredential(ctx, current, binding!.credentialHeaders)
            ) {
              binding!.onDropped(ctx.path);
              return;
            }
            const cookies = ctx.context.responseHeaders?.getSetCookie() ?? [];
            if (cookies.length) {
              current.cookies!.append(cookies);
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin & { [BRIDGE_HANDLE]: BridgeHandle };
  return plugin;
}
