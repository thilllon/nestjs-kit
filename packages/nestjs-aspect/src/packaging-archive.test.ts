import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { type ModuleItem, parseSync } from "@swc/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Checks the tarball that `pnpm pack` writes and a consumer that installs it
// with pnpm, outside the workspace: the file list, the declarations and
// source maps, the names each entry exports, and a Nest application compiled
// from one TypeScript source as an ES module and as a CommonJS module.

const execute = promisify(execFile);
const packageRoot = join(__dirname, "..");
const fixtures = join(packageRoot, "fixtures", "packed-consumer");
const compiler = join(
  dirname(createRequire(__filename).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

interface Entry {
  import: { types: string; default: string };
  require: { types: string; default: string };
}

const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as {
  name: string;
  version: string;
  exports: Record<string, Entry | string>;
  devDependencies: Record<string, string>;
};

function entryOf(subpath: string): Entry {
  const target = manifest.exports[subpath];
  if (target === undefined || typeof target === "string") {
    throw new Error(`The export map has no conditional entry ${subpath}`);
  }
  return target;
}

// pnpm's bin shim for vitest exports NODE_PATH with the workspace's hoisted
// packages; the consumer must resolve only what it installed.
const { NODE_PATH: _workspacePath, ...inheritedEnvironment } = process.env;

/** The names each entry exports: `values` at run time, `types` in addition. */
const publicApi = {
  ".": {
    values: [
      "Advisor",
      "After",
      "AfterReturning",
      "AfterThrowing",
      "Around",
      "Aspect",
      "AspectConfigurationError",
      "AspectInspector",
      "AspectModule",
      "AspectNotReadyError",
      "AspectUsageError",
      "Before",
      "DeclareParents",
      "P",
      "createAnnotation",
      "introduced",
      "isAnnotation",
      "isIntroduced",
      "promiseAdapter",
    ],
    types: [
      "AccessorGuard",
      "Advice",
      "AdviceAdapter",
      "AdviceDecorator",
      "AdviceKind",
      "AdviceResult",
      "AdviceValue",
      "AdvisedMember",
      "AdvisorType",
      "AllShapes",
      "AndShape",
      "Annotation",
      "AnnotationLike",
      "AnnotationOptions",
      "AnyShape",
      "AnyShapes",
      "ArgMatcher",
      "ArgOf",
      "ArgsOf",
      "AspectAdvice",
      "AspectInstantiation",
      "AspectModuleOptions",
      "AspectOptions",
      "AspectReportLevel",
      "AsyncGuard",
      "BeanRef",
      "Class",
      "ClassFilter",
      "ClassRef",
      "DeclareParentsOptions",
      "Fn",
      "InterceptorContext",
      "IntroductionDecorator",
      "JP",
      "JoinPoint",
      "JoinPointKind",
      "JoinPointSignature",
      "MemberAdvisor",
      "MethodInterceptor",
      "MethodInvocation",
      "MethodKeys",
      "MethodMatcher",
      "MethodOrClassDecorator",
      "MethodRef",
      "NestAnnotation",
      "OrShape",
      "PJP",
      "Pointcut",
      "PointcutAdvisor",
      "PointcutFactory",
      "PointcutLike",
      "ProceedingJoinPoint",
      "ReturnValueAdapter",
      "ReturnValueAdapterRegistry",
      "Shape",
      "ShapeOf",
    ],
  },
  "./rxjs": { values: ["observableAdapter"], types: [] },
} as const satisfies Record<
  string,
  { values: readonly string[]; types: readonly string[] }
>;

type Subpath = keyof typeof publicApi;

const entries = Object.entries(manifest.exports).flatMap(([subpath, target]) =>
  typeof target === "string"
    ? []
    : [
        {
          subpath,
          specifier: posix.join(manifest.name, subpath),
          runtime: [target.import.default, target.require.default],
          declarations: [target.import.types, target.require.types],
        },
      ],
);

// Records the files the package's specifiers resolve to in a consumer process.
const resolutionTrace = `const { registerHooks } = require("node:module");
const { fileURLToPath } = require("node:url");
const name = ${JSON.stringify(manifest.name)};
const resolved = {};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (specifier === name || specifier.startsWith(name + "/")) {
      resolved[specifier] = fileURLToPath(result.url).split("/node_modules/" + name + "/").pop();
    }
    return result;
  },
});
process.on("exit", () => {
  process.stdout.write(JSON.stringify({ resolved }) + "\\n");
});
`;

let workspace: string;
let consumer: string;
/** The installed copy of the archive. */
let root: string;
let files: string[];

async function run(
  file: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  try {
    const { stdout } = await execute(file, args, {
      cwd,
      env: inheritedEnvironment,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 240_000,
    });
    return stdout;
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      throw new Error(
        `${file} ${args.join(" ")} failed in ${cwd}\n${String(error.stdout)}\n${String("stderr" in error ? error.stderr : "")}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function parseLines(stdout: string): unknown[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "nestjs-aspect-archive-"));
  await run("pnpm", ["pack", "--pack-destination", workspace], packageRoot);
  const tarball = join(workspace, `${manifest.name}-${manifest.version}.tgz`);
  files = (await run("tar", ["--list", "--gzip", "--file", tarball], workspace))
    .trim()
    .split("\n")
    .map((line) => line.replace(/^package\//, ""))
    .sort();

  // The peers at the versions the workspace store holds.
  const { devDependencies } = manifest;
  consumer = join(workspace, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      name: "packed-consumer",
      private: true,
      dependencies: {
        [manifest.name]: `file:${tarball}`,
        "@nestjs/common": devDependencies["@nestjs/common"],
        "@nestjs/core": devDependencies["@nestjs/core"],
        "reflect-metadata": devDependencies["reflect-metadata"],
        rxjs: devDependencies.rxjs,
        "@types/node": devDependencies["@types/node"],
      },
    }),
  );
  await writeFile(join(consumer, "trace-resolution.cjs"), resolutionTrace);
  // CI enables frozen lockfiles by default; a fresh consumer has no lockfile.
  await run(
    "pnpm",
    ["install", "--prefer-offline", "--no-frozen-lockfile"],
    consumer,
  );
  root = join(consumer, "node_modules", manifest.name);

  await Promise.all(
    ["app.mts", "app.cts"].map((file) =>
      copyFile(join(fixtures, "app.ts"), join(consumer, file)),
    ),
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        skipLibCheck: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        types: ["node"],
        outDir: "out",
      },
      files: ["app.mts", "app.cts"],
    }),
  );
  await run(
    process.execPath,
    [compiler, "--project", "tsconfig.json"],
    consumer,
  );
}, 300_000);

afterAll(async () => {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
});

// Relative specifiers of static imports, re-exports, import() and require().
const relativeSpecifier =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])(\.\.?\/[^"']+)\1/g;

/** `entry` and the files it reaches through relative imports. */
async function moduleGraph(entry: string): Promise<string[]> {
  const pending = [posix.normalize(entry)];
  const reached = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (reached.has(file)) {
      continue;
    }
    reached.add(file);
    const code = await readFile(join(root, file), "utf8");
    for (const [, , specifier = ""] of code.matchAll(relativeSpecifier)) {
      pending.push(posix.join(posix.dirname(file), specifier));
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

async function declaredNames(file: string): Promise<string[]> {
  const { body } = parseSync(await readFile(join(root, file), "utf8"), {
    syntax: "typescript",
  });
  return [...new Set(exportedNames(body))].sort();
}

describe("packed nestjs-aspect archive", () => {
  it("contains the build output, the README, the license and the manifest only", () => {
    expect(files.filter((file) => !file.startsWith("dist/"))).toEqual([
      "LICENSE",
      "README.md",
      "package.json",
    ]);
    expect(
      files.filter(
        (file) =>
          file.startsWith("dist/") &&
          !/^dist\/[\w-]+\.(?:[cm]js|d\.[cm]ts)(?:\.map)?$/.test(file),
      ),
    ).toEqual([]);
    expect(files).toEqual(
      expect.arrayContaining(
        entries.flatMap(({ runtime, declarations }) =>
          [...runtime, ...declarations].map((path) => posix.normalize(path)),
        ),
      ),
    );
  });

  it("names no Aop identifier and no path outside the package sources in its declarations and source maps", async () => {
    const problems: string[] = [];
    const forbidden = /aop|\bdocs\//i;
    for (const file of files) {
      if (/\.d\.[cm]ts$/.test(file)) {
        const code = await readFile(join(root, file), "utf8");
        const found = forbidden.exec(code);
        if (found) {
          problems.push(`${file} contains ${found[0]}`);
        }
      }
      if (!file.endsWith(".map")) {
        continue;
      }
      const map = JSON.parse(await readFile(join(root, file), "utf8")) as {
        sources: readonly (string | null)[];
        names?: readonly string[];
        sourcesContent?: readonly (string | null)[];
      };
      for (const source of map.sources) {
        if (
          source === null ||
          !/^\.\.\/src\/[\w.-]+\.ts$/.test(source) ||
          source.endsWith(".test.ts")
        ) {
          problems.push(`${file} maps ${String(source)}`);
        }
      }
      for (const text of [
        ...(map.names ?? []),
        ...(map.sourcesContent ?? []),
      ]) {
        const found = forbidden.exec(text ?? "");
        if (found) {
          problems.push(`${file} contains ${found[0]}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("lists every entry of the export map in the expected public API", () => {
    expect(Object.keys(publicApi).sort()).toEqual(
      entries.map(({ subpath }) => subpath).sort(),
    );
    expect(
      Object.entries(manifest.exports)
        .filter(([, target]) => typeof target === "string")
        .map(([subpath]) => subpath),
    ).toEqual(["./package.json"]);
  });

  it.each(entries)(
    "exports exactly the expected names from $subpath in both formats",
    async ({ subpath, specifier, declarations }) => {
      const api = publicApi[subpath as Subpath];
      const [output] = parseLines(
        await run(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import { createRequire } from "node:module";
const esm = await import(${JSON.stringify(specifier)});
const cjs = createRequire(import.meta.url)(${JSON.stringify(specifier)});
console.log(JSON.stringify({ esm: Object.keys(esm).sort(), cjs: Object.keys(cjs).sort() }));`,
          ],
          consumer,
        ),
      );
      expect(output).toEqual({ esm: api.values, cjs: api.values });

      const declared = [...api.values, ...api.types].sort();
      const [mts, cts] = await Promise.all(declarations.map(declaredNames));
      expect({ mts, cts }).toEqual({ mts: declared, cts: declared });
    },
  );

  it.each(["import", "require"] as const)(
    "does not load rxjs from the root entry through %s",
    async (condition) => {
      const graph = await moduleGraph(entryOf(".")[condition].default);
      const importing: string[] = [];
      for (const file of graph) {
        if (
          /["']rxjs(?:\/[^"']*)?["']/.test(
            await readFile(join(root, file), "utf8"),
          )
        ) {
          importing.push(file);
        }
      }
      expect(importing).toEqual([]);
      expect(graph).not.toContain(
        posix.normalize(entryOf("./rxjs")[condition].default),
      );
    },
  );
});

describe("consumer that installs the packed archive", () => {
  it.each([
    { format: "an ES module", file: "out/app.mjs", extension: "mjs" },
    { format: "a CommonJS module", file: "out/app.cjs", extension: "cjs" },
  ])(
    "weaves a Nest application compiled as $format, with aspects that inject a provider and the ./rxjs adapter",
    async ({ file, extension }) => {
      const [result, trace] = parseLines(
        await run(
          process.execPath,
          ["--require", "./trace-resolution.cjs", file],
          consumer,
        ),
      );

      expect(trace).toEqual({
        resolved: {
          "nestjs-aspect": `dist/index.${extension}`,
          "nestjs-aspect/rxjs": `dist/rxjs.${extension}`,
        },
      });
      expect(result).toEqual({
        price: "A:42",
        last: "B:2",
        // The stream is advised when it is subscribed, not when it is returned.
        beforeSubscription: 2,
        advisors: [
          ["AuditAspect", "record", "afterReturning"],
          ["RetryAspect", "retry", "around"],
        ],
        // A member that requires advice cannot be called on an instance of
        // the closed application.
        afterClose: "AspectConfigurationError",
        // Nothing is advised after the application closed.
        entries: [
          "retry 1",
          'QuoteService.price("A") -> A:42',
          'QuoteService.stream("B") -> B:2',
        ],
      });
    },
  );
});
