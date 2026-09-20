import { defineConfig } from "tsdown";
import { sharedBuildOptions } from "../../tsdown.config.mts";

export default defineConfig([
  {
    ...sharedBuildOptions,
    entry: { index: "src/index.ts", platform: "src/platform.ts" },
  },
  {
    ...sharedBuildOptions,
    entry: { plugin: "src/plugin.ts" },
  },
]);
