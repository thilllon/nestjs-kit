import { defineConfig } from "vitest/config";
import unitConfig from "./vitest.config.mts";

export default defineConfig({
  ...unitConfig,
  test: {
    ...unitConfig.test,
    include: ["packages/*/src/**/*.e2e.spec.ts"],
    exclude: [],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: false,
  },
});
