// Introductions: `@DeclareParents`, its metadata, and the lookup of the
// delegate that implements an introduced interface for one object.

import "reflect-metadata";
import { AspectConfigurationError, AspectUsageError } from "./errors";
import { isPointcutLike } from "./pointcut";
import type { Class, ClassFilter, PointcutLike } from "./types";
import { constructorChain, isObject } from "./util";
import { resolveIntroduction } from "./weaving-registry";

/**
 * Own Reflect metadata of an aspect class constructor: `readonly
 * IntroductionMetadata[]`, one entry per `@DeclareParents`, in declaration
 * order.
 */
export const INTRODUCTION_METADATA: unique symbol = Symbol.for(
  "nestjs-aspect:introductions",
);

export interface DeclareParentsOptions<I extends object> {
  /**
   * Class that implements the introduced interface. Each target object gets
   * its own instance, created without arguments on first use.
   */
  use: new () => I;
  /**
   * When true, the members of the introduction replace members of that name
   * which the target class already has. Defaults to false: such a member
   * fails the bootstrap with `AspectConfigurationError`.
   */
  override?: boolean;
}

/** One `@DeclareParents` application. */
export interface IntroductionMetadata {
  readonly classFilter: ClassFilter;
  /** The abstract class that names the introduced interface. */
  readonly token: Class;
  readonly use: new () => object;
  readonly override: boolean;
  /** The static member of the aspect that declares the introduction. */
  readonly memberName: string | symbol;
}

/**
 * Decorator of a static member whose type is the introduced interface, which
 * the `use` class implements.
 */
export type IntroductionDecorator<I extends object> = <
  T extends Class,
  K extends keyof T,
>(
  target: T & (I extends T[K] ? unknown : never),
  key: K,
) => void;

/** Types that TypeScript records for a member whose type has no class. */
const ERASED_TYPES: readonly unknown[] = [
  Object,
  Function,
  Array,
  Promise,
  String,
  Number,
  Boolean,
  Symbol,
  BigInt,
];

function ownIntroductions(type: object): readonly IntroductionMetadata[] {
  return Reflect.getOwnMetadata(INTRODUCTION_METADATA, type) ?? [];
}

/**
 * Declares that the classes `target` matches implement an additional
 * interface, on a static member of an aspect:
 *
 * ```ts
 * @DeclareParents(P.inModule(ServiceModule), { use: DefaultUsageTracked })
 * static readonly mixin: UsageTracked;
 * ```
 *
 * The type of the member is the token of the interface: an abstract class,
 * because an interface leaves no value at run time. It is read from the
 * `design:type` metadata the compiler emits. `target` is a class filter or a
 * pointcut, of which the class filter is used: an introduction applies to
 * whole classes.
 *
 * The methods and accessors of the `use` class become members of each
 * matched class and run on the delegate of the object they are called on.
 * `isIntroduced`, `introduced` and `jp.introduced` reach the delegate.
 *
 * Throws `AspectConfigurationError` when `target` is no pointcut or class
 * filter, when `use` is no class, when the member is no static member, or
 * when its type is no class.
 */
export function DeclareParents<I extends object>(
  target: PointcutLike | ClassFilter,
  options: DeclareParentsOptions<I>,
): IntroductionDecorator<I> {
  const classFilter = isPointcutLike(target) ? target.classFilter : target;
  if (!isObject(classFilter) || typeof classFilter.matches !== "function") {
    throw new AspectConfigurationError(
      "@DeclareParents requires a pointcut or a class filter; an undefined one usually comes from a circular import",
    );
  }
  const { use, override = false } = options;
  if (typeof use !== "function") {
    throw new AspectConfigurationError(
      "@DeclareParents requires a class as its use option",
    );
  }
  return (aspect: object, key: PropertyKey) => {
    const memberName = key as string | symbol;
    if (typeof aspect !== "function") {
      throw new AspectConfigurationError(
        `@DeclareParents applies to a static member; ${aspect.constructor.name}.${String(memberName)} is an instance member`,
      );
    }
    const token: unknown = Reflect.getMetadata(
      "design:type",
      aspect,
      memberName,
    );
    if (typeof token !== "function" || ERASED_TYPES.includes(token)) {
      throw new AspectConfigurationError(
        `@DeclareParents requires an abstract class that names the introduced interface as the type of the static member ${aspect.name}.${String(memberName)}; an interface leaves no value at run time, and the type is read from the decorator metadata the compiler emits`,
      );
    }
    const entry: IntroductionMetadata = {
      classFilter,
      token: token as Class,
      use,
      override,
      memberName,
    };
    Reflect.defineMetadata(
      INTRODUCTION_METADATA,
      [...ownIntroductions(aspect), entry],
      aspect,
    );
  };
}

/**
 * Introductions declared on the class and its superclasses, those of the
 * furthest superclass first, each class in declaration order.
 */
export function getIntroductionMetadata(
  type: Class,
): readonly IntroductionMetadata[] {
  return [...constructorChain(type)].reverse().flatMap(ownIntroductions);
}

function className(target: object): string {
  const prototype: unknown = Object.getPrototypeOf(target);
  const type = isObject(prototype) ? prototype.constructor : undefined;
  return typeof type === "function" && type.name ? type.name : "the object";
}

/**
 * True when an aspect of the application `target` belongs to introduces the
 * interface `token` into the class of `target`. The members of the interface
 * are then members of `target`.
 */
export function isIntroduced<T, I extends object>(
  target: T,
  token: Class<I>,
): target is T & I {
  return isObject(target) && resolveIntroduction(target, token) !== undefined;
}

/**
 * The delegate that implements the introduced interface `token` for
 * `target`, created on first use. Throws `AspectUsageError` when no aspect of
 * the application of `target` introduces the interface into its class.
 */
export function introduced<I extends object>(
  target: object,
  token: Class<I>,
): I {
  const delegate = isObject(target)
    ? resolveIntroduction(target, token)
    : undefined;
  if (!delegate) {
    throw new AspectUsageError(
      `${token.name} is not introduced into ${isObject(target) ? className(target) : String(target)} by an aspect of its application`,
    );
  }
  return delegate as I;
}
