import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type ModuleItem, parseSync } from "@swc/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import publicApi from "../fixtures/public-api.json" with { type: "json" };
import manifest from "../package.json" with { type: "json" };

// Checks the tarball that `pnpm pack` writes: its file list, source maps,
// license and manifest, the names each entry exports, and the module shape of
// every emitted chunk.

const execute = promisify(execFile);
// pnpm's bin shim for vitest exports NODE_PATH with the workspace's hoisted
// packages; the extracted archive resolves only through its own node_modules.
const { NODE_PATH: _workspacePath, ...inheritedEnvironment } = process.env;
const packageRoot = fileURLToPath(new URL("../", import.meta.url));

// Names that must never reach a public entry, whatever the allow-list says.
const internalNames = [
  "MODULE_OPTIONS_TOKEN",
  "ConfigurableModuleClass",
  "OPTIONS_TYPE",
  "ASYNC_OPTIONS_TYPE",
  "moduleDefinition",
  "default",
];

type Subpath = keyof typeof publicApi;

const entries = Object.entries(manifest.exports).flatMap(([subpath, target]) =>
  typeof target === "string"
    ? []
    : [
        {
          subpath,
          esm: target.import.default,
          cjs: target.require.default,
          declarations: [target.import.types, target.require.types],
        },
      ],
);

let workspace: string;
let root: string;
let files: string[];

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "nsba-archive-"));
  await execute("pnpm", ["pack", "--pack-destination", workspace], {
    cwd: packageRoot,
    timeout: 120_000,
  });
  const tarball = join(workspace, `${manifest.name}-${manifest.version}.tgz`);
  const { stdout } = await execute("tar", [
    "--list",
    "--gzip",
    "--file",
    tarball,
  ]);
  files = stdout
    .trim()
    .split("\n")
    .map((line) => line.replace(/^package\//, ""))
    .sort();
  await execute("tar", [
    "--extract",
    "--gzip",
    "--file",
    tarball,
    "--directory",
    workspace,
  ]);
  root = join(workspace, "package");
  // The runtime checks resolve the peers from the workspace installation.
  await symlink(
    join(packageRoot, "node_modules"),
    join(root, "node_modules"),
    "dir",
  );
}, 180_000);

afterAll(async () => {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
});

// Relative specifiers of static imports, re-exports, import() and require().
const relativeSpecifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])(\.\.?\/[^"']+)\1/g;
const sourceMappingUrl = /^\/\/# sourceMappingURL=(\S+)$/m;
const declarationFile = /\.d\.[cm]?ts$/;

// The files the export map reaches through relative imports and source-map
// comments. A declaration file names its sibling runtime file, as in
// `from "./chunk.mjs"`, and TypeScript reads `./chunk.d.mts` for it.
async function reachableFiles(): Promise<string[]> {
  const pending = Object.values(manifest.exports)
    .flatMap((target) =>
      typeof target === "string"
        ? [target]
        : Object.values(target).flatMap(({ types, default: path }) => [
            types,
            path,
          ]),
    )
    .map((path) => posix.normalize(path));
  const reached = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) {
      continue;
    }
    reached.add(file);
    if (!/\.(?:[cm]?js|d\.[cm]?ts)$/.test(file)) {
      continue;
    }
    const code = await readFile(join(root, file), "utf8");
    const directory = posix.dirname(file);
    for (const [, , specifier = ""] of code.matchAll(relativeSpecifier)) {
      const target = posix.join(directory, specifier);
      pending.push(
        declarationFile.test(file)
          ? target.replace(/\.([cm]?)js$/, ".d.$1ts")
          : target,
      );
    }
    const map = sourceMappingUrl.exec(code)?.[1];
    if (map !== undefined) {
      pending.push(posix.join(directory, map));
    }
  }
  return [...reached];
}

function exportedNames(body: readonly ModuleItem[]): string[] {
  return body.flatMap((item): string[] => {
    switch (item.type) {
      case "ExportDeclaration": {
        const { declaration } = item;
        switch (declaration.type) {
          case "ClassDeclaration":
          case "FunctionDeclaration":
            return [declaration.identifier.value];
          case "VariableDeclaration":
            return declaration.declarations.map((declarator) =>
              declarator.id.type === "Identifier"
                ? declarator.id.value
                : `<${declarator.id.type}>`,
            );
          default:
            return [declaration.id.value];
        }
      }
      case "ExportNamedDeclaration":
        return item.specifiers.map((specifier) => {
          switch (specifier.type) {
            case "ExportSpecifier":
              return (specifier.exported ?? specifier.orig).value;
            case "ExportNamespaceSpecifier":
              return specifier.name.value;
            default:
              return "default";
          }
        });
      case "ExportDefaultDeclaration":
      case "ExportDefaultExpression":
        return ["default"];
      case "ExportAllDeclaration":
        return [`* from ${item.source.value}`];
      case "TsExportAssignment":
        return ["export ="];
      default:
        return [];
    }
  });
}

async function declarationExports(file: string): Promise<string[]> {
  const { body } = parseSync(await readFile(join(root, file), "utf8"), {
    syntax: "typescript",
  });
  return exportedNames(body);
}

async function node(script: string): Promise<unknown> {
  const { stdout } = await execute(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      cwd: root,
      env: { ...inheritedEnvironment, NODE_ENV: "test" },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  return JSON.parse(stdout);
}

describe("packed authentication archive", () => {
  it("contains only the manifest, README, license and the files the export map reaches", async () => {
    const expected = [...(await reachableFiles()), "README.md", "LICENSE"];
    expect(files).toEqual(expected.sort());
  });

  // Every map names only this package's non-test sources by relative path. The
  // archive ships no sources, so runtime maps embed them for debuggers.
  // rolldown-plugin-dts drops the content of declaration maps; editors fall
  // back to the declarations when the source file is absent.
  it("maps only the package's own sources and embeds them in runtime maps", async () => {
    const sources = new Set(
      (await readdir(join(packageRoot, "src")))
        .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
        .map((file) => `src/${file}`),
    );
    const problems: string[] = [];
    for (const file of files.filter((path) => path.endsWith(".map"))) {
      const runtime = /\.[cm]js\.map$/.test(file);
      const map = JSON.parse(await readFile(join(root, file), "utf8")) as {
        file?: string;
        sourceRoot?: string;
        sources: readonly (string | null)[];
        sourcesContent?: readonly (string | null)[];
      };
      if (map.file !== posix.basename(file, ".map")) {
        problems.push(`${file} maps ${String(map.file)}`);
      }
      map.sources.forEach((source, index) => {
        const resolved = posix.normalize(
          posix.join(posix.dirname(file), map.sourceRoot ?? "", source ?? ""),
        );
        if (source === null || /^(?:\/|[a-z][\w+.-]*:)/i.test(source)) {
          problems.push(`${file} names the source ${String(source)}`);
        } else if (!sources.has(resolved)) {
          problems.push(`${file} maps ${resolved}, not package source`);
        }
        if (runtime && typeof map.sourcesContent?.[index] !== "string") {
          problems.push(`${file} does not embed ${resolved}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("ships the declared MIT license and the workspace manifest unchanged", async () => {
    const [license, workspaceLicense, packed] = await Promise.all([
      readFile(join(root, "LICENSE"), "utf8"),
      readFile(join(packageRoot, "LICENSE"), "utf8"),
      readFile(join(root, "package.json"), "utf8"),
    ]);
    expect(manifest.license).toBe("MIT");
    expect(license).toBe(workspaceLicense);
    expect(license).toMatch(/^Copyright \d{4} \S/);
    expect(license).toContain(
      "Permission is hereby granted, free of charge, to any person obtaining a copy of this software",
    );
    expect(JSON.parse(packed)).toEqual(manifest);
    expect(packed).not.toMatch(/"(?:workspace|catalog|link):/);
  });

  it("lists one allow-list row per entry and no internal name", () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      entries.map(({ subpath }) => subpath).sort(),
    );
    const leaked = Object.entries(publicApi).flatMap(([subpath, api]) =>
      [...api.values, ...api.types]
        .filter((name) => internalNames.includes(name))
        .map((name) => `${subpath} ${name}`),
    );
    expect(leaked).toEqual([]);
  });

  it.each(entries)(
    "exports exactly the allow-listed names from $subpath",
    async ({ subpath, esm, cjs, declarations }) => {
      const api = publicApi[subpath as Subpath];
      const runtime = await node(`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const esm = await import(${JSON.stringify(esm)});
const cjs = require(${JSON.stringify(cjs)});
console.log(JSON.stringify({ esm: Object.keys(esm).sort(), cjs: Object.keys(cjs).sort() }));`);
      expect(runtime).toEqual({ esm: api.values, cjs: api.values });
      const [mts, cts] = await Promise.all(
        declarations.map(async (file) =>
          [...new Set(await declarationExports(file))].sort(),
        ),
      );
      const declared = [...api.values, ...api.types].sort();
      expect({ mts, cts }).toEqual({ mts: declared, cts: declared });
    },
    60_000,
  );

  it("emits no default export, export assignment or star re-export in any declaration", async () => {
    const found = await Promise.all(
      files
        .filter((file) => declarationFile.test(file))
        .map(async (file) =>
          (await declarationExports(file))
            .filter(
              (name) =>
                name === "default" ||
                name === "export =" ||
                name.startsWith("* from"),
            )
            .map((name) => `${file}: ${name}`),
        ),
    );
    expect(found.flat()).toEqual([]);
  });

  it("loads every emitted chunk synchronously without a default export", async () => {
    // require() of an ES module graph that uses top-level await throws
    // ERR_REQUIRE_ASYNC_MODULE, and CommonJS rejects top-level await outright.
    const chunks = files.filter((file) => /\.[cm]js$/.test(file));
    const result = await node(`import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const outcomes = {};
for (const file of ${JSON.stringify(chunks)}) {
  try {
    const loaded = require("./" + file);
    outcomes[file] = Object.hasOwn(loaded, "default") ? "default export" : "loaded";
  } catch (error) {
    outcomes[file] = error.code + " " + error.message.split("\\n")[0];
  }
}
console.log(JSON.stringify(outcomes));`);
    expect(result).toEqual(
      Object.fromEntries(chunks.map((file) => [file, "loaded"])),
    );
  }, 60_000);
});
