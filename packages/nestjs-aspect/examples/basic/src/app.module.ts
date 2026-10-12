import { Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";
import { CallTraceAspect } from "./call-trace.aspect.js";
import { CallTrace } from "./call-trace.js";
import { OrdersModule } from "./orders.module.js";
import { RetryAspect } from "./retry.aspect.js";
import { TraceController } from "./trace.controller.js";
import { TransactionAspect } from "./transaction.aspect.js";

@Module({
  imports: [AspectModule.forRoot(), OrdersModule],
  controllers: [TraceController],
  providers: [CallTrace, CallTraceAspect, TransactionAspect, RetryAspect],
})
export class AppModule {}
