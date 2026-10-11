import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { isAspectAdvice } from "./advice";
import {
  compileAspect,
  describeAdvisor,
  sortAdvisors,
} from "./aspect-compiler";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { matching, named } from "./aspect-fixture";
import { AspectConfigurationError } from "./errors";
import { createClassRef, createMethodRef } from "./method-ref";
import type {
  AdvisorDescriptor,
  AnyShape,
  AspectAdvice,
  MethodInterceptor,
  PointcutAdvisor,
  ProceedingJoinPoint,
} from "./types";

const anything = matching();

const unresolved = { resolveAspect: () => undefined, registration: 0 };

describe("compileAspect", () => {
  it("orders advisors by kind and then by declaration", () => {
    @Aspect({ order: 5 })
    class Mixed {
      @AfterThrowing(anything)
      failed(): void {}

      @Before(anything)
      firstBefore(): void {}

      @AfterReturning(anything)
      returned(): void {}

      @After(anything)
      after(): void {}

      @Before(anything)
      secondBefore(): void {}

      @Around(anything)
      around(jp: ProceedingJoinPoint<AnyShape>): unknown {
        return jp.proceed();
      }
    }

    const advisors = compileAspect(Mixed, {
      resolveAspect: () => undefined,
      registration: 3,
    });

    expect(advisors.map((advisor) => advisor.source.methodName)).toEqual([
      "around",
      "firstBefore",
      "secondBefore",
      "after",
      "returned",
      "failed",
    ]);
    expect(advisors.map((advisor) => advisor.kindRank)).toEqual([
      0, 1, 1, 2, 3, 4,
    ]);
    expect(advisors.map((advisor) => advisor.declaration)).toEqual([
      5, 1, 4, 3, 2, 0,
    ]);
    for (const advisor of advisors) {
      expect(advisor.order).toBe(5);
      expect(advisor.registration).toBe(3);
      expect(advisor.source.type).toBe(Mixed);
    }
  });

  it("carries the pointcut, the kind and the throwing filter of each advice", () => {
    const pointcut = named("load");

    @Aspect()
    class Errors {
      @AfterThrowing(pointcut, { throwing: RangeError })
      failed(): void {}
    }

    const [advisor] = compileAspect(Errors, unresolved);

    expect(advisor.pointcut).toBe(pointcut);
    expect(advisor.order).toBeUndefined();
    expect(advisor.source).toEqual({
      type: Errors,
      methodName: "failed",
      kind: "afterThrowing",
    });
    expect(isAspectAdvice(advisor.advice)).toBe(true);
    expect(advisor.advice).toMatchObject({
      kind: "afterThrowing",
      aspectType: Errors,
      methodName: "failed",
      throwing: RangeError,
    });
  });

  it("resolves the aspect instance lazily through the given resolver", () => {
    class Target {
      load(): void {}
    }

    @Aspect()
    class Lazy {
      @Before(anything)
      before(): void {}
    }

    const calls: unknown[][] = [];
    const instance = new Lazy();
    const [advisor] = compileAspect(Lazy, {
      resolveAspect: (...args) => {
        calls.push(args);
        return instance;
      },
      registration: 0,
    });
    const method = createMethodRef(createClassRef(Target), "load");
    const target = new Target();

    expect(calls).toEqual([]);
    expect((advisor.advice as AspectAdvice).resolveAspect(method, target)).toBe(
      instance,
    );
    expect(calls).toEqual([[Lazy, method, target]]);
  });

  it("compiles advice inherited from a superclass before its own", () => {
    abstract class Base {
      @Before(anything)
      inherited(): void {}
    }

    @Aspect()
    class Derived extends Base {
      @Before(anything)
      own(): void {}
    }

    const advisors = compileAspect(Derived, unresolved);

    expect(advisors.map((advisor) => advisor.source.methodName)).toEqual([
      "inherited",
      "own",
    ]);
    expect(
      advisors.map((advisor) => (advisor.advice as AspectAdvice).aspectType),
    ).toEqual([Derived, Derived]);
  });

  it("rejects an aspect that extends another aspect", () => {
    @Aspect()
    class Parent {
      @Before(anything)
      inherited(): void {}
    }

    @Aspect()
    class Child extends Parent {}

    expect(() => compileAspect(Child, unresolved)).toThrow(
      AspectConfigurationError,
    );
    expect(() => compileAspect(Child, unresolved)).toThrow(
      "The aspect Child extends the aspect Parent",
    );
    expect(compileAspect(Parent, unresolved)).toHaveLength(1);
  });

  it("rejects a class that is not an aspect", () => {
    class Forgotten {
      @Before(anything)
      check(): void {}
    }

    expect(() => compileAspect(Forgotten, unresolved)).toThrow(
      AspectConfigurationError,
    );
    expect(() => compileAspect(Forgotten, unresolved)).toThrow(/@Aspect/);
  });

  it.each(["perTarget", "perClass"] as const)(
    "rejects the %s instantiation model",
    (instantiation) => {
      @Aspect({ instantiation })
      class Scoped {}

      expect(() => compileAspect(Scoped, unresolved)).toThrow(
        AspectConfigurationError,
      );
    },
  );

  it("rejects advice that is not a method", () => {
    @Aspect()
    class Accessor {
      @Before(anything)
      get check(): () => void {
        return () => undefined;
      }
    }

    expect(() => compileAspect(Accessor, unresolved)).toThrow(
      /Accessor\.check/,
    );
  });
});

describe("describeAdvisor", () => {
  const advice: MethodInterceptor = {
    invoke: (invocation) => invocation.proceed(),
  };

  it("describes the pointcut, advice and order of an advisor instance", () => {
    class Advisor implements PointcutAdvisor {
      readonly pointcut = anything;
      readonly advice = advice;
      readonly order = 100;
    }

    expect(describeAdvisor(new Advisor(), Advisor, 7)).toEqual({
      pointcut: anything,
      advice,
      order: 100,
      registration: 7,
      kindRank: 0,
      declaration: 0,
      source: { type: Advisor },
    });
  });

  it("rejects an advisor without a pointcut or without advice", () => {
    class Incomplete {}

    expect(() =>
      describeAdvisor({ advice } as unknown as PointcutAdvisor, Incomplete, 0),
    ).toThrow(AspectConfigurationError);
    expect(() =>
      describeAdvisor(
        { pointcut: anything } as unknown as PointcutAdvisor,
        Incomplete,
        0,
      ),
    ).toThrow(/Incomplete has no advice/);
  });

  it("rejects a pointcut whose class filter or method matcher cannot match", () => {
    class Malformed {}
    const pointcut = { classFilter: {}, methodMatcher: {} };

    expect(() =>
      describeAdvisor(
        { pointcut, advice } as unknown as PointcutAdvisor,
        Malformed,
        0,
      ),
    ).toThrow(AspectConfigurationError);
  });

  it("rejects an order that cannot be compared", () => {
    class Unordered {}

    expect(() =>
      describeAdvisor({ pointcut: anything, advice, order: NaN }, Unordered, 0),
    ).toThrow(/Unordered has an order that is not a number/);
  });
});

describe("sortAdvisors", () => {
  function descriptor(
    keys: Partial<
      Pick<
        AdvisorDescriptor,
        "order" | "registration" | "kindRank" | "declaration"
      >
    >,
  ): AdvisorDescriptor {
    return {
      pointcut: anything,
      advice: {},
      order: undefined,
      registration: 0,
      kindRank: 0,
      declaration: 0,
      source: { type: Object },
      ...keys,
    };
  }

  it("compares order, registration, kind rank and declaration in that sequence", () => {
    const unordered = descriptor({ registration: 0 });
    const negative = descriptor({ order: -1, registration: 9 });
    const lateRegistration = descriptor({ order: 1, registration: 2 });
    const lateKind = descriptor({ order: 1, registration: 1, kindRank: 4 });
    const lateDeclaration = descriptor({
      order: 1,
      registration: 1,
      kindRank: 1,
      declaration: 3,
    });
    const first = descriptor({
      order: 1,
      registration: 1,
      kindRank: 1,
      declaration: 0,
    });
    const input = [
      unordered,
      lateRegistration,
      lateKind,
      lateDeclaration,
      negative,
      first,
    ];

    const sorted = sortAdvisors(input);

    expect(sorted).toEqual([
      negative,
      first,
      lateDeclaration,
      lateKind,
      lateRegistration,
      unordered,
    ]);
    expect(input[0]).toBe(unordered);
  });

  it("keeps the input order of advisors with equal keys", () => {
    const a = descriptor({});
    const b = descriptor({});

    expect(sortAdvisors([b, a])[0]).toBe(b);
  });
});
