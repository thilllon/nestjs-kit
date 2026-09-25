import { Strategy } from "./strategy.decorator";
import { getStrategyRegistryToken } from "./strategy.tokens";

/** A strategy group whose keys are declared once as literal types. */
export interface StrategyGroup<K extends string = string> {
  /** Group name, also used by `getStrategyRegistryToken(name)`. */
  readonly name: string;
  /** Declared keys in declaration order. */
  readonly keys: readonly K[];
  /** Injection token of the group's `StrategyRegistry`. */
  readonly token: string;
  /** `@Strategy(key)` limited to the declared keys. */
  Strategy(key: K): ClassDecorator;
}

/** Union of the keys a strategy group declares. */
export type StrategyKeyOf<G extends StrategyGroup> =
  G extends StrategyGroup<infer K> ? K : never;

/**
 * Declares a strategy group and its keys. The keys are inferred as literal
 * types, so `group.Strategy(key)`, `defaultKey` and the injected
 * `StrategyRegistry<T, StrategyKeyOf<typeof group>>` accept only these keys.
 */
export function defineStrategyGroup<const K extends string>(
  name: string,
  keys: readonly [K, ...K[]],
): StrategyGroup<K> {
  if (typeof name !== "string" || name === "") {
    throw new Error("defineStrategyGroup() requires a non-empty name");
  }
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error(`Strategy group "${name}" declares no keys`);
  }
  const declared = new Set<string>();
  for (const key of keys) {
    if (typeof key !== "string" || key === "") {
      throw new Error(`Strategy group "${name}" declares an empty key`);
    }
    if (declared.has(key)) {
      throw new Error(
        `Strategy group "${name}" declares the key "${key}" more than once`,
      );
    }
    declared.add(key);
  }
  const frozenKeys = Object.freeze([...keys]);
  return Object.freeze({
    name,
    keys: frozenKeys,
    token: getStrategyRegistryToken(name),
    Strategy(key: K): ClassDecorator {
      if (!declared.has(key)) {
        throw new Error(
          `Strategy group "${name}" declares no key "${key}"; declared keys: ${quoted(frozenKeys)}`,
        );
      }
      return Strategy(key);
    },
  });
}

/** Formats keys the way registry and module errors list them. */
export function quoted(keys: Iterable<string>): string {
  return [...keys].map((key) => `"${key}"`).join(", ");
}
