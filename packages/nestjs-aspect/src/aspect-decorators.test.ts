import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Advisor,
  Around,
  Aspect,
  Before,
  getAdviceMetadata,
  getAspectMetadata,
  getAdvisorPointcut,
  isAdvisor,
  isAspect,
} from "./aspect-decorators";
import { matching, named } from "./aspect-fixture";
import { AspectConfigurationError } from "./errors";
import { createClassRef, createMethodRef } from "./method-ref";
import {
  guaranteedAnnotations,
  matchesStatically,
  referencedAnnotations,
} from "./pointcut";
import { Pointcut as P } from "./pointcut-designators";
import type {
  AnnotationLike,
  MethodInterceptor,
  Pointcut,
  PointcutAdvisor,
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

  it("record an annotation as the pointcut P.annotated(annotation)", () => {
    const Audited = createAnnotation<"Audited">("Audited");
    const Roles = Reflector.createDecorator<string[]>();

    class Service {
      @Audited()
      @Roles(["admin"])
      both(): void {}

      @Audited()
      audited(): void {}

      @Roles(["admin"])
      roles(): void {}

      plain(): void {}
    }

    @Aspect()
    class AnnotationAspect {
      @Around(Audited)
      @Before(Audited)
      @After(Roles)
      @AfterReturning(Roles)
      @AfterThrowing(Audited, { throwing: RangeError })
      advise(): void {}
    }

    const classRef = createClassRef(Service);
    const members = ["both", "audited", "roles", "plain"].map((name) =>
      createMethodRef(classRef, name, "method"),
    );
    const annotations: AnnotationLike<any>[] = [
      Audited,
      Roles,
      Roles,
      Audited,
      Audited,
    ];
    const entries = getAdviceMetadata(AnnotationAspect);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "afterThrowing",
      "afterReturning",
      "after",
      "before",
      "around",
    ]);
    expect(entries[0]?.throwing).toBe(RangeError);
    entries.forEach(({ pointcut }, index) => {
      const expected = P.annotated(annotations[index] as never);
      expect(
        members.map((method) => matchesStatically(pointcut, method)),
      ).toEqual(members.map((method) => matchesStatically(expected, method)));
      expect(guaranteedAnnotations(pointcut)).toEqual(
        guaranteedAnnotations(expected),
      );
      expect(referencedAnnotations(pointcut)).toEqual(
        referencedAnnotations(expected),
      );
    });
    expect([
      ...guaranteedAnnotations(entries[3]?.pointcut ?? anything),
    ]).toEqual(["Audited"]);
  });

  it("reject a function that is no annotation with the error of P.annotated", () => {
    class NotAnAnnotation {}

    const annotatedError = (() => {
      try {
        P.annotated(NotAnAnnotation as never);
      } catch (error) {
        return error;
      }
    })();

    expect(annotatedError).toBeInstanceOf(AspectConfigurationError);
    expect(() => Before(NotAnAnnotation as never)).toThrow(
      (annotatedError as Error).message,
    );
    expect(() => Around(NotAnAnnotation as never)).toThrow(
      AspectConfigurationError,
    );
  });

  it("reject a missing pointcut or annotation as a possible circular import", () => {
    expect(() => After(undefined as never)).toThrow(
      "@After requires a pointcut; an undefined pointcut usually comes from a circular import",
    );
  });

  it("reject a throwing option of @AfterThrowing that is no class when the decorator is evaluated", () => {
    function declare(): void {
      @Aspect()
      class Recorder {
        @AfterThrowing(anything, { throwing: "RangeError" as never })
        record(): void {}
      }
      void Recorder;
    }

    expect(declare).toThrow(AspectConfigurationError);
    expect(declare).toThrow(
      "@AfterThrowing requires a class as its throwing option",
    );
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
    class TransactionAdvisor {
      static readonly pointcut = anything;

      readonly advice: MethodInterceptor = {
        invoke: (invocation) => invocation.proceed(),
      };

      constructor(readonly transactions: Transactions) {}
    }

    const moduleRef = await Test.createTestingModule({
      providers: [Transactions, TransactionAdvisor],
    }).compile();

    expect(isAdvisor(TransactionAdvisor)).toBe(true);
    expect(getAdvisorPointcut(TransactionAdvisor)).toBe(anything);
    expect(isAspect(TransactionAdvisor)).toBe(false);
    expect(isAdvisor(Transactions)).toBe(false);
    expect(moduleRef.get(TransactionAdvisor).transactions).toBe(
      moduleRef.get(Transactions),
    );
  });

  it("rejects a class whose pointcut is not a static member", () => {
    expect(() => {
      // @ts-expect-error The pointcut must be a static member.
      @Advisor()
      class InstancePointcut implements PointcutAdvisor {
        readonly pointcut = anything;
        readonly advice: MethodInterceptor = {
          invoke: (invocation) => invocation.proceed(),
        };
      }
      return InstancePointcut;
    }).toThrow(AspectConfigurationError);
    expect(() => {
      // @ts-expect-error Instances must supply advice.
      @Advisor()
      class NoAdvice {
        static readonly pointcut = anything;
      }
      return NoAdvice;
    }).not.toThrow();
  });
});
