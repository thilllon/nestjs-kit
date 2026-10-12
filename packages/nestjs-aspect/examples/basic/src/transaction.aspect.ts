import { Around, Aspect, P, type ProceedingJoinPointOf } from "nestjs-aspect";
import { Database } from "./database.js";
import { Transactional } from "./transactional.js";

const transactional = P.annotated(Transactional);

/**
 * Delimits a transaction at an annotated provider method. An interceptor
 * surrounds a route handler as a whole and does not reach a method that
 * another provider calls. Calling `Database.transactional()` inside the
 * method is equivalent for one method; the annotation states the boundary
 * once for every method that carries it, and `requiresAdvice` keeps such a
 * method from running without this aspect.
 */
@Aspect({ order: 15 })
export class TransactionAspect {
  constructor(private readonly database: Database) {}

  @Around(transactional)
  run(
    joinPoint: ProceedingJoinPointOf<typeof transactional>,
  ): Promise<unknown> {
    return this.database.transactional(() => joinPoint.proceed());
  }
}
