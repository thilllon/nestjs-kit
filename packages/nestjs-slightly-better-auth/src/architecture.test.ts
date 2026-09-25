import { readdirSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { type ImportDeclaration, parseSync } from "@swc/core";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

/**
 * Source-level fitness rules from design v7 §3.2, §11.7, §12.7 and §14.7. Runtime edges are
 * imports and re-exports that are not type-only. Type edges also include `import("…")` types.
 */
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const sourceFiles = readdirSync(sourceDirectory)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .sort();

const contracts = ["auth-contracts.ts", "auth-types.ts", "bridge-protocol.ts"];
const shared = [
  "auth-errors.ts",
  "auth-tokens.ts",
  "error-redactor.ts",
  "platform.ts",
  "set-cookies.ts",
];
const kernel = [
  "auth-core-module.ts",
  "auth-decorators.ts",
  "auth-exchange.ts",
  "auth-guard.ts",
  "auth-scope-interceptor.ts",
  "auth-service.ts",
  "authorization-evaluator.ts",
  "boot-validator.ts",
  "bridge-client.ts",
  "hook-binder.ts",
  "instance-registry.ts",
  "mount-coordinator.ts",
  "origin-check.ts",
  "policy-resolver.ts",
  "principal-readings.ts",
  "principal-resolver.ts",
  "request-scope.ts",
  "route-paths.ts",
  "route-planner.ts",
  "transport-registry.ts",
  "trusted-origins.ts",
];
const compositionRoot = [
  "auth-module-definition.ts",
  "auth-module.ts",
  "index.ts",
];
const pluginFiles = [
  "database-hook-dispatcher.ts",
  "hook-dispatcher.ts",
  "plugin.ts",
];
/** Unpublished fixtures that only tests import. */
const testSupport = [
  "jwt-extension-fixture.ts",
  "kafka-fixture.ts",
  "policy-kit-fixtures.ts",
  "test-fixtures.ts",
];
/**
 * Published test utilities (design v7 §2.2.16, §14.1 and §14.8). The conformance kits boot real
 * modules against their own Better Auth instance, so they reach the composition root, the plugin
 * and built-in units, which core never may.
 */
const testingKit: Readonly<Record<string, readonly string[]>> = {
  testing: ["testing.ts"],
  conformance: [
    "conformance-fixtures.ts",
    "conformance-http.ts",
    "conformance-policy-harness.ts",
    "conformance-policy-units.ts",
    "conformance-policy.ts",
    "conformance-principal.ts",
    "conformance-transport.ts",
    "testing-conformance.ts",
  ],
};
/** Built-in extension units (design v7 §3.1 E1/E2), each with its own files. */
const units: Readonly<Record<string, readonly string[]>> = {
  session: ["session-principal.ts"],
  http: ["http-transport.ts"],
  express: ["express-platform.ts", "express.ts"],
  fastify: ["fastify-platform.ts", "fastify.ts"],
  graphql: ["graphql-lineage.ts", "graphql-transport.ts", "graphql.ts"],
  websockets: [
    "socket-io-transport.ts",
    "websockets.ts",
    "ws-connection-auth.ts",
    "ws-transport.ts",
  ],
  rpc: ["microservices.ts", "rpc-carriers.ts", "rpc-transport.ts"],
  admin: ["admin.ts"],
  organization: ["organization.ts"],
  "api-key": ["api-key.ts"],
};
const coreFiles = [...contracts, ...shared, ...kernel];

/** Core files may reach extension code only through these reviewed edges. */
const coreExceptions = [
  {
    edge: "auth-service.ts -> session-principal.ts (runtime)",
    reason:
      "BetterAuthService.getSession() is the session unit's kind-constrained projection; " +
      "the session unit owns SESSION_REQUIRED (design v7 §7.8 item 5).",
  },
  {
    edge: "auth-types.ts -> index.ts (type)",
    reason:
      "PrincipalKinds is declared by the public root module, which subpath augmentations " +
      "target by package self-reference (design v7 §11.7).",
  },
];

/** Kernel literals that match an extension name but carry a different meaning. */
const kernelLiteralExceptions = [
  {
    file: "hook-binder.ts",
    literal: "http",
    count: 1,
    reason:
      "HookOptions.calls mode for requests routed through auth.handler (design v7 §2.2.3).",
  },
  {
    file: "hook-binder.ts",
    literal: "session",
    count: 1,
    reason:
      "better-auth core model name in DatabaseHookTarget (design v7 §10.6).",
  },
  {
    file: "trusted-origins.ts",
    literal: "http",
    count: 1,
    reason:
      "better-auth's dynamic baseURL protocol value, mirrored from getTrustedOrigins() (design v7 §7.10).",
  },
];

const requiredPeers = [
  "@nestjs/common",
  "@nestjs/core",
  "better-auth/api",
  "rxjs",
];
interface EntryPolicy {
  readonly specifiers: readonly string[];
  readonly nodeBuiltins: boolean;
  /** Groups besides contracts, shared helpers and kernel that the runtime graph may reach. */
  readonly groups: readonly string[];
}
/** Runtime imports each published entry may reach (design v7 §2.1 and §12.7). */
const entryPolicies: Readonly<Record<string, EntryPolicy>> = {
  ".": {
    specifiers: requiredPeers,
    nodeBuiltins: true,
    groups: ["composition root", "unit:session", "unit:http"],
  },
  "./plugin": {
    specifiers: ["better-auth/api", "better-auth/cookies", "defu"],
    nodeBuiltins: false,
    groups: ["plugin"],
  },
  "./platform": { specifiers: [], nodeBuiltins: true, groups: [] },
  "./express": {
    specifiers: [...requiredPeers, "path-to-regexp"],
    nodeBuiltins: true,
    groups: ["unit:express"],
  },
  "./fastify": {
    specifiers: requiredPeers,
    nodeBuiltins: true,
    groups: ["unit:fastify"],
  },
  // graphql is a peer of @nestjs/graphql; the unit's sources never import it.
  "./graphql": {
    specifiers: [...requiredPeers, "@nestjs/graphql"],
    nodeBuiltins: true,
    groups: ["unit:graphql"],
  },
  "./websockets": {
    specifiers: [...requiredPeers, "@nestjs/websockets"],
    nodeBuiltins: true,
    groups: ["unit:websockets"],
  },
  "./microservices": {
    specifiers: [...requiredPeers, "@nestjs/microservices"],
    nodeBuiltins: true,
    groups: ["unit:rpc"],
  },
  "./admin": {
    specifiers: requiredPeers,
    nodeBuiltins: true,
    groups: ["unit:admin"],
  },
  "./organization": {
    specifiers: requiredPeers,
    nodeBuiltins: true,
    groups: ["unit:organization"],
  },
  "./api-key": {
    specifiers: [...requiredPeers, "better-auth/plugins/access"],
    nodeBuiltins: true,
    groups: ["unit:api-key"],
  },
  // @nestjs/testing stays a type-only import of ./testing.
  "./testing": {
    specifiers: requiredPeers,
    nodeBuiltins: true,
    groups: ["kit:testing"],
  },
  // The kits build a memory-adapter instance with the nestjs() plugin and boot the root module.
  "./testing/conformance": {
    specifiers: [
      ...requiredPeers,
      "@nestjs/testing",
      "better-auth",
      "better-auth/adapters/memory",
      "better-auth/cookies",
      "better-auth/plugins",
      "defu",
    ],
    nodeBuiltins: true,
    groups: [
      "composition root",
      "plugin",
      "unit:session",
      "unit:http",
      "unit:admin",
      "unit:organization",
      "kit:testing",
      "kit:conformance",
    ],
  },
};
const extensionNames = new Set([
  "express",
  "fastify",
  "graphql",
  "apollo",
  "mercurius",
  "socket.io",
  "ws",
  "rpc",
  "http",
  "session",
  "admin",
  "organization",
  "api-key",
]);

interface SourceModule {
  /** Source file name → whether any edge to it is a runtime edge. */
  readonly internal: ReadonlyMap<string, boolean>;
  /** Bare or `node:` specifier → whether any edge to it is a runtime edge. */
  readonly external: ReadonlyMap<string, boolean>;
  readonly unresolved: readonly string[];
  readonly literals: readonly string[];
  readonly augmentations: readonly string[];
  readonly syntax: readonly string[];
}

const functionScopes = new Set([
  "ArrowFunctionExpression",
  "ClassMethod",
  "Constructor",
  "FunctionDeclaration",
  "FunctionExpression",
  "GetterProperty",
  "MethodProperty",
  "PrivateMethod",
  "SetterProperty",
]);

type AstNode = Readonly<Record<string, unknown>> & { readonly type: string };

function visit(
  value: unknown,
  callback: (node: AstNode, insideFunction: boolean) => void,
  insideFunction = false,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, callback, insideFunction);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  const node = value as Readonly<Record<string, unknown>>;
  let inside = insideFunction;
  if (typeof node.type === "string") {
    callback(node as AstNode, insideFunction);
    inside ||= functionScopes.has(node.type);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key !== "span") {
      visit(child, callback, inside);
    }
  }
}

function stringValue(value: unknown): string | undefined {
  const node = value as { type?: unknown; value?: unknown } | undefined;
  return node?.type === "StringLiteral" && typeof node.value === "string"
    ? node.value
    : undefined;
}

function isTypeOnlyImport(declaration: ImportDeclaration): boolean {
  return (
    declaration.typeOnly ||
    (declaration.specifiers.length > 0 &&
      declaration.specifiers.every(
        (specifier) =>
          specifier.type === "ImportSpecifier" && specifier.isTypeOnly,
      ))
  );
}

function parseModule(file: string): SourceModule {
  const program = parseSync(readFileSync(join(sourceDirectory, file), "utf8"), {
    syntax: "typescript",
    decorators: true,
    target: "es2022",
  });
  const internal = new Map<string, boolean>();
  const external = new Map<string, boolean>();
  const unresolved: string[] = [];
  const literals: string[] = [];
  const augmentations: string[] = [];
  const syntax = new Set<string>();
  const addEdge = (specifier: string, runtime: boolean): void => {
    if (!specifier.startsWith(".")) {
      external.set(specifier, (external.get(specifier) ?? false) || runtime);
      return;
    }
    const target = posix
      .normalize(posix.join(posix.dirname(file), specifier))
      .replace(/\.js$/, ".ts");
    if (!sourceFiles.includes(target)) {
      unresolved.push(specifier);
      return;
    }
    internal.set(target, (internal.get(target) ?? false) || runtime);
  };
  for (const item of program.body) {
    switch (item.type) {
      case "ImportDeclaration":
        addEdge(item.source.value, !isTypeOnlyImport(item));
        break;
      case "ExportAllDeclaration":
        addEdge(item.source.value, true);
        break;
      case "ExportNamedDeclaration":
        if (item.source) {
          addEdge(
            item.source.value,
            !item.typeOnly &&
              !item.specifiers.every(
                (specifier) =>
                  specifier.type === "ExportSpecifier" && specifier.isTypeOnly,
              ),
          );
        }
        for (const specifier of item.specifiers) {
          const exported =
            specifier.type === "ExportSpecifier"
              ? (specifier.exported ?? specifier.orig)
              : specifier.type === "ExportNamespaceSpecifier"
                ? specifier.name
                : specifier.exported;
          if (exported.value === "default") {
            syntax.add("default export");
          }
        }
        break;
      case "ExportDefaultDeclaration":
      case "ExportDefaultExpression":
        syntax.add("default export");
        break;
      case "TsImportEqualsDeclaration":
        if (item.moduleRef.type === "TsExternalModuleReference") {
          syntax.add("import = require()");
        }
        break;
      case "TsModuleDeclaration": {
        const name = stringValue(item.id);
        if (name !== undefined) {
          augmentations.push(name);
        }
        break;
      }
    }
  }
  visit(program.body, (node, insideFunction) => {
    switch (node.type) {
      case "StringLiteral":
        literals.push(String(node.value));
        break;
      case "TemplateLiteral": {
        // Template literal types carry `types` where expressions carry `expressions`.
        const quasis = node.quasis as readonly { cooked?: string }[];
        const holes = (node.expressions ?? node.types) as readonly unknown[];
        if (holes.length === 0) {
          literals.push(quasis.map((quasi) => quasi.cooked ?? "").join(""));
        }
        break;
      }
      case "TsImportType": {
        const specifier = stringValue(node.argument);
        if (specifier !== undefined) {
          addEdge(specifier, false);
        }
        break;
      }
      case "CallExpression": {
        const callee = node.callee as AstNode;
        if (callee.type === "Import") {
          syntax.add("dynamic import()");
        } else if (callee.type === "Identifier" && callee.value === "require") {
          syntax.add("require()");
        }
        break;
      }
      case "Identifier":
        if (node.value === "createRequire" || node.value === "loadPackage") {
          syntax.add(String(node.value));
        }
        break;
      case "AwaitExpression":
        if (!insideFunction) {
          syntax.add("top-level await");
        }
        break;
      case "ForOfStatement":
        // SWC sets `await` to false for a plain for...of; its types declare an optional span.
        if (!insideFunction && node.await) {
          syntax.add("top-level await");
        }
        break;
    }
  });
  return {
    internal,
    external,
    unresolved,
    literals,
    augmentations,
    syntax: [...syntax],
  };
}

const modules = new Map(sourceFiles.map((file) => [file, parseModule(file)]));
const publishedFiles = sourceFiles.filter(
  (file) => !testSupport.includes(file),
);

function moduleOf(file: string): SourceModule {
  const module = modules.get(file);
  if (!module) {
    throw new Error(`Unknown source file: ${file}`);
  }
  return module;
}

function groupOf(file: string): string {
  if (coreFiles.includes(file)) {
    return "core";
  }
  if (compositionRoot.includes(file)) {
    return "composition root";
  }
  if (pluginFiles.includes(file)) {
    return "plugin";
  }
  if (testSupport.includes(file)) {
    return "test support";
  }
  const kit = Object.entries(testingKit).find(([, files]) =>
    files.includes(file),
  );
  if (kit) {
    return `kit:${kit[0]}`;
  }
  const unit = Object.entries(units).find(([, files]) => files.includes(file));
  return unit ? `unit:${unit[0]}` : "unclassified";
}

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@")
    ? parts.slice(0, 2).join("/")
    : (parts[0] ?? specifier);
}

function reach(
  entry: string,
  includeTypes: boolean,
): { readonly files: readonly string[]; readonly external: readonly string[] } {
  const files = new Set<string>();
  const external = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    const module = moduleOf(file);
    for (const [target, runtime] of module.internal) {
      if (includeTypes || runtime) {
        pending.push(target);
      }
    }
    for (const [specifier, runtime] of module.external) {
      if (includeTypes || runtime) {
        external.add(specifier);
      }
    }
  }
  return { files: [...files].sort(), external: [...external].sort() };
}

const entries = Object.entries(manifest.exports).flatMap(
  ([subpath, conditions]) => {
    if (typeof conditions === "string") {
      return [];
    }
    // Nested outputs map to flat hyphenated sources: dist/testing/conformance → testing-conformance.ts.
    const outputs = new Set(
      Object.values(conditions).map(({ default: output }) =>
        output
          .replace(/^\.\/dist\//, "")
          .replace(/\.(mjs|cjs)$/, "")
          .replaceAll("/", "-"),
      ),
    );
    return [{ subpath, source: `${[...outputs].join("|")}.ts` }];
  },
);

describe("authentication source architecture", () => {
  it("parses every relative import to a flat source file", () => {
    expect(
      sourceFiles.flatMap((file) =>
        moduleOf(file).unresolved.map((specifier) => `${file} -> ${specifier}`),
      ),
    ).toEqual([]);
  });

  it("assigns every non-test source file to exactly one boundary group", () => {
    const declared = [
      ...coreFiles,
      ...compositionRoot,
      ...pluginFiles,
      ...testSupport,
      ...Object.values(testingKit).flat(),
      ...Object.values(units).flat(),
    ].sort();
    expect(
      declared,
      "Classify each new source file in exactly one group.",
    ).toEqual(sourceFiles);
  });

  it("keeps contracts, shared helpers and kernel files independent of extensions", () => {
    const edges = coreFiles.flatMap((file) =>
      [...moduleOf(file).internal]
        .filter(([target]) => groupOf(target) !== "core")
        .map(
          ([target, runtime]) =>
            `${file} -> ${target} (${runtime ? "runtime" : "type"})`,
        ),
    );
    expect(edges.sort()).toEqual(coreExceptions.map(({ edge }) => edge).sort());
  });

  it("keeps each extension unit independent of other units and of the composition root", () => {
    const violations = Object.entries(units).flatMap(([unit, files]) =>
      files.flatMap((file) =>
        [...moduleOf(file).internal.keys()]
          .filter(
            (target) => groupOf(target) !== "core" && !files.includes(target),
          )
          .map((target) => `${unit}: ${file} -> ${target}`),
      ),
    );
    expect(violations).toEqual([]);
  });

  it("keeps unpublished test support out of runtime and type edges of published files", () => {
    expect(
      publishedFiles.flatMap((file) =>
        [...moduleOf(file).internal.keys()]
          .filter((target) => groupOf(target) === "test support")
          .map((target) => `${file} -> ${target}`),
      ),
    ).toEqual([]);
  });

  it("keeps plugin files inside better-auth, defu and the bridge protocol", () => {
    const allowedRuntimeFiles = [...pluginFiles, "bridge-protocol.ts"];
    const allowedTypeFiles = [...pluginFiles, ...contracts];
    const allowedRuntime = ["better-auth/api", "better-auth/cookies", "defu"];
    const violations = pluginFiles.flatMap((file) => {
      const module = moduleOf(file);
      return [
        ...[...module.internal]
          .filter(([target, runtime]) =>
            runtime
              ? !allowedRuntimeFiles.includes(target)
              : !allowedTypeFiles.includes(target),
          )
          .map(([target]) => `${file} -> ${target}`),
        ...[...module.external]
          .filter(([specifier, runtime]) =>
            runtime
              ? !allowedRuntime.includes(specifier)
              : specifier !== "better-auth" &&
                !allowedRuntime.includes(specifier),
          )
          .map(([specifier]) => `${file} -> ${specifier}`),
      ];
    });
    expect(violations).toEqual([]);
  });

  it("keeps platform, transport, principal-kind and policy names out of kernel files", () => {
    const found: Record<string, Record<string, number>> = {};
    for (const file of kernel) {
      for (const literal of moduleOf(file).literals) {
        if (
          extensionNames.has(literal) ||
          literal.startsWith(`${manifest.name}/`)
        ) {
          const counts = found[file] ?? {};
          counts[literal] = (counts[literal] ?? 0) + 1;
          found[file] = counts;
        }
      }
    }
    const allowed: Record<string, Record<string, number>> = {};
    for (const { file, literal, count } of kernelLiteralExceptions) {
      allowed[file] = { ...allowed[file], [literal]: count };
    }
    expect(found).toEqual(allowed);
  });

  it("maps every package export to one source entry with an import policy", () => {
    expect(
      entries.filter(({ source }) => !sourceFiles.includes(source)),
    ).toEqual([]);
    expect(entries.map(({ subpath }) => subpath).sort()).toEqual(
      Object.keys(entryPolicies).sort(),
    );
  });

  it.each(entries)(
    "limits the runtime graph of $subpath to its allowed peers and units",
    ({ subpath, source }) => {
      const policy = entryPolicies[subpath];
      if (!policy) {
        throw new Error(`Declare an import policy for ${subpath}.`);
      }
      const graph = reach(source, false);
      expect({
        external: graph.external.filter(
          (specifier) =>
            !(
              policy.specifiers.includes(specifier) ||
              (policy.nodeBuiltins && isBuiltin(specifier))
            ),
        ),
        files: graph.files.filter((file) => {
          const group = groupOf(file);
          return group !== "core" && !policy.groups.includes(group);
        }),
      }).toEqual({ external: [], files: [] });
    },
  );

  it("keeps the root runtime and declaration graph free of optional peers, subpath units and test code", () => {
    const graph = reach("index.ts", true);
    expect({
      packages: [...new Set(graph.external.map(packageOf))].filter(
        (name) =>
          !isBuiltin(name) &&
          !["@nestjs/common", "@nestjs/core", "better-auth", "rxjs"].includes(
            name,
          ),
      ),
      files: graph.files.filter(
        (file) =>
          !["core", "composition root", "unit:session", "unit:http"].includes(
            groupOf(file),
          ),
      ),
    }).toEqual({ packages: [], files: [] });
  });

  it("declares every package that a published entry reaches in runtime or declaration code", () => {
    const declared = new Set([
      ...Object.keys(manifest.peerDependencies),
      ...Object.keys(manifest.dependencies),
    ]);
    const undeclared = entries.flatMap(({ subpath, source }) =>
      reach(source, true)
        .external.filter(
          (specifier) =>
            !isBuiltin(specifier) && !declared.has(packageOf(specifier)),
        )
        .map((specifier) => `${subpath} -> ${specifier}`),
    );
    expect(undeclared).toEqual([]);
  });

  it("imports Nest packages and SDKs through their public entries only", () => {
    const external = sourceFiles.flatMap((file) =>
      [...moduleOf(file).external].map(([specifier, runtime]) => ({
        file,
        specifier,
        runtime,
      })),
    );
    // Nest subpaths, `@nestjs/core/internal` included, are not public API (design v7 §12.7).
    expect(
      external
        .filter(({ specifier }) => /^@nestjs\/[^/]+\/./.test(specifier))
        .map(({ file, specifier }) => `${file} -> ${specifier}`),
    ).toEqual([]);
    // Entry policies confine the conformance kit's instance-building imports to ./testing/conformance.
    const publicRuntime = [
      "better-auth",
      "better-auth/adapters/memory",
      "better-auth/api",
      "better-auth/cookies",
      "better-auth/plugins",
      "better-auth/plugins/access",
    ];
    const publicTypes = ["better-auth", "better-auth/api"];
    expect(
      external
        .filter(
          ({ file, specifier, runtime }) =>
            publishedFiles.includes(file) &&
            (/^(better-call|@better-auth)(\/|$)/.test(specifier) ||
              (packageOf(specifier) === "better-auth" &&
                !(runtime ? publicRuntime : publicTypes).includes(specifier))),
        )
        .map(({ file, specifier }) => `${file} -> ${specifier}`),
    ).toEqual([]);
  });

  it("uses static named exports without loaders, top-level await or foreign augmentations", () => {
    expect(
      publishedFiles.flatMap((file) => {
        const module = moduleOf(file);
        return [
          ...module.syntax,
          ...module.augmentations
            .filter((name) => name !== manifest.name)
            .map((name) => `declare module "${name}"`),
        ].map((finding) => `${file}: ${finding}`);
      }),
    ).toEqual([]);
  });
});
