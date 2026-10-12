import "reflect-metadata";
import {
  forwardRef,
  Global,
  Inject,
  Injectable,
  Module,
  type ModuleMetadata,
  type OnApplicationShutdown,
  Scope,
} from "@nestjs/common";
import { ContextIdFactory, LazyModuleLoader } from "@nestjs/core";
import { Test, type TestingModule } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { AspectModule } from "./aspect.module";
import {
  Advisor,
  AfterReturning,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectInspector } from "./aspect-inspector";
import { AspectNotReadyError, AspectUsageError } from "./errors";
import { Pointcut as P } from "./pointcut-designators";
import type {
  AnyShape,
  Class,
  ClassFilter,
  JoinPoint,
  JoinPointOf,
  MethodInterceptor,
  Pointcut,
  ProceedingJoinPointOf,
} from "./types";
import {
  closeWoven,
  compileWoven,
  initWoven,
  RecordingLogger,
} from "./weaving-fixture";

const applications: TestingModule[] = [];

afterEach(async () => {
  await closeWoven();
  await Promise.all(
    applications.splice(0).map((application) => application.close()),
  );
});

/**
 * Initializes a testing module with the imports exactly as given, so a test
 * decides where `AspectModule` stands among them.
 */
async function initOrdered(
  metadata: ModuleMetadata,
): Promise<{ moduleRef: TestingModule; logger: RecordingLogger }> {
  const logger = new RecordingLogger();
  const moduleRef = await Test.createTestingModule(metadata)
    .setLogger(logger)
    .compile();
  applications.push(moduleRef);
  await moduleRef.init();
  return { moduleRef, logger };
}

const Authorized = createAnnotation<"Authorized">("Authorized", {
  requiresAdvice: true,
});

/** An aspect that records the join points `pointcut` matches. */
function recorder(pointcut: Pointcut<AnyShape>, log: string[], label = "") {
  @Aspect()
  class Recorder {
    @Before(pointcut)
    record(joinPoint: JoinPoint<AnyShape>) {
      const { targetType, name } = joinPoint.signature;
      log.push(`${label}${targetType.name}.${String(name)}`);
    }
  }
  return Recorder;
}

/** A promise with the function that resolves it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("request-scoped and transient factory providers", () => {
  it("resolves an object literal, an object without a prototype, a native object and an object that inherits from an instance, and weaves none of them", async () => {
    const log: string[] = [];

    @Injectable()
    class Settings {
      get(key: string) {
        return `setting ${key}`;
      }
    }

    class Defaults {
      get(key: string) {
        return `default ${key}`;
      }
    }
    const nativeGet = Map.prototype.get;
    const { moduleRef } = await initWoven({
      providers: [
        Settings,
        recorder(P.name("get"), log),
        recorder(P.bean("INHERITING"), log, "bean "),
        {
          provide: "INHERITING",
          scope: Scope.REQUEST,
          useFactory: (): Defaults => Object.create(new Defaults()),
        },
        {
          provide: "LITERAL",
          scope: Scope.REQUEST,
          useFactory: () => ({ get: (key: string) => `literal ${key}` }),
        },
        {
          provide: "BARE",
          scope: Scope.TRANSIENT,
          useFactory: () =>
            Object.assign(Object.create(null), {
              get: (key: string) => `bare ${key}`,
            }),
        },
        {
          provide: "NATIVE",
          scope: Scope.REQUEST,
          useFactory: () => new Map([["key", "native key"]]),
        },
      ],
    });
    const contextId = ContextIdFactory.create();
    const results: unknown[] = [];
    for (const token of ["LITERAL", "BARE", "NATIVE", "INHERITING"]) {
      const resolved = await moduleRef.resolve<{
        get(key: string): unknown;
      }>(token, contextId);
      results.push(resolved.get("key"));
    }
    results.push(moduleRef.get(Settings).get("key"));
    // The class an object inherits from through an instance is no class of
    // the container.
    results.push(new Defaults().get("key"));

    expect(results).toEqual([
      "literal key",
      "bare key",
      "native key",
      "default key",
      "setting key",
      "default key",
    ]);
    expect(log).toEqual(["Settings.get"]);
    expect(Map.prototype.get).toBe(nativeGet);
  });

  it.each<{ entry: string; exclude: (type: Class) => Class | ClassFilter }>([
    { entry: "a class", exclude: (type) => type },
    {
      entry: "a class filter on the provider token",
      exclude: () => P.bean("DRAFT").classFilter,
    },
  ])(
    "leaves the instance unadvised when $entry of the exclude option names its class",
    async ({ exclude }) => {
      const log: string[] = [];

      class Draft {
        run() {
          log.push("run");
        }

        @Authorized()
        publish() {
          log.push("publish");
        }
      }
      const { moduleRef } = await initWoven(
        {
          providers: [
            recorder(P.within(Draft).or(P.annotated(Authorized)), log),
            {
              provide: "DRAFT",
              scope: Scope.REQUEST,
              useFactory: () => new Draft(),
            },
          ],
        },
        { exclude: [exclude(Draft)] },
      );
      const draft = await moduleRef.resolve<Draft>(
        "DRAFT",
        ContextIdFactory.create(),
      );

      draft.run();
      expect(log).toEqual(["run"]);
      expect(() => draft.publish()).toThrow(
        "Draft.publish carries @Authorized, which requires advice, and Draft is never advised",
      );
      expect(log).toEqual(["run"]);
    },
  );
});

describe("transitive module pointcuts", () => {
  it("matches every module of a graph with an import cycle and with a module two paths reach", async () => {
    const log: string[] = [];

    @Injectable()
    class OrderService {
      run() {}
    }

    @Injectable()
    class PaymentService {
      run() {}
    }

    @Injectable()
    class ClockService {
      run() {}
    }

    @Injectable()
    class OutsideService {
      run() {}
    }

    @Module({
      providers: [ClockService],
      exports: [ClockService],
    })
    class ClockModule {}

    @Module({
      imports: [forwardRef(() => PaymentModule), ClockModule],
      providers: [OrderService],
      exports: [OrderService],
    })
    class OrderModule {}

    @Module({
      imports: [forwardRef(() => OrderModule), ClockModule],
      providers: [PaymentService],
      exports: [PaymentService],
    })
    class PaymentModule {}

    @Module({
      providers: [OutsideService],
      exports: [OutsideService],
    })
    class OutsideModule {}

    const { moduleRef } = await initWoven({
      imports: [OrderModule, OutsideModule],
      providers: [
        recorder(P.inModule(OrderModule, { transitive: true }), log, "order "),
        recorder(
          P.inModule(PaymentModule, { transitive: true }),
          log,
          "payment ",
        ),
      ],
    });
    for (const type of [
      OrderService,
      PaymentService,
      ClockService,
      OutsideService,
    ]) {
      moduleRef.get(type, { strict: false }).run();
    }
    expect(log).toEqual([
      "order OrderService.run",
      "payment OrderService.run",
      "order PaymentService.run",
      "payment PaymentService.run",
      "order ClockService.run",
      "payment ClockService.run",
    ]);
  });

  it("reaches a global module from the modules that list it, also through forwardRef", async () => {
    const log: string[] = [];

    @Injectable()
    class ConfigService {
      run() {}
    }

    @Global()
    @Module({
      providers: [ConfigService],
      exports: [ConfigService],
    })
    class ConfigModule {}

    @Module({
      imports: [ConfigModule],
    })
    class ListingModule {}

    @Module({
      imports: [forwardRef(() => ConfigModule)],
    })
    class ForwardingModule {}

    @Module({})
    class SilentModule {}

    const { moduleRef } = await initWoven({
      imports: [ListingModule, ForwardingModule, SilentModule],
      providers: [
        recorder(
          P.inModule(ListingModule, { transitive: true }),
          log,
          "listing ",
        ),
        recorder(
          P.inModule(ForwardingModule, { transitive: true }),
          log,
          "forwarding ",
        ),
        recorder(
          P.inModule(SilentModule, { transitive: true }),
          log,
          "silent ",
        ),
      ],
    });
    moduleRef.get(ConfigService, { strict: false }).run();

    expect(log).toEqual([
      "listing ConfigService.run",
      "forwarding ConfigService.run",
    ]);
  });
});

describe("a perTarget aspect on a call without its instance", () => {
  it("raises AspectUsageError and does not run the member", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perTarget" })
    class Counting {
      @Before(pointcut)
      count(_joinPoint: JoinPoint<AnyShape>) {
        log.push("advice");
      }
    }
    const { moduleRef } = await initWoven({ providers: [Service, Counting] });
    const service = moduleRef.get(Service);
    const { run } = service;

    expect(() => run()).toThrow(AspectUsageError);
    expect(() => run()).toThrow(
      "Service.run was called without its instance, which the perTarget aspect Counting needs",
    );
    expect(log).toEqual([]);

    service.run();
    expect(log).toEqual(["advice", "run"]);
  });
});

describe("@Advisor classes that are no singletons", () => {
  function metered(scope: "own" | "dependency") {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }

    @Injectable({ scope: Scope.REQUEST })
    class Tenant {}

    // The scope option is applied after @Advisor, which makes the class a
    // provider of the default scope.
    @Injectable(scope === "own" ? { scope: Scope.TRANSIENT } : {})
    @Advisor()
    class Metering {
      static readonly pointcut = P.method(Service, "run");

      readonly advice: MethodInterceptor = {
        invoke: (invocation) => {
          log.push("advice");
          return invocation.proceed();
        },
      };

      constructor(@Inject(scope === "own" ? "UNIT" : Tenant) _unit: unknown) {}
    }
    const providers = [
      Service,
      Tenant,
      Metering,
      { provide: "UNIT", useValue: "call" },
    ];
    return { Service, providers, log };
  }

  it.each([
    { scope: "own" as const, title: "transient by its own scope" },
    { scope: "dependency" as const, title: "request-scoped by a dependency" },
  ])(
    "fails the bootstrap in strict mode for an advisor that is $title",
    async ({ scope }) => {
      const { providers } = metered(scope);

      await expect(initWoven({ providers })).rejects.toThrow(
        "The advisor Metering is not a singleton",
      );
    },
  );

  it.each([
    { scope: "own" as const, title: "transient by its own scope" },
    { scope: "dependency" as const, title: "request-scoped by a dependency" },
  ])(
    "warns without strict mode and rejects every call for an advisor that is $title",
    async ({ scope }) => {
      const { Service, providers, log } = metered(scope);

      const { moduleRef, logger } = await initWoven(
        { providers },
        { strict: false },
      );
      expect(logger.messages("warn")).toEqual([
        expect.stringContaining("The advisor Metering is not a singleton"),
      ]);
      expect(moduleRef.get(AspectInspector).advisorsOf(Service, "run")).toEqual(
        [],
      );

      const service = moduleRef.get(Service);
      for (const _attempt of [1, 2]) {
        expect(() => service.run()).toThrow(AspectNotReadyError);
      }
      expect(log).toEqual([]);
    },
  );
});

describe("@Advisor instances that fail while they are described", () => {
  function broken() {
    @Injectable()
    class Service {
      run() {}
    }

    @Advisor()
    class Broken {
      static readonly pointcut = P.method(Service, "run");

      get advice(): MethodInterceptor {
        throw new TypeError("the advice is unavailable");
      }
    }
    return { providers: [Service, Broken] };
  }

  it("fails the bootstrap with the error of the advisor, also without strict mode", async () => {
    const error = await initWoven(broken(), { strict: false }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).toContain("the advice is unavailable");
  });

  it("raises the error of the advisor from AspectInspector", async () => {
    const { moduleRef } = await compileWoven(broken());
    const inspector = moduleRef.get(AspectInspector);

    expect(() => inspector.advisedMembers()).toThrow(
      "the advice is unavailable",
    );
  });
});

describe("validation warnings", () => {
  it("warns once about two aspects that share an order on several members", async () => {
    @Injectable()
    class Service {
      run() {}

      stop() {}

      get state() {
        return "idle";
      }
    }
    const pointcut = P.within(Service).and(
      P.kind("method").or(P.kind("getter")),
    );

    @Aspect({ order: 5 })
    class First {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {}
    }

    @Aspect({ order: 5 })
    class Second {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {}
    }

    const { logger } = await initWoven({
      providers: [Service, First, Second],
    });
    expect(logger.messages("warn")).toEqual([
      "First and Second advise Service.run with order 5; First runs first because it is registered first",
    ]);
  });

  it.each([
    { scope: Scope.REQUEST, title: "request-scoped", warnings: 0 },
    { scope: Scope.DEFAULT, title: "singleton", warnings: 1 },
  ])(
    "logs $warnings shutdown-order warnings for a global module before AspectModule whose $title provider has a shutdown hook",
    async ({ scope, warnings }) => {
      @Injectable()
      class Settings {
        read() {
          return "settings";
        }
      }

      @Injectable({ scope })
      class Audit implements OnApplicationShutdown {
        onApplicationShutdown() {}
      }

      @Global()
      @Module({
        providers: [Settings, Audit],
        exports: [Settings, Audit],
      })
      class ConfigModule {}

      const { moduleRef, logger } = await initOrdered({
        imports: [ConfigModule, AspectModule.forRoot()],
      });
      expect(moduleRef.get(Settings, { strict: false }).read()).toBe(
        "settings",
      );
      expect(logger.messages("warn")).toEqual(
        warnings === 0
          ? []
          : [
              expect.stringContaining(
                "The global module ConfigModule is imported before AspectModule, so the onApplicationShutdown hook of Audit runs after",
              ),
            ],
      );
    },
  );

  it("logs each warning once when lazy modules are loaded, and logs the warnings they add", async () => {
    @Injectable()
    class Report {
      render() {}
    }

    @Module({
      providers: [Report],
    })
    class ReportModule {}

    @Injectable()
    class Vault {
      @Authorized()
      open() {}
    }

    @Module({
      providers: [Vault],
    })
    class VaultModule {}

    @Injectable()
    class Mailer {
      send() {}
    }

    @Module({
      providers: [Mailer],
    })
    class MailerModule {}

    const { moduleRef, logger } = await initWoven(
      { providers: [recorder(P.name("rneder"), [])] },
      { strict: false },
    );
    const unmatched =
      "The pointcut of Recorder.record (before) matches no member of the application";
    expect(logger.messages("warn")).toEqual([unmatched]);
    const loader = moduleRef.get(LazyModuleLoader);

    await loader.load(() => ReportModule);
    expect(logger.messages("warn")).toEqual([unmatched]);

    await loader.load(() => VaultModule);
    expect(logger.messages("warn")).toEqual([
      unmatched,
      expect.stringContaining("Vault.open (@Authorized)"),
    ]);

    await loader.load(() => MailerModule);
    expect(logger.messages("warn")).toHaveLength(2);
  });
});

describe("overlapping calls on request-scoped instances", () => {
  it("keeps the target, the arguments and the result of each call apart", async () => {
    const gates = {
      apple: deferred(),
      bread: deferred(),
      cider: deferred(),
    };
    type Item = keyof typeof gates;

    @Injectable({ scope: Scope.REQUEST })
    class Cart {
      readonly items: string[] = [];

      async add(item: Item): Promise<string> {
        await gates[item].promise;
        this.items.push(item);
        return `${item} in a cart of ${this.items.length}`;
      }
    }
    const pointcut = P.method(Cart, "add");
    const entered: unknown[] = [];
    const settled: { target: unknown; args: unknown[]; value: unknown }[] = [];

    @Aspect()
    class Tracking {
      @Around(pointcut)
      async around(
        joinPoint: ProceedingJoinPointOf<typeof pointcut>,
      ): Promise<string> {
        const [item] = joinPoint.args;
        entered.push(item);
        const value = await joinPoint.proceed();
        settled.push({
          target: joinPoint.target,
          args: [...joinPoint.args],
          value,
        });
        return `${item}: ${value}`;
      }

      @AfterReturning(pointcut)
      returned(joinPoint: JoinPointOf<typeof pointcut>, value: string): void {
        settled.push({
          target: joinPoint.target,
          args: [...joinPoint.args],
          value,
        });
      }
    }
    const { moduleRef } = await initWoven({ providers: [Cart, Tracking] });
    const first = await moduleRef.resolve(Cart, ContextIdFactory.create());
    const second = await moduleRef.resolve(Cart, ContextIdFactory.create());
    expect(first).not.toBe(second);

    const apple = first.add("apple");
    const bread = second.add("bread");
    const cider = first.add("cider");
    expect(entered).toEqual(["apple", "bread", "cider"]);
    expect(settled).toEqual([]);

    // The calls settle in another order than they started.
    gates.bread.resolve();
    await expect(bread).resolves.toBe("bread: bread in a cart of 1");
    gates.cider.resolve();
    await expect(cider).resolves.toBe("cider: cider in a cart of 1");
    gates.apple.resolve();
    await expect(apple).resolves.toBe("apple: apple in a cart of 2");

    const expected = (target: Cart, item: Item, size: number) => {
      const call = {
        target,
        args: [item],
        value: `${item} in a cart of ${size}`,
      };
      // The after-returning advice, then the around advice that resumes.
      return [call, call];
    };
    expect(settled).toEqual([
      ...expected(second, "bread", 1),
      ...expected(first, "cider", 1),
      ...expected(first, "apple", 2),
    ]);
    expect(settled.map((call) => call.target === first)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
    expect([first.items, second.items]).toEqual([
      ["cider", "apple"],
      ["bread"],
    ]);
  });
});
