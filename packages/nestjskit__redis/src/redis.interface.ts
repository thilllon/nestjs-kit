export interface RedisModuleOptions<TClient = unknown> {
  /** Creates the client; bootstrap waits for the returned promise. */
  connect(): TClient | Promise<TClient>;

  /** Closes the client during application shutdown. */
  disconnect(client: TClient): unknown;
}

export interface RedisModuleExtras {
  alias: string;
  isGlobal: boolean;
}
