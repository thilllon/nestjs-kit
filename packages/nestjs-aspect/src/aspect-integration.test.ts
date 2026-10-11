import "reflect-metadata";
import { Reflector } from "@nestjs/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createAdviceAdapterRegistry,
  createReturnValueAdapterRegistry,
} from "./advice";
import { createAnnotation } from "./annotation";
import { compileAspect, sortAdvisors } from "./aspect-compiler";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectNotReadyError } from "./errors";
import { buildChain, invoke } from "./invocation";
import { createClassRef, createMethodRef } from "./method-ref";
import { matchesStatically } from "./pointcut";
import { P } from "./pointcut-designators";
import type {
  AdvisorDescriptor,
  AnyShape,
  ChainOptions,
  Class,
  InterceptorChain,
  JoinPoint,
  JP,
  PJP,
} from "./types";

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

let log: string[];

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

  onModuleInit(): void {
    log.push("onModuleInit");
  }
}

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
  onRangeError(_jp: JP<typeof findById>, error: RangeError): void {
    log.push(`range error: ${error.message}`);
  }

  @AfterReturning(findById)
  cacheUser(jp: JP<typeof findById>, user: User): void {
    const [id] = jp.args;
    const key: number = id;
    log.push(`cache ${key} = ${user.name}`);
  }

  @Around(retryable)
  async retry(jp: PJP<typeof retryable>): Promise<unknown> {
    const { attempts } = jp.annotation(Retryable);
    for (let attempt = 1; ; attempt++) {
      try {
        return await jp.proceed();
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
  leave(jp: JoinPoint<AnyShape>): void {
    log.push(`leave ${String(jp.signature.name)}`);
  }

  @Before(inUserModule)
  enter(jp: JoinPoint<AnyShape>): void {
    log.push(`enter ${jp}`);
  }

  @Before(withRoles)
  roles(jp: JP<typeof withRoles>): void {
    const roles: string[] | undefined = jp.findAnnotation(Roles);
    log.push(`roles ${roles?.join()}`);
  }

  @Before(audited)
  audit(jp: JP<typeof audited>): void {
    const { action } = jp.annotation(Audited);
    log.push(`audit ${action}`);
  }

  @Before(accountOps)
  checkAccount(jp: JP<typeof accountOps>): void {
    const account: Account = jp.args[0];
    log.push(`account ${account.id}`);
  }

  @Around(rename)
  upperCase(jp: PJP<typeof rename>): User {
    const [user, name] = jp.args;
    return jp.proceedWith(user, name.toUpperCase());
  }
}

/**
 * Builds interceptor chains the way a weaver does: compiled advisors, a
 * `ClassRef` with the registrations of the class, static matching, ordering.
 * The aspects register in array order.
 */
function chainsOf(
  type: Class,
  module: Class,
  aspects: readonly object[],
): (name: string) => InterceptorChain {
  const instances = new Map(
    aspects.map((aspect) => [aspect.constructor as Class, aspect]),
  );
  const advisors: AdvisorDescriptor[] = [ResilienceAspect, AuditAspect].flatMap(
    (aspectType, registration) =>
      compileAspect(aspectType, {
        registration,
        resolveAspect: (requested) => instances.get(requested),
      }),
  );
  const options: ChainOptions = {
    adviceAdapters: createAdviceAdapterRegistry(),
    returnValues: createReturnValueAdapterRegistry(),
  };
  const classRef = createClassRef(type, {
    beans: [{ token: type, module }],
  });
  return (name) => {
    const method = createMethodRef(classRef, name);
    const matched = advisors.filter(({ pointcut }) =>
      matchesStatically(pointcut, method),
    );
    return buildChain(method, sortAdvisors(matched), options);
  };
}

function adviceOf(chain: InterceptorChain): string[] {
  return chain.links.map(
    ({ advisor }) =>
      `${advisor.source.type.name}.${String(advisor.source.methodName)}`,
  );
}

const chainOf = chainsOf(UserService, UserModule, [
  new ResilienceAspect(),
  new AuditAspect(),
]);

beforeEach(() => {
  log = [];
});

describe("aspects compiled into chains for a service class", () => {
  it("orders the chain by aspect order, advice kind and declaration", () => {
    expect(adviceOf(chainOf("findById"))).toEqual([
      "AuditAspect.enter",
      "AuditAspect.roles",
      "AuditAspect.checkAccount",
      "AuditAspect.leave",
      "ResilienceAspect.retry",
      "ResilienceAspect.cacheUser",
      "ResilienceAspect.onRangeError",
    ]);
    expect(adviceOf(chainOf("rename"))).toEqual([
      "AuditAspect.upperCase",
      "AuditAspect.enter",
      "AuditAspect.audit",
      "AuditAspect.checkAccount",
      "AuditAspect.leave",
    ]);
  });

  it("retries an annotated method until it succeeds within its attempts", async () => {
    const service = new UserService();
    service.failures = [new RangeError("first"), new TypeError("second")];

    const user = await invoke(chainOf("findById"), service, [7]);

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
    const service = new UserService();
    const last = new RangeError("third");
    service.failures = [
      new RangeError("first"),
      new RangeError("second"),
      last,
      new RangeError("never reached"),
    ];

    await expect(invoke(chainOf("findById"), service, [7])).rejects.toBe(last);

    expect(service.calls).toBe(3);
    expect(log.filter((entry) => entry.startsWith("range error"))).toEqual([
      "range error: first",
      "range error: second",
      "range error: third",
    ]);
    expect(log.at(-1)).toBe("leave findById");
    expect(log).not.toContainEqual(expect.stringMatching(/^cache/));
  });

  it("gives advice the typed arguments and annotation value of a synchronous method", () => {
    const service = new UserService();

    const renamed = invoke(chainOf("rename"), service, [
      new User("ann"),
      "bob",
    ]);

    expect(renamed).toEqual(new User("BOB"));
    expect(log).toEqual([
      'enter UserService.rename(User, "BOB")',
      "audit rename",
      "rename BOB",
      "leave rename",
    ]);
  });

  it("runs advice behind a runtime matcher only for the calls it accepts", () => {
    const service = new UserService();
    const chain = chainOf("deposit");

    expect(invoke(chain, service, [new Account("acc-1"), 5])).toBe("acc-1");
    expect(invoke(chain, service, ["acc-2", 6])).toBe("acc-2");

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

  it("leaves lifecycle hooks and classes outside the module without advice", () => {
    class OtherModule {}

    expect(chainOf("onModuleInit").links).toEqual([]);
    expect(adviceOf(chainsOf(UserService, OtherModule, [])("deposit"))).toEqual(
      ["AuditAspect.checkAccount"],
    );
  });

  it("raises AspectNotReadyError while an aspect has no instance", () => {
    const service = new UserService();
    const chain = chainsOf(UserService, UserModule, [])("deposit");

    expect(() => invoke(chain, service, ["acc", 1])).toThrow(
      AspectNotReadyError,
    );
    expect(log).toEqual([]);
  });
});
