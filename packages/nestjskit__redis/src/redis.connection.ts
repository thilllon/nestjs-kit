import type { OnApplicationShutdown } from "@nestjs/common";
import type { ModulesContainer } from "@nestjs/core";
import type { RedisModuleOptions } from "./redis.interface";

/** Provider token whose value is the alias of each registration module. */
export const REDIS_REGISTRATION = Symbol("REDIS_REGISTRATION");

type HostModule = Parameters<ModulesContainer["set"]>[1];

interface PendingClient {
  /** Disconnects the client once connect() produced it. */
  close?: () => unknown;
  /** The error of another registration that failed while this one connected. */
  aborted?: { error: unknown };
}

// A failed bootstrap runs no shutdown hooks, so the first failed bootstrap
// registration disconnects the clients of the other bootstrap registrations
// and stops those that have not connected yet. Registrations of lazily loaded
// modules connect independently: Nest does not tell providers which lazy load
// instantiates them, so a failure cannot be scoped to one load.
interface Bootstrap {
  /** Aliases of the registrations that the application bootstrap instantiates. */
  readonly aliases: ReadonlySet<string>;
  readonly pending: Set<PendingClient>;
  failure?: { error: unknown };
}

const bootstraps = new WeakMap<ModulesContainer, Bootstrap>();

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

// Nest registers its internal core module first and the root module second.
// Bootstrap instantiates the modules reachable from the root; lazily loaded
// modules are not imported by any of them.
function bootstrapOf(modules: ModulesContainer): Bootstrap {
  let bootstrap = bootstraps.get(modules);
  if (!bootstrap) {
    const [, root] = modules.values();
    const reachable = new Set(root ? [root] : []);
    for (const moduleRef of reachable) {
      for (const imported of moduleRef.imports) {
        reachable.add(imported);
      }
    }
    bootstrap = {
      aliases: new Set([...reachable].flatMap((ref) => aliasOf(ref) ?? [])),
      pending: new Set(),
    };
    bootstraps.set(modules, bootstrap);
  }
  return bootstrap;
}

// Runs each disconnect, best effort, and ignores its failure.
async function disconnectAll(closers: Array<() => unknown>): Promise<void> {
  await Promise.allSettled(closers.map(async (close) => close()));
}

// Records the failure, disconnects the connected bootstrap clients and makes
// the registrations still connecting disconnect their clients when they finish.
async function abortBootstrap(
  bootstrap: Bootstrap,
  error: unknown,
): Promise<void> {
  bootstrap.failure = { error };
  const pending = [...bootstrap.pending];
  bootstrap.pending.clear();
  for (const client of pending) {
    client.aborted = { error };
  }
  await disconnectAll(pending.flatMap(({ close }) => (close ? [close] : [])));
}

async function connect<TClient>(
  options: RedisModuleOptions<TClient>,
  alias: string,
): Promise<TClient & object> {
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
  return client;
}

export async function connectRedisClient<TClient>(
  options: RedisModuleOptions<TClient>,
  alias: string,
  modules: ModulesContainer,
): Promise<TClient> {
  assertDistinctAliases(modules);
  const bootstrap = bootstrapOf(modules);
  if (!bootstrap.aliases.has(alias)) {
    const client = await connect(options, alias);
    connectedClients.add(client);
    return client;
  }
  if (bootstrap.failure) {
    throw bootstrap.failure.error;
  }
  const pending: PendingClient = {};
  bootstrap.pending.add(pending);
  try {
    const client = await connect(options, alias);
    if (pending.aborted) {
      await disconnectAll([() => options.disconnect(client)]);
      throw pending.aborted.error;
    }
    pending.close = () => {
      connectedClients.delete(client);
      return options.disconnect(client);
    };
    connectedClients.add(client);
    return client;
  } catch (error) {
    bootstrap.pending.delete(pending);
    if (!pending.aborted) {
      await abortBootstrap(bootstrap, error);
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
