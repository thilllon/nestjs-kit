import "reflect-metadata";
import type { InjectionToken } from "@nestjs/common";
import {
  hasClassAnnotation,
  hasMethodAnnotation,
  isAnnotation,
} from "./annotation";
import { AopConfigurationError } from "./errors";
import { createPointcut } from "./pointcut";
import type {
  AndShape,
  Annotation,
  AnnotationLike,
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

export type ArgMatcher =
  | Class
  | BigIntConstructor
  | SymbolConstructor
  | typeof ANY
  | typeof REST;

/** Argument type one `P.args` matcher stands for. */
export type ArgOf<H> = H extends StringConstructor
  ? string
  : H extends NumberConstructor
    ? number
    : H extends BooleanConstructor
      ? boolean
      : H extends BigIntConstructor
        ? bigint
        : H extends SymbolConstructor
          ? symbol
          : H extends Class<infer I>
            ? I
            : unknown;

export type ArgsOf<M extends readonly ArgMatcher[]> = M extends readonly [
  infer H,
  ...infer R extends readonly ArgMatcher[],
]
  ? H extends typeof REST
    ? unknown[]
    : [ArgOf<H>, ...ArgsOf<R>]
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
   * `BigInt` and `Symbol` match their primitives and type the argument as
   * the primitive. `P.ANY` matches one
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
   * token. A string is tested against a string token or, for a class or
   * symbol token, its name or description; `*` in it matches any run of
   * characters and the pattern covers the whole text. A `RegExp` tests the
   * same text; a class matches the identical token.
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

const PRIMITIVE_TYPES: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [String, "string"],
  [Number, "number"],
  [Boolean, "boolean"],
  [BigInt, "bigint"],
  [Symbol, "symbol"],
]);

function isTypeOrSubclass(type: Class, base: Class): boolean {
  return type === base || type.prototype instanceof base;
}

function typeFilter(base: Class): ClassFilter {
  return { matches: (classRef) => isTypeOrSubclass(classRef.type, base) };
}

function staticMatcher(matches: (method: MethodRef) => boolean): MethodMatcher {
  return { isRuntime: false, matches };
}

/** A copy without the flags that make `test` depend on `lastIndex`. */
function stateless(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
}

/** Whole-text test of a string in which `*` matches any run of characters. */
function textTest(pattern: string | RegExp): (text: string) => boolean {
  if (typeof pattern !== "string") {
    const expression = stateless(pattern);
    return (text) => expression.test(text);
  }
  if (!pattern.includes("*")) {
    return (text) => text === pattern;
  }
  const expression = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
    "s",
  );
  return (text) => expression.test(text);
}

function tokenText(token: InjectionToken): string | undefined {
  if (typeof token === "string") {
    return token;
  }
  if (typeof token === "symbol") {
    return token.description;
  }
  return typeof token === "function" ? token.name : undefined;
}

/** Guaranteed names of an annotation; a Nest decorator has none. */
function annotationNames(annotation: AnnotationLike<any>): string[] {
  if (isAnnotation(annotation)) {
    return [annotation.annotationName];
  }
  if (
    typeof annotation !== "function" ||
    (annotation as { KEY?: unknown }).KEY === undefined
  ) {
    throw new AopConfigurationError(
      "Expected an annotation created by createAnnotation() or Reflector.createDecorator()",
    );
  }
  return [];
}

function matchesArgument(matcher: Fn, value: unknown): boolean {
  return (
    value instanceof matcher || typeof value === PRIMITIVE_TYPES.get(matcher)
  );
}

function argsMatcher(matchers: readonly ArgMatcher[]): MethodMatcher {
  const restIndex = matchers.indexOf(REST);
  if (restIndex !== -1 && restIndex !== matchers.length - 1) {
    throw new AopConfigurationError(
      "P.REST is valid only as the last matcher of P.args()",
    );
  }
  const variadic = restIndex !== -1;
  const positional = variadic ? matchers.slice(0, -1) : matchers;
  for (const matcher of positional) {
    if (matcher !== ANY && typeof matcher !== "function") {
      throw new AopConfigurationError(
        "P.args() accepts classes, P.ANY and P.REST",
      );
    }
  }
  return {
    isRuntime: true,
    matches: () => true,
    matchesRuntime: (_method, args) => {
      if (
        variadic
          ? args.length < positional.length
          : args.length !== positional.length
      ) {
        return false;
      }
      return positional.every(
        (matcher, index) =>
          matcher === ANY || matchesArgument(matcher as Fn, args[index]),
      );
    },
  };
}

function annotated(annotation: AnnotationLike<any>): Pointcut<any> {
  return createPointcut({
    methodMatcher: staticMatcher((method) =>
      hasMethodAnnotation(annotation, method),
    ),
    guarantees: annotationNames(annotation),
  });
}

function withinAnnotated(annotation: AnnotationLike<any>): Pointcut<any> {
  return createPointcut({
    // The declaring type is the target type or one of its superclasses, and
    // class annotations are inherited.
    classFilter: {
      matches: (classRef) => hasClassAnnotation(annotation, classRef.type),
    },
    methodMatcher: staticMatcher((method) =>
      hasClassAnnotation(annotation, method.declaringType),
    ),
    guarantees: annotationNames(annotation),
  });
}

function targetAnnotated(annotation: AnnotationLike<any>): Pointcut<any> {
  return createPointcut({
    classFilter: {
      matches: (classRef) => hasClassAnnotation(annotation, classRef.type),
    },
    guarantees: annotationNames(annotation),
  });
}

/** Pointcut designators. */
export const P: PointcutFactory = {
  method: (type, name) =>
    createPointcut({
      classFilter: typeFilter(type),
      methodMatcher: staticMatcher(
        (method) => method.kind === "method" && method.name === name,
      ),
      includesExplicitly: () => true,
    }),

  within: (...types) =>
    createPointcut({
      classFilter: {
        matches: (classRef) =>
          types.some((type) => isTypeOrSubclass(classRef.type, type)),
      },
      methodMatcher: staticMatcher((method) =>
        types.includes(method.declaringType),
      ),
    }),

  target: (type) => createPointcut({ classFilter: typeFilter(type) }),

  name: (pattern) => {
    const test = textTest(pattern);
    return createPointcut({
      methodMatcher: staticMatcher(
        (method) => typeof method.name === "string" && test(method.name),
      ),
    });
  },

  kind: (kind) =>
    createPointcut({
      methodMatcher: staticMatcher((method) => method.kind === kind),
      includesExplicitly: () => kind !== "method",
    }),

  annotated,
  withinAnnotated,
  targetAnnotated,

  args: (...matchers) =>
    createPointcut({ methodMatcher: argsMatcher(matchers) }),

  bean: (token) => {
    let matchesToken: (candidate: InjectionToken) => boolean;
    if (typeof token === "function") {
      matchesToken = (candidate) => candidate === token;
    } else {
      const test = textTest(token);
      matchesToken = (candidate) => {
        const text = tokenText(candidate);
        return text !== undefined && test(text);
      };
    }
    return createPointcut({
      classFilter: {
        matches: (classRef) =>
          classRef.beans.some((bean) => matchesToken(bean.token)),
      },
    });
  },

  inModule: (module, options = {}) =>
    createPointcut({
      classFilter: {
        matches: (classRef) =>
          classRef.beans.some(
            (bean) =>
              bean.module === module ||
              (options.transitive === true &&
                classRef.reachesModule(module, bean.module)),
          ),
      },
    }),

  metadata: (key, predicate) =>
    createPointcut({
      methodMatcher: staticMatcher((method) => {
        const prototype = method.declaringType.prototype;
        let value: unknown;
        if (Reflect.hasOwnMetadata(key, method.original)) {
          value = Reflect.getOwnMetadata(key, method.original);
        } else if (Reflect.hasOwnMetadata(key, prototype, method.name)) {
          value = Reflect.getOwnMetadata(key, prototype, method.name);
        } else {
          return false;
        }
        return predicate === undefined || predicate(value, method);
      }),
    }),

  matching: (parts) =>
    createPointcut({
      classFilter: parts.classFilter,
      methodMatcher: parts.methodMatcher,
    }),

  all: (...pointcuts) =>
    pointcuts.length === 0
      ? createPointcut({})
      : pointcuts.reduce((result, pointcut) => result.and(pointcut)),

  any: (...pointcuts) =>
    pointcuts.length === 0
      ? createPointcut({ classFilter: { matches: () => false } })
      : pointcuts.reduce((result, pointcut) => result.or(pointcut)),

  ANY,
  REST,
};
