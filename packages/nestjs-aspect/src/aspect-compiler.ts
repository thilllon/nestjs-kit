// Compiles aspect class metadata and advisor instances into
// `AdvisorDescriptor`s and orders them.

import { ADVICE_KINDS } from "./advice";
import { getAdviceMetadata, getAspectMetadata } from "./aspect-decorators";
import { AopConfigurationError } from "./errors";
import type {
  AdvisorDescriptor,
  AspectAdvice,
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

function isObject(value: unknown): value is object {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  );
}

/** True when the prototype chain defines `name` as a method. */
function definesMethod(type: Class, name: string | symbol): boolean {
  for (
    let prototype: object | null = type.prototype;
    prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor) {
      return typeof descriptor.value === "function";
    }
  }
  return false;
}

function compareOrder(a: number | undefined, b: number | undefined): number {
  if (a === b) {
    return 0;
  }
  if (a === undefined) {
    return 1;
  }
  if (b === undefined) {
    return -1;
  }
  return a - b;
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
  aspectType: Class,
  options: AspectCompilerOptions,
): AdvisorDescriptor[] {
  const metadata = getAspectMetadata(aspectType);
  if (!metadata) {
    throw new AopConfigurationError(
      `${aspectType.name} is not decorated with @Aspect`,
    );
  }
  if (metadata.instantiation !== "singleton") {
    throw new AopConfigurationError(
      `${aspectType.name} declares the instantiation model "${metadata.instantiation}"; only "singleton" is supported`,
    );
  }
  const { resolveAspect, registration } = options;
  const advisors = getAdviceMetadata(aspectType).map(
    (entry, declaration): AdvisorDescriptor => {
      const { kind, methodName, pointcut, throwing } = entry;
      if (!definesMethod(aspectType, methodName)) {
        throw new AopConfigurationError(
          `The ${kind} advice ${aspectType.name}.${String(methodName)} is not a method`,
        );
      }
      const advice: AspectAdvice = {
        kind,
        aspectType,
        methodName,
        ...(throwing === undefined ? {} : { throwing }),
        resolveAspect: (method, target) =>
          resolveAspect(aspectType, method, target),
      };
      return {
        pointcut,
        advice,
        order: metadata.order,
        registration,
        kindRank: ADVICE_KINDS.indexOf(kind),
        declaration,
        source: { type: aspectType, methodName, kind },
      };
    },
  );
  return sortAdvisors(advisors);
}

/**
 * Describes an `@AopAdvisor` instance: its `pointcut`, `advice` and `order`
 * as they are at the time of the call, with `kindRank` 0 and `declaration` 0.
 * Throws `AopConfigurationError` when `pointcut` or `advice` is missing.
 */
export function describeAdvisor(
  advisor: PointcutAdvisor,
  type: Class,
  registration: number,
): AdvisorDescriptor {
  const { pointcut, advice, order } = advisor;
  if (
    !isObject(pointcut) ||
    !isObject(pointcut.classFilter) ||
    !isObject(pointcut.methodMatcher)
  ) {
    throw new AopConfigurationError(
      `The advisor ${type.name} has no pointcut with a classFilter and a methodMatcher`,
    );
  }
  if (!isObject(advice)) {
    throw new AopConfigurationError(`The advisor ${type.name} has no advice`);
  }
  if (order !== undefined && typeof order !== "number") {
    throw new AopConfigurationError(
      `The advisor ${type.name} has an order that is not a number`,
    );
  }
  return {
    pointcut,
    advice,
    order,
    registration,
    kindRank: 0,
    declaration: 0,
    source: { type },
  };
}

/**
 * Orders advisors for one chain; returns a new array. Keys, in order: `order`
 * ascending with `undefined` last, `registration`, `kindRank`, `declaration`.
 */
export function sortAdvisors(
  advisors: readonly AdvisorDescriptor[],
): AdvisorDescriptor[] {
  return [...advisors].sort(
    (a, b) =>
      compareOrder(a.order, b.order) ||
      a.registration - b.registration ||
      a.kindRank - b.kindRank ||
      a.declaration - b.declaration,
  );
}
