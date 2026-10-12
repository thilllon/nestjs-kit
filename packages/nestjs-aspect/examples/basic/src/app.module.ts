import { Module } from "@nestjs/common";
import { AspectModule } from "nestjs-aspect";
import { CallStatistics } from "./call-statistics.js";
import { OrdersModule } from "./orders.module.js";
import { RetryAspect } from "./retry.aspect.js";
import { StatisticsAspect } from "./statistics.aspect.js";
import { StatisticsController } from "./statistics.controller.js";
import { TransactionAspect } from "./transaction.aspect.js";

@Module({
  imports: [AspectModule.forRoot(), OrdersModule],
  controllers: [StatisticsController],
  providers: [CallStatistics, StatisticsAspect, RetryAspect, TransactionAspect],
})
export class AppModule {}
