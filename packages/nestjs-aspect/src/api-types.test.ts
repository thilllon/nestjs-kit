// Type fixture of the public API: the usage section of docs/sketch/api.ts.
// `pnpm typecheck` checks it; every `@ts-expect-error` marks a misuse the API
// rejects at compile time. The tests evaluate the fixture and compare the
// run-time guarantees of its pointcuts with their types.

// biome-ignore-all lint/correctness/noUnusedVariables: the fixture declares classes and locals only to be type-checked
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: the fixture declares advice signatures without bodies

import { Reflector } from "@nestjs/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  After,
  AfterReturning,
  AfterThrowing,
  type AnyShape,
  Around,
  Aspect,
  Before,
  createAnnotation,
  type JoinPoint,
  type JP,
  P,
  type PJP,
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

    @After(findById)
    async asyncAfter(jp: JP<typeof findById>): Promise<void> {}
  }

  const renamePc = P.method(UserService, "rename");

  @Aspect()
  class SyncAspect {
    // @ts-expect-error async advice on a join point known to be synchronous
    @Before(renamePc)
    async check(jp: JP<typeof renamePc>): Promise<void> {}

    // @ts-expect-error async advice on a join point known to be synchronous
    @After(renamePc)
    async release(jp: JP<typeof renamePc>): Promise<void> {}

    // @ts-expect-error P.method rejects a name that is not a method of the type
    static readonly bad = P.method(UserService, "nope");
  }

  // A union of a synchronous and an asynchronous method may be asynchronous.
  const renameOrFind = renamePc.or(findById);
  const anyOfBoth = P.any(renamePc, findById);

  @Aspect()
  class MixedAspect {
    @Before(renameOrFind)
    async before(jp: JP<typeof renameOrFind>): Promise<void> {}

    @AfterThrowing(anyOfBoth)
    async failed(jp: JP<typeof anyOfBoth>, error: unknown): Promise<void> {}
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
    a(jp: JP<typeof either>): void {
      jp.annotation(Audited);
    }

    @Before(auditedOrRetry)
    b(jp: JP<typeof auditedOrRetry>): void {
      // @ts-expect-error neither annotation is guaranteed on every match
      jp.annotation(Audited);
    }
  }

  // Designators outside the sketch
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
    all(jp: JP<typeof allOf>): void {
      jp.annotation(Retryable);
      jp.annotation(Audited);
    }

    @Before(anyOf)
    any(jp: JP<typeof anyOf>): void {
      jp.annotation(Audited);
    }

    @Before(roles)
    nest(jp: JP<typeof roles>): void {
      const found: string[] | undefined = jp.findAnnotation(Roles);
      // @ts-expect-error a Nest decorator has no name the pointcut can guarantee
      jp.annotation(Roles);
    }

    @Around(broad)
    async broad(jp: PJP<typeof broad>): Promise<unknown> {
      return jp.proceed();
    }
  }

  return {
    Audited,
    Retryable,
    Settings,
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
    expectTypeOf<S["ann"]>().toBeNever();
  });

  it("carry the method contract of an annotation into the join point", () => {
    type S = ShapeOf<Usage["retryable"]>;

    expectTypeOf<S["returns"]>().toEqualTypeOf<Promise<unknown>>();
    expectTypeOf<S["ann"]>().toEqualTypeOf<"Retryable">();
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
    expectTypeOf<ShapeOf<Usage["allOf"]>["ann"]>().toEqualTypeOf<
      "Retryable" | "Audited"
    >();
    expectTypeOf<ShapeOf<Usage["either"]>["ann"]>().toEqualTypeOf<"Audited">();
    expectTypeOf<ShapeOf<Usage["anyOf"]>["ann"]>().toEqualTypeOf<"Audited">();
    expectTypeOf<ShapeOf<Usage["auditedOrRetry"]>["ann"]>().toBeNever();
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

  it("leave broad pointcuts and negations without guarantees", () => {
    expectTypeOf<ShapeOf<Usage["broad"]>["ann"]>().toBeNever();
    expectTypeOf<ReturnType<Usage["findById"]["not"]>>().toEqualTypeOf<
      Pointcut<AnyShape>
    >();
  });
});
