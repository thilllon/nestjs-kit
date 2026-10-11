// One interceptor factory per advice kind. Rules shared by all of them:
// - The advice method is `aspect[advice.methodName]`, called with the aspect
//   instance as `this`. The instance comes from
//   `advice.resolveAspect(invocation.method, invocation.target)` when the
//   chain reaches the advice; `undefined` raises `AspectNotReadyError` naming
//   the aspect and the join point. The error is thrown before the advice and
//   everything inside it run; advice outside it has already started, and
//   after asynchronous before advice outside it the error is a rejection.
// - "Asynchronous result" means a value for which
//   `context.returnValues.find(value)` returns an adapter `A`, or a thenable
//   returned by a join point with `invocation.method.isAsync`, which is
//   followed as `Promise.resolve(value)`. Any other thenable, such as a lazy
//   query builder returned by a synchronous method, is a plain value: it is
//   returned untouched and never run.
// - The join point is asynchronous when `invocation.method.isAsync` or its
//   result is asynchronous. Before advice runs ahead of the result and has
//   `invocation.method.isAsync` only.
// - A before, after, afterReturning or afterThrowing advice that returns a
//   thenable is awaited on an asynchronous join point. On a synchronous join
//   point the interceptor raises `AspectUsageError`: the advice must be
//   synchronous. The thenable it returned is still observed, so that its
//   rejection is not reported as unhandled.
// - A join point that throws synchronously has no result to follow. Advice
//   that returns a thenable for it is awaited when `invocation.method.isAsync`
//   and the error is delivered as a rejection; otherwise `AspectUsageError`.
// - On a join point with `invocation.method.isAsync`, an error that before
//   advice throws synchronously is delivered as a rejection, as the join
//   point itself would deliver it.

import { AspectNotReadyError, AspectUsageError } from "./errors";
import { createProceedingJoinPoint } from "./join-point";
import type {
  AspectAdvice,
  InterceptorContext,
  MethodInterceptor,
  MethodInvocation,
  ReturnValueAdapter,
} from "./types";
import { isThenable } from "./util";

/** An asynchronous result and the adapter that follows it. */
interface Followed {
  readonly adapter: ReturnValueAdapter;
  readonly result: unknown;
}

function follow(
  result: unknown,
  invocation: MethodInvocation,
  context: InterceptorContext,
): Followed | undefined {
  const adapter = context.returnValues.find(result);
  if (adapter) {
    return { adapter, result };
  }
  if (invocation.method.isAsync && isThenable(result)) {
    const promise = Promise.resolve(result);
    const promiseAdapter = context.returnValues.find(promise);
    return promiseAdapter && { adapter: promiseAdapter, result: promise };
  }
  return undefined;
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
    throw new AspectNotReadyError(
      `${method.targetType.name}.${String(method.name)} was called before an instance of the aspect ${advice.aspectType.name} exists (advice ${describeAdvice(advice)})`,
    );
  }
  const fn = (aspect as Record<string | symbol, unknown>)[advice.methodName];
  if (typeof fn !== "function") {
    throw new AspectUsageError(
      `${describeAdvice(advice)} is not a method of the aspect instance`,
    );
  }
  return (...args) => fn.apply(aspect, args);
}

function asyncAdviceError(
  advice: AspectAdvice,
  invocation: MethodInvocation,
  options?: ErrorOptions,
): AspectUsageError {
  const { method } = invocation;
  return new AspectUsageError(
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
 * Returns the synchronous `result` of a join point, after advice that
 * returned `returned`.
 */
function returnAfterAdvice(
  returned: unknown,
  result: unknown,
  advice: AspectAdvice,
  invocation: MethodInvocation,
): unknown {
  if (isThenable(returned) && invocation.method.isAsync) {
    return Promise.resolve(returned).then(() => result);
  }
  requireSynchronous(returned, advice, invocation);
  return result;
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
 * on a synchronous join point it raises `AspectUsageError`. Otherwise the
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
 * synchronous result runs the advice and is returned; when the advice
 * returns a thenable and `invocation.method.isAsync`, as a promise that
 * waits for it. An error from the advice replaces the outcome.
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
      const followed = follow(result, invocation, context);
      if (followed) {
        return followed.adapter.finally(followed.result, () => run(joinPoint));
      }
      return returnAfterAdvice(run(joinPoint), result, advice, invocation);
    },
  };
}

/**
 * Runs `advice(jp, value)` after a normal completion and keeps the result:
 * `A.onSuccess(result, (value) => advice(jp, value))` for an asynchronous
 * result, `advice(jp, result)` otherwise; when that advice returns a thenable
 * and `invocation.method.isAsync`, the result is a promise that waits for
 * it. An error from the advice propagates instead of the result.
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
      const followed = follow(result, invocation, context);
      if (followed) {
        return followed.adapter.onSuccess(followed.result, (value) =>
          run(joinPoint, value),
        );
      }
      return returnAfterAdvice(
        run(joinPoint, result),
        result,
        advice,
        invocation,
      );
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
      const followed = follow(result, invocation, context);
      if (!followed) {
        return result;
      }
      return followed.adapter.onError(followed.result, (error) => {
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
