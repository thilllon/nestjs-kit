import {
  AfterReturning,
  AfterThrowing,
  Aspect,
  Before,
  type JoinPointOf,
  Pointcut as P,
} from "nestjs-aspect";
import { CallTrace } from "./call-trace.js";
import { Database } from "./database.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersModule } from "./orders.module.js";

/**
 * The calls between the providers of `OrdersModule`: every method of the
 * service, the repository and the inventory client, with no decorator on
 * any of them. The route handlers are left to Nest interceptors, which see
 * the request, and `Database` is the infrastructure below the traced calls.
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
export class CallTraceAspect {
  constructor(private readonly trace: CallTrace) {}

  @Before(orders)
  recordCall(joinPoint: JoinPointOf<typeof orders>): void {
    this.trace.record({ event: "call", member: memberOf(joinPoint) });
  }

  @AfterReturning(orders)
  recordReturn(joinPoint: JoinPointOf<typeof orders>): void {
    this.trace.record({ event: "return", member: memberOf(joinPoint) });
  }

  @AfterThrowing(orders)
  recordError(joinPoint: JoinPointOf<typeof orders>, error: unknown): void {
    this.trace.record({
      event: "error",
      member: memberOf(joinPoint),
      error: error instanceof Error ? error.constructor.name : typeof error,
    });
  }
}
