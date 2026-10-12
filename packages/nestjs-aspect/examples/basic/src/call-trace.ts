import { Injectable } from "@nestjs/common";

export interface TraceEntry {
  event: "call" | "return" | "error";
  /** `"OrdersService.place"`. */
  member: string;
  /** Name of the error class, for an `error` entry. */
  error?: string;
}

@Injectable()
export class CallTrace {
  readonly entries: TraceEntry[] = [];

  record(entry: TraceEntry): void {
    this.entries.push(entry);
  }
}
