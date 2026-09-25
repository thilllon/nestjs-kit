import { createClient, type Client } from "graphql-ws";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Opens a graphql-ws client for a GraphQL WebSocket URL, such as
 * `ws://localhost:3000/graphql`. The session token travels once, as
 * `authorization` in the connection_init payload. The transport applies it to
 * every operation on the connection and authenticates each one separately.
 *
 * A token is sent only over `wss://` or to a loopback host, because `ws://`
 * exposes it to every network hop.
 */
export function connect(url: string, token?: string): Client {
  const { protocol, hostname } = new URL(url);
  if (token && protocol !== "wss:" && !LOOPBACK_HOSTS.has(hostname)) {
    throw new Error(
      `Refusing to send a session token over ${protocol}// to ${hostname}; use wss://`,
    );
  }
  return createClient({
    url,
    // Without a token, connection_init carries no payload, and operations use
    // the upgrade request's credentials, such as a browser's session cookie.
    ...(token
      ? { connectionParams: { authorization: `Bearer ${token}` } }
      : {}),
    // Report a closed connection instead of reconnecting with the same token.
    retryAttempts: 0,
  });
}
