import { Body, Controller, Get, Post } from "@nestjs/common";
import type { Order } from "./order.js";
import { OrdersService } from "./orders.service.js";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() body: { sku: string; quantity: number }): Promise<Order> {
    return this.orders.place(body.sku, body.quantity);
  }

  @Get()
  list(): Promise<Order[]> {
    return this.orders.list();
  }
}
