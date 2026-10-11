import { Module } from "@nestjs/common";
import { InventoryClient } from "./inventory.client.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, InventoryClient],
})
export class OrdersModule {}
