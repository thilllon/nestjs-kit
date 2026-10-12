import "reflect-metadata";
import {
  forwardRef,
  Global,
  Inject,
  Injectable,
  Module,
  type OnModuleInit,
  Optional,
  Scope,
} from "@nestjs/common";
import { ContextIdFactory, LazyModuleLoader } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { AspectModule } from "./aspect.module";
import {
  Advisor,
  After,
  AfterReturning,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectConfigurationError, AspectNotReadyError } from "./errors";
import { DeclareParents, introduced, isIntroduced } from "./introduction";
import { Pointcut as P } from "./pointcut-designators";
import type {
  AdviceAdapter,
  AnyShape,
  JoinPoint,
  ProceedingJoinPoint,
  ReturnValueAdapter,
} from "./types";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

abstract class UsageTracked {
  abstract incrementUseCount(): void;

  abstract get useCount(): number;

  abstract describeUsage(): string;
}

class DefaultUsageTracked implements UsageTracked {
  private count = 0;

  incrementUseCount(): void {
    this.count++;
  }

  get useCount(): number {
    return this.count;
  }

  describeUsage(): string {
    return `usage: ${this.count}`;
  }
}

/** A promise that settles when the test opens it. */
function gate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("keyed aspect instances", () => {
  it("gives a per-target aspect instance the provider that its own module registers under a token another module registers as well", async () => {
    const constructed: string[] = [];

    @Injectable()
    class Service {
      run() {}
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perTarget" })
    class Labelling {
      constructor(@Inject("CONFIG") readonly config: string) {
        constructed.push(config);
      }

      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {}
    }

    @Module({
      providers: [
        { provide: "CONFIG", useValue: "aspect module" },
        Service,
        Labelling,
      ],
    })
    class AspectFeatureModule {}

    @Module({
      providers: [{ provide: "CONFIG", useValue: "other module" }],
    })
    class OtherModule {}

    const { moduleRef } = await initWoven({
      imports: [AspectFeatureModule, OtherModule],
    });
    moduleRef.get(Service, { strict: false }).run();
    // The provider instance, then the instance of the target object.
    expect(constructed).toEqual(["aspect module", "aspect module"]);
  });

  it.each([
    {
      own: "a request-scoped provider",
      other: "a singleton",
      ownScope: Scope.REQUEST,
      otherScope: Scope.DEFAULT,
    },
    {
      own: "a singleton",
      other: "a request-scoped provider",
      ownScope: Scope.DEFAULT,
      otherScope: Scope.REQUEST,
    },
  ])(
    "validates the scope of $own that the module of a per-class aspect registers under a token another module registers as $other",
    async ({ ownScope, otherScope }) => {
      const seen: string[] = [];

      @Injectable()
      class Service {
        run() {}
      }
      const pointcut = P.within(Service);

      @Aspect({ instantiation: "perClass" })
      class Labelling {
        constructor(@Inject("CONFIG") private readonly config: string) {}

        @Before(pointcut)
        record(_joinPoint: JoinPoint<AnyShape>) {
          seen.push(this.config);
        }
      }

      @Module({
        providers: [
          { provide: "CONFIG", scope: ownScope, useFactory: () => "own" },
          Service,
          Labelling,
        ],
      })
      class AspectFeatureModule {}

      @Module({
        providers: [
          { provide: "CONFIG", scope: otherScope, useFactory: () => "other" },
        ],
      })
      class OtherModule {}
      const compilation = initWoven({
        imports: [AspectFeatureModule, OtherModule],
      });

      if (ownScope === Scope.REQUEST) {
        await expect(compilation).rejects.toThrow(
          "The perClass aspect Labelling depends on CONFIG, which is request-scoped or transient",
        );
      } else {
        const { moduleRef } = await compilation;
        moduleRef.get(Service, { strict: false }).run();
        expect(seen).toEqual(["own"]);
      }
    },
  );

  it("gives a per-class aspect instance a provider that the module of the aspect imports", async () => {
    const seen: string[] = [];

    @Injectable()
    class Clock {
      now() {
        return "noon";
      }
    }

    @Module({
      providers: [Clock],
      exports: [Clock],
    })
    class ClockModule {}

    @Injectable()
    class Service {
      run() {}
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perClass" })
    class Stamping {
      constructor(private readonly clock: Clock) {}

      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        seen.push(this.clock.now());
      }
    }

    @Module({
      imports: [ClockModule],
      providers: [Service, Stamping],
    })
    class FeatureModule {}

    const { moduleRef } = await initWoven({ imports: [FeatureModule] });
    moduleRef.get(Service, { strict: false }).run();
    expect(seen).toEqual(["noon"]);
  });

  it("resolves a forwardRef() dependency of a per-target aspect", async () => {
    const log: string[] = [];

    @Injectable()
    class Ledger {
      private entries = 0;

      next(): number {
        return ++this.entries;
      }
    }

    @Injectable()
    class Service {
      run() {}
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perTarget" })
    class Booking {
      constructor(
        @Inject(forwardRef(() => Ledger)) private readonly ledger: Ledger,
      ) {}

      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push(`entry ${this.ledger.next()}`);
      }
    }
    const { moduleRef } = await initWoven({
      providers: [Ledger, Service, Booking],
    });

    moduleRef.get(Service).run();
    expect(log).toEqual(["entry 1"]);
    expect(moduleRef.get(Ledger).next()).toBe(2);
  });

  it("keeps the initializer of an optional @Inject() property that no provider supplies", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {}
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perTarget" })
    class Tagging {
      @Optional()
      @Inject("TAG")
      readonly tag: string = "untagged";

      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push(this.tag);
      }
    }
    const { moduleRef } = await initWoven({ providers: [Service, Tagging] });

    moduleRef.get(Service).run();
    expect(log).toEqual(["untagged"]);
  });

  it.each([
    {
      instantiation: "perClass" as const,
      dependency: "a request-scoped provider",
      bubbling: false,
    },
    {
      instantiation: "perTarget" as const,
      dependency: "a singleton that depends on a request-scoped provider",
      bubbling: true,
    },
  ])(
    "rejects a $instantiation aspect that depends on $dependency, and fails the call without strict mode",
    async ({ instantiation, bubbling }) => {
      const log: string[] = [];
      const constructed: object[] = [];

      @Injectable({ scope: Scope.REQUEST })
      class Tenant {}

      @Injectable()
      class TenantSettings {
        constructor(readonly tenant: Tenant) {}
      }

      @Injectable()
      class Service {
        run() {
          log.push("run");
        }
      }
      const Dependency = bubbling ? TenantSettings : Tenant;
      const pointcut = P.within(Service);

      @Aspect({ instantiation })
      class Scoped {
        constructor(@Inject(Dependency) readonly dependency: object) {
          constructed.push(this);
        }

        @Before(pointcut)
        record(_joinPoint: JoinPoint<AnyShape>) {
          log.push("advice");
        }
      }
      const metadata = { providers: [Tenant, TenantSettings, Service, Scoped] };
      const dependencyProblem = `The ${instantiation} aspect Scoped depends on ${Dependency.name}, which is request-scoped or transient`;
      const scopeProblem =
        "The aspect Scoped is not a singleton: it is request-scoped or transient, by its own scope or through a dependency";

      const failure: unknown = await initWoven(metadata).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(AspectConfigurationError);
      expect(String(failure)).toContain(dependencyProblem);
      expect(String(failure)).toContain(scopeProblem);
      expect(String(failure)).toContain("ModuleRef.resolve()");

      const { moduleRef, logger } = await initWoven(metadata, {
        strict: false,
      });
      expect(logger.messages("warn")).toEqual(
        expect.arrayContaining([
          expect.stringContaining(dependencyProblem),
          expect.stringContaining(scopeProblem),
        ]),
      );
      const service = moduleRef.get(Service);
      // The aspect provider is request-scoped itself, so no instance of it exists.
      expect(() => service.run()).toThrow(AspectNotReadyError);
      expect(() => service.run()).toThrow(AspectNotReadyError);
      expect(log).toEqual([]);
      expect(constructed).toEqual([]);
    },
  );

  it("fails every call of a perClass aspect with a transient dependency without strict mode, and constructs no instance for the class", async () => {
    const log: string[] = [];
    const constructed: object[] = [];

    @Injectable({ scope: Scope.TRANSIENT })
    class Draft {}

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perClass" })
    class Drafting {
      constructor(readonly draft: Draft) {
        constructed.push(this);
      }

      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("advice");
      }
    }
    const { moduleRef } = await initWoven(
      { providers: [Draft, Service, Drafting] },
      { strict: false },
    );
    const service = moduleRef.get(Service);

    for (const _attempt of [1, 2]) {
      expect(() => service.run()).toThrow(AspectConfigurationError);
      expect(() => service.run()).toThrow(
        "The perClass aspect Drafting depends on Draft, which is request-scoped or transient",
      );
    }
    expect(log).toEqual([]);
    // The provider instance, which the container constructed.
    expect(constructed).toEqual([moduleRef.get(Drafting)]);
  });

  it("gives the target of each request its own per-target aspect instance while the requests interleave", async () => {
    const tracers: object[] = [];
    const traces: [tracer: number, orders: string[]][] = [];
    const counters: object[] = [];
    const counts: [counter: number, calls: number][] = [];

    @Injectable({ scope: Scope.REQUEST })
    class Checkout {
      async pay(order: string, settled: Promise<void>): Promise<string> {
        await settled;
        return `paid ${order}`;
      }
    }
    const pointcut = P.within(Checkout);

    @Aspect({ instantiation: "perTarget" })
    class Tracing {
      private readonly orders: string[] = [];

      constructor() {
        tracers.push(this);
      }

      @Around(pointcut)
      async trace(joinPoint: ProceedingJoinPoint<AnyShape>) {
        this.orders.push(String(joinPoint.args[0]));
        const result: unknown = await joinPoint.proceed();
        traces.push([tracers.indexOf(this), [...this.orders]]);
        return result;
      }
    }

    @Aspect({ instantiation: "perClass" })
    class Counting {
      private calls = 0;

      constructor() {
        counters.push(this);
      }

      @Before(pointcut)
      count(_joinPoint: JoinPoint<AnyShape>) {
        counts.push([counters.indexOf(this), ++this.calls]);
      }
    }
    const { moduleRef } = await initWoven({
      providers: [Checkout, Tracing, Counting],
    });
    const firstRequest = ContextIdFactory.create();
    const secondRequest = ContextIdFactory.create();
    const first = await moduleRef.resolve(Checkout, firstRequest);
    const second = await moduleRef.resolve(Checkout, secondRequest);
    expect(await moduleRef.resolve(Checkout, firstRequest)).toBe(first);
    // The provider instances, which serve no call.
    expect(tracers).toHaveLength(1);
    expect(counters).toHaveLength(1);

    const gates = [gate(), gate(), gate()];
    const calls = [
      first.pay("a1", gates[0].promise),
      second.pay("b1", gates[1].promise),
      first.pay("a2", gates[2].promise),
    ];
    gates[1].resolve();
    await expect(calls[1]).resolves.toBe("paid b1");
    gates[2].resolve();
    gates[0].resolve();
    await expect(Promise.all(calls)).resolves.toEqual([
      "paid a1",
      "paid b1",
      "paid a2",
    ]);

    expect(traces).toEqual([
      [2, ["b1"]],
      [1, ["a1", "a2"]],
      [1, ["a1", "a2"]],
    ]);
    expect(tracers).toHaveLength(3);
    expect(counts).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    expect(counters).toHaveLength(2);
  });

  it("raises the error of the constructor of a keyed aspect and constructs the instance on the next call", async () => {
    const log: string[] = [];
    const constructed: object[] = [];
    let failing = false;

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perClass" })
    class Fragile {
      constructor() {
        if (failing) {
          throw new Error("the aspect cannot start");
        }
        constructed.push(this);
      }

      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push(`aspect ${constructed.indexOf(this)}`);
      }
    }
    const { moduleRef } = await initWoven({ providers: [Service, Fragile] });
    const service = moduleRef.get(Service);

    failing = true;
    expect(() => service.run()).toThrow("the aspect cannot start");
    expect(log).toEqual([]);

    failing = false;
    service.run();
    service.run();
    expect(log).toEqual(["aspect 1", "run", "aspect 1", "run"]);
  });

  it("keeps the per-class instances of an aspect class that two applications register apart", async () => {
    const constructed: object[] = [];
    const seen: [aspect: number, calls: number, tick: number][] = [];

    @Injectable()
    class Clock {
      private ticks = 0;

      tick(): number {
        return ++this.ticks;
      }
    }

    @Injectable()
    class Session {
      touch() {}
    }
    const pointcut = P.within(Session);

    @Aspect({ instantiation: "perClass" })
    class Counting {
      private calls = 0;

      constructor(private readonly clock: Clock) {
        constructed.push(this);
      }

      @Before(pointcut)
      count(_joinPoint: JoinPoint<AnyShape>) {
        seen.push([constructed.indexOf(this), ++this.calls, this.clock.tick()]);
      }
    }
    const metadata = { providers: [Clock, Session, Counting] };
    const one = await initWoven(metadata);
    const two = await initWoven(metadata);

    one.moduleRef.get(Session).touch();
    two.moduleRef.get(Session).touch();
    one.moduleRef.get(Session).touch();
    // The provider instances are 0 and 1.
    expect(seen).toEqual([
      [2, 1, 1],
      [3, 1, 1],
      [2, 2, 2],
    ]);
  });
});

// Classes of module scope: every application of the tests below shares them,
// as the test cases of a consumer share the classes of its modules.
@Injectable()
class Ledger {
  balance() {
    return 0;
  }
}

@Injectable()
class Journal {
  describeUsage() {
    return "own";
  }
}

@Aspect()
class LedgerTracking {
  @DeclareParents(P.within(Ledger), { use: DefaultUsageTracked })
  static readonly ledgers: UsageTracked;

  @DeclareParents(P.within(Journal), {
    use: DefaultUsageTracked,
    override: true,
  })
  static readonly journals: UsageTracked;
}

describe("introductions across applications", () => {
  it("introduces into the same classes in simultaneous and in later applications, each instance with its own delegate", async () => {
    const metadata = { providers: [Ledger, Journal, LedgerTracking] };
    const one = await compileWoven(metadata);
    const two = await compileWoven(metadata);
    const firstLedger = one.moduleRef.get(Ledger);
    const secondLedger = two.moduleRef.get(Ledger);
    const firstJournal = one.moduleRef.get(Journal);

    introduced(firstLedger, UsageTracked).incrementUseCount();
    introduced(firstJournal, UsageTracked).incrementUseCount();
    expect((firstLedger as Ledger & UsageTracked).useCount).toBe(1);
    expect((secondLedger as Ledger & UsageTracked).useCount).toBe(0);
    expect(firstJournal.describeUsage()).toBe("usage: 1");
    expect(two.moduleRef.get(Journal).describeUsage()).toBe("usage: 0");

    await one.moduleRef.close();
    await two.moduleRef.close();
    expect(isIntroduced(firstLedger, UsageTracked)).toBe(false);
    expect(firstJournal.describeUsage()).toBe("own");

    const three = await compileWoven(metadata);
    const thirdLedger = three.moduleRef.get(Ledger);
    expect(isIntroduced(thirdLedger, UsageTracked)).toBe(true);
    expect((thirdLedger as Ledger & UsageTracked).describeUsage()).toBe(
      "usage: 0",
    );
    expect(thirdLedger.balance()).toBe(0);
    expect(three.moduleRef.get(Journal).describeUsage()).toBe("usage: 0");
    expect(isIntroduced(firstLedger, UsageTracked)).toBe(false);
  });

  it("gives the interface to the overriding introduction when two aspects introduce it into one class", async () => {
    class ReplacementUsageTracked extends DefaultUsageTracked {
      override describeUsage(): string {
        return "replacement";
      }
    }

    @Injectable()
    class Report {}
    const reports = P.within(Report);

    @Aspect()
    class Tracking {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }

    @Aspect()
    class Replacing {
      @DeclareParents(reports, {
        use: ReplacementUsageTracked,
        override: true,
      })
      static readonly mixin: UsageTracked;
    }
    const { moduleRef } = await compileWoven({
      providers: [Report, Tracking, Replacing],
    });
    const report = moduleRef.get(Report);

    expect(introduced(report, UsageTracked)).toBeInstanceOf(
      ReplacementUsageTracked,
    );
    expect((report as Report & UsageTracked).describeUsage()).toBe(
      "replacement",
    );
  });

  it("leaves the getter a subclass inherits from a woven superclass unadvised when an introduction adds the setter", async () => {
    const log: string[] = [];

    abstract class Labelled {
      abstract set label(value: string);

      abstract get current(): string;
    }

    class DefaultLabelled implements Labelled {
      private value = "none";

      set label(value: string) {
        this.value = value;
      }

      get current(): string {
        return this.value;
      }
    }

    @Injectable()
    class Document {
      get label(): string {
        return "own getter";
      }
    }

    @Injectable()
    class Invoice extends Document {}
    // The getter of Document only: Invoice is registered under its own token.
    const getters = P.bean(Document).and(P.kind("getter"));

    @Aspect()
    class Labelling {
      @DeclareParents(P.bean(Invoice), { use: DefaultLabelled, override: true })
      static readonly mixin: Labelled;

      @Before(getters)
      record(joinPoint: JoinPoint<AnyShape>) {
        log.push(`read by ${joinPoint.signature.targetType.name}`);
      }
    }
    const { moduleRef } = await compileWoven({
      providers: [Document, Invoice, Labelling],
    });
    const invoice = moduleRef.get<{ label: string } & Labelled>(Invoice);

    invoice.label = "introduced";
    expect(invoice.current).toBe("introduced");
    expect(invoice.label).toBe("own getter");
    expect(log).toEqual([]);

    expect(moduleRef.get(Document).label).toBe("own getter");
    expect(log).toEqual(["read by Document"]);
  });

  it("rejects a use option that is no class", () => {
    class Target {}

    const declare = () =>
      DeclareParents(P.within(Target), { use: undefined as never });
    expect(declare).toThrow(AspectConfigurationError);
    expect(declare).toThrow(
      "@DeclareParents requires a class as its use option",
    );
  });
});

const Audited = createAnnotation<"Audited">("Audited");

const Authorized = createAnnotation<"Authorized">("Authorized", {
  requiresAdvice: true,
});

describe("classes of lazy-loaded modules", () => {
  it("weaves the class of an instance that a value or factory provider of the module supplies", async () => {
    const log: string[] = [];

    class Report {
      render() {
        log.push("render");
      }
    }

    class Export {
      render() {
        log.push("export");
      }
    }

    @Module({
      providers: [
        { provide: "REPORT", useValue: new Report() },
        { provide: "EXPORT", useFactory: () => new Export() },
      ],
    })
    class ReportModule {}
    const pointcut = P.within(Report, Export);

    @Aspect()
    class Auditing {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("audit");
      }
    }
    const { moduleRef } = await initWoven({ providers: [Auditing] });
    const lazy = await moduleRef.get(LazyModuleLoader).load(() => ReportModule);

    lazy.get<Report>("REPORT").render();
    lazy.get<Export>("EXPORT").render();
    expect(log).toEqual(["audit", "render", "audit", "export"]);
  });

  it("weaves a class again that the module registers under another token, for the instances that exist", async () => {
    const log: string[] = [];

    @Injectable()
    class Report {
      render() {
        log.push("render");
      }
    }

    @Module({
      providers: [{ provide: "ARCHIVE", useClass: Report }],
    })
    class ArchiveModule {}
    const reports = P.within(Report);
    const archives = P.bean("ARCHIVE");

    @Aspect()
    class Auditing {
      @Before(reports)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("audit");
      }

      @Before(archives)
      archive(_joinPoint: JoinPoint<AnyShape>) {
        log.push("archive");
      }
    }
    const { moduleRef } = await initWoven({ providers: [Report, Auditing] });
    const report = moduleRef.get(Report);
    report.render();
    expect(log.splice(0)).toEqual(["audit", "render"]);

    const lazy = await moduleRef
      .get(LazyModuleLoader)
      .load(() => ArchiveModule);
    lazy.get<Report>("ARCHIVE").render();
    expect(log.splice(0)).toEqual(["audit", "archive", "render"]);
    // The designator selects the class, so its other instances follow.
    report.render();
    expect(log.splice(0)).toEqual(["audit", "archive", "render"]);
    // The class still belongs to one application: an instance that no
    // container holds is not ambiguous.
    new Report().render();
    expect(log).toEqual(["audit", "archive", "render"]);
  });

  it("keeps the token of a request-scoped factory provider among the beans of a class that a load weaves again", async () => {
    const log: string[] = [];

    class Draft {
      render() {
        log.push("render");
      }
    }

    @Module({
      providers: [{ provide: "OTHER", useClass: Draft }],
    })
    class OtherModule {}
    const drafts = P.bean("DRAFT");

    @Aspect()
    class Auditing {
      @Before(drafts)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("audit");
      }
    }
    const { moduleRef } = await initWoven({
      providers: [
        Auditing,
        {
          provide: "DRAFT",
          scope: Scope.REQUEST,
          useFactory: () => new Draft(),
        },
      ],
    });
    const resolveDraft = () =>
      moduleRef.resolve<Draft>("DRAFT", ContextIdFactory.create());
    (await resolveDraft()).render();
    expect(log.splice(0)).toEqual(["audit", "render"]);

    await moduleRef.get(LazyModuleLoader).load(() => OtherModule);
    (await resolveDraft()).render();
    expect(log).toEqual(["audit", "render"]);
  });

  it("introduces into a class of the module", async () => {
    @Injectable()
    class Report {}

    @Module({
      providers: [Report],
    })
    class ReportModule {}
    const reports = P.within(Report);

    @Aspect()
    class UsageTracking {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }
    const { moduleRef } = await initWoven({ providers: [UsageTracking] });
    const lazy = await moduleRef.get(LazyModuleLoader).load(() => ReportModule);

    const report = lazy.get(Report);
    if (!isIntroduced(report, UsageTracked)) {
      throw new Error("the report is introduced");
    }
    report.incrementUseCount();
    expect(report.describeUsage()).toBe("usage: 1");
  });

  function collidingModule() {
    const log: string[] = [];
    const vaults: Vault[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }

    @Injectable()
    class Report {
      describeUsage() {
        return "own";
      }
    }

    @Injectable()
    class Vault {
      constructor() {
        vaults.push(this);
      }

      @Authorized()
      open() {
        log.push("opened");
      }
    }

    @Module({
      providers: [Report, Vault],
    })
    class ReportModule {}
    const reports = P.within(Report);
    const guarded = P.within(Service).or(P.annotated(Authorized));

    @Aspect()
    class UsageTracking {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;

      @Before(guarded)
      check(_joinPoint: JoinPoint<AnyShape>) {
        log.push("checked");
      }
    }
    return {
      metadata: { providers: [Service, UsageTracking] },
      Service,
      ReportModule,
      vaults,
      log,
    };
  }

  const collision =
    "The introduction UsageTracking.mixin adds describeUsage to Report, which already has a member of that name";

  it("rejects the load when an introduction adds a member the class has, and keeps the application live", async () => {
    const { metadata, Service, ReportModule, log } = collidingModule();
    const { moduleRef } = await initWoven(metadata);

    const failure: unknown = await moduleRef
      .get(LazyModuleLoader)
      .load(() => ReportModule)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AspectConfigurationError);
    expect(String(failure)).toContain(collision);

    moduleRef.get(Service).run();
    expect(log).toEqual(["checked", "run"]);
  });

  it("advises a member that requires advice after an introduction rejected the load of its module", async () => {
    const { metadata, ReportModule, vaults, log } = collidingModule();
    const { moduleRef } = await initWoven(metadata);
    await expect(
      moduleRef.get(LazyModuleLoader).load(() => ReportModule),
    ).rejects.toThrow(collision);

    vaults[0].open();
    expect(log).toEqual(["checked", "opened"]);
  });

  it("reports the member an introduction collides with again from the next load of the module", async () => {
    const { metadata, ReportModule } = collidingModule();
    const { moduleRef } = await initWoven(metadata);
    const loader = moduleRef.get(LazyModuleLoader);
    await expect(loader.load(() => ReportModule)).rejects.toThrow(collision);

    await expect(loader.load(() => ReportModule)).rejects.toThrow(collision);
  });

  it("weaves the classes that follow the class an introduction collides with, and rejects every load of the module", async () => {
    const log: string[] = [];

    @Injectable()
    class Report {
      describeUsage() {
        return "own";
      }
    }

    // A load that is rejected returns no module reference, so the instances
    // report themselves.
    const invoices: { render(): void }[] = [];
    const mailers: { send(): void }[] = [];

    @Injectable()
    class Invoice {
      constructor() {
        invoices.push(this);
      }

      @Audited()
      render() {
        log.push("invoice");
      }
    }

    @Module({
      providers: [Report, Invoice],
    })
    class ReportModule {}
    const reports = P.within(Report);
    const audited = P.annotated(Audited);

    @Aspect()
    class UsageTracking {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;

      @Before(audited)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("audit");
      }
    }

    @Injectable()
    class Mailer {
      constructor() {
        mailers.push(this);
      }

      @Audited()
      send() {
        log.push("send");
      }
    }

    @Module({
      providers: [Mailer],
    })
    class MailerModule {}
    const { moduleRef } = await initWoven({ providers: [UsageTracking] });
    const loader = moduleRef.get(LazyModuleLoader);

    await expect(loader.load(() => ReportModule)).rejects.toThrow(collision);
    await expect(loader.load(() => ReportModule)).rejects.toThrow(collision);
    // The load of another module weaves its classes and reports the
    // collision that is still there.
    await expect(loader.load(() => MailerModule)).rejects.toThrow(collision);

    invoices[0].render();
    mailers[0].send();
    expect(log).toEqual(["audit", "invoice", "audit", "send"]);
  });

  it("leaves a class of the exclude option unadvised", async () => {
    const log: string[] = [];

    @Injectable()
    class Report {
      @Audited()
      render() {
        log.push("render");
      }
    }

    @Injectable()
    class Invoice {
      @Audited()
      render() {
        log.push("invoice");
      }
    }

    @Module({
      providers: [Report, Invoice],
    })
    class ReportModule {}
    const pointcut = P.annotated(Audited);

    @Aspect()
    class Auditing {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("audit");
      }
    }
    const { moduleRef } = await initWoven(
      { providers: [Auditing] },
      { exclude: [Report] },
    );
    const lazy = await moduleRef.get(LazyModuleLoader).load(() => ReportModule);

    lazy.get(Report).render();
    lazy.get(Invoice).render();
    expect(log).toEqual(["render", "audit", "invoice"]);
  });

  it("logs the report lines of the classes the load wove, and no line of the classes woven before", async () => {
    @Injectable()
    class Service {
      @Audited()
      run() {}
    }

    @Injectable()
    class Report {
      @Audited()
      render() {}
    }

    @Module({
      providers: [Report],
    })
    class ReportModule {}
    const pointcut = P.annotated(Audited);

    @Aspect()
    class Auditing {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {}
    }
    const { moduleRef, logger } = await initWoven(
      { providers: [Service, Auditing] },
      { report: "log" },
    );
    expect(logger.messages("log")).toEqual([
      "Service.run <- Auditing.record (before, no order)",
    ]);

    await moduleRef.get(LazyModuleLoader).load(() => ReportModule);
    expect(logger.messages("log").slice(1)).toEqual([
      "Report.render <- Auditing.record (before, no order)",
    ]);
  });

  it("advises the request-scoped and transient instances of the module in the application that loaded it", async () => {
    const log: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class Report {
      render() {}
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class Draft {
      render() {}
    }

    class Export {
      render() {}
    }

    @Module({
      providers: [
        Report,
        Draft,
        {
          provide: "EXPORT",
          scope: Scope.REQUEST,
          useFactory: () => new Export(),
        },
      ],
      exports: [Report, Draft, "EXPORT"],
    })
    class DocumentsModule {}
    const pointcut = P.within(Report, Draft, Export);

    @Aspect()
    class Auditing {
      constructor(@Inject("APPLICATION") private readonly name: string) {}

      @Before(pointcut)
      record(joinPoint: JoinPoint<AnyShape>) {
        log.push(`${this.name} ${joinPoint.signature.targetType.name}`);
      }
    }
    const application = (name: string) => ({
      provide: "APPLICATION",
      useValue: name,
    });
    // A second live application that advises the same classes: an instance
    // that no application claims is refused in strict mode.
    const eager = await initWoven({
      imports: [DocumentsModule],
      providers: [Auditing, application("eager")],
    });
    const eagerRequest = ContextIdFactory.create();
    (await eager.moduleRef.resolve(Report, eagerRequest)).render();
    (await eager.moduleRef.resolve<Export>("EXPORT", eagerRequest)).render();
    expect(log.splice(0)).toEqual(["eager Report", "eager Export"]);

    const { moduleRef } = await initWoven({
      providers: [Auditing, application("lazy")],
    });
    const lazy = await moduleRef
      .get(LazyModuleLoader)
      .load(() => DocumentsModule);
    const request = ContextIdFactory.create();
    (await lazy.resolve(Report, request)).render();
    (await lazy.resolve(Draft)).render();
    (await lazy.resolve<Export>("EXPORT", request)).render();
    expect(log).toEqual(["lazy Report", "lazy Draft", "lazy Export"]);
  });
});

describe("the timing of lazy loads", () => {
  function auditedModules() {
    const log: string[] = [];

    @Injectable()
    class Report {
      @Audited()
      render() {
        log.push("render");
      }
    }

    @Module({
      providers: [Report],
    })
    class ReportModule {}

    @Injectable()
    class Invoice {
      @Audited()
      render() {
        log.push("invoice");
      }
    }

    @Module({
      providers: [Invoice],
    })
    class InvoiceModule {}
    const pointcut = P.annotated(Audited);

    @Aspect()
    class Auditing {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("audit");
      }
    }
    return { Report, ReportModule, Invoice, InvoiceModule, Auditing, log };
  }

  it("weaves the classes of two modules whose loads run at the same time", async () => {
    const { Report, ReportModule, Invoice, InvoiceModule, Auditing, log } =
      auditedModules();
    const { moduleRef } = await initWoven({ providers: [Auditing] });
    const loader = moduleRef.get(LazyModuleLoader);

    const [reports, invoices] = await Promise.all([
      loader.load(() => ReportModule),
      loader.load(() => InvoiceModule),
    ]);
    reports.get(Report).render();
    invoices.get(Invoice).render();
    expect(log).toEqual(["audit", "render", "audit", "invoice"]);
  });

  it("weaves a module that an onModuleInit hook loads before the weaver has completed", async () => {
    const { Report, ReportModule, Auditing, log } = auditedModules();
    const duringHook: string[][] = [];

    @Injectable()
    class Preloader implements OnModuleInit {
      report?: InstanceType<typeof Report>;

      constructor(private readonly loader: LazyModuleLoader) {}

      async onModuleInit() {
        const lazy = await this.loader.load(() => ReportModule);
        const report = lazy.get(Report);
        report.render();
        duringHook.push(log.splice(0));
        this.report = report;
      }
    }

    @Global()
    @Module({
      providers: [Preloader],
      exports: [Preloader],
    })
    class PreloadModule {}

    // The global module precedes AspectModule, so its hooks run first.
    const moduleRef = await Test.createTestingModule({
      imports: [PreloadModule, AspectModule.forRoot()],
      providers: [Auditing],
    }).compile();
    try {
      await moduleRef.init();
      // The weaver had not completed: the class was not woven in the hook.
      expect(duringHook).toEqual([["render"]]);
      moduleRef.get(Preloader).report?.render();
      expect(log).toEqual(["audit", "render"]);
    } finally {
      await moduleRef.close();
    }
  });

  it("resolves a load that follows the shutdown of the application, without weaving", async () => {
    const { Report, ReportModule, Auditing, log } = auditedModules();
    const { moduleRef, logger } = await initWoven(
      { providers: [Auditing] },
      { report: "log" },
    );
    const loader = moduleRef.get(LazyModuleLoader);
    await moduleRef.close();
    const logged = logger.entries.length;

    const lazy = await loader.load(() => ReportModule);
    lazy.get(Report).render();
    expect(log).toEqual(["render"]);
    // Neither a report line nor a warning: the closed weaver examines nothing.
    expect(logger.entries).toHaveLength(logged);
  });

  it("propagates the error of a load that Nest rejects and weaves the next module", async () => {
    const { Report, ReportModule, Auditing, log } = auditedModules();

    @Module({
      providers: [
        {
          provide: "STORAGE",
          useFactory: () => {
            throw new Error("the storage is unreachable");
          },
        },
      ],
    })
    class BrokenModule {}
    const { moduleRef } = await initWoven({ providers: [Auditing] });
    const loader = moduleRef.get(LazyModuleLoader);

    await expect(loader.load(() => BrokenModule)).rejects.toThrow(
      "the storage is unreachable",
    );
    const lazy = await loader.load(() => ReportModule);
    lazy.get(Report).render();
    expect(log).toEqual(["audit", "render"]);
  });
});

/** An advice kind of its own: a label the interceptor records. */
class Tagged {
  constructor(
    readonly tag: string,
    readonly log: string[],
  ) {}
}

const taggedAdapter: AdviceAdapter = {
  supports: (advice) => advice instanceof Tagged,
  toInterceptor: (advice) => ({
    invoke(invocation) {
      const { tag, log } = advice as Tagged;
      log.push(tag);
      return invocation.proceed();
    },
  }),
};

describe("adapters of several applications", () => {
  it("converts a custom advice kind only in the application that registers its adapter", async () => {
    const log: string[] = [];

    @Injectable()
    class Quotes {
      latest() {
        return 42;
      }
    }

    @Advisor()
    class Tagging {
      static readonly pointcut = P.method(Quotes, "latest");

      readonly advice = new Tagged("tagged", log);
    }
    const metadata = { providers: [Quotes, Tagging] };
    const adapting = await initWoven(metadata, {
      adviceAdapters: [taggedAdapter],
    });
    const plain = await initWoven(metadata);

    expect(adapting.moduleRef.get(Quotes).latest()).toBe(42);
    expect(() => plain.moduleRef.get(Quotes).latest()).toThrow(
      "No advice adapter supports the advice",
    );
    expect(adapting.moduleRef.get(Quotes).latest()).toBe(42);
    expect(log).toEqual(["tagged", "tagged"]);
  });

  it("follows a custom result type only in the application that registers its return value adapter", async () => {
    const results: unknown[] = [];

    class Task {
      constructor(readonly value: number) {}
    }
    const taskAdapter: ReturnValueAdapter<Task> = {
      supports: (value): value is Task => value instanceof Task,
      onSuccess(task, callback) {
        callback(task.value);
        return task;
      },
      onError: (task) => task,
      finally(task, callback) {
        callback();
        return task;
      },
    };

    @Injectable()
    class Jobs {
      start() {
        return new Task(42);
      }
    }
    const pointcut = P.within(Jobs);

    @Aspect()
    class Results {
      @AfterReturning(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>, result: unknown) {
        results.push(result);
      }
    }
    const metadata = { providers: [Jobs, Results] };
    const adapting = await initWoven(metadata, {
      returnValueAdapters: [taskAdapter],
    });
    const plain = await initWoven(metadata);

    const followed = adapting.moduleRef.get(Jobs).start();
    expect(results.splice(0)).toEqual([42]);
    const returned = plain.moduleRef.get(Jobs).start();
    expect(results).toEqual([returned]);
    expect(followed).toBeInstanceOf(Task);
  });
});

describe("interceptors of advice adapters in the chain", () => {
  it("skips the interceptor of an adapter on the calls the runtime pointcut of its advisor rejects", async () => {
    const log: string[] = [];

    @Injectable()
    class Quotes {
      latest(_symbol: string | number) {
        log.push("latest");
      }
    }

    @Advisor()
    class Tagging {
      static readonly pointcut = P.within(Quotes).and(P.args(String));

      readonly advice = new Tagged("tagged", log);
    }
    const { moduleRef } = await initWoven(
      { providers: [Quotes, Tagging] },
      { adviceAdapters: [taggedAdapter] },
    );
    const quotes = moduleRef.get(Quotes);

    quotes.latest("AAPL");
    expect(log.splice(0)).toEqual(["tagged", "latest"]);
    quotes.latest(7);
    expect(log).toEqual(["latest"]);
  });

  it("converts the advice of an aspect with a registered adapter that supports it, instead of the built-in conversion", async () => {
    const log: string[] = [];
    const replacing: AdviceAdapter = {
      supports: (advice) => "kind" in advice && advice.kind === "before",
      toInterceptor: () => ({
        invoke(invocation) {
          log.push("replaced");
          return invocation.proceed();
        },
      }),
    };

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const pointcut = P.within(Service);

    @Aspect()
    class Auditing {
      @Before(pointcut)
      record(_joinPoint: JoinPoint<AnyShape>) {
        log.push("before");
      }

      @After(pointcut)
      finish(_joinPoint: JoinPoint<AnyShape>) {
        log.push("after");
      }
    }
    const { moduleRef } = await initWoven(
      { providers: [Service, Auditing] },
      { adviceAdapters: [replacing] },
    );

    moduleRef.get(Service).run();
    expect(log).toEqual(["replaced", "run", "after"]);
  });
});
