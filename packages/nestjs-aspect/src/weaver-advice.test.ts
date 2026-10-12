import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectUsageError } from "./errors";
import { Pointcut as P } from "./pointcut-designators";
import type { AnyShape, JoinPoint, ProceedingJoinPoint } from "./types";
import { closeWoven, compileWoven } from "./weaving-fixture";

afterEach(closeWoven);

/**
 * A woven calculator whose aspect declares the five advice kinds for its
 * methods and getters, and the log of what ran.
 */
async function calculator() {
  const log: string[] = [];

  @Injectable()
  class Calculator {
    add(a: number, b: number): number {
      log.push("add");
      return a + b;
    }

    fail(): number {
      log.push("fail");
      throw new RangeError("boom");
    }

    async addAsync(a: number, b: number): Promise<number> {
      await Promise.resolve();
      log.push("addAsync");
      return a + b;
    }

    async failAsync(): Promise<number> {
      await Promise.resolve();
      log.push("failAsync");
      throw new RangeError("boom");
    }

    get total(): number {
      log.push("total");
      return 3;
    }

    get broken(): number {
      log.push("broken");
      throw new RangeError("boom");
    }
  }
  const members = P.within(Calculator).and(
    P.kind("method").or(P.kind("getter")),
  );

  @Aspect()
  class Tracing {
    @Around(members)
    around(joinPoint: ProceedingJoinPoint<AnyShape>): unknown {
      log.push("around");
      return joinPoint.proceed();
    }

    @Before(members)
    before(_jp: JoinPoint<AnyShape>): void {
      log.push("before");
    }

    @After(members)
    after(_jp: JoinPoint<AnyShape>): void {
      log.push("after");
    }

    @AfterReturning(members)
    returned(_jp: JoinPoint<AnyShape>, value: unknown): void {
      log.push(`returned ${String(value)}`);
    }

    @AfterThrowing(members, { throwing: RangeError })
    threw(_jp: JoinPoint<AnyShape>, error: RangeError): void {
      log.push(`threw ${error.message}`);
    }
  }
  const { moduleRef } = await compileWoven({
    providers: [Calculator, Tracing],
  });
  return { calculator: moduleRef.get(Calculator), log };
}

describe("advice through the dispatcher stub", () => {
  it("runs the five advice kinds around a synchronous method", async () => {
    const { calculator: target, log } = await calculator();

    expect(target.add(1, 2)).toBe(3);
    expect(log.splice(0)).toEqual([
      "around",
      "before",
      "add",
      "returned 3",
      "after",
    ]);

    expect(() => target.fail()).toThrow(RangeError);
    expect(log).toEqual(["around", "before", "fail", "threw boom", "after"]);
  });

  it("runs the five advice kinds around the settlement of an asynchronous method", async () => {
    const { calculator: target, log } = await calculator();

    const pending = target.addAsync(1, 2);
    expect(log).toEqual(["around", "before"]);
    expect(await pending).toBe(3);
    expect(log.splice(0)).toEqual([
      "around",
      "before",
      "addAsync",
      "returned 3",
      "after",
    ]);

    await expect(target.failAsync()).rejects.toThrow(RangeError);
    expect(log).toEqual([
      "around",
      "before",
      "failAsync",
      "threw boom",
      "after",
    ]);
  });

  it("runs the five advice kinds around a getter", async () => {
    const { calculator: target, log } = await calculator();

    expect(target.total).toBe(3);
    expect(log.splice(0)).toEqual([
      "around",
      "before",
      "total",
      "returned 3",
      "after",
    ]);

    expect(() => target.broken).toThrow(RangeError);
    expect(log).toEqual(["around", "before", "broken", "threw boom", "after"]);
  });

  it("nests advice of one kind in declaration order, and aspects without an order in registration order", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {}

      fail() {
        throw new RangeError("boom");
      }
    }
    const pointcut = P.within(Service);

    function tracing(label: string) {
      @Aspect()
      class Tracing {
        @Before(pointcut)
        firstBefore(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} before 1`);
        }

        @Before(pointcut)
        secondBefore(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} before 2`);
        }

        @AfterReturning(pointcut)
        firstReturned(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} returned 1`);
        }

        @AfterReturning(pointcut)
        secondReturned(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} returned 2`);
        }

        @AfterThrowing(pointcut)
        firstThrew(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} threw 1`);
        }

        @AfterThrowing(pointcut)
        secondThrew(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} threw 2`);
        }

        @After(pointcut)
        firstAfter(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} after 1`);
        }

        @After(pointcut)
        secondAfter(_jp: JoinPoint<AnyShape>): void {
          log.push(`${label} after 2`);
        }
      }
      return Tracing;
    }
    const { moduleRef } = await compileWoven({
      providers: [Service, tracing("outer"), tracing("inner")],
    });
    const service = moduleRef.get(Service);

    service.run();
    expect(log.splice(0)).toEqual([
      "outer before 1",
      "outer before 2",
      "inner before 1",
      "inner before 2",
      "inner returned 2",
      "inner returned 1",
      "inner after 2",
      "inner after 1",
      "outer returned 2",
      "outer returned 1",
      "outer after 2",
      "outer after 1",
    ]);

    expect(() => service.fail()).toThrow(RangeError);
    expect(log).toEqual([
      "outer before 1",
      "outer before 2",
      "inner before 1",
      "inner before 2",
      "inner threw 2",
      "inner threw 1",
      "inner after 2",
      "inner after 1",
      "outer threw 2",
      "outer threw 1",
      "outer after 2",
      "outer after 1",
    ]);
  });

  it("advises a method that is called without its instance, with no target", async () => {
    const targets: unknown[] = [];

    @Injectable()
    class Stateless {
      double(value: number) {
        return value * 2;
      }
    }
    const pointcut = P.within(Stateless);

    @Aspect()
    class Tracing {
      @After(pointcut)
      after(joinPoint: JoinPoint<AnyShape>): void {
        targets.push(joinPoint.target);
      }
    }
    const { moduleRef } = await compileWoven({
      providers: [Stateless, Tracing],
    });
    const { double } = moduleRef.get(Stateless);

    expect(double(2)).toBe(4);
    expect(targets).toEqual([undefined]);
  });

  it("raises AspectUsageError for asynchronous advice on a synchronous join point", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
        return "ran";
      }
    }
    const pointcut = P.within(Service);

    @Aspect()
    class Slow {
      @Before(pointcut)
      async before(_jp: JoinPoint<AnyShape>): Promise<void> {
        await Promise.resolve();
      }
    }
    const { moduleRef } = await compileWoven({ providers: [Service, Slow] });

    expect(() => moduleRef.get(Service).run()).toThrow(AspectUsageError);
    expect(log).toEqual([]);
  });
});
