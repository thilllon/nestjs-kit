import { Injectable } from "@nestjs/common";
import { Database } from "./database.js";
import type { Order } from "./order.js";

@Injectable()
export class OrdersRepository {
  private lastId = 0;

  constructor(private readonly database: Database) {}

  async insert(sku: string, quantity: number): Promise<Order> {
    this.lastId += 1;
    const order = { id: this.lastId, sku, quantity };
    this.database.write(order);
    return order;
  }

  async confirm(order: Order, reservation: string): Promise<Order> {
    const confirmed = { ...order, reservation };
    this.database.write(confirmed);
    return confirmed;
  }

  async findAll(): Promise<Order[]> {
    return this.database.orders();
  }
}
