import "reflect-metadata";
import { Injectable } from "@nestjs/common";
import { afterEach, describe, expect, it } from "vitest";
import { Advisor } from "./aspect-decorators";
import { AspectConfigurationError } from "./errors";
import { Pointcut as P } from "./pointcut-designators";
import type { AdviceAdapter } from "./types";
import { closeWoven, initWoven } from "./weaving-fixture";

afterEach(closeWoven);

/** An advice kind of its own: the value a failing join point falls back to. */
class Fallback {
  constructor(readonly value: unknown) {}
}

/** Follows asynchronous results with the adapters of the application. */
const fallbackAdapter: AdviceAdapter = {
  supports: (advice) => advice instanceof Fallback,
  toInterceptor: (advice, context) => ({
    invoke(invocation) {
      const { value } = advice as Fallback;
      try {
        const result = invocation.proceed();
        const adapter = context.returnValues.find(result);
        return adapter ? Promise.resolve(result).catch(() => value) : result;
      } catch {
        return value;
      }
    },
  }),
};

function quotes() {
  @Injectable()
  class Quotes {
    latest(symbol: string): number {
      if (symbol === "DOWN") {
        throw new Error("feed is down");
      }
      return 42;
    }

    async history(symbol: string): Promise<number[]> {
      if (symbol === "DOWN") {
        throw new Error("feed is down");
      }
      return [41, 42];
    }
  }

  @Advisor()
  class LatestFallback {
    static readonly pointcut = P.method(Quotes, "latest");

    readonly advice = new Fallback(0);
  }

  @Advisor()
  class HistoryFallback {
    static readonly pointcut = P.method(Quotes, "history");

    readonly advice = new Fallback([]);
  }
  return { Quotes, providers: [Quotes, LatestFallback, HistoryFallback] };
}

describe("advice adapters", () => {
  it("runs an advice kind that a registered adapter converts", async () => {
    const { Quotes, providers } = quotes();
    const { moduleRef } = await initWoven(
      { providers },
      { adviceAdapters: [fallbackAdapter] },
    );
    const service = moduleRef.get(Quotes);
    expect(service.latest("UP")).toBe(42);
    expect(service.latest("DOWN")).toBe(0);
    await expect(service.history("UP")).resolves.toEqual([41, 42]);
    await expect(service.history("DOWN")).resolves.toEqual([]);
  });

  it("rejects the call of a member whose advice no adapter converts", async () => {
    const { Quotes, providers } = quotes();
    const { moduleRef } = await initWoven({ providers });
    expect(() => moduleRef.get(Quotes).latest("UP")).toThrow(
      AspectConfigurationError,
    );
    expect(() => moduleRef.get(Quotes).latest("UP")).toThrow(
      "No advice adapter supports the advice",
    );
  });
});
