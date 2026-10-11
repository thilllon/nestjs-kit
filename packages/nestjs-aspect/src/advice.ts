// Advice guards, the Promise return value adapter and the two
// adapter registries.

import { AspectConfigurationError } from "./errors";
import {
  afterInterceptor,
  afterReturningInterceptor,
  afterThrowingInterceptor,
  aroundInterceptor,
  beforeInterceptor,
} from "./interceptor";
import type {
  Advice,
  AdviceAdapter,
  AdviceAdapterRegistry,
  AdviceKind,
  AspectAdvice,
  InterceptorContext,
  MethodInterceptor,
  ReturnValueAdapter,
  ReturnValueAdapterRegistry,
} from "./types";
import { isObject } from "./util";

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

const INTERCEPTOR_FACTORIES: Record<
  AdviceKind,
  (advice: AspectAdvice, context: InterceptorContext) => MethodInterceptor
> = {
  around: aroundInterceptor,
  before: beforeInterceptor,
  after: afterInterceptor,
  afterReturning: afterReturningInterceptor,
  afterThrowing: afterThrowingInterceptor,
};

/** True for an object with an `invoke` function. */
export function isMethodInterceptor(
  advice: unknown,
): advice is MethodInterceptor {
  return isObject(advice) && typeof advice.invoke === "function";
}

/** True for advice compiled from an aspect method. */
export function isAspectAdvice(advice: unknown): advice is AspectAdvice {
  return (
    isObject(advice) &&
    ADVICE_KINDS.includes(advice.kind as AdviceKind) &&
    typeof advice.aspectType === "function" &&
    (typeof advice.methodName === "string" ||
      typeof advice.methodName === "symbol") &&
    typeof advice.resolveAspect === "function"
  );
}

/**
 * Follows promises: `onSuccess` and `finally` wait for the callback and keep
 * the resolved value or the rejection; `onError` rejects with whatever the
 * callback throws.
 *
 * It supports instances of `Promise` only. Another thenable, such as a lazy
 * query builder, is a plain value: following it would run it and replace it
 * with a promise.
 */
export const promiseAdapter: ReturnValueAdapter<Promise<unknown>> = {
  supports(value: unknown): value is Promise<unknown> {
    return value instanceof Promise;
  },
  onSuccess(value, callback) {
    return value.then(async (resolved) => {
      await callback(resolved);
      return resolved;
    });
  },
  onError(value, callback) {
    return value.then(undefined, async (error: unknown) => {
      await callback(error);
      throw error;
    });
  },
  finally(value, callback) {
    return value.then(
      async (resolved) => {
        await callback();
        return resolved;
      },
      async (error: unknown) => {
        await callback();
        throw error;
      },
    );
  },
};

/**
 * Registry of return value adapters, searched in the given order. The default
 * is `[promiseAdapter]`.
 */
export function createReturnValueAdapterRegistry(
  adapters: readonly ReturnValueAdapter<any>[] = [promiseAdapter],
): ReturnValueAdapterRegistry {
  const ordered = [...adapters];
  return {
    find(value) {
      return ordered.find((adapter) => adapter.supports(value));
    },
  };
}

/** Passes a `MethodInterceptor` through unchanged. */
export const methodInterceptorAdapter: AdviceAdapter = {
  supports(advice) {
    return isMethodInterceptor(advice);
  },
  toInterceptor(advice) {
    return advice as MethodInterceptor;
  },
};

/** Converts `AspectAdvice` with the interceptor factory of its kind. */
export const aspectAdviceAdapter: AdviceAdapter = {
  supports(advice) {
    return isAspectAdvice(advice);
  },
  toInterceptor(advice, context) {
    const aspectAdvice = advice as AspectAdvice;
    return INTERCEPTOR_FACTORIES[aspectAdvice.kind](aspectAdvice, context);
  },
};

/**
 * Registry of advice adapters. The given adapters are consulted first, then
 * `aspectAdviceAdapter` and `methodInterceptorAdapter`.
 */
export function createAdviceAdapterRegistry(
  adapters: readonly AdviceAdapter[] = [],
): AdviceAdapterRegistry {
  const ordered = [...adapters, aspectAdviceAdapter, methodInterceptorAdapter];
  return {
    toInterceptor(advice: Advice, context: InterceptorContext) {
      const adapter = ordered.find((candidate) => candidate.supports(advice));
      if (!adapter) {
        throw new AspectConfigurationError(
          "No advice adapter supports the advice: it is neither a MethodInterceptor nor advice compiled from an aspect",
        );
      }
      return adapter.toInterceptor(advice, context);
    },
  };
}
