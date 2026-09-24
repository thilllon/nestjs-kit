import type { IncomingHttpHeaders } from "node:http";
import type { AuthTransport, ExtensionDefinition } from "./auth-contracts.js";
import { UPGRADE_REQUEST } from "./bridge-protocol.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import { toWebHeaders, upgradeRequestUrl } from "./platform.js";
import {
  isSocketIo,
  mappedCredentialHeaders,
  principalTtl,
  quotaAdvice,
  transportDefinition,
  validateGateways,
  wsException,
  type WsTransportOptions,
} from "./socket-io-transport.js";

export { UPGRADE_REQUEST } from "./bridge-protocol.js";
export interface WsClientLike {
  readonly [UPGRADE_REQUEST]?: {
    readonly headers: Headers;
    readonly url?: string;
    readonly remoteAddress?: string;
    readonly encrypted?: boolean;
  };
}
export interface WsAdapterLike {
  bindClientConnect(
    server: unknown,
    callback: (...args: any[]) => void,
  ): unknown;
}
export function recordUpgradeRequest(
  client: object,
  request: {
    headers: IncomingHttpHeaders;
    url?: string;
    socket?: { remoteAddress?: string; encrypted?: boolean };
  },
): void {
  Object.defineProperty(client, UPGRADE_REQUEST, {
    value: Object.freeze({
      headers: toWebHeaders(request.headers),
      url: request.url,
      remoteAddress: request.socket?.remoteAddress,
      encrypted: request.socket?.encrypted,
    }),
    configurable: true,
  });
}
export function withUpgradeRequest<
  T extends new (
    ...args: any[]
  ) => WsAdapterLike,
>(Base: T): T {
  return class extends Base {
    override bindClientConnect(
      server: unknown,
      callback: (...args: any[]) => void,
    ): unknown {
      return super.bindClientConnect(server, (client, request, ...rest) => {
        recordUpgradeRequest(client, request);
        callback(client, request, ...rest);
      });
    }
  };
}
export function wsTransport(
  options: WsTransportOptions<WsClientLike> = {},
): ExtensionDefinition<AuthTransport> {
  const ttl = principalTtl(options.principalTtlMs);
  return transportDefinition({
    id: "ws",
    handles: (context) =>
      context.getType() === "ws" &&
      !isSocketIo(context.switchToWs().getClient()),
    describe(context) {
      const client = context.switchToWs().getClient<WsClientLike>();
      const upgrade = () => {
        const request = client[UPGRADE_REQUEST];
        if (!request) {
          throw BetterAuthConfigurationError.atRequest(
            "WS_UPGRADE_REQUEST_MISSING",
            "WebSocket authentication requires its upgrade request.",
            {
              hint: "app.useWebSocketAdapter(new (withUpgradeRequest(WsAdapter))(app));",
            },
          );
        }
        return request;
      };
      const url = () => {
        const request = upgrade();
        return upgradeRequestUrl({
          headers: request.headers,
          url: request.url,
          secure: request.encrypted,
        });
      };
      return {
        key: context.getArgs(),
        invocation: context.getArgs(),
        connection: client,
        principalTtlMs: ttl,
        headers: () => {
          const headers = new Headers(upgrade().headers);
          mappedCredentialHeaders(options.credentials?.(client)).forEach(
            (value, name) => {
              headers.set(name, value);
            },
          );
          return headers;
        },
        get clientIp() {
          return upgrade().remoteAddress ?? null;
        },
        cookies: null,
        get request() {
          return { method: "GET", url: url() };
        },
        param: (name) => context.switchToWs().getData()?.[name],
        get browser() {
          return {
            enforce: true,
            key: client,
            headers: () => new Headers(upgrade().headers),
            url: url(),
          };
        },
      };
    },
    toException: wsException,
    validate: (context) => validateGateways(context, options.gatewayCoverage),
    advise: (context) => quotaAdvice(context, ttl),
  });
}
