import type { Type } from "@nestjs/common";

// A registered symbol is shared by the CJS and ESM builds of this package.
const STRATEGY_KEY = Symbol.for("nestjs-strategy.key");

/**
 * Names a provider class as the strategy selected by `key` within the
 * strategy groups that register it.
 */
export function Strategy(key: string): ClassDecorator {
  if (typeof key !== "string" || key === "") {
    throw new Error("@Strategy() requires a non-empty key");
  }
  return (target) => {
    Object.defineProperty(target, STRATEGY_KEY, {
      value: key,
      configurable: true,
    });
  };
}

/**
 * Returns the key a class declares with `@Strategy()`. Keys are not
 * inherited: a subclass selects a strategy only through its own decorator.
 */
export function getStrategyKey(target: Type): string | undefined {
  const value: unknown = Object.getOwnPropertyDescriptor(
    target,
    STRATEGY_KEY,
  )?.value;
  return typeof value === "string" ? value : undefined;
}
