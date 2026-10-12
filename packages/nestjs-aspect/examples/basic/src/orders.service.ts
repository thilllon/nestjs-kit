import { Injectable, NotFoundException } from "@nestjs/common";
import type { Order, OrderEvent } from "./order.js";
import { OrdersRepository } from "./orders.repository.js";
import { OutboxRepository } from "./outbox.repository.js";
import { Retryable } from "./retryable.js";
import { Transactional } from "./transactional.js";

/**
 * The changes of an order. Each one writes the order and its event in one
 * transaction, and is repeated in a new transaction when it loses a
 * conflict with a concurrent change of the same order.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly orders: OrdersRepository,
    private readonly outbox: OutboxRepository,
  ) {}

  @Retryable({ attempts: 3, backoffMilliseconds: 20 })
  @Transactional()
  async create(sku: string, quantity: number): Promise<Order> {
    const order = await this.orders.insert(sku, quantity);
    await this.outbox.append("order.created", order.id);
    return order;
  }

  /** Confirms a pending order; an order in another state is left as it is. */
  @Retryable({ attempts: 3, backoffMilliseconds: 20 })
  @Transactional()
  async confirm(orderId: number, reservation: string): Promise<Order> {
    const order = await this.existing(orderId);
    if (order.status !== "pending") {
      return order;
    }
    await this.outbox.append("order.confirmed", orderId);
    return this.orders.save({ ...order, status: "confirmed", reservation });
  }

  /** Cancels a pending order; an order in another state is left as it is. */
  @Retryable({ attempts: 3, backoffMilliseconds: 20 })
  @Transactional()
  async cancel(orderId: number): Promise<Order> {
    const order = await this.existing(orderId);
    if (order.status !== "pending") {
      return order;
    }
    await this.outbox.append("order.cancelled", orderId);
    return this.orders.save({ ...order, status: "cancelled" });
  }

  list(): Promise<Order[]> {
    return this.orders.findAll();
  }

  events(): Promise<OrderEvent[]> {
    return this.outbox.findAll();
  }

  private async existing(orderId: number): Promise<Order> {
    const order = await this.orders.find(orderId);
    if (!order) {
      throw new NotFoundException(`Unknown order ${orderId}`);
    }
    return order;
  }
}
