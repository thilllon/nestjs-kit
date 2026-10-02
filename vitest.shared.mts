import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// This module imports only Node.js built-ins, so the repository root needs no
// test runner. Each workspace project's `vitest.config.mts` imports Vitest and
// the SWC plugin from its own dependencies and combines these options.

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
export function workspaceSourceAliases(): Alias[] {
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

// SWC options that compile legacy decorators and emit the metadata that Nest
// dependency injection reads.
export const decoratorTransform = {
  jsc: {
    parser: { syntax: "typescript", decorators: true },
    transform: { legacyDecorator: true, decoratorMetadata: true },
  },
} as const;

// Vitest projects, relative to the workspace project that runs them. A script
// selects one with `vitest run --project <name>`.
export const testProjects = [
  {
    // Unit tests run against workspace source, without services or `dist`.
    extends: true as const,
    test: {
      name: "unit",
      environment: "node",
      include: ["src/**/*.test.ts"],
      exclude: ["**/*.e2e.test.ts", "**/packaging*.test.ts"],
      clearMocks: true,
      restoreMocks: true,
    },
  },
  {
    // E2E test files share the package's Compose services, so they run in turn.
    extends: true as const,
    test: {
      name: "e2e",
      environment: "node",
      include: ["src/**/*.e2e.test.ts"],
      clearMocks: true,
      restoreMocks: true,
      testTimeout: 15_000,
      hookTimeout: 15_000,
      fileParallelism: false,
    },
  },
  {
    // Packaging tests load the built artifacts, so this project inherits
    // neither the source aliases nor the decorator transform. The tests start
    // Node, pnpm, compiler and bundler processes, and the test files run in
    // parallel; the unit-test default of 5 s is too short.
    extends: false as const,
    test: {
      name: "packaging",
      environment: "node",
      include: ["src/packaging*.test.ts"],
      testTimeout: 120_000,
    },
  },
];
