import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import {
  Advisor,
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectInspector } from "./aspect-inspector";
import { Pointcut as P } from "./pointcut-designators";
import type {
  AnyShape,
  JoinPoint,
  MethodInterceptor,
  Pointcut,
  ProceedingJoinPoint,
} from "./types";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

/** Runs the microtasks that are queued, and those they queue. */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/** A promise that the test resolves. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("advice order across aspects", () => {
  it("nests aspects by ascending order whatever their registration order, with an aspect without an order innermost", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run(): void {
        log.push("run");
      }
    }
    const pointcut = P.within(Service);

    function tracing(label: string, order?: number) {
      @Aspect(order === undefined ? {} : { order })
      class Tracing {
        @Before(pointcut)
        before(_joinPoint: JoinPoint<AnyShape>): void {
          log.push(`${label} before`);
        }

        @After(pointcut)
        after(_joinPoint: JoinPoint<AnyShape>): void {
          log.push(`${label} after`);
        }
      }
      return Tracing;
    }
    const { moduleRef } = await compileWoven({
      providers: [
        Service,
        tracing("infinity", Number.POSITIVE_INFINITY),
        tracing("none"),
        tracing("zero", 0),
        tracing("negative", -1),
      ],
    });

    moduleRef.get(Service).run();

    expect(log).toEqual([
      "negative before",
      "zero before",
      "infinity before",
      "none before",
      "run",
      "none after",
      "infinity after",
      "zero after",
      "negative after",
    ]);
  });

  it("nests aspects and advisors with equal orders in registration order, not in definition order", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run(): string {
        log.push("run");
        return "ran";
      }
    }
    const pointcut = P.within(Service);

    @Aspect({ order: 5 })
    class DefinedFirst {
      @Around(pointcut)
      around(joinPoint: ProceedingJoinPoint<AnyShape>): unknown {
        log.push("aspect defined first: in");
        const result = joinPoint.proceed();
        log.push("aspect defined first: out");
        return result;
      }
    }

    @Advisor()
    class DefinedSecond {
      static readonly pointcut = pointcut;

      readonly order = 5;

      readonly advice: MethodInterceptor = {
        invoke: (invocation) => {
          log.push("advisor: in");
          const result = invocation.proceed();
          log.push("advisor: out");
          return result;
        },
      };
    }

    @Aspect({ order: 5 })
    class DefinedThird {
      @Before(pointcut)
      before(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("aspect defined third: before");
      }

      @AfterReturning(pointcut)
      returned(_joinPoint: JoinPoint<AnyShape>, value: unknown): void {
        log.push(`aspect defined third: returned ${String(value)}`);
      }

      @After(pointcut)
      after(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("aspect defined third: after");
      }
    }
    const { moduleRef } = await compileWoven({
      providers: [Service, DefinedThird, DefinedSecond, DefinedFirst],
    });

    expect(moduleRef.get(Service).run()).toBe("ran");

    expect(log).toEqual([
      "aspect defined third: before",
      "advisor: in",
      "aspect defined first: in",
      "run",
      "aspect defined first: out",
      "advisor: out",
      "aspect defined third: returned ran",
      "aspect defined third: after",
    ]);
  });

  it("delivers an error of the before advice of an inner aspect to the outer aspect only", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run(): void {
        log.push("run");
      }
    }
    const pointcut = P.within(Service);

    @Aspect({ order: 1 })
    class Outer {
      @Before(pointcut)
      before(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("outer before");
      }

      @AfterReturning(pointcut)
      returned(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("outer returned");
      }

      @AfterThrowing(pointcut, { throwing: Error })
      threw(_joinPoint: JoinPoint<AnyShape>, error: Error): void {
        log.push(`outer threw ${error.message}`);
      }

      @After(pointcut)
      after(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("outer after");
      }
    }

    @Aspect({ order: 2 })
    class Denying {
      @Before(pointcut)
      before(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("denying before");
        throw new Error("denied");
      }

      @AfterThrowing(pointcut)
      threw(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("denying threw");
      }

      @After(pointcut)
      after(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("denying after");
      }
    }

    @Aspect()
    class Innermost {
      @Before(pointcut)
      before(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("innermost before");
      }
    }
    const { moduleRef } = await compileWoven({
      providers: [Service, Innermost, Denying, Outer],
    });

    expect(() => moduleRef.get(Service).run()).toThrow("denied");

    expect(log).toEqual([
      "outer before",
      "denying before",
      "outer threw denied",
      "outer after",
    ]);
  });
});

describe("advice order on an asynchronous join point", () => {
  it("runs the advice of the next aspect only after the asynchronous advice before it has settled", async () => {
    const log: string[] = [];
    const entered = gate();
    const left = gate();

    @Injectable()
    class Service {
      async load(): Promise<string> {
        log.push("load");
        return "loaded";
      }
    }
    const pointcut = P.within(Service);

    @Aspect({ order: 1 })
    class Outer {
      @Before(pointcut)
      async before(_joinPoint: JoinPoint<AnyShape>): Promise<void> {
        log.push("outer before: start");
        await entered.promise;
        log.push("outer before: end");
      }

      @AfterReturning(pointcut)
      returned(_joinPoint: JoinPoint<AnyShape>, value: unknown): void {
        log.push(`outer returned ${String(value)}`);
      }

      @After(pointcut)
      after(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("outer after");
      }
    }

    @Aspect({ order: 2 })
    class Inner {
      @Before(pointcut)
      before(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("inner before");
      }

      @AfterReturning(pointcut)
      async returned(_joinPoint: JoinPoint<AnyShape>): Promise<void> {
        log.push("inner returned: start");
        await left.promise;
        log.push("inner returned: end");
      }

      @After(pointcut)
      after(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("inner after");
      }
    }
    const { moduleRef } = await compileWoven({
      providers: [Service, Inner, Outer],
    });

    const pending = moduleRef
      .get(Service)
      .load()
      .then((value) => {
        log.push(`caller received ${value}`);
      });
    await settled();
    expect(log.splice(0)).toEqual(["outer before: start"]);

    entered.resolve();
    await settled();
    expect(log.splice(0)).toEqual([
      "outer before: end",
      "inner before",
      "load",
      "inner returned: start",
    ]);

    left.resolve();
    await pending;
    expect(log).toEqual([
      "inner returned: end",
      "inner after",
      "outer returned loaded",
      "outer after",
      "caller received loaded",
    ]);
  });

  it("delivers the rejection of asynchronous after advice of an inner aspect to the after-throwing advice of the outer aspect", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      async load(): Promise<string> {
        log.push("load");
        return "loaded";
      }

      async fail(): Promise<string> {
        log.push("fail");
        throw new Error("unreachable upstream");
      }
    }
    const pointcut = P.within(Service);

    @Aspect({ order: 1 })
    class Outer {
      @AfterReturning(pointcut)
      returned(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("outer returned");
      }

      @AfterThrowing(pointcut, { throwing: Error })
      threw(_joinPoint: JoinPoint<AnyShape>, error: Error): void {
        log.push(`outer threw ${error.message}`);
      }

      @After(pointcut)
      after(_joinPoint: JoinPoint<AnyShape>): void {
        log.push("outer after");
      }
    }

    @Aspect({ order: 2 })
    class Releasing {
      @After(pointcut)
      async after(_joinPoint: JoinPoint<AnyShape>): Promise<void> {
        await Promise.resolve();
        log.push("releasing after");
        throw new Error("release failed");
      }
    }
    const { moduleRef } = await compileWoven({
      providers: [Service, Releasing, Outer],
    });
    const service = moduleRef.get(Service);

    await expect(service.load()).rejects.toThrow("release failed");
    expect(log.splice(0)).toEqual([
      "load",
      "releasing after",
      "outer threw release failed",
      "outer after",
    ]);

    await expect(service.fail()).rejects.toThrow("release failed");
    expect(log).toEqual([
      "fail",
      "releasing after",
      "outer threw release failed",
      "outer after",
    ]);
  });
});

/**
 * An aspect with around, before, after-returning and after advice for an
 * asynchronous join point. Its around advice appends `label` to the result.
 */
function traced(
  label: string,
  pointcut: Pointcut<AnyShape>,
  log: string[],
  order?: number,
) {
  @Aspect(order === undefined ? {} : { order })
  class Tracing {
    @Around(pointcut)
    async around(joinPoint: ProceedingJoinPoint<AnyShape>): Promise<unknown> {
      log.push(`${label} around`);
      const value = await joinPoint.proceed();
      log.push(`${label} resumed`);
      return `${String(value)} ${label}`;
    }

    @Before(pointcut)
    before(_joinPoint: JoinPoint<AnyShape>): void {
      log.push(`${label} before`);
    }

    @AfterReturning(pointcut)
    returned(_joinPoint: JoinPoint<AnyShape>, value: unknown): void {
      log.push(`${label} returned ${String(value)}`);
    }

    @After(pointcut)
    after(_joinPoint: JoinPoint<AnyShape>): void {
      log.push(`${label} after`);
    }
  }
  return Tracing;
}

/** The advice of `traced` aspects around one call, outermost first. */
function nested(labels: readonly string[], result: string): string[] {
  const [outer, ...inner] = labels;
  if (outer === undefined) {
    return ["run"];
  }
  const returned = [result, ...[...inner].reverse()].join(" ");
  return [
    `${outer} around`,
    `${outer} before`,
    ...nested(inner, result),
    `${outer} returned ${returned}`,
    `${outer} after`,
    `${outer} resumed`,
  ];
}

describe("precedence of aspects at run time", () => {
  function service() {
    const log: string[] = [];

    @Injectable()
    class Service {
      async run(): Promise<string> {
        await Promise.resolve();
        log.push("run");
        return "result";
      }
    }
    return { Service, log, pointcut: P.within(Service) };
  }

  it.each([
    { imported: ["audit", "metrics"] },
    { imported: ["metrics", "audit"] },
  ])(
    "nests aspects without an order of the modules imported as $imported in that order",
    async ({ imported }) => {
      const { Service, log, pointcut } = service();

      @Module({
        providers: [traced("audit", pointcut, log)],
      })
      class AuditModule {}

      @Module({
        providers: [traced("metrics", pointcut, log)],
      })
      class MetricsModule {}

      const modules = { audit: AuditModule, metrics: MetricsModule };
      const { moduleRef } = await initWoven({
        imports: imported.map((name) => modules[name as keyof typeof modules]),
        providers: [Service],
      });
      const [outer, inner] = imported;

      await expect(moduleRef.get(Service).run()).resolves.toBe(
        `result ${inner} ${outer}`,
      );
      expect(log).toEqual(nested(imported, "result"));
    },
  );

  it("runs the after-returning and after advice of the inner aspect before the around advice of the outer aspect resumes", async () => {
    const { Service, log, pointcut } = service();
    const { moduleRef } = await initWoven({
      providers: [
        Service,
        // Registered inner first: the order decides, not the registration.
        traced("inner", pointcut, log, 2),
        traced("outer", pointcut, log, 1),
      ],
    });

    await expect(moduleRef.get(Service).run()).resolves.toBe(
      "result inner outer",
    );
    expect(log).toEqual([
      "outer around",
      "outer before",
      "inner around",
      "inner before",
      "run",
      "inner returned result",
      "inner after",
      "inner resumed",
      "outer returned result inner",
      "outer after",
      "outer resumed",
    ]);
  });

  it("places an @Advisor class by the order of its instance, and one without an order among the unordered aspects", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const pointcut = P.method(Service, "run");

    function ordered(label: string, order?: number) {
      @Aspect(order === undefined ? {} : { order })
      class Ordered {
        @Before(pointcut)
        record(_joinPoint: JoinPoint<AnyShape>) {
          log.push(label);
        }
      }
      return Ordered;
    }

    function interceptor(label: string): MethodInterceptor {
      return {
        invoke: (invocation) => {
          log.push(label);
          return invocation.proceed();
        },
      };
    }

    @Advisor()
    class ConfiguredAdvisor {
      static readonly pointcut = pointcut;

      readonly advice = interceptor("advisor 5");

      constructor(@Inject("ADVISOR_ORDER") readonly order: number) {}
    }

    @Advisor()
    class PlainAdvisor {
      static readonly pointcut = pointcut;

      readonly advice = interceptor("advisor");
    }

    const { moduleRef } = await initWoven({
      providers: [
        Service,
        { provide: "ADVISOR_ORDER", useValue: 5 },
        ordered("aspect 10", 10),
        ordered("aspect a"),
        PlainAdvisor,
        ConfiguredAdvisor,
        ordered("aspect b"),
        ordered("aspect 1", 1),
      ],
    });
    moduleRef.get(Service).run();

    expect(log).toEqual([
      "aspect 1",
      "advisor 5",
      "aspect 10",
      "aspect a",
      "advisor",
      "aspect b",
      "run",
    ]);
    expect(
      moduleRef
        .get(AspectInspector)
        .advisorsOf(Service, "run")
        .map((advisor) => advisor.order),
    ).toEqual([1, 5, 10, undefined, undefined, undefined]);
  });
});
