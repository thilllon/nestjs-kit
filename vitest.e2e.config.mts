import { defineConfig } from "vitest/config";
import unitConfig from "./vitest.config.mts";

// Each package runs this configuration from its own directory.
export default defineConfig({
  ...unitConfig,
  root: process.cwd(),
  test: {
    ...unitConfig.test,
    include: ["src/**/*.e2e.test.ts"],
    exclude: [],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
