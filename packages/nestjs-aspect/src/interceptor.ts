// One interceptor factory per advice kind. Rules shared by all of them:
// - The advice method is `aspect[advice.methodName]`, called with the aspect
//   instance as `this`. The instance comes from
//   `advice.resolveAspect(invocation.method, invocation.target)` on every
//   call; `undefined` raises `AopNotReadyError` naming the aspect and the
//   join point.
// - "Asynchronous result" means a value for which
//   `context.returnValues.find(value)` returns an adapter `A`.
// - A before, after, afterReturning or afterThrowing advice that returns a
//   thenable is awaited when the join point result is asynchronous or (for
//   before) the join point is asynchronous. Otherwise the interceptor raises
//   `AopUsageError`: on a synchronous join point the advice must be
//   synchronous. The thenable it returned is still observed, so that its
//   rejection is not reported as unhandled.
// - A join point that throws synchronously has no result to follow. Advice
//   that returns a thenable for it is awaited when `invocation.method.isAsync`
//   and the error is delivered as a rejection; otherwise `AopUsageError`.
// - On an asynchronous join point, an error that before advice throws
//   synchronously is delivered as a rejection, as the join point itself would
//   deliver it. `AopNotReadyError` is always thrown synchronously, before the
//   join point runs.

import { AopNotReadyError, AopUsageError } from "./errors";
import { createProceedingJoinPoint } from "./join-point";
import type {
  AspectAdvice,
  InterceptorContext,
  MethodInterceptor,
  MethodInvocation,
} from "./types";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === "object" && value !== null) ||
      typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function describeAdvice(advice: AspectAdvice): string {
  return `${advice.aspectType.name}.${String(advice.methodName)}`;
}

/** Binds the advice method to the aspect instance that serves this call. */
function resolveAdvice(
  advice: AspectAdvice,
  invocation: MethodInvocation,
): (...args: unknown[]) => unknown {
  const aspect = advice.resolveAspect(invocation.method, invocation.target);
  if (!aspect) {
    const { method } = invocation;
    throw new AopNotReadyError(
      `${method.targetType.name}.${String(method.name)} was called before an instance of the aspect ${advice.aspectType.name} exists (advice ${describeAdvice(advice)})`,
    );
  }
  const fn = (aspect as Record<string | symbol, unknown>)[advice.methodName];
  if (typeof fn !== "function") {
    throw new AopUsageError(
      `${describeAdvice(advice)} is not a method of the aspect instance`,
    );
  }
  return (...args) => fn.apply(aspect, args);
}

function asyncAdviceError(
  advice: AspectAdvice,
  invocation: MethodInvocation,
  options?: ErrorOptions,
): AopUsageError {
  const { method } = invocation;
  return new AopUsageError(
    `The ${advice.kind} advice ${describeAdvice(advice)} returned a promise on the synchronous join point ${method.targetType.name}.${String(method.name)}; advice on a synchronous join point must be synchronous`,
    options,
  );
}

/** Rejects a thenable returned by advice that has nothing to wait for it. */
function requireSynchronous(
  returned: unknown,
  advice: AspectAdvice,
  invocation: MethodInvocation,
  options?: ErrorOptions,
): void {
  if (isThenable(returned)) {
    returned.then(undefined, () => undefined);
    throw asyncAdviceError(advice, invocation, options);
  }
}

/**
 * Propagates `error` of a join point that threw synchronously, after advice
 * that returned `returned`.
 */
function rethrowAfterAdvice(
  returned: unknown,
  error: unknown,
  advice: AspectAdvice,
  invocation: MethodInvocation,
): Promise<never> {
  if (isThenable(returned) && invocation.method.isAsync) {
    return Promise.resolve(returned).then(() => {
      throw error;
    });
  }
  requireSynchronous(returned, advice, invocation, { cause: error });
  throw error;
}

/**
 * `advice(pjp)`; its return value is the result. `pjp.proceed()` runs
 * `invocation.cloneFromHere().proceed()` and `pjp.proceedWith(...args)` runs
 * `invocation.cloneFromHere(args).proceed()`.
 */
export function aroundInterceptor(
  advice: AspectAdvice,
  _context: InterceptorContext,
): MethodInterceptor {
  return {
    invoke(invocation) {
      const run = resolveAdvice(advice, invocation);
      return run(createProceedingJoinPoint(invocation));
    },
  };
}

/**
 * `r = advice(jp)`. A thenable `r` on an asynchronous join point
 * (`invocation.method.isAsync`) yields `r.then(() => invocation.proceed())`;
 * on a synchronous join point it raises `AopUsageError`. Otherwise the
 * result is `invocation.proceed()`. An error from the advice prevents the
 * join point from running.
 */
export function beforeInterceptor(
  advice: AspectAdvice,
  _context: InterceptorContext,
): MethodInterceptor {
  return {
    invoke(invocation) {
      const run = resolveAdvice(advice, invocation);
      if (!invocation.method.isAsync) {
        requireSynchronous(run(invocation.joinPoint), advice, invocation);
        return invocation.proceed();
      }
      let returned: unknown;
      try {
        returned = run(invocation.joinPoint);
      } catch (error) {
        return Promise.reject(error);
      }
      return isThenable(returned)
        ? Promise.resolve(returned).then(() => invocation.proceed())
        : invocation.proceed();
    },
  };
}

/**
 * Finally semantics. A synchronous throw runs the advice and rethrows. An
 * asynchronous result yields `A.finally(result, () => advice(jp))`. A
 * synchronous result runs the advice and is returned. An error from the
 * advice replaces the outcome.
 */
export function afterInterceptor(
  advice: AspectAdvice,
  context: InterceptorContext,
): MethodInterceptor {
  return {
    invoke(invocation) {
      const run = resolveAdvice(advice, invocation);
      const joinPoint = invocation.joinPoint;
      let result: unknown;
      try {
        result = invocation.proceed();
      } catch (error) {
        return rethrowAfterAdvice(run(joinPoint), error, advice, invocation);
      }
      const adapter = context.returnValues.find(result);
      if (adapter) {
        return adapter.finally(result, () => run(joinPoint));
      }
      requireSynchronous(run(joinPoint), advice, invocation);
      return result;
    },
  };
}

/**
 * Runs `advice(jp, value)` after a normal completion and keeps the result:
 * `A.onSuccess(result, (value) => advice(jp, value))` for an asynchronous
 * result, `advice(jp, result)` otherwise. An error from the advice
 * propagates instead of the result.
 */
export function afterReturningInterceptor(
  advice: AspectAdvice,
  context: InterceptorContext,
): MethodInterceptor {
  return {
    invoke(invocation) {
      const run = resolveAdvice(advice, invocation);
      const joinPoint = invocation.joinPoint;
      const result = invocation.proceed();
      const adapter = context.returnValues.find(result);
      if (adapter) {
        return adapter.onSuccess(result, (value) => run(joinPoint, value));
      }
      requireSynchronous(run(joinPoint, result), advice, invocation);
      return result;
    },
  };
}

/**
 * Runs `advice(jp, error)` when the join point throws or its asynchronous
 * result fails (`A.onError`), then rethrows the same error. With
 * `advice.throwing`, only for an error that is `instanceof` that class. An
 * error from the advice replaces the original error.
 */
export function afterThrowingInterceptor(
  advice: AspectAdvice,
  context: InterceptorContext,
): MethodInterceptor {
  const { throwing } = advice;
  const handles = (error: unknown): boolean =>
    throwing === undefined || error instanceof throwing;
  return {
    invoke(invocation) {
      const run = resolveAdvice(advice, invocation);
      const joinPoint = invocation.joinPoint;
      let result: unknown;
      try {
        result = invocation.proceed();
      } catch (error) {
        if (!handles(error)) {
          throw error;
        }
        return rethrowAfterAdvice(
          run(joinPoint, error),
          error,
          advice,
          invocation,
        );
      }
      const adapter = context.returnValues.find(result);
      if (!adapter) {
        return result;
      }
      return adapter.onError(result, (error) => {
        if (!handles(error)) {
          throw error;
        }
        const returned = run(joinPoint, error);
        if (isThenable(returned)) {
          return Promise.resolve(returned).then(() => {
            throw error;
          });
        }
        throw error;
      });
    },
  };
}
