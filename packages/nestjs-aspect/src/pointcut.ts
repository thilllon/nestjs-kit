// Slice A. Exported signatures are frozen; the bodies are the slice's work.

import type {
  AnyShape,
  ClassFilter,
  MethodMatcher,
  MethodRef,
  Pointcut,
  PointcutLike,
  Shape,
} from "./types";

/**
 * Members that broad pointcuts never match. A Nest lifecycle hook is a join
 * point only for a pointcut that names it with `P.method`. `constructor` is
 * never a join point.
 */
export const RESERVED_MEMBERS: ReadonlySet<string | symbol> = new Set([
  "constructor",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

/**
 * True for a join point that every pointcut can match: a method whose name is
 * not reserved. Reserved members and accessors need an explicit designator.
 */
export function isDefaultJoinPoint(_method: MethodRef): boolean {
  throw new Error("not implemented");
}

/** Parts of a pointcut; an omitted part matches everything. */
export interface PointcutParts {
  classFilter?: ClassFilter;
  methodMatcher?: MethodMatcher;
  includesExplicitly?: (method: MethodRef) => boolean;
  guarantees?: Iterable<string>;
}

/**
 * Builds a composable pointcut from its parts. Every designator of `P` goes
 * through this function.
 *
 * Composition rules:
 * - `a.and(b)`: both class filters and both method matchers match;
 *   `isRuntime` when either is; guarantees the union.
 * - `a.or(b)`: the class filter accepts what either accepts and the method
 *   matcher evaluates each side's class filter with its own method matcher;
 *   guarantees the intersection.
 * - `a.not()`: the class filter accepts every class and the method matcher
 *   negates the whole of `a`; guarantees nothing.
 * - Runtime matchers: a static `matches` of a composite answers "may match".
 *   `matchesRuntime` of a composite evaluates each operand completely (class
 *   filter, static part, then runtime part when it has one). `not()` of a
 *   runtime pointcut matches statically wherever the operand may match or
 *   does not match, and negates the complete decision at run time.
 * - `includesExplicitly`: `and` requires both sides to match statically and
 *   either side to include explicitly; `or` requires one side to match
 *   statically and include explicitly; `not` never includes explicitly.
 */
export function createPointcut<S extends Shape = AnyShape>(
  _parts: PointcutParts,
): Pointcut<S> {
  throw new Error("not implemented");
}

/**
 * The static decision of the weaver for one advisor and one member:
 * the class filter and the static method matcher match and, unless
 * `isDefaultJoinPoint(method)`, the pointcut includes the member explicitly.
 */
export function matchesStatically(
  _pointcut: PointcutLike,
  _method: MethodRef,
): boolean {
  throw new Error("not implemented");
}

/** Annotation names the pointcut guarantees; empty for a hand-written pointcut. */
export function guaranteedAnnotations(
  _pointcut: PointcutLike,
): ReadonlySet<string> {
  throw new Error("not implemented");
}
