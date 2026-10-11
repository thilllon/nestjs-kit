import "reflect-metadata";
import { Controller, Get, Injectable } from "@nestjs/common";
import {
  concat,
  defer,
  firstValueFrom,
  lastValueFrom,
  map,
  NEVER,
  Observable,
  of,
  retry,
  Subject,
  take,
  throwError,
  toArray,
} from "rxjs";
import { afterEach, describe, expect, it } from "vitest";
import { promiseAdapter } from "./advice";
import {
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
} from "./aspect-decorators";
import { P } from "./pointcut-designators";
import { observableAdapter } from "./rxjs";
import type { AnyShape, JoinPoint, JP, PJP } from "./types";
import { closeWoven, initWoven, listenWoven } from "./weaving-fixture";

afterEach(closeWoven);

const adapters = { returnValueAdapters: [promiseAdapter, observableAdapter] };

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class QuotaError extends Error {}

/** A service whose streams record every subscription and teardown. */
function fixture() {
  const log: string[] = [];

  @Injectable()
  class PriceService {
    subscriptions = 0;

    /** Errors the next subscriptions of `flaky` fail with, one each. */
    failures: Error[] = [];

    readonly ticks = new Subject<number>();

    quotes(symbol: string): Observable<string> {
      log.push(`call ${symbol}`);
      return new Observable<string>((subscriber) => {
        this.subscriptions += 1;
        log.push(`subscribe ${symbol}`);
        subscriber.next(`${symbol}:1`);
        subscriber.next(`${symbol}:2`);
        subscriber.complete();
        return () => log.push(`teardown ${symbol}`);
      });
    }

    empty(): Observable<never> {
      return new Observable((subscriber) => subscriber.complete());
    }

    failing(error: Error): Observable<string> {
      return concat(
        of("partial"),
        throwError(() => error),
      );
    }

    flaky(): Observable<string> {
      return defer(() => {
        this.subscriptions += 1;
        const failure = this.failures.shift();
        return failure ? throwError(() => failure) : of("stable");
      });
    }

    live(): Observable<number> {
      return new Observable<number>((subscriber) => {
        const subscription = this.ticks.subscribe(subscriber);
        return () => {
          log.push("teardown live");
          subscription.unsubscribe();
        };
      });
    }

    async balance(): Promise<number> {
      return 7;
    }
  }

  return { log, PriceService };
}

describe("observableAdapter with after-returning advice", () => {
  it("delivers the last emitted value once the stream completes, after every emission reached the subscriber", async () => {
    const { log, PriceService } = fixture();
    const quotes = P.method(PriceService, "quotes");

    @Aspect()
    class AuditAspect {
      @AfterReturning(quotes)
      record(jp: JP<typeof quotes>, value: unknown) {
        log.push(`returned ${jp.args[0]} ${String(value)}`);
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    const stream = moduleRef.get(PriceService).quotes("A");
    stream.subscribe({
      next: (value) => log.push(`next ${value}`),
      complete: () => log.push("complete"),
    });

    expect(log).toEqual([
      "call A",
      "subscribe A",
      "next A:1",
      "next A:2",
      "returned A A:2",
      "complete",
      "teardown A",
    ]);
  });

  it("neither subscribes to a cold stream nor runs for a call whose result is never subscribed", async () => {
    const { log, PriceService } = fixture();

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.within(PriceService))
      record() {
        log.push("returned");
      }

      @After(P.within(PriceService))
      settle() {
        log.push("after");
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    service.quotes("A");
    await sleep(5);

    expect(service.subscriptions).toBe(0);
    expect(log).toEqual(["call A"]);
  });

  it("subscribes to the source once per subscriber and runs the advice for each subscription", async () => {
    const { log, PriceService } = fixture();
    const returned: unknown[] = [];

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.within(PriceService))
      record(_jp: unknown, value: unknown) {
        returned.push(value);
      }

      @After(P.within(PriceService))
      settle() {
        log.push("after");
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    const stream = service.quotes("A");

    expect(await lastValueFrom(stream.pipe(toArray()))).toEqual(["A:1", "A:2"]);
    expect(service.subscriptions).toBe(1);
    expect(await lastValueFrom(stream)).toBe("A:2");
    expect(service.subscriptions).toBe(2);
    expect(returned).toEqual(["A:2", "A:2"]);
    expect(log.filter((entry) => entry === "after")).toHaveLength(2);
  });

  it("passes undefined for a stream that completes without a value", async () => {
    const { PriceService } = fixture();
    const returned: unknown[] = [];

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.method(PriceService, "empty"))
      record(_jp: unknown, value: unknown) {
        returned.push(value);
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    await lastValueFrom(moduleRef.get(PriceService).empty(), {
      defaultValue: "none",
    });

    expect(returned).toEqual([undefined]);
  });

  it("holds the completion until asynchronous advice settles", async () => {
    const { log, PriceService } = fixture();

    @Aspect()
    class AuditAspect {
      // The typed pointcut carries the Observable return type, for which
      // the decorators accept asynchronous advice.
      @AfterReturning(P.method(PriceService, "quotes"))
      async record() {
        await sleep(5);
        log.push("stored");
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    const completed = new Promise<void>((resolve) => {
      moduleRef
        .get(PriceService)
        .quotes("A")
        .subscribe({
          next: (value) => log.push(`next ${value}`),
          complete: () => {
            log.push("complete");
            resolve();
          },
        });
    });
    expect(log).not.toContain("complete");
    await completed;

    expect(log.slice(2)).toEqual([
      "next A:1",
      "next A:2",
      "teardown A",
      "stored",
      "complete",
    ]);
  });

  it("turns an error of the advice into the error notification of the stream", async () => {
    const { PriceService } = fixture();
    const failure = new Error("audit store is down");

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.method(PriceService, "quotes"))
      record() {
        throw failure;
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    const received: string[] = [];
    const error = await new Promise((resolve) => {
      moduleRef
        .get(PriceService)
        .quotes("A")
        .subscribe({ next: (value) => received.push(value), error: resolve });
    });

    expect(received).toEqual(["A:1", "A:2"]);
    expect(error).toBe(failure);
  });

  it("does not run for a stream that fails or that the subscriber leaves early", async () => {
    const { PriceService } = fixture();
    const returned: unknown[] = [];

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.within(PriceService))
      record(_jp: unknown, value: unknown) {
        returned.push(value);
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    await expect(
      lastValueFrom(service.failing(new Error("x"))),
    ).rejects.toThrow("x");
    expect(await firstValueFrom(service.quotes("A"))).toBe("A:1");

    expect(returned).toEqual([]);
  });
});

describe("observableAdapter with after-throwing advice", () => {
  it("runs on the error notification and propagates the same error", async () => {
    const { log, PriceService } = fixture();
    const failing = P.method(PriceService, "failing");

    @Aspect()
    class AlertAspect {
      @AfterThrowing(failing)
      alert(_jp: JP<typeof failing>, error: unknown) {
        log.push(`alert ${(error as Error).message}`);
      }

      @AfterThrowing(failing, { throwing: QuotaError })
      throttle(_jp: JP<typeof failing>, error: QuotaError) {
        log.push(`quota ${error.message}`);
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AlertAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    const plain = new Error("feed closed");
    const stream = service.failing(plain);
    expect(log).toEqual([]);

    const received: string[] = [];
    const error = await new Promise((resolve) => {
      stream.subscribe({
        next: (value) => received.push(value),
        error: resolve,
      });
    });
    expect(error).toBe(plain);
    expect(received).toEqual(["partial"]);
    expect(log).toEqual(["alert feed closed"]);

    await expect(
      lastValueFrom(service.failing(new QuotaError("limit"))),
    ).rejects.toBeInstanceOf(QuotaError);
    expect(log.slice(1).sort()).toEqual(["alert limit", "quota limit"]);
  });

  it("waits for asynchronous advice and replaces the error with the one the advice throws", async () => {
    const { log, PriceService } = fixture();
    const replacement = new Error("translated");

    @Aspect()
    class AlertAspect {
      @AfterThrowing(P.within(PriceService).and(P.name("failing")))
      async alert(_jp: unknown, error: unknown) {
        const { message } = error as Error;
        await sleep(5);
        log.push(`alert ${message}`);
        if (message === "translate me") {
          throw replacement;
        }
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AlertAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    const original = new Error("keep me");

    await expect(lastValueFrom(service.failing(original))).rejects.toBe(
      original,
    );
    expect(log).toEqual(["alert keep me"]);
    await expect(
      lastValueFrom(service.failing(new Error("translate me"))),
    ).rejects.toBe(replacement);
  });

  it("does not run for a stream that completes", async () => {
    const { log, PriceService } = fixture();

    @Aspect()
    class AlertAspect {
      @AfterThrowing(P.within(PriceService))
      alert() {
        log.push("alert");
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AlertAspect] },
      adapters,
    );
    await lastValueFrom(moduleRef.get(PriceService).quotes("A"));

    expect(log).not.toContain("alert");
  });
});

describe("observableAdapter with after advice", () => {
  function auditing(PriceService: ReturnType<typeof fixture>["PriceService"]) {
    const runs: string[] = [];

    @Aspect()
    class ReleaseAspect {
      @After(P.within(PriceService))
      release(jp: JoinPoint<AnyShape>) {
        runs.push(String(jp.signature.name));
      }
    }

    return { runs, ReleaseAspect };
  }

  it("runs once when the stream completes and once when it fails", async () => {
    const { PriceService } = fixture();
    const { runs, ReleaseAspect } = auditing(PriceService);
    const { moduleRef } = await initWoven(
      { providers: [PriceService, ReleaseAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);

    const completing = service.quotes("A");
    const failing = service.failing(new Error("x"));
    expect(runs).toEqual([]);
    await lastValueFrom(completing);
    expect(runs).toEqual(["quotes"]);
    await expect(lastValueFrom(failing)).rejects.toThrow("x");
    expect(runs).toEqual(["quotes", "failing"]);
  });

  it("runs when the subscriber unsubscribes from a stream that is still open, after the source is torn down", async () => {
    const { log, PriceService } = fixture();
    const { runs, ReleaseAspect } = auditing(PriceService);
    const { moduleRef } = await initWoven(
      { providers: [PriceService, ReleaseAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    const received: number[] = [];
    const subscription = service
      .live()
      .subscribe((value) => received.push(value));
    service.ticks.next(1);
    expect(runs).toEqual([]);

    subscription.unsubscribe();
    service.ticks.next(2);
    subscription.unsubscribe();

    expect(received).toEqual([1]);
    expect(log).toEqual(["teardown live"]);
    expect(runs).toEqual(["live"]);
    expect(service.ticks.observed).toBe(false);
  });

  it("runs once when an operator of the subscriber ends the subscription", async () => {
    const { PriceService } = fixture();
    const { runs, ReleaseAspect } = auditing(PriceService);
    const { moduleRef } = await initWoven(
      { providers: [PriceService, ReleaseAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    const first = firstValueFrom(service.live().pipe(take(1)));
    service.ticks.next(4);

    expect(await first).toBe(4);
    expect(runs).toEqual(["live"]);

    // The source emits and completes synchronously, after take(1) left.
    expect(await firstValueFrom(service.quotes("A"))).toBe("A:1");
    expect(runs).toEqual(["live", "quotes"]);
  });

  it("replaces the completion with the error the advice throws", async () => {
    const { PriceService } = fixture();
    const failure = new Error("release failed");

    @Aspect()
    class ReleaseAspect {
      @After(P.method(PriceService, "quotes"))
      release() {
        throw failure;
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, ReleaseAspect] },
      adapters,
    );

    await expect(
      lastValueFrom(moduleRef.get(PriceService).quotes("A")),
    ).rejects.toBe(failure);
  });
});

describe("around advice on a method that returns an Observable", () => {
  it("transforms and resubscribes the stream it proceeds to, inside the other advice of the join point", async () => {
    const { PriceService } = fixture();
    const flaky = P.method(PriceService, "flaky");
    const log: string[] = [];

    @Aspect({ order: 1 })
    class AuditAspect {
      @AfterReturning(flaky)
      record(_jp: JP<typeof flaky>, value: unknown) {
        log.push(`returned ${String(value)}`);
      }

      @AfterThrowing(flaky)
      alert(_jp: JP<typeof flaky>, error: unknown) {
        log.push(`threw ${(error as Error).message}`);
      }
    }

    @Aspect({ order: 2 })
    class RetryAspect {
      @Around(flaky)
      retry(jp: PJP<typeof flaky>): Observable<string> {
        return jp.proceed().pipe(
          retry(2),
          map((value) => value.toUpperCase()),
        );
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect, RetryAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);

    service.failures = [new Error("first"), new Error("second")];
    expect(await lastValueFrom(service.flaky())).toBe("STABLE");
    expect(service.subscriptions).toBe(3);
    expect(log).toEqual(["returned STABLE"]);

    service.failures = [new Error("1"), new Error("2"), new Error("3")];
    await expect(lastValueFrom(service.flaky())).rejects.toThrow("3");
    expect(log).toEqual(["returned STABLE", "threw 3"]);
  });

  it("replaces the stream without subscribing to the source", async () => {
    const { PriceService } = fixture();

    @Aspect()
    class CacheAspect {
      @Around(P.method(PriceService, "quotes"))
      cached(): Observable<string> {
        return of("cached");
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, CacheAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);

    expect(await lastValueFrom(service.quotes("A"))).toBe("cached");
    expect(service.subscriptions).toBe(0);
  });
});

describe("observableAdapter registration", () => {
  it("leaves an Observable a plain return value for an application that does not register it", async () => {
    const { PriceService } = fixture();
    const returned: unknown[] = [];

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.method(PriceService, "quotes"))
      record(_jp: unknown, value: unknown) {
        returned.push(value);
      }
    }

    const { moduleRef } = await initWoven({
      providers: [PriceService, AuditAspect],
    });
    const service = moduleRef.get(PriceService);
    const stream = service.quotes("A");

    expect(returned).toEqual([stream]);
    expect(service.subscriptions).toBe(0);
  });

  it("keeps following promises next to streams", async () => {
    const { PriceService } = fixture();
    const returned: unknown[] = [];

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.within(PriceService))
      record(_jp: unknown, value: unknown) {
        returned.push(value);
      }
    }

    const { moduleRef } = await initWoven(
      { providers: [PriceService, AuditAspect] },
      adapters,
    );
    const service = moduleRef.get(PriceService);
    await service.balance();
    await lastValueFrom(service.quotes("A"));

    expect(returned).toEqual([7, "A:2"]);
  });

  it("supports Observables only", () => {
    expect(observableAdapter.supports(of(1))).toBe(true);
    expect(observableAdapter.supports(new Subject())).toBe(true);
    expect(observableAdapter.supports(NEVER)).toBe(true);
    expect(observableAdapter.supports(Promise.resolve(1))).toBe(false);
    expect(observableAdapter.supports({ subscribe() {} })).toBe(false);
    expect(observableAdapter.supports(undefined)).toBe(false);
  });
});

describe("observableAdapter behind an HTTP route", () => {
  it("advises the stream Nest subscribes to for the response", async () => {
    const log: string[] = [];

    @Controller("prices")
    class PriceController {
      @Get("ok")
      ok(): Observable<{ price: number }> {
        return of({ price: 1 }, { price: 2 });
      }

      @Get("down")
      down(): Observable<never> {
        return throwError(() => new QuotaError("limit"));
      }
    }

    @Aspect()
    class AuditAspect {
      @AfterReturning(P.within(PriceController))
      record(_jp: unknown, value: unknown) {
        log.push(`returned ${JSON.stringify(value)}`);
      }

      @AfterThrowing(P.within(PriceController), { throwing: QuotaError })
      alert(_jp: unknown, error: QuotaError) {
        log.push(`threw ${error.message}`);
      }

      @After(P.within(PriceController))
      settle() {
        log.push("after");
      }
    }

    const { moduleRef } = await initWoven(
      { controllers: [PriceController], providers: [AuditAspect] },
      adapters,
    );
    const url = await listenWoven(moduleRef);

    const ok = await fetch(`${url}/prices/ok`);
    expect([ok.status, await ok.json()]).toEqual([200, { price: 2 }]);
    expect(log).toEqual(['returned {"price":2}', "after"]);

    const down = await fetch(`${url}/prices/down`);
    expect(down.status).toBe(500);
    expect(log.slice(2)).toEqual(["threw limit", "after"]);
  });
});
