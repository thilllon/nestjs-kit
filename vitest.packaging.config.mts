import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/src/packaging*.test.ts"],
    // Packaging tests start Node, pnpm, compiler and bundler processes, and the
    // test files run in parallel; the unit-test default of 5 s is too short.
    testTimeout: 120_000,
  },
});
