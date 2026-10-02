import { defineConfig } from "vitest/config";

// Each package runs this configuration from its own directory.
export default defineConfig({
  root: process.cwd(),
  test: {
    environment: "node",
    include: ["src/packaging*.test.ts"],
    // Packaging tests start Node, pnpm, compiler and bundler processes, and the
    // test files run in parallel; the unit-test default of 5 s is too short.
    testTimeout: 120_000,
  },
});
