import { Controller, Get } from "@nestjs/common";
import { CallTrace, type TraceEntry } from "./call-trace.js";

/** Declared by `AppModule`, outside the module `CallTraceAspect` advises. */
@Controller("trace")
export class TraceController {
  constructor(private readonly trace: CallTrace) {}

  @Get()
  entries(): TraceEntry[] {
    return this.trace.entries;
  }
}
