import {
  envDetector,
  hostDetector,
  processDetector,
} from "@opentelemetry/resources";
import { NodeSDK, type tracing } from "@opentelemetry/sdk-node";
import { birthplaceDetector } from "birthplace/otel";

export interface TelemetryOptions {
  /** The birthplace file that `build:metadata` writes. */
  file: URL;
  traceExporter: tracing.SpanExporter;
}

/**
 * Creates an SDK whose resource carries the build recorded in the birthplace
 * file. The application exports spans only.
 */
export const createTelemetry = ({
  file,
  traceExporter,
}: TelemetryOptions): NodeSDK =>
  new NodeSDK({
    // `resourceDetectors` replaces the default detectors, so the process, host
    // and environment detectors are listed again. `envDetector` runs last, so
    // OTEL_RESOURCE_ATTRIBUTES can override build attributes deliberately.
    resourceDetectors: [
      birthplaceDetector({ file, includeHostAttributes: true }),
      processDetector,
      hostDetector,
      envDetector,
    ],
    traceExporter,
    metricReaders: [],
    logRecordProcessors: [],
  });
