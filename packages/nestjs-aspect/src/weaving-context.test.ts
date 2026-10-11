import "reflect-metadata";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Inject, Injectable } from "@nestjs/common";
import { ModulesContainer } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AspectModule } from "./aspect.module";
import { Aspect, Before } from "./aspect-decorators";
import { AspectUsageError } from "./errors";
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

/** Runs a full garbage collection after a turn of the event loop. */
async function collectGarbage(): Promise<void> {
  setFlagsFromString("--expose-gc");
  const collect = runInNewContext("gc") as () => void;
  await new Promise((resolve) => setTimeout(resolve, 0));
  collect();
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

  it("drops an application that is abandoned without close() once nothing refers to it", async () => {
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
    // The containers, which keep the applications reachable until released.
    const containers: ModulesContainer[] = [];
    const slow = {
      provide: "SLOW",
      inject: [ModulesContainer],
      useFactory: (container: ModulesContainer) => {
        containers.push(container);
        return new Promise((resolve) => setTimeout(resolve, 5));
      },
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
        providers: [Shared, Labelling, slow],
      }).compile();
      return failure;
    }
    expect(await abandonApplications()).toEqual(new Error("boom"));
    expect(containers).toHaveLength(2);
    expect(isStub(Shared.prototype.run)).toBe(true);
    // Both applications are live: nothing tells which of them advises an
    // instance that neither created.
    expect(() => new Shared().run()).toThrow(AspectUsageError);
    expect(log).toEqual([]);

    containers.length = 0;
    const run = (): boolean => {
      try {
        new Shared().run();
      } catch {
        // An application is still live.
      }
      return log.includes("run");
    };
    for (let turn = 0; turn < 20 && !run(); turn++) {
      await collectGarbage();
    }
    expect(log).toEqual(["run"]);
  });

  it("keeps advising the instances of an application that only they keep reachable", async () => {
    const log: string[] = [];

    /** A class of its own per application, with an aspect that guards it. */
    function guarded() {
      const constructed: Vault[] = [];

      @Injectable()
      class Vault {
        constructor() {
          constructed.push(this);
        }

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
      const metadata = {
        imports: [AspectModule.forRoot()],
        providers: [Vault, Guard],
      };
      return { Vault, metadata, constructed };
    }

    // The handles of the applications go out of scope with these functions.
    // The container of the first application never hands its instance out:
    // the initialization records it as an instance of the application.
    async function initialized(): Promise<{ open(): string }> {
      const { metadata, constructed } = guarded();
      const moduleRef = await Test.createTestingModule(metadata).compile();
      await moduleRef.init();
      return constructed.splice(0)[0];
    }
    async function compiled(): Promise<{ open(): string }> {
      const { Vault, metadata, constructed } = guarded();
      const moduleRef = await Test.createTestingModule(metadata).compile();
      constructed.length = 0;
      return moduleRef.get(Vault);
    }
    const vaults = [await initialized(), await compiled()];
    for (let turn = 0; turn < 10; turn++) {
      await collectGarbage();
    }
    for (const vault of vaults) {
      expect(() => vault.open()).toThrow("denied");
    }
    expect(log).toEqual([]);
  });
});
