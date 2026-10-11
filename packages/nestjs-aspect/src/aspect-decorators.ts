// Aspect and advice decorators, their metadata keys and readers.

import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { AspectConfigurationError } from "./errors";
import { isPointcutLike } from "./pointcut";
import type {
  AdviceKind,
  AdviceMetadata,
  AnyShape,
  AspectMetadata,
  AspectOptions,
  Class,
  Fn,
  JoinPoint,
  Pointcut,
  PointcutAdvisor,
  PointcutLike,
  ProceedingJoinPoint,
  Shape,
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
type Deferred = PromiseLike<any> | { subscribe: Fn };

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
export type AsyncGuard<S extends Shape, T extends Fn> =
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
export type AdviceValue<R> = R extends { subscribe: Fn } ? any : Awaited<R>;

export type AdviceDecorator<S extends Shape, F extends Fn> = <T extends F>(
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
  pointcut: unknown,
  throwing?: Class,
): (target: object, key: string | symbol) => void {
  const decorator = `@${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
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

/** Runs before the join point. An error prevents the join point from running. */
export function Before<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<S, (jp: JoinPoint<S>) => AdviceResult<S>> {
  return adviceDecorator("before", pc);
}

/** Runs after the join point, whatever its outcome (finally). */
export function After<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<S, (jp: JoinPoint<S>) => AdviceResult<S>> {
  return adviceDecorator("after", pc);
}

/** Runs after a normal completion with the settled result; cannot replace it. */
export function AfterReturning<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<
  S,
  (jp: JoinPoint<S>, result: AdviceValue<S["returns"]>) => AdviceResult<S>
> {
  return adviceDecorator("afterReturning", pc);
}

/**
 * Runs when the join point fails. With `throwing`, only for errors that are
 * `instanceof` that class.
 */
export function AfterThrowing<S extends Shape, E = unknown>(
  pc: Pointcut<S>,
  options?: { throwing: Class<E> },
): AdviceDecorator<S, (jp: JoinPoint<S>, error: E) => AdviceResult<S>> {
  return adviceDecorator("afterThrowing", pc, options?.throwing);
}

/** Surrounds the join point; the return value becomes the caller's result. */
export function Around<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<AnyShape, (jp: ProceedingJoinPoint<S>) => S["returns"]> {
  return adviceDecorator("around", pc);
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
