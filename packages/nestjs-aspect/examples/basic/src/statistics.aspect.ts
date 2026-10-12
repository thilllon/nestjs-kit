import {
  Around,
  Aspect,
  Pointcut as P,
  type ProceedingJoinPointOf,
} from "nestjs-aspect";
import { CallStatistics } from "./call-statistics.js";
import { OrdersModule } from "./orders.module.js";

/**
 * The calls that leave the application logic of `OrdersModule`: the
 * asynchronous methods of its providers whose token ends in `Repository` or
 * `Client`. No method carries a decorator for it, and a repository or
 * client that joins the module later is selected as well.
 */
const boundaryCalls = P.all(
  P.inModule(OrdersModule),
  P.bean(/(Repository|Client)$/),
  P.matching({
    methodMatcher: { isRuntime: false, matches: (method) => method.isAsync },
  }),
);

/**
 * Records the number, the failures and the duration of the calls at the
 * boundaries. It has the lowest order of the three aspects and is the
 * outermost one: a call that `RetryAspect` repeats is one call, and its
 * duration includes the retries.
 */
@Aspect({ order: 10 })
export class StatisticsAspect {
  constructor(private readonly statistics: CallStatistics) {}

  @Around(boundaryCalls)
  async record(
    joinPoint: ProceedingJoinPointOf<typeof boundaryCalls>,
  ): Promise<unknown> {
    const { targetType, name } = joinPoint.signature;
    const member = `${targetType.name}.${String(name)}`;
    const started = performance.now();
    let failed = true;
    try {
      const result = await joinPoint.proceed();
      failed = false;
      return result;
    } finally {
      this.statistics.record(member, failed, performance.now() - started);
    }
  }
}
