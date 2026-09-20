import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: "typescript", decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
    exclude: ["**/*.e2e.test.ts", "**/packaging.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
