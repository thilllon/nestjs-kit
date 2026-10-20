import type { IncomingHttpHeaders } from "node:http";
import type { ExecutionContext } from "@nestjs/common";
import { MetadataScanner } from "@nestjs/core";
import {
  SubscribeMessage,
  WebSocketGateway,
  WsException,
} from "@nestjs/websockets";
import {
  type AuthTransport,
  type BootAdvice,
  type BootAdviceContext,
  type ExtensionDefinition,
  type TransportCall,
  type TransportValidationContext,
} from "./auth-contracts.js";
import {
  AuthFailures,
  BetterAuthConfigurationError,
  type AuthFailure,
} from "./auth-errors.js";
import { EXTENSION_DEFINITION } from "./bridge-protocol.js";
import { toWebHeaders, upgradeRequestUrl } from "./platform.js";
import { WsConnectionAuth, WS_CONNECTION_AUTH } from "./ws-connection-auth.js";

export interface WsTransportOptions<C> {
  /** Replaces principal credentials without changing the browser handshake used for origin checks. */
  credentials?: (client: C) => HeadersInit | undefined;
  /** Defaults to zero. Positive values delay revocation for non-authoritative messages. */
  principalTtlMs?: number;
  /** Every message handler requires explicit guard and scope coverage on every Nest major. */
  gatewayCoverage?: "error" | "warn" | "off";
}
export interface SocketIoClientLike {
  readonly handshake: {
    readonly headers: IncomingHttpHeaders;
    readonly auth?: Record<string, unknown>;
    readonly address?: string;
    readonly url?: string;
    readonly secure?: boolean;
  };
}
/** Convert only mapped headers here: native Headers errors can quote the credential. */
export function mappedCredentialHeaders(
  input: HeadersInit | undefined,
): Headers {
  const headers = new Headers();
  if (input === undefined) {
    return headers;
  }
  const malformed = () =>
    AuthFailures.rejected({ status: 401, reason: "MALFORMED_CREDENTIALS" });
  if (input === null || typeof input !== "object") {
    throw malformed();
  }
  // Read caller-provided getters/iterators outside the conversion catch so their
  // programming errors remain errors, as do errors thrown by the mapper itself.
  const iterable = (input as { [Symbol.iterator]?: unknown })[Symbol.iterator];
  if (iterable !== undefined && typeof iterable !== "function") {
    throw malformed();
  }
  const entries: Iterable<unknown> =
    typeof iterable === "function"
      ? (input as Iterable<unknown>)
      : Object.entries(input);
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw malformed();
    }
    const [name, value] = entry;
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      /[\r\n\0]/.test(value)
    ) {
      throw malformed();
    }
    try {
      headers.append(name, value);
    } catch {
      throw malformed();
    }
  }
  return headers;
}
export function isSocketIo(client: unknown): client is SocketIoClientLike {
  return typeof client === "object" && client !== null && "handshake" in client;
}
export function wsException(failure: AuthFailure): WsException {
  return new WsException({
    status: "error",
    statusCode: failure.status,
    code: failure.code,
    ...(failure.reason ? { reason: failure.reason } : {}),
    message: failure.message,
  });
}
export function validateGateways(
  context: TransportValidationContext,
  coverage: WsTransportOptions<unknown>["gatewayCoverage"],
): void {
  class Probe {
    message(): void {}
  }
  WebSocketGateway()(Probe);
  SubscribeMessage("probe")(
    Probe.prototype,
    "message",
    Object.getOwnPropertyDescriptor(Probe.prototype, "message")!,
  );
  if (
    Reflect.getMetadata("websockets:is_gateway", Probe) !== true ||
    Reflect.getMetadata(
      "websockets:message_mapping",
      Probe.prototype.message,
    ) !== true
  ) {
    throw new BetterAuthConfigurationError(
      "NEST_METADATA_KEY_CHANGED",
      "Nest WebSocket gateway/message metadata failed its canary.",
    );
  }
  const scanner = new MetadataScanner();
  for (const wrapper of context.discovery.getProviders()) {
    const target = wrapper.metatype;
    if (
      !target?.prototype ||
      wrapper.isAlias ||
      !Reflect.getMetadata("websockets:is_gateway", target)
    ) {
      continue;
    }
    for (const method of scanner.getAllMethodNames(target.prototype)) {
      if (
        Reflect.getMetadata(
          "websockets:message_mapping",
          target.prototype[method],
        )
      ) {
        context.claim(target, method, "explicit", {
          everyHandler: true,
          code: "GATEWAY_UNGUARDED",
          coverage: coverage ?? "error",
          hint: `Add @UseBetterAuth() to ${target.name} (or @Public() to opt out). Global guards and interceptors do not reach gateways on NestJS 11, and this check does not depend on the version.`,
        });
      }
    }
  }
}
export function quotaAdvice(
  context: BootAdviceContext,
  ttl: number,
): readonly BootAdvice[] {
  return ttl === 0 &&
    context.sources.some((source) => source.effects?.consumesQuota)
    ? [
        {
          level: "warn",
          code: "W_QUOTA_PER_MESSAGE",
          message:
            "Quota-consuming WebSocket principals verify on every message.",
          hint: "Consider connection-time authentication and principalTtlMs; a positive TTL delays revocation on non-authoritative handlers.",
        },
      ]
    : [];
}
export function transportDefinition(
  transport: AuthTransport,
): ExtensionDefinition<AuthTransport> {
  return {
    [EXTENSION_DEFINITION]: true,
    use: { useFactory: () => transport },
    providers: [
      WsConnectionAuth,
      { provide: WS_CONNECTION_AUTH, useExisting: WsConnectionAuth },
    ],
    exports: [WsConnectionAuth, WS_CONNECTION_AUTH],
  };
}
export function principalTtl(value = 0): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new BetterAuthConfigurationError(
      "INVALID_WS_TTL",
      "principalTtlMs must be a finite non-negative number.",
    );
  }
  return value;
}
export function socketIoTransport(
  options: WsTransportOptions<SocketIoClientLike> = {},
): ExtensionDefinition<AuthTransport> {
  const ttl = principalTtl(options.principalTtlMs);
  return transportDefinition({
    id: "socket.io",
    handles: (context) =>
      context.getType() === "ws" &&
      isSocketIo(context.switchToWs().getClient()),
    describe(context: ExecutionContext): TransportCall {
      const client = context.switchToWs().getClient<SocketIoClientLike>();
      const original = () => toWebHeaders(client.handshake.headers);
      return {
        key: context.getArgs(),
        invocation: context.getArgs(),
        connection: client,
        principalTtlMs: ttl,
        headers: () => {
          const headers = original();
          let mapped: HeadersInit | undefined;
          if (options.credentials) {
            mapped = options.credentials(client);
          } else if (!headers.has("authorization")) {
            const token = client.handshake.auth?.token;
            if (token !== undefined) {
              if (typeof token !== "string") {
                throw AuthFailures.rejected({
                  status: 401,
                  reason: "MALFORMED_CREDENTIALS",
                });
              }
              mapped = { authorization: `Bearer ${token}` };
            }
          }
          mappedCredentialHeaders(mapped).forEach((value, name) => {
            headers.set(name, value);
          });
          return headers;
        },
        get clientIp() {
          return client.handshake.address ?? null;
        },
        cookies: null,
        get request() {
          return { method: "GET", url: upgradeRequestUrl(client.handshake) };
        },
        param: (name) => context.switchToWs().getData()?.[name],
        get browser() {
          return {
            enforce: true,
            key: client,
            headers: original,
            url: upgradeRequestUrl(client.handshake),
          };
        },
      };
    },
    toException: wsException,
    validate: (context) => validateGateways(context, options.gatewayCoverage),
    advise: (context) => quotaAdvice(context, ttl),
  });
}
