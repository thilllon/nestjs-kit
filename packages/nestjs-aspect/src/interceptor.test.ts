import "reflect-metadata";
import { beforeEach, describe, expect, it } from "vitest";
import { named, outcome, weave } from "./aspect-fixture";
import {
  type AdviceDecorator,
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  Before,
} from "./aspect-decorators";
import { AspectNotReadyError, AspectUsageError } from "./errors";
import type {
  AnyShape,
  JoinPoint,
  Pointcut,
  ProceedingJoinPoint,
} from "./types";

class DomainError extends Error {}

class OtherError extends Error {}

let log: string[];

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

class Calculator {
  add(a: number, b: number): number {
    log.push(`add(${a}, ${b})`);
    return a + b;
  }

  fail(): number {
    log.push("fail");
    throw new DomainError("boom");
  }

  async addAsync(a: number, b: number): Promise<number> {
    await tick();
    log.push(`add(${a}, ${b})`);
    return a + b;
  }

  async failAsync(): Promise<number> {
    await tick();
    log.push("fail");
    throw new DomainError("boom");
  }
}

const members = [
  { mode: "synchronous", add: "add", fail: "fail" },
  { mode: "asynchronous", add: "addAsync", fail: "failAsync" },
] as const;

const targets = named("add", "fail", "addAsync", "failAsync");

beforeEach(() => {
  log = [];
});

describe.each(members)("on a $mode join point", ({ mode, add, fail }) => {
  describe("before advice", () => {
    it("runs before the join point", async () => {
      @Aspect()
      class Trace {
        @Before(targets)
        before(joinPoint: JoinPoint<AnyShape>): void {
          log.push(`before ${joinPoint.args.join("+")}`);
        }
      }
      const calculator = weave(new Calculator(), [new Trace()]);

      expect(await calculator[add](1, 2)).toBe(3);
      expect(log).toEqual(["before 1+2", "add(1, 2)"]);
    });

    it("prevents the join point from running when it throws", async () => {
      @Aspect()
      class Guard {
        @Before(targets)
        deny(): void {
          throw new OtherError("denied");
        }
      }
      const calculator = weave(new Calculator(), [new Guard()]);

      const result = await outcome(() => calculator[add](1, 2));

      expect(result).toEqual({ error: new OtherError("denied") });
      expect(log).toEqual([]);
    });
  });

  describe("after advice", () => {
    @Aspect()
    class Trace {
      @After(targets)
      after(): void {
        log.push("after");
      }
    }

    it("runs after a normal completion and keeps the result", async () => {
      const calculator = weave(new Calculator(), [new Trace()]);

      expect(await calculator[add](1, 2)).toBe(3);
      expect(log).toEqual(["add(1, 2)", "after"]);
    });

    it("runs after a failure and keeps the error", async () => {
      const calculator = weave(new Calculator(), [new Trace()]);

      const result = await outcome(() => calculator[fail]());

      expect(result).toEqual({ error: new DomainError("boom") });
      expect(log).toEqual(["fail", "after"]);
    });

    it("replaces the outcome with its own error", async () => {
      @Aspect()
      class Broken {
        @After(targets)
        after(): void {
          throw new OtherError("cleanup failed");
        }
      }
      const calculator = weave(new Calculator(), [new Broken()]);

      expect(await outcome(() => calculator[add](1, 2))).toEqual({
        error: new OtherError("cleanup failed"),
      });
      expect(await outcome(() => calculator[fail]())).toEqual({
        error: new OtherError("cleanup failed"),
      });
    });
  });

  describe("afterReturning advice", () => {
    it("receives the settled value and cannot replace it", async () => {
      const received: unknown[] = [];
      @Aspect()
      class Trace {
        @AfterReturning(targets)
        returned(_jp: JoinPoint<AnyShape>, value: unknown): void {
          received.push(value);
          // biome-ignore lint/correctness/noVoidTypeReturn: the test returns a value that the interceptor must ignore
          return "ignored" as unknown as undefined;
        }
      }
      const calculator = weave(new Calculator(), [new Trace()]);

      expect(await calculator[add](1, 2)).toBe(3);
      expect(received).toEqual([3]);
    });

    it("does not run when the join point fails", async () => {
      @Aspect()
      class Trace {
        @AfterReturning(targets)
        returned(): void {
          log.push("returned");
        }
      }
      const calculator = weave(new Calculator(), [new Trace()]);

      const result = await outcome(() => calculator[fail]());

      expect(result).toEqual({ error: new DomainError("boom") });
      expect(log).toEqual(["fail"]);
    });

    it("replaces the result with its own error", async () => {
      @Aspect()
      class Broken {
        @AfterReturning(targets)
        returned(): void {
          throw new OtherError("rejected");
        }
      }
      const calculator = weave(new Calculator(), [new Broken()]);

      const result = await outcome(() => calculator[add](1, 2));

      expect(result).toEqual({ error: new OtherError("rejected") });
      expect(log).toEqual(["add(1, 2)"]);
    });
  });

  describe("afterThrowing advice", () => {
    it("receives the error of the join point, which still propagates", async () => {
      const received: unknown[] = [];
      @Aspect()
      class Trace {
        @AfterThrowing(targets)
        failed(_jp: JoinPoint<AnyShape>, error: unknown): void {
          received.push(error);
        }
      }
      const calculator = weave(new Calculator(), [new Trace()]);

      const result = await outcome(() => calculator[fail]());

      expect(result).toEqual({ error: new DomainError("boom") });
      expect(received).toEqual([new DomainError("boom")]);
    });

    it("does not run after a normal completion", async () => {
      @Aspect()
      class Trace {
        @AfterThrowing(targets)
        failed(): void {
          log.push("failed");
        }
      }
      const calculator = weave(new Calculator(), [new Trace()]);

      expect(await calculator[add](1, 2)).toBe(3);
      expect(log).toEqual(["add(1, 2)"]);
    });

    it("runs only for errors that are instances of the throwing class", async () => {
      @Aspect()
      class Trace {
        @AfterThrowing(targets, { throwing: DomainError })
        domain(): void {
          log.push("domain");
        }

        @AfterThrowing(targets, { throwing: OtherError })
        other(): void {
          log.push("other");
        }
      }
      const calculator = weave(new Calculator(), [new Trace()]);

      const result = await outcome(() => calculator[fail]());

      expect(result).toEqual({ error: new DomainError("boom") });
      expect(log).toEqual(["fail", "domain"]);
    });

    it("replaces the error with its own error", async () => {
      @Aspect()
      class Translate {
        @AfterThrowing(targets)
        failed(): void {
          throw new OtherError("translated");
        }
      }
      const calculator = weave(new Calculator(), [new Translate()]);

      const result = await outcome(() => calculator[fail]());

      expect(result).toEqual({ error: new OtherError("translated") });
    });

    it("does not see errors thrown by before advice of the same aspect", async () => {
      @Aspect()
      class Mixed {
        @Before(targets)
        deny(): void {
          throw new OtherError("denied");
        }

        @AfterThrowing(targets)
        failed(): void {
          log.push("failed");
        }
      }
      const calculator = weave(new Calculator(), [new Mixed()]);

      const result = await outcome(() => calculator[add](1, 2));

      expect(result).toEqual({ error: new OtherError("denied") });
      expect(log).toEqual([]);
    });
  });

  describe("around advice", () => {
    it("skips the join point when it does not proceed", async () => {
      @Aspect()
      class Cache {
        @Around(targets)
        cached(): unknown {
          return mode === "synchronous" ? 42 : Promise.resolve(42);
        }
      }
      const calculator = weave(new Calculator(), [new Cache()]);

      expect(await calculator[add](1, 2)).toBe(42);
      expect(log).toEqual([]);
    });

    it("replaces the result", async () => {
      @Aspect()
      class Double {
        @Around(targets)
        double(joinPoint: ProceedingJoinPoint<AnyShape>): unknown {
          const result = joinPoint.proceed();
          return result instanceof Promise
            ? result.then((value) => value * 2)
            : (result as number) * 2;
        }
      }
      const calculator = weave(new Calculator(), [new Double()]);

      expect(await calculator[add](1, 2)).toBe(6);
    });

    it("replaces the arguments with proceedWith", async () => {
      const seen: unknown[] = [];
      @Aspect()
      class Rewrite {
        @Around(targets)
        rewrite(joinPoint: ProceedingJoinPoint<AnyShape>): unknown {
          return joinPoint.proceedWith(10, 20);
        }

        @Before(targets)
        inner(joinPoint: JoinPoint<AnyShape>): void {
          seen.push(joinPoint.args);
        }
      }
      const calculator = weave(new Calculator(), [new Rewrite()]);

      expect(await calculator[add](1, 2)).toBe(30);
      expect(seen).toEqual([[10, 20]]);
      expect(log).toEqual(["add(10, 20)"]);
    });

    it("re-runs the inner chain every time it proceeds", async () => {
      @Aspect({ order: 1 })
      class Retry {
        @Around(targets)
        retry(joinPoint: ProceedingJoinPoint<AnyShape>): unknown {
          if (mode === "synchronous") {
            try {
              return joinPoint.proceed();
            } catch {
              return joinPoint.proceed();
            }
          }
          return (joinPoint.proceed() as Promise<unknown>).catch(() =>
            joinPoint.proceed(),
          );
        }
      }
      let attempts = 0;
      @Aspect({ order: 2 })
      class Flaky {
        @Before(targets)
        before(): void {
          log.push("before");
        }

        @AfterReturning(targets)
        returned(): void {
          attempts += 1;
          if (attempts === 1) {
            throw new OtherError("first attempt");
          }
        }
      }
      const calculator = weave(new Calculator(), [new Retry(), new Flaky()]);

      expect(await calculator[add](1, 2)).toBe(3);
      expect(log).toEqual(["before", "add(1, 2)", "before", "add(1, 2)"]);
    });

    it("catches the error of the join point", async () => {
      @Aspect()
      class Fallback {
        @Around(targets)
        async fallback(
          joinPoint: ProceedingJoinPoint<AnyShape>,
        ): Promise<unknown> {
          try {
            return await joinPoint.proceed();
          } catch {
            return -1;
          }
        }
      }
      const calculator = weave(new Calculator(), [new Fallback()]);

      expect(await calculator[fail]()).toBe(-1);
    });
  });

  it("raises AspectNotReadyError before the join point runs while the aspect has no instance", async () => {
    @Aspect()
    class Late {
      @After(targets)
      after(): void {}
    }
    const calculator = weave(new Calculator(), [new Late()], {
      resolveAspect: () => undefined,
    });

    expect(() => calculator[add](1, 2)).toThrow(AspectNotReadyError);
    expect(() => calculator[add](1, 2)).toThrow(/Late/);
    expect(log).toEqual([]);
  });
});

describe("synchronous join points", () => {
  it("return and throw synchronously through every advice kind", () => {
    @Aspect()
    class All {
      @Around(targets)
      around(joinPoint: ProceedingJoinPoint<AnyShape>): unknown {
        return joinPoint.proceed();
      }

      @Before(targets)
      before(): void {}

      @After(targets)
      after(): void {}

      @AfterReturning(targets)
      returned(): void {}

      @AfterThrowing(targets)
      failed(): void {}
    }
    const calculator = weave(new Calculator(), [new All()]);

    expect(calculator.add(1, 2)).toBe(3);
    expect(() => calculator.fail()).toThrow(DomainError);
  });

  const asyncAdvice: [
    string,
    (
      pointcut: Pointcut<AnyShape>,
    ) => AdviceDecorator<AnyShape, () => void | PromiseLike<void>>,
    "add" | "fail",
    string[],
  ][] = [
    ["before", Before, "add", []],
    ["after", After, "add", ["add(1, 2)"]],
    ["afterReturning", AfterReturning, "add", ["add(1, 2)"]],
    ["afterThrowing", AfterThrowing, "fail", ["fail"]],
  ];

  it.each(asyncAdvice)(
    "reject %s advice that returns a promise",
    (_kind, decorator, member, ran) => {
      @Aspect()
      class Slow {
        @decorator(targets)
        async advice(): Promise<void> {}
      }
      const calculator = weave(new Calculator(), [new Slow()]);

      expect(() => calculator[member](1, 2)).toThrow(AspectUsageError);
      expect(log).toEqual(ran);
    },
  );

  it("observe the rejection of a promise that rejected advice returned", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    @Aspect()
    class Slow {
      @Before(targets)
      async advice(): Promise<void> {
        throw new OtherError("late");
      }
    }
    const calculator = weave(new Calculator(), [new Slow()]);

    try {
      expect(() => calculator.add(1, 2)).toThrow(AspectUsageError);
      await new Promise((resolve) => setTimeout(resolve, 5));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });
});

describe("asynchronous join points", () => {
  it("wait for before advice that returns a promise", async () => {
    @Aspect()
    class Slow {
      @Before(targets)
      async before(): Promise<void> {
        await tick();
        log.push("before");
      }
    }
    const calculator = weave(new Calculator(), [new Slow()]);

    expect(await calculator.addAsync(1, 2)).toBe(3);
    expect(log).toEqual(["before", "add(1, 2)"]);
  });

  it("do not run when asynchronous before advice rejects", async () => {
    @Aspect()
    class Guard {
      @Before(targets)
      async deny(): Promise<void> {
        await tick();
        throw new OtherError("denied");
      }
    }
    const calculator = weave(new Calculator(), [new Guard()]);

    await expect(calculator.addAsync(1, 2)).rejects.toThrow(OtherError);
    expect(log).toEqual([]);
  });

  it("deliver an error that before advice throws synchronously as a rejection", async () => {
    @Aspect()
    class Guard {
      @Before(targets)
      deny(): void {
        throw new OtherError("denied");
      }
    }
    const calculator = weave(new Calculator(), [new Guard()]);

    const promise = calculator.addAsync(1, 2);

    await expect(promise).rejects.toThrow(OtherError);
  });

  it("settle only after asynchronous after-returning advice has finished", async () => {
    @Aspect()
    class Slow {
      @AfterReturning(targets)
      async returned(): Promise<void> {
        await tick();
        log.push("returned");
      }
    }
    const calculator = weave(new Calculator(), [new Slow()]);

    expect(await calculator.addAsync(1, 2)).toBe(3);
    expect(log).toEqual(["add(1, 2)", "returned"]);
  });

  it("reject with the error of asynchronous after-returning advice", async () => {
    @Aspect()
    class Strict {
      @AfterReturning(targets)
      async returned(): Promise<void> {
        await tick();
        throw new OtherError("advice failed");
      }
    }
    const calculator = weave(new Calculator(), [new Strict()]);

    await expect(calculator.addAsync(1, 2)).rejects.toThrow("advice failed");
    expect(log).toEqual(["add(1, 2)"]);
  });

  it("settle only after asynchronous after-throwing advice has finished", async () => {
    @Aspect()
    class Slow {
      @AfterThrowing(targets)
      async failed(): Promise<void> {
        await tick();
        log.push("failed");
      }
    }
    const calculator = weave(new Calculator(), [new Slow()]);

    await expect(calculator.failAsync()).rejects.toThrow(DomainError);
    expect(log).toEqual(["fail", "failed"]);
  });

  it.each([
    ["fulfils", "addAsync", "add(1, 2)"],
    ["rejects", "failAsync", "fail"],
  ] as const)(
    "settle only after asynchronous after advice has finished when the join point %s",
    async (_outcome, member, ran) => {
      @Aspect()
      class Slow {
        @After(targets)
        async after(): Promise<void> {
          await tick();
          log.push("after");
        }
      }
      const calculator = weave(new Calculator(), [new Slow()]);

      await outcome(() => calculator[member](1, 2));
      expect(log).toEqual([ran, "after"]);
    },
  );

  it("reject with the error of asynchronous afterThrowing advice", async () => {
    @Aspect()
    class Translate {
      @AfterThrowing(targets, { throwing: DomainError })
      async failed(): Promise<void> {
        await tick();
        throw new OtherError("translated");
      }
    }
    const calculator = weave(new Calculator(), [new Translate()]);

    await expect(calculator.failAsync()).rejects.toThrow("translated");
  });

  it("follow the promise of a method that is not declared asynchronous", async () => {
    class Legacy {
      load(): unknown {
        return tick().then(() => "loaded");
      }
    }
    const received: unknown[] = [];
    @Aspect()
    class Trace {
      @AfterReturning(named("load"))
      async returned(_jp: JoinPoint<AnyShape>, value: unknown): Promise<void> {
        received.push(value);
      }
    }
    const legacy = weave(new Legacy(), [new Trace()]);

    expect(await legacy.load()).toBe("loaded");
    expect(received).toEqual(["loaded"]);
  });
});

describe("a lazy thenable returned by a synchronous method", () => {
  let executed: number;

  class Query {
    where(): this {
      return this;
    }

    // biome-ignore lint/suspicious/noThenProperty: the fixture is a lazy query builder
    then(resolve: (rows: string[]) => unknown): unknown {
      executed++;
      return Promise.resolve(["row"]).then(resolve);
    }
  }

  class Repository {
    build(): Query {
      return new Query();
    }
  }

  const build = named("build");

  it.each([
    ["after", After(build)],
    ["afterReturning", AfterReturning(build)],
    ["afterThrowing", AfterThrowing(build)],
  ] as const)("passes through %s advice untouched", (_kind, decorator) => {
    executed = 0;
    @Aspect()
    class Trace {
      @(decorator as AdviceDecorator<AnyShape, () => void>)
      advice(): void {
        log.push("advice");
      }
    }
    const repository = weave(new Repository(), [new Trace()]);

    const query = repository.build();

    expect(query).toBeInstanceOf(Query);
    expect(query.where()).toBe(query);
    expect(executed).toBe(0);
  });

  it("is followed when the method is declared to return a Promise", async () => {
    function Typed(): MethodDecorator {
      return () => undefined;
    }
    class Declared {
      @Typed()
      find(): Promise<string[]> {
        return new Query() as unknown as Promise<string[]>;
      }
    }
    const received: unknown[] = [];
    @Aspect()
    class Trace {
      @AfterReturning(named("find"))
      returned(_jp: JoinPoint<AnyShape>, rows: unknown): void {
        received.push(rows);
      }
    }
    const declared = weave(new Declared(), [new Trace()]);

    const result = declared.find();

    expect(result).toBeInstanceOf(Promise);
    expect(await result).toEqual(["row"]);
    expect(received).toEqual([["row"]]);
  });
});

describe("a method declared to return a Promise that returns a plain value", () => {
  function Typed(): MethodDecorator {
    return () => undefined;
  }

  class Cache {
    @Typed()
    read(): Promise<number> {
      return 5 as unknown as Promise<number>;
    }
  }

  const read = named("read");

  it.each([
    ["before", Before(read)],
    ["after", After(read)],
    ["afterReturning", AfterReturning(read)],
  ] as const)("waits for asynchronous %s advice", async (kind, decorator) => {
    @Aspect()
    class Slow {
      @(decorator as AdviceDecorator<AnyShape, () => Promise<void>>)
      async advice(): Promise<void> {
        await tick();
        log.push(kind);
      }
    }
    const cache = weave(new Cache(), [new Slow()]);

    const result = cache.read();

    expect(result).toBeInstanceOf(Promise);
    expect(await result).toBe(5);
    expect(log).toEqual([kind]);
  });
});

describe("a promise-returning method that throws synchronously", () => {
  function Typed(): MethodDecorator {
    return () => undefined;
  }

  class Gateway {
    @Typed()
    send(): Promise<string> {
      throw new DomainError("offline");
    }
  }

  it("rejects with its error after asynchronous after-advice", async () => {
    @Aspect()
    class Slow {
      @After(named("send"))
      async after(): Promise<void> {
        await tick();
        log.push("after");
      }

      @AfterThrowing(named("send"))
      async failed(): Promise<void> {
        await tick();
        log.push("failed");
      }
    }
    const gateway = weave(new Gateway(), [new Slow()]);

    await expect(gateway.send()).rejects.toThrow(DomainError);
    expect(log).toEqual(["failed", "after"]);
  });
});

describe("advice invocation", () => {
  it("calls the advice method on the aspect instance and advises self-invocation", () => {
    class Greeter {
      greet(name: string): string {
        return `${this.prefix()} ${name}`;
      }

      prefix(): string {
        return "hello";
      }
    }
    @Aspect()
    class Counter {
      calls = 0;

      @Before(named("greet", "prefix"))
      count(): void {
        this.calls += 1;
      }
    }
    const counter = new Counter();
    const greeter = weave(new Greeter(), [counter]);

    expect(greeter.greet("nest")).toBe("hello nest");
    expect(counter.calls).toBe(2);
  });
});
