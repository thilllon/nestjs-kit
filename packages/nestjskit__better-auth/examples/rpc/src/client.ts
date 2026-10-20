import {
  type ClientProxy,
  ClientProxyFactory,
  Transport,
} from "@nestjs/microservices";
import { firstValueFrom, timeout } from "rxjs";
import type { RpcAddress } from "./create-app.js";

/** The failure payload of a rejected message. */
export interface RpcFailure {
  status?: string;
  statusCode?: number;
  code?: string;
  reason?: string;
  message?: string;
}

export function createClient(address: RpcAddress): ClientProxy {
  return ClientProxyFactory.create({
    transport: Transport.TCP,
    options: address,
  });
}

/**
 * Sends a message and resolves with the handler's reply. TCP messages have no
 * headers, so the session token travels in the payload's `auth` envelope field.
 * A rejected message rejects with its failure payload.
 */
export function send<T = unknown>(
  client: ClientProxy,
  pattern: string,
  token?: string,
): Promise<T> {
  const payload = token ? { auth: { authorization: `Bearer ${token}` } } : {};
  return firstValueFrom(client.send<T>(pattern, payload).pipe(timeout(5000)));
}
