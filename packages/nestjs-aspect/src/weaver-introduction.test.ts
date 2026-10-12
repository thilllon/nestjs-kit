import "reflect-metadata";
import { Injectable, Scope } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { Aspect, Before } from "./aspect-decorators";
import { AspectConfigurationError, AspectUsageError } from "./errors";
import { DeclareParents, introduced, isIntroduced } from "./introduction";
import { Pointcut as P } from "./pointcut-designators";
import type { AnyShape, ClassFilter, JoinPoint } from "./types";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

abstract class UsageTracked {
  abstract incrementUseCount(): void;

  abstract get useCount(): number;

  abstract set label(value: string);

  abstract describeUsage(): string;
}

const delegates: DefaultUsageTracked[] = [];

class DefaultUsageTracked implements UsageTracked {
  private count = 0;

  private name = "usage";

  constructor() {
    delegates.push(this);
  }

  incrementUseCount(): void {
    this.count++;
  }

  get useCount(): number {
    return this.count;
  }

  set label(value: string) {
    this.name = value;
  }

  describeUsage(): string {
    return `${this.name}: ${this.count}`;
  }
}

afterEach(() => {
  delegates.length = 0;
});

describe("introductions", () => {
  it("gives each target its own delegate, created on first use, and exposes its members on the target", async () => {
    @Injectable({ scope: Scope.TRANSIENT })
    class Report {
      render() {
        return "report";
      }
    }

    @Injectable()
    class Plain {
      render() {
        return "plain";
      }
    }
    const reports = P.within(Report);

    @Aspect()
    class UsageTracking {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;

      @Before(reports)
      record(joinPoint: JoinPoint<AnyShape>) {
        joinPoint.introduced(UsageTracked).incrementUseCount();
      }
    }
    const { moduleRef } = await initWoven({
      providers: [Report, Plain, UsageTracking],
    });
    const first = await moduleRef.resolve(Report);
    const second = await moduleRef.resolve(Report);
    expect(delegates).toEqual([]);

    first.render();
    first.render();
    second.render();
    expect(delegates).toHaveLength(2);
    expect(introduced(first, UsageTracked)).toBe(delegates[0]);
    expect(introduced(second, UsageTracked)).toBe(delegates[1]);

    if (!isIntroduced(first, UsageTracked)) {
      throw new Error("the report is introduced");
    }
    // The type guard widens the report to the introduced interface.
    expect(first.useCount).toBe(2);
    first.incrementUseCount();
    first.label = "first report";
    expect(first.describeUsage()).toBe("first report: 3");
    expect(introduced(second, UsageTracked).describeUsage()).toBe("usage: 1");
    expect(first.render()).toBe("report");

    const plain = moduleRef.get(Plain);
    expect(isIntroduced(plain, UsageTracked)).toBe(false);
    expect(isIntroduced(first, DefaultUsageTracked)).toBe(false);
    expect("useCount" in plain).toBe(false);
    expect(() => introduced(plain, UsageTracked)).toThrow(AspectUsageError);
    expect(() => introduced(plain, UsageTracked)).toThrow(
      "UsageTracked is not introduced into Plain",
    );
  });

  it("accepts a class filter and introduces into the classes it matches only in its own application", async () => {
    @Injectable()
    class Report {}
    const filter: ClassFilter = { matches: (ref) => ref.type === Report };

    @Aspect()
    class UsageTracking {
      @DeclareParents(filter, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }
    const introducing = await compileWoven({
      providers: [Report, UsageTracking],
    });
    const other = await compileWoven({ providers: [Report] });

    const report = introducing.moduleRef.get(Report);
    const foreign = other.moduleRef.get(Report);
    expect(isIntroduced(report, UsageTracked)).toBe(true);
    expect(isIntroduced(foreign, UsageTracked)).toBe(false);
    // The prototype is shared, so the member exists and refuses the call.
    expect(() => (foreign as Report & UsageTracked).describeUsage()).toThrow(
      AspectUsageError,
    );

    await introducing.moduleRef.close();
    expect(isIntroduced(report, UsageTracked)).toBe(false);
    expect(() => (report as Report & UsageTracked).useCount).toThrow(
      AspectUsageError,
    );
    expect(() => (report as Report & UsageTracked).useCount).toThrow(
      "Report.useCount is introduced by an aspect, and the application of the instance it was called on is closed or does not declare the introduction",
    );
  });

  it("does not introduce into a subclass in the container that the class filter rejects", async () => {
    @Injectable()
    class Base {}

    @Injectable()
    class Sub extends Base {}
    const filter: ClassFilter = { matches: (ref) => ref.type === Base };

    @Aspect()
    class UsageTracking {
      @DeclareParents(filter, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }
    const { moduleRef } = await compileWoven({
      providers: [Base, Sub, UsageTracking],
    });
    const sub = moduleRef.get(Sub);
    expect(isIntroduced(moduleRef.get(Base), UsageTracked)).toBe(true);
    expect(isIntroduced(sub, UsageTracked)).toBe(false);
    expect(() => (sub as Sub & UsageTracked).incrementUseCount()).toThrow(
      AspectUsageError,
    );
  });

  it("gives an instance of a subclass outside the container the advice and the introductions of its woven superclass", async () => {
    const log: string[] = [];

    @Injectable()
    class Report {
      render() {
        return "report";
      }
    }

    class Outside extends Report {}
    const reports = P.within(Report);

    @Aspect()
    class UsageTracking {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;

      @Before(reports)
      record(_jp: JoinPoint<AnyShape>) {
        log.push("advice");
      }
    }
    await compileWoven({ providers: [Report, UsageTracking] });

    const outside = new Outside();
    expect(outside.render()).toBe("report");
    expect(log).toEqual(["advice"]);
    if (!isIntroduced(outside, UsageTracked)) {
      throw new Error("the subclass instance is introduced");
    }
    outside.incrementUseCount();
    expect(outside.useCount).toBe(1);
  });

  it("applies the introductions that a superclass of the aspect declares", async () => {
    @Injectable()
    class Report {}
    const reports = P.within(Report);

    class TrackingSupport {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }

    @Aspect()
    class UsageTracking extends TrackingSupport {}

    const { moduleRef } = await compileWoven({
      providers: [Report, UsageTracking],
    });
    expect(isIntroduced(moduleRef.get(Report), UsageTracked)).toBe(true);
  });

  it("introduces a setter next to the getter the class has under the same name", async () => {
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

    class Document {
      get label(): string {
        return "own getter";
      }
    }

    @Injectable()
    class Report {
      get label(): string {
        return "own getter";
      }
    }

    /** Inherits the getter. */
    @Injectable()
    class Invoice extends Document {}
    const documents = P.within(Report, Invoice);

    @Aspect()
    class Labelling {
      @DeclareParents(documents, { use: DefaultLabelled, override: true })
      static readonly mixin: Labelled;
    }
    const { moduleRef } = await compileWoven({
      providers: [Report, Invoice, Labelling],
    });
    for (const type of [Report, Invoice]) {
      const document = moduleRef.get<{ label: string } & Labelled>(type);
      document.label = "introduced";
      expect(document.current).toBe("introduced");
      expect(document.label).toBe("own getter");
    }
  });

  it("rejects an introduced member that the class already has, unless the introduction overrides it", async () => {
    @Injectable()
    class Report {
      describeUsage() {
        return "own";
      }
    }
    const reports = P.within(Report);

    @Aspect()
    class Conflicting {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }

    @Aspect()
    class Overriding {
      @DeclareParents(reports, { use: DefaultUsageTracked, override: true })
      static readonly mixin: UsageTracked;
    }

    const failure: unknown = await compileWoven({
      providers: [Report, Conflicting],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AspectConfigurationError);
    expect(String(failure)).toContain(
      "The introduction Conflicting.mixin adds describeUsage to Report, which already has a member of that name",
    );

    const { moduleRef } = await compileWoven({
      providers: [Report, Overriding],
    });
    const report = moduleRef.get(Report);
    expect(report.describeUsage()).toBe("usage: 0");
    await moduleRef.close();
    expect(report.describeUsage()).toBe("own");
  });

  it("rejects two introductions of one application that add the same member to a class", async () => {
    @Injectable()
    class Report {}
    const reports = P.within(Report);

    @Aspect()
    class First {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }

    @Aspect()
    class Second {
      @DeclareParents(reports, { use: DefaultUsageTracked })
      static readonly mixin: UsageTracked;
    }
    await expect(
      compileWoven({ providers: [Report, First, Second] }),
    ).rejects.toThrow(
      "The introduction Second.mixin adds incrementUseCount to Report, which the introduction First.mixin adds as well",
    );
  });

  it("rejects a declaration that names no introduced interface or is no static member", () => {
    interface Erased {
      run(): void;
    }

    class Running implements Erased {
      run() {}
    }
    const anything = P.within(Running);

    expect(() => {
      class Declaring {
        @DeclareParents(anything, { use: Running })
        static readonly mixin: Erased;
      }
      return Declaring;
    }).toThrow("as the type of the static member Declaring.mixin");
    expect(() => {
      class Declaring {
        @(
          DeclareParents(anything, { use: DefaultUsageTracked }) as (
            target: object,
            key: string,
          ) => void
        )
        readonly mixin!: UsageTracked;
      }
      return Declaring;
    }).toThrow("a static member");
    expect(() =>
      DeclareParents(undefined as never, { use: DefaultUsageTracked }),
    ).toThrow(AspectConfigurationError);

    // The delegate class implements the type of the static member.
    class Mismatched {
      // @ts-expect-error Running does not implement UsageTracked
      @DeclareParents(anything, { use: Running })
      static readonly mixin: UsageTracked;
    }
    expect(Mismatched).toBeDefined();
  });
});
