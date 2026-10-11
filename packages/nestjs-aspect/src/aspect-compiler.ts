// Compiles aspect class metadata and advisor instances into
// `AdvisorDescriptor`s and orders them.

import { ADVICE_KINDS } from "./advice";
import {
  getAdviceMetadata,
  getAspectMetadata,
  isAspect,
} from "./aspect-decorators";
import { AspectConfigurationError } from "./errors";
import { isPointcutLike } from "./pointcut";
import type {
  AdvisorDescriptor,
  AspectAdvice,
  AspectInstanceResolver,
  Class,
  PointcutAdvisor,
} from "./types";
import { constructorChain, isObject, isOrder } from "./util";

export interface AspectCompilerOptions {
  /** Supplies aspect instances lazily, at call time. */
  resolveAspect: AspectInstanceResolver;
  /** Position of the aspect among the aspects and advisors of the application. */
  registration: number;
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
 * Throws `AspectConfigurationError` when the class is not an `@Aspect`, when it
 * extends another `@Aspect` class, whose advice it would run a second time,
 * when an advice method is not a function on its prototype chain, or when the
 * aspect declares an instantiation model other than `"singleton"`.
 */
export function compileAspect(
  aspectType: Class,
  options: AspectCompilerOptions,
): AdvisorDescriptor[] {
  const metadata = getAspectMetadata(aspectType);
  if (!metadata) {
    throw new AspectConfigurationError(
      `${aspectType.name} is not decorated with @Aspect`,
    );
  }
  const [, ...superclasses] = constructorChain(aspectType);
  const parent = superclasses.find(isAspect);
  if (parent) {
    throw new AspectConfigurationError(
      `The aspect ${aspectType.name} extends the aspect ${parent.name}, whose advice would run once for each of them. An aspect inherits advice only from a class without @Aspect.`,
    );
  }
  if (metadata.instantiation !== "singleton") {
    throw new AspectConfigurationError(
      `${aspectType.name} declares the instantiation model "${metadata.instantiation}"; only "singleton" is supported`,
    );
  }
  const { resolveAspect, registration } = options;
  const advisors = getAdviceMetadata(aspectType).map(
    (entry, declaration): AdvisorDescriptor => {
      const { kind, methodName, pointcut, throwing } = entry;
      if (!definesMethod(aspectType, methodName)) {
        throw new AspectConfigurationError(
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
 * Describes an `@Advisor` instance: its `pointcut`, `advice` and `order`
 * as they are at the time of the call, with `kindRank` 0 and `declaration` 0.
 * Throws `AspectConfigurationError` when `pointcut` or `advice` is missing or
 * `order` is not a number.
 */
export function describeAdvisor(
  advisor: PointcutAdvisor,
  type: Class,
  registration: number,
): AdvisorDescriptor {
  const { pointcut, advice, order } = advisor;
  if (!isPointcutLike(pointcut)) {
    throw new AspectConfigurationError(
      `The advisor ${type.name} has no pointcut with a classFilter and a methodMatcher`,
    );
  }
  if (!isObject(advice)) {
    throw new AspectConfigurationError(
      `The advisor ${type.name} has no advice`,
    );
  }
  if (order !== undefined && !isOrder(order)) {
    throw new AspectConfigurationError(
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
