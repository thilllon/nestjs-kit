import type { OnApplicationShutdown } from "@nestjs/common";
import type { ModulesContainer } from "@nestjs/core";
import type { RedisModuleOptions } from "./redis.interface";

/** Provider token whose value is the alias of each registration module. */
export const REDIS_REGISTRATION = Symbol("REDIS_REGISTRATION");

interface PendingClient {
  /** Disconnects the client once connect() produced it. */
  close?: () => unknown;
  /** The error of another registration that failed while this one connected. */
  aborted?: { error: unknown };
}

// A failed registration disconnects the pending clients of its application:
// those connected or connecting since every registration last settled. The
// clients of a running application therefore stay connected when a lazily
// loaded registration fails.
interface ApplicationClients {
  /** Aliases whose connect() finished or failed. */
  readonly settled: Set<string>;
  readonly pending: Set<PendingClient>;
}

const applications = new WeakMap<ModulesContainer, ApplicationClients>();

// Clients created by a registration's connect(). A client that replaces the
// provider, such as a test double, is not disconnected by the registration.
const connectedClients = new WeakSet<object>();

function registeredAliases(modules: ModulesContainer): string[] {
  const aliases: string[] = [];
  for (const moduleRef of modules.values()) {
    const alias = moduleRef.providers.get(REDIS_REGISTRATION)?.instance;
    if (typeof alias === "string") {
      aliases.push(alias);
    }
  }
  return aliases;
}

function assertDistinctAliases(aliases: string[]): void {
  const seen = new Set<string>();
  for (const alias of aliases) {
    if (seen.has(alias)) {
      throw new Error(
        `Redis alias "${alias}" is registered by more than one RedisModule. Use distinct aliases, or import one registration module wherever the client is shared.`,
      );
    }
    seen.add(alias);
  }
}

function applicationClients(modules: ModulesContainer): ApplicationClients {
  let clients = applications.get(modules);
  if (!clients) {
    clients = { settled: new Set(), pending: new Set() };
    applications.set(modules, clients);
  }
  return clients;
}

// Runs each disconnect, best effort, and ignores its failure.
async function disconnectAll(closers: Array<() => unknown>): Promise<void> {
  await Promise.allSettled(closers.map(async (close) => close()));
}

// Disconnects the pending clients of the application and makes the
// registrations still connecting disconnect their clients when they finish.
async function abortPending(
  clients: ApplicationClients,
  error: unknown,
): Promise<void> {
  const pending = [...clients.pending];
  clients.pending.clear();
  for (const client of pending) {
    client.aborted = { error };
  }
  await disconnectAll(pending.flatMap(({ close }) => (close ? [close] : [])));
}

export async function connectRedisClient<TClient>(
  options: RedisModuleOptions<TClient>,
  alias: string,
  modules: ModulesContainer,
): Promise<TClient> {
  const clients = applicationClients(modules);
  const pending: PendingClient = {};
  try {
    if (
      typeof options?.connect !== "function" ||
      typeof options.disconnect !== "function"
    ) {
      throw new TypeError(
        `Redis registration "${alias}" requires connect and disconnect functions.`,
      );
    }
    assertDistinctAliases(registeredAliases(modules));
    clients.pending.add(pending);
    const client = await options.connect();
    if (
      client === null ||
      (typeof client !== "object" && typeof client !== "function")
    ) {
      throw new TypeError(
        `Redis registration "${alias}" connect() returned no client.`,
      );
    }
    if (pending.aborted) {
      await disconnectAll([() => options.disconnect(client)]);
      throw pending.aborted.error;
    }
    pending.close = () => {
      connectedClients.delete(client);
      return options.disconnect(client);
    };
    connectedClients.add(client);
    clients.settled.add(alias);
    if (registeredAliases(modules).every((name) => clients.settled.has(name))) {
      clients.pending.clear();
    }
    return client;
  } catch (error) {
    clients.settled.add(alias);
    clients.pending.delete(pending);
    if (!pending.aborted) {
      await abortPending(clients, error);
    }
    throw error;
  }
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
