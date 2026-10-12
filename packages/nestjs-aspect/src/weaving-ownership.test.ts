import "reflect-metadata";
import { Inject, Injectable, Module, Scope } from "@nestjs/common";
import { ContextIdFactory, LazyModuleLoader } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { Advisor, After, Around, Aspect, Before } from "./aspect-decorators";
import {
  AspectConfigurationError,
  AspectNotReadyError,
  AspectUsageError,
} from "./errors";
import { DeclareParents } from "./introduction";
import { Pointcut as P } from "./pointcut-designators";
import type {
  AdviceAdapter,
  AnyShape,
  Class,
  JoinPoint,
  MethodInterceptor,
  ProceedingJoinPointOf,
} from "./types";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

const Authorized = createAnnotation<"Authorized">("Authorized", {
  requiresAdvice: true,
});

/** An aspect that logs `label` and the member before every method of `type`. */
function labelling(type: Class, label: string, log: string[]) {
  const pointcut = P.within(type);

  @Aspect()
  class Labelling {
    @Before(pointcut)
    record(joinPoint: JoinPoint<AnyShape>) {
      log.push(`${label} ${String(joinPoint.signature.name)}`);
    }
  }
  return Labelling;
}

/** A promise that settles when the test calls `open`. */
function gate(): { opened: Promise<void>; open(): void } {
  let open = (): void => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** The error a rejected compilation raises; `undefined` when it succeeds. */
function failure(compilation: Promise<unknown>): Promise<unknown> {
  return compilation.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("an instance that two applications know", () => {
  it("is advised by the application that holds it and advises its class, not by the one that created it", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }
    const creating = await initWoven({ providers: [Shared] });
    const instance = creating.moduleRef.get(Shared);
    instance.run();
    expect(log.splice(0)).toEqual(["run"]);

    const holding = await initWoven({
      providers: [
        { provide: "SHARED", useValue: instance },
        labelling(Shared, "holding", log),
      ],
    });
    instance.run();
    expect(log.splice(0)).toEqual(["holding run", "run"]);

    await holding.moduleRef.close();
    instance.run();
    expect(creating.moduleRef.get(Shared)).toBe(instance);
    expect(log).toEqual(["run"]);
  });

  it("is left unadvised by an application that advises its class while the application that created it advises nothing in the class", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }
    const creating = await initWoven({ providers: [Shared] });
    const advising = await initWoven({
      providers: [Shared, labelling(Shared, "advising", log)],
    });

    creating.moduleRef.get(Shared).run();
    expect(log.splice(0)).toEqual(["run"]);
    advising.moduleRef.get(Shared).run();
    expect(log).toEqual(["advising run", "run"]);
  });

  it("attributes an instance with primitive and function fields to the application of its dependency", async () => {
    const log: string[] = [];

    @Injectable()
    class Dependency {}

    class Holder {
      readonly label = "holder";

      readonly count = 1;

      readonly parent = null;

      readonly format = (value: number): string => String(value);

      constructor(readonly dependency: Dependency) {}

      run() {
        log.push("run");
      }
    }
    const providers = (label: string) => [
      Dependency,
      Holder,
      labelling(Holder, label, log),
    ];
    const first = await initWoven({ providers: providers("first") });
    const second = await initWoven({ providers: providers("second") });

    new Holder(first.moduleRef.get(Dependency)).run();
    new Holder(second.moduleRef.get(Dependency)).run();
    expect(log).toEqual(["first run", "run", "second run", "run"]);
  });
});

describe("a call without its instance while two applications advise the class", () => {
  function shared() {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }
    return { Shared, log };
  }

  it("raises AspectUsageError in strict mode", async () => {
    const { Shared, log } = shared();
    const first = await compileWoven({
      providers: [Shared, labelling(Shared, "first", log)],
    });
    const second = await compileWoven({
      providers: [Shared, labelling(Shared, "second", log)],
    });
    // The instance belongs to the first application; the detached call
    // carries no instance that tells so.
    const { run } = first.moduleRef.get(Shared);
    expect(() => run()).toThrow(AspectUsageError);
    expect(() => run()).toThrow(
      "nothing tells which of them the instance that was called belongs to",
    );
    expect(log).toEqual([]);

    await second.moduleRef.close();
    run();
    expect(log).toEqual(["first run", "run"]);
  });

  it("is advised by the most recent application with one warning when no application is strict", async () => {
    const { Shared, log } = shared();
    const lenient = { strict: false };
    const first = await compileWoven(
      { providers: [Shared, labelling(Shared, "first", log)] },
      lenient,
    );
    const second = await compileWoven(
      { providers: [Shared, labelling(Shared, "second", log)] },
      lenient,
    );
    const { run } = first.moduleRef.get(Shared);
    run();
    run();
    expect(log).toEqual(["second run", "run", "second run", "run"]);
    expect(first.logger.messages("warn")).toEqual([]);
    expect(second.logger.messages("warn")).toEqual([
      expect.stringContaining("Several live applications advise Shared"),
    ]);
  });
});

describe("members that are called without their instance", () => {
  it("raises AspectUsageError for an introduced member", async () => {
    abstract class Touchable {
      abstract touch(): number;
    }

    class DefaultTouchable implements Touchable {
      private touches = 0;

      touch(): number {
        this.touches++;
        return this.touches;
      }
    }

    @Injectable()
    class Report {}
    const reports = P.within(Report);

    @Aspect()
    class Touching {
      @DeclareParents(reports, { use: DefaultTouchable })
      static readonly mixin: Touchable;
    }
    const { moduleRef } = await compileWoven({
      providers: [Report, Touching],
    });
    const report = moduleRef.get(Report) as Report & Touchable;
    const { touch } = report;

    expect(() => touch()).toThrow(AspectUsageError);
    expect(() => touch()).toThrow(
      "Report.touch is introduced by an aspect and was called without its instance",
    );
    // The failed calls created no delegate.
    expect(report.touch()).toBe(1);
  });

  it("runs a requiresAdvice member without advice once its application closed, unlike the call on the instance", async () => {
    const log: string[] = [];

    @Injectable()
    class Vault {
      @Authorized()
      open() {
        log.push("opened");
      }
    }
    const pointcut = P.annotated(Authorized);

    @Aspect()
    class Authorizing {
      @Before(pointcut)
      check(_joinPoint: JoinPoint<AnyShape>) {
        log.push("checked");
      }
    }
    const { moduleRef } = await initWoven({ providers: [Vault, Authorizing] });
    const vault = moduleRef.get(Vault);
    const { open } = vault;
    open();
    expect(log.splice(0)).toEqual(["checked", "opened"]);

    await moduleRef.close();
    expect(() => vault.open()).toThrow(AspectConfigurationError);
    // A call without an instance belongs to no application: it runs the
    // member like a call on an object no application created.
    open();
    expect(log).toEqual(["opened"]);
  });
});

describe("prototypes that cannot be woven", () => {
  it("fails the bootstrap for a matched member of a frozen prototype and does not keep the application live", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }

    @Injectable()
    class Sealed {
      run() {}
    }
    Object.freeze(Sealed.prototype);

    const error = await failure(
      compileWoven({
        providers: [
          Shared,
          Sealed,
          labelling(Shared, "failed", log),
          labelling(Sealed, "failed", log),
        ],
      }),
    );
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(error).toMatchObject({
      message:
        "Sealed.run cannot be woven: its prototype does not allow the property to be redefined",
      cause: expect.any(TypeError),
    });

    // One live application advises Shared: the failed one would make the
    // call ambiguous.
    await compileWoven({
      providers: [Shared, labelling(Shared, "second", log)],
    });
    new Shared().run();
    expect(log).toEqual(["second run", "run"]);
  });

  it("fails the bootstrap for an introduction into a frozen prototype", async () => {
    abstract class Touchable {
      abstract touch(): void;
    }

    class DefaultTouchable implements Touchable {
      touch() {}
    }

    @Injectable()
    class Sealed {}
    Object.freeze(Sealed.prototype);
    const sealed = P.within(Sealed);

    @Aspect()
    class Touching {
      @DeclareParents(sealed, { use: DefaultTouchable })
      static readonly mixin: Touchable;
    }
    const error = await failure(
      compileWoven({ providers: [Sealed, Touching] }),
    );
    expect(error).toBeInstanceOf(AspectConfigurationError);
    expect(error).toMatchObject({
      message:
        "Sealed.touch cannot be introduced: its prototype does not allow the property to be defined",
      cause: expect.any(TypeError),
    });
  });
});

describe("a subclass that inherits the stub of a woven superclass", () => {
  function inheriting() {
    const log: string[] = [];

    @Injectable()
    class Base {
      run() {
        return "base";
      }
    }

    @Injectable()
    class Sub extends Base {}

    @Module({
      providers: [Sub],
    })
    class SubModule {}
    const pointcut = P.bean(Base);

    @Aspect()
    class Recording {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("advice");
      }
    }
    return { Base, Sub, SubModule, Recording, log };
  }

  it("is not advised once a lazy module registers it and no advisor matches it", async () => {
    const { Base, Sub, SubModule, Recording, log } = inheriting();
    const { moduleRef } = await initWoven({ providers: [Base, Recording] });

    const lazy = await moduleRef.get(LazyModuleLoader).load(() => SubModule);
    expect(lazy.get(Sub).run()).toBe("base");
    expect(log).toEqual([]);
  });

  it("is not advised once a lazy module registers it, also when an instance was called before the load", async () => {
    const { Base, Sub, SubModule, Recording, log } = inheriting();
    const { moduleRef } = await initWoven({ providers: [Base, Recording] });

    // The application has not examined Sub: its instances are advised like
    // those of the woven superclass.
    new Sub().run();
    expect(log.splice(0)).toEqual(["advice"]);

    const lazy = await moduleRef.get(LazyModuleLoader).load(() => SubModule);
    expect(lazy.get(Sub).run()).toBe("base");
    expect(log).toEqual([]);
  });
});

describe("a subclass that the exclude option names by a provider token", () => {
  it("runs the superclass member of a super call without advice once the container resolves the excluded instance", async () => {
    const log: string[] = [];

    @Injectable()
    class Base {
      run() {
        log.push("base");
      }
    }

    @Injectable()
    class Sub extends Base {
      override run() {
        super.run();
      }
    }
    const { moduleRef } = await initWoven(
      {
        providers: [
          Base,
          Sub,
          labelling(Base, "advice", log),
          {
            provide: "DRAFT",
            scope: Scope.REQUEST,
            useFactory: () => new Sub(),
          },
        ],
      },
      { exclude: [P.bean("DRAFT").classFilter] },
    );

    // A super call is an execution of the superclass member.
    moduleRef.get(Sub).run();
    expect(log.splice(0)).toEqual(["advice run", "base"]);

    // The first instance the factory returns shows that the class is excluded.
    const draft = await moduleRef.resolve<Sub>(
      "DRAFT",
      ContextIdFactory.create(),
    );
    draft.run();
    moduleRef.get(Sub).run();
    expect(log).toEqual(["base", "base"]);
  });
});

describe("calls in flight when an application closes", () => {
  it("completes the call with the rest of its advice and runs the calls it makes afterwards without advice", async () => {
    const log: string[] = [];
    const release = gate();

    @Injectable()
    class Transfers {
      async transfer(): Promise<string> {
        log.push("transfer starts");
        await release.opened;
        this.record();
        return "transferred";
      }

      record() {
        log.push("record");
      }
    }
    const transfers = P.method(Transfers, "transfer");
    const records = P.method(Transfers, "record");

    @Aspect()
    class Tracing {
      @Around(transfers)
      async around(
        joinPoint: ProceedingJoinPointOf<typeof transfers>,
      ): Promise<string> {
        log.push("around enters");
        const result = await joinPoint.proceed();
        log.push(`around returns ${result}`);
        return result;
      }

      @After(transfers)
      after(_joinPoint: JoinPoint<AnyShape>) {
        log.push("after transfer");
      }

      @Before(records)
      before(_joinPoint: JoinPoint<AnyShape>) {
        log.push("before record");
      }
    }
    const { moduleRef } = await initWoven({ providers: [Transfers, Tracing] });
    const service = moduleRef.get(Transfers);
    service.record();
    expect(log.splice(0)).toEqual(["before record", "record"]);

    const pending = service.transfer();
    expect(log.splice(0)).toEqual(["around enters", "transfer starts"]);
    await moduleRef.close();
    release.open();

    await expect(pending).resolves.toBe("transferred");
    expect(log.splice(0)).toEqual([
      "record",
      "after transfer",
      "around returns transferred",
    ]);

    // A call that starts after the close is not advised.
    await expect(service.transfer()).resolves.toBe("transferred");
    expect(log).toEqual(["transfer starts", "record"]);
  });

  it("rejects the requiresAdvice member that an in-flight call reaches after the close", async () => {
    const log: string[] = [];
    const release = gate();

    @Injectable()
    class Vault {
      async openLater(): Promise<string> {
        await release.opened;
        this.open();
        return "opened";
      }

      @Authorized()
      open() {
        log.push("opened");
      }
    }
    const authorized = P.annotated(Authorized);
    const deferred = P.method(Vault, "openLater");

    @Aspect()
    class Authorizing {
      @Before(authorized)
      check(_joinPoint: JoinPoint<AnyShape>) {
        log.push("checked");
      }

      @After(deferred)
      after(_joinPoint: JoinPoint<AnyShape>) {
        log.push("after openLater");
      }
    }
    const { moduleRef } = await initWoven({ providers: [Vault, Authorizing] });
    const pending = moduleRef.get(Vault).openLater();
    await moduleRef.close();
    release.open();

    await expect(pending).rejects.toThrow(AspectConfigurationError);
    await expect(pending).rejects.toThrow(
      "Vault.open requires advice, and the application of the instance it was called on is closed",
    );
    expect(log).toEqual(["after openLater"]);
  });

  it("leaves the in-flight and the later calls of another application that advises the class to that application", async () => {
    const log: string[] = [];
    const release = gate();

    @Injectable()
    class Shared {
      async run(): Promise<void> {
        await release.opened;
        this.step();
      }

      step() {
        log.push("step");
      }
    }
    const closing = await initWoven({
      providers: [Shared, labelling(Shared, "closing", log)],
    });
    const remaining = await initWoven({
      providers: [Shared, labelling(Shared, "remaining", log)],
    });
    const instance = remaining.moduleRef.get(Shared);
    const pending = instance.run();
    expect(log.splice(0)).toEqual(["remaining run"]);

    // The second close finds the application closed already.
    await closing.moduleRef.close();
    await closing.moduleRef.close();
    release.open();
    await pending;
    expect(log.splice(0)).toEqual(["remaining step", "step"]);

    closing.moduleRef.get(Shared).step();
    instance.step();
    expect(log).toEqual(["step", "remaining step", "step"]);
  });
});

describe("interleaved asynchronous calls of two applications that advise one class", () => {
  it("advises every call and the calls it makes after an await with the aspects of the application of its instance", async () => {
    const log: string[] = [];
    const names = new Map<unknown, string>();

    @Injectable()
    class Shared {
      async run(release: Promise<void>): Promise<string> {
        await release;
        return this.step();
      }

      step(): string {
        return `${names.get(this)} stepped`;
      }
    }

    /** Logs the application of the aspect and the instance it advises. */
    function attributing(application: string) {
      const pointcut = P.within(Shared);

      @Aspect()
      class Attributing {
        @Before(pointcut)
        record(joinPoint: JoinPoint<AnyShape>) {
          const name = String(joinPoint.signature.name);
          log.push(
            `${application} advises ${names.get(joinPoint.target)}.${name}`,
          );
        }
      }
      return Attributing;
    }
    const first = await initWoven({
      providers: [Shared, attributing("first")],
    });
    const second = await initWoven({
      providers: [Shared, attributing("second")],
    });
    const firstInstance = first.moduleRef.get(Shared);
    const secondInstance = second.moduleRef.get(Shared);
    names.set(firstInstance, "first");
    names.set(secondInstance, "second");

    const firstGate = gate();
    const secondGate = gate();
    const laterGate = gate();
    const calls = Promise.all([
      firstInstance.run(firstGate.opened),
      secondInstance.run(secondGate.opened),
      firstInstance.run(laterGate.opened),
    ]);
    // Each call resumes while the calls of the other application wait.
    secondGate.open();
    await secondGate.opened;
    await Promise.resolve();
    laterGate.open();
    await laterGate.opened;
    await Promise.resolve();
    firstGate.open();

    expect(await calls).toEqual([
      "first stepped",
      "second stepped",
      "first stepped",
    ]);
    expect(log).toEqual([
      "first advises first.run",
      "second advises second.run",
      "first advises first.run",
      "second advises second.step",
      "first advises first.step",
      "first advises first.step",
    ]);
  });
});

describe("the interceptor chain of a member", () => {
  it("keeps the interceptor an advice adapter creates for the member across its calls", async () => {
    /** An advice kind of its own: numbers the calls of each member. */
    class Numbering {}

    const numberingAdapter: AdviceAdapter = {
      supports: (advice) => advice instanceof Numbering,
      toInterceptor: () => {
        let calls = 0;
        return {
          invoke(invocation) {
            calls++;
            return `${calls}: ${String(invocation.proceed())}`;
          },
        };
      },
    };

    @Injectable()
    class Quotes {
      latest() {
        return "latest";
      }

      oldest() {
        return "oldest";
      }
    }

    @Advisor()
    class NumberingAdvisor {
      static readonly pointcut = P.within(Quotes);

      readonly advice = new Numbering();
    }
    const { moduleRef } = await initWoven(
      { providers: [Quotes, NumberingAdvisor] },
      { adviceAdapters: [numberingAdapter] },
    );
    const quotes = moduleRef.get(Quotes);
    expect([quotes.latest(), quotes.latest(), quotes.latest()]).toEqual([
      "1: latest",
      "2: latest",
      "3: latest",
    ]);
    expect(quotes.oldest()).toBe("1: oldest");
  });

  it("advises the calls that follow one that preceded the instance of its advisor", async () => {
    const log: string[] = [];
    const early: unknown[] = [];

    @Injectable()
    class Cache {
      // The dependency delays the constructor until the weaver has run.
      constructor(@Inject("SLOW") _slow: unknown) {
        try {
          this.warm();
        } catch (error) {
          early.push(error);
        }
      }

      warm() {
        log.push("warm");
      }
    }

    @Advisor()
    class CacheAdvisor {
      static readonly pointcut = P.method(Cache, "warm");

      readonly advice: MethodInterceptor = {
        invoke: (invocation) => {
          log.push("advice");
          return invocation.proceed();
        },
      };

      // The advisor cannot exist before the cache it depends on.
      constructor(readonly cache: Cache) {}
    }
    const { moduleRef } = await initWoven({
      providers: [
        Cache,
        CacheAdvisor,
        { provide: "SLOW", useFactory: () => sleep(5) },
      ],
    });
    expect(early).toEqual([expect.any(AspectNotReadyError)]);
    expect(log).toEqual([]);

    moduleRef.get(Cache).warm();
    expect(log).toEqual(["advice", "warm"]);
  });
});
