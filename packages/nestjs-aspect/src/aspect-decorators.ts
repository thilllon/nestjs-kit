// Aspect and advice decorators, their metadata keys and readers.

import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { AspectConfigurationError } from "./errors";
import { isPointcutLike } from "./pointcut";
import { annotated } from "./pointcut-designators";
import type {
  AdviceKind,
  AdviceMetadata,
  AnnotationLike,
  AnyShape,
  AspectMetadata,
  AspectOptions,
  Class,
  AnyFunction,
  JoinPoint,
  Pointcut,
  PointcutAdvisor,
  PointcutLike,
  ProceedingJoinPoint,
  Shape,
  ShapeOf,
} from "./types";
import { constructorChain, isOrder } from "./util";

/**
 * Own Reflect metadata of an aspect class constructor: `AspectMetadata`.
 * Metadata keys use `Symbol.for`, so two copies of the package read each
 * other's aspects.
 */
export const ASPECT_METADATA: unique symbol = Symbol.for(
  "nestjs-aspect:aspect",
);

/**
 * Own Reflect metadata of a class constructor: `readonly AdviceMetadata[]`,
 * one entry per advice decorator application, in application order.
 * TypeScript applies the decorators of a class member by member in source
 * order, so the array index is the declaration order; several advice
 * decorators on one method are applied bottom-up. A decorator replaces the
 * array with a copy instead of mutating it.
 */
export const ADVICE_METADATA: unique symbol = Symbol.for(
  "nestjs-aspect:advice",
);

/** Own Reflect metadata of an `@Advisor` class constructor: `true`. */
export const ADVISOR_METADATA: unique symbol = Symbol.for(
  "nestjs-aspect:advisor",
);

/**
 * A result whose settlement advice can follow: a promise, or a value with a
 * `subscribe` method, such as an Observable, which a `ReturnValueAdapter`
 * follows.
 */
type Deferred = PromiseLike<any> | { subscribe: AnyFunction };

/**
 * Return type required of before, after, afterReturning and afterThrowing
 * advice: `void`, or also a promise when the join point is or may be
 * asynchronous. A join point that returns a value with a `subscribe` method
 * may be asynchronous: whether an adapter follows it is known at run time.
 */
export type AdviceResult<S extends Shape> = [S["returns"]] extends [
  PromiseLike<any>,
]
  ? void | PromiseLike<void>
  : unknown extends S["returns"]
    ? void | PromiseLike<void>
    : // Also a union with such a member, as `or()` of a synchronous and an asynchronous method produces.
      [Extract<S["returns"], Deferred>] extends [never]
      ? // biome-ignore lint/suspicious/noConfusingVoidType: void is the return type required of synchronous advice
        void
      : void | PromiseLike<void>;

/**
 * `() => Promise<void>` is assignable to `() => void`, so a function type
 * constraint cannot reject asynchronous advice. This intersection checks the
 * return type of the advice method itself.
 */
export type AsyncGuard<S extends Shape, T extends AnyFunction> =
  AdviceResult<S> extends void | PromiseLike<void>
    ? // biome-ignore lint/suspicious/noConfusingVoidType: void is compared with the advice return type
      [void] extends [AdviceResult<S>]
      ? PromiseLike<void> extends AdviceResult<S>
        ? unknown
        : ReturnType<T> extends PromiseLike<any>
          ? { "async advice is not allowed on a synchronous join point": never }
          : unknown
      : unknown
    : unknown;

/**
 * Type of the result after-returning advice receives: the awaited result of
 * the join point. For a result with a `subscribe` method it is `any`: a
 * `ReturnValueAdapter` decides at run time what such a result settles to,
 * as `observableAdapter` passes the last value an Observable emits, so the
 * advice declares the type itself.
 */
export type AdviceValue<R> = R extends { subscribe: AnyFunction }
  ? any
  : Awaited<R>;

export type AdviceDecorator<S extends Shape, F extends AnyFunction> = <
  T extends F,
>(
  target: object,
  key: string | symbol,
  desc: TypedPropertyDescriptor<T> & AsyncGuard<S, T>,
) => void;

const INSTANTIATION_MODELS: readonly unknown[] = [
  "singleton",
  "perTarget",
  "perClass",
];

function ownAdviceMetadata(type: object): readonly AdviceMetadata[] {
  return Reflect.getOwnMetadata(ADVICE_METADATA, type) ?? [];
}

function adviceDecorator(
  kind: AdviceKind,
  pointcutOrAnnotation: unknown,
  throwing?: Class,
): (target: object, key: string | symbol) => void {
  const decorator = `@${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
  // A pointcut is an object and an annotation a function: an annotation
  // stands for `Pointcut.annotated(annotation)`, which validates it.
  const pointcut =
    typeof pointcutOrAnnotation === "function"
      ? annotated(pointcutOrAnnotation as AnnotationLike<any>)
      : pointcutOrAnnotation;
  if (!isPointcutLike(pointcut)) {
    throw new AspectConfigurationError(
      `${decorator} requires a pointcut; an undefined pointcut usually comes from a circular import`,
    );
  }
  if (throwing !== undefined && typeof throwing !== "function") {
    throw new AspectConfigurationError(
      `${decorator} requires a class as its throwing option`,
    );
  }
  return (target, key) => {
    if (typeof target === "function") {
      throw new AspectConfigurationError(
        `${decorator} cannot be applied to the static member ${target.name}.${String(key)}`,
      );
    }
    const type = target.constructor;
    const entry: AdviceMetadata =
      throwing === undefined
        ? { kind, pointcut, methodName: key }
        : { kind, pointcut, methodName: key, throwing };
    Reflect.defineMetadata(
      ADVICE_METADATA,
      [...ownAdviceMetadata(type), entry],
      type,
    );
  };
}

/**
 * Marks a class as an aspect and as a Nest provider (`@Injectable()`), and
 * stores `AspectMetadata` with `instantiation` defaulting to `"singleton"`.
 */
export function Aspect(options: AspectOptions = {}): ClassDecorator {
  const { order, instantiation = "singleton" } = options;
  if (order !== undefined && !isOrder(order)) {
    throw new AspectConfigurationError(
      "@Aspect requires a number as its order",
    );
  }
  if (!INSTANTIATION_MODELS.includes(instantiation)) {
    throw new AspectConfigurationError(
      `@Aspect does not support the instantiation model ${String(instantiation)}`,
    );
  }
  const metadata: AspectMetadata = { order, instantiation };
  return (target) => {
    Injectable()(target);
    Reflect.defineMetadata(ASPECT_METADATA, metadata, target);
  };
}

/** Before or after advice and its parameter for the shape `S`. */
type BeforeOrAfterDecorator<S extends Shape> = AdviceDecorator<
  S,
  (joinPoint: JoinPoint<S>) => AdviceResult<S>
>;

/** After-returning advice and its parameters for the shape `S`. */
type AfterReturningDecorator<S extends Shape> = AdviceDecorator<
  S,
  (
    joinPoint: JoinPoint<S>,
    result: AdviceValue<S["returns"]>,
  ) => AdviceResult<S>
>;

/** After-throwing advice and its parameters for the shape `S`. */
type AfterThrowingDecorator<S extends Shape, E> = AdviceDecorator<
  S,
  (joinPoint: JoinPoint<S>, error: E) => AdviceResult<S>
>;

/** Around advice and its parameter for the shape `S`. */
type AroundDecorator<S extends Shape> = AdviceDecorator<
  AnyShape,
  (joinPoint: ProceedingJoinPoint<S>) => S["returns"]
>;

/**
 * Runs before the join point. An error prevents the join point from running.
 *
 * Every advice decorator accepts an annotation in place of a pointcut:
 * `@Before(Audited)` is `@Before(Pointcut.annotated(Audited))`.
 */
export function Before<S extends Shape>(
  pointcut: Pointcut<S>,
): BeforeOrAfterDecorator<S>;
export function Before<A extends AnnotationLike<any>>(
  annotation: A,
): BeforeOrAfterDecorator<ShapeOf<A>>;
export function Before(
  pointcut: Pointcut<Shape> | AnnotationLike<any>,
): BeforeOrAfterDecorator<any> {
  return adviceDecorator("before", pointcut);
}

/** Runs after the join point, whatever its outcome (finally). */
export function After<S extends Shape>(
  pointcut: Pointcut<S>,
): BeforeOrAfterDecorator<S>;
export function After<A extends AnnotationLike<any>>(
  annotation: A,
): BeforeOrAfterDecorator<ShapeOf<A>>;
export function After(
  pointcut: Pointcut<Shape> | AnnotationLike<any>,
): BeforeOrAfterDecorator<any> {
  return adviceDecorator("after", pointcut);
}

/** Runs after a normal completion with the settled result; cannot replace it. */
export function AfterReturning<S extends Shape>(
  pointcut: Pointcut<S>,
): AfterReturningDecorator<S>;
export function AfterReturning<A extends AnnotationLike<any>>(
  annotation: A,
): AfterReturningDecorator<ShapeOf<A>>;
export function AfterReturning(
  pointcut: Pointcut<Shape> | AnnotationLike<any>,
): AfterReturningDecorator<any> {
  return adviceDecorator("afterReturning", pointcut);
}

/**
 * Runs when the join point fails. With `throwing`, only for errors that are
 * `instanceof` that class.
 */
export function AfterThrowing<S extends Shape, E = unknown>(
  pointcut: Pointcut<S>,
  options?: { throwing: Class<E> },
): AfterThrowingDecorator<S, E>;
export function AfterThrowing<A extends AnnotationLike<any>, E = unknown>(
  annotation: A,
  options?: { throwing: Class<E> },
): AfterThrowingDecorator<ShapeOf<A>, E>;
export function AfterThrowing(
  pointcut: Pointcut<Shape> | AnnotationLike<any>,
  options?: { throwing: Class },
): AfterThrowingDecorator<any, any> {
  return adviceDecorator("afterThrowing", pointcut, options?.throwing);
}

/** Surrounds the join point; the return value becomes the caller's result. */
export function Around<S extends Shape>(
  pointcut: Pointcut<S>,
): AroundDecorator<S>;
export function Around<A extends AnnotationLike<any>>(
  annotation: A,
): AroundDecorator<ShapeOf<A>>;
export function Around(
  pointcut: Pointcut<Shape> | AnnotationLike<any>,
): AroundDecorator<any> {
  return adviceDecorator("around", pointcut);
}

/**
 * Class the `@Advisor` decorator accepts: a static `pointcut`, and instances
 * with `advice` and an optional `order`.
 */
export type AdvisorType = Class<Pick<PointcutAdvisor, "advice" | "order">> & {
  readonly pointcut: PointcutLike;
};

/**
 * Marks a class as an advisor and as a Nest provider (`@Injectable()`).
 *
 * The pointcut is the static member `pointcut`: the weaver matches it while
 * the container instantiates providers, before an instance of the advisor
 * exists. The instance supplies `advice` and `order`.
 *
 * Throws `AspectConfigurationError` when the class has no static pointcut.
 */
export function Advisor(): <T extends AdvisorType>(target: T) => void {
  return (target) => {
    if (!isPointcutLike((target as Partial<AdvisorType>).pointcut)) {
      throw new AspectConfigurationError(
        `@Advisor requires ${target.name} to declare its pointcut as the static member "pointcut"`,
      );
    }
    Injectable()(target);
    Reflect.defineMetadata(ADVISOR_METADATA, true, target);
  };
}

/** True when the class itself is decorated with `@Aspect`. */
export function isAspect(type: Class): boolean {
  return Reflect.hasOwnMetadata(ASPECT_METADATA, type);
}

/** `AspectMetadata` of the class itself; `undefined` when it is not an aspect. */
export function getAspectMetadata(type: Class): AspectMetadata | undefined {
  return Reflect.getOwnMetadata(ASPECT_METADATA, type);
}

/**
 * Advice declared on the class and its superclasses: the entries of the
 * furthest superclass first, each class in declaration order. A class that
 * declares advice on a method replaces the advice its superclasses declare on
 * the method of that name. Empty for a class without advice decorators,
 * whether or not it is an aspect.
 */
export function getAdviceMetadata(type: Class): readonly AdviceMetadata[] {
  const perClass: (readonly AdviceMetadata[])[] = [];
  const redeclared = new Set<string | symbol>();
  for (const current of constructorChain(type)) {
    const own = ownAdviceMetadata(current);
    perClass.unshift(own.filter((entry) => !redeclared.has(entry.methodName)));
    for (const entry of own) {
      redeclared.add(entry.methodName);
    }
  }
  return perClass.flat();
}

/** True when the class itself is decorated with `@Advisor`. */
export function isAdvisor(type: Class): boolean {
  return Reflect.hasOwnMetadata(ADVISOR_METADATA, type);
}

/** The static pointcut of an `@Advisor` class. */
export function getAdvisorPointcut(type: Class): PointcutLike {
  return (type as AdvisorType).pointcut;
}
