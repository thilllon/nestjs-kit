import { ConflictException, Injectable } from "@nestjs/common";
import { InventoryClient } from "./inventory.client.js";
import { OutOfStockError } from "./inventory.transport.js";
import type { Order } from "./order.js";
import { OrdersService } from "./orders.service.js";
import { TransientError } from "./retryable.js";

/**
 * Places an order in three steps, none of which holds a transaction open
 * during the call of the remote inventory service: the order is stored as
 * pending, the stock is reserved, and the order is confirmed.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly orders: OrdersService,
    private readonly inventory: InventoryClient,
  ) {}

  async place(sku: string, quantity: number): Promise<Order> {
    return this.complete(await this.orders.create(sku, quantity));
  }

  /**
   * Reserves the stock of a pending order and confirms the order. The order
   * id is the idempotency key, so a second call for the same order gets the
   * reservation of the first one.
   *
   * When the inventory service does not answer, the order stays pending and
   * `ReconciliationWorker` completes it later. When the service refuses the
   * reservation, the order is cancelled.
   */
  async complete(order: Order): Promise<Order> {
    let reservation: string;
    try {
      reservation = await this.inventory.reserve(
        `order-${order.id}`,
        order.sku,
        order.quantity,
      );
    } catch (error) {
      if (error instanceof TransientError) {
        return order;
      }
      if (error instanceof OutOfStockError) {
        await this.orders.cancel(order.id);
        throw new ConflictException(error.message);
      }
      throw error;
    }
    return this.orders.confirm(order.id, reservation);
  }
}
