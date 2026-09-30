import { io, type Socket } from "socket.io-client";

/** The failure payload of a rejected handshake or message. */
export interface GatewayFailure {
  status?: string;
  statusCode?: number;
  code?: string;
  reason?: string;
  message?: string;
}

export type GatewayError = Error & { data?: GatewayFailure };

const TIMEOUT_MS = 5000;

/**
 * Connects to a Socket.IO namespace URL, such as `http://localhost:3000/admin`,
 * and resolves once the server accepts the handshake. A rejected handshake
 * rejects with the server's `connect_error`, whose `data` holds the failure.
 */
export async function connect(url: string, token?: string): Promise<Socket> {
  const socket = io(url, {
    transports: ["websocket"],
    // The transport turns a string auth.token into a bearer credential.
    auth: token ? { token } : {},
    forceNew: true,
    reconnection: false,
    timeout: TIMEOUT_MS,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const connected = () => {
        socket.off("connect_error", failed);
        resolve();
      };
      const failed = (error: Error) => {
        socket.off("connect", connected);
        reject(error);
      };
      socket.once("connect", connected);
      socket.once("connect_error", failed);
    });
    return socket;
  } catch (error) {
    socket.close();
    throw error;
  }
}

/**
 * Emits an event and resolves with the gateway's acknowledgement. Nest reports
 * a failed message through a separate `exception` event instead, which rejects
 * with an error whose `data` holds the failure. The event carries no request
 * identifier, so keep one request in flight per socket.
 */
export function request<T = unknown>(
  socket: Socket,
  event: string,
  data: unknown = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const settle = () => {
      clearTimeout(timer);
      socket.off("exception", failed);
    };
    const failed = (failure: GatewayFailure) => {
      settle();
      reject(
        Object.assign(new Error(failure.message ?? `${event} failed`), {
          data: failure,
        }),
      );
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error(`No reply to ${event} within ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    socket.once("exception", failed);
    socket.emit(event, data, (reply: T) => {
      settle();
      resolve(reply);
    });
  });
}
