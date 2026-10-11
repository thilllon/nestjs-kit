import "reflect-metadata";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Inject, Injectable, Scope } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AspectModule } from "./aspect.module";
import { Aspect, Before } from "./aspect-decorators";
import { P } from "./pointcut-designators";
import type { AnyShape, Class, JoinPoint } from "./types";
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

/** Runs full garbage collections across a few turns of the event loop. */
async function collectGarbage(): Promise<void> {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    collect();
  }
}

describe("applications that share a class", () => {
  it("advises an instance with the aspects of its own application", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }

    // No application: a hand-made instance runs the original method.
    new Shared().run();
    expect(log.splice(0)).toEqual(["run"]);

    const first = await compileWoven({
      providers: [Shared, labelling(Shared, "first", log)],
    });
    const stub = Shared.prototype.run;
    const second = await compileWoven({
      providers: [Shared, labelling(Shared, "second", log)],
    });
    expect(Shared.prototype.run).toBe(stub);

    const firstInstance = first.moduleRef.get(Shared);
    const secondInstance = second.moduleRef.get(Shared);
    firstInstance.run();
    secondInstance.run();
    expect(log.splice(0)).toEqual(["first", "run", "second", "run"]);

    await second.moduleRef.close();
    secondInstance.run();
    firstInstance.run();
    expect(log.splice(0)).toEqual(["run", "first", "run"]);

    await first.moduleRef.close();
    firstInstance.run();
    new Shared().run();
    expect(log.splice(0)).toEqual(["run", "run"]);

    // create -> close -> create: the third application advises its instance.
    const third = await compileWoven({
      providers: [Shared, labelling(Shared, "third", log)],
    });
    third.moduleRef.get(Shared).run();
    firstInstance.run();
    expect(log).toEqual(["third", "run", "run"]);
  });

  it("leaves an instance to the application that holds it and does not advise the class", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }

    await compileWoven({
      providers: [Shared, labelling(Shared, "weaving", log)],
    });
    const excluding = await compileWoven(
      { providers: [Shared, labelling(Shared, "excluding", log)] },
      { exclude: [Shared] },
    );
    const unmatched = await compileWoven({ providers: [Shared] });
    excluding.moduleRef.get(Shared).run();
    unmatched.moduleRef.get(Shared).run();
    expect(log).toEqual(["run", "run"]);
  });

  it("does not adopt an instance of a closed application that was never called", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }

    const first = await compileWoven({
      providers: [Shared, labelling(Shared, "first", log)],
    });
    const instance = first.moduleRef.get(Shared);
    await first.moduleRef.close();
    await compileWoven({
      providers: [Shared, labelling(Shared, "second", log)],
    });
    instance.run();
    expect(log).toEqual(["run"]);
  });

  it("advises a value provider instance that sequential applications reuse", async () => {
    const log: string[] = [];

    class Shared {
      run() {
        log.push("run");
      }
    }
    const instance = new Shared();
    const providers = [
      { provide: Shared, useValue: instance },
      labelling(Shared, "advice", log),
    ];

    const first = await initWoven({ providers });
    first.moduleRef.get(Shared).run();
    await first.moduleRef.close();
    instance.run();
    expect(log.splice(0)).toEqual(["advice", "run", "run"]);

    const second = await initWoven({ providers });
    second.moduleRef.get(Shared).run();
    expect(log).toEqual(["advice", "run"]);
  });

  it("drops an application that is abandoned without close()", async () => {
    const log: string[] = [];

    @Injectable()
    class Shared {
      run() {
        log.push("run");
      }
    }

    @Injectable()
    class Broken {
      // The dependency delays the constructor until the weaver has run.
      constructor(@Inject("SLOW") _slow: unknown) {
        throw new Error("boom");
      }
    }
    const Labelling = labelling(Shared, "abandoned", log);
    const slow = {
      provide: "SLOW",
      useFactory: () => new Promise((resolve) => setTimeout(resolve, 5)),
    };

    // The applications live in a function of their own, and not under
    // `expect(...).rejects`: both would keep the containers reachable.
    async function abandonApplications(): Promise<unknown> {
      const failure: unknown = await Test.createTestingModule({
        imports: [AspectModule.forRoot()],
        providers: [Shared, Labelling, Broken, slow],
      })
        .compile()
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      // Compiled, never initialized and never closed.
      await Test.createTestingModule({
        imports: [AspectModule.forRoot()],
        providers: [Shared, Labelling],
      }).compile();
      return failure;
    }
    expect(await abandonApplications()).toEqual(new Error("boom"));
    expect(isStub(Shared.prototype.run)).toBe(true);
    new Shared().run();
    expect(log.splice(0)).toEqual(["abandoned", "run"]);

    await collectGarbage();
    new Shared().run();
    expect(log).toEqual(["run"]);
  });

  it("attributes an instance no container holds to the most recent application, with one warning", async () => {
    const log: string[] = [];

    @Injectable({ scope: Scope.REQUEST })
    class PerRequest {
      run() {}
    }

    const first = await compileWoven({
      providers: [PerRequest, labelling(PerRequest, "first", log)],
    });
    const second = await compileWoven({
      providers: [PerRequest, labelling(PerRequest, "second", log)],
    });
    for (const { moduleRef } of [first, second, first]) {
      const instance = await moduleRef.resolve(
        PerRequest,
        ContextIdFactory.create(),
      );
      instance.run();
      instance.run();
    }
    expect(log).toEqual(Array(6).fill("second"));
    expect(second.logger.messages("warn")).toEqual([
      expect.stringContaining("Several live applications weave PerRequest"),
    ]);
  });
});
