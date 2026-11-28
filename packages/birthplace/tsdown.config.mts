import { defineConfig } from "tsdown";
import { sharedBuildOptions } from "../../tsdown.config.mts";

export default defineConfig({
  ...sharedBuildOptions,
  entry: {
    index: "src/index.ts",
    otel: "src/otel.ts",
    attributes: "src/attributes.ts",
    cli: "src/cli.ts",
  },
  // The output runs on the floor of the package's engines range.
  target: "node22",
});
