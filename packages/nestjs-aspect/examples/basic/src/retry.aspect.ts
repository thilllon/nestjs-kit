import { Around, Aspect, P, type PJP } from "nestjs-aspect";
import { Retryable, TransientError } from "./retryable.js";

const retryable = P.annotated(Retryable);

/**
 * Runs inside `AuditAspect`, which has the lower order: the audit trail
 * holds one call and one outcome for a method, however often it is retried.
 */
@Aspect({ order: 20 })
export class RetryAspect {
  @Around(retryable)
  async retry(jp: PJP<typeof retryable>): Promise<unknown> {
    const { attempts } = jp.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await jp.proceed();
      } catch (error) {
        if (!(error instanceof TransientError) || attempt >= attempts) {
          throw error;
        }
      }
    }
  }
}
