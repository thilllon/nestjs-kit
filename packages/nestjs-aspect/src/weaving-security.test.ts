import "reflect-metadata";
import { Inject, Injectable, Module, Scope, type Type } from "@nestjs/common";
import { ContextIdFactory, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { AspectModule } from "./aspect.module";
import { Aspect, Before } from "./aspect-decorators";
import { AspectConfigurationError, AspectUsageError } from "./errors";
import { DeclareParents } from "./introduction";
import { ORIGINAL } from "./method-ref";
import { P } from "./pointcut-designators";
import type { AnyShape, Class, JoinPoint } from "./types";
import { weavingRegistry } from "./weaving-registry";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";
import { isStub } from "./weaving-stub";

afterEach(closeWoven);

/** An aspect that logs `label` before every method of `type`. */
function labelling(type: Class, label: string, log: string[]) {
  const pointcut = P.within(type);

  @Aspect()
  class Labelling {
    @Before(pointcut)
    record(_jp: JoinPoint<AnyShape>) {
      log.push(label);
    }
  }
  return Labelling;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("attribution after an application closes", () => {
  it("advises an instance no container holds by the application that remains", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }
    const lenient = { strict: false };
    await compileWoven(
      { providers: [Shared, labelling(Shared, "first", log)] },
      lenient,
    );
    const second = await compileWoven(
      { providers: [Shared, labelling(Shared, "second", log)] },
      lenient,
    );
    const instance = new Shared();
    instance.run();
    expect(log.splice(0)).toEqual(["second", "run"]);

    await second.moduleRef.close();
    instance.run();
    expect(log).toEqual(["first", "run"]);
  });

  it("keeps the advice of a request-scoped instance when a later application closes", async () => {
    const log: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {
      run() {
        log.push("run");
      }
    }
    const first = await compileWoven({
      providers: [PerRequest, labelling(PerRequest, "first", log)],
    });
    const second = await compileWoven({
      providers: [PerRequest, labelling(PerRequest, "second", log)],
    });
    const instance = await first.moduleRef.resolve(
      PerRequest,
      ContextIdFactory.create(),
    );
    instance.run();
    await second.moduleRef.close();
    instance.run();
    expect(log).toEqual(["first", "run", "first", "run"]);
  });

  it("hands an instance to the application whose container holds it from then on", async () => {
    const log: string[] = [];

    class Shared {
      run() {
        log.push("run");
      }
    }
    const instance = new Shared();
    await compileWoven({
      providers: [
        { provide: "SHARED", useClass: Shared },
        labelling(Shared, "first", log),
      ],
    });
    instance.run();
    expect(log.splice(0)).toEqual(["first", "run"]);

    const second = await initWoven({
      providers: [
        { provide: Shared, useValue: instance },
        labelling(Shared, "second", log),
      ],
    });
    second.moduleRef.get(Shared).run();
    expect(log).toEqual(["second", "run"]);
  });
});

describe("applications whose weaving fails", () => {
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

  it("does not count an application as live when an introduction collides", async () => {
    const { Shared, log } = shared();

    abstract class Tracked {
      abstract track(): void;
    }

    class DefaultTracked implements Tracked {
      track() {}
    }

    @Injectable()
    class Conflicted {
      track() {}
    }
    const shares = P.within(Shared);
    const conflicted = P.within(Conflicted);

    @Aspect()
    class Failing {
      @DeclareParents(conflicted, { use: DefaultTracked })
      static readonly mixin: Tracked;

      @Before(shares)
      record(_jp: JoinPoint<AnyShape>) {
        log.push("failed");
      }
    }
    await expect(
      compileWoven({ providers: [Shared, Conflicted, Failing] }),
    ).rejects.toThrow(AspectConfigurationError);

    await compileWoven({
      providers: [Shared, labelling(Shared, "second", log)],
    });
    new Shared().run();
    expect(log).toEqual(["second", "run"]);
  });
});

describe("applications that weave one class at the same time", () => {
  it("advises request-scoped and transient instances with the aspects of the application that created them", async () => {
    const log: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {
      run() {}
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class PerUse {
      run() {}
    }
    const applications = await Promise.all(
      ["first", "second", "third"].map((label) =>
        compileWoven({
          providers: [
            PerRequest,
            PerUse,
            labelling(PerRequest, `${label} request`, log),
            labelling(PerUse, `${label} transient`, log),
          ],
        }),
      ),
    );
    const [first, second, third] = applications;
    for (const { moduleRef } of [second, first, third, first]) {
      const contextId = ContextIdFactory.create();
      (await moduleRef.resolve(PerRequest, contextId)).run();
      (await moduleRef.resolve(PerUse, contextId)).run();
    }
    expect(log).toEqual([
      "second request",
      "second transient",
      "first request",
      "first transient",
      "third request",
      "third transient",
      "first request",
      "first transient",
    ]);
    for (const { logger } of applications) {
      expect(logger.messages("warn")).toEqual([]);
    }
  });

  it("advises the instance a request-scoped factory provider returns, in its own application", async () => {
    const log: string[] = [];

    class Session {
      run() {}
    }
    const providers = (label: string) => [
      {
        provide: "SESSION",
        scope: Scope.REQUEST,
        useFactory: () => new Session(),
      },
      labelling(Session, label, log),
    ];
    const first = await initWoven({ providers: providers("first") });
    const second = await initWoven({ providers: providers("second") });
    for (const { moduleRef } of [first, second, first]) {
      const session = await moduleRef.resolve<Session>(
        "SESSION",
        ContextIdFactory.create(),
      );
      session.run();
    }
    expect(log).toEqual(["first", "second", "first"]);
  });

  it("raises AspectUsageError in strict mode for an instance that nothing attributes to one application", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }
    await compileWoven({
      providers: [Shared, labelling(Shared, "first", log)],
    });
    const second = await compileWoven(
      { providers: [Shared, labelling(Shared, "second", log)] },
      { strict: false },
    );
    const instance = new Shared();
    expect(() => instance.run()).toThrow(AspectUsageError);
    expect(() => instance.run()).toThrow(
      "Several live applications advise Shared",
    );
    expect(log).toEqual([]);

    await second.moduleRef.close();
    instance.run();
    expect(log).toEqual(["first", "run"]);
  });

  it("warns once without strict mode and lets the most recent application advise the instance", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {}
    }
    const lenient = { strict: false };
    await compileWoven(
      { providers: [Shared, labelling(Shared, "first", log)] },
      lenient,
    );
    const second = await compileWoven(
      { providers: [Shared, labelling(Shared, "second", log)] },
      lenient,
    );
    new Shared().run();
    new Shared().run();
    expect(log).toEqual(["second", "second"]);
    expect(second.logger.messages("warn")).toEqual([
      expect.stringContaining("Several live applications advise Shared"),
    ]);
  });

  it("attributes an instance no container holds to the application of its dependencies", async () => {
    const log: string[] = [];

    @Injectable()
    class Dependency {}

    @Injectable()
    class Eager {
      constructor(
        readonly dependency: Dependency,
        // The dependency delays the constructor until the weaver has run.
        @Inject("SLOW") _slow: unknown,
      ) {
        this.warm();
      }

      warm() {}
    }
    const providers = (label: string) => [
      Dependency,
      Eager,
      labelling(Eager, label, log),
      { provide: "SLOW", useFactory: () => sleep(5) },
    ];
    // Each constructor calls a woven method before a container holds the
    // instance, the second one while both applications are live.
    const first = await compileWoven({ providers: providers("first") });
    const second = await compileWoven({ providers: providers("second") });
    expect(log.splice(0)).toEqual(["first", "second"]);

    new Eager(first.moduleRef.get(Dependency), undefined);
    new Eager(second.moduleRef.get(Dependency), undefined);
    expect(log).toEqual(["first", "second"]);
    expect(() => new Eager(new Dependency(), undefined)).toThrow(
      AspectUsageError,
    );
  });

  it("raises AspectUsageError in strict mode for an instance that the containers of two applications hold", async () => {
    const log: string[] = [];

    class Shared {
      run() {
        log.push("run");
      }
    }
    const instance = new Shared();
    const providers = (label: string) => [
      { provide: Shared, useValue: instance },
      labelling(Shared, label, log),
    ];
    const first = await initWoven({ providers: providers("first") });
    first.moduleRef.get(Shared).run();
    expect(log.splice(0)).toEqual(["first", "run"]);

    const second = await initWoven({ providers: providers("second") });
    expect(() => second.moduleRef.get(Shared).run()).toThrow(
      "held by the containers of several live applications",
    );
    expect(log).toEqual([]);

    await first.moduleRef.close();
    instance.run();
    expect(log).toEqual(["second", "run"]);
  });
});

describe("classes the weaver examines", () => {
  it("weaves the providers of a module that is named like the core module of Nest", async () => {
    const log: string[] = [];

    @Injectable()
    class Vault {
      open() {}
    }

    @Module({
      providers: [Vault],
      exports: [Vault],
    })
    class InternalCoreModule {}

    const { moduleRef } = await initWoven({
      imports: [InternalCoreModule],
      providers: [labelling(Vault, "guarded", log)],
    });
    moduleRef.get(Vault, { strict: false }).open();
    expect(log).toEqual(["guarded"]);
  });

  it("weaves a class that extends a class of Nest", async () => {
    const log: string[] = [];

    @Injectable()
    class RoleReflector extends Reflector {
      roles() {
        return ["admin"];
      }
    }
    const { moduleRef } = await initWoven({
      providers: [RoleReflector, labelling(RoleReflector, "guarded", log)],
    });
    expect(moduleRef.get(RoleReflector).roles()).toEqual(["admin"]);
    expect(log).toEqual(["guarded"]);
    expect(isStub(Reflector.prototype.get)).toBe(false);
  });

  it("never weaves a class of Nest that a module of the application registers", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      constructor(readonly reflector: Reflector) {}

      get() {
        return "value";
      }
    }
    const pointcut = P.name("get");

    @Aspect()
    class Everything {
      @Before(pointcut)
      record(joinPoint: JoinPoint<AnyShape>) {
        log.push(joinPoint.signature.targetType.name);
      }
    }
    const { moduleRef } = await initWoven({
      providers: [Reflector, Service, Everything],
    });
    const service = moduleRef.get(Service);
    service.get();
    service.reflector.get("missing", Service);
    expect(log).toEqual(["Service"]);
    expect(isStub(Reflector.prototype.get)).toBe(false);
  });

  it("never weaves a native class whose instance a value provider supplies", async () => {
    const log: string[] = [];
    const pointcut = P.name("get");

    @Aspect()
    class Everything {
      @Before(pointcut)
      record(joinPoint: JoinPoint<AnyShape>) {
        log.push(joinPoint.signature.targetType.name);
      }
    }
    const { moduleRef } = await initWoven({
      providers: [
        { provide: "CACHE", useValue: new Map([["key", "value"]]) },
        Everything,
      ],
    });
    expect(moduleRef.get<Map<string, string>>("CACHE").get("key")).toBe(
      "value",
    );
    expect(log).toEqual([]);
    expect(isStub(Map.prototype.get)).toBe(false);
  });

  it("weaves the options factory class that forRootAsync registers in the module", async () => {
    const log: string[] = [];

    @Injectable()
    class Options {
      create() {
        return {};
      }

      describe() {
        return "options";
      }
    }
    const pointcut = P.method(Options, "describe");

    @Aspect()
    class Describing {
      @Before(pointcut)
      record(_jp: JoinPoint<AnyShape>) {
        log.push("advised");
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRootAsync({ useClass: Options })],
      providers: [Describing],
    }).compile();
    try {
      moduleRef.get(Options, { strict: false }).describe();
      expect(log).toEqual(["advised"]);
    } finally {
      await moduleRef.close();
    }
  });

  it("weaves the class of a request-scoped factory instance when the container first resolves it", async () => {
    const log: string[] = [];

    class Session {
      run() {}
    }
    const { moduleRef } = await initWoven({
      providers: [
        {
          provide: "SESSION",
          scope: Scope.REQUEST,
          useFactory: () => new Session(),
        },
        labelling(Session, "advised", log),
      ],
    });
    expect(isStub(Session.prototype.run)).toBe(false);
    const session = await moduleRef.resolve<Session>(
      "SESSION",
      ContextIdFactory.create(),
    );
    session.run();
    expect(log).toEqual(["advised"]);
  });

  it("advises a method that is called without its instance", async () => {
    const log: string[] = [];

    @Injectable()
    class Stateless {
      double(value: number) {
        return value * 2;
      }
    }
    const { moduleRef } = await compileWoven({
      providers: [Stateless, labelling(Stateless, "advised", log)],
    });
    const { double } = moduleRef.get(Stateless);
    expect([1, 2].map((value) => double(value))).toEqual([2, 4]);
    expect(log).toEqual(["advised", "advised"]);
  });
});

describe("members that cannot be advised", () => {
  const Authorized = createAnnotation<"Authorized">("Authorized", {
    requiresAdvice: true,
  });

  function vault() {
    const log: string[] = [];

    @Injectable()
    class Vault {
      @Authorized()
      open() {
        log.push("opened");
      }

      describe() {
        return "vault";
      }
    }
    return { Vault, log };
  }

  it("rejects the call of a requiresAdvice member without strict mode", async () => {
    const { Vault, log } = vault();
    const { moduleRef, logger } = await initWoven(
      { providers: [Vault] },
      { strict: false },
    );
    expect(logger.messages("warn")).toEqual([
      expect.stringContaining("Vault.open (@Authorized)"),
    ]);
    const instance = moduleRef.get(Vault);
    expect(() => instance.open()).toThrow(AspectConfigurationError);
    expect(() => instance.open()).toThrow(
      "Vault.open carries @Authorized, which requires advice",
    );
    expect(instance.describe()).toBe("vault");
    expect(log).toEqual([]);
  });

  it("rejects the call of a requiresAdvice member of an application that is compiled and never initialized", async () => {
    const { Vault, log } = vault();
    const { moduleRef } = await compileWoven({ providers: [Vault] });
    expect(() => moduleRef.get(Vault).open()).toThrow(AspectConfigurationError);
    expect(log).toEqual([]);
  });

  it("rejects a requiresAdvice member of an excluded class", async () => {
    const { Vault, log } = vault();
    const pointcut = P.annotated(Authorized);

    @Aspect()
    class Authorizing {
      @Before(pointcut)
      check(_jp: JoinPoint<AnyShape>) {}
    }
    const metadata = { providers: [Vault, Authorizing] };

    await expect(initWoven(metadata, { exclude: [Vault] })).rejects.toThrow(
      "are never advised: Vault.open (@Authorized)",
    );

    const { moduleRef } = await initWoven(metadata, {
      exclude: [Vault],
      strict: false,
    });
    expect(() => moduleRef.get(Vault).open()).toThrow(
      "Vault.open carries @Authorized, which requires advice, and Vault is never advised",
    );
    expect(log).toEqual([]);
  });

  it("never advises a module class and rejects a requiresAdvice member of one", async () => {
    const log: string[] = [];

    @Module({})
    class Plain {
      describe() {
        return "plain";
      }
    }

    @Module({})
    class Guarded {
      @Authorized()
      reset() {
        log.push("reset");
      }
    }
    const metadata = (module: Type<unknown>) => ({
      imports: [module],
      providers: [labelling(module, "advised", log)],
    });

    const plain = await initWoven(metadata(Plain));
    expect(plain.moduleRef.get(Plain).describe()).toBe("plain");
    expect(log).toEqual([]);
    expect(plain.logger.messages("warn")).toEqual([
      expect.stringContaining("matches no member of the application"),
    ]);

    await expect(initWoven(metadata(Guarded))).rejects.toThrow(
      "are never advised: Guarded.reset (@Authorized)",
    );
    const lenient = await initWoven(metadata(Guarded), { strict: false });
    expect(() => lenient.moduleRef.get(Guarded).reset()).toThrow(
      AspectConfigurationError,
    );
    expect(log).toEqual([]);
  });

  it("fails the initialization in every mode when the advice of an aspect can never run", async () => {
    @Injectable()
    class Service {
      run() {}
    }
    const run = P.method(Service, "run");

    @Aspect()
    class FromFactory {
      @Before(run)
      record(_jp: JoinPoint<AnyShape>) {}
    }

    @Injectable()
    class Forgotten {
      @Before(run)
      record(_jp: JoinPoint<AnyShape>) {}
    }
    const lenient = { strict: false };

    await expect(
      initWoven(
        {
          providers: [
            Service,
            { provide: FromFactory, useFactory: () => new FromFactory() },
          ],
        },
        lenient,
      ),
    ).rejects.toThrow("The aspect FromFactory is the instance of a factory");
    await expect(
      initWoven({ providers: [Service, Forgotten] }, lenient),
    ).rejects.toThrow("Forgotten declares advice (record)");
  });
});

describe("state that stubs trust", () => {
  it("refuses to weave a method that carries a forged stub marker", async () => {
    @Injectable()
    class Vault {
      open() {
        return "opened";
      }
    }
    const forged = Symbol.for("nestjs-aspect:stub-owner");
    Object.defineProperty(Vault.prototype.open, ORIGINAL, {
      value: () => "bypassed",
    });
    Object.defineProperty(Vault.prototype.open, forged, { value: Vault });
    expect(isStub(Vault.prototype.open)).toBe(false);

    await expect(
      compileWoven({ providers: [Vault, labelling(Vault, "guarded", [])] }),
    ).rejects.toThrow(AspectConfigurationError);
  });

  it("keeps the registry out of reach of assignment and ignores an inherited one", () => {
    const key = Symbol.for("nestjs-aspect:weaving-registry");
    const registry = weavingRegistry();
    expect(Reflect.set(globalThis, key, {})).toBe(false);
    expect(Reflect.deleteProperty(globalThis, key)).toBe(false);
    expect(Object.isFrozen(registry)).toBe(true);

    const polluted = Object.create({ [key]: registry }) as object;
    const own = weavingRegistry(polluted);
    expect(own).not.toBe(registry);
    expect(Object.hasOwn(polluted, key)).toBe(true);
  });

  it.each([
    ["an object without the registry maps", {}],
    [
      "maps that are no WeakMaps",
      Object.freeze({
        attributions: new Map(),
        types: new Map(),
        containers: new Map(),
        stubs: new Map(),
        epoch: { generation: 0 },
      }),
    ],
  ])("rejects a registry property that holds %s", (_label, value) => {
    const key = Symbol.for("nestjs-aspect:weaving-registry");
    const host = Object.defineProperty({}, key, { value });
    expect(() => weavingRegistry(host)).toThrow(AspectConfigurationError);
  });
});

describe("objects that reach a stub by other ways than their class", () => {
  function guardedVault() {
    const log: string[] = [];

    @Injectable()
    class Vault {
      open() {
        log.push("opened");
        return "secret";
      }
    }
    const pointcut = P.within(Vault);

    @Aspect()
    class Guard {
      @Before(pointcut)
      check(_jp: JoinPoint<AnyShape>) {
        throw new Error("denied");
      }
    }
    return { Vault, Guard, log };
  }

  it("advises an object that has a woven instance as its prototype", async () => {
    const { Vault, Guard, log } = guardedVault();
    const { moduleRef } = await initWoven({ providers: [Vault, Guard] });
    const view = Object.create(moduleRef.get(Vault)) as InstanceType<
      typeof Vault
    >;
    expect(() => view.open()).toThrow("denied");
    expect(log).toEqual([]);
  });

  it("advises an instance of a constructor function whose prototype names the woven class", async () => {
    const { Vault, Guard, log } = guardedVault();
    await initWoven({ providers: [Vault, Guard] });
    function Legacy() {}
    Legacy.prototype = Object.create(Vault.prototype) as object;
    const legacy = Reflect.construct(Legacy, []) as InstanceType<typeof Vault>;
    expect(() => legacy.open()).toThrow("denied");
    expect(log).toEqual([]);
  });

  it("rejects a requiresAdvice member on an object that has an instance as its prototype", async () => {
    const log: string[] = [];
    const Authorized = createAnnotation<"Authorized">("Authorized", {
      requiresAdvice: true,
    });

    @Injectable()
    class Vault {
      @Authorized()
      open() {
        log.push("opened");
      }
    }
    const { moduleRef } = await initWoven(
      { providers: [Vault] },
      { strict: false },
    );
    const view = Object.create(moduleRef.get(Vault)) as Vault;
    expect(() => view.open()).toThrow(AspectConfigurationError);
    expect(log).toEqual([]);
  });

  it("runs the method once when a wrapper around the stub is woven by a later application", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
        return "done";
      }
    }
    const first = await initWoven({
      providers: [Service, labelling(Service, "first", log)],
    });
    const stub = Service.prototype.run;
    Service.prototype.run = function wrapper(this: Service) {
      log.push("wrapper");
      return stub.call(this);
    };
    await first.moduleRef.close();

    const second = await initWoven({
      providers: [Service, labelling(Service, "second", log)],
    });
    expect(second.moduleRef.get(Service).run()).toBe("done");
    expect(log).toEqual(["second", "wrapper", "run"]);
  });
});

describe("objects that several applications know", () => {
  it("keeps the advice of an application for an object that another application only holds", async () => {
    const log: string[] = [];

    class Account {
      withdraw() {
        log.push("withdraw");
      }
    }

    @Injectable()
    class Reporter {
      constructor(@Inject("ACCOUNT") readonly account: Account) {}
    }
    await initWoven({
      providers: [Account, labelling(Account, "guard", log)],
    });
    const account = new Account();
    account.withdraw();
    expect(log.splice(0)).toEqual(["guard", "withdraw"]);

    const holding = await initWoven({
      providers: [{ provide: "ACCOUNT", useValue: account }, Reporter],
    });
    holding.moduleRef.get(Reporter).account.withdraw();
    expect(log.splice(0)).toEqual(["guard", "withdraw"]);

    await holding.moduleRef.close();
    account.withdraw();
    expect(log).toEqual(["guard", "withdraw"]);
  });

  it("refuses an object whose dependencies belong to two applications", async () => {
    const log: string[] = [];

    @Injectable()
    class Left {}

    @Injectable()
    class Right {}

    class Pair {
      constructor(
        readonly left: Left,
        readonly right: Right,
      ) {}

      run() {
        log.push("run");
      }
    }
    const providers = (label: string) => [
      Left,
      Right,
      Pair,
      labelling(Pair, label, log),
    ];
    const first = await initWoven({ providers: providers("first") });
    const second = await initWoven({ providers: providers("second") });
    const mixed = new Pair(
      first.moduleRef.get(Left),
      second.moduleRef.get(Right),
    );
    expect(() => mixed.run()).toThrow(AspectUsageError);
    expect(log).toEqual([]);
  });

  it("does not attribute an object to the application of its dependencies when that application does not advise the class", async () => {
    const log: string[] = [];

    @Injectable()
    class Dependency {}

    class Holder {
      constructor(readonly dependency: Dependency) {}

      run() {
        log.push("run");
      }
    }
    const third = await initWoven({ providers: [Dependency, Holder] });
    await initWoven({
      providers: [Dependency, Holder, labelling(Holder, "first", log)],
    });
    await initWoven({
      providers: [Dependency, Holder, labelling(Holder, "second", log)],
    });
    const holder = new Holder(third.moduleRef.get(Dependency));
    expect(() => holder.run()).toThrow(AspectUsageError);
    expect(log).toEqual([]);
  });
});

describe("requiresAdvice members after the application closed", () => {
  const Authorized = createAnnotation<"Authorized">("Authorized", {
    requiresAdvice: true,
  });

  it("rejects the call on an instance of a closed application instead of running it without the advice", async () => {
    const log: string[] = [];

    @Injectable()
    class Vault {
      @Authorized()
      open() {
        log.push("opened");
      }

      describe() {
        return "vault";
      }
    }
    const pointcut = P.annotated(Authorized);

    @Aspect()
    class Authorizing {
      @Before(pointcut)
      check(_jp: JoinPoint<AnyShape>) {
        log.push("checked");
      }
    }
    const { moduleRef } = await initWoven({ providers: [Vault, Authorizing] });
    const vault = moduleRef.get(Vault);
    vault.open();
    expect(log.splice(0)).toEqual(["checked", "opened"]);

    await moduleRef.close();
    expect(() => vault.open()).toThrow(AspectConfigurationError);
    expect(() => vault.open()).toThrow(
      "Vault.open requires advice, and the application of the instance it was called on is closed",
    );
    expect(vault.describe()).toBe("vault");
    expect(log).toEqual([]);
  });

  it("keeps rejecting the call after the initialization failed its validation", async () => {
    const log: string[] = [];

    @Injectable()
    class Vault {
      @Authorized()
      open() {
        log.push("opened");
      }
    }
    // Not a module of the fixture: Nest rejects close() after a failed init().
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot()],
      providers: [Vault],
    }).compile();
    const vault = moduleRef.get(Vault);
    expect(() => vault.open()).toThrow(
      "no advisor of the application handles it",
    );

    await expect(moduleRef.init()).rejects.toThrow(AspectConfigurationError);
    expect(() => vault.open()).toThrow(AspectConfigurationError);
    expect(log).toEqual([]);
  });
});

describe("pointcuts on the token of a scoped factory provider", () => {
  it("advises the instances of a request-scoped factory whose class is a provider as well", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const pointcut = P.bean("ADMIN");

    @Aspect()
    class Guard {
      @Before(pointcut)
      check(_jp: JoinPoint<AnyShape>) {
        log.push("guard");
      }
    }
    const { moduleRef } = await initWoven({
      providers: [
        Service,
        Guard,
        {
          provide: "ADMIN",
          scope: Scope.REQUEST,
          useFactory: () => new Service(),
        },
      ],
    });
    const admin = await moduleRef.resolve<Service>(
      "ADMIN",
      ContextIdFactory.create(),
    );
    admin.run();
    expect(log).toEqual(["guard", "run"]);
  });
});
