import "reflect-metadata";
import { Inject, Injectable, Optional, Scope } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { Aspect, Before } from "./aspect-decorators";
import { AspectConfigurationError, AspectNotReadyError } from "./errors";
import { P } from "./pointcut-designators";
import type { AnyShape, Class, JoinPoint } from "./types";
import { closeWoven, compileWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

@Injectable()
class Clock {
  private ticks = 0;

  tick(): number {
    return ++this.ticks;
  }
}

/**
 * An aspect of the given instantiation model that counts the calls it
 * advises. `created` lists the aspect instances in creation order.
 */
function counting(
  instantiation: "perTarget" | "perClass",
  types: readonly Class[],
) {
  const created: object[] = [];
  const seen: [aspect: number, calls: number, tick: number][] = [];
  const pointcut = types
    .map((type) => P.within(type))
    .reduce((all, next) => all.or(next));

  @Aspect({ instantiation })
  class Counting {
    private calls = 0;

    constructor(
      private readonly clock: Clock,
      @Optional() @Inject("ABSENT") readonly absent?: unknown,
    ) {
      created.push(this);
    }

    @Before(pointcut)
    count(_jp: JoinPoint<AnyShape>) {
      seen.push([created.indexOf(this), ++this.calls, this.clock.tick()]);
    }
  }
  return { Counting, created, seen };
}

describe("per-target aspects", () => {
  it("creates one aspect instance per target object, on the first advised call, from the singleton dependencies", async () => {
    @Injectable({ scope: Scope.TRANSIENT })
    class Session {
      touch() {}
    }
    const { Counting, created, seen } = counting("perTarget", [Session]);
    const { moduleRef } = await initWoven({
      providers: [Clock, Session, Counting],
    });
    // The provider instance, which serves no call.
    expect(created).toHaveLength(1);

    const first = await moduleRef.resolve(Session);
    const second = await moduleRef.resolve(Session);
    expect(created).toHaveLength(1);

    first.touch();
    first.touch();
    second.touch();
    first.touch();
    expect(seen).toEqual([
      [1, 1, 1],
      [1, 2, 2],
      [2, 1, 3],
      [1, 3, 4],
    ]);
    expect(created).toHaveLength(3);
    expect(moduleRef.get(Clock).tick()).toBe(5);
  });

  it("rejects a dependency that is not a singleton, and fails the call without strict mode", async () => {
    @Injectable()
    class Service {
      run() {
        return "ran";
      }
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class Draft {}
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perTarget" })
    class Drafting {
      constructor(readonly draft: Draft) {}

      @Before(pointcut)
      record(_jp: JoinPoint<AnyShape>) {}
    }
    const metadata = { providers: [Service, Draft, Drafting] };

    await expect(initWoven(metadata)).rejects.toThrow(
      "The perTarget aspect Drafting depends on Draft, which is request-scoped or transient",
    );

    const { moduleRef, logger } = await initWoven(metadata, { strict: false });
    expect(logger.messages("warn")).toEqual([
      expect.stringContaining("The perTarget aspect Drafting depends on Draft"),
    ]);
    expect(() => moduleRef.get(Service).run()).toThrow(
      AspectConfigurationError,
    );
  });

  it("injects @Inject() constructor parameters and properties, and validates the properties", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {}
    }

    @Injectable({ scope: Scope.TRANSIENT })
    class Draft {}
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perTarget" })
    class Stamping {
      @Inject(Clock)
      private readonly clock!: Clock;

      constructor(@Inject("PREFIX") private readonly prefix: string) {}

      @Before(pointcut)
      stamp(_jp: JoinPoint<AnyShape>) {
        log.push(`${this.prefix} ${this.clock.tick()}`);
      }
    }

    @Aspect({ instantiation: "perTarget" })
    class Drafting {
      @Inject(Draft)
      readonly draft!: Draft;

      @Before(pointcut)
      record(_jp: JoinPoint<AnyShape>) {}
    }

    const { moduleRef } = await initWoven({
      providers: [
        Clock,
        Service,
        Stamping,
        { provide: "PREFIX", useValue: "at" },
      ],
    });
    moduleRef.get(Service).run();
    expect(log).toEqual(["at 1"]);

    await expect(
      initWoven({ providers: [Service, Draft, Drafting] }),
    ).rejects.toThrow(
      "The perTarget aspect Drafting depends on Draft, which is request-scoped or transient",
    );
  });

  it("raises AspectNotReadyError for a call that precedes the provider instance of the aspect", async () => {
    const created: object[] = [];

    @Injectable()
    class Service {
      // The dependency delays the constructor until the weaver has run.
      constructor(@Inject("SLOW") _slow: unknown) {
        this.run();
      }

      run() {}
    }
    const pointcut = P.within(Service);

    @Aspect({ instantiation: "perTarget" })
    class Dependent {
      constructor(readonly service: Service) {
        created.push(this);
      }

      @Before(pointcut)
      record(_jp: JoinPoint<AnyShape>) {}
    }
    const slow = {
      provide: "SLOW",
      useFactory: () => new Promise((resolve) => setTimeout(resolve, 5)),
    };

    await expect(
      compileWoven({ providers: [Service, Dependent, slow] }),
    ).rejects.toThrow(AspectNotReadyError);
    expect(created).toEqual([]);
  });

  it("creates no aspect instance for an object of another application", async () => {
    @Injectable()
    class Session {
      touch() {}
    }
    const first = counting("perTarget", [Session]);
    const second = counting("perTarget", [Session]);
    const one = await initWoven({
      providers: [Clock, Session, first.Counting],
    });
    await initWoven({ providers: [Clock, Session, second.Counting] });

    one.moduleRef.get(Session).touch();
    expect(first.seen).toEqual([[1, 1, 1]]);
    expect(second.seen).toEqual([]);
    expect(second.created).toHaveLength(1);
  });
});

describe("per-class aspects", () => {
  it("creates one aspect instance per advised class and shares it among the instances of the class", async () => {
    @Injectable({ scope: Scope.TRANSIENT })
    class Order {
      touch() {}
    }

    @Injectable()
    class Invoice {
      touch() {}
    }
    const { Counting, created, seen } = counting("perClass", [Order, Invoice]);
    const { moduleRef } = await initWoven({
      providers: [Clock, Order, Invoice, Counting],
    });
    expect(created).toHaveLength(1);

    (await moduleRef.resolve(Order)).touch();
    (await moduleRef.resolve(Order)).touch();
    moduleRef.get(Invoice).touch();
    (await moduleRef.resolve(Order)).touch();
    expect(seen).toEqual([
      [1, 1, 1],
      [1, 2, 2],
      [2, 1, 3],
      [1, 3, 4],
    ]);
    expect(created).toHaveLength(3);
  });

  it("keys the aspect instance by the class of the object for an inherited member", async () => {
    class Base {
      touch() {}
    }

    @Injectable()
    class Order extends Base {}

    @Injectable()
    class Invoice extends Base {}
    const { Counting, seen } = counting("perClass", [Base]);
    const { moduleRef } = await initWoven({
      providers: [Clock, Order, Invoice, Counting],
    });

    moduleRef.get(Order).touch();
    moduleRef.get(Invoice).touch();
    moduleRef.get(Order).touch();
    expect(seen.map(([aspect]) => aspect)).toEqual([1, 2, 1]);
  });
});
