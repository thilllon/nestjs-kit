// Type fixture of the public API.
// `pnpm typecheck` checks it; every `@ts-expect-error` marks a misuse the API
// rejects at compile time. The tests evaluate the fixture and compare the
// run-time guarantees of its pointcuts with their types.

/* oxlint-disable no-unused-vars -- the fixture declares classes, locals and advice signatures only to be type-checked */

import { Reflector } from "@nestjs/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  After,
  AfterReturning,
  AfterThrowing,
  type Annotation,
  type AnnotationOptions,
  type AnyFunction,
  type AnyShape,
  type AsyncMethod,
  Around,
  Aspect,
  Before,
  createAnnotation,
  type JoinPoint,
  type JoinPointOf,
  Pointcut as P,
  type ProceedingJoinPointOf,
  type Pointcut,
  type ProceedingJoinPoint,
  type ShapeOf,
} from "./index";
import { createClassRef, createMethodRef } from "./method-ref";
import { matchesStatically } from "./pointcut";

interface RetryOptions {
  attempts: number;
}

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

/** Declares the annotations, targets, pointcuts and aspects of the fixture. */
function declareUsage() {
  /** Retryable can only be applied to async methods. */
  const Retryable = createAnnotation<
    "Retryable",
    RetryOptions,
    (...args: any[]) => Promise<unknown>
  >("Retryable");
  const Audited = createAnnotation<"Audited">("Audited");
  const Roles = Reflector.createDecorator<string[]>();

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
      joinPoint: ProceedingJoinPoint<
        typeof retryable extends Pointcut<infer S> ? S : never
      >,
    ): Promise<unknown> {
      const { attempts } = joinPoint.annotation(Retryable); // typed as RetryOptions
      for (let i = 1; ; i++) {
        try {
          return await joinPoint.proceed();
        } catch (e) {
          if (i >= attempts) {
            throw e;
          }
        }
      }
    }

    @AfterReturning(findById)
    cacheUser(joinPoint: JoinPoint<any>, user: User): void {}

    @Before(accountOps)
    checkAccount(joinPoint: JoinPoint<any>): void {
      const [account] = joinPoint.args as [Account, ...unknown[]];
    }

    @AfterThrowing(findById, { throwing: RangeError })
    onRangeError(joinPoint: JoinPoint<any>, error: RangeError): void {}
  }

  @Aspect()
  class TypedAdviceAspect {
    @Around(findById)
    async aroundFind(
      joinPoint: ProceedingJoinPointOf<typeof findById>,
    ): Promise<User> {
      const [id] = joinPoint.args; // number
      const n: number = id;
      return joinPoint.proceedWith(n + 1);
    }

    @Before(accountOps)
    before(joinPoint: JoinPointOf<typeof accountOps>): void {
      const account: Account = joinPoint.args[0];
      // @ts-expect-error this pointcut does not guarantee Audited
      joinPoint.annotation(Audited);
      joinPoint.findAnnotation(Audited); // allowed: returns void | undefined
    }

    // @ts-expect-error around advice on findById must return Promise<User>
    @Around(findById)
    wrongReturn(joinPoint: ProceedingJoinPointOf<typeof findById>): string {
      return "x";
    }

    @Around(findById)
    async wrongArgs(
      joinPoint: ProceedingJoinPointOf<typeof findById>,
    ): Promise<User> {
      // @ts-expect-error proceedWith arguments are checked against the signature
      return joinPoint.proceedWith("not-a-number");
    }

    // @ts-expect-error afterReturning receives the awaited return type (User), not string
    @AfterReturning(findById)
    wrongResult(
      joinPoint: JoinPointOf<typeof findById>,
      result: string,
    ): void {}

    // @ts-expect-error the throwing filter fixes the error parameter type
    @AfterThrowing(findById, { throwing: NotFoundError })
    wrongError(
      joinPoint: JoinPointOf<typeof findById>,
      error: ConflictError,
    ): void {}

    // Known limitation: TypeScript treats structurally identical classes as interchangeable.
    @AfterThrowing(findById, { throwing: RangeError })
    structurallySame(
      joinPoint: JoinPointOf<typeof findById>,
      error: TypeError,
    ): void {}

    @AfterReturning(findById)
    async asyncAllowed(
      joinPoint: JoinPointOf<typeof findById>,
      user: User,
    ): Promise<void> {}

    @After(findById)
    async asyncAfter(joinPoint: JoinPointOf<typeof findById>): Promise<void> {}
  }

  const renamePc = P.method(UserService, "rename");

  @Aspect()
  class SyncAspect {
    // @ts-expect-error async advice on a join point known to be synchronous
    @Before(renamePc)
    async check(joinPoint: JoinPointOf<typeof renamePc>): Promise<void> {}

    // @ts-expect-error async advice on a join point known to be synchronous
    @After(renamePc)
    async release(joinPoint: JoinPointOf<typeof renamePc>): Promise<void> {}

    // @ts-expect-error P.method rejects a name that is not a method of the type
    static readonly bad = P.method(UserService, "nope");
  }

  // A union of a synchronous and an asynchronous method may be asynchronous.
  const renameOrFind = renamePc.or(findById);
  const anyOfBoth = P.any(renamePc, findById);

  @Aspect()
  class MixedAspect {
    @Before(renameOrFind)
    async before(joinPoint: JoinPointOf<typeof renameOrFind>): Promise<void> {}

    @AfterThrowing(anyOfBoth)
    async failed(
      joinPoint: JoinPointOf<typeof anyOfBoth>,
      error: unknown,
    ): Promise<void> {}
  }

  // Accessors accept an annotation that has no method contract.
  class Settings {
    @Audited()
    get theme(): string {
      return "dark";
    }

    @Audited()
    set size(value: number) {}

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
    a(joinPoint: JoinPointOf<typeof either>): void {
      joinPoint.annotation(Audited);
    }

    @Before(auditedOrRetry)
    b(joinPoint: JoinPointOf<typeof auditedOrRetry>): void {
      // @ts-expect-error neither annotation is guaranteed on every match
      joinPoint.annotation(Audited);
    }
  }

  // Further designators
  const allOf = P.all(findById, retryable, P.targetAnnotated(Audited));
  const anyOf = P.any(P.annotated(Audited), P.withinAnnotated(Audited));
  const roles = P.annotated(Roles);
  const broad = P.name("find*")
    .and(P.kind("method"))
    .and(P.bean(/Service$/))
    .and(P.inModule(AccountService, { transitive: true }))
    .and(P.metadata("roles", (value) => Array.isArray(value)))
    .and(P.matching({ classFilter: { matches: () => true } }))
    .and(P.target(UserService).not());

  @Aspect()
  class DesignatorAspect {
    @Before(allOf)
    all(joinPoint: JoinPointOf<typeof allOf>): void {
      joinPoint.annotation(Retryable);
      joinPoint.annotation(Audited);
    }

    @Before(anyOf)
    any(joinPoint: JoinPointOf<typeof anyOf>): void {
      joinPoint.annotation(Audited);
    }

    @Before(roles)
    nest(joinPoint: JoinPointOf<typeof roles>): void {
      const found: string[] | undefined = joinPoint.findAnnotation(Roles);
      // @ts-expect-error a Nest decorator has no name the pointcut can guarantee
      joinPoint.annotation(Roles);
    }

    @Around(broad)
    async broad(
      joinPoint: ProceedingJoinPointOf<typeof broad>,
    ): Promise<unknown> {
      return joinPoint.proceed();
    }
  }

  // An annotation in place of a pointcut is P.annotated(annotation).
  @Aspect()
  class AnnotationAdviceAspect {
    @Around(Retryable)
    async retry(
      joinPoint: ProceedingJoinPointOf<typeof Retryable>,
    ): Promise<unknown> {
      const { attempts }: RetryOptions = joinPoint.annotation(Retryable);
      return joinPoint.proceed();
    }

    @Before(Audited)
    audit(joinPoint: JoinPointOf<typeof Audited>): void {
      joinPoint.annotation(Audited);
      // @ts-expect-error the Audited annotation does not guarantee Retryable
      joinPoint.annotation(Retryable);
    }

    @After(Retryable)
    async release(joinPoint: JoinPointOf<typeof Retryable>): Promise<void> {}

    @AfterReturning(Retryable)
    settled(joinPoint: JoinPointOf<typeof Retryable>, result: unknown): void {}

    @AfterThrowing(Retryable, { throwing: NotFoundError })
    notFound(
      joinPoint: JoinPointOf<typeof Retryable>,
      error: NotFoundError,
    ): void {}

    @Before(Roles)
    nest(joinPoint: JoinPointOf<typeof Roles>): void {
      const found: string[] | undefined = joinPoint.findAnnotation(Roles);
      // @ts-expect-error a Nest decorator has no name the advice can guarantee
      joinPoint.annotation(Roles);
    }

    // @ts-expect-error around advice for Retryable must return a Promise
    @Around(Retryable)
    wrongReturn(joinPoint: ProceedingJoinPointOf<typeof Retryable>): string {
      return "x";
    }

    // @ts-expect-error the throwing filter fixes the error parameter type
    @AfterThrowing(Retryable, { throwing: NotFoundError })
    wrongError(
      joinPoint: JoinPointOf<typeof Retryable>,
      error: ConflictError,
    ): void {}
  }

  // An annotation whose contract is a synchronous method types the join point
  // as synchronous.
  const Logged = createAnnotation<"Logged", void, (name: string) => string>(
    "Logged",
  );

  @Aspect()
  class SyncAnnotationAspect {
    // @ts-expect-error async advice on a join point known to be synchronous
    @Before(Logged)
    async check(joinPoint: JoinPointOf<typeof Logged>): Promise<void> {}

    @Around(Logged)
    log(joinPoint: ProceedingJoinPointOf<typeof Logged>): string {
      const [name]: readonly [name: string] = joinPoint.args;
      // @ts-expect-error proceedWith arguments are checked against the contract
      joinPoint.proceedWith(1);
      return joinPoint.proceedWith(name.trim());
    }
  }

  // `{ async: true }` gives the annotation the contract AsyncMethod; the name
  // is inferred.
  const Timed = createAnnotation("Timed", { async: true });
  const TimedRetry = createAnnotation<"TimedRetry", RetryOptions>(
    "TimedRetry",
    { async: true, requiresAdvice: true },
  );
  const Fetched = createAnnotation<
    "Fetched",
    void,
    (id: number) => Promise<User>
  >("Fetched", { async: true });
  // Options typed as AnnotationOptions are accepted with any explicit
  // contract, including a generic one a wrapper forwards.
  function makeAnnotation<N extends string, V, F extends AnyFunction>(
    name: N,
    options: AnnotationOptions = {},
  ): Annotation<V, F, N> {
    return createAnnotation<N, V, F>(name, options);
  }
  const loggedOptions: AnnotationOptions = { requiresAdvice: true };
  expectTypeOf(
    createAnnotation<"Logged", void, (name: string) => string>(
      "Logged",
      loggedOptions,
    ),
  ).toEqualTypeOf<Annotation<void, (name: string) => string, "Logged">>();
  expectTypeOf(
    makeAnnotation<"Made", void, (name: string) => string>("Made"),
  ).toEqualTypeOf<Annotation<void, (name: string) => string, "Made">>();

  class ReportService {
    @Timed()
    @TimedRetry({ attempts: 2 })
    async build(id: string): Promise<string> {
      return id;
    }

    @Fetched()
    async fetch(id: number): Promise<User> {
      return new User(String(id));
    }

    // @ts-expect-error the value of TimedRetry is required and typed
    @TimedRetry()
    async other(): Promise<void> {}
  }

  @Aspect()
  class TimingAspect {
    @Around(Timed)
    async time(
      joinPoint: ProceedingJoinPointOf<typeof Timed>,
    ): Promise<unknown> {
      return joinPoint.proceed();
    }

    // @ts-expect-error around advice for an async annotation must return a Promise
    @Around(Timed)
    wrongReturn(joinPoint: ProceedingJoinPointOf<typeof Timed>): string {
      return "x";
    }
  }

  /** Never called: applying Timed to a synchronous method throws. */
  function timeASynchronousMethod(): void {
    class SyncService {
      // @ts-expect-error Timed requires a method that returns a Promise
      @Timed()
      build(id: string): string {
        return id;
      }

      // @ts-expect-error an async annotation does not apply to accessors
      @Timed()
      get size(): number {
        return 0;
      }
    }
  }

  /** Never called: the decorator throws when it is evaluated. */
  function adviseAClass(): void {
    @Aspect()
    class ClassAspect {
      // @ts-expect-error an advice decorator requires a pointcut or an annotation
      @Before(UserService)
      notAnAnnotation(joinPoint: JoinPoint<any>): void {}
    }
  }

  return {
    Audited,
    Fetched,
    Logged,
    Retryable,
    Roles,
    Settings,
    Timed,
    TimedRetry,
    UserService,
    accountOps,
    allOf,
    anyOf,
    auditedOrRetry,
    broad,
    either,
    findById,
    renamePc,
    retryable,
  };
}

type Usage = ReturnType<typeof declareUsage>;

describe("public types", () => {
  it("carry the exact signature of P.method into the join point", () => {
    type S = ShapeOf<Usage["findById"]>;

    expectTypeOf<S["args"]>().toEqualTypeOf<[id: number]>();
    expectTypeOf<S["returns"]>().toEqualTypeOf<Promise<User>>();
    expectTypeOf<S["target"]>().toEqualTypeOf<
      InstanceType<Usage["UserService"]>
    >();
    expectTypeOf<S["annotations"]>().toBeNever();
  });

  it("carry the method contract of an annotation into the join point", () => {
    type S = ShapeOf<Usage["retryable"]>;

    expectTypeOf<S["returns"]>().toEqualTypeOf<Promise<unknown>>();
    expectTypeOf<S["annotations"]>().toEqualTypeOf<"Retryable">();
  });

  it("give an annotation the shape of P.annotated(annotation)", () => {
    const usage = declareUsage();
    const annotatedRetryable = P.annotated(usage.Retryable);
    const annotatedLogged = P.annotated(usage.Logged);
    const annotatedRoles = P.annotated(usage.Roles);

    expectTypeOf<ShapeOf<Usage["Retryable"]>>().toEqualTypeOf<
      ShapeOf<typeof annotatedRetryable>
    >();
    expectTypeOf<ShapeOf<Usage["Logged"]>>().toEqualTypeOf<
      ShapeOf<typeof annotatedLogged>
    >();
    expectTypeOf<ShapeOf<Usage["Roles"]>>().toEqualTypeOf<
      ShapeOf<typeof annotatedRoles>
    >();
    expectTypeOf<ShapeOf<Usage["Logged"]>["args"]>().toEqualTypeOf<
      [name: string]
    >();
    expectTypeOf<JoinPointOf<Usage["Audited"]>>().toEqualTypeOf<
      JoinPoint<
        ShapeOf<ReturnType<typeof P.annotated<void, AnyFunction, "Audited">>>
      >
    >();
    expectTypeOf<ShapeOf<Usage["Roles"]>>().toEqualTypeOf<AnyShape>();
  });

  it("give an async annotation the promise contract and infer its name", () => {
    expectTypeOf<Usage["Timed"]>().toEqualTypeOf<
      Annotation<void, AsyncMethod, "Timed">
    >();
    expectTypeOf<Usage["TimedRetry"]>().toEqualTypeOf<
      Annotation<RetryOptions, AsyncMethod, "TimedRetry">
    >();
    expectTypeOf<Usage["Fetched"]>().toEqualTypeOf<
      Annotation<void, (id: number) => Promise<User>, "Fetched">
    >();
    expectTypeOf<ShapeOf<Usage["Timed"]>["returns"]>().toEqualTypeOf<
      Promise<unknown>
    >();
    expectTypeOf<
      ShapeOf<Usage["Timed"]>["annotations"]
    >().toEqualTypeOf<"Timed">();
    expect(declareUsage().Timed.async).toBe(true);
  });

  it("keep the types of annotations created without the async option", () => {
    expectTypeOf(createAnnotation("Plain")).toEqualTypeOf<
      Annotation<void, AnyFunction, "Plain">
    >();
    expectTypeOf(
      createAnnotation("Required", { requiresAdvice: true }),
    ).toEqualTypeOf<Annotation<void, AnyFunction, "Required">>();
    expectTypeOf(
      createAnnotation<"Valued", string>("Valued", { async: false }),
    ).toEqualTypeOf<Annotation<string, AnyFunction, "Valued">>();
    expectTypeOf<Usage["Retryable"]>().toEqualTypeOf<
      Annotation<RetryOptions, AsyncMethod, "Retryable">
    >();
    expectTypeOf<Usage["Logged"]>().toEqualTypeOf<
      Annotation<void, (name: string) => string, "Logged">
    >();
    expect(declareUsage().Retryable.async).toBe(false);
  });

  it("type P.args as an argument tuple", () => {
    type Args = ShapeOf<Usage["accountOps"]>["args"];
    const primitives = P.args(String, Number, Boolean, BigInt, Symbol, P.ANY);

    expectTypeOf<Args[0]>().toEqualTypeOf<Account>();
    expectTypeOf<ShapeOf<typeof primitives>["args"]>().toEqualTypeOf<
      [string, number, boolean, bigint, symbol, unknown]
    >();
  });

  it("guarantee the annotations of both sides of and() and the common ones of or()", () => {
    expectTypeOf<ShapeOf<Usage["allOf"]>["annotations"]>().toEqualTypeOf<
      "Retryable" | "Audited"
    >();
    expectTypeOf<
      ShapeOf<Usage["either"]>["annotations"]
    >().toEqualTypeOf<"Audited">();
    expectTypeOf<
      ShapeOf<Usage["anyOf"]>["annotations"]
    >().toEqualTypeOf<"Audited">();
    expectTypeOf<ShapeOf<Usage["auditedOrRetry"]>["annotations"]>().toBeNever();
  });

  it("guarantee at run time the annotations their types guarantee", () => {
    const usage = declareUsage();
    const names = (pointcut: Pointcut<any>) => [...pointcut.guarantees].sort();

    expect(names(usage.retryable)).toEqual(["Retryable"]);
    expect(names(usage.allOf)).toEqual(["Audited", "Retryable"]);
    expect(names(usage.either)).toEqual(["Audited"]);
    expect(names(usage.anyOf)).toEqual(["Audited"]);
    expect(names(usage.auditedOrRetry)).toEqual([]);
    expect(names(usage.findById)).toEqual([]);
    expect(names(usage.broad)).toEqual([]);
  });

  it("select an annotated accessor with P.kind", () => {
    const { Audited, Settings } = declareUsage();
    const getter = createMethodRef(createClassRef(Settings), "theme", "getter");
    const setter = createMethodRef(createClassRef(Settings), "size", "setter");

    expect(
      matchesStatically(P.annotated(Audited).and(P.kind("getter")), getter),
    ).toBe(true);
    expect(
      matchesStatically(P.annotated(Audited).and(P.kind("setter")), setter),
    ).toBe(true);
    expect(matchesStatically(P.annotated(Audited), getter)).toBe(false);
  });

  it("name the designators and the pointcut type through one import alias", () => {
    const byName: P = P.name("find*");
    const guaranteed: P<ShapeOf<Usage["retryable"]>> = declareUsage().retryable;
    // @ts-expect-error A broad pointcut does not guarantee the annotation.
    const unguaranteed: P<ShapeOf<Usage["retryable"]>> = byName;

    expectTypeOf(byName).toEqualTypeOf<Pointcut<AnyShape>>();
    expectTypeOf<P<ShapeOf<Usage["retryable"]>>>().toEqualTypeOf<
      Usage["retryable"]
    >();
    expectTypeOf<ReturnType<typeof P.name>>().toEqualTypeOf<P>();
    expect([...guaranteed.guarantees]).toEqual(["Retryable"]);
    expect([...unguaranteed.guarantees]).toEqual([]);
  });

  it("leave broad pointcuts and negations without guarantees", () => {
    expectTypeOf<ShapeOf<Usage["broad"]>["annotations"]>().toBeNever();
    expectTypeOf<ReturnType<Usage["findById"]["not"]>>().toEqualTypeOf<
      Pointcut<AnyShape>
    >();
  });
});
