// A consumer of the packed archive. The packaging test compiles this file as
// an ES module (`app.mts`) and as a CommonJS module (`app.cts`) and runs both.

import "reflect-metadata";
import { Injectable, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  AfterReturning,
  Around,
  Aspect,
  AspectInspector,
  AspectModule,
  createAnnotation,
  type JoinPointOf,
  Pointcut as P,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";
import { observableAdapter } from "nestjs-aspect/rxjs";
import { lastValueFrom, type Observable, of } from "rxjs";

const Retryable = createAnnotation<
  "Retryable",
  { attempts: number },
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });

@Injectable()
class AuditLog {
  readonly entries: string[] = [];
}

@Injectable()
class QuoteService {
  private failures = 1;

  @Retryable({ attempts: 2 })
  async price(symbol: string): Promise<string> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error("unavailable");
    }
    return `${symbol}:42`;
  }

  stream(symbol: string): Observable<string> {
    return of(`${symbol}:1`, `${symbol}:2`);
  }
}

const retryable = P.annotated(Retryable);
const quotes = P.within(QuoteService);

@Aspect({ order: 1 })
class AuditAspect {
  constructor(private readonly log: AuditLog) {}

  @AfterReturning(quotes)
  record(joinPoint: JoinPointOf<typeof quotes>, value: unknown): void {
    this.log.entries.push(`${joinPoint.toString()} -> ${String(value)}`);
  }
}

@Aspect({ order: 2 })
class RetryAspect {
  constructor(private readonly log: AuditLog) {}

  @Around(retryable)
  async retry(
    joinPoint: ProceedingJoinPointOf<typeof retryable>,
  ): Promise<unknown> {
    const { attempts } = joinPoint.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await joinPoint.proceed();
      } catch (error) {
        if (attempt >= attempts) {
          throw error;
        }
        this.log.entries.push(`retry ${attempt}`);
      }
    }
  }
}

@Module({
  imports: [
    AspectModule.forRoot({
      report: false,
      returnValueAdapters: [observableAdapter],
    }),
  ],
  providers: [AuditLog, QuoteService, AuditAspect, RetryAspect],
})
class AppModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const service = app.get(QuoteService);
  const log = app.get(AuditLog);
  const price = await service.price("A");
  const pending = service.stream("B");
  const beforeSubscription = log.entries.length;
  const last = await lastValueFrom(pending);
  const advisors = app
    .get(AspectInspector)
    .advisorsOf(QuoteService, "price")
    .map(({ type, methodName, kind }) => [type.name, methodName, kind]);
  await app.close();
  await lastValueFrom(service.stream("C"));
  const afterClose = await Promise.resolve()
    .then(() => service.price("C"))
    .catch((error: unknown) => (error instanceof Error ? error.name : error));
  console.log(
    JSON.stringify({
      price,
      last,
      beforeSubscription,
      advisors,
      afterClose,
      entries: log.entries,
    }),
  );
}

void main();
