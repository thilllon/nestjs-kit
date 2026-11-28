import {
  execFileSync,
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
} from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Checks the built CLI, a real NodeSDK that loads the built detector, and a
// consumer that installs the archive `pnpm pack` writes, outside the
// workspace.

const packageRoot = join(__dirname, "..");
const packageRequire = createRequire(__filename);
const compiler = join(
  dirname(packageRequire.resolve("typescript/package.json")),
  "bin",
  "tsc",
);
const tsx = pathToFileURL(packageRequire.resolve("tsx")).href;
const nodeSdkSmoke = join(packageRoot, "fixtures", "node-sdk-smoke.mts");
const revision = "b".repeat(40);

// pnpm's bin shim for vitest exports NODE_PATH with the workspace's hoisted
// packages; the consumer must resolve only what it installed.
const { NODE_PATH: _workspacePath, ...inheritedEnvironment } = process.env;

// CI provider variables must not leak into the metadata the CLI collects.
const isolatedEnvironment = {
  ...inheritedEnvironment,
  GITHUB_ACTIONS: "false",
  GITLAB_CI: "false",
  VERCEL: "0",
  SOURCE_DATE_EPOCH: undefined,
};

/** Runs the NodeSDK fixture, which exits nonzero when an assertion fails. */
const runNodeSdkSmoke = (args: readonly string[]) =>
  spawnSync(process.execPath, ["--import", tsx, nodeSdkSmoke, ...args], {
    encoding: "utf8",
    env: isolatedEnvironment,
    timeout: 60_000,
  });

describe("built CLI", () => {
  const cli = join(packageRoot, "dist", "cli.cjs");
  let temporaryDirectory: string;
  let fixture: string;

  const runCli = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: isolatedEnvironment,
    });

  beforeAll(() => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "birthplace-cli-"));
    fixture = join(temporaryDirectory, "fixture");
    mkdirSync(fixture);
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({ name: "fixture-package", version: "1.2.3" }),
    );
  });

  afterAll(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  it("generates metadata and inspects it as OpenTelemetry attributes", () => {
    const birthplaceFile = join(
      temporaryDirectory,
      "nested",
      "birthplace.json",
    );
    const generated = runCli(
      "generate",
      "--cwd",
      fixture,
      "--output",
      birthplaceFile,
      "--service-name",
      "demo",
      "--service-version",
      "2.0.0",
      "--revision",
      revision,
      "--no-timestamp",
      "--strict",
    );

    expect(generated.status).toBe(0);
    expect(generated.stderr).toBe("");
    expect(JSON.parse(readFileSync(birthplaceFile, "utf8"))).toEqual({
      schemaVersion: 1,
      service: { name: "demo", version: "2.0.0" },
      source: { revision },
      build: {},
    });

    const inspected = runCli("inspect", birthplaceFile, "--otel");
    expect(inspected.status).toBe(0);
    expect(inspected.stderr).toBe("");
    expect(JSON.parse(inspected.stdout)).toEqual({
      "service.name": "demo",
      "service.version": "2.0.0",
      "vcs.ref.head.revision": revision,
    });
  });

  it("uses JSON generation as the bare command", () => {
    const result = runCli(
      "--cwd",
      fixture,
      "--revision",
      revision,
      "--no-timestamp",
      "--strict",
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(
      JSON.parse(
        readFileSync(join(temporaryDirectory, "birthplace.json"), "utf8"),
      ),
    ).toEqual({
      schemaVersion: 1,
      service: { name: "fixture-package", version: "1.2.3" },
      source: { revision },
      build: {},
    });
  });

  it("only includes custom OTel attributes when inspection opts in", () => {
    const file = join(temporaryDirectory, "custom.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        service: {},
        source: { revision, dirty: false },
        build: {},
      }),
    );
    const standard = runCli("inspect", file, "--otel");
    const custom = runCli(
      "inspect",
      file,
      "--otel",
      "--include-custom-attributes",
    );
    expect(standard.status).toBe(0);
    expect(custom.status).toBe(0);
    expect(JSON.parse(standard.stdout)).toEqual({
      "vcs.ref.head.revision": revision,
    });
    expect(JSON.parse(custom.stdout)).toEqual({
      "vcs.ref.head.revision": revision,
      "birthplace.source.dirty": false,
    });
  });

  it("captures the build machine only with --host", () => {
    const file = join(temporaryDirectory, "host.json");
    const generated = runCli(
      "generate",
      "--cwd",
      fixture,
      "--output",
      file,
      "--revision",
      revision,
      "--no-timestamp",
      "--host",
    );

    expect(generated.status).toBe(0);
    expect(generated.stderr).toBe("");
    const { host } = JSON.parse(readFileSync(file, "utf8"));
    expect(typeof host.arch).toBe("string");
    expect(["little", "big"]).toContain(host.endianness);

    const standard = runCli("inspect", file, "--otel");
    const custom = runCli(
      "inspect",
      file,
      "--otel",
      "--include-custom-attributes",
    );
    const withHost = runCli(
      "inspect",
      file,
      "--otel",
      "--include-host-attributes",
    );
    expect(withHost.status).toBe(0);
    for (const result of [standard, custom]) {
      expect(result.status).toBe(0);
      expect(
        Object.keys(JSON.parse(result.stdout)).filter((key) =>
          key.startsWith("birthplace.host."),
        ),
      ).toEqual([]);
    }
    const attributes = JSON.parse(withHost.stdout);
    expect(attributes["birthplace.host.arch"]).toBe(host.arch);
    expect(attributes["birthplace.host.endianness"]).toBe(host.endianness);
    if (host.cpu?.logical !== undefined) {
      expect(attributes["birthplace.host.cpu.logical.count"]).toBe(
        host.cpu.logical.count,
      );
    }
    if (host.memory !== undefined) {
      expect(attributes["birthplace.host.memory.total"]).toBe(
        host.memory.total,
      );
    }
  });

  it("writes an importable ESM metadata module", () => {
    const birthplaceFile = join(temporaryDirectory, "birthplace.mjs");
    const generated = runCli(
      "generate",
      "--cwd",
      fixture,
      "--output",
      birthplaceFile,
      "--format",
      "esm",
      "--revision",
      revision,
      "--timestamp",
      "2026-09-21T01:02:03Z",
      "--strict",
    );

    expect(generated.status).toBe(0);
    const imported = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import(${JSON.stringify(
          pathToFileURL(birthplaceFile).href,
        )}).then(({default: value}) => console.log(JSON.stringify(value)))`,
      ],
      { encoding: "utf8" },
    );
    expect(imported.status).toBe(0);
    expect(JSON.parse(imported.stdout).service.name).toBe("fixture-package");
    expect(JSON.parse(imported.stdout).build.timestampSource).toBe("explicit");
  });

  it.each([
    ["an unsupported format", () => ["generate", "--format", "yaml"]],
    // The temporary directory has no package.json and is not a Git checkout.
    [
      "missing strict fields",
      () => ["generate", "--cwd", temporaryDirectory, "--strict"],
    ],
    ["invalid explicit metadata", () => ["generate", "--revision", "short"]],
  ])("returns a nonzero status for %s", (_description, args) => {
    const result = runCli(...args());

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });

  it("returns a nonzero status for malformed input", () => {
    const birthplaceFile = join(temporaryDirectory, "malformed.json");
    writeFileSync(birthplaceFile, "{");

    const result = runCli("inspect", birthplaceFile);

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });

  it("returns a nonzero status when the output cannot be replaced", () => {
    const outputDirectory = join(temporaryDirectory, "occupied");
    mkdirSync(outputDirectory);

    const result = runCli(
      "generate",
      "--cwd",
      fixture,
      "--output",
      outputDirectory,
      "--revision",
      revision,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });

  it.each([
    ["an unknown command", ["frobnicate"]],
    ["an unknown command with options", ["frobnicate", "--cwd", "."]],
    ["an extra positional argument", ["generate", "frobnicate"]],
  ])("rejects %s without writing anything", (_label, args) => {
    const directory = join(
      temporaryDirectory,
      `rejected-${args.length}-${args[0]}`,
    );
    mkdirSync(directory);

    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: directory,
      encoding: "utf8",
      env: isolatedEnvironment,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe("");
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("NodeSDK with the built detector", () => {
  it.each([
    ["the generated birthplace file", [], "packaged JSON"],
    ["an imported birthplace object", ["--info"], "imported ESM"],
  ])("carries %s into exported spans", (_name, flags, source) => {
    const result = runNodeSdkSmoke(flags);

    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`NodeSDK smoke passed: CLI -> ${source}`);
  });
});

describe("packed consumer", () => {
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { name: string; version: string };
  let workspace: string;
  let consumer: string;
  let archive: string;
  /** The installed copy of the archive. */
  let installed: string;
  let bin: string;

  const run = (
    command: string,
    args: readonly string[],
    options: Partial<SpawnSyncOptionsWithStringEncoding> = {},
  ): string => {
    const result = spawnSync(command, args, {
      cwd: consumer,
      encoding: "utf8",
      env: {
        ...isolatedEnvironment,
        XDG_CONFIG_HOME: join(workspace, "xdg"),
      },
      ...options,
    });
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed (${String(result.status)})\n${String(
          result.error ?? "",
        )}\n${result.stdout}\n${result.stderr}`,
      );
    }
    return result.stdout;
  };

  // The exact public surface of every entry point, sorted. An export that is
  // added or dropped without updating these lists fails the consumer checks.
  const rootExports = JSON.stringify([
    "BirthplaceError",
    "birthplaceDetector",
    "collectBirthplace",
    "readBirthplace",
    "toOtelAttributes",
    "writeBirthplace",
  ]);
  const otelExports = JSON.stringify([
    "birthplaceDetector",
    "toOtelAttributes",
  ]);
  const attributesExports = JSON.stringify([
    "BirthplaceError",
    "toOtelAttributes",
  ]);

  // Walks the relative import graph of a built entry point and returns every
  // bare (non-relative) module it can load. ESM has no synchronous load hook
  // to patch, so this proves statically what the Module._load guard proves at
  // run time for CommonJS.
  const collectExternalModules = (entry: string): string[] => {
    const externals = new Set<string>();
    const visited = new Set<string>();
    const pending = [entry];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      const source = readFileSync(file, "utf8");
      const specifiers = [
        ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
        ...source.matchAll(/\bimport\s*["']([^"']+)["']/g),
        ...source.matchAll(
          /\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/g,
        ),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        if (specifier.startsWith(".")) {
          pending.push(resolve(dirname(file), specifier));
        } else {
          externals.add(specifier.replace(/^node:/, ""));
        }
      }
    }
    return [...externals].sort();
  };

  // Returns the files an entry point reaches and fails on any reference to a
  // Node.js built-in or a non-relative module.
  const builtinFreeGraph = (entry: string): string[] => {
    const visited = new Set<string>();
    const pending = [join(installed, entry)];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (visited.has(file)) {
        continue;
      }
      visited.add(file);
      const source = readFileSync(file, "utf8");
      if (source.includes("node:")) {
        throw new Error(`${file} mentions node:`);
      }
      const specifiers = [
        ...source.matchAll(
          /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(["'])([^"']+)\1/g,
        ),
      ].map((match) => match[2]);
      for (const specifier of specifiers) {
        if (!/^\.\.?\//.test(specifier)) {
          throw new Error(
            `${file} imports the non-relative module ${specifier}`,
          );
        }
        pending.push(resolve(dirname(file), specifier));
      }
    }
    return [...visited];
  };

  const generate = (output: string, ...args: string[]): void => {
    run(bin, [
      "generate",
      "--cwd",
      consumer,
      "--output",
      output,
      "--revision",
      "c".repeat(40),
      "--no-timestamp",
      ...args,
    ]);
  };

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "birthplace-archive-"));
    consumer = join(workspace, "consumer");
    mkdirSync(consumer);
    mkdirSync(join(workspace, "xdg"));
    run("pnpm", ["pack", "--pack-destination", workspace], {
      cwd: packageRoot,
    });
    archive = join(workspace, `${manifest.name}-${manifest.version}.tgz`);
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({
        name: "birthplace-smoke-consumer",
        version: "1.0.0",
        private: true,
        dependencies: {
          // The version the workspace store holds, so the install can stay
          // offline.
          commander: JSON.parse(
            readFileSync(
              join(packageRoot, "node_modules", "commander", "package.json"),
              "utf8",
            ),
          ).version,
          birthplace: `file:${archive}`,
        },
      }),
    );
    // CI enables frozen lockfiles by default; a fresh consumer has no
    // lockfile.
    run("pnpm", [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--no-frozen-lockfile",
    ]);
    installed = join(consumer, "node_modules", manifest.name);
    bin = join(
      consumer,
      "node_modules",
      ".bin",
      `birthplace${process.platform === "win32" ? ".cmd" : ""}`,
    );
  }, 300_000);

  afterAll(() => {
    if (workspace !== undefined) {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("ships only the build output, the README, the license and the manifest", () => {
    const files = execFileSync("tar", ["--list", "--gzip", "--file", archive], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .map((line) => line.replace(/^package\//, ""));

    expect(
      files.filter(
        (file) =>
          !file.startsWith("dist/") &&
          !["LICENSE", "README.md", "package.json"].includes(file),
      ),
    ).toEqual([]);
    expect(files).toEqual(
      expect.arrayContaining(["LICENSE", "README.md", "package.json"]),
    );
  });

  it("loads every entry point from CommonJS without the collectors in birthplace/otel", () => {
    writeFileSync(
      join(consumer, "commonjs.cjs"),
      `
const assert = require('assert/strict');
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (['child_process', 'node:child_process', 'os', 'node:os'].includes(request)) {
    throw new Error('birthplace/otel loaded ' + request);
  }
  return originalLoad.apply(this, arguments);
};
const otel = require('birthplace/otel');
assert.deepEqual(otel.toOtelAttributes({ schemaVersion: 1, service: { name: 'cjs' }, source: {}, build: {} }), { 'service.name': 'cjs' });
assert.equal(typeof otel.birthplaceDetector, 'function');
Module._load = function (request, parent, isMain) {
  if (request.startsWith('node:') || Module.builtinModules.includes(request)) {
    throw new Error('birthplace/attributes loaded ' + request);
  }
  return originalLoad.apply(this, arguments);
};
const attributes = require('birthplace/attributes');
assert.deepEqual(attributes.toOtelAttributes({ schemaVersion: 1, service: { name: 'cjs' }, source: {}, build: {} }), { 'service.name': 'cjs' });
assert.deepEqual(Object.keys(attributes).sort(), ${attributesExports});
Module._load = originalLoad;
assert.deepEqual(otel.birthplaceDetector({ info: { schemaVersion: 1, service: { name: 'object' }, source: {}, build: {} } }).detect().attributes, { 'service.name': 'object' });
const root = require('birthplace');
assert.equal(typeof root.collectBirthplace, 'function');
assert.deepEqual(Object.keys(root).sort(), ${rootExports});
assert.deepEqual(Object.keys(otel).sort(), ${otelExports});
`,
    );

    run(process.execPath, ["commonjs.cjs"]);
  });

  it("loads every entry point from ESM", () => {
    writeFileSync(
      join(consumer, "esm.mjs"),
      `
import assert from 'node:assert/strict';
import * as root from 'birthplace';
import { collectBirthplace } from 'birthplace';
import * as otel from 'birthplace/otel';
import { toOtelAttributes, birthplaceDetector } from 'birthplace/otel';
import * as attributes from 'birthplace/attributes';
assert.deepEqual(Object.keys(attributes).sort(), ${attributesExports});
assert.deepEqual(attributes.toOtelAttributes({ schemaVersion: 1, service: { name: 'esm' }, source: {}, build: {} }), { 'service.name': 'esm' });
assert.equal(typeof collectBirthplace, 'function');
assert.deepEqual(Object.keys(root).sort(), ${rootExports});
assert.deepEqual(Object.keys(otel).sort(), ${otelExports});
assert.equal(typeof birthplaceDetector, 'function');
assert.deepEqual(toOtelAttributes({ schemaVersion: 1, service: { name: 'esm' }, source: {}, build: {} }), { 'service.name': 'esm' });
`,
    );

    run(process.execPath, ["esm.mjs"]);
  });

  it("installs the birthplace executable", () => {
    const installedManifest = JSON.parse(
      readFileSync(join(installed, "package.json"), "utf8"),
    ) as { bin: Record<string, string> };

    expect(Object.keys(installedManifest.bin)).toEqual(["birthplace"]);
    for (const target of Object.values(installedManifest.bin)) {
      run(process.execPath, [join(installed, target), "--help"]);
    }
  });

  it("keeps birthplace/attributes free of Node.js built-ins in both formats", () => {
    for (const entry of ["dist/attributes.mjs", "dist/attributes.cjs"]) {
      expect(builtinFreeGraph(entry).length).toBeGreaterThanOrEqual(1);
    }
    // The same walker notices the built-ins that the Node-only entry loads.
    expect(() => builtinFreeGraph("dist/otel.mjs")).toThrow(/node:/);
    expect(() => builtinFreeGraph("dist/otel.cjs")).toThrow(/node:/);
  });

  it("keeps the Git and build-machine collectors out of birthplace/otel", () => {
    // The root entry point is walked too, so a broken walker cannot pass by
    // finding nothing.
    for (const extension of ["cjs", "mjs"]) {
      const otelModules = collectExternalModules(
        join(installed, "dist", `otel.${extension}`),
      );
      expect(otelModules).toContain("fs");
      expect(otelModules).not.toContain("child_process");
      expect(otelModules).not.toContain("os");
      const rootModules = collectExternalModules(
        join(installed, "dist", `index.${extension}`),
      );
      expect(rootModules).toEqual(
        expect.arrayContaining(["child_process", "os"]),
      );
    }
  });

  it("generates and inspects metadata through the installed executable", () => {
    const file = join(consumer, "birthplace.json");
    generate(file, "--strict");

    expect(JSON.parse(run(bin, ["inspect", file, "--otel"]))).toMatchObject({
      "service.name": "birthplace-smoke-consumer",
      "service.version": "1.0.0",
      "vcs.ref.head.revision": "c".repeat(40),
    });
    const generated = JSON.parse(readFileSync(file, "utf8"));
    expect(generated.schemaVersion).toBe(1);
    expect("host" in generated).toBe(false);
  });

  it("records and exports the build machine through the installed executable", () => {
    const file = join(consumer, "birthplace-host.json");
    generate(file, "--host");

    const captured = JSON.parse(readFileSync(file, "utf8")).host;
    expect(typeof captured.arch).toBe("string");
    expect(["little", "big"]).toContain(captured.endianness);
    const attributes = JSON.parse(
      run(bin, ["inspect", file, "--otel", "--include-host-attributes"]),
    );
    expect(attributes["birthplace.host.arch"]).toBe(captured.arch);
    expect(attributes["birthplace.host.endianness"]).toBe(captured.endianness);
  });

  it.each([
    ["the generated birthplace file", [], "packaged JSON"],
    ["an imported birthplace object", ["--info"], "imported ESM"],
  ])(
    "carries %s into NodeSDK spans with the installed detector",
    (_name, flags, source) => {
      const result = runNodeSdkSmoke([
        join(installed, "dist", "cli.cjs"),
        join(installed, "dist", "otel.cjs"),
        ...flags,
      ]);

      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`NodeSDK smoke passed: CLI -> ${source}`);
    },
  );

  it("writes an ESM birthplace module with a default export only", () => {
    const file = join(consumer, "birthplace-default.mjs");
    generate(file, "--format", "esm", "--strict");

    const imported = JSON.parse(
      run(process.execPath, [
        "--input-type=module",
        "--eval",
        `import(${JSON.stringify(
          pathToFileURL(file).href,
        )}).then((namespace) => console.log(JSON.stringify({ keys: Object.keys(namespace), value: namespace.default })))`,
      ]),
    );
    expect(imported.keys).toEqual(["default"]);
    expect(imported.value.source.revision).toBe("c".repeat(40));
  });

  it("type-checks consumers of the declarations in both module formats", () => {
    const source = `import { collectBirthplace, type Birthplace, type BirthplaceHost } from 'birthplace';
import { toOtelAttributes, birthplaceDetector } from 'birthplace/otel';
const info: Birthplace = collectBirthplace({ timestamp: false, host: true });
const host: BirthplaceHost | undefined = info.host;
const count: number | undefined = host?.cpu?.logical?.count;
const value: string | number | boolean = toOtelAttributes(info, { includeHostAttributes: true })['birthplace.host.memory.total'];
birthplaceDetector({ file: new URL('file:///app/birthplace.json'), includeHostAttributes: true }).detect();
birthplaceDetector({ info, includeHostAttributes: true }).detect();
import { toOtelAttributes as map, BirthplaceError, type Birthplace as Info, type OtelAttributes } from 'birthplace/attributes';
const mapped: OtelAttributes = map(info as Info, { includeHostAttributes: true });
void [mapped, BirthplaceError];
export { count, value };
`;
    writeFileSync(join(consumer, "types.ts"), source);
    writeFileSync(join(consumer, "types.mts"), source);

    run(process.execPath, [
      compiler,
      "--noEmit",
      "--strict",
      "--module",
      "node16",
      "--moduleResolution",
      "node16",
      "--target",
      "es2020",
      "types.ts",
      "types.mts",
    ]);
  });

  it("types an imported ESM birthplace file as Birthplace with allowJs", () => {
    // The generated file's JSDoc annotation lets the import compile without a
    // cast.
    generate(join(consumer, "birthplace-typed.mjs"), "--format", "esm");
    writeFileSync(
      join(consumer, "imported.mts"),
      `import { toOtelAttributes, birthplaceDetector } from 'birthplace/otel';
import { toOtelAttributes as map } from 'birthplace/attributes';
import type { Birthplace } from 'birthplace';
import birthplace from './birthplace-typed.mjs';
const typed: Birthplace = birthplace;
birthplaceDetector({ info: birthplace }).detect();
void [toOtelAttributes(birthplace), map(birthplace), typed];
`,
    );

    run(process.execPath, [
      compiler,
      "--noEmit",
      "--strict",
      "--allowJs",
      "--module",
      "node16",
      "--moduleResolution",
      "node16",
      "--target",
      "es2020",
      "imported.mts",
    ]);
  });
});
