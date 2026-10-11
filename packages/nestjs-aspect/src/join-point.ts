// Slice B. Exported signatures are frozen; the bodies are the slice's work.

import type {
  AnyShape,
  JoinPoint,
  MethodInvocation,
  ProceedingJoinPoint,
} from "./types";

/**
 * Join point of one invocation.
 * - `kind`, `signature` and `isAsync` come from `invocation.method`; `target`
 *   and `args` from the invocation.
 * - `annotation` and `findAnnotation` use `findAnnotation` of
 *   `./annotation` (the method, the declaring class, the target class);
 *   `annotation` raises `AopUsageError` when nothing is found.
 * - `toString()` is `"<TargetType>.<name>(<args>)"`, with the arguments
 *   rendered by `formatArgument`.
 */
export function createJoinPoint(
  _invocation: MethodInvocation,
): JoinPoint<AnyShape> {
  throw new Error("not implemented");
}

/**
 * Join point of around advice. `proceed()` runs
 * `invocation.cloneFromHere().proceed()` and `proceedWith(...args)` runs
 * `invocation.cloneFromHere(args).proceed()`, so both can be called any number
 * of times.
 */
export function createProceedingJoinPoint(
  _invocation: MethodInvocation,
): ProceedingJoinPoint<AnyShape> {
  throw new Error("not implemented");
}

/**
 * Short rendering of one argument for `JoinPoint.toString()`: primitives as
 * literals (strings quoted and truncated), functions as `[Function name]`,
 * arrays as `Array(n)`, other objects as their constructor name. It never
 * calls user code such as `toJSON` or `toString`.
 */
export function formatArgument(_value: unknown): string {
  throw new Error("not implemented");
}
