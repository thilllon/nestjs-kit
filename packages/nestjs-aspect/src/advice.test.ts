import "reflect-metadata";
import { describe, expect, it } from "vitest";
import {
  ADVICE_KINDS,
  aspectAdviceAdapter,
  createAdviceAdapterRegistry,
  createReturnValueAdapterRegistry,
  isAspectAdvice,
  isMethodInterceptor,
  methodInterceptorAdapter,
  promiseAdapter,
} from "./advice";
import { AfterReturning, Aspect, Before } from "./aspect-decorators";
import { named, outcome, weave } from "./aspect-fixture";
import { AopConfigurationError, AopUsageError } from "./errors";
import type {
  AdviceAdapter,
  AnyShape,
  AspectAdvice,
  InterceptorContext,
  JoinPoint,
  MethodInterceptor,
  PointcutAdvisor,
  ReturnValueAdapter,
} from "./types";

const context: InterceptorContext = {
  returnValues: createReturnValueAdapterRegistry(),
};

const passThrough: MethodInterceptor = {
  invoke: (invocation) => invocation.proceed(),
};

describe("advice guards", () => {
  it("recognize a method interceptor by its invoke function", () => {
    expect(isMethodInterceptor(passThrough)).toBe(true);
    expect(isMethodInterceptor({ invoke: "no" })).toBe(false);
    expect(isMethodInterceptor(null)).toBe(false);
  });

  it("recognize advice compiled from an aspect", () => {
    class Some {}
    const advice: AspectAdvice = {
      kind: "before",
      aspectType: Some,
      methodName: "check",
      resolveAspect: () => undefined,
    };

    expect(isAspectAdvice(advice)).toBe(true);
    expect(isAspectAdvice({ ...advice, kind: "sideways" })).toBe(false);
    expect(isAspectAdvice(passThrough)).toBe(false);
    expect(isAspectAdvice(undefined)).toBe(false);
  });
});

describe("promiseAdapter", () => {
  it("supports thenables only", () => {
    // biome-ignore lint/suspicious/noThenProperty: the test needs a thenable that is not a Promise
    const thenable = { then: () => undefined };

    expect(promiseAdapter.supports(Promise.resolve(1))).toBe(true);
    expect(promiseAdapter.supports(thenable)).toBe(true);
    expect(promiseAdapter.supports({ catch: () => undefined })).toBe(false);
    expect(promiseAdapter.supports(1)).toBe(false);
    expect(promiseAdapter.supports(null)).toBe(false);
  });

  it("onSuccess waits for the callback and keeps the resolved value", async () => {
    const order: string[] = [];

    const result = promiseAdapter.onSuccess(
      Promise.resolve("value"),
      async (resolved) => {
        await Promise.resolve();
        order.push(`callback ${String(resolved)}`);
        return "replacement";
      },
    );

    expect(await result).toBe("value");
    expect(order).toEqual(["callback value"]);
  });

  it("onSuccess rejects with the error of the callback and skips it on rejection", async () => {
    const failing = promiseAdapter.onSuccess(Promise.resolve(1), () => {
      throw new Error("callback");
    });
    let called = false;
    const rejected = promiseAdapter.onSuccess(
      Promise.reject(new Error("original")),
      () => {
        called = true;
      },
    );

    await expect(failing).rejects.toThrow("callback");
    await expect(rejected).rejects.toThrow("original");
    expect(called).toBe(false);
  });

  it("onError rejects with what the callback throws and keeps a resolved value", async () => {
    const translated = promiseAdapter.onError(
      Promise.reject(new Error("original")),
      async (error) => {
        throw new Error(`translated ${(error as Error).message}`);
      },
    );
    const kept = promiseAdapter.onError(
      Promise.reject(new Error("original")),
      () => undefined,
    );
    const resolved = promiseAdapter.onError(Promise.resolve(1), () => {
      throw new Error("unreachable");
    });

    await expect(translated).rejects.toThrow("translated original");
    await expect(kept).rejects.toThrow("original");
    expect(await resolved).toBe(1);
  });

  it("finally waits for the callback and keeps the outcome", async () => {
    const order: string[] = [];
    const callback = async () => {
      await Promise.resolve();
      order.push("callback");
    };

    expect(await promiseAdapter.finally(Promise.resolve(1), callback)).toBe(1);
    await expect(
      promiseAdapter.finally(Promise.reject(new Error("original")), callback),
    ).rejects.toThrow("original");
    expect(order).toEqual(["callback", "callback"]);
  });

  it("finally rejects with the error of the callback", async () => {
    const result = promiseAdapter.finally(Promise.resolve(1), () => {
      throw new Error("callback");
    });

    await expect(result).rejects.toThrow("callback");
  });
});

/** A lazy result type that is not a thenable. */
class Task<T> {
  constructor(readonly run: () => T) {}
}

const taskAdapter: ReturnValueAdapter<Task<unknown>> = {
  supports: (value): value is Task<unknown> => value instanceof Task,
  onSuccess: (task, cb) =>
    new Task(() => {
      const value = task.run();
      cb(value);
      return value;
    }),
  onError: (task, cb) =>
    new Task(() => {
      try {
        return task.run();
      } catch (error) {
        cb(error);
        throw error;
      }
    }),
  finally: (task, cb) =>
    new Task(() => {
      try {
        return task.run();
      } finally {
        cb();
      }
    }),
};

describe("return value adapter registry", () => {
  it("finds the Promise adapter by default and nothing for plain values", () => {
    const registry = createReturnValueAdapterRegistry();

    expect(registry.find(Promise.resolve())).toBe(promiseAdapter);
    expect(registry.find(1)).toBeUndefined();
  });

  it("returns the first registered adapter that supports the value", () => {
    const everything: ReturnValueAdapter = {
      ...promiseAdapter,
      supports: (value): value is unknown => true,
    };
    const registry = createReturnValueAdapterRegistry([
      taskAdapter,
      everything,
      promiseAdapter,
    ]);

    expect(registry.find(new Task(() => 1))).toBe(taskAdapter);
    expect(registry.find(Promise.resolve())).toBe(everything);
  });

  it("lets advice follow the settlement of a custom result type", () => {
    class Jobs {
      schedule(value: number): Task<number> {
        return new Task(() => value * 2);
      }
    }
    const received: unknown[] = [];

    @Aspect()
    class Trace {
      @AfterReturning(named("schedule"))
      returned(_jp: JoinPoint<AnyShape>, value: unknown): void {
        received.push(value);
      }
    }
    const jobs = weave(new Jobs(), [new Trace()], {
      returnValueAdapters: [taskAdapter, promiseAdapter],
    });

    const task = jobs.schedule(21);

    expect(received).toEqual([]);
    expect(task.run()).toBe(42);
    expect(received).toEqual([42]);
  });

  it("treats a result without an adapter as synchronous", async () => {
    class Jobs {
      load(): Promise<number> {
        return Promise.resolve(1);
      }
    }
    @Aspect()
    class Trace {
      @AfterReturning(named("load"))
      async returned(): Promise<void> {}
    }
    const jobs = weave(new Jobs(), [new Trace()], { returnValueAdapters: [] });

    const result = await outcome(() => jobs.load());

    expect(result).toEqual({ error: expect.any(AopUsageError) });
  });
});

describe("advice adapter registry", () => {
  it("passes a method interceptor through unchanged", () => {
    const registry = createAdviceAdapterRegistry();

    expect(registry.toInterceptor(passThrough, context)).toBe(passThrough);
    expect(methodInterceptorAdapter.supports(passThrough)).toBe(true);
    expect(aspectAdviceAdapter.supports(passThrough)).toBe(false);
  });

  it("rejects advice that no adapter supports", () => {
    const registry = createAdviceAdapterRegistry();

    expect(() => registry.toInterceptor({ unknown: true }, context)).toThrow(
      AopConfigurationError,
    );
  });

  it("converts a custom advice kind through a registered adapter", () => {
    interface CountingAdvice {
      count: number;
    }
    const countingAdapter: AdviceAdapter = {
      supports: (advice) => "count" in advice,
      toInterceptor: (advice) => ({
        invoke(invocation) {
          (advice as CountingAdvice).count += 1;
          return invocation.proceed();
        },
      }),
    };
    class Service {
      run(): string {
        return "ran";
      }
    }
    const counting: CountingAdvice = { count: 0 };
    const advisor: PointcutAdvisor = {
      pointcut: named("run"),
      advice: counting,
    };
    const service = weave(new Service(), [], {
      advisors: [advisor],
      adviceAdapters: [countingAdapter],
    });

    expect(service.run()).toBe("ran");
    expect(service.run()).toBe("ran");
    expect(counting.count).toBe(2);
  });

  it("consults registered adapters before the built-in ones", () => {
    const calls: string[] = [];
    const override: AdviceAdapter = {
      supports: (advice) => isAspectAdvice(advice),
      toInterceptor: (advice, received) => {
        expect(received.returnValues).toBeDefined();
        return {
          invoke(invocation) {
            calls.push((advice as AspectAdvice).kind);
            return invocation.proceed();
          },
        };
      },
    };
    class Service {
      run(): string {
        return "ran";
      }
    }
    @Aspect()
    class Trace {
      @Before(named("run"))
      before(): void {
        calls.push("advice method");
      }
    }
    const service = weave(new Service(), [new Trace()], {
      adviceAdapters: [override],
    });

    expect(service.run()).toBe("ran");
    expect(calls).toEqual(["before"]);
  });
});

describe("ADVICE_KINDS", () => {
  it("lists the kinds in their order within one aspect", () => {
    expect(ADVICE_KINDS).toEqual([
      "around",
      "before",
      "after",
      "afterReturning",
      "afterThrowing",
    ]);
  });
});
