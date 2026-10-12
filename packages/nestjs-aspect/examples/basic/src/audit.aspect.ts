import {
  AfterReturning,
  AfterThrowing,
  Aspect,
  Before,
  type JoinPointOf,
  P,
} from "nestjs-aspect";
import { AuditLog } from "./audit-log.js";
import { Database } from "./database.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersModule } from "./orders.module.js";

/**
 * The calls between the providers of `OrdersModule`: every method of the
 * service, the repository and the inventory client. The route handlers are
 * left to Nest interceptors, which see the request, and `Database` is the
 * infrastructure below the audited calls.
 */
const orders = P.inModule(OrdersModule).and(
  P.within(OrdersController, Database).not(),
);

function memberOf(joinPoint: JoinPointOf<typeof orders>): string {
  const { targetType, name } = joinPoint.signature;
  return `${targetType.name}.${String(name)}`;
}

/**
 * Has the lowest order of the three aspects, so it runs outside
 * `TransactionAspect`: an entry for the outcome of a transactional method is
 * recorded after the commit or the rollback.
 */
@Aspect({ order: 10 })
export class AuditAspect {
  constructor(private readonly log: AuditLog) {}

  @Before(orders)
  recordCall(joinPoint: JoinPointOf<typeof orders>): void {
    this.log.record({ event: "call", member: memberOf(joinPoint) });
  }

  @AfterReturning(orders)
  recordReturn(joinPoint: JoinPointOf<typeof orders>): void {
    this.log.record({ event: "return", member: memberOf(joinPoint) });
  }

  @AfterThrowing(orders)
  recordError(joinPoint: JoinPointOf<typeof orders>, error: unknown): void {
    this.log.record({
      event: "error",
      member: memberOf(joinPoint),
      error: error instanceof Error ? error.constructor.name : typeof error,
    });
  }
}
