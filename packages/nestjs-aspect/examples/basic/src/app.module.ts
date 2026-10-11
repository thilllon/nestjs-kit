import { Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";
import { AuditAspect } from "./audit.aspect.js";
import { AuditController } from "./audit.controller.js";
import { AuditLog } from "./audit-log.js";
import { OrdersModule } from "./orders.module.js";
import { RetryAspect } from "./retry.aspect.js";

@Module({
  imports: [AspectModule.forRoot(), OrdersModule],
  controllers: [AuditController],
  providers: [AuditLog, AuditAspect, RetryAspect],
})
export class AppModule {}
