import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { InventoryClient } from "./inventory.client.js";
import type { Order } from "./order.js";
import { OrdersRepository } from "./orders.repository.js";
import { TransientError } from "./retryable.js";
import { Transactional } from "./transactional.js";

@Injectable()
export class OrdersService {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly inventory: InventoryClient,
  ) {}

  /**
   * Reserves the stock, then stores the order. The call of the remote
   * inventory service and its retries stay outside the transaction, which
   * covers the two writes only.
   */
  async place(sku: string, quantity: number): Promise<Order> {
    let reservation: string;
    try {
      reservation = await this.inventory.reserve(sku, quantity);
    } catch (error) {
      if (error instanceof TransientError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
    return this.store(sku, quantity, reservation);
  }

  /**
   * Stores the order and its reservation in one transaction: a failure of
   * the second write discards the first. `place` calls it on `this`, and
   * the call is advised like a call from another provider.
   */
  @Transactional()
  async store(
    sku: string,
    quantity: number,
    reservation: string,
  ): Promise<Order> {
    const order = await this.repository.insert(sku, quantity);
    return this.repository.confirm(order, reservation);
  }

  list(): Promise<Order[]> {
    return this.repository.findAll();
  }
}
