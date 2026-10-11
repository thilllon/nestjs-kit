// Helpers shared by the decorators, the compiler, the adapters and the
// interceptors.

import type { Class } from "./types";

export function isObject(
  value: unknown,
): value is Record<PropertyKey, unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof value.then === "function";
}

/** The class and its superclasses, nearest first. */
export function* constructorChain(type: Class): Generator<Class> {
  for (
    let current: unknown = type;
    typeof current === "function" && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    yield current as Class;
  }
}

/** True for a number that orders advisors: any number except `NaN`. */
export function isOrder(value: unknown): value is number {
  return typeof value === "number" && !Number.isNaN(value);
}
