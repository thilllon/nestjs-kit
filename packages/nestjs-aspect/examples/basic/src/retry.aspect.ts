import {
  Around,
  Aspect,
  Pointcut as P,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";
import { Retryable, TransientError } from "./retryable.js";

const retryable = P.annotated(Retryable);

/**
 * Repeats a call after a `TransientError` and no other error. Before each
 * further attempt it waits a random time below a limit that doubles.
 *
 * Its order places it inside `StatisticsAspect`, which records a retried
 * call once, and outside `TransactionAspect`, so each attempt of a
 * transactional method runs in a new transaction.
 */
@Aspect({ order: 20 })
export class RetryAspect {
  @Around(retryable)
  async retry(
    joinPoint: ProceedingJoinPointOf<typeof retryable>,
  ): Promise<unknown> {
    const { attempts, backoffMilliseconds } = joinPoint.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await joinPoint.proceed();
      } catch (error) {
        if (!(error instanceof TransientError) || attempt >= attempts) {
          throw error;
        }
        const ceiling = backoffMilliseconds * 2 ** (attempt - 1);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * ceiling),
        );
      }
    }
  }
}
