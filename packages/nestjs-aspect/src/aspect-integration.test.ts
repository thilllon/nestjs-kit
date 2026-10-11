import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAnnotation } from "./annotation";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { P } from "./pointcut-designators";
import type {
  AnyShape,
  JoinPoint,
  JoinPointOf,
  ProceedingJoinPointOf,
} from "./types";
import { closeWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

interface RetryOptions {
  attempts: number;
}

const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable");
const Audited = createAnnotation<"Audited", { action: string }>("Audited");
const Roles = Reflector.createDecorator<string[]>();

class Account {
  constructor(readonly id: string) {}
}

class User {
  constructor(readonly name: string) {}
}

/**
 * An application with one service in a feature module and two aspects in
 * the root module. Every call declares its own classes: stubs live on class
 * prototypes, which the tests of one file share.
 */
async function application() {
  const log: string[] = [];

  @Injectable()
  class UserService {
    /** Errors the next calls of `findById` fail with, one per call. */
    failures: Error[] = [];

    calls = 0;

    @Retryable({ attempts: 3 })
    @Roles(["admin"])
    async findById(id: number): Promise<User> {
      this.calls += 1;
      log.push(`findById ${id} #${this.calls}`);
      const failure = this.failures.shift();
      if (failure) {
        throw failure;
      }
      return new User(`user-${id}`);
    }

    @Audited({ action: "rename" })
    rename(_user: User, name: string): User {
      log.push(`rename ${name}`);
      return new User(name);
    }

    deposit(to: Account | string, amount: number): string {
      log.push(`deposit ${amount}`);
      return typeof to === "string" ? to : to.id;
    }
  }

  @Module({
    providers: [UserService],
    exports: [UserService],
  })
  class UserModule {}

  const retryable = P.annotated(Retryable);
  const findById = P.method(UserService, "findById");
  const rename = P.method(UserService, "rename");
  const audited = P.annotated(Audited);
  const withRoles = P.annotated(Roles);
  const inUserModule = P.inModule(UserModule).and(P.bean(/Service$/));
  const accountOps = P.within(UserService).and(P.args(Account, P.REST));

  @Aspect({ order: 10 })
  class ResilienceAspect {
    @AfterThrowing(findById, { throwing: RangeError })
    onRangeError(_jp: JoinPointOf<typeof findById>, error: RangeError): void {
      log.push(`range error: ${error.message}`);
    }

    @AfterReturning(findById)
    cacheUser(joinPoint: JoinPointOf<typeof findById>, user: User): void {
      const [id] = joinPoint.args;
      const key: number = id;
      log.push(`cache ${key} = ${user.name}`);
    }

    @Around(retryable)
    async retry(
      joinPoint: ProceedingJoinPointOf<typeof retryable>,
    ): Promise<unknown> {
      const { attempts } = joinPoint.annotation(Retryable);
      for (let attempt = 1; ; attempt++) {
        try {
          return await joinPoint.proceed();
        } catch (error) {
          if (attempt >= attempts) {
            throw error;
          }
        }
      }
    }
  }

  @Aspect({ order: 1 })
  class AuditAspect {
    @After(inUserModule)
    leave(joinPoint: JoinPoint<AnyShape>): void {
      log.push(`leave ${String(joinPoint.signature.name)}`);
    }

    @Before(inUserModule)
    enter(joinPoint: JoinPoint<AnyShape>): void {
      log.push(`enter ${joinPoint}`);
    }

    @Before(withRoles)
    roles(joinPoint: JoinPointOf<typeof withRoles>): void {
      const roles: string[] | undefined = joinPoint.findAnnotation(Roles);
      log.push(`roles ${roles?.join()}`);
    }

    @Before(audited)
    audit(joinPoint: JoinPointOf<typeof audited>): void {
      const { action } = joinPoint.annotation(Audited);
      log.push(`audit ${action}`);
    }

    @Before(accountOps)
    checkAccount(joinPoint: JoinPointOf<typeof accountOps>): void {
      const account: Account = joinPoint.args[0];
      log.push(`account ${account.id}`);
    }

    @Around(rename)
    upperCase(joinPoint: ProceedingJoinPointOf<typeof rename>): User {
      const [user, name] = joinPoint.args;
      return joinPoint.proceedWith(user, name.toUpperCase());
    }
  }

  const { moduleRef } = await initWoven({
    imports: [UserModule],
    providers: [ResilienceAspect, AuditAspect],
  });
  return { service: moduleRef.get(UserService, { strict: false }), log };
}

describe("two aspects woven into a service of a feature module", () => {
  it("retries an annotated method until it succeeds within its attempts", async () => {
    const { service, log } = await application();
    service.failures = [new RangeError("first"), new TypeError("second")];

    const user = await service.findById(7);

    expect(user).toEqual(new User("user-7"));
    expect(service.calls).toBe(3);
    expect(log).toEqual([
      "enter UserService.findById(7)",
      "roles admin",
      "findById 7 #1",
      "range error: first",
      "findById 7 #2",
      "findById 7 #3",
      "cache 7 = user-7",
      "leave findById",
    ]);
  });

  it("rejects with the last error when the attempts are used up", async () => {
    const { service, log } = await application();
    const last = new RangeError("third");
    service.failures = [
      new RangeError("first"),
      new RangeError("second"),
      last,
      new RangeError("never reached"),
    ];

    await expect(service.findById(7)).rejects.toBe(last);

    expect(service.calls).toBe(3);
    expect(log.filter((entry) => entry.startsWith("range error"))).toEqual([
      "range error: first",
      "range error: second",
      "range error: third",
    ]);
    expect(log.at(-1)).toBe("leave findById");
    expect(log).not.toContainEqual(expect.stringMatching(/^cache/));
  });

  it("gives advice the typed arguments and annotation value of a synchronous method", async () => {
    const { service, log } = await application();

    const renamed = service.rename(new User("ann"), "bob");

    expect(renamed).toEqual(new User("BOB"));
    expect(log).toEqual([
      'enter UserService.rename(User, "BOB")',
      "audit rename",
      "rename BOB",
      "leave rename",
    ]);
  });

  it("runs advice behind a runtime matcher only for the calls it accepts", async () => {
    const { service, log } = await application();

    expect(service.deposit(new Account("acc-1"), 5)).toBe("acc-1");
    expect(service.deposit("acc-2", 6)).toBe("acc-2");

    expect(log).toEqual([
      "enter UserService.deposit(Account, 5)",
      "account acc-1",
      "deposit 5",
      "leave deposit",
      'enter UserService.deposit("acc-2", 6)',
      "deposit 6",
      "leave deposit",
    ]);
  });
});
