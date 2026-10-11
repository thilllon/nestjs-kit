// Slice B. Exported signatures are frozen; the bodies are the slice's work.

import type {
  AdviceMetadata,
  AnyShape,
  AspectMetadata,
  AspectOptions,
  Class,
  Fn,
  JoinPoint,
  Pointcut,
  ProceedingJoinPoint,
  Shape,
} from "./types";

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

/** Own Reflect metadata of an `@AopAdvisor` class constructor: `true`. */
export const ADVISOR_METADATA: unique symbol = Symbol.for(
  "nestjs-aspect:advisor",
);

/**
 * Return type required of before, after, afterReturning and afterThrowing
 * advice: `void`, or also a promise when the join point is or may be
 * asynchronous.
 */
export type AdviceResult<S extends Shape> = [S["returns"]] extends [
  PromiseLike<any>,
]
  ? void | PromiseLike<void>
  : unknown extends S["returns"]
    ? void | PromiseLike<void>
    : // biome-ignore lint/suspicious/noConfusingVoidType: void is the return type required of synchronous advice
      void;

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

export type AdviceDecorator<S extends Shape, F extends Fn> = <T extends F>(
  target: object,
  key: string | symbol,
  desc: TypedPropertyDescriptor<T> & AsyncGuard<S, T>,
) => void;

/**
 * Marks a class as an aspect and as a Nest provider (`@Injectable()`), and
 * stores `AspectMetadata` with `instantiation` defaulting to `"singleton"`.
 */
export function Aspect(_options?: AspectOptions): ClassDecorator {
  throw new Error("not implemented");
}

/** Runs before the join point. An error prevents the join point from running. */
export function Before<S extends Shape>(
  _pc: Pointcut<S>,
): AdviceDecorator<S, (jp: JoinPoint<S>) => AdviceResult<S>> {
  throw new Error("not implemented");
}

/** Runs after the join point, whatever its outcome (finally). */
export function After<S extends Shape>(
  _pc: Pointcut<S>,
): AdviceDecorator<S, (jp: JoinPoint<S>) => AdviceResult<S>> {
  throw new Error("not implemented");
}

/** Runs after a normal completion with the awaited result; cannot replace it. */
export function AfterReturning<S extends Shape>(
  _pc: Pointcut<S>,
): AdviceDecorator<
  S,
  (jp: JoinPoint<S>, result: Awaited<S["returns"]>) => AdviceResult<S>
> {
  throw new Error("not implemented");
}

/**
 * Runs when the join point fails. With `throwing`, only for errors that are
 * `instanceof` that class.
 */
export function AfterThrowing<S extends Shape, E = unknown>(
  _pc: Pointcut<S>,
  _options?: { throwing: Class<E> },
): AdviceDecorator<S, (jp: JoinPoint<S>, error: E) => AdviceResult<S>> {
  throw new Error("not implemented");
}

/** Surrounds the join point; the return value becomes the caller's result. */
export function Around<S extends Shape>(
  _pc: Pointcut<S>,
): AdviceDecorator<AnyShape, (jp: ProceedingJoinPoint<S>) => S["returns"]> {
  throw new Error("not implemented");
}

/**
 * Marks a class whose instances implement `PointcutAdvisor` as an advisor and
 * as a Nest provider (`@Injectable()`).
 */
export function AopAdvisor(): ClassDecorator {
  throw new Error("not implemented");
}

/** True when the class itself is decorated with `@Aspect`. */
export function isAspect(_type: Class): boolean {
  throw new Error("not implemented");
}

/** `AspectMetadata` of the class itself; `undefined` when it is not an aspect. */
export function getAspectMetadata(_type: Class): AspectMetadata | undefined {
  throw new Error("not implemented");
}

/**
 * Advice declared on the class and its superclasses: the entries of the
 * furthest superclass first, each class in declaration order. Empty for a
 * class without advice decorators, whether or not it is an aspect.
 */
export function getAdviceMetadata(_type: Class): readonly AdviceMetadata[] {
  throw new Error("not implemented");
}

/** True when the class itself is decorated with `@AopAdvisor`. */
export function isAopAdvisor(_type: Class): boolean {
  throw new Error("not implemented");
}
