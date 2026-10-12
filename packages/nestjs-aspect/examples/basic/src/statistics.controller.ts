import { Controller, Get } from "@nestjs/common";
import { CallStatistics, type CallTotals } from "./call-statistics.js";

@Controller("statistics")
export class StatisticsController {
  constructor(private readonly statistics: CallStatistics) {}

  @Get()
  summary(): Record<string, CallTotals> {
    return this.statistics.summary();
  }
}
