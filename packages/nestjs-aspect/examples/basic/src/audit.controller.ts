import { Controller, Get } from "@nestjs/common";
import { type AuditEntry, AuditLog } from "./audit-log.js";

/** Declared by `AppModule`, outside the module `AuditAspect` advises. */
@Controller("audit")
export class AuditController {
  constructor(private readonly log: AuditLog) {}

  @Get()
  entries(): AuditEntry[] {
    return this.log.entries;
  }
}
