import { fileURLToPath } from "node:url";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

const betterAuthSource = fileURLToPath(
  new URL("./packages/nestjs-slightly-better-auth/src/", import.meta.url),
);

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  resolve: {
    // Examples import the workspace package by name; tests use its source so
    // they run without a prior build.
    alias: [
      {
        find: /^nestjs-slightly-better-auth$/,
        replacement: `${betterAuthSource}index.ts`,
      },
      {
        find: /^nestjs-slightly-better-auth\/([\w-]+)$/,
        replacement: `${betterAuthSource}$1.ts`,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts", "examples/*/src/**/*.test.ts"],
    exclude: ["**/*.e2e.test.ts", "**/packaging*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
