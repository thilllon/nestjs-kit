import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import {
  After,
  AfterThrowing,
  Advisor,
  Around,
  Aspect,
  Before,
  getAdviceMetadata,
  getAspectMetadata,
  isAdvisor,
  isAspect,
} from "./aspect-decorators";
import { matching, named } from "./aspect-fixture";
import { AspectConfigurationError } from "./errors";
import type {
  AnyShape,
  MethodInterceptor,
  Pointcut,
  PointcutAdvisor,
  ProceedingJoinPoint,
} from "./types";

const anything = matching();

describe("@Aspect", () => {
  it("makes the class a Nest provider with constructor injection", async () => {
    @Injectable()
    class Metrics {}

    @Aspect()
    class MeteredAspect {
      constructor(readonly metrics: Metrics) {}
    }

    const moduleRef = await Test.createTestingModule({
      providers: [Metrics, MeteredAspect],
    }).compile();

    expect(moduleRef.get(MeteredAspect).metrics).toBe(moduleRef.get(Metrics));
  });

  it("stores the order and defaults to the singleton instantiation model", () => {
    @Aspect({ order: 10 })
    class Ordered {}

    @Aspect()
    class Plain {}

    expect(getAspectMetadata(Ordered)).toEqual({
      order: 10,
      instantiation: "singleton",
    });
    expect(getAspectMetadata(Plain)).toEqual({
      order: undefined,
      instantiation: "singleton",
    });
  });

  it("does not make a subclass an aspect", () => {
    @Aspect()
    class Base {}

    class Derived extends Base {}

    expect(isAspect(Base)).toBe(true);
    expect(isAspect(Derived)).toBe(false);
    expect(getAspectMetadata(Derived)).toBeUndefined();
  });

  it("rejects an order that is not a number and an unknown instantiation model", () => {
    expect(() => Aspect({ order: "1" as unknown as number })).toThrow(
      AspectConfigurationError,
    );
    expect(() => Aspect({ instantiation: "request" as never })).toThrow(
      AspectConfigurationError,
    );
  });
});

describe("advice decorators", () => {
  it("record advice in declaration order with kind, pointcut and method", () => {
    const first = named("first");
    const second = named("second");

    @Aspect()
    class Recorded {
      @Before(first)
      one(): void {}

      @Around(second)
      two(jp: ProceedingJoinPoint<AnyShape>): unknown {
        return jp.proceed();
      }

      @AfterThrowing(first, { throwing: RangeError })
      three(): void {}
    }

    expect(getAdviceMetadata(Recorded)).toEqual([
      { kind: "before", pointcut: first, methodName: "one" },
      { kind: "around", pointcut: second, methodName: "two" },
      {
        kind: "afterThrowing",
        pointcut: first,
        methodName: "three",
        throwing: RangeError,
      },
    ]);
  });

  it("record several decorators on one method bottom-up", () => {
    @Aspect()
    class Stacked {
      @Before(anything)
      @After(anything)
      both(): void {}
    }

    expect(getAdviceMetadata(Stacked).map((entry) => entry.kind)).toEqual([
      "after",
      "before",
    ]);
  });

  it("are detectable on a class that is not an aspect", () => {
    class Forgotten {
      @Before(anything)
      check(): void {}
    }

    expect(isAspect(Forgotten)).toBe(false);
    expect(getAdviceMetadata(Forgotten)).toHaveLength(1);
  });

  it("list superclass advice first without changing the superclass", () => {
    class Base {
      @Before(anything)
      inherited(): void {}
    }

    @Aspect()
    class Derived extends Base {
      @After(anything)
      own(): void {}
    }

    @Aspect()
    class Sibling extends Base {}

    expect(getAdviceMetadata(Derived).map((entry) => entry.methodName)).toEqual(
      ["inherited", "own"],
    );
    expect(getAdviceMetadata(Base)).toHaveLength(1);
    expect(getAdviceMetadata(Sibling)).toHaveLength(1);
  });

  it("replace inherited advice on a method the subclass declares advice on", () => {
    const other = named("other");

    class Base {
      @Before(anything)
      shared(): void {}

      @Before(anything)
      inherited(): void {}
    }

    @Aspect()
    class Derived extends Base {
      @After(other)
      override shared(): void {}
    }

    expect(
      getAdviceMetadata(Derived).map(({ kind, methodName, pointcut }) => [
        kind,
        methodName,
        pointcut,
      ]),
    ).toEqual([
      ["before", "inherited", anything],
      ["after", "shared", other],
    ]);
    expect(getAdviceMetadata(Base)).toHaveLength(2);
  });

  it("return nothing for a class without advice", () => {
    class Empty {}

    expect(getAdviceMetadata(Empty)).toEqual([]);
  });

  it("reject a missing pointcut when the decorator is evaluated", () => {
    const notYetInitialized = undefined as unknown as Pointcut;

    expect(() => Before(notYetInitialized)).toThrow(AspectConfigurationError);
    expect(() => Around({} as Pointcut)).toThrow(/pointcut/);
  });

  it("reject static members", () => {
    expect(() => {
      class Static {
        @Before(anything)
        static check(): void {}
      }
      return Static;
    }).toThrow(AspectConfigurationError);
  });
});

describe("@Advisor", () => {
  it("marks the class as an advisor and as a Nest provider", async () => {
    @Injectable()
    class Transactions {}

    @Advisor()
    class TransactionAdvisor implements PointcutAdvisor {
      readonly pointcut = anything;
      readonly advice: MethodInterceptor = {
        invoke: (invocation) => invocation.proceed(),
      };

      constructor(readonly transactions: Transactions) {}
    }

    const moduleRef = await Test.createTestingModule({
      providers: [Transactions, TransactionAdvisor],
    }).compile();

    expect(isAdvisor(TransactionAdvisor)).toBe(true);
    expect(isAspect(TransactionAdvisor)).toBe(false);
    expect(isAdvisor(Transactions)).toBe(false);
    expect(moduleRef.get(TransactionAdvisor).transactions).toBe(
      moduleRef.get(Transactions),
    );
  });
});
