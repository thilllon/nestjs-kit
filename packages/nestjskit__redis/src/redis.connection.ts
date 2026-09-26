import type { OnApplicationShutdown } from "@nestjs/common";
import type { RedisModuleOptions } from "./redis.interface";

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
  if (client == null) {
    throw new TypeError(
      `Redis registration "${alias}" connect() returned no client.`,
    );
  }
  return client;
}

export class RedisConnection<TClient> implements OnApplicationShutdown {
  private closing?: Promise<void>;

  constructor(
    private readonly client: TClient,
    private readonly options: RedisModuleOptions<TClient>,
  ) {}

  onApplicationShutdown(): Promise<void> {
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
