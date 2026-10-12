import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { CheckoutService } from "./checkout.service.js";
import { OrdersService } from "./orders.service.js";

/**
 * Completes the orders that have been pending for longer than one interval,
 * on a timer. No request starts its calls, so no guard, interceptor or
 * exception filter surrounds them; the aspects advise them like the calls a
 * route handler makes.
 *
 * `RECONCILE_INTERVAL_MILLISECONDS` sets the interval, 30 seconds by
 * default.
 */
@Injectable()
export class ReconciliationWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(ReconciliationWorker.name);

  private readonly interval = Number(
    process.env.RECONCILE_INTERVAL_MILLISECONDS ?? 30_000,
  );

  private timer?: NodeJS.Timeout;

  private running?: Promise<void>;

  constructor(
    private readonly orders: OrdersService,
    private readonly checkout: CheckoutService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.tick(), this.interval);
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Starts a run unless the previous one is still going. */
  private tick(): void {
    this.running ??= this.reconcile()
      .catch((error) => this.logger.error(`Reconciliation failed: ${error}`))
      .finally(() => {
        this.running = undefined;
      });
  }

  private async reconcile(): Promise<void> {
    const before = Date.now() - this.interval;
    for (const order of await this.orders.list()) {
      if (order.status === "pending" && order.createdAt <= before) {
        await this.checkout
          .complete(order)
          .catch((error) =>
            this.logger.warn(`Order ${order.id} is not completed: ${error}`),
          );
      }
    }
  }
}
