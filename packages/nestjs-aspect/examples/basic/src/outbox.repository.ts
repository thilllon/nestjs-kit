import { Injectable } from "@nestjs/common";
import { Database } from "./database.js";
import type { OrderEvent } from "./order.js";

/**
 * The events of the orders. An event is written in the transaction that
 * changes its order, so the two are stored or discarded together.
 */
@Injectable()
export class OutboxRepository {
  constructor(private readonly database: Database) {}

  async append(type: OrderEvent["type"], orderId: number): Promise<OrderEvent> {
    const event = { id: this.database.nextId("outbox"), type, orderId };
    this.database.set(`outbox/${event.id}`, event);
    return event;
  }

  async findAll(): Promise<OrderEvent[]> {
    return this.database.list<OrderEvent>("outbox/");
  }
}
