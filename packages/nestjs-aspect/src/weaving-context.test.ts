import "reflect-metadata";
import { Injectable, Scope } from "@nestjs/common";
import { ContextIdFactory } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { Aspect, Before } from "./aspect-decorators";
import { P } from "./pointcut-designators";
import type { AnyShape, Class, JoinPoint } from "./types";
import { closeWoven, compileWoven } from "./weaving-fixture";

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
