import { Body, Controller, Get, Post } from "@nestjs/common";
import { CheckoutService } from "./checkout.service.js";
import type { Order, OrderEvent } from "./order.js";
import { OrdersService } from "./orders.service.js";

@Controller("orders")
export class OrdersController {
  constructor(
    private readonly checkout: CheckoutService,
    private readonly orders: OrdersService,
  ) {}

  @Post()
  create(@Body() body: { sku: string; quantity: number }): Promise<Order> {
    return this.checkout.place(body.sku, body.quantity);
  }

  @Get()
  list(): Promise<Order[]> {
    return this.orders.list();
  }

  @Get("events")
  events(): Promise<OrderEvent[]> {
    return this.orders.events();
  }
}
