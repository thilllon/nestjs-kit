import { Around, Aspect, P, type ProceedingJoinPointOf } from "nestjs-aspect";
import { Retryable, TransientError } from "./retryable.js";

const retryable = P.annotated(Retryable);

/**
 * Retries one call of an outbound client. A Nest interceptor surrounds the
 * route handler as a whole and does not reach a call between providers.
 *
 * Runs inside `CallTraceAspect`, which has the lower order: the trace holds
 * one call and one outcome for a method, however often it is retried.
 */
@Aspect({ order: 20 })
export class RetryAspect {
  @Around(retryable)
  async retry(
    joinPoint: ProceedingJoinPointOf<typeof retryable>,
  ): Promise<unknown> {
    const { attempts } = joinPoint.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await joinPoint.proceed();
      } catch (error) {
        if (!(error instanceof TransientError) || attempt >= attempts) {
          throw error;
        }
      }
    }
  }
}
