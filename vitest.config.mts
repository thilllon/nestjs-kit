import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

type Manifest = {
  name: string;
  exports?: Record<string, unknown>;
};

type Alias = {
  find: RegExp;
  replacement: string;
};

const packagesDirectory = new URL("./packages/", import.meta.url);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importTarget(target: unknown): unknown {
  if (target && typeof target === "object" && "import" in target) {
    const branch = target.import;
    return branch && typeof branch === "object" && "default" in branch
      ? branch.default
      : branch;
  }
  return undefined;
}

// Tests import workspace packages by name. Every export whose `import` target
// is `./dist/<entry>.mjs` resolves to `src/<entry>.ts` of the same package, so
// tests run against source without a prior build. Exports without a matching
// source file keep resolving through the package's own `exports`.
function workspaceSourceAliases(): Alias[] {
  const aliases: Alias[] = [];
  for (const directory of readdirSync(packagesDirectory)) {
    const manifestUrl = new URL(`${directory}/package.json`, packagesDirectory);
    if (!existsSync(manifestUrl)) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as Manifest;
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      const entry = /^\.\/dist\/(.+)\.mjs$/.exec(String(importTarget(target)));
      if (!entry) {
        continue;
      }
      const source = new URL(
        `${directory}/src/${entry[1]}.ts`,
        packagesDirectory,
      );
      if (!existsSync(source)) {
        continue;
      }
      // "." maps to the package name, "./sub" to "<name>/sub".
      const specifier = `${manifest.name}${subpath.slice(1)}`;
      aliases.push({
        find: new RegExp(`^${escapeRegExp(specifier)}$`),
        replacement: fileURLToPath(source),
      });
    }
  }
  return aliases;
}

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
    alias: workspaceSourceAliases(),
  },
  test: {
    environment: "node",
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/examples/*/src/**/*.test.ts",
    ],
    exclude: ["**/*.e2e.test.ts", "**/packaging*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
  },
});
