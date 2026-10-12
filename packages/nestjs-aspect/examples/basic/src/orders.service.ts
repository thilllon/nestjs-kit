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
   * Stores the order, reserves its stock and stores the reservation. A
   * failed reservation rejects the method, which discards the stored order.
   */
  @Transactional()
  async place(sku: string, quantity: number): Promise<Order> {
    const order = await this.repository.insert(sku, quantity);
    let reservation: string;
    try {
      reservation = await this.inventory.reserve(sku, quantity);
    } catch (error) {
      if (error instanceof TransientError) {
        throw new ServiceUnavailableException(error.message);
      }
      throw error;
    }
    return this.repository.confirm(order, reservation);
  }

  list(): Promise<Order[]> {
    return this.repository.findAll();
  }
}
