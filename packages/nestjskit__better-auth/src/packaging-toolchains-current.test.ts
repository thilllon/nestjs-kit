import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };
import {
  compilerOptions,
  consumerFor,
  describeDeclarationConsumers,
  fixtures,
  installToolchainConsumers,
  run,
  workspaceCompiler,
  workspaceDirectory,
} from "./packaging-toolchains-fixture.js";

// The declaration consumers at the current peer versions, and the consumer
// application bundled by esbuild and built by the Nest CLI's webpack build.
// The floor row is in packaging-toolchains-floor.test.ts.

// Nest loads these optional packages only when an application uses them.
const nestOptionalPackages = [
  "@nestjs/microservices",
  "@nestjs/websockets",
  "class-transformer",
  "class-validator",
];

// The application's output: see fixtures/packed-consumer/app.ts.
const authenticated = {
  services: { defaultAlias: true, defaultInstance: true, namedInstance: true },
  requests: {
    signUp: [200, 200],
    anonymous: 401,
    user: {
      status: 200,
      body: { email: "user@consumer.example", serviceUser: true },
    },
    operator: {
      status: 200,
      body: { email: "operator@consumer.example", serviceUser: true },
    },
    crossDefault: 401,
    crossNamed: 401,
  },
};

installToolchainConsumers(["current", "nest-cli"]);

describeDeclarationConsumers("current");

// The consumer application compiled by the workspace TypeScript 7, as the
// input of the esbuild bundles.
async function compileApp(directory: string): Promise<void> {
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { ...compilerOptions("nodenext"), outDir: "out" },
      files: ["app.mts", "app.cts"],
    }),
  );
  await run(
    process.execPath,
    [workspaceCompiler, "--project", "tsconfig.json"],
    {
      cwd: directory,
      timeout: 120_000,
    },
  );
}

async function runIsolated(
  bundle: string,
  entry: string,
): Promise<{ stdout: string; stderr: string }> {
  // A directory without node_modules: the bundle must carry every module it loads.
  const directory = await mkdtemp(join(workspaceDirectory(), "bundle-run-"));
  await cp(bundle, directory, { recursive: true });
  return run(process.execPath, [entry], {
    cwd: directory,
    env: { NODE_ENV: "test" },
    timeout: 120_000,
  });
}

describe.concurrent("bundlers with the current peer versions", () => {
  beforeAll(async () => {
    await compileApp(consumerFor("current"));
  }, 180_000);

  it.each([
    {
      format: "esm",
      input: "out/app.mjs",
      // ESM output bundles CommonJS dependencies, which call require(). Without
      // code splitting, esbuild leaves Better Auth's memory adapter, which
      // Better Auth also imports dynamically, uninitialized.
      options: [
        "--splitting",
        "--outdir=bundle-esm",
        "--out-extension:.js=.mjs",
        '--banner:js=import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
      ],
      output: "bundle-esm",
      entry: "app.mjs",
      artifact: "mjs",
    },
    {
      format: "cjs",
      input: "out/app.cjs",
      options: ["--outdir=bundle-cjs", "--out-extension:.js=.cjs"],
      output: "bundle-cjs",
      entry: "app.cjs",
      artifact: "cjs",
    },
  ] as const)(
    "bundles the $format application with esbuild and authenticates both instances",
    async ({ format, input, options, output, entry, artifact }) => {
      const directory = consumerFor("current");
      const metafile = `${output}.meta.json`;
      await run(
        join(directory, "node_modules", ".bin", "esbuild"),
        [
          input,
          "--bundle",
          "--platform=node",
          `--format=${format}`,
          `--metafile=${metafile}`,
          "--log-level=warning",
          ...nestOptionalPackages.map((name) => `--external:${name}`),
          ...options,
        ],
        { cwd: directory, timeout: 120_000 },
      );
      const { inputs } = JSON.parse(
        await readFile(join(directory, metafile), "utf8"),
      ) as { inputs: Record<string, unknown> };
      const bundled = Object.keys(inputs)
        .filter((path) => path.includes(`/${manifest.name}/`))
        .map((path) => path.split(`/${manifest.name}/`).pop() ?? "");
      // The package's own entries and chunks come from one module format.
      expect(bundled).toEqual(
        expect.arrayContaining(
          ["index", "express", "plugin"].map(
            (name) => `dist/${name}.${artifact}`,
          ),
        ),
      );
      expect(bundled.every((path) => path.endsWith(`.${artifact}`))).toBe(true);
      const { stdout, stderr } = await runIsolated(
        join(directory, output),
        entry,
      );
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toEqual(authenticated);
    },
    240_000,
  );

  it("builds the application with nest build --webpack and authenticates both instances", async () => {
    const directory = consumerFor("nest-cli");
    await mkdir(join(directory, "src"));
    await copyFile(join(fixtures, "app.ts"), join(directory, "src", "main.ts"));
    await writeFile(
      join(directory, "nest-cli.json"),
      JSON.stringify({
        sourceRoot: "src",
        entryFile: "main",
        compilerOptions: { webpack: true, deleteOutDir: true },
      }),
    );
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          ...compilerOptions("nodenext"),
          rootDir: "src",
          outDir: "dist",
        },
        include: ["src"],
      }),
    );
    const build = await run(
      join(directory, "node_modules", ".bin", "nest"),
      ["build", "--webpack"],
      { cwd: directory, timeout: 300_000 },
    );
    expect(stripVTControlCharacters(build.stdout)).toMatch(
      /compiled successfully/,
    );
    // The Nest CLI's webpack configuration keeps node_modules external, so
    // Node resolves the installed package when the bundle starts.
    const bundle = await readFile(join(directory, "dist", "main.js"), "utf8");
    expect(bundle).toContain(`require("${manifest.name}")`);
    const { stdout, stderr } = await run(
      process.execPath,
      [join("dist", "main.js")],
      { cwd: directory, env: { NODE_ENV: "test" }, timeout: 120_000 },
    );
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual(authenticated);
  }, 420_000);
});
