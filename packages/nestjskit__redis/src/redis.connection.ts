import type { OnApplicationShutdown } from "@nestjs/common";
import type { ModulesContainer } from "@nestjs/core";
import type { RedisModuleOptions } from "./redis.interface";

/** Provider token whose value is the alias of each registration module. */
export const REDIS_REGISTRATION = Symbol("REDIS_REGISTRATION");

type HostModule = Parameters<ModulesContainer["set"]>[1];

// Clients created by a registration's connect(). A client that replaces the
// provider, such as a test double, is not disconnected by the registration.
const connectedClients = new WeakSet<object>();

function aliasOf(moduleRef: HostModule): string | undefined {
  const alias = moduleRef.providers.get(REDIS_REGISTRATION)?.instance;
  return typeof alias === "string" ? alias : undefined;
}

function assertDistinctAliases(modules: ModulesContainer): void {
  const seen = new Set<string>();
  for (const moduleRef of modules.values()) {
    const alias = aliasOf(moduleRef);
    if (alias === undefined) {
      continue;
    }
    if (seen.has(alias)) {
      throw new Error(
        `Redis alias "${alias}" is registered by more than one RedisModule. Use distinct aliases, or import one registration module wherever the client is shared.`,
      );
    }
    seen.add(alias);
  }
}

// Checks every registered alias before connecting, so a duplicate alias fails
// bootstrap before any registration opens a client.
export async function connectRedisClient<TClient>(
  options: RedisModuleOptions<TClient>,
  alias: string,
  modules: ModulesContainer,
): Promise<TClient> {
  assertDistinctAliases(modules);
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
