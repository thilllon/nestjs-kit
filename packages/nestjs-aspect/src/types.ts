// The contracts the source files share: shapes, annotations, matching input,
// pointcuts, join points, the advisor API and the interceptor chain.

import type { InjectionToken } from "@nestjs/common";
import type { ReflectableDecorator } from "@nestjs/core";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Fn = (...args: any[]) => any;

export type Class<T = any> = abstract new (...args: any[]) => T;

/** Static shape a pointcut guarantees for every join point it matches. */
export interface Shape {
  target: object;
  args: readonly unknown[];
  returns: unknown;
  /** Annotation names guaranteed to be present on every matched join point. */
  ann: string;
}

/** The shape of a pointcut that guarantees nothing. */
export interface AnyShape extends Shape {
  target: object;
  args: readonly unknown[];
  returns: unknown;
  ann: never;
}

/** Shape of `a.and(b)`. */
export type AndShape<A extends Shape, B extends Shape> = {
  target: A["target"] & B["target"];
  args: A["args"] & B["args"];
  returns: A["returns"] & B["returns"];
  ann: A["ann"] | B["ann"];
};

/** Shape of `a.or(b)`: an annotation stays guaranteed only when both sides guarantee it. */
export type OrShape<A extends Shape, B extends Shape> = {
  target: A["target"] | B["target"];
  args: A["args"] | B["args"];
  returns: A["returns"] | B["returns"];
  ann: Extract<A["ann"], B["ann"]>;
};

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/**
 * `unknown` for the descriptor of an accessor when `F` is no method contract
 * (exactly `Fn`), `never` otherwise. A method contract cannot hold for an
 * accessor, and a member whose type is a function goes through the method
 * overload.
 */
export type AccessorGuard<F extends Fn, T> = [T] extends [Fn]
  ? never
  : (<G>() => G extends F ? 1 : 2) extends <G>() => G extends Fn ? 1 : 2
    ? unknown
    : never;

export type MethodOrClassDecorator<F extends Fn> = {
  <T extends F>(
    target: object,
    key: string | symbol,
    desc: TypedPropertyDescriptor<T>,
  ): void;
  <T>(
    target: object,
    key: string | symbol,
    desc: TypedPropertyDescriptor<T> & AccessorGuard<F, T>,
  ): void;
  (target: Class): void;
};

/**
 * Typed metadata decorator. `V` is the value type, `F` the method contract the
 * annotation can be applied to and `N` the name literal that lets the compiler
 * track which annotations a pointcut guarantees.
 *
 * The name is the identity of an annotation: two annotations created with one
 * name read and write the same metadata.
 */
export interface Annotation<V, F extends Fn = Fn, N extends string = string> {
  readonly annotationName: N;
  /** A method that carries the annotation must be matched by an advisor. */
  readonly requiresAdvice: boolean;
  // biome-ignore lint/suspicious/noConfusingVoidType: void marks an annotation that takes no value
  (...value: [V] extends [void] ? [] : [value: V]): MethodOrClassDecorator<F>;
}

/** Decorator created by Nest's `Reflector.createDecorator`. */
export type NestAnnotation<V> = ReflectableDecorator<any, V>;

/** Everything `P.annotated()` and `jp.findAnnotation()` accept. */
export type AnnotationLike<V = unknown> =
  | Annotation<V, any, any>
  | NestAnnotation<V>;

/** Where an annotation lookup found its value. */
export type AnnotationSource = "method" | "declaringType" | "targetType";

/**
 * Result of an annotation lookup. A match with `value: undefined` is an
 * annotation that takes no value.
 */
export interface AnnotationMatch<V> {
  readonly value: V;
  readonly source: AnnotationSource;
}

/** One annotation application, as stored under `ANNOTATIONS_METADATA`. */
export interface AnnotationRecord {
  readonly name: string;
  readonly value: unknown;
  readonly requiresAdvice: boolean;
}

// ---------------------------------------------------------------------------
// Matching input: what class filters and method matchers see
// ---------------------------------------------------------------------------

export type JoinPointKind = "method" | "getter" | "setter";

/** One registration of a class in the Nest container. */
export interface BeanRef {
  /** Provider token (for a controller, the controller class). */
  readonly token: InjectionToken;
  /** Class of the module that declares the provider. */
  readonly module: Class;
}

/**
 * A class as class filters see it. Weaving replaces members of the class
 * prototype, so its granularity is the class: one `ClassRef` describes every
 * registration of the class in one application.
 */
export interface ClassRef {
  readonly type: Class;
  /**
   * Registrations of the class in the application. Empty for a class that is
   * described outside a container.
   */
  readonly beans: readonly BeanRef[];
  /**
   * True when `imported` is within the transitive imports of `root`, `root`
   * itself excluded. False outside a container.
   */
  reachesModule(root: Class, imported: Class): boolean;
}

/** A method or accessor execution, as method matchers see it. */
export interface MethodRef {
  /** Class whose prototype defines the member. */
  readonly declaringType: Class;
  /** Concrete class being woven; equal to `classRef.type`. */
  readonly targetType: Class;
  readonly classRef: ClassRef;
  readonly name: string | symbol;
  readonly kind: JoinPointKind;
  /**
   * The function the join point executes: the method, the getter or the
   * setter, never a dispatcher stub.
   */
  readonly original: Fn;
  /**
   * True for a native `async` function and for a method whose
   * `design:returntype` metadata is `Promise`.
   */
  readonly isAsync: boolean;
}

// ---------------------------------------------------------------------------
// Pointcuts
// ---------------------------------------------------------------------------

export interface ClassFilter {
  matches(type: ClassRef): boolean;
}

export interface MethodMatcher {
  /**
   * Static decision, evaluated once per (class, member) at weaving time. For a
   * runtime matcher, true means "may match": the decision is completed by
   * `matchesRuntime` on every call.
   */
  matches(method: MethodRef): boolean;
  /** True when `matchesRuntime` must run on every call. */
  readonly isRuntime: boolean;
  /**
   * Evaluated on every call, only when `isRuntime` is true and `matches`
   * returned true.
   */
  matchesRuntime?(method: MethodRef, args: readonly unknown[]): boolean;
}

/**
 * Low-level pointcut. It matches a member when
 * `classFilter.matches(method.classRef) && methodMatcher.matches(method)`.
 * The class filter is a necessary condition that lets the weaver skip whole
 * classes; a composite whose class condition is not a conjunction (`not()`,
 * `or()`) widens its class filter and decides in its method matcher.
 */
export interface PointcutLike {
  readonly classFilter: ClassFilter;
  readonly methodMatcher: MethodMatcher;
  /**
   * Opt-in for join points that broad pointcuts leave out: Nest lifecycle
   * hooks (selected by `P.method`) and accessors (selected by `P.kind`).
   * Returns true when the pointcut statically matches `method` through a
   * designator that selects it explicitly. A pointcut without this member
   * matches default join points only. See `matchesStatically`.
   */
  includesExplicitly?(method: MethodRef): boolean;
  /**
   * Names of the annotations present on every join point the pointcut
   * matches; the run-time counterpart of `Shape["ann"]`.
   */
  readonly guarantees?: ReadonlySet<string>;
}

/** Typed, composable pointcut produced by `P`. */
export interface Pointcut<S extends Shape = AnyShape> extends PointcutLike {
  /** Phantom member that carries the shape; never set at run time. */
  readonly __shape?: S;
  readonly guarantees: ReadonlySet<string>;
  includesExplicitly(method: MethodRef): boolean;
  and<S2 extends Shape>(other: Pointcut<S2>): Pointcut<AndShape<S, S2>>;
  or<S2 extends Shape>(other: Pointcut<S2>): Pointcut<OrShape<S, S2>>;
  not(): Pointcut<AnyShape>;
}

export type ShapeOf<PC> = PC extends Pointcut<infer S> ? S : never;

// ---------------------------------------------------------------------------
// Join points
// ---------------------------------------------------------------------------

export interface JoinPointSignature {
  readonly name: string | symbol;
  readonly declaringType: Class;
  readonly targetType: Class;
}

export interface JoinPoint<S extends Shape> {
  readonly kind: JoinPointKind;
  readonly target: S["target"];
  /** Frozen. `proceedWith` is the way to run the join point with other arguments. */
  readonly args: Readonly<S["args"]>;
  readonly signature: JoinPointSignature;
  readonly isAsync: boolean;
  /**
   * Value of an annotation the pointcut guarantees. Lookup order: the method,
   * the declaring class, the target class. Throws `AspectUsageError` when the
   * annotation is absent.
   */
  annotation<V, N extends S["ann"]>(a: Annotation<V, any, N>): V;
  /** Same lookup as `annotation`; `undefined` when the annotation is absent. */
  findAnnotation<V>(a: Annotation<V, any, any>): V | undefined;
  // Spelled without the `NestAnnotation` alias, through which `V` is not inferred.
  findAnnotation<V>(a: ReflectableDecorator<any, V>): V | undefined;
  /**
   * The delegate that implements the interface `token` for the target, which
   * an aspect introduces with `@DeclareParents`. Throws `AspectUsageError`
   * when the interface is not introduced into the class of the target.
   */
  introduced<I extends object>(token: Class<I>): I;
  /** `"UserService.findById(1)"`. */
  toString(): string;
}

export interface ProceedingJoinPoint<S extends Shape> extends JoinPoint<S> {
  /** Runs the rest of the chain. Can be called more than once. */
  proceed(): S["returns"];
  /** Runs the rest of the chain with replaced arguments. */
  proceedWith(
    ...args: S["args"] extends readonly unknown[] ? S["args"] : never
  ): S["returns"];
}

export type JP<PC> = JoinPoint<ShapeOf<PC>>;

export type PJP<PC> = ProceedingJoinPoint<ShapeOf<PC>>;

// ---------------------------------------------------------------------------
// Low-level advisor API
// ---------------------------------------------------------------------------

export interface MethodInvocation {
  readonly method: MethodRef;
  readonly target: object;
  /** Frozen copy of the arguments of the call or of `cloneFromHere(args)`. */
  readonly args: readonly unknown[];
  readonly joinPoint: JoinPoint<AnyShape>;
  /**
   * Runs the next interceptor whose runtime matcher accepts the arguments, or
   * the original function at the end of the chain. An invocation advances as
   * it proceeds: call it once per invocation object.
   */
  proceed(): unknown;
  /**
   * A new invocation positioned where this one is, optionally with replaced
   * arguments. Proceeding more than once goes through a clone each time.
   */
  cloneFromHere(args?: readonly unknown[]): MethodInvocation;
}

export interface MethodInterceptor {
  invoke(invocation: MethodInvocation): unknown;
}

export type AdviceKind =
  | "around"
  | "before"
  | "after"
  | "afterReturning"
  | "afterThrowing";

/**
 * Returns the aspect instance that serves a call, or `undefined` while it does
 * not exist yet. `target` selects the instance for the per-target and
 * per-class instantiation models.
 */
export type AspectInstanceResolver = (
  aspectType: Class,
  method: MethodRef,
  target: object,
) => object | undefined;

/** Advice declared by an advice decorator on an aspect method. */
export interface AspectAdvice {
  readonly kind: AdviceKind;
  readonly aspectType: Class;
  readonly methodName: string | symbol;
  /** `afterThrowing` only: the advice runs for errors that are `instanceof` this class. */
  readonly throwing?: Class;
  /** Bound `AspectInstanceResolver`. */
  resolveAspect(method: MethodRef, target: object): object | undefined;
}

/**
 * Marker for anything an `AdviceAdapter` converts to a `MethodInterceptor`.
 * Built in: `MethodInterceptor` and `AspectAdvice`.
 */
export type Advice = MethodInterceptor | AspectAdvice | object;

export interface PointcutAdvisor {
  pointcut: PointcutLike;
  advice: Advice;
  /** Lower runs first (higher precedence). Unspecified is the lowest precedence. */
  order?: number;
}

/** What an advice adapter receives besides the advice. One per application. */
export interface InterceptorContext {
  readonly returnValues: ReturnValueAdapterRegistry;
}

/** SPI that adds an advice kind. */
export interface AdviceAdapter {
  supports(advice: Advice): boolean;
  toInterceptor(advice: Advice, context: InterceptorContext): MethodInterceptor;
}

export interface AdviceAdapterRegistry {
  /** Throws `AspectConfigurationError` when no adapter supports the advice. */
  toInterceptor(advice: Advice, context: InterceptorContext): MethodInterceptor;
}

/** SPI that lets advice follow the settlement of an asynchronous result. */
export interface ReturnValueAdapter<T = unknown> {
  supports(value: unknown): value is T;
  /** Runs `cb` with the resolved value, waits for it and keeps the value. */
  onSuccess(value: T, cb: (resolved: unknown) => unknown): T;
  /** Runs `cb` with the error; `cb` rethrows the error that propagates. */
  onError(value: T, cb: (error: unknown) => unknown): T;
  /** Runs `cb` after settlement, waits for it and keeps the outcome. */
  finally(value: T, cb: () => unknown): T;
}

export interface ReturnValueAdapterRegistry {
  /** First registered adapter that supports the value. */
  find(value: unknown): ReturnValueAdapter | undefined;
}

// ---------------------------------------------------------------------------
// Aspect metadata and compiled advisors
// ---------------------------------------------------------------------------

export type AspectInstantiation = "singleton" | "perTarget" | "perClass";

export interface AspectOptions {
  /** Lower runs first (higher precedence). Unspecified is the lowest precedence. */
  order?: number;
  instantiation?: AspectInstantiation;
}

/** Value stored under `ASPECT_METADATA`. */
export interface AspectMetadata {
  readonly order: number | undefined;
  readonly instantiation: AspectInstantiation;
}

/**
 * One advice decorator application, stored under `ADVICE_METADATA`. The
 * position in the stored array is the declaration order.
 */
export interface AdviceMetadata {
  readonly kind: AdviceKind;
  readonly pointcut: PointcutLike;
  readonly methodName: string | symbol;
  readonly throwing?: Class;
}

/** Where an advisor comes from; used by reports and error messages. */
export interface AdvisorSource {
  /** Aspect class or `@Advisor` class. */
  readonly type: Class;
  /** Advice method and kind, for an advisor compiled from an aspect. */
  readonly methodName?: string | symbol;
  readonly kind?: AdviceKind;
}

/**
 * An advisor with the keys that order it. `sortAdvisors` compares `order`
 * ascending (undefined last), then `registration`, then `kindRank`, then
 * `declaration`.
 */
export interface AdvisorDescriptor {
  readonly pointcut: PointcutLike;
  readonly advice: Advice;
  readonly order: number | undefined;
  /** Position of the aspect or advisor class among those of the application. */
  readonly registration: number;
  /**
   * Position of the advice kind within one aspect: around 0, before 1,
   * after 2, afterReturning 3, afterThrowing 4. 0 for other advisors.
   */
  readonly kindRank: number;
  /** Declaration index within the aspect. 0 for other advisors. */
  readonly declaration: number;
  readonly source: AdvisorSource;
}

// ---------------------------------------------------------------------------
// Interceptor chain
// ---------------------------------------------------------------------------

/** A method matcher with `isRuntime` and the `matchesRuntime` it requires. */
export type RuntimeMethodMatcher = MethodMatcher &
  Required<Pick<MethodMatcher, "matchesRuntime">>;

export interface ChainLink {
  readonly interceptor: MethodInterceptor;
  /**
   * Present when the advisor's method matcher is a runtime matcher; the link
   * is skipped on a call for which `matchesRuntime` returns a falsy value.
   */
  readonly runtimeMatcher?: RuntimeMethodMatcher;
  readonly advisor: AdvisorDescriptor;
}

/** Cached per application and per (class, member). */
export interface InterceptorChain {
  readonly method: MethodRef;
  readonly links: readonly ChainLink[];
}

export interface ChainOptions {
  readonly adviceAdapters: AdviceAdapterRegistry;
  readonly returnValues: ReturnValueAdapterRegistry;
}
