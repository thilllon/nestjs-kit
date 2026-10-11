import { Body, Controller, Post } from "@nestjs/common";
import { type Order, OrdersService } from "./orders.service.js";

@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() body: { sku: string; quantity: number }): Promise<Order> {
    return this.orders.place(body.sku, body.quantity);
  }
}
