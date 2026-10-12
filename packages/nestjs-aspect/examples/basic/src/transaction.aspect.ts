import {
  Around,
  Aspect,
  Pointcut as P,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";
import { Database } from "./database.js";
import { Transactional } from "./transactional.js";

const transactional = P.annotated(Transactional);

/**
 * Delimits a transaction at an annotated provider method. An interceptor
 * surrounds a route handler as a whole and does not reach a method that
 * another provider or a worker calls.
 *
 * It has the highest order of the three aspects and is the innermost one:
 * `RetryAspect` repeats the whole transaction.
 */
@Aspect({ order: 100 })
export class TransactionAspect {
  constructor(private readonly database: Database) {}

  @Around(transactional)
  run(
    joinPoint: ProceedingJoinPointOf<typeof transactional>,
  ): Promise<unknown> {
    return this.database.transactional(() => joinPoint.proceed());
  }
}
