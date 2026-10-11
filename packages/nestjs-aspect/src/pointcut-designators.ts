// Slice A. Exported signatures are frozen; the bodies are the slice's work.

import type {
  AndShape,
  Annotation,
  AnyShape,
  Class,
  ClassFilter,
  Fn,
  JoinPointKind,
  MethodMatcher,
  MethodRef,
  NestAnnotation,
  OrShape,
  Pointcut,
  Shape,
} from "./types";

/** `P.args` matcher for one argument of any value. */
export const ANY: unique symbol = Symbol.for("nestjs-aspect:any");

/** `P.args` matcher for zero or more trailing arguments. Valid in last position only. */
export const REST: unique symbol = Symbol.for("nestjs-aspect:rest");

export type MethodKeys<T> = {
  [K in keyof T]-?: T[K] extends Fn ? K : never;
}[keyof T];

export type ArgMatcher = Class | typeof ANY | typeof REST;

export type ArgsOf<M extends readonly ArgMatcher[]> = M extends readonly [
  infer H,
  ...infer R extends readonly ArgMatcher[],
]
  ? H extends typeof REST
    ? unknown[]
    : [H extends Class<infer I> ? I : unknown, ...ArgsOf<R>]
  : [];

/** Shape of `P.all(...)`: the shapes folded with `and`. */
export type AllShapes<Ps extends readonly Pointcut<any>[]> =
  Ps extends readonly [
    Pointcut<infer H extends Shape>,
    ...infer R extends readonly Pointcut<any>[],
  ]
    ? R extends readonly []
      ? H
      : AllShapes<R> extends infer T extends Shape
        ? AndShape<H, T>
        : never
    : AnyShape;

/** Shape of `P.any(...)`: the shapes folded with `or`. */
export type AnyShapes<Ps extends readonly Pointcut<any>[]> =
  Ps extends readonly [
    Pointcut<infer H extends Shape>,
    ...infer R extends readonly Pointcut<any>[],
  ]
    ? R extends readonly []
      ? H
      : AnyShapes<R> extends infer T extends Shape
        ? OrShape<H, T>
        : never
    : AnyShape;

export interface PointcutFactory {
  /**
   * Execution of one specific method. Carries that method's exact signature.
   * Matches when the target type is `type` or a subclass and the member is
   * the method `name`. The only designator that selects a Nest lifecycle
   * hook.
   */
  method<C extends Class, K extends MethodKeys<InstanceType<C>>>(
    type: C,
    name: K,
  ): Pointcut<{
    target: InstanceType<C>;
    args: Parameters<InstanceType<C>[K]>;
    returns: ReturnType<InstanceType<C>[K]>;
    ann: never;
  }>;

  /** `within(Type)`: members declared on one of the given classes. */
  within<C extends Class[]>(
    ...types: C
  ): Pointcut<{
    target: InstanceType<C[number]>;
    args: readonly unknown[];
    returns: unknown;
    ann: never;
  }>;

  /** `target(Type)`: the target type is `type` or a subclass. */
  target<C extends Class>(
    type: C,
  ): Pointcut<{
    target: InstanceType<C>;
    args: readonly unknown[];
    returns: unknown;
    ann: never;
  }>;

  /**
   * Member name pattern. In a string, `*` matches any run of characters and
   * the pattern covers the whole name. Symbol-named members never match.
   */
  name(pattern: string | RegExp): Pointcut<AnyShape>;

  /**
   * Join point kind. `"getter"` and `"setter"` are the only designators that
   * select accessors.
   */
  kind(kind: JoinPointKind): Pointcut<AnyShape>;

  /**
   * `@annotation(A)`: the member itself carries A. The method contract of the
   * annotation flows into the advice.
   */
  annotated<V, F extends Fn, N extends string>(
    a: Annotation<V, F, N>,
  ): Pointcut<{
    target: object;
    args: Parameters<F>;
    returns: ReturnType<F>;
    ann: N;
  }>;
  annotated<V>(a: NestAnnotation<V>): Pointcut<AnyShape>;

  /** `@within(A)`: the declaring class carries A. */
  withinAnnotated<V, F extends Fn, N extends string>(
    a: Annotation<V, F, N>,
  ): Pointcut<{
    target: object;
    args: readonly unknown[];
    returns: unknown;
    ann: N;
  }>;
  withinAnnotated<V>(a: NestAnnotation<V>): Pointcut<AnyShape>;

  /** `@target(A)`: the target class carries A. */
  targetAnnotated<V, F extends Fn, N extends string>(
    a: Annotation<V, F, N>,
  ): Pointcut<{
    target: object;
    args: readonly unknown[];
    returns: unknown;
    ann: N;
  }>;
  targetAnnotated<V>(a: NestAnnotation<V>): Pointcut<AnyShape>;

  /**
   * `args(...)`: run-time argument check (runtime matcher). A class matches
   * an argument that is `instanceof` it; `String`, `Number`, `Boolean`,
   * `BigInt` and `Symbol` also match their primitives. `P.ANY` matches one
   * argument and `P.REST` the remaining ones. Without `P.REST` the argument
   * count must equal the matcher count.
   */
  args<M extends readonly ArgMatcher[]>(
    ...matchers: M
  ): Pointcut<{
    target: object;
    args: ArgsOf<M>;
    returns: unknown;
    ann: never;
  }>;

  /**
   * `bean(name)`: one registration of the class has a matching provider
   * token. A string matches a string token exactly or, for a class or symbol
   * token, its name or description; a `RegExp` tests the same text; a class
   * matches the identical token.
   */
  bean(token: string | RegExp | Class): Pointcut<AnyShape>;

  /**
   * Providers and controllers declared in a Nest module. With `transitive`,
   * also those declared in the modules it imports, at any depth.
   */
  inModule(
    module: Class,
    options?: { transitive?: boolean },
  ): Pointcut<AnyShape>;

  /**
   * Reflect metadata `key` is defined on the member: on the member function
   * (as Nest's `SetMetadata` stores it) or as own metadata of
   * `(DeclaringClass.prototype, memberName)`. `predicate` receives the value.
   */
  metadata(
    key: unknown,
    predicate?: (value: unknown, method: MethodRef) => boolean,
  ): Pointcut<AnyShape>;

  /** Custom pointcut from a class filter and a method matcher. */
  matching(parts: {
    classFilter?: ClassFilter;
    methodMatcher?: MethodMatcher;
  }): Pointcut<AnyShape>;

  /** Conjunction. Without arguments it matches every default join point. */
  all<Ps extends readonly Pointcut<any>[]>(
    ...pointcuts: Ps
  ): Pointcut<AllShapes<Ps>>;

  /** Disjunction. Without arguments it matches nothing. */
  any<Ps extends readonly Pointcut<any>[]>(
    ...pointcuts: Ps
  ): Pointcut<AnyShapes<Ps>>;

  readonly ANY: typeof ANY;
  readonly REST: typeof REST;
}

function notImplemented(): never {
  throw new Error("not implemented");
}

/** Pointcut designators. */
export const P: PointcutFactory = {
  method: notImplemented,
  within: notImplemented,
  target: notImplemented,
  name: notImplemented,
  kind: notImplemented,
  annotated: notImplemented,
  withinAnnotated: notImplemented,
  targetAnnotated: notImplemented,
  args: notImplemented,
  bean: notImplemented,
  inModule: notImplemented,
  metadata: notImplemented,
  matching: notImplemented,
  all: notImplemented,
  any: notImplemented,
  ANY,
  REST,
};
