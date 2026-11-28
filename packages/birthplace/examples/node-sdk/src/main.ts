import { trace } from "@opentelemetry/api";
import { tracing } from "@opentelemetry/sdk-node";
import { createTelemetry } from "./telemetry.js";

const sdk = createTelemetry({
  file: new URL("birthplace.json", import.meta.url),
  traceExporter: new tracing.ConsoleSpanExporter(),
});

sdk.start();
trace.getTracer("birthplace-example").startSpan("example-request").end();
await sdk.shutdown();
