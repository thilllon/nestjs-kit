import "reflect-metadata";
import { Injectable, Module, Scope } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { AspectModule } from "./aspect.module";
import { Around, Aspect, Before } from "./aspect-decorators";
import { AspectConfigurationError, AspectNotReadyError } from "./errors";
import { P } from "./pointcut-designators";
import type { AnyShape, JoinPoint, JP, PJP } from "./types";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

/** The error with which the initialization of a woven module fails. */
async function initError(
  ...parameters: Parameters<typeof initWoven>
): Promise<unknown> {
  return initWoven(...parameters).then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("scope validation", () => {
  function scopedAspects() {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        return "ran";
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class RequestState {}
    const run = P.method(Service, "run");

    @Aspect()
    class BubblingAspect {
      constructor(readonly state: RequestState) {}

      @Before(run)
      record(_jp: JP<typeof run>) {
        log.push("advised");
      }
    }
    return { Service, RequestState, BubblingAspect, log };
  }

  it("rejects an aspect that is request-scoped through a dependency", async () => {
    const { Service, RequestState, BubblingAspect, log } = scopedAspects();
    const error = await initError({
      providers: [Service, RequestState, BubblingAspect],
    });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "The aspect BubblingAspect is not a singleton",
    );
    for (const hint of ["ModuleRef.resolve()", "ContextIdFactory", "CLS"]) {
      expect(String(error)).toContain(hint);
    }
    // The failed application no longer advises the class.
    expect(new Service().run()).toBe("ran");
    expect(log).toEqual([]);
  });

  it("rejects an aspect that declares a scope itself", async () => {
    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");

    @Injectable({ scope: Scope.TRANSIENT })
    @Aspect()
    class TransientAspect {
      @Before(run)
      record(_jp: JP<typeof run>) {}
    }
    const error = await initError({ providers: [Service, TransientAspect] });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain("TransientAspect is not a singleton");
  });

  it("warns without strict mode and never skips the advice silently", async () => {
    const { Service, RequestState, BubblingAspect, log } = scopedAspects();
    const { moduleRef, logger } = await initWoven(
      { providers: [Service, RequestState, BubblingAspect] },
      { strict: false },
    );
    expect(logger.messages("warn")).toEqual([
      expect.stringContaining("The aspect BubblingAspect is not a singleton"),
    ]);
    expect(() => moduleRef.get(Service).run()).toThrow(AspectNotReadyError);
    expect(log).toEqual([]);
  });
});

describe("bootstrap validation", () => {
  it("rejects advice decorators on a class without @Aspect", async () => {
    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");

    @Injectable()
    class Forgotten {
      @Before(run)
      record(_jp: JP<typeof run>) {}
    }
    const error = await initError({ providers: [Service, Forgotten] });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "Forgotten declares advice (record) but is not decorated with @Aspect",
    );
  });

  it("rejects a requiresAdvice annotation that no advisor matches, listing the members", async () => {
    const Retryable = createAnnotation<"Retryable">("Retryable", {
      requiresAdvice: true,
    });
    const Cached = createAnnotation<"Cached">("Cached", {
      requiresAdvice: true,
    });
    const Audited = createAnnotation<"Audited">("Audited");

    @Injectable()
    class UserService {
      @Retryable()
      findById() {}

      @Cached()
      get profile() {
        return 1;
      }

      @Audited()
      rename() {}
    }

    @Injectable()
    class OrderService {
      @Retryable()
      place() {}
    }
    const placing = P.method(OrderService, "place");

    @Aspect()
    class OrderAspect {
      @Around(placing)
      retry(jp: PJP<typeof placing>) {
        return jp.proceed();
      }
    }

    const error = await initError({
      providers: [UserService, OrderService, OrderAspect],
    });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "UserService.findById (@Retryable), UserService.get profile (@Cached).",
    );
    expect(String(error)).not.toContain("rename");
    expect(String(error)).not.toContain("OrderService");
  });

  it("warns about a pointcut that matches nothing and about aspects that share an order", async () => {
    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");
    const typo = P.name("rnu");

    @Aspect({ order: 5 })
    class First {
      @Before(run)
      record(_jp: JP<typeof run>) {}

      @Before(typo)
      never(_jp: JoinPoint<AnyShape>) {}
    }

    @Aspect({ order: 5 })
    class Second {
      @Before(run)
      record(_jp: JP<typeof run>) {}
    }

    @Aspect({ order: 6 })
    class Third {
      @Before(run)
      record(_jp: JP<typeof run>) {}
    }

    const { logger } = await initWoven({
      providers: [Service, First, Second, Third],
    });
    expect(logger.messages("warn")).toEqual([
      "The pointcut of First.never (before) matches no member of the application",
      "First and Second advise Service.run with order 5; First runs first because it is registered first",
    ]);
  });

  it("warns about an aspect that several modules register", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");

    @Aspect()
    class Twice {
      @Before(run)
      record(_jp: JP<typeof run>) {
        log.push("advised");
      }
    }

    @Module({
      providers: [Twice],
    })
    class FirstModule {}

    @Module({
      providers: [Twice],
    })
    class SecondModule {}

    const { moduleRef, logger } = await initWoven({
      imports: [FirstModule, SecondModule],
      providers: [Service],
    });
    moduleRef.get(Service).run();
    // The advice runs once, on one instance.
    expect(log).toEqual(["advised"]);
    expect(logger.messages("warn")).toEqual([
      "Twice is registered 2 times; the instance of FirstModule serves its advice",
    ]);
  });

  it("logs the weaving report in chain order at the configured level", async () => {
    @Injectable()
    class UserService {
      findById() {}

      get name() {
        return "name";
      }
    }
    const findById = P.method(UserService, "findById");
    const getters = P.within(UserService).and(P.kind("getter"));

    @Aspect()
    class AuditAspect {
      @Before(findById)
      audit(_jp: JP<typeof findById>) {}

      @Before(getters)
      read(_jp: JP<typeof getters>) {}
    }

    @Aspect({ order: 10 })
    class ResilienceAspect {
      @Around(findById)
      retry(jp: PJP<typeof findById>) {
        return jp.proceed();
      }
    }
    const providers = [UserService, AuditAspect, ResilienceAspect];
    const lines = [
      "UserService.findById <- ResilienceAspect.retry (around, order 10)",
      "UserService.findById <- AuditAspect.audit (before, no order)",
      "UserService.get name <- AuditAspect.read (before, no order)",
    ];

    const byDefault = await initWoven({ providers });
    expect(byDefault.logger.messages("debug")).toEqual(lines);

    const atLog = await initWoven({ providers }, { report: "log" });
    expect(atLog.logger.messages("log")).toEqual(lines);
    expect(atLog.logger.messages("debug")).toEqual([]);

    const silent = await initWoven({ providers }, { report: false });
    expect(silent.logger.entries).toEqual([]);
  });

  it("rejects a second import with other options and an unknown report level", async () => {
    await expect(
      compileWoven({ imports: [AspectModule.forRoot({ strict: false })] }),
    ).rejects.toThrow("AspectModule is imported 2 times");
    await expect(compileWoven({}, { report: "info" as never })).rejects.toThrow(
      AspectConfigurationError,
    );
  });
});
