// Slice B. Exported signatures are frozen; the bodies are the slice's work.
//
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

import type {
  AspectAdvice,
  InterceptorContext,
  MethodInterceptor,
} from "./types";

/**
 * `advice(pjp)`; its return value is the result. `pjp.proceed()` runs
 * `invocation.cloneFromHere().proceed()` and `pjp.proceedWith(...args)` runs
 * `invocation.cloneFromHere(args).proceed()`.
 */
export function aroundInterceptor(
  _advice: AspectAdvice,
  _context: InterceptorContext,
): MethodInterceptor {
  throw new Error("not implemented");
}

/**
 * `r = advice(jp)`. A thenable `r` on an asynchronous join point
 * (`invocation.method.isAsync`) yields `r.then(() => invocation.proceed())`;
 * on a synchronous join point it raises `AopUsageError`. Otherwise the
 * result is `invocation.proceed()`. An error from the advice prevents the
 * join point from running.
 */
export function beforeInterceptor(
  _advice: AspectAdvice,
  _context: InterceptorContext,
): MethodInterceptor {
  throw new Error("not implemented");
}

/**
 * Finally semantics. A synchronous throw runs the advice and rethrows. An
 * asynchronous result yields `A.finally(result, () => advice(jp))`. A
 * synchronous result runs the advice and is returned. An error from the
 * advice replaces the outcome.
 */
export function afterInterceptor(
  _advice: AspectAdvice,
  _context: InterceptorContext,
): MethodInterceptor {
  throw new Error("not implemented");
}

/**
 * Runs `advice(jp, value)` after a normal completion and keeps the result:
 * `A.onSuccess(result, (value) => advice(jp, value))` for an asynchronous
 * result, `advice(jp, result)` otherwise. An error from the advice
 * propagates instead of the result.
 */
export function afterReturningInterceptor(
  _advice: AspectAdvice,
  _context: InterceptorContext,
): MethodInterceptor {
  throw new Error("not implemented");
}

/**
 * Runs `advice(jp, error)` when the join point throws or its asynchronous
 * result fails (`A.onError`), then rethrows the same error. With
 * `advice.throwing`, only for an error that is `instanceof` that class. An
 * error from the advice replaces the original error.
 */
export function afterThrowingInterceptor(
  _advice: AspectAdvice,
  _context: InterceptorContext,
): MethodInterceptor {
  throw new Error("not implemented");
}
