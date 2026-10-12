import type {
  AndShape,
  AnyShape,
  ClassFilter,
  MethodMatcher,
  MethodRef,
  OrShape,
  Pointcut,
  PointcutLike,
  Shape,
} from "./types";
import { isObject } from "./util";

/**
 * Members that broad pointcuts never match. A Nest lifecycle hook is a join
 * point only for a pointcut that names it with `Pointcut.method`.
 * `constructor` is never a join point.
 */
export const RESERVED_MEMBERS: ReadonlySet<string | symbol> = new Set([
  "constructor",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

const EVERY_CLASS: ClassFilter = { matches: () => true };

const EVERY_METHOD: MethodMatcher = { isRuntime: false, matches: () => true };

const NO_ANNOTATIONS: ReadonlySet<string> = new Set();

/**
 * Property of a pointcut built by `createPointcut` that holds the names of
 * the annotations its designators refer to, or `undefined` when a part of it
 * is a caller-supplied matcher. Registered with `Symbol.for`, so every copy
 * of the package reads it.
 */
const REFERENCES: unique symbol = Symbol.for(
  "nestjs-aspect:referenced-annotations",
);

/** The union of the referenced annotations; unknown when either is unknown. */
function mergeReferences(
  a: PointcutLike,
  b: PointcutLike,
): Pick<PointcutParts, "references" | "custom"> {
  const left = referencedAnnotations(a);
  const right = referencedAnnotations(b);
  return left && right ? { references: [...left, ...right] } : { custom: true };
}

/** True for a value with a class filter and a method matcher that can match. */
export function isPointcutLike(value: unknown): value is PointcutLike {
  if (!isObject(value)) {
    return false;
  }
  const { classFilter, methodMatcher } = value as Partial<PointcutLike>;
  return (
    typeof classFilter?.matches === "function" &&
    typeof methodMatcher?.matches === "function"
  );
}

/** Class filter and static method matcher, without the join point exclusions. */
function matchesRaw(pointcut: PointcutLike, method: MethodRef): boolean {
  return (
    pointcut.classFilter.matches(method.classRef) &&
    pointcut.methodMatcher.matches(method)
  );
}

function matchesRuntimePart(
  pointcut: PointcutLike,
  method: MethodRef,
  args: readonly unknown[],
): boolean {
  const matcher = pointcut.methodMatcher;
  return !matcher.isRuntime || (matcher.matchesRuntime?.(method, args) ?? true);
}

function matchesCompletely(
  pointcut: PointcutLike,
  method: MethodRef,
  args: readonly unknown[],
): boolean {
  return (
    matchesRaw(pointcut, method) && matchesRuntimePart(pointcut, method, args)
  );
}

function includesExplicitly(
  pointcut: PointcutLike,
  method: MethodRef,
): boolean {
  return (
    pointcut.includesExplicitly !== undefined &&
    matchesRaw(pointcut, method) &&
    pointcut.includesExplicitly(method)
  );
}

function conjunction(a: PointcutLike, b: PointcutLike): PointcutParts {
  const isRuntime = a.methodMatcher.isRuntime || b.methodMatcher.isRuntime;
  return {
    classFilter: {
      matches: (type) =>
        a.classFilter.matches(type) && b.classFilter.matches(type),
    },
    methodMatcher: {
      isRuntime,
      matches: (method) =>
        a.methodMatcher.matches(method) && b.methodMatcher.matches(method),
      // Runs after the static match, which covers the static part of both operands.
      ...(isRuntime && {
        matchesRuntime: (method: MethodRef, args: readonly unknown[]) =>
          matchesRuntimePart(a, method, args) &&
          matchesRuntimePart(b, method, args),
      }),
    },
    includesExplicitly: (method) =>
      includesExplicitly(a, method) || includesExplicitly(b, method),
    guarantees: [...guaranteedAnnotations(a), ...guaranteedAnnotations(b)],
    ...mergeReferences(a, b),
  };
}

function disjunction(a: PointcutLike, b: PointcutLike): PointcutParts {
  const isRuntime = a.methodMatcher.isRuntime || b.methodMatcher.isRuntime;
  const common = guaranteedAnnotations(b);
  return {
    classFilter: {
      matches: (type) =>
        a.classFilter.matches(type) || b.classFilter.matches(type),
    },
    methodMatcher: {
      isRuntime,
      matches: (method) => matchesRaw(a, method) || matchesRaw(b, method),
      ...(isRuntime && {
        matchesRuntime: (method: MethodRef, args: readonly unknown[]) =>
          matchesCompletely(a, method, args) ||
          matchesCompletely(b, method, args),
      }),
    },
    includesExplicitly: (method) =>
      includesExplicitly(a, method) || includesExplicitly(b, method),
    guarantees: [...guaranteedAnnotations(a)].filter((name) =>
      common.has(name),
    ),
    ...mergeReferences(a, b),
  };
}

function negation(a: PointcutLike): PointcutParts {
  const isRuntime = a.methodMatcher.isRuntime;
  return {
    methodMatcher: {
      isRuntime,
      // The operand decides at run time wherever it may match, so the
      // negation may match there too.
      matches: (method) => isRuntime || !matchesRaw(a, method),
      ...(isRuntime && {
        matchesRuntime: (method: MethodRef, args: readonly unknown[]) =>
          !matchesCompletely(a, method, args),
      }),
    },
    ...mergeReferences(a, a),
  };
}

/**
 * True for a join point that every pointcut can match: a method whose name is
 * not reserved. Reserved members and accessors need an explicit designator.
 */
export function isDefaultJoinPoint(method: MethodRef): boolean {
  return method.kind === "method" && !RESERVED_MEMBERS.has(method.name);
}

/** Parts of a pointcut; an omitted part matches everything. */
export interface PointcutParts {
  classFilter?: ClassFilter;
  methodMatcher?: MethodMatcher;
  includesExplicitly?: (method: MethodRef) => boolean;
  guarantees?: Iterable<string>;
  /**
   * Names of the annotations the parts refer to without guaranteeing them;
   * the guaranteed ones are always referenced.
   */
  references?: Iterable<string>;
  /** True when a part is a caller-supplied matcher, as in `Pointcut.matching`. */
  custom?: boolean;
}

/**
 * Builds a composable pointcut from its parts. Every designator of `Pointcut`
 * goes through this function.
 *
 * `parts.includesExplicitly` is consulted only for members the pointcut
 * matches statically.
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
 *   `matchesRuntime` of `or()` and `not()` evaluates each operand completely
 *   (class filter, static part, then runtime part when it has one);
 *   `matchesRuntime` of `and()` evaluates the runtime parts, because its
 *   static match covers both operands. `not()` of a runtime pointcut matches
 *   statically wherever the operand may match or does not match, and negates
 *   the complete decision at run time.
 * - `includesExplicitly`: `and` requires both sides to match statically and
 *   either side to include explicitly; `or` requires one side to match
 *   statically and include explicitly; `not` never includes explicitly.
 */
export function createPointcut<S extends Shape = AnyShape>(
  parts: PointcutParts,
): Pointcut<S> {
  const explicit = parts.includesExplicitly;
  const pointcut: Pointcut<S> = {
    classFilter: parts.classFilter ?? EVERY_CLASS,
    methodMatcher: parts.methodMatcher ?? EVERY_METHOD,
    guarantees: new Set(parts.guarantees),
    includesExplicitly: (method) =>
      explicit !== undefined &&
      matchesRaw(pointcut, method) &&
      explicit(method),
    and: <S2 extends Shape>(other: Pointcut<S2>) =>
      createPointcut<AndShape<S, S2>>(conjunction(pointcut, other)),
    or: <S2 extends Shape>(other: Pointcut<S2>) =>
      createPointcut<OrShape<S, S2>>(disjunction(pointcut, other)),
    not: () => createPointcut<AnyShape>(negation(pointcut)),
  };
  Object.defineProperty(pointcut, REFERENCES, {
    value: parts.custom
      ? undefined
      : new Set([...(parts.guarantees ?? []), ...(parts.references ?? [])]),
  });
  return Object.freeze(pointcut);
}

/**
 * The static decision of the weaver for one advisor and one member:
 * the class filter and the static method matcher match and, unless
 * `isDefaultJoinPoint(method)`, the pointcut includes the member explicitly.
 * `constructor` never matches.
 */
export function matchesStatically(
  pointcut: PointcutLike,
  method: MethodRef,
): boolean {
  if (method.name === "constructor" || !matchesRaw(pointcut, method)) {
    return false;
  }
  return isDefaultJoinPoint(method) || includesExplicitly(pointcut, method);
}

/** Annotation names the pointcut guarantees; empty for a hand-written pointcut. */
export function guaranteedAnnotations(
  pointcut: PointcutLike,
): ReadonlySet<string> {
  return pointcut.guarantees ?? NO_ANNOTATIONS;
}

/**
 * Names of the annotations the designators of the pointcut refer to, in any
 * position of a composition. `undefined` for a pointcut whose annotations
 * cannot be told: a hand-written one, or one composed with `Pointcut.matching`.
 */
export function referencedAnnotations(
  pointcut: PointcutLike,
): ReadonlySet<string> | undefined {
  return (pointcut as { [REFERENCES]?: ReadonlySet<string> })[REFERENCES];
}
