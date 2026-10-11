import {
  AfterReturning,
  AfterThrowing,
  Aspect,
  Before,
  type JoinPointOf,
  P,
} from "nestjs-aspect";
import { AuditLog } from "./audit-log.js";
import { OrdersModule } from "./orders.module.js";

/** Every method of the providers and controllers `OrdersModule` declares. */
const orders = P.inModule(OrdersModule);

function memberOf(joinPoint: JoinPointOf<typeof orders>): string {
  const { targetType, name } = joinPoint.signature;
  return `${targetType.name}.${String(name)}`;
}

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
