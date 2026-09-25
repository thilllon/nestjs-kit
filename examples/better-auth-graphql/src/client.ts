import { createClient, type Client } from "graphql-ws";

/**
 * Opens a graphql-ws client for a GraphQL WebSocket URL, such as
 * `ws://localhost:3000/graphql`. The session token travels once, as
 * `authorization` in the connection_init payload. The transport applies it to
 * every operation on the connection and authenticates each one separately.
 */
export function connect(url: string, token?: string): Client {
  return createClient({
    url,
    // Send an object payload even without a token: the Apollo transport
    // recognizes a graphql-ws operation only when connection_init carries one
    // (#601).
    connectionParams: token ? { authorization: `Bearer ${token}` } : {},
    // Report a closed connection instead of reconnecting with the same token.
    retryAttempts: 0,
  });
}
