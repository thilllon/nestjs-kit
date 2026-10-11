// Type fixture of the public API: the usage section of docs/sketch/api.ts.
// `pnpm typecheck` checks it; every `@ts-expect-error` marks a misuse the API
// rejects at compile time.

// biome-ignore-all lint/correctness/noUnusedVariables: the fixture declares classes and locals only to be type-checked
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: the fixture declares advice signatures without bodies

import { Reflector } from "@nestjs/core";
import { describe, expectTypeOf, it } from "vitest";
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

/**
 * Declares the annotations, targets, pointcuts and aspects of the fixture.
 * The declarations are evaluated only when the function is called.
 */
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

    expectTypeOf<Args[0]>().toEqualTypeOf<Account>();
  });

  it("guarantee the annotations of both sides of and() and the common ones of or()", () => {
    expectTypeOf<ShapeOf<Usage["allOf"]>["ann"]>().toEqualTypeOf<
      "Retryable" | "Audited"
    >();
    expectTypeOf<ShapeOf<Usage["either"]>["ann"]>().toEqualTypeOf<"Audited">();
    expectTypeOf<ShapeOf<Usage["anyOf"]>["ann"]>().toEqualTypeOf<"Audited">();
    expectTypeOf<ShapeOf<Usage["auditedOrRetry"]>["ann"]>().toBeNever();
  });

  it("leave broad pointcuts and negations without guarantees", () => {
    expectTypeOf<ShapeOf<Usage["broad"]>["ann"]>().toBeNever();
    expectTypeOf<ReturnType<Usage["findById"]["not"]>>().toEqualTypeOf<
      Pointcut<AnyShape>
    >();
  });
});
