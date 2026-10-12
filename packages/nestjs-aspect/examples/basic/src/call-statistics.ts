import { Injectable } from "@nestjs/common";

export interface CallTotals {
  calls: number;
  errors: number;
  milliseconds: number;
}

/**
 * Totals per method. Its size is bounded by the number of advised methods,
 * whatever the number of calls.
 */
@Injectable()
export class CallStatistics {
  private readonly totals = new Map<string, CallTotals>();

  record(member: string, failed: boolean, milliseconds: number): void {
    const totals = this.totals.get(member) ?? {
      calls: 0,
      errors: 0,
      milliseconds: 0,
    };
    totals.calls += 1;
    totals.errors += failed ? 1 : 0;
    totals.milliseconds += milliseconds;
    this.totals.set(member, totals);
  }

  /** The totals by member, such as `"OrdersRepository.insert"`. */
  summary(): Record<string, CallTotals> {
    return Object.fromEntries(this.totals);
  }

  reset(): void {
    this.totals.clear();
  }
}
