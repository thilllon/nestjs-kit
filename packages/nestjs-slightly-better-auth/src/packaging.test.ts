import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

function node(script: string, ...flags: string[]): string {
  return execFileSync(process.execPath, [...flags, "--eval", script], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

describe("built authentication package", () => {
  it("shares one module identity between Node import and require", () => {
    const result = node(
      `import { createRequire } from "node:module";
       const require = createRequire(import.meta.url);
       const name = ${JSON.stringify(manifest.name)};
       const imported = await import(name);
       const required = require(name);
       console.log(JSON.stringify({
         same: imported === required,
         imported: import.meta.resolve(name),
         required: require.resolve(name),
       }));`,
      "--input-type=module",
    );
    expect(JSON.parse(result)).toEqual({
      same: true,
      imported: expect.stringMatching(/\/dist\/index\.mjs$/),
      required: expect.stringMatching(/\/dist\/index\.mjs$/),
    });
  });

  it("loads the real CommonJS fallback when require(esm) is disabled", () => {
    const result = node(
      `const name = ${JSON.stringify(manifest.name)};
       require(name);
       console.log(require.resolve(name));`,
      "--no-experimental-require-module",
    );
    expect(result).toMatch(/\/dist\/index\.cjs$/);
  });

  it("includes every declared entry point and both declaration formats", () => {
    const entry = manifest.exports["."];
    const paths = new Set([
      manifest.main,
      manifest.module,
      manifest.types,
      ...Object.values(entry).flatMap(({ types, default: path }) => [
        types,
        path,
      ]),
      manifest.exports["./package.json"],
    ]);
    const missing = [...paths].filter(
      (path) => !existsSync(new URL(`../${path}`, import.meta.url)),
    );
    expect(missing).toEqual([]);
  });
});
