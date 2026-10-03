import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Consumers that install the packed tarball and hand it to other toolchains:
// TypeScript 5.9 and 6.x next to the workspace's TypeScript 7, esbuild, and
// the Nest CLI's webpack build. Each peer row has its own test file, so CI runs
// the rows' compilers in separate jobs.

const execute = promisify(execFile);
// Read at runtime: source files import only source files and packages.
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  name: string;
  version: string;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const fixtures = fileURLToPath(
  new URL("../fixtures/packed-consumer/", import.meta.url),
);
export const workspaceCompiler = fileURLToPath(
  new URL("../bin/tsc", import.meta.resolve("typescript")),
);

export type Row = "floor" | "current";
type Consumer = Row | "nest-cli";

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

// pnpm's bin shim for vitest exports NODE_PATH with the workspace's hoisted
// packages; a consumer must resolve only what it installed.
const { NODE_PATH: _workspacePath, ...inheritedEnvironment } = process.env;

let workspace: string | undefined;
const consumers = new Map<Consumer, string>();

export async function run(
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

function rangeOf(ranges: Record<string, string>, name: string): string {
  const range = ranges[name];
  if (range === undefined) {
    throw new Error(`No version range for ${name} in the package manifest`);
  }
  return range;
}

function runtimeDependencies(row: Row): Record<string, string> {
  const version = (name: string) => {
    const range = rangeOf(manifest.peerDependencies, name);
    return row === "floor" ? floorOf(range) : range;
  };
  const peers = [
    "@nestjs/common",
    "@nestjs/core",
    "better-auth",
    "reflect-metadata",
    "rxjs",
  ] as const;
  return {
    ...Object.fromEntries(peers.map((peer) => [peer, version(peer)])),
    "@nestjs/platform-express": version("@nestjs/core"),
    "@types/node": rangeOf(manifest.devDependencies, "@types/node"),
  };
}

function compilerAliases(row: Row): Record<string, string> {
  return Object.fromEntries(
    Object.entries(compilers).flatMap(([name, versions]) =>
      versions === null
        ? []
        : [[`typescript-${name}`, `npm:typescript@${versions[row]}`]],
    ),
  );
}

// The floor row installs exact versions that the workspace store already
// holds; the other consumers let pnpm pick the newest versions in range.
const consumerDependencies: Record<
  Consumer,
  { dependencies: () => Record<string, string>; preferOffline: boolean }
> = {
  floor: {
    dependencies: () => ({
      ...runtimeDependencies("floor"),
      ...compilerAliases("floor"),
    }),
    preferOffline: true,
  },
  current: {
    dependencies: () => ({
      ...runtimeDependencies("current"),
      ...compilerAliases("current"),
      ...bundlerPackages,
    }),
    preferOffline: false,
  },
  "nest-cli": {
    dependencies: () => ({
      ...runtimeDependencies("current"),
      ...nestCliPackages,
    }),
    preferOffline: false,
  },
};

async function install(
  directory: string,
  name: Consumer,
  tarball: string,
): Promise<string> {
  const consumer = join(directory, name);
  const { dependencies, preferOffline } = consumerDependencies[name];
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: `packed-toolchain-${name}`,
      private: true,
      dependencies: { [manifest.name]: `file:${tarball}`, ...dependencies() },
    }),
  );
  await writeFile(
    join(consumer, "pnpm-workspace.yaml"),
    "allowBuilds:\n  esbuild: true\n",
  );
  await run(
    "pnpm",
    [
      "install",
      ...(preferOffline ? ["--prefer-offline"] : []),
      "--no-frozen-lockfile",
    ],
    { cwd: consumer, timeout: 300_000 },
  );
  return consumer;
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

// Packs the package and installs the named consumers before the file's tests,
// and removes them afterwards.
export function installToolchainConsumers(names: readonly Consumer[]): void {
  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "nsba-packed-toolchains-"));
    const directory = workspace;
    await run("pnpm", ["pack", "--pack-destination", directory], {
      cwd: packageRoot,
      timeout: 120_000,
    });
    const tarball = join(directory, `${manifest.name}-${manifest.version}.tgz`);
    // Settle every install before failing, so cleanup never races a running pnpm.
    const results = await Promise.allSettled(
      names.map((name) => install(directory, name, tarball)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    for (const [index, name] of names.entries()) {
      const result = results[index];
      if (result?.status === "fulfilled") {
        consumers.set(name, result.value);
      }
    }
    await Promise.all(
      names
        .filter((name) => name !== "nest-cli")
        .map((name) => copyFixtures(consumerFor(name))),
    );
  }, 600_000);

  afterAll(async () => {
    if (workspace !== undefined) {
      await rm(workspace, { recursive: true, force: true });
    }
  });
}

export function workspaceDirectory(): string {
  if (workspace === undefined) {
    throw new Error("The toolchain consumers are not installed");
  }
  return workspace;
}

export function consumerFor(name: Consumer): string {
  const directory = consumers.get(name);
  if (directory === undefined) {
    throw new Error(`No installed consumer ${name}`);
  }
  return directory;
}

type ResolutionMode = "nodenext" | "node16" | "bundler";

export function compilerOptions(mode: ResolutionMode) {
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

// Compiles the row's declaration consumers with every compiler and resolution
// mode, with and without the ./api-key augmentation.
export function describeDeclarationConsumers(row: Row): void {
  describe.concurrent(`declaration consumers with the ${row} peer versions`, () => {
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

    it.each(
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
  });
}
