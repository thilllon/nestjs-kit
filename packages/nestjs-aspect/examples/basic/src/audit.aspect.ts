import {
  AfterReturning,
  AfterThrowing,
  Aspect,
  Before,
  type JP,
  P,
} from "nestjs-aspect";
import { AuditLog } from "./audit-log.js";
import { OrdersModule } from "./orders.module.js";

/** Every method of the providers and controllers `OrdersModule` declares. */
const orders = P.inModule(OrdersModule);

function memberOf(jp: JP<typeof orders>): string {
  const { targetType, name } = jp.signature;
  return `${targetType.name}.${String(name)}`;
}

@Aspect({ order: 10 })
export class AuditAspect {
  constructor(private readonly log: AuditLog) {}

  @Before(orders)
  recordCall(jp: JP<typeof orders>): void {
    this.log.record({ event: "call", member: memberOf(jp) });
  }

  @AfterReturning(orders)
  recordReturn(jp: JP<typeof orders>): void {
    this.log.record({ event: "return", member: memberOf(jp) });
  }

  @AfterThrowing(orders)
  recordError(jp: JP<typeof orders>, error: unknown): void {
    this.log.record({
      event: "error",
      member: memberOf(jp),
      error: error instanceof Error ? error.constructor.name : typeof error,
    });
  }
}
