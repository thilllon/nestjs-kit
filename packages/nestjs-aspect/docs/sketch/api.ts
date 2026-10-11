/**
 * Type-level sketch of the public API. Declarations only, no runtime.
 * `pnpm exec tsc --project docs/sketch` must pass. Every `@ts-expect-error` below
 * marks a misuse the API is designed to reject at compile time.
 */

// biome-ignore-all lint/correctness/noUnusedVariables: the usage section declares classes and locals only to be type-checked
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: the usage section declares advice signatures without bodies

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
type Fn = (...args: any[]) => any;
type Class<T = any> = abstract new (...args: any[]) => T;

/** Static shape a pointcut guarantees for every join point it matches. */
interface Shape {
  target: object;
  args: readonly unknown[];
  returns: unknown;
  /** Annotation names guaranteed to be present on every matched join point. */
  ann: string;
}
interface AnyShape extends Shape {
  target: object;
  args: readonly unknown[];
  returns: unknown;
  ann: never;
}

// ---------------------------------------------------------------------------
// Annotations (typed metadata + decorator)
// ---------------------------------------------------------------------------
/** Accessors are accepted only when `F` is no method contract (exactly `Fn`). */
type AccessorGuard<F extends Fn, T> = [T] extends [Fn]
  ? never
  : (<G>() => G extends F ? 1 : 2) extends <G>() => G extends Fn ? 1 : 2
    ? unknown
    : never;

type MethodOrClassDecorator<F extends Fn> = {
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

interface Annotation<V, F extends Fn = Fn, N extends string = string> {
  readonly annotationName: N;
  // biome-ignore lint/suspicious/noConfusingVoidType: void marks an annotation that takes no value
  (...value: [V] extends [void] ? [] : [value: V]): MethodOrClassDecorator<F>;
}

declare function createAnnotation<
  N extends string,
  V = void,
  F extends Fn = Fn,
>(name: N, options?: { requiresAdvice?: boolean }): Annotation<V, F, N>;

// ---------------------------------------------------------------------------
// Pointcuts
// ---------------------------------------------------------------------------
interface Pointcut<S extends Shape = AnyShape> {
  readonly __shape?: S;
  and<S2 extends Shape>(
    other: Pointcut<S2>,
  ): Pointcut<{
    target: S["target"] & S2["target"];
    args: S["args"] & S2["args"];
    returns: S["returns"] & S2["returns"];
    ann: S["ann"] | S2["ann"];
  }>;
  or<S2 extends Shape>(
    other: Pointcut<S2>,
  ): Pointcut<{
    target: S["target"] | S2["target"];
    args: S["args"] | S2["args"];
    returns: S["returns"] | S2["returns"];
    ann: Extract<S["ann"], S2["ann"]>;
  }>;
  not(): Pointcut<AnyShape>;
}

type MethodKeys<T> = { [K in keyof T]-?: T[K] extends Fn ? K : never }[keyof T];
declare const ANY: unique symbol;
declare const REST: unique symbol;
type ArgMatcher = Class | typeof ANY | typeof REST;
type ArgsOf<M extends readonly ArgMatcher[]> = M extends readonly [
  infer H,
  ...infer R extends readonly ArgMatcher[],
]
  ? H extends typeof REST
    ? unknown[]
    : [H extends Class<infer I> ? I : unknown, ...ArgsOf<R>]
  : [];

declare const P: {
  /** Execution of one specific method. Carries that method's exact signature. */
  method<C extends Class, K extends MethodKeys<InstanceType<C>>>(
    type: C,
    name: K,
  ): Pointcut<{
    target: InstanceType<C>;
    args: Parameters<InstanceType<C>[K]>;
    returns: ReturnType<InstanceType<C>[K]>;
    ann: never;
  }>;
  /** within(Type): methods declared on the given classes. */
  within<C extends Class[]>(
    ...types: C
  ): Pointcut<{
    target: InstanceType<C[number]>;
    args: readonly unknown[];
    returns: unknown;
    ann: never;
  }>;
  /** target(Type): the runtime target is instanceof Type (subclasses included). */
  target<C extends Class>(
    type: C,
  ): Pointcut<{
    target: InstanceType<C>;
    args: readonly unknown[];
    returns: unknown;
    ann: never;
  }>;
  /** @annotation(A): the method carries A. The contract F flows into the advice. */
  annotated<V, F extends Fn, N extends string>(
    a: Annotation<V, F, N>,
  ): Pointcut<{
    target: object;
    args: Parameters<F>;
    returns: ReturnType<F>;
    ann: N;
  }>;
  /** @within(A): the declaring class carries A. */
  withinAnnotated<V, F extends Fn, N extends string>(
    a: Annotation<V, F, N>,
  ): Pointcut<{
    target: object;
    args: readonly unknown[];
    returns: unknown;
    ann: N;
  }>;
  /** args(...): runtime argument check (dynamic pointcut). */
  args<M extends readonly ArgMatcher[]>(
    ...matchers: M
  ): Pointcut<{
    target: object;
    args: ArgsOf<M>;
    returns: unknown;
    ann: never;
  }>;
  /** Method name pattern. */
  name(pattern: string | RegExp): Pointcut<AnyShape>;
  /** Providers declared in a Nest module (the counterpart of a Java package). */
  inModule(
    module: Class,
    options?: { transitive?: boolean },
  ): Pointcut<AnyShape>;
  /** bean(name): provider token pattern. */
  bean(token: string | RegExp | Class): Pointcut<AnyShape>;
  readonly ANY: typeof ANY;
  readonly REST: typeof REST;
};

// ---------------------------------------------------------------------------
// Join points
// ---------------------------------------------------------------------------
interface JoinPoint<S extends Shape> {
  readonly kind: "method" | "getter" | "setter";
  readonly target: S["target"];
  readonly args: Readonly<S["args"]>;
  readonly signature: {
    readonly name: string | symbol;
    readonly declaringType: Class;
    readonly targetType: Class;
  };
  readonly isAsync: boolean;
  /** Guaranteed annotation: allowed only when the pointcut proves its presence. */
  annotation<V, N extends S["ann"]>(a: Annotation<V, any, N>): V;
  findAnnotation<V>(a: Annotation<V, any, any>): V | undefined;
}
interface ProceedingJoinPoint<S extends Shape> extends JoinPoint<S> {
  proceed(): S["returns"];
  proceedWith(
    ...args: S["args"] extends readonly unknown[] ? S["args"] : never
  ): S["returns"];
}

// ---------------------------------------------------------------------------
// Aspects and advice
// ---------------------------------------------------------------------------
type AdviceResult<S extends Shape> = [S["returns"]] extends [PromiseLike<any>]
  ? void | PromiseLike<void>
  : unknown extends S["returns"]
    ? void | PromiseLike<void>
    : // A union with a promise member, as `or()` of a synchronous and an asynchronous method produces.
      [Extract<S["returns"], PromiseLike<any>>] extends [never]
      ? // biome-ignore lint/suspicious/noConfusingVoidType: void is the return type required of synchronous advice
        void
      : void | PromiseLike<void>;

/**
 * `() => Promise<void>` is assignable to `() => void`, so a plain function type
 * constraint cannot reject async advice. An extra intersection checks the
 * return type of the advice method itself instead.
 */
type AsyncGuard<S extends Shape, T extends Fn> =
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

type AdviceDecorator<S extends Shape, F extends Fn> = <T extends F>(
  target: object,
  key: string | symbol,
  desc: TypedPropertyDescriptor<T> & AsyncGuard<S, T>,
) => void;

declare function Aspect(options?: {
  order?: number;
  instantiation?: "singleton" | "perTarget" | "perClass";
}): ClassDecorator;
declare function Before<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<S, (jp: JoinPoint<S>) => AdviceResult<S>>;
declare function After<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<S, (jp: JoinPoint<S>) => AdviceResult<S>>;
declare function AfterReturning<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<
  S,
  (jp: JoinPoint<S>, result: Awaited<S["returns"]>) => AdviceResult<S>
>;
declare function AfterThrowing<S extends Shape, E = unknown>(
  pc: Pointcut<S>,
  options?: { throwing: Class<E> },
): AdviceDecorator<S, (jp: JoinPoint<S>, error: E) => AdviceResult<S>>;
declare function Around<S extends Shape>(
  pc: Pointcut<S>,
): AdviceDecorator<AnyShape, (jp: ProceedingJoinPoint<S>) => S["returns"]>;

// ===========================================================================
// Usage - must compile
// ===========================================================================
interface RetryOptions {
  attempts: number;
}
/** Retryable can only be applied to async methods. */
const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable");
const Audited = createAnnotation<"Audited">("Audited");

class NotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
}
class ConflictError extends Error {
  readonly code = "CONFLICT" as const;
}

class Account {
  constructor(readonly id: string) {}
}
class User {
  constructor(readonly name: string) {}
}

class UserService {
  @Retryable({ attempts: 3 })
  async findById(id: number): Promise<User> {
    return new User(String(id));
  }

  @Audited()
  rename(user: User, name: string): User {
    return new User(name);
  }

  // @ts-expect-error Retryable requires a method that returns a Promise
  @Retryable({ attempts: 3 })
  syncFind(id: number): User {
    return new User(String(id));
  }

  // @ts-expect-error the options are required and typed
  @Retryable()
  async other(): Promise<void> {}
}

@Audited()
class AccountService {
  transfer(from: Account, amount: number): void {}
}

const retryable = P.annotated(Retryable);
const findById = P.method(UserService, "findById");
const accountOps = P.within(AccountService).and(P.args(Account, P.REST));

@Aspect({ order: 10 })
class ResilienceAspect {
  @Around(retryable)
  async retry(
    jp: ProceedingJoinPoint<
      typeof retryable extends Pointcut<infer S> ? S : never
    >,
  ): Promise<unknown> {
    const { attempts } = jp.annotation(Retryable); // typed as RetryOptions
    for (let i = 1; ; i++) {
      try {
        return await jp.proceed();
      } catch (e) {
        if (i >= attempts) {
          throw e;
        }
      }
    }
  }

  @AfterReturning(findById)
  cacheUser(jp: JoinPoint<any>, user: User): void {}

  @Before(accountOps)
  checkAccount(jp: JoinPoint<any>): void {
    const [account] = jp.args as [Account, ...unknown[]];
  }

  @AfterThrowing(findById, { throwing: RangeError })
  onRangeError(jp: JoinPoint<any>, error: RangeError): void {}
}

// Shape helpers that keep advice parameters readable
type ShapeOf<PC> = PC extends Pointcut<infer S> ? S : never;
type JP<PC> = JoinPoint<ShapeOf<PC>>;
type PJP<PC> = ProceedingJoinPoint<ShapeOf<PC>>;

@Aspect()
class TypedAdviceAspect {
  @Around(findById)
  async aroundFind(jp: PJP<typeof findById>): Promise<User> {
    const [id] = jp.args; // number
    const n: number = id;
    return jp.proceedWith(n + 1);
  }

  @Before(accountOps)
  before(jp: JP<typeof accountOps>): void {
    const account: Account = jp.args[0];
    // @ts-expect-error this pointcut does not guarantee Audited
    jp.annotation(Audited);
    jp.findAnnotation(Audited); // allowed: returns void | undefined
  }

  // @ts-expect-error around advice on findById must return Promise<User>
  @Around(findById)
  wrongReturn(jp: PJP<typeof findById>): string {
    return "x";
  }

  @Around(findById)
  async wrongArgs(jp: PJP<typeof findById>): Promise<User> {
    // @ts-expect-error proceedWith arguments are checked against the signature
    return jp.proceedWith("not-a-number");
  }

  // @ts-expect-error afterReturning receives the awaited return type (User), not string
  @AfterReturning(findById)
  wrongResult(jp: JP<typeof findById>, result: string): void {}

  // @ts-expect-error the throwing filter fixes the error parameter type
  @AfterThrowing(findById, { throwing: NotFoundError })
  wrongError(jp: JP<typeof findById>, error: ConflictError): void {}

  // Known limitation: TypeScript treats structurally identical classes as interchangeable.
  @AfterThrowing(findById, { throwing: RangeError })
  structurallySame(jp: JP<typeof findById>, error: TypeError): void {}

  @AfterReturning(findById)
  async asyncAllowed(jp: JP<typeof findById>, user: User): Promise<void> {}
}

const renamePc = P.method(UserService, "rename");
@Aspect()
class SyncAspect {
  // @ts-expect-error async advice on a join point known to be synchronous
  @Before(renamePc)
  async check(jp: JP<typeof renamePc>): Promise<void> {}

  // @ts-expect-error P.method rejects a name that is not a method of the type
  static readonly bad = P.method(UserService, "nope");
}

// or() of a synchronous and an asynchronous method may be asynchronous
const renameOrFind = renamePc.or(findById);
@Aspect()
class MixedAspect {
  @Before(renameOrFind)
  async check(jp: JP<typeof renameOrFind>): Promise<void> {}
}

// Accessors accept an annotation that has no method contract
class Settings {
  @Audited()
  get theme(): string {
    return "dark";
  }

  // @ts-expect-error Retryable requires a method that returns a Promise
  @Retryable({ attempts: 3 })
  get retries(): number {
    return 3;
  }
}

// or(): an annotation is guaranteed only when both sides guarantee it
const either = P.annotated(Audited).or(P.withinAnnotated(Audited));
const auditedOrRetry = P.annotated(Audited).or(P.annotated(Retryable));
@Aspect()
class OrAspect {
  @Before(either)
  a(jp: JP<typeof either>): void {
    jp.annotation(Audited);
  }

  @Before(auditedOrRetry)
  b(jp: JP<typeof auditedOrRetry>): void {
    // @ts-expect-error neither annotation is guaranteed on every match
    jp.annotation(Audited);
  }
}

export {};
