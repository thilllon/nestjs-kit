import { Injectable } from "@nestjs/common";
import { Database } from "./database.js";
import type { Order } from "./order.js";

@Injectable()
export class OrdersRepository {
  constructor(private readonly database: Database) {}

  async insert(sku: string, quantity: number): Promise<Order> {
    const order: Order = {
      id: this.database.nextId("orders"),
      sku,
      quantity,
      createdAt: Date.now(),
      status: "pending",
    };
    this.database.set(`orders/${order.id}`, order);
    return order;
  }

  async save(order: Order): Promise<Order> {
    this.database.set(`orders/${order.id}`, order);
    return order;
  }

  async find(id: number): Promise<Order | undefined> {
    return this.database.get<Order>(`orders/${id}`);
  }

  async findAll(): Promise<Order[]> {
    return this.database.list<Order>("orders/");
  }
}
