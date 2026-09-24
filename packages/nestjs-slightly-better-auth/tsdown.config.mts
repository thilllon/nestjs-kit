import { defineConfig } from "tsdown";
import { sharedBuildOptions } from "../../tsdown.config.mts";

export default defineConfig([
  {
    ...sharedBuildOptions,
    entry: {
      index: "src/index.ts",
      platform: "src/platform.ts",
      express: "src/express.ts",
      fastify: "src/fastify.ts",
      graphql: "src/graphql.ts",
      websockets: "src/websockets.ts",
      microservices: "src/microservices.ts",
      admin: "src/admin.ts",
      organization: "src/organization.ts",
      "api-key": "src/api-key.ts",
      testing: "src/testing.ts",
      "testing/conformance": "src/testing-conformance.ts",
    },
  },
  {
    ...sharedBuildOptions,
    entry: { plugin: "src/plugin.ts" },
  },
]);
