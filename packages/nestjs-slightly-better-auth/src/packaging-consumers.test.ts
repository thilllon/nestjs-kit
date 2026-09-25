import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

// Consumers that install the packed tarball with pnpm, outside the workspace.
// The floor rows install exact versions that the workspace store already holds;
// the current rows let pnpm pick the newest versions inside the peer ranges.

const execute = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtures = fileURLToPath(
  new URL("../fixtures/packed-consumer/", import.meta.url),
);
const compiler = fileURLToPath(
  new URL("../bin/tsc", import.meta.resolve("typescript")),
);

type OptionalPeer = keyof typeof manifest.peerDependenciesMeta;
type Peer = keyof typeof manifest.peerDependencies;
type Row = "floor" | "current";

const corePeers = [
  "@nestjs/common",
  "@nestjs/core",
  "better-auth",
  "reflect-metadata",
  "rxjs",
] as const satisfies readonly Exclude<Peer, OptionalPeer>[];

// The entries that need each optional peer at runtime; every other entry loads without it.
const optionalPeerEntries: Record<OptionalPeer, readonly string[]> = {
  "@nestjs/graphql": ["graphql"],
  "@nestjs/microservices": ["microservices"],
  "@nestjs/testing": ["testing/conformance"],
  "@nestjs/websockets": ["websockets"],
  graphql: ["graphql"],
};

const entries = Object.entries(manifest.exports).flatMap(([subpath, target]) =>
  typeof target === "string"
    ? []
    : [
        {
          name: subpath === "." ? "index" : subpath.slice("./".length),
          specifier:
            subpath === "."
              ? manifest.name
              : `${manifest.name}/${subpath.slice("./".length)}`,
          cjs: target.require.default.slice("./".length),
        },
      ],
);

function floorOf(range: string): string {
  const version = /\d+\.\d+\.\d+/.exec(range)?.[0];
  if (version === undefined) {
    throw new Error(`No floor version in the peer range ${range}`);
  }
  return version;
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function coreDependencies(row: Row): Record<string, string> {
  const version = (range: string) => (row === "floor" ? floorOf(range) : range);
  return {
    ...Object.fromEntries(
      corePeers.map((peer) => [peer, version(manifest.peerDependencies[peer])]),
    ),
    "@nestjs/platform-express": version(
      manifest.peerDependencies["@nestjs/core"],
    ),
    "@types/node": manifest.devDependencies["@types/node"],
  };
}

// Optional-peer consumers: a row's core set plus one subpath's peers and the
// packages its boot needs.
const optionalConsumers = {
  graphql: {
    peers: ["@nestjs/graphql", "graphql"],
    extras: ["@nestjs/apollo", "@apollo/server", "@as-integrations/express5"],
  },
  websockets: { peers: ["@nestjs/websockets"], extras: [] },
  microservices: { peers: ["@nestjs/microservices"], extras: [] },
  "testing/conformance": { peers: ["@nestjs/testing"], extras: [] },
} as const satisfies Record<
  string,
  {
    peers: readonly OptionalPeer[];
    extras: readonly (keyof typeof manifest.devDependencies)[];
  }
>;
type OptionalConsumer = keyof typeof optionalConsumers;

// Records how the package's specifiers resolve. With CONSUMER_CJS_ARTIFACTS=1 it
// resolves them without the module-sync condition, so require() reaches the
// real CommonJS artifacts the way a resolver without module-sync does.
const resolutionTrace = `const { registerHooks } = require("node:module");
const { fileURLToPath } = require("node:url");
const name = ${JSON.stringify(manifest.name)};
const withoutModuleSync = process.env.CONSUMER_CJS_ARTIFACTS === "1";
const resolved = {};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier !== name && !specifier.startsWith(name + "/")) {
      return nextResolve(specifier, context);
    }
    const kind = context.conditions.includes("require") ? "require" : "import";
    const result = nextResolve(
      specifier,
      withoutModuleSync
        ? { ...context, conditions: context.conditions.filter((condition) => condition !== "module-sync") }
        : context,
    );
    resolved[kind + " " + specifier] = fileURLToPath(result.url).split("/" + name + "/").pop();
    return result;
  },
});
process.on("exit", () => {
  process.stdout.write(JSON.stringify({ resolved }) + "\\n");
});
`;

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
      env: { ...inheritedEnvironment, ...options.env },
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

async function install(
  name: string,
  dependencies: Record<string, string>,
): Promise<string> {
  const directory = join(workspace, name.replaceAll("/", "-"));
  await mkdir(directory);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: `packed-consumer-${name.replaceAll("/", "-")}`,
      private: true,
      dependencies: { [manifest.name]: `file:${tarball}`, ...dependencies },
    }),
  );
  await writeFile(join(directory, "trace-resolution.cjs"), resolutionTrace);
  // Like the repository, deny the Apollo protobuf install script the GraphQL server pulls in.
  await writeFile(
    join(directory, "pnpm-workspace.yaml"),
    'allowBuilds:\n  "@apollo/protobufjs": false\n',
  );
  // CI enables frozen lockfiles by default; a fresh consumer has no lockfile.
  // Pinned consumers may resolve from cached metadata; a consumer that installs
  // peer ranges refreshes it, so it gets the newest versions inside them.
  const pinned = Object.values(dependencies).every((version) =>
    /^\d+\.\d+\.\d+$/.test(version),
  );
  await run(
    "pnpm",
    [
      "install",
      ...(pinned ? ["--prefer-offline"] : []),
      "--no-frozen-lockfile",
    ],
    { cwd: directory, timeout: 240_000 },
  );
  return directory;
}

async function installedVersion(
  directory: string,
  name: string,
): Promise<string> {
  const path = join(directory, "node_modules", name, "package.json");
  return (JSON.parse(await readFile(path, "utf8")) as { version: string })
    .version;
}

async function compileApp(directory: string): Promise<void> {
  await Promise.all([
    copyFile(join(fixtures, "app.ts"), join(directory, "app.mts")),
    copyFile(join(fixtures, "app.ts"), join(directory, "app.cts")),
    copyFile(join(fixtures, "app.ts"), join(directory, "app.ts")),
    copyFile(
      join(fixtures, "declarations.cts"),
      join(directory, "declarations.cts"),
    ),
  ]);
  await writeFile(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { ...compilerOptions("nodenext"), outDir: "out" },
      files: ["app.mts", "app.cts"],
    }),
  );
  await run(process.execPath, [compiler, "--project", "tsconfig.json"], {
    cwd: directory,
    timeout: 120_000,
  });
}

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

function parseLines(stdout: string): unknown[] {
  return stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

function nodeScript(
  directory: string,
  script: string,
  format: "esm" | "cjs",
): Promise<{ stdout: string; stderr: string }> {
  return run(
    process.execPath,
    [
      "--require",
      "./trace-resolution.cjs",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: directory,
      env: {
        NODE_ENV: "test",
        CONSUMER_CJS_ARTIFACTS: format === "cjs" ? "1" : "0",
      },
      timeout: 120_000,
    },
  );
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "nsba-packed-consumers-"));
  await run("pnpm", ["pack", "--pack-destination", workspace], {
    cwd: packageRoot,
    timeout: 120_000,
  });
  tarball = join(workspace, `${manifest.name}-${manifest.version}.tgz`);
  const rows = ["floor", "current"] as const;
  const installs: [string, Record<string, string>][] = [
    ...rows.map((row): [string, Record<string, string>] => [
      row,
      coreDependencies(row),
    ]),
    ...rows.flatMap((row) =>
      Object.entries(optionalConsumers).map(
        ([name, { peers, extras }]): [string, Record<string, string>] => [
          `${row}-${name}`,
          {
            ...coreDependencies(row),
            ...Object.fromEntries(
              peers.map((peer) => {
                const range = manifest.peerDependencies[peer];
                return [peer, row === "floor" ? floorOf(range) : range];
              }),
            ),
            // Packages outside the peer list: the workspace version, or the
            // newest release of its major.
            ...Object.fromEntries(
              extras.map((extra) => {
                const version = manifest.devDependencies[extra];
                return [extra, row === "floor" ? version : `^${version}`];
              }),
            ),
          },
        ],
      ),
    ),
  ];
  // Settle every install before failing, so cleanup never races a running pnpm.
  const results = await Promise.allSettled(
    installs.map(async ([name, dependencies]) => {
      consumers.set(name, await install(name, dependencies));
    }),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
  await Promise.all(
    (["floor", "current"] as const).map((row) => compileApp(consumerFor(row))),
  );
}, 600_000);

afterAll(async () => {
  if (workspace !== undefined) {
    await rm(workspace, { recursive: true, force: true });
  }
});

function consumerFor(name: string): string {
  const directory = consumers.get(name);
  if (directory === undefined) {
    throw new Error(`No installed consumer ${name}`);
  }
  return directory;
}

// Every optional-peer outcome an entry can report when the consumer lacks peers.
function expectedEntries(installed: readonly OptionalPeer[]) {
  return Object.fromEntries(
    entries.map(({ name }) => {
      const missing = (
        Object.entries(optionalPeerEntries) as [
          OptionalPeer,
          readonly string[],
        ][]
      )
        .filter(
          ([peer, owners]) =>
            owners.includes(name) && !installed.includes(peer),
        )
        .map(([peer]) => peer);
      const outcome =
        missing.length === 0
          ? "loaded"
          : expect.stringMatching(
              new RegExp(
                `^missing (${missing.map((peer) => peer.replace("/", "\\/")).join("|")})$`,
              ),
            );
      return [name, { esm: outcome, cjs: outcome }];
    }),
  );
}

// One process per format: a failed import() leaves Better Auth partially
// loaded, and a later require() of it in the same process then fails.
const loadEntries = (
  format: "esm" | "cjs",
) => `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const fromPackage = createRequire(require.resolve(${JSON.stringify(`${manifest.name}/package.json`)}));
const peers = ${JSON.stringify(Object.keys(manifest.peerDependenciesMeta))};
const resolvable = peers.filter((peer) => {
  try {
    fromPackage.resolve(peer);
    return true;
  } catch (error) {
    return error.code !== "MODULE_NOT_FOUND";
  }
});
const load = ${format === "esm" ? "(specifier) => import(specifier)" : "async (specifier) => require(specifier)"};
const outcome = (error) => {
  const missing = /Cannot find (?:package|module) '([^']+)'/.exec(error.message);
  return missing ? "missing " + missing[1] : error.code + " " + error.message;
};
const loaded = {};
for (const { name, specifier } of ${JSON.stringify(entries)}) {
  loaded[name] = await load(specifier).then(() => "loaded", outcome);
}
console.log(JSON.stringify({ resolvable, entries: loaded }));`;

async function loadAllEntries(directory: string) {
  const [esm, cjs] = await Promise.all(
    (["esm", "cjs"] as const).map(async (format) => {
      const { stdout } = await nodeScript(
        directory,
        loadEntries(format),
        format,
      );
      return parseLines(stdout) as [
        { resolvable: string[]; entries: Record<string, string> },
        { resolved: Record<string, string> },
      ];
    }),
  );
  return {
    resolvable: { esm: esm[0].resolvable, cjs: cjs[0].resolvable },
    entries: Object.fromEntries(
      entries.map(({ name }) => [
        name,
        { esm: esm[0].entries[name], cjs: cjs[0].entries[name] },
      ]),
    ),
    resolved: Object.fromEntries(
      Object.entries({ ...esm[1].resolved, ...cjs[1].resolved }).filter(
        ([specifier]) => !specifier.endsWith("/package.json"),
      ),
    ),
  };
}

// Each entry's import() reaches its .mjs artifact and its require() the .cjs one.
const artifactResolution = Object.fromEntries(
  entries.flatMap(({ specifier, cjs }) => [
    [`import ${specifier}`, cjs.replace(/\.cjs$/, ".mjs")],
    [`require ${specifier}`, cjs],
  ]),
);

describe.each(["floor", "current"] as const)(
  "installed tarball with the %s peer versions",
  (row) => {
    it("installs the intended Nest and Better Auth versions", async () => {
      const directory = consumerFor(row);
      const versions = Object.fromEntries(
        await Promise.all(
          [...corePeers, "@nestjs/platform-express"].map(
            async (name) =>
              [name, await installedVersion(directory, name)] as const,
          ),
        ),
      );
      console.info(`${row} peer versions: ${JSON.stringify(versions)}`);
      const floors = Object.fromEntries(
        Object.entries(coreDependencies("floor")).filter(
          ([name]) => name !== "@types/node",
        ),
      );
      if (row === "floor") {
        expect(versions).toEqual(floors);
      } else {
        for (const [name, version] of Object.entries(versions)) {
          const floor = floors[name] ?? "";
          expect(version.split(".")[0], name).toBe(floor.split(".")[0]);
          expect(compareVersions(version, floor), name).toBeGreaterThanOrEqual(
            0,
          );
        }
      }
    });

    it("shares one module between import() and require() of the installed package", async () => {
      const { stdout } = await nodeScript(
        consumerFor(row),
        `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const imported = await import(${JSON.stringify(manifest.name)});
const required = require(${JSON.stringify(manifest.name)});
console.log(JSON.stringify({
  module: imported.BetterAuthModule === required.BetterAuthModule,
  service: imported.BetterAuthService === required.BetterAuthService,
  token: imported.getBetterAuthServiceToken("admin") === required.getBetterAuthServiceToken("admin"),
}));`,
        "esm",
      );
      expect(parseLines(stdout)).toEqual([
        { module: true, service: true, token: true },
        {
          resolved: {
            [`import ${manifest.name}`]: "dist/index.mjs",
            [`require ${manifest.name}`]: "dist/index.mjs",
          },
        },
      ]);
    });

    it.each([
      { format: "esm", script: "out/app.mjs", artifacts: "mjs" },
      { format: "cjs", script: "out/app.cjs", artifacts: "mjs" },
      { format: "cjs", script: "out/app.cjs", artifacts: "cjs" },
    ] as const)(
      "authenticates default and named instances from a compiled $format consumer through the .$artifacts artifacts",
      async ({ script, artifacts }) => {
        const { stdout, stderr } = await run(
          process.execPath,
          ["--require", "./trace-resolution.cjs", script],
          {
            cwd: consumerFor(row),
            env: { CONSUMER_CJS_ARTIFACTS: artifacts === "cjs" ? "1" : "0" },
            timeout: 120_000,
          },
        );
        expect(stderr).toBe("");
        const [result, trace] = parseLines(stdout);
        expect(result).toEqual({
          services: {
            defaultAlias: true,
            defaultInstance: true,
            namedInstance: true,
          },
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
        });
        const kind = script.endsWith(".mjs") ? "import" : "require";
        expect(trace).toEqual({
          resolved: Object.fromEntries(
            ["index", "express", "plugin"].map((name) => [
              `${kind} ${name === "index" ? manifest.name : `${manifest.name}/${name}`}`,
              `dist/${name}.${artifacts}`,
            ]),
          ),
        });
      },
    );

    it.each([
      {
        mode: "nodenext",
        files: ["app.mts", "app.cts"],
        declarations: ["express", "index", "plugin"].flatMap((name) => [
          `dist/${name}.d.cts`,
          `dist/${name}.d.mts`,
        ]),
      },
      {
        mode: "node16",
        files: ["app.mts", "declarations.cts"],
        declarations: [
          "dist/admin.d.cts",
          "dist/express.d.cts",
          "dist/express.d.mts",
          "dist/index.d.cts",
          "dist/index.d.mts",
          "dist/plugin.d.cts",
          "dist/plugin.d.mts",
        ],
      },
      {
        mode: "bundler",
        files: ["app.ts"],
        declarations: ["express", "index", "plugin"].map(
          (name) => `dist/${name}.d.mts`,
        ),
      },
    ] as const)(
      "compiles the declaration consumers with $mode resolution",
      async ({ mode, files, declarations }) => {
        const directory = consumerFor(row);
        const project = `tsconfig.${mode}.json`;
        await writeFile(
          join(directory, project),
          JSON.stringify({
            compilerOptions: { ...compilerOptions(mode), noEmit: true },
            files,
          }),
        );
        const { stdout } = await run(
          process.execPath,
          [compiler, "--project", project, "--listFiles", "--pretty", "false"],
          { cwd: directory, timeout: 120_000 },
        );
        const entryDeclarations = new Set(
          Object.values(manifest.exports).flatMap((target) =>
            typeof target === "string"
              ? []
              : Object.values(target).map(({ types }) =>
                  types.slice("./".length),
                ),
          ),
        );
        const used = stdout
          .split("\n")
          .map((line) => line.split(`/${manifest.name}/`).pop() ?? "")
          .filter((path) => entryDeclarations.has(path));
        expect([...new Set(used)].sort()).toEqual(declarations);
      },
    );

    it("loads every entry that does not need an optional peer when none is installed", async () => {
      const result = await loadAllEntries(consumerFor(row));
      expect(result.resolvable).toEqual({ esm: [], cjs: [] });
      expect(result.entries).toEqual(expectedEntries([]));
      expect(result.resolved).toEqual(artifactResolution);
    });
  },
);

it("resolves every entry to its CommonJS artifact with require(esm) disabled", async () => {
  // Better Auth ships only ESM, so an entry that imports it stops at that peer;
  // the platform helpers and the Fastify platform import no Better Auth module.
  const script = `const { dirname, relative } = require("node:path");
const root = dirname(require.resolve(${JSON.stringify(`${manifest.name}/package.json`)}));
const packageOf = (path) => {
  const [scope, name] = path.split("/node_modules/").pop().split("/");
  return scope.startsWith("@") ? scope + "/" + name : scope;
};
const result = {};
for (const { name, specifier } of ${JSON.stringify(entries)}) {
  const file = relative(root, require.resolve(specifier));
  let outcome = "loaded";
  try {
    require(specifier);
  } catch (error) {
    const esm = /of ES Module (\\S+) from (\\S+) not supported/.exec(error.message);
    outcome = esm
      ? error.code + " " + packageOf(esm[1]) + " from " + relative(root, esm[2]).split("/")[0]
      : error.code + " " + error.message;
  }
  result[name] = { file, outcome };
}
console.log(JSON.stringify(result));`;
  const directory = consumerFor("floor");
  await writeFile(join(directory, "require-fallback.cjs"), script);
  const { stdout } = await run(
    process.execPath,
    ["--no-experimental-require-module", "require-fallback.cjs"],
    { cwd: directory, timeout: 60_000 },
  );
  expect(JSON.parse(stdout)).toEqual(
    Object.fromEntries(
      entries.map(({ name, cjs }) => [
        name,
        {
          file: cjs,
          outcome: ["platform", "fastify"].includes(name)
            ? "loaded"
            : "ERR_REQUIRE_ESM better-auth from dist",
        },
      ]),
    ),
  );
});

const bootPrelude = (
  format: "esm" | "cjs",
) => `import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const load = ${format === "esm" ? "(specifier) => import(specifier)" : "async (specifier) => require(specifier)"};
const kit = await load(${JSON.stringify(manifest.name)});
const { nestjs } = await load(${JSON.stringify(`${manifest.name}/plugin`)});
const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { Logger } = await import("@nestjs/common");
const { NestFactory } = await import("@nestjs/core");
Logger.overrideLogger(false);
const instance = (cookiePrefix) => betterAuth({
  baseURL: "http://localhost:3000",
  secret: "packed-consumer-secret-with-enough-entropy-0123456789",
  database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
  emailAndPassword: { enabled: true },
  logger: { disabled: true },
  advanced: { cookiePrefix },
  plugins: [nestjs()],
});
const cookieFor = async (auth, email) => {
  const { headers } = await auth.api.signUpEmail({
    body: { email, password: "packed-consumer-password", name: "Consumer" },
    returnHeaders: true,
  });
  return headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
};
`;

const optionalBoots: Record<
  OptionalConsumer,
  { script: string; expected: unknown }
> = {
  graphql: {
    script: `const graphql = await load(${JSON.stringify(`${manifest.name}/graphql`)});
const express = await load(${JSON.stringify(`${manifest.name}/express`)});
const { GraphQLModule } = await import("@nestjs/graphql");
const { ApolloDriver } = await import("@nestjs/apollo");
const { ExpressAdapter } = await import("@nestjs/platform-express");
const auth = instance("graphql");
const app = await NestFactory.create({
  module: class PackedGraphqlModule {},
  imports: [
    kit.BetterAuthModule.forRoot({ auth, platforms: [express.expressPlatform()], transports: [graphql.apolloTransport()], logSummary: false }),
    GraphQLModule.forRoot({ driver: ApolloDriver, typeDefs: "type Query { ping: String! }", resolvers: { Query: { ping: () => "pong" } } }),
  ],
}, new ExpressAdapter(), { logger: false });
try {
  await app.init();
  console.log(JSON.stringify({ originalInstance: app.get(kit.BetterAuthService).instance === auth, adapter: app.getHttpAdapter().getType() }));
} finally {
  await app.close();
}`,
    expected: { originalInstance: true, adapter: "express" },
  },
  websockets: {
    script: `const sockets = await load(${JSON.stringify(`${manifest.name}/websockets`)});
const auths = { default: instance("default"), named: instance("named") };
const context = await NestFactory.createApplicationContext({
  module: class PackedWebSocketModule {},
  imports: [
    kit.BetterAuthModule.forRoot({ auth: auths.default, transports: [sockets.socketIoTransport()], http: { mount: false }, logSummary: false }),
    kit.BetterAuthModule.forRoot({ name: "named", auth: auths.named, logSummary: false }),
  ],
}, { logger: false });
try {
  const connections = context.get(sockets.WS_CONNECTION_AUTH);
  const client = (cookie) => ({ handshake: { headers: { cookie, host: "localhost:3000", origin: "http://localhost:3000" }, auth: {}, url: "/socket.io/" } });
  const cookies = { default: await cookieFor(auths.default, "user@consumer.example"), named: await cookieFor(auths.named, "operator@consumer.example") };
  const email = (result) => result.outcome === "authenticated" ? result.principal.session.user.email : result.outcome;
  console.log(JSON.stringify({
    default: email(await connections.authenticate(client(cookies.default))),
    named: email(await connections.authenticate(client(cookies.named), { instance: "named" })),
    crossNamed: email(await connections.authenticate(client(cookies.default), { instance: "named" })),
    anonymous: email(await connections.authenticate(client(""))),
  }));
} finally {
  await context.close();
}`,
    expected: {
      default: "user@consumer.example",
      named: "operator@consumer.example",
      crossNamed: "absent",
      anonymous: "absent",
    },
  },
  microservices: {
    script: `const rpc = await load(${JSON.stringify(`${manifest.name}/microservices`)});
const { Transport } = await import("@nestjs/microservices");
const auth = instance("rpc");
const app = await NestFactory.createMicroservice(
  kit.BetterAuthModule.forRoot({ auth, transports: [rpc.rpcTransport()], http: { mount: false }, logSummary: false }),
  { transport: Transport.TCP, options: { host: "127.0.0.1", port: 0 }, logger: false },
);
try {
  await app.init();
  console.log(JSON.stringify({ originalInstance: app.get(kit.BetterAuthService).instance === auth, carriers: rpc.defaultCarriers.map((carrier) => carrier.id) }));
} finally {
  await app.close();
}`,
    expected: {
      originalInstance: true,
      carriers: ["grpc", "nats", "kafka", "rmq", "mqtt", "payload"],
    },
  },
  "testing/conformance": {
    script: `const testing = await load(${JSON.stringify(`${manifest.name}/testing`)});
const conformance = await load(${JSON.stringify(`${manifest.name}/testing/conformance`)});
const { Test } = await import("@nestjs/testing");
const builder = Test.createTestingModule({
  imports: [
    kit.BetterAuthModule.forRoot({ auth: instance("first"), http: { mount: false }, logSummary: false }),
    kit.BetterAuthModule.forRoot({ name: "named", auth: instance("named"), http: { mount: false }, logSummary: false }),
  ],
});
const fixed = (userId) => ({ kind: "session", source: "better-auth:session", userId, session: {} });
testing.overridePrincipal(builder, fixed("default-user"));
testing.overridePrincipal(builder, fixed("named-user"), { instance: "named" });
const moduleRef = await builder.compile();
await moduleRef.init();
const resolver = moduleRef.get(kit.PRINCIPAL_RESOLVER);
const call = { key: {}, invocation: {}, headers: () => new Headers(), clientIp: null, cookies: null, param: () => undefined };
const principals = [];
for (const name of [undefined, "named"]) {
  const result = await resolver.resolve(call, { auth: moduleRef.get(kit.getBetterAuthHandleToken(name)), freshness: "default", accepts: new Set(["session"]), sourceSet: "0" });
  principals.push(result.principal?.userId ?? result.outcome);
}
await moduleRef.close();
const auth = conformance.createConformanceAuth();
const outcomes = [];
for (const item of conformance.principalSourceConformance({
  source: kit.sessionPrincipal(),
  auth,
  credentials: {
    valid: async () => {
      const { user } = await auth.api.signUpEmail({ body: { email: crypto.randomUUID() + "@consumer.example", password: crypto.randomUUID(), name: "Consumer" } });
      return testing.authHeadersFor(auth, user.id);
    },
    invalid: () => new Headers({ cookie: "better-auth.session_token=invalid.value" }),
  },
})) {
  outcomes.push(item.skip === undefined ? ((await item.run())?.skipped ? "skipped" : "passed") : "skipped");
}
console.log(JSON.stringify({ principals, outcomes: [...new Set(outcomes)].sort() }));`,
    expected: {
      principals: ["default-user", "named-user"],
      outcomes: ["passed", "skipped"],
    },
  },
};

describe.each(
  (["floor", "current"] as const).flatMap((row) =>
    (Object.keys(optionalConsumers) as OptionalConsumer[]).map((name) => ({
      row,
      name,
    })),
  ),
)(
  "installed tarball with only the ./$name optional peers at the $row versions",
  ({ row, name }) => {
    const { peers } = optionalConsumers[name];

    it("keeps every other optional peer absent and loads each entry whose peers are present", async () => {
      const result = await loadAllEntries(consumerFor(`${row}-${name}`));
      const present = Object.keys(manifest.peerDependenciesMeta).filter(
        (peer) => (peers as readonly string[]).includes(peer),
      );
      expect(result.resolvable).toEqual({ esm: present, cjs: present });
      expect(result.entries).toEqual(expectedEntries(peers));
      expect(result.resolved).toEqual(artifactResolution);
    });

    it.each(["esm", "cjs"] as const)(
      "boots the subpath from the installed %s artifacts",
      async (format) => {
        const { stdout } = await nodeScript(
          consumerFor(`${row}-${name}`),
          `${bootPrelude(format)}${optionalBoots[name].script}`,
          format,
        );
        const [result, trace] = parseLines(stdout) as [
          unknown,
          { resolved: Record<string, string> },
        ];
        expect(result).toEqual(optionalBoots[name].expected);
        const extension = format === "esm" ? ".mjs" : ".cjs";
        expect(
          Object.values(trace.resolved).every((path) =>
            path.endsWith(extension),
          ),
        ).toBe(true);
        expect(Object.keys(trace.resolved)).toContain(
          `${format === "esm" ? "import" : "require"} ${manifest.name}/${name}`,
        );
      },
    );
  },
);
