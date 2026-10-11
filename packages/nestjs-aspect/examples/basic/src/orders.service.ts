import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { InventoryClient } from "./inventory.client.js";
import { TransientError } from "./retryable.js";

export interface Order {
  id: number;
  sku: string;
  quantity: number;
  reservation: string;
}

@Injectable()
export class OrdersService {
  private readonly orders: Order[] = [];

  constructor(private readonly inventory: InventoryClient) {}

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
    const order = { id: this.orders.length + 1, sku, quantity, reservation };
    this.orders.push(order);
    return order;
  }
}
