/** Thrown when a registry has no strategy for the requested key. */
export class UnknownStrategyError extends Error {
  constructor(
    readonly group: string,
    readonly key: string | undefined,
    readonly registeredKeys: readonly string[],
  ) {
    const keys = registeredKeys.map((registered) => `"${registered}"`);
    super(
      key === undefined
        ? `Strategy group "${group}" has no default strategy; pass one of: ${keys.join(", ")}`
        : `Strategy group "${group}" has no strategy "${key}"; registered keys: ${keys.join(", ")}`,
    );
    this.name = "UnknownStrategyError";
  }
}

/** Strategies of one group, keyed by their `@Strategy()` names. */
export class StrategyRegistry<T = unknown>
  implements Iterable<[key: string, strategy: T]>
{
  private readonly strategies: ReadonlyMap<string, T>;

  constructor(
    readonly name: string,
    strategies: Iterable<readonly [key: string, strategy: T]>,
    readonly defaultKey?: string,
  ) {
    const entries = new Map<string, T>();
    for (const [key, strategy] of strategies) {
      if (entries.has(key)) {
        throw new Error(
          `Strategy group "${name}" registers the key "${key}" more than once`,
        );
      }
      entries.set(key, strategy);
    }
    if (defaultKey !== undefined && !entries.has(defaultKey)) {
      throw new Error(
        `Strategy group "${name}" has no strategy for its default key "${defaultKey}"`,
      );
    }
    this.strategies = entries;
  }

  get size(): number {
    return this.strategies.size;
  }

  /**
   * Returns the strategy registered for `key`, or the default strategy when
   * `key` is omitted. Throws `UnknownStrategyError` for an unregistered key.
   */
  get(key?: string): T {
    const selected = key ?? this.defaultKey;
    if (selected !== undefined && this.strategies.has(selected)) {
      return this.strategies.get(selected) as T;
    }
    throw new UnknownStrategyError(this.name, key, this.keys());
  }

  /** Returns the strategy registered for `key`, or `undefined`. */
  find(key: string): T | undefined {
    return this.strategies.get(key);
  }

  has(key: string): boolean {
    return this.strategies.has(key);
  }

  /** Keys in registration order. */
  keys(): string[] {
    return [...this.strategies.keys()];
  }

  values(): T[] {
    return [...this.strategies.values()];
  }

  entries(): [key: string, strategy: T][] {
    return [...this.strategies.entries()];
  }

  [Symbol.iterator](): Iterator<[key: string, strategy: T]> {
    return this.strategies.entries();
  }
}
