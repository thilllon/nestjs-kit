import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Runs the documented scripts against the built example and the built
// birthplace CLI: `build:metadata` records the checkout, and `start` prints
// one span with its resource.

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));

// OTEL_* variables must not change the printed resource or disable the SDK.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("OTEL_")),
);

const runScript = (script: string) => {
  const result = spawnSync("pnpm", ["run", script], {
    cwd: exampleRoot,
    encoding: "utf8",
    env: environment,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
};

describe("documented run", () => {
  it("records the build and exports it with the span resource", () => {
    runScript("build:metadata");
    const recorded = JSON.parse(
      readFileSync(join(exampleRoot, "dist", "birthplace.json"), "utf8"),
    );
    expect(recorded.service).toEqual({
      name: "birthplace-node-sdk-example",
      version: "0.0.0",
    });
    expect(recorded.source.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof recorded.host.arch).toBe("string");

    const printed = runScript("start");
    expect(printed).toContain("'service.name': 'birthplace-node-sdk-example'");
    expect(printed).toContain(
      `'vcs.ref.head.revision': '${recorded.source.revision}'`,
    );
    expect(printed).toContain(
      `'birthplace.host.arch': '${recorded.host.arch}'`,
    );
    expect(printed).toContain("name: 'example-request'");
  });
});
