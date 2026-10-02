import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";
import {
  decoratorTransform,
  testProjects,
  workspaceSourceAliases,
} from "../../../../vitest.shared.mts";

export default defineConfig({
  plugins: [swc.vite(decoratorTransform)],
  resolve: { alias: workspaceSourceAliases() },
  test: { projects: testProjects },
});
