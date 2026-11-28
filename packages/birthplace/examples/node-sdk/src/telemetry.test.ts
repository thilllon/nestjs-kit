import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { trace } from "@opentelemetry/api";
import type { tracing } from "@opentelemetry/sdk-node";
import { collectBirthplace, writeBirthplace } from "birthplace";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTelemetry } from "./telemetry.js";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const directories: string[] = [];

// The SDK and envDetector read OTEL_* variables, which must not change the
// resource or disable the SDK under test.
beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OTEL_")) {
      vi.stubEnv(key, undefined);
    }
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createTelemetry", () => {
  it("exports spans whose resource carries the recorded build and the build machine", async () => {
    const directory = mkdtempSync(join(tmpdir(), "birthplace-example-"));
    directories.push(directory);
    const file = join(directory, "birthplace.json");
    // What `build:metadata` records, without the checkout and CI variables of
    // the machine running the test.
    writeBirthplace(
      collectBirthplace({
        cwd: exampleRoot,
        env: {},
        revision: "a".repeat(40),
        timestamp: false,
        host: true,
      }),
      { file },
    );
    const spans: tracing.ReadableSpan[] = [];
    const sdk = createTelemetry({
      file: pathToFileURL(file),
      traceExporter: {
        export(batch, callback) {
          spans.push(...batch);
          callback({ code: 0 });
        },
        async shutdown() {
          // The in-memory exporter holds no connections.
        },
      },
    });

    sdk.start();
    trace.getTracer("birthplace-example").startSpan("example-request").end();
    await sdk.shutdown();

    expect(spans).toHaveLength(1);
    expect(spans[0]?.resource.attributes).toMatchObject({
      "service.name": "birthplace-node-sdk-example",
      "service.version": "0.0.0",
      "vcs.ref.head.revision": "a".repeat(40),
      "birthplace.host.arch": expect.any(String),
      "process.pid": process.pid,
    });
  });
});
