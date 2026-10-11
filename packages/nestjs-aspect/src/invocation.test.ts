import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createAdviceAdapterRegistry,
  createReturnValueAdapterRegistry,
} from "./advice";
import { describeAdvisor } from "./aspect-compiler";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { matching, named, weave } from "./aspect-fixture";
import { AspectConfigurationError } from "./errors";
import { buildChain, Invocation, invoke } from "./invocation";
import { createClassRef, createMethodRef } from "./method-ref";
import type {
  AnyShape,
  ChainOptions,
  JoinPoint,
  MethodInterceptor,
  MethodInvocation,
  PointcutAdvisor,
  ProceedingJoinPoint,
} from "./types";

let log: string[];

class Service {
  run(value: string): string {
    log.push(`run ${value}`);
    return value;
  }

  fail(): never {
    log.push("fail");
    throw new Error("boom");
  }

  async runAsync(value: string): Promise<string> {
    await Promise.resolve();
    log.push(`run ${value}`);
    return value;
  }
}

const targets = named("run", "fail", "runAsync");

/** An aspect with one advice of every kind, logging under `label`. */
function tracingAspect(label: string, order?: number): object {
  @Aspect({ order })
  class Tracing {
    @AfterThrowing(targets)
    failed(): void {
      log.push(`${label} afterThrowing`);
    }

    @AfterReturning(targets)
    returned(): void {
      log.push(`${label} afterReturning`);
    }

    @After(targets)
    after(): void {
      log.push(`${label} after`);
    }

    @Before(targets)
    before(): void {
      log.push(`${label} before`);
    }

    @Around(targets)
    around(jp: ProceedingJoinPoint<AnyShape>): unknown {
      log.push(`${label} around in`);
      const done = () => log.push(`${label} around out`);
      try {
        const result = jp.proceed();
        if (result instanceof Promise) {
          return result.finally(done);
        }
        done();
        return result;
      } catch (error) {
        done();
        throw error;
      }
    }
  }
  return new Tracing();
}

function recordingAdvisor(label: string, order?: number): PointcutAdvisor {
  const advice: MethodInterceptor = {
    invoke(invocation) {
      log.push(`${label} in`);
      const result = invocation.proceed();
      log.push(`${label} out`);
      return result;
    },
  };
  return { pointcut: targets, advice, order };
}

const chainOptions: ChainOptions = {
  adviceAdapters: createAdviceAdapterRegistry(),
  returnValues: createReturnValueAdapterRegistry(),
};

beforeEach(() => {
  log = [];
});

describe("chain order", () => {
  it("runs the advice of one aspect as around, before, join point, afterReturning, after", () => {
    const service = weave(new Service(), [tracingAspect("a")]);

    service.run("x");

    expect(log).toEqual([
      "a around in",
      "a before",
      "run x",
      "a afterReturning",
      "a after",
      "a around out",
    ]);
  });

  it("runs afterThrowing before after when the join point fails", () => {
    const service = weave(new Service(), [tracingAspect("a")]);

    expect(() => service.fail()).toThrow("boom");

    expect(log).toEqual([
      "a around in",
      "a before",
      "fail",
      "a afterThrowing",
      "a after",
      "a around out",
    ]);
  });

  it("keeps the same order on an asynchronous join point", async () => {
    const service = weave(new Service(), [tracingAspect("a")]);

    await service.runAsync("x");

    expect(log).toEqual([
      "a around in",
      "a before",
      "run x",
      "a afterReturning",
      "a after",
      "a around out",
    ]);
  });

  it("nests aspects by order: the lowest order enters first and leaves last", async () => {
    const service = weave(new Service(), [
      tracingAspect("inner", 20),
      tracingAspect("outer", 10),
    ]);
    const expected = [
      "outer around in",
      "outer before",
      "inner around in",
      "inner before",
      "run x",
      "inner afterReturning",
      "inner after",
      "inner around out",
      "outer afterReturning",
      "outer after",
      "outer around out",
    ];

    service.run("x");
    expect(log).toEqual(expected);

    log = [];
    await service.runAsync("x");
    expect(log).toEqual(expected);
  });

  it("gives an aspect without an order the lowest precedence", () => {
    const service = weave(new Service(), [
      tracingAspect("unordered"),
      tracingAspect("ordered", 1000),
    ]);

    service.run("x");

    expect(log.slice(0, 3)).toEqual([
      "ordered around in",
      "ordered before",
      "unordered around in",
    ]);
  });

  it("runs advice of the same kind in declaration order", () => {
    @Aspect()
    class Steps {
      @Before(targets)
      first(): void {
        log.push("first");
      }

      @After(targets)
      cleanup(): void {
        log.push("cleanup");
      }

      @Before(targets)
      second(): void {
        log.push("second");
      }

      @Before(targets)
      third(): void {
        log.push("third");
      }
    }
    const service = weave(new Service(), [new Steps()]);

    service.run("x");

    expect(log).toEqual(["first", "second", "third", "run x", "cleanup"]);
  });

  it("orders low-level advisors together with aspects", () => {
    const service = weave(new Service(), [tracingAspect("aspect", 20)], {
      advisors: [recordingAdvisor("late", 30), recordingAdvisor("early", 10)],
    });

    service.run("x");

    expect(log).toEqual([
      "early in",
      "aspect around in",
      "aspect before",
      "late in",
      "run x",
      "late out",
      "aspect afterReturning",
      "aspect after",
      "aspect around out",
      "early out",
    ]);
  });
});

describe("runtime matchers", () => {
  it("skip the advice on the calls whose arguments they reject", () => {
    const longValues = matching(
      (method) => method.name === "run",
      (_method, args) => String(args[0]).length > 3,
    );
    @Aspect()
    class Trace {
      @Before(longValues)
      before(): void {
        log.push("before");
      }

      @After(targets)
      after(): void {
        log.push("after");
      }
    }
    const service = weave(new Service(), [new Trace()]);

    service.run("ab");
    service.run("abcdef");
    service.run("cd");

    expect(log).toEqual([
      "run ab",
      "after",
      "before",
      "run abcdef",
      "after",
      "run cd",
      "after",
    ]);
  });

  it("skip the advice when the matcher returns a falsy value that is no boolean", () => {
    @Aspect()
    class Trace {
      @Before(
        matching(
          () => true,
          () => 0 as unknown as boolean,
        ),
      )
      before(): void {
        log.push("before");
      }
    }
    const service = weave(new Service(), [new Trace()]);

    service.run("ab");

    expect(log).toEqual(["run ab"]);
  });

  it("see the arguments that around advice replaced", () => {
    const longValues = matching(
      (method) => method.name === "run",
      (_method, args) => String(args[0]).length > 3,
    );
    @Aspect()
    class Trace {
      @Around(targets)
      around(jp: ProceedingJoinPoint<AnyShape>): unknown {
        return jp.proceedWith("replaced");
      }

      @Before(longValues)
      before(): void {
        log.push("before");
      }
    }
    const service = weave(new Service(), [new Trace()]);

    expect(service.run("ab")).toBe("replaced");
    expect(log).toEqual(["before", "run replaced"]);
  });
});

describe("arguments", () => {
  it("are read-only, so every proceed starts from the arguments it was given", () => {
    const seen: unknown[] = [];
    @Aspect()
    class Retry {
      @Around(targets)
      around(jp: ProceedingJoinPoint<AnyShape>): unknown {
        const results = [jp.proceed(), jp.proceed()];
        seen.push(jp.args[0]);
        return results;
      }

      @Before(targets)
      before(jp: JoinPoint<AnyShape>): void {
        expect(() => {
          (jp.args as unknown[])[0] = "mutated";
        }).toThrow(TypeError);
      }
    }
    const service = weave(new Service(), [new Retry()]);

    expect(service.run("ab")).toEqual(["ab", "ab"]);
    expect(seen).toEqual(["ab"]);
  });

  it("are a copy of the array the caller passed", () => {
    const passed = ["ab"];
    const invocation = new Invocation(
      { method: createMethodRef(createClassRef(Service), "run"), links: [] },
      new Service(),
      passed,
    );
    passed[0] = "changed";

    expect(invocation.proceed()).toBe("ab");
  });
});

describe("buildChain", () => {
  const method = createMethodRef(createClassRef(Service), "run");

  it("rejects a runtime matcher without matchesRuntime", () => {
    const broken = {
      classFilter: { matches: () => true },
      methodMatcher: { matches: () => true, isRuntime: true },
    };
    const advisor = describeAdvisor(
      { ...recordingAdvisor("a"), pointcut: broken },
      Object,
      0,
    );

    expect(() => buildChain(method, [advisor], chainOptions)).toThrow(
      AspectConfigurationError,
    );
  });
});

describe("Invocation", () => {
  const method = createMethodRef(createClassRef(Service), "run");

  it("calls the original function with the target as this when the chain is empty", () => {
    const chain = buildChain(method, [], chainOptions);

    expect(invoke(chain, new Service(), ["x"])).toBe("x");
    expect(log).toEqual(["run x"]);
  });

  it("gives every interceptor the target, the arguments and one join point", () => {
    const seen: MethodInvocation[] = [];
    const capture: MethodInterceptor = {
      invoke(invocation) {
        seen.push(invocation);
        return invocation.proceed();
      },
    };
    const advisor = describeAdvisor(
      { pointcut: targets, advice: capture },
      Object,
      0,
    );
    const chain = buildChain(method, [advisor, advisor], chainOptions);
    const target = new Service();

    invoke(chain, target, ["x"]);

    expect(seen).toHaveLength(2);
    expect(seen[0].target).toBe(target);
    expect(seen[0].args).toEqual(["x"]);
    expect(seen[0].method).toBe(method);
    expect(seen[1].joinPoint).toBe(seen[0].joinPoint);
  });

  it("clones from the current position, so an interceptor can proceed again", () => {
    const twice: MethodInterceptor = {
      invoke(invocation) {
        invocation.cloneFromHere().proceed();
        return invocation.cloneFromHere(["second"]).proceed();
      },
    };
    const advisors = [
      describeAdvisor(recordingAdvisor("outer"), Object, 0),
      describeAdvisor({ pointcut: targets, advice: twice }, Object, 1),
      describeAdvisor(recordingAdvisor("inner"), Object, 2),
    ];
    const invocation = new Invocation(
      buildChain(method, advisors, chainOptions),
      new Service(),
      ["first"],
    );

    expect(invocation.proceed()).toBe("second");
    expect(log).toEqual([
      "outer in",
      "inner in",
      "run first",
      "inner out",
      "inner in",
      "run second",
      "inner out",
      "outer out",
    ]);
  });
});
