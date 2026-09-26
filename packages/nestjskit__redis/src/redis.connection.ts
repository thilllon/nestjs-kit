import type { OnApplicationShutdown } from "@nestjs/common";
import type { RedisModuleOptions } from "./redis.interface";

// Clients created by a registration's connect(). A client that replaces the
// provider, such as a test double, is not disconnected by the registration.
const connectedClients = new WeakSet<object>();

export async function connectRedisClient<TClient>(
  options: RedisModuleOptions<TClient>,
  alias: string,
): Promise<TClient> {
  if (
    typeof options?.connect !== "function" ||
    typeof options.disconnect !== "function"
  ) {
    throw new TypeError(
      `Redis registration "${alias}" requires connect and disconnect functions.`,
    );
  }
  const client = await options.connect();
  if (
    client === null ||
    (typeof client !== "object" && typeof client !== "function")
  ) {
    throw new TypeError(
      `Redis registration "${alias}" connect() returned no client.`,
    );
  }
  connectedClients.add(client);
  return client;
}

export class RedisConnection<TClient> implements OnApplicationShutdown {
  private closing?: Promise<void>;

  constructor(
    private readonly client: TClient,
    private readonly options: RedisModuleOptions<TClient>,
  ) {}

  onApplicationShutdown(): Promise<void> {
    if (!connectedClients.has(this.client as object)) {
      return Promise.resolve();
    }
    this.closing ??= Promise.resolve()
      .then(() => this.options.disconnect(this.client))
      .then(
        () => undefined,
        (error: unknown) => {
          this.closing = undefined;
          throw error;
        },
      );
    return this.closing;
  }
}
