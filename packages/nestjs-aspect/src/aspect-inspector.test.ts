import "reflect-metadata";
import { Inject, Injectable, Module } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import {
  Advisor,
  After,
  AfterReturning,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectInspector } from "./aspect-inspector";
import { DeclareParents } from "./introduction";
import { Pointcut as P } from "./pointcut-designators";
import type {
  JoinPointOf,
  MethodInterceptor,
  ProceedingJoinPointOf,
} from "./types";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

function fixture() {
  @Injectable()
  class OrderService {
    private state = "open";

    get status(): string {
      return this.state;
    }

    set status(value: string) {
      this.state = value;
    }

    place(item: string): string {
      return item;
    }

    cancel(item: string): string {
      return item;
    }

    describe(): string {
      return "orders";
    }
  }

  @Injectable()
  class RushOrderService extends OrderService {
    override cancel(item: string): string {
      return `rush ${item}`;
    }
  }

  const place = P.method(OrderService, "place");
  const mutations = P.method(OrderService, "place").or(
    P.method(OrderService, "cancel"),
  );

  @Aspect({ order: 20 })
  class AuditAspect {
    @AfterReturning(mutations)
    recordResult() {}

    @Before(mutations)
    recordCall() {}

    @After(P.within(OrderService).and(P.kind("setter")))
    recordStatus() {}
  }

  @Aspect({ order: 10 })
  class RetryAspect {
    @Around(place)
    retry(joinPoint: ProceedingJoinPointOf<typeof place>) {
      return joinPoint.proceed();
    }
  }

  @Advisor()
  class TracingAdvisor {
    static readonly pointcut = place;

    readonly advice: MethodInterceptor = {
      invoke: (invocation) => invocation.proceed(),
    };
  }

  return {
    OrderService,
    RushOrderService,
    AuditAspect,
    RetryAspect,
    TracingAdvisor,
  };
}

describe("AspectInspector", () => {
  it("lists the advisors of a member in the order their advice runs, with the advice kind, source and order", async () => {
    const { OrderService, AuditAspect, RetryAspect, TracingAdvisor } =
      fixture();
    const { moduleRef } = await initWoven(
      {
        providers: [OrderService, AuditAspect, TracingAdvisor, RetryAspect],
      },
      { report: false },
    );
    const inspector = moduleRef.get(AspectInspector);

    expect(inspector.advisorsOf(OrderService, "place")).toEqual([
      { type: RetryAspect, methodName: "retry", kind: "around", order: 10 },
      {
        type: AuditAspect,
        methodName: "recordCall",
        kind: "before",
        order: 20,
      },
      {
        type: AuditAspect,
        methodName: "recordResult",
        kind: "afterReturning",
        order: 20,
      },
      { type: TracingAdvisor, order: undefined },
    ]);
    expect(
      inspector
        .advisorsOf(OrderService, "cancel")
        .map(({ methodName }) => methodName),
    ).toEqual(["recordCall", "recordResult"]);
  });

  it("reports no advisor for a member, an accessor half or a class that nothing advises", async () => {
    const { OrderService, AuditAspect, RetryAspect } = fixture();

    @Injectable()
    class Unrelated {
      place() {}
    }

    const { moduleRef } = await initWoven(
      { providers: [OrderService, Unrelated, AuditAspect, RetryAspect] },
      { report: false },
    );
    const inspector = moduleRef.get(AspectInspector);

    expect(inspector.advisorsOf(OrderService, "describe")).toEqual([]);
    expect(inspector.advisorsOf(Unrelated, "place")).toEqual([]);
    expect(inspector.advisedMembers(Unrelated)).toEqual([]);
    expect(inspector.advisorsOf(OrderService, "status")).toEqual([]);
    expect(inspector.advisorsOf(OrderService, "status", "getter")).toEqual([]);
    expect(inspector.advisorsOf(OrderService, "status", "setter")).toEqual([
      {
        type: AuditAspect,
        methodName: "recordStatus",
        kind: "after",
        order: 20,
      },
    ]);
  });

  it("lists every advised member of the application and narrows the list to one class", async () => {
    const { OrderService, RushOrderService, AuditAspect, RetryAspect } =
      fixture();
    const { moduleRef } = await initWoven(
      {
        providers: [OrderService, RushOrderService, AuditAspect, RetryAspect],
      },
      { report: false },
    );
    const inspector = moduleRef.get(AspectInspector);
    const summary = (type?: typeof OrderService) =>
      inspector
        .advisedMembers(type)
        .map(
          (member) =>
            `${member.type.name}.${String(member.name)} (${member.kind}, declared by ${member.declaringType.name}): ${member.advisors.length}`,
        )
        .sort();

    expect(summary(RushOrderService)).toEqual([
      "RushOrderService.cancel (method, declared by RushOrderService): 2",
      "RushOrderService.place (method, declared by OrderService): 3",
      "RushOrderService.status (setter, declared by OrderService): 1",
    ]);
    expect(summary()).toEqual([
      "OrderService.cancel (method, declared by OrderService): 2",
      "OrderService.place (method, declared by OrderService): 3",
      "OrderService.status (setter, declared by OrderService): 1",
      ...summary(RushOrderService),
    ]);
  });

  it("omits a class the module options exclude", async () => {
    const { OrderService, RushOrderService, AuditAspect } = fixture();
    const { moduleRef } = await initWoven(
      { providers: [OrderService, RushOrderService, AuditAspect] },
      { report: false, exclude: [RushOrderService] },
    );
    const inspector = moduleRef.get(AspectInspector);

    expect(inspector.advisedMembers(RushOrderService)).toEqual([]);
    expect(inspector.advisorsOf(OrderService, "cancel")).toHaveLength(2);
  });

  it("leaves out members that are introduced and members whose calls are rejected", async () => {
    const Authorized = createAnnotation<"AuthorizedReport">(
      "AuthorizedReport",
      { requiresAdvice: true },
    );

    abstract class Tracked {
      abstract track(): void;
    }

    class DefaultTracked implements Tracked {
      track() {}
    }

    @Injectable()
    class Report {
      render() {}

      @Authorized()
      unsafe() {}
    }
    const render = P.method(Report, "render");

    @Aspect()
    class Reporting {
      @DeclareParents(render, { use: DefaultTracked })
      static readonly mixin: Tracked;

      @Before(render)
      record(_jp: JoinPointOf<typeof render>) {}
    }
    const { moduleRef, logger } = await initWoven(
      { providers: [Report, Reporting] },
      { strict: false, report: "log" },
    );

    expect(
      moduleRef
        .get(AspectInspector)
        .advisedMembers()
        .map((member) => `${member.type.name}.${String(member.name)}`),
    ).toEqual(["Report.render"]);
    expect(logger.messages("log")).toEqual([
      "Report.render <- Reporting.record (before, no order)",
    ]);
  });

  it("is injectable in any module and already answers while providers are constructed", async () => {
    const { OrderService, RetryAspect } = fixture();
    const seen: string[] = [];

    @Injectable()
    class Diagnostics {
      constructor(@Inject(AspectInspector) inspector: AspectInspector) {
        seen.push(
          ...inspector
            .advisorsOf(OrderService, "place")
            .map(({ type }) => type.name),
        );
      }
    }

    @Module({
      providers: [Diagnostics],
    })
    class DiagnosticsModule {}

    await compileWoven(
      { imports: [DiagnosticsModule], providers: [OrderService, RetryAspect] },
      { report: false },
    );

    expect(seen).toEqual(["RetryAspect"]);
  });

  it("answers for its own application when two advise one class differently, and lists nothing once it shut down", async () => {
    const { OrderService, AuditAspect, RetryAspect } = fixture();
    const first = await initWoven(
      { providers: [OrderService, AuditAspect] },
      { report: false },
    );
    const second = await initWoven(
      { providers: [OrderService, RetryAspect] },
      { report: false },
    );
    const names = (moduleRef: typeof first.moduleRef) =>
      moduleRef
        .get(AspectInspector)
        .advisorsOf(OrderService, "place")
        .map(({ type }) => type.name);

    expect(names(first.moduleRef)).toEqual(["AuditAspect", "AuditAspect"]);
    expect(names(second.moduleRef)).toEqual(["RetryAspect"]);

    await second.moduleRef.close();
    expect(names(second.moduleRef)).toEqual([]);
    expect(names(first.moduleRef)).toEqual(["AuditAspect", "AuditAspect"]);
  });
});
