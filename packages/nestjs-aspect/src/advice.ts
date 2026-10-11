// Slice B. Exported signatures are frozen; the bodies are the slice's work.

import type {
  AdviceAdapter,
  AdviceAdapterRegistry,
  AdviceKind,
  AspectAdvice,
  MethodInterceptor,
  ReturnValueAdapter,
  ReturnValueAdapterRegistry,
} from "./types";

/**
 * Advice kinds in their order within one aspect. The index of a kind is its
 * `AdvisorDescriptor.kindRank`.
 */
export const ADVICE_KINDS: readonly AdviceKind[] = [
  "around",
  "before",
  "after",
  "afterReturning",
  "afterThrowing",
];

/** True for an object with an `invoke` function. */
export function isMethodInterceptor(
  _advice: unknown,
): _advice is MethodInterceptor {
  throw new Error("not implemented");
}

/** True for advice compiled from an aspect method. */
export function isAspectAdvice(_advice: unknown): _advice is AspectAdvice {
  throw new Error("not implemented");
}

/**
 * Follows thenables with `then`: `onSuccess` and `finally` wait for the
 * callback and keep the resolved value or the rejection; `onError` rejects
 * with whatever the callback throws.
 */
export const promiseAdapter: ReturnValueAdapter<PromiseLike<unknown>> = {
  supports(_value: unknown): _value is PromiseLike<unknown> {
    throw new Error("not implemented");
  },
  onSuccess() {
    throw new Error("not implemented");
  },
  onError() {
    throw new Error("not implemented");
  },
  finally() {
    throw new Error("not implemented");
  },
};

/**
 * Registry of return value adapters, searched in the given order. The default
 * is `[promiseAdapter]`.
 */
export function createReturnValueAdapterRegistry(
  _adapters?: readonly ReturnValueAdapter<any>[],
): ReturnValueAdapterRegistry {
  throw new Error("not implemented");
}

/** Passes a `MethodInterceptor` through unchanged. */
export const methodInterceptorAdapter: AdviceAdapter = {
  supports() {
    throw new Error("not implemented");
  },
  toInterceptor() {
    throw new Error("not implemented");
  },
};

/** Converts `AspectAdvice` with the interceptor factory of its kind. */
export const aspectAdviceAdapter: AdviceAdapter = {
  supports() {
    throw new Error("not implemented");
  },
  toInterceptor() {
    throw new Error("not implemented");
  },
};

/**
 * Registry of advice adapters. The given adapters are consulted first, then
 * `aspectAdviceAdapter` and `methodInterceptorAdapter`.
 */
export function createAdviceAdapterRegistry(
  _adapters?: readonly AdviceAdapter[],
): AdviceAdapterRegistry {
  throw new Error("not implemented");
}
