import { defineConfig } from "tsdown";

export default defineConfig({
  cwd: process.cwd(),
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "node",
  target: "node24",
  fixedExtension: true,
  tsconfig: "tsconfig.json",
  dts: true,
  sourcemap: true,
  clean: true,
  deps: { neverBundle: true },
  publint: { strict: true },
  attw: { level: "error" },
});
