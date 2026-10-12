import { Module } from "@nestjs/common";
import { CheckoutService } from "./checkout.service.js";
import { Database } from "./database.js";
import { InventoryClient } from "./inventory.client.js";
import {
  InMemoryInventory,
  InventoryTransport,
} from "./inventory.transport.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersRepository } from "./orders.repository.js";
import { OrdersService } from "./orders.service.js";
import { OutboxRepository } from "./outbox.repository.js";
import { ReconciliationWorker } from "./reconciliation.worker.js";

@Module({
  controllers: [OrdersController],
  providers: [
    CheckoutService,
    OrdersService,
    OrdersRepository,
    OutboxRepository,
    InventoryClient,
    ReconciliationWorker,
    Database,
    { provide: InventoryTransport, useClass: InMemoryInventory },
  ],
  exports: [Database],
})
export class OrdersModule {}
