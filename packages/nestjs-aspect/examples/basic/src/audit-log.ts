import { Injectable } from "@nestjs/common";

export interface AuditEntry {
  event: "call" | "return" | "error";
  /** `"OrdersService.place"`. */
  member: string;
  /** Name of the error class, for an `error` entry. */
  error?: string;
}

@Injectable()
export class AuditLog {
  readonly entries: AuditEntry[] = [];

  record(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
