import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { LazyModuleLoader } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import { Aspect, Before } from "./aspect-decorators";
import { AspectInspector } from "./aspect-inspector";
import { AspectConfigurationError } from "./errors";
import { P } from "./pointcut-designators";
import type { AnyShape, JoinPoint } from "./types";
import { closeWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

const Audited = createAnnotation<"Audited">("Audited");

const Authorized = createAnnotation<"Authorized">("Authorized", {
  requiresAdvice: true,
});

describe("lazy-loaded modules", () => {
  it("weaves the classes of a module when LazyModuleLoader has loaded it", async () => {
    const log: string[] = [];

    @Injectable()
    class Report {
      @Audited()
      render() {
        log.push("render");
        return "report";
      }
    }

    @Module({
      providers: [Report],
    })
    class ReportModule {}

    const pointcut = P.annotated(Audited);

    @Aspect()
    class Auditing {
      @Before(pointcut)
      record(joinPoint: JoinPoint<AnyShape>) {
        log.push(`audit ${String(joinPoint.signature.name)}`);
      }
    }
    const { moduleRef, logger } = await initWoven({ providers: [Auditing] });
    expect(logger.messages("warn")).toEqual([
      expect.stringContaining("matches no member of the application"),
    ]);
    const inspector = moduleRef.get(AspectInspector);
    expect(inspector.advisedMembers()).toEqual([]);

    const loader = moduleRef.get(LazyModuleLoader);
    const lazy = await loader.load(() => ReportModule);
    expect(lazy.get(Report).render()).toBe("report");
    expect(log.splice(0)).toEqual(["audit render", "render"]);
    expect(inspector.advisedMembers().map((member) => member.name)).toEqual([
      "render",
    ]);

    // A module that is loaded already is returned without weaving again.
    const again = await loader.load(() => ReportModule);
    again.get(Report).render();
    expect(log).toEqual(["audit render", "render"]);
  });

  function vaultModule() {
    const log: string[] = [];
    const vaults: Vault[] = [];

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
      providers: [Vault],
    })
    class VaultModule {}
    return { Vault, VaultModule, vaults, log };
  }

  it("rejects the load in strict mode when a member requires advice that no advisor handles", async () => {
    const { VaultModule, vaults, log } = vaultModule();
    const { moduleRef } = await initWoven({});
    const loader = moduleRef.get(LazyModuleLoader);

    await expect(loader.load(() => VaultModule)).rejects.toThrow(
      AspectConfigurationError,
    );
    await expect(loader.load(() => VaultModule)).rejects.toThrow(
      "Vault.open (@Authorized)",
    );
    expect(vaults).toHaveLength(1);
    expect(() => vaults[0].open()).toThrow(AspectConfigurationError);
    expect(log).toEqual([]);
  });

  it("warns without strict mode and rejects the call of the member", async () => {
    const { Vault, VaultModule, log } = vaultModule();
    const { moduleRef, logger } = await initWoven({}, { strict: false });

    const lazy = await moduleRef.get(LazyModuleLoader).load(() => VaultModule);
    expect(logger.messages("warn")).toEqual([
      expect.stringContaining("Vault.open (@Authorized)"),
    ]);
    expect(() => lazy.get(Vault).open()).toThrow(
      "no advisor of the application handles it",
    );
    expect(log).toEqual([]);
  });

  it("rejects the load of a module that registers an aspect", async () => {
    const log: string[] = [];

    @Injectable()
    class Service {
      run() {
        log.push("run");
      }
    }
    const pointcut = P.within(Service);

    @Aspect()
    class Late {
      @Before(pointcut)
      record(_jp: JoinPoint<AnyShape>) {
        log.push("late");
      }
    }

    @Module({
      providers: [Late],
    })
    class LateModule {}

    const { moduleRef } = await initWoven(
      { providers: [Service] },
      { strict: false },
    );
    await expect(
      moduleRef.get(LazyModuleLoader).load(() => LateModule),
    ).rejects.toThrow(
      "The aspect Late is registered by a lazy-loaded module, so its advice does not run",
    );
    moduleRef.get(Service).run();
    expect(log).toEqual(["run"]);
  });
});
