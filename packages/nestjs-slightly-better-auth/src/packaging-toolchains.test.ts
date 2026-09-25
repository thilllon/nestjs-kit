import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

// Consumers that install the packed tarball and hand it to other toolchains:
// TypeScript 5.9 and 6.x next to the workspace's TypeScript 7, esbuild, and
// the Nest CLI's webpack build.

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtures = fileURLToPath(
  new URL("../fixtures/packed-consumer/", import.meta.url),
);
const workspaceCompiler = fileURLToPath(
  new URL("../bin/tsc", import.meta.resolve("typescript")),
);

type Row = "floor" | "current";

// Each row installs its compilers under an alias; "7" is the workspace compiler.
const compilers = {
  "5.9": { floor: "5.9.3", current: "~5.9.3" },
  "6": { floor: "6.0.3", current: "^6.0.3" },
  "7": null,
} as const;
type Compiler = keyof typeof compilers;
// Object.keys() lists integer-like keys first; keep the version order.
const compilerNames = ["5.9", "6", "7"] as const satisfies readonly Compiler[];

// Toolchain packages of the current row, outside the package's peer ranges.
const bundlerPackages = { esbuild: "^0.28.2" };
const nestCliPackages = {
  "@nestjs/cli": "^12.0.7",
  "fork-ts-checker-webpack-plugin": "^9.1.0",
  "ts-loader": "^9.5.4",
  "tsconfig-paths-webpack-plugin": "^4.2.0",
  typescript: "^6.0.3",
  webpack: "^5.105.4",
  "webpack-node-externals": "^3.0.0",
};

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

// pnpm's bin shim for vitest exports NODE_PATH with the workspace's hoisted
// packages; a consumer must resolve only what it installed.
const { NODE_PATH: _workspacePath, ...inheritedEnvironment } = process.env;

let workspace: string;
let tarball: string;
const consumers = new Map<string, string>();

async function run(
  file: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execute(file, args, {
      ...options,
      env: { ...inheritedEnvironment, NO_COLOR: "1", ...options.env },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      throw new Error(
        `${file} ${args.join(" ")} failed in ${options.cwd}\n${String(error.stdout)}\n${String("stderr" in error ? error.stderr : "")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function floorOf(range: string): string {
  const version = /\d+\.\d+\.\d+/.exec(range)?.[0];
  if (version === undefined) {
    throw new Error(`No floor version in the peer range ${range}`);
  }
  return version;
}

function runtimeDependencies(row: Row): Record<string, string> {
  const version = (range: string) => (row === "floor" ? floorOf(range) : range);
  const peers = [
    "@nestjs/common",
    "@nestjs/core",
    "better-auth",
    "reflect-metadata",
    "rxjs",
  ] as const;
  return {
    ...Object.fromEntries(
      peers.map((peer) => [peer, version(manifest.peerDependencies[peer])]),
    ),
    "@nestjs/platform-express": version(
      manifest.peerDependencies["@nestjs/core"],
    ),
    "@types/node": manifest.devDependencies["@types/node"],
  };
}

async function install(
  name: string,
  dependencies: Record<string, string>,
  preferOffline: boolean,
): Promise<string> {
  const directory = join(workspace, name);
  await mkdir(directory);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: `packed-toolchain-${name}`,
      private: true,
      dependencies: { [manifest.name]: `file:${tarball}`, ...dependencies },
    }),
  );
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    "allowBuilds:\n  esbuild: true\n",
  );
  await run(
    "pnpm",
    [
      "install",
      ...(preferOffline ? ["--prefer-offline"] : []),
      "--no-frozen-lockfile",
    ],
    { cwd: directory, timeout: 300_000 },
  );
  return directory;
}

function consumerFor(name: string): string {
  const directory = consumers.get(name);
  if (directory === undefined) {
    throw new Error(`No installed consumer ${name}`);
  }
  return directory;
}

async function copyFixtures(directory: string): Promise<void> {
  const copies = [
    ["app.ts", ["app.mts", "app.cts", "app.ts"]],
    ["declarations.cts", ["declarations.cts"]],
    ["principal-kinds.ts", ["kinds.mts", "kinds.cts", "kinds.ts"]],
    [
      "principal-kinds-api-key.ts",
      ["kinds-api-key.mts", "kinds-api-key.cts", "kinds-api-key.ts"],
    ],
  ] as const;
  await Promise.all(
    copies.flatMap(([source, targets]) =>
      targets.map((target) =>
        copyFile(join(fixtures, source), join(directory, target)),
      ),
    ),
  );
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "nsba-packed-toolchains-"));
  await run("pnpm", ["pack", "--pack-destination", workspace], {
    cwd: packageRoot,
    timeout: 120_000,
  });
  tarball = join(workspace, `${manifest.name}-${manifest.version}.tgz`);
  const aliases = (row: Row) =>
    Object.fromEntries(
      Object.entries(compilers).flatMap(([name, versions]) =>
        versions === null
          ? []
          : [[`typescript-${name}`, `npm:typescript@${versions[row]}`]],
      ),
    );
  const installs = [
    install(
      "floor",
      { ...runtimeDependencies("floor"), ...aliases("floor") },
      true,
    ),
    install(
      "current",
      {
        ...runtimeDependencies("current"),
        ...aliases("current"),
        ...bundlerPackages,
      },
      false,
    ),
    install(
      "nest-cli",
      { ...runtimeDependencies("current"), ...nestCliPackages },
      false,
    ),
  ];
  // Settle every install before failing, so cleanup never races a running pnpm.
  const results = await Promise.allSettled(installs);
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  const [floor, current, nestCli] = results.map((result) =>
    result.status === "fulfilled" ? result.value : "",
  ) as [string, string, string];
  consumers.set("floor", floor);
  consumers.set("current", current);
  consumers.set("nest-cli", nestCli);
  await Promise.all([copyFixtures(floor), copyFixtures(current)]);
}, 600_000);

afterAll(async () => {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
});

type ResolutionMode = "nodenext" | "node16" | "bundler";

function compilerOptions(mode: ResolutionMode) {
  return {
    target: "ES2022",
    module: { nodenext: "NodeNext", node16: "Node16", bundler: "Preserve" }[
      mode
    ],
    moduleResolution: {
      nodenext: "NodeNext",
      node16: "Node16",
      bundler: "Bundler",
    }[mode],
    strict: true,
    skipLibCheck: true,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    types: ["node"],
  };
}

// The application compiles as ESM and CommonJS under nodenext. Node16 CommonJS
// cannot import the ESM-only NestJS and Better Auth declarations, so its
// CommonJS files import only this package.
const programs: Record<
  ResolutionMode,
  (kinds: string) => { files: string[]; declarations: string[] }
> = {
  nodenext: (kinds) => ({
    files: ["app.mts", "app.cts", `${kinds}.mts`, `${kinds}.cts`],
    declarations: ["d.cts", "d.mts"],
  }),
  node16: (kinds) => ({
    files: ["app.mts", "declarations.cts", `${kinds}.mts`, `${kinds}.cts`],
    declarations: ["d.cts", "d.mts"],
  }),
  bundler: (kinds) => ({
    files: ["app.ts", `${kinds}.ts`],
    declarations: ["d.mts"],
  }),
};

function compilerPath(directory: string, compiler: Compiler): string {
  return compiler === "7"
    ? workspaceCompiler
    : join(directory, "node_modules", `typescript-${compiler}`, "bin", "tsc");
}

describe.each(["floor", "current"] as const)(
  "declaration consumers with the %s peer versions",
  (row) => {
    it("installs TypeScript 5.9 and 6.x next to the workspace TypeScript 7", async () => {
      const directory = consumerFor(row);
      const versions = await Promise.all(
        compilerNames.map(async (compiler) => {
          const { stdout } = await run(
            process.execPath,
            [compilerPath(directory, compiler), "--version"],
            { cwd: directory, timeout: 60_000 },
          );
          return stdout.trim();
        }),
      );
      console.info(`${row} compilers: ${versions.join(", ")}`);
      expect(versions).toEqual([
        expect.stringMatching(/^Version 5\.9\.\d+$/),
        expect.stringMatching(/^Version 6\.\d+\.\d+$/),
        expect.stringMatching(/^Version 7\.\d+\.\d+$/),
      ]);
    }, 60_000);

    it.concurrent.each(
      compilerNames.flatMap((compiler) =>
        (["nodenext", "node16", "bundler"] as const).flatMap((mode) =>
          [false, true].map((apiKey) => ({ compiler, mode, apiKey })),
        ),
      ),
    )(
      "compiles with TypeScript $compiler, $mode resolution and ./api-key imported: $apiKey",
      async ({ compiler, mode, apiKey }) => {
        const directory = consumerFor(row);
        const { files, declarations } = programs[mode](
          apiKey ? "kinds-api-key" : "kinds",
        );
        const project = `tsconfig.${compiler}.${mode}.${apiKey ? "api-key" : "root"}.json`;
        await writeFile(
          join(directory, project),
          JSON.stringify({
            compilerOptions: { ...compilerOptions(mode), noEmit: true },
            files,
          }),
        );
        const { stdout } = await run(
          process.execPath,
          [
            compilerPath(directory, compiler),
            "--project",
            project,
            "--listFiles",
            "--pretty",
            "false",
          ],
          { cwd: directory, timeout: 180_000 },
        );
        // The augmentation reaches the program only through the ./api-key declarations.
        const apiKeyDeclarations = stdout
          .split("\n")
          .map((line) => line.split(`/${manifest.name}/`).pop() ?? "")
          .filter((path) => /^dist\/api-key\.d\.[cm]ts$/.test(path))
          .sort();
        expect([...new Set(apiKeyDeclarations)]).toEqual(
          apiKey
            ? declarations.map((extension) => `dist/api-key.${extension}`)
            : [],
        );
      },
      240_000,
    );
  },
);

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
  const directory = await mkdtemp(join(workspace, "bundle-run-"));
  await cp(bundle, directory, { recursive: true });
  return run(process.execPath, [entry], {
    cwd: directory,
    env: { NODE_ENV: "test" },
    timeout: 120_000,
  });
}

describe("bundlers with the current peer versions", () => {
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
