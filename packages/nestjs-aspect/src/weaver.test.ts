import "reflect-metadata";
import {
  type ArgumentsHost,
  type CanActivate,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  Global,
  Inject,
  Injectable,
  type MiddlewareConsumer,
  Module,
  type NestMiddleware,
  type NestModule,
  type OnModuleInit,
  Scope,
  UseGuards,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import {
  Advisor,
  AfterReturning,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectInspector } from "./aspect-inspector";
import { AspectNotReadyError } from "./errors";
import { ORIGINAL } from "./method-ref";
import { P } from "./pointcut-designators";
import type {
  AnyShape,
  JoinPoint,
  JoinPointOf,
  MethodInterceptor,
  ProceedingJoinPointOf,
  Pointcut,
  ReturnValueAdapter,
} from "./types";
import {
  closeWoven,
  compileWoven,
  initWoven,
  listenWoven,
} from "./weaving-fixture";

afterEach(closeWoven);

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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("module and bean pointcuts in a container", () => {
  function modules() {
    @Injectable()
    class DeepService {
      run() {}
    }

    @Injectable()
    class MidService {
      run() {}
    }

    @Injectable()
    class RootService {
      run() {}
    }

    @Injectable()
    class SharedService {
      run() {}
    }

    @Injectable()
    class OtherService {
      run() {}
    }

    @Module({
      providers: [DeepService],
      exports: [DeepService],
    })
    class DeepModule {}

    @Module({
      imports: [DeepModule],
      providers: [MidService],
      exports: [MidService, DeepModule],
    })
    class MidModule {}

    @Global()
    @Module({
      providers: [SharedService],
      exports: [SharedService],
    })
    class SharedModule {}

    @Module({
      imports: [MidModule],
      providers: [RootService],
      exports: [RootService, MidModule],
    })
    class RootModule {}

    @Module({
      providers: [OtherService],
      exports: [OtherService],
    })
    class OtherModule {}

    const services = [
      RootService,
      MidService,
      DeepService,
      SharedService,
      OtherService,
    ];
    return { RootModule, MidModule, SharedModule, OtherModule, services };
  }

  it("matches the classes a module declares, and with transitive those of its imports", async () => {
    const { RootModule, SharedModule, OtherModule, services } = modules();
    const log: string[] = [];
    const { moduleRef } = await compileWoven({
      imports: [RootModule, SharedModule, OtherModule],
      providers: [
        recorder(P.inModule(RootModule), log, "direct "),
        recorder(P.inModule(RootModule, { transitive: true }), log, "deep "),
      ],
    });
    for (const service of services) {
      moduleRef.get(service, { strict: false }).run();
    }
    // SharedModule is global: Nest adds it to the imports of every module,
    // but RootModule does not list it.
    expect(log).toEqual([
      "direct RootService.run",
      "deep RootService.run",
      "deep MidService.run",
      "deep DeepService.run",
    ]);
  });

  it("matches provider tokens: class, string, and the instance of a factory provider", async () => {
    const log: string[] = [];

    @Injectable()
    class UserService {
      run() {}
    }

    class Mailer {
      run() {}
    }

    class Gateway {
      run() {}
    }

    @Injectable()
    class Unrelated {
      run() {}
    }

    const { moduleRef } = await initWoven({
      providers: [
        UserService,
        Unrelated,
        { provide: "MAILER", useClass: Mailer },
        { provide: "PAYMENT_GATEWAY", useFactory: () => new Gateway() },
        recorder(P.bean(UserService), log, "class "),
        recorder(P.bean("MAILER"), log, "string "),
        recorder(P.bean(/GATEWAY$/), log, "factory "),
      ],
    });
    moduleRef.get(UserService).run();
    moduleRef.get(Unrelated).run();
    moduleRef.get<Mailer>("MAILER").run();
    moduleRef.get<Gateway>("PAYMENT_GATEWAY").run();
    expect(log).toEqual([
      "class UserService.run",
      "string Mailer.run",
      "factory Gateway.run",
    ]);
  });

  it("evaluates each side of a disjunction of bean pointcuts with its own member condition", async () => {
    const log: string[] = [];

    class Reader {
      read() {}

      write() {}
    }

    class Writer {
      read() {}

      write() {}
    }
    const pointcut = P.bean("READER")
      .and(P.name("read"))
      .or(P.bean("WRITER").and(P.name("write")));

    const { moduleRef } = await compileWoven({
      providers: [
        { provide: "READER", useClass: Reader },
        { provide: "WRITER", useClass: Writer },
        recorder(pointcut, log),
      ],
    });
    for (const token of ["READER", "WRITER"]) {
      const bean = moduleRef.get<Reader | Writer>(token);
      bean.read();
      bean.write();
    }
    expect(log).toEqual(["Reader.read", "Writer.write"]);
  });

  it("weaves a class again when a factory supplies an instance of it under another token", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {}
    }

    const { moduleRef } = await compileWoven({
      providers: [
        Service,
        { provide: "ALIAS", useFactory: () => new Service() },
        recorder(P.bean("ALIAS"), log),
      ],
    });
    // The class of a factory instance is known when the application
    // initializes.
    moduleRef.get<Service>("ALIAS").run();
    expect(log).toEqual([]);

    await moduleRef.init();
    moduleRef.get<Service>("ALIAS").run();
    expect(log).toEqual(["Service.run"]);
    expect(
      moduleRef
        .get(AspectInspector)
        .advisedMembers(Service)
        .map((member) => [member.name, member.advisors.length]),
    ).toEqual([["run", 1]]);
  });
});

describe("dispatcher stubs", () => {
  it("installs one stub per member that keeps the name, the length and the metadata", async () => {
    class Report {}

    @Injectable()
    class ReportService {
      build(_from: Date, _to: Date): Report {
        return new Report();
      }

      untouched() {}
    }
    const original = ReportService.prototype.build;
    const untouched = ReportService.prototype.untouched;
    Reflect.defineMetadata("custom", "value", original);
    const pointcut = P.method(ReportService, "build");

    await compileWoven({ providers: [ReportService, recorder(pointcut, [])] });
    const stub = ReportService.prototype.build;
    expect(stub).not.toBe(original);
    expect((stub as unknown as Record<symbol, unknown>)[ORIGINAL]).toBe(
      original,
    );
    expect([stub.name, stub.length]).toEqual(["build", 2]);
    expect(Reflect.getMetadata("custom", stub)).toBe("value");
    expect(ReportService.prototype.untouched).toBe(untouched);

    // A second application reuses the stub.
    await compileWoven({ providers: [ReportService, recorder(pointcut, [])] });
    expect(ReportService.prototype.build).toBe(stub);
  });

  it("puts the stub of an inherited method on the concrete class", async () => {
    const log: string[] = [];

    class BaseRepository {
      find() {
        return "base";
      }

      save() {
        return "saved";
      }
    }

    @Injectable()
    class UserRepository extends BaseRepository {
      override save() {
        return `user ${super.save()}`;
      }
    }

    @Injectable()
    class PlainRepository extends BaseRepository {}
    const baseFind = BaseRepository.prototype.find;

    const { moduleRef } = await compileWoven({
      providers: [
        UserRepository,
        PlainRepository,
        recorder(P.target(UserRepository), log),
      ],
    });
    // The superclass is not registered and keeps its functions.
    expect(BaseRepository.prototype.find).toBe(baseFind);
    expect(Object.hasOwn(UserRepository.prototype, "find")).toBe(true);
    expect(Object.hasOwn(PlainRepository.prototype, "find")).toBe(false);

    expect(moduleRef.get(UserRepository).find()).toBe("base");
    // `super.save()` reaches the unwoven superclass method without advice.
    expect(moduleRef.get(UserRepository).save()).toBe("user saved");
    expect(moduleRef.get(PlainRepository).find()).toBe("base");
    expect(log).toEqual(["UserRepository.find", "UserRepository.save"]);
  });

  it("advises a super call when the superclass is woven, and not a subclass that only inherits the stub", async () => {
    const log: string[] = [];

    @Injectable()
    class BaseService {
      run() {
        return "base";
      }
    }

    @Injectable()
    class Overriding extends BaseService {
      override run() {
        return `overriding ${super.run()}`;
      }
    }

    @Injectable()
    class Inheriting extends BaseService {}

    const { moduleRef } = await compileWoven({
      providers: [
        BaseService,
        Overriding,
        Inheriting,
        recorder(P.bean(BaseService), log, "base "),
        recorder(P.bean(Overriding), log, "overriding "),
      ],
    });
    expect(moduleRef.get(BaseService).run()).toBe("base");
    expect(log.splice(0)).toEqual(["base BaseService.run"]);

    // Two executions: the override, then the superclass method.
    expect(moduleRef.get(Overriding).run()).toBe("overriding base");
    expect(log.splice(0)).toEqual([
      "overriding Overriding.run",
      "base BaseService.run",
    ]);

    // No advisor matches the bean Inheriting.
    expect(moduleRef.get(Inheriting).run()).toBe("base");
    expect(log).toEqual([]);
  });

  it("leaves an excluded subclass unadvised when its override calls super", async () => {
    const log: string[] = [];

    @Injectable()
    class BaseService {
      run() {
        return "base";
      }
    }

    @Injectable()
    class Legacy extends BaseService {
      override run() {
        return `legacy ${super.run()}`;
      }
    }

    const { moduleRef } = await compileWoven(
      { providers: [BaseService, Legacy, recorder(P.name("run"), log)] },
      { exclude: [Legacy] },
    );
    expect(moduleRef.get(Legacy).run()).toBe("legacy base");
    expect(moduleRef.get(BaseService).run()).toBe("base");
    expect(log).toEqual(["BaseService.run"]);
  });

  it("weaves both inherited accessors of a subclass with the advisors of the subclass", async () => {
    const log: string[] = [];

    @Injectable()
    class BaseSettings {
      private current = 1;

      get level() {
        return this.current;
      }

      set level(value: number) {
        this.current = value;
      }
    }

    @Injectable()
    class UserSettings extends BaseSettings {}

    /** Its getter is woven, its setter matches no advisor. */
    @Injectable()
    class ReadOnlySettings extends BaseSettings {}
    const accessors = P.kind("getter").or(P.kind("setter"));

    const { moduleRef } = await compileWoven({
      providers: [
        BaseSettings,
        UserSettings,
        ReadOnlySettings,
        recorder(P.bean(BaseSettings).and(accessors), log, "base "),
        recorder(P.bean(UserSettings).and(accessors), log, "user "),
        recorder(P.bean(ReadOnlySettings).and(P.kind("getter")), log, "read "),
      ],
    });
    const user = moduleRef.get(UserSettings);
    user.level = 2;
    expect(user.level).toBe(2);
    expect(log.splice(0)).toEqual([
      "user UserSettings.level",
      "user UserSettings.level",
    ]);

    const readOnly = moduleRef.get(ReadOnlySettings);
    readOnly.level = 3;
    expect(readOnly.level).toBe(3);
    expect(log.splice(0)).toEqual(["read ReadOnlySettings.level"]);

    const base = moduleRef.get(BaseSettings);
    base.level = 4;
    expect(base.level).toBe(4);
    expect(log).toEqual(["base BaseSettings.level", "base BaseSettings.level"]);
  });

  it("weaves getters and setters independently when P.kind selects them", async () => {
    const log: string[] = [];

    @Injectable()
    class Settings {
      private current = "light";

      get theme() {
        return this.current;
      }

      set theme(value: string) {
        this.current = value;
      }

      get untouched() {
        return 1;
      }

      describe() {
        return this.current;
      }
    }
    const setter = Object.getOwnPropertyDescriptor(
      Settings.prototype,
      "theme",
    )?.set;
    const getters = P.within(Settings)
      .and(P.kind("getter"))
      .and(P.name("theme"));

    @Aspect()
    class SettingsAspect {
      @Around(getters)
      upperCase(joinPoint: ProceedingJoinPointOf<typeof getters>) {
        log.push(`${joinPoint.kind} ${String(joinPoint.signature.name)}`);
        return String(joinPoint.proceed()).toUpperCase();
      }
    }

    const { moduleRef } = await compileWoven({
      providers: [Settings, SettingsAspect],
    });
    const settings = moduleRef.get(Settings);
    settings.theme = "dark";
    expect(settings.theme).toBe("DARK");
    expect(settings.describe()).toBe("dark");
    expect(settings.untouched).toBe(1);
    expect(log).toEqual(["getter theme"]);
    expect(
      Object.getOwnPropertyDescriptor(Settings.prototype, "theme")?.set,
    ).toBe(setter);
  });

  it("leaves lifecycle hooks to P.method and never advises aspects", async () => {
    const log: string[] = [];

    @Injectable()
    class Worker implements OnModuleInit {
      onModuleInit() {
        log.push("hook runs");
      }

      work() {}
    }
    const everything = P.all();

    @Aspect()
    class Broad {
      @Before(everything)
      record(joinPoint: JoinPoint<AnyShape>) {
        log.push(`broad ${joinPoint.toString()}`);
      }

      helper() {}
    }
    const hook = P.method(Worker, "onModuleInit");

    @Aspect()
    class Hooks {
      @Before(hook)
      record(joinPoint: JoinPointOf<typeof hook>) {
        log.push(`hook ${joinPoint.toString()}`);
      }
    }

    const { moduleRef } = await initWoven({
      providers: [Worker, Broad, Hooks],
    });
    expect(log.splice(0)).toEqual(["hook Worker.onModuleInit()", "hook runs"]);
    moduleRef.get(Worker).work();
    moduleRef.get(Broad).helper();
    expect(log).toEqual(["broad Worker.work()"]);
    expect(Object.hasOwn(Broad.prototype.helper, ORIGINAL)).toBe(false);
    expect(Object.hasOwn(Hooks.prototype.record, ORIGINAL)).toBe(false);
  });
});

describe("aspects and advisors in a container", () => {
  it("injects the dependencies of an aspect and advises transient targets", async () => {
    @Injectable()
    class Metrics {
      readonly counts = new Map<string, number>();

      count(name: string) {
        this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
      }
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class Task {
      execute() {
        return "done";
      }
    }

    @Injectable()
    class Runner {
      constructor(readonly task: Task) {}
    }
    const execute = P.method(Task, "execute");

    @Aspect()
    class MetricsAspect {
      constructor(private readonly metrics: Metrics) {}

      @AfterReturning(execute)
      count(joinPoint: JoinPointOf<typeof execute>, result: string) {
        this.metrics.count(`${String(joinPoint.signature.name)}:${result}`);
      }
    }

    const { moduleRef } = await compileWoven({
      providers: [Metrics, Task, Runner, MetricsAspect],
    });
    moduleRef.get(Runner).task.execute();
    (await moduleRef.resolve(Task)).execute();
    expect([...moduleRef.get(Metrics).counts]).toEqual([["execute:done", 2]]);
  });

  it("raises AspectNotReadyError for a call that precedes the aspect instance", async () => {
    @Injectable()
    class Cache {
      // The dependency delays the constructor until the weaver has run.
      constructor(@Inject("SLOW") _slow: unknown) {
        this.warm();
      }

      warm() {}
    }
    const warm = P.method(Cache, "warm");

    @Aspect()
    class CacheAspect {
      // The aspect cannot exist before the cache it depends on.
      constructor(readonly cache: Cache) {}

      @Before(warm)
      record(_jp: JoinPointOf<typeof warm>) {}
    }

    await expect(
      compileWoven({
        providers: [
          Cache,
          CacheAspect,
          { provide: "SLOW", useFactory: () => sleep(5) },
        ],
      }),
    ).rejects.toThrow(AspectNotReadyError);
  });

  it("raises AspectNotReadyError for a call that precedes the advisor instance", async () => {
    @Injectable()
    class Cache {
      constructor(@Inject("SLOW") _slow: unknown) {
        this.warm();
      }

      warm() {}
    }

    @Advisor()
    class CacheAdvisor {
      static readonly pointcut = P.method(Cache, "warm");

      readonly advice: MethodInterceptor = {
        invoke: (invocation) => invocation.proceed(),
      };

      constructor(readonly cache: Cache) {}
    }

    await expect(
      compileWoven({
        providers: [
          Cache,
          CacheAdvisor,
          { provide: "SLOW", useFactory: () => sleep(5) },
        ],
      }),
    ).rejects.toThrow(
      "Cache.warm was called before an instance of the advisor CacheAdvisor exists",
    );
  });

  it("runs an @Advisor class with a MethodInterceptor", async () => {
    const log: string[] = [];
    const Transactional = createAnnotation<"Transactional">("Transactional");

    @Injectable()
    class TransactionManager {
      async run<T>(work: () => T): Promise<Awaited<T>> {
        log.push("begin");
        try {
          const result = await work();
          log.push("commit");
          return result;
        } catch (error) {
          log.push("rollback");
          throw error;
        }
      }
    }

    @Advisor()
    class TransactionAdvisor {
      static readonly pointcut = P.annotated(Transactional).or(
        P.withinAnnotated(Transactional),
      );

      readonly order = 100;

      readonly advice: MethodInterceptor = {
        invoke: (invocation) =>
          this.transactions.run(() => invocation.proceed()),
      };

      constructor(private readonly transactions: TransactionManager) {}
    }

    @Injectable()
    class OrderService {
      @Transactional()
      async place(id: number) {
        log.push(`place ${id}`);
        return id;
      }

      async cancel(id: number) {
        log.push(`cancel ${id}`);
      }
    }

    @Injectable()
    @Transactional()
    class LedgerService {
      async post() {
        log.push("post");
        throw new Error("ledger closed");
      }
    }

    const { moduleRef, logger } = await initWoven({
      providers: [
        TransactionManager,
        TransactionAdvisor,
        OrderService,
        LedgerService,
        // An aspect without an order has the lowest precedence.
        recorder(P.within(OrderService), log, "inner "),
      ],
    });
    await expect(moduleRef.get(OrderService).place(7)).resolves.toBe(7);
    await moduleRef.get(OrderService).cancel(7);
    await expect(moduleRef.get(LedgerService).post()).rejects.toThrow(
      "ledger closed",
    );
    expect(log).toEqual([
      "begin",
      "inner OrderService.place",
      "place 7",
      "commit",
      "inner OrderService.cancel",
      "cancel 7",
      "begin",
      "post",
      "rollback",
    ]);
    expect(logger.messages("debug")).toContain(
      "OrderService.place <- TransactionAdvisor (order 100)",
    );
  });
});

describe("module options", () => {
  it("never weaves excluded classes and their subclasses", async () => {
    const log: string[] = [];

    @Injectable()
    class Woven {
      run() {}
    }

    @Injectable()
    class Legacy {
      run() {}
    }

    @Injectable()
    class LegacyChild extends Legacy {}

    @Injectable()
    class WovenChild extends Woven {}

    @Injectable()
    class Generated {
      run() {}
    }
    const legacyRun = Legacy.prototype.run;

    const { moduleRef } = await compileWoven(
      {
        providers: [
          Woven,
          Legacy,
          LegacyChild,
          WovenChild,
          Generated,
          recorder(P.name("run"), log),
        ],
      },
      {
        exclude: [
          Legacy,
          WovenChild,
          { matches: (classRef) => classRef.type.name.startsWith("Gen") },
        ],
      },
    );
    for (const type of [Woven, Legacy, LegacyChild, WovenChild, Generated]) {
      moduleRef.get(type).run();
    }
    expect(log).toEqual(["Woven.run"]);
    expect(Legacy.prototype.run).toBe(legacyRun);
  });

  it("follows results through a custom return value adapter", async () => {
    const log: string[] = [];

    /** A lazy result that settles when it is run. */
    class Deferred<T> {
      constructor(readonly run: () => Promise<T>) {}
    }
    const deferredAdapter: ReturnValueAdapter<Deferred<unknown>> = {
      supports: (value): value is Deferred<unknown> =>
        value instanceof Deferred,
      onSuccess: (value, callback) =>
        new Deferred(async () => {
          const resolved = await value.run();
          await callback(resolved);
          return resolved;
        }),
      onError: (value, callback) =>
        new Deferred(async () => {
          try {
            return await value.run();
          } catch (error) {
            await callback(error);
            throw error;
          }
        }),
      finally: (value, callback) =>
        new Deferred(async () => {
          try {
            return await value.run();
          } finally {
            await callback();
          }
        }),
    };

    @Injectable()
    class Loader {
      load() {
        return new Deferred(async () => {
          log.push("loaded");
          return 42;
        });
      }

      async loadAsync() {
        return 1;
      }
    }
    const loads = P.within(Loader);

    @Aspect()
    class LoaderAspect {
      @AfterReturning(loads)
      record(joinPoint: JoinPointOf<typeof loads>, result: unknown) {
        log.push(
          `${String(joinPoint.signature.name)} returned ${String(result)}`,
        );
      }
    }

    const { moduleRef } = await compileWoven(
      { providers: [Loader, LoaderAspect] },
      { returnValueAdapters: [deferredAdapter] },
    );
    const deferred = moduleRef.get(Loader).load();
    expect(deferred).toBeInstanceOf(Deferred);
    expect(log).toEqual([]);
    await expect(deferred.run()).resolves.toBe(42);
    // The built-in promise adapter stays registered.
    await moduleRef.get(Loader).loadAsync();
    expect(log).toEqual(["loaded", "load returned 42", "loadAsync returned 1"]);
  });

  it("consults the return value adapters of the options before the promise adapter", async () => {
    const log: string[] = [];
    const tracingAdapter: ReturnValueAdapter<Promise<unknown>> = {
      supports: (value): value is Promise<unknown> => value instanceof Promise,
      onSuccess: (value, callback) =>
        value.then(async (resolved) => {
          log.push("custom adapter");
          await callback(resolved);
          return resolved;
        }),
      onError: (value) => value,
      finally: (value) => value,
    };

    @Injectable()
    class Loader {
      async load() {
        return 1;
      }
    }
    const loads = P.within(Loader);

    @Aspect()
    class LoaderAspect {
      @AfterReturning(loads)
      record(_jp: JoinPointOf<typeof loads>, result: unknown) {
        log.push(`returned ${String(result)}`);
      }
    }

    const { moduleRef } = await compileWoven(
      { providers: [Loader, LoaderAspect] },
      { returnValueAdapters: [tracingAdapter] },
    );
    await moduleRef.get(Loader).load();
    expect(log).toEqual(["custom adapter", "returned 1"]);
  });
});

describe("enhancers and middleware", () => {
  it("advises a guard, and a middleware once the application initializes", async () => {
    const log: string[] = [];

    @Injectable()
    class RoleGuard implements CanActivate {
      canActivate() {
        return this.allowed();
      }

      allowed() {
        return true;
      }
    }

    @Injectable()
    class TraceMiddleware implements NestMiddleware {
      use(_request: unknown, _response: unknown, next: () => void) {
        this.trace();
        next();
      }

      trace() {}
    }

    /** Also a provider, so the weaver knows it before the router binds `use`. */
    @Injectable()
    class ProvidedMiddleware implements NestMiddleware {
      use(_request: unknown, _response: unknown, next: () => void) {
        next();
      }
    }

    @Controller()
    @UseGuards(RoleGuard)
    class PingController {
      @Get("ping")
      ping() {
        return "pong";
      }
    }

    @Module({
      controllers: [PingController],
      providers: [
        ProvidedMiddleware,
        recorder(P.within(RoleGuard, TraceMiddleware, ProvidedMiddleware), log),
      ],
    })
    class PingModule implements NestModule {
      configure(consumer: MiddlewareConsumer) {
        consumer.apply(TraceMiddleware, ProvidedMiddleware).forRoutes("ping");
      }
    }

    const { moduleRef } = await compileWoven({ imports: [PingModule] });
    const url = await listenWoven(moduleRef);
    expect(await (await fetch(`${url}/ping`)).text()).toBe("pong");
    // The router binds `TraceMiddleware.use` before the weaver learns of the
    // class, so that call is not advised; the calls it makes are.
    expect(log).toEqual([
      "TraceMiddleware.trace",
      "ProvidedMiddleware.use",
      "RoleGuard.canActivate",
      "RoleGuard.allowed",
    ]);
  });
});

describe("HTTP pipeline", () => {
  class TeapotError extends Error {}

  @Catch(TeapotError)
  class TeapotFilter implements ExceptionFilter {
    catch(error: TeapotError, host: ArgumentsHost) {
      host
        .switchToHttp()
        .getResponse<{
          status(code: number): { json(body: unknown): void };
        }>()
        .status(418)
        .json({ teapot: error.message });
    }
  }

  it("orders two aspects on a route handler and delivers an advice error to an exception filter", async () => {
    const log: string[] = [];

    @Controller("orders")
    class OrderController {
      @Get("list")
      list() {
        log.push("handler");
        return ["order"];
      }

      @Get("brew")
      brew() {
        log.push("handler");
        return "coffee";
      }
    }
    const handlers = P.within(OrderController);
    const brew = P.method(OrderController, "brew");

    @Aspect({ order: 2 })
    class Inner {
      @Around(handlers)
      around(joinPoint: ProceedingJoinPointOf<typeof handlers>) {
        log.push("inner around");
        const result = joinPoint.proceed();
        log.push("inner around returns");
        return result;
      }

      @Before(brew)
      refuse(_jp: JoinPointOf<typeof brew>) {
        throw new TeapotError("no coffee");
      }
    }

    @Aspect({ order: 1 })
    class Outer {
      @Before(handlers)
      before(_jp: JoinPointOf<typeof handlers>) {
        log.push("outer before");
      }

      @Around(handlers)
      around(joinPoint: ProceedingJoinPointOf<typeof handlers>) {
        log.push("outer around");
        try {
          return joinPoint.proceed();
        } finally {
          log.push("outer around returns");
        }
      }
    }

    const { moduleRef } = await compileWoven({
      controllers: [OrderController],
      // Registered inner first: the order decides, not the registration.
      providers: [
        Inner,
        Outer,
        { provide: APP_FILTER, useClass: TeapotFilter },
      ],
    });
    const url = await listenWoven(moduleRef);

    const list = await fetch(`${url}/orders/list`);
    expect([list.status, await list.json()]).toEqual([200, ["order"]]);
    expect(log.splice(0)).toEqual([
      "outer around",
      "outer before",
      "inner around",
      "handler",
      "inner around returns",
      "outer around returns",
    ]);

    const refused = await fetch(`${url}/orders/brew`);
    expect([refused.status, await refused.json()]).toEqual([
      418,
      { teapot: "no coffee" },
    ]);
    expect(log).toEqual([
      "outer around",
      "outer before",
      "inner around",
      "outer around returns",
    ]);
  });
});
