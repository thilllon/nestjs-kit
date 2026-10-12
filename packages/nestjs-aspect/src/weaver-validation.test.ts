import "reflect-metadata";
import { Injectable, Module, Scope } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { AspectModule } from "./aspect.module";
import { Advisor, Around, Aspect, Before } from "./aspect-decorators";
import { AspectConfigurationError, AspectNotReadyError } from "./errors";
import { Pointcut as P } from "./pointcut-designators";
import type {
  AnyShape,
  JoinPoint,
  JoinPointOf,
  MethodInterceptor,
  ProceedingJoinPointOf,
} from "./types";
import {
  closeWoven,
  compileWoven,
  initWoven,
  RecordingLogger,
} from "./weaving-fixture";

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
      record(_jp: JoinPointOf<typeof run>) {
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
      record(_jp: JoinPointOf<typeof run>) {}
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
      record(_jp: JoinPointOf<typeof run>) {}
    }
    const error = await initError({ providers: [Service, Forgotten] });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "Forgotten declares advice (record) but is not decorated with @Aspect",
    );
  });

  it("rejects a requiresAdvice annotation that no advisor handles, listing the members", async () => {
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
    const placing = P.within(OrderService).and(P.annotated(Retryable));
    const everything = P.within(UserService, OrderService);

    @Aspect()
    class OrderAspect {
      @Around(placing)
      retry(joinPoint: ProceedingJoinPointOf<typeof placing>) {
        return joinPoint.proceed();
      }
    }

    /** Matches the annotated members without referring to their annotations. */
    @Aspect()
    class LoggingAspect {
      @Before(everything)
      record(_jp: JoinPointOf<typeof everything>) {}
    }

    const error = await initError({
      providers: [UserService, OrderService, OrderAspect, LoggingAspect],
    });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "UserService.findById (@Retryable), UserService.get profile (@Cached).",
    );
    expect(String(error)).not.toContain("rename");
    expect(String(error)).not.toContain("OrderService");
  });

  it("accepts a requiresAdvice annotation under a composed or a custom pointcut", async () => {
    const Retryable = createAnnotation<"RetryableComposed">(
      "RetryableComposed",
      { requiresAdvice: true },
    );
    const Cached = createAnnotation<"CachedComposed">("CachedComposed", {
      requiresAdvice: true,
    });

    @Injectable()
    class Service {
      @Retryable()
      find() {}

      @Cached()
      load() {}
    }
    // Guarantees neither annotation and refers to both.
    const either = P.annotated(Retryable).or(P.annotated(Cached));
    const custom = P.matching({
      classFilter: { matches: (classRef) => classRef.type === Service },
      methodMatcher: { isRuntime: false, matches: () => true },
    });

    @Aspect()
    class Composed {
      @Before(either)
      record(_jp: JoinPointOf<typeof either>) {}
    }

    @Aspect()
    class Custom {
      @Before(custom)
      record(_jp: JoinPointOf<typeof custom>) {}
    }

    await expect(
      initError({ providers: [Service, Composed] }),
    ).resolves.toBeUndefined();
    await expect(
      initError({ providers: [Service, Custom] }),
    ).resolves.toBeUndefined();
  });

  it("accepts a requiresAdvice annotation under a custom pointcut that is composed with an annotation pointcut", async () => {
    const Retryable = createAnnotation<"RetryableMixed">("RetryableMixed", {
      requiresAdvice: true,
    });
    const Other = createAnnotation<"OtherMixed">("OtherMixed");
    const log: string[] = [];

    @Injectable()
    class Service {
      @Retryable()
      find() {
        log.push("find");
      }
    }
    const custom = P.matching({
      classFilter: { matches: (classRef) => classRef.type === Service },
      methodMatcher: { isRuntime: false, matches: () => true },
    });
    // The annotations a caller-supplied matcher refers to are unknown, and
    // stay unknown in a composition.
    const pointcuts = {
      or: custom.or(P.annotated(Other)),
      and: custom.and(P.annotated(Other).not()),
    };

    for (const pointcut of Object.values(pointcuts)) {
      @Aspect()
      class Mixed {
        @Before(pointcut)
        record(_jp: JoinPoint<AnyShape>) {
          log.push("advice");
        }
      }
      const { moduleRef } = await initWoven({ providers: [Service, Mixed] });
      moduleRef.get(Service).find();
      await moduleRef.close();
    }
    expect(log).toEqual(["advice", "find", "advice", "find"]);
  });

  it("requires advice for accessors and lifecycle hooks only by an annotation they carry themselves", async () => {
    const Secured = createAnnotation<"SecuredClass">("SecuredClass", {
      requiresAdvice: true,
    });
    const log: string[] = [];

    @Secured()
    @Injectable()
    class Vault {
      private opened = false;

      onModuleInit() {
        this.opened = true;
      }

      get isOpen() {
        return this.opened;
      }

      read() {
        return "content";
      }
    }
    const secured = P.withinAnnotated(Secured);

    @Aspect()
    class Securing {
      @Before(secured)
      check(joinPoint: JoinPoint<AnyShape>) {
        log.push(String(joinPoint.signature.name));
      }
    }

    const { moduleRef } = await initWoven({ providers: [Vault, Securing] });
    const vault = moduleRef.get(Vault);
    expect(vault.isOpen).toBe(true);
    expect(vault.read()).toBe("content");
    expect(log).toEqual(["read"]);

    @Injectable()
    class Ledger {
      @Secured()
      get balance() {
        return 0;
      }
    }
    const error = await initError({ providers: [Ledger, Securing] });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain("Ledger.get balance (@SecuredClass)");
  });

  it("rejects a requiresAdvice annotation on a member of an aspect", async () => {
    const Retryable = createAnnotation<"RetryableOnAspect">(
      "RetryableOnAspect",
      { requiresAdvice: true },
    );

    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");

    @Aspect()
    class Helping {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {}

      @Retryable()
      helper() {}
    }

    const error = await initError({ providers: [Service, Helping] });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "aspects, advisors, module classes and the classes of the exclude option are never advised: Helping.helper (@RetryableOnAspect).",
    );
  });

  it("rejects an aspect or advisor that a factory or value provider supplies", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");

    @Aspect()
    class FromFactory {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {
        log.push("factory");
      }
    }

    @Advisor()
    class FromValue {
      static readonly pointcut = run;

      readonly advice: MethodInterceptor = {
        invoke: (invocation) => invocation.proceed(),
      };
    }
    const providers = [
      Service,
      { provide: FromFactory, useFactory: () => new FromFactory() },
      { provide: "ADVISOR", useValue: new FromValue() },
    ];

    const error = await initError({ providers });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "The aspect FromFactory is the instance of a factory, value or alias provider, so its advice does not run.",
    );
    expect(String(error)).toContain("The advisor FromValue is the instance");

    // No call could report advice that never runs, so strict mode does not
    // decide this error.
    expect(String(await initError({ providers }, { strict: false }))).toBe(
      String(error),
    );
    expect(log).toEqual([]);
  });

  it("rejects an aspect that a request-scoped factory provider returns when the container resolves it", async () => {
    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");

    @Aspect()
    class Late {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {}
    }

    const { moduleRef } = await initWoven({
      providers: [
        Service,
        { provide: "LATE", scope: Scope.REQUEST, useFactory: () => new Late() },
      ],
    });
    await expect(
      moduleRef.resolve("LATE", ContextIdFactory.create()),
    ).rejects.toThrow(
      "The aspect Late is the instance of a factory, value or alias provider, so its advice does not run.",
    );
  });

  it("reports an invalid advisor instance as a validation problem", async () => {
    @Injectable()
    class Service {
      run() {}
    }

    @Advisor()
    class Unordered {
      static readonly pointcut = P.method(Service, "run");

      readonly order = "first" as never;

      readonly advice: MethodInterceptor = {
        invoke: (invocation) => invocation.proceed(),
      };
    }
    const providers = [Service, Unordered];

    const error = await initError({ providers });
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(String(error)).toContain(
      "The advisor Unordered has an order that is not a number",
    );

    const { logger } = await initWoven({ providers }, { strict: false });
    expect(logger.messages("warn")).toEqual([
      "The advisor Unordered has an order that is not a number",
    ]);
  });

  it("rejects options that depend on a request-scoped provider", async () => {
    @Injectable({ scope: Scope.REQUEST })
    class Tenant {}

    @Module({
      providers: [Tenant],
      exports: [Tenant],
    })
    class TenantModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        AspectModule.forRootAsync({
          imports: [TenantModule],
          inject: [Tenant],
          useFactory: () => ({}),
        }),
      ],
    }).compile();
    await expect(moduleRef.init()).rejects.toThrow(
      "The options of AspectModule.forRootAsync depend on a request-scoped or transient provider",
    );
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
      record(_jp: JoinPointOf<typeof run>) {}

      @Before(typo)
      never(_jp: JoinPoint<AnyShape>) {}
    }

    @Aspect({ order: 5 })
    class Second {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {}
    }

    @Aspect({ order: 6 })
    class Third {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {}
    }

    const { logger } = await initWoven({
      providers: [Service, First, Second, Third],
    });
    expect(logger.messages("warn")).toEqual([
      "The pointcut of First.never (before) matches no member of the application",
      "First and Second advise Service.run with order 5; First runs first because it is registered first",
    ]);
  });

  it("warns about aspects without an order on one member, and not about the advice of one aspect", async () => {
    @Injectable()
    class Service {
      run() {}

      stop() {}
    }
    const run = P.method(Service, "run");
    const stop = P.method(Service, "stop");

    @Aspect()
    class Alone {
      @Before(stop)
      first(_jp: JoinPointOf<typeof stop>) {}

      @Before(stop)
      second(_jp: JoinPointOf<typeof stop>) {}
    }

    @Aspect()
    class First {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {}
    }

    @Aspect()
    class Second {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {}
    }

    const { logger } = await initWoven({
      providers: [Service, Alone, First, Second],
    });
    expect(logger.messages("warn")).toEqual([
      "First and Second advise Service.run with no order; First runs first because it is registered first",
    ]);
  });

  it("runs no advice of an aspect that a test replaces with a value, and warns when the advised class is replaced", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const run = P.method(Service, "run");

    @Aspect()
    class Auditing {
      @Before(run)
      record(_jp: JoinPointOf<typeof run>) {
        log.push("advice");
      }
    }
    const metadata = {
      imports: [AspectModule.forRoot()],
      providers: [Service, Auditing],
    };

    const withoutAspect = await Test.createTestingModule(metadata)
      .overrideProvider(Auditing)
      .useValue({})
      .compile();
    await withoutAspect.init();
    withoutAspect.get(Service).run();
    await withoutAspect.close();
    expect(log).toEqual(["run"]);

    const logger = new RecordingLogger();
    const withoutService = await Test.createTestingModule(metadata)
      .overrideProvider(Service)
      .useValue({ run: () => log.push("mock") })
      .setLogger(logger)
      .compile();
    await withoutService.init();
    withoutService.get(Service).run();
    await withoutService.close();
    expect(log).toEqual(["run", "mock"]);
    expect(logger.messages("warn")).toEqual([
      "The pointcut of Auditing.record (before) matches no member of the application",
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
      record(_jp: JoinPointOf<typeof run>) {
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
      audit(_jp: JoinPointOf<typeof findById>) {}

      @Before(getters)
      read(_jp: JoinPointOf<typeof getters>) {}
    }

    @Aspect({ order: 10 })
    class ResilienceAspect {
      @Around(findById)
      retry(joinPoint: ProceedingJoinPointOf<typeof findById>) {
        return joinPoint.proceed();
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

  it("rejects a second registration and an unknown report level", async () => {
    @Module({
      imports: [AspectModule.forRoot()],
    })
    class FeatureModule {}

    // Every forRoot() call registers a module of its own, whatever its options.
    for (const second of [AspectModule, FeatureModule]) {
      await expect(compileWoven({ imports: [second] })).rejects.toThrow(
        "AspectModule is registered 2 times. Import AspectModule.forRoot() or forRootAsync() once",
      );
    }
    await expect(compileWoven({}, { report: "info" as never })).rejects.toThrow(
      AspectConfigurationError,
    );
  });
});
