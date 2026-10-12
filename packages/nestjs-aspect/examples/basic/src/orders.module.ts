import { Module } from "@nestjs/common";
import { Database } from "./database.js";
import { InventoryClient } from "./inventory.client.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersRepository } from "./orders.repository.js";
import { OrdersService } from "./orders.service.js";

@Module({
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository, InventoryClient, Database],
  exports: [Database],
})
export class OrdersModule {}
