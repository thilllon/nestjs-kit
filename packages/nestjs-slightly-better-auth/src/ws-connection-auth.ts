import { Inject } from "@nestjs/common";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host.js";
import type { PrincipalResolver, PrincipalResult } from "./auth-contracts.js";
import {
  AuthFailures,
  BetterAuthConfigurationError,
  type AuthFailure,
} from "./auth-errors.js";
import {
  INSTANCE_REGISTRY,
  PRINCIPAL_RESOLVER,
  TRANSPORT_REGISTRY,
} from "./auth-tokens.js";
import type { InstanceLookup } from "./instance-registry.js";
import type { TransportRegistry } from "./transport-registry.js";

export const WS_CONNECTION_AUTH: unique symbol = Symbol.for(
  "nestjs-slightly-better-auth:ws-connection-auth",
);
export function wsCloseCodeFor(failure: AuthFailure): 4401 | 4403 | 4429 {
  return failure.status === 401 ? 4401 : failure.status === 403 ? 4403 : 4429;
}
/** Connection authentication delegates to the same origin and principal kernel as messages. */
export class WsConnectionAuth {
  constructor(
    @Inject(INSTANCE_REGISTRY) private readonly instances: InstanceLookup,
    @Inject(PRINCIPAL_RESOLVER) private readonly resolver: PrincipalResolver,
    @Inject(TRANSPORT_REGISTRY) private readonly transports: TransportRegistry,
  ) {}

  async authenticate(
    client: unknown,
    options: { instance?: string } = {},
  ): Promise<PrincipalResult> {
    if (typeof client !== "object" || client === null) {
      throw BetterAuthConfigurationError.atRequest(
        "INVALID_WS_CLIENT",
        "Connection authentication requires a WebSocket client.",
      );
    }
    const context = new ExecutionContextHost([client, undefined]);
    context.setType("ws");
    const transport = this.transports.select(context);
    const call = this.transports.describe(context, transport);
    const entry = this.instances.get(options.instance ?? "default");
    const browser = call.browser;
    if (browser && entry.options.originCheck?.mode !== "off") {
      const failure = await entry.handle.checkOrigin(browser, "cookie");
      if (failure) {
        return { outcome: "rejected", failure };
      }
    }
    const accepts = new Set(
      entry.sources
        .filter((source) => source.acceptance === "default")
        .flatMap((source) => [...source.kinds]),
    );
    return this.resolver.resolve(call, {
      auth: entry.handle,
      accepts,
      sourceSet: JSON.stringify(
        entry.sources.flatMap((source, index) =>
          source.kinds.some((kind) => accepts.has(kind)) ? [index] : [],
        ),
      ),
      freshness:
        entry.options.session !== false &&
        entry.options.session?.freshness === "authoritative"
          ? "authoritative"
          : "default",
    });
  }

  socketIoMiddleware(
    options: { required?: boolean; instance?: string } = {},
  ): (socket: unknown, next: (error?: Error) => void) => void {
    return (socket, next) => {
      void this.authenticate(socket, options).then(
        (result) => {
          const failure =
            result.outcome === "rejected"
              ? result.failure
              : result.outcome === "absent" && options.required
                ? AuthFailures.unauthenticated()
                : undefined;
          if (!failure) {
            next();
            return;
          }
          next(
            Object.assign(new Error(failure.message), {
              data: {
                status: "error",
                statusCode: failure.status,
                code: failure.code,
                ...(failure.reason ? { reason: failure.reason } : {}),
                message: failure.message,
              },
            }),
          );
        },
        () => {
          next(
            Object.assign(new Error("Internal server error"), {
              data: {
                status: "error",
                statusCode: 500,
                message: "Internal server error",
              },
            }),
          );
        },
      );
    };
  }
}
