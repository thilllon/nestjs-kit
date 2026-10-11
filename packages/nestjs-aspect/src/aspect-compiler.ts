// Slice B. Exported signatures are frozen; the bodies are the slice's work.

import type {
  AdvisorDescriptor,
  AspectInstanceResolver,
  Class,
  PointcutAdvisor,
} from "./types";

export interface AspectCompilerOptions {
  /** Supplies aspect instances lazily, at call time. */
  resolveAspect: AspectInstanceResolver;
  /** Position of the aspect among the aspects and advisors of the application. */
  registration: number;
}

/**
 * Compiles the metadata of an aspect class into advisors, without an aspect
 * instance. The result is in in-aspect order: around, before, after,
 * afterReturning, afterThrowing; the same kind in declaration order.
 *
 * Each advisor carries an `AspectAdvice` bound to `options.resolveAspect`,
 * the aspect's `order` and `source: { type, methodName, kind }`.
 *
 * Throws `AopConfigurationError` when the class is not an `@Aspect`, when an
 * advice method is not a function on its prototype chain, or when the aspect
 * declares an instantiation model other than `"singleton"`.
 */
export function compileAspect(
  _aspectType: Class,
  _options: AspectCompilerOptions,
): AdvisorDescriptor[] {
  throw new Error("not implemented");
}

/**
 * Describes an `@AopAdvisor` instance: its `pointcut`, `advice` and `order`
 * as they are at the time of the call, with `kindRank` 0 and `declaration` 0.
 * Throws `AopConfigurationError` when `pointcut` or `advice` is missing.
 */
export function describeAdvisor(
  _advisor: PointcutAdvisor,
  _type: Class,
  _registration: number,
): AdvisorDescriptor {
  throw new Error("not implemented");
}

/**
 * Orders advisors for one chain; returns a new array. Keys, in order: `order`
 * ascending with `undefined` last, `registration`, `kindRank`, `declaration`.
 */
export function sortAdvisors(
  _advisors: readonly AdvisorDescriptor[],
): AdvisorDescriptor[] {
  throw new Error("not implemented");
}
