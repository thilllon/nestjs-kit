import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = join(__dirname, "..");
const { name } = require("../package.json") as { name: string };
const compiler = join(
  dirname(require.resolve("typescript/package.json")),
  "bin",
  "tsc",
);

const consumer = `import {
  getRedisOptionsToken,
  getRedisToken,
  RedisModule,
  type RedisModuleOptions,
} from "@nestjs-kit/redis";
import * as api from "@nestjs-kit/redis";

declare class Client {
  quit(): Promise<"OK">;
}

RedisModule.register({
  alias: "cache",
  global: true,
  connect: () => new Client(),
  disconnect: (client) => client.quit(),
});
RedisModule.register({
  connect: async () => new Client(),
  // @ts-expect-error The inferred client has no close method.
  disconnect: (client) => client.close(),
});
// @ts-expect-error disconnect is required.
RedisModule.register({ connect: () => new Client() });
RedisModule.registerAsync<Client>({
  alias: "async",
  useFactory: async () => ({
    connect: () => new Client(),
    disconnect: (client) => client.quit(),
  }),
});
const options: RedisModuleOptions<Client> = {
  connect: () => new Client(),
  disconnect: (client) => client.quit(),
};
// @ts-expect-error The generated options token stays internal.
void api.MODULE_OPTIONS_TOKEN;
const tokens: Array<string | symbol> = [
  getRedisToken(),
  getRedisToken("cache"),
  getRedisOptionsToken(),
];
void options;
void tokens;
`;

describe("built Redis package", () => {
  it.each(["esm", "cjs"] as const)(
    "bootstraps default and named registrations from the actual %s artifact",
    (format) => {
      const load =
        format === "esm"
          ? `await import(${JSON.stringify(name)})`
          : `require(${JSON.stringify(name)})`;
      const resolve =
        format === "esm"
          ? `import.meta.resolve(${JSON.stringify(name)})`
          : `require.resolve(${JSON.stringify(name)})`;
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { createRequire } from "node:module";
           const require = createRequire(import.meta.url);
           const kit = ${load};
           const { Module } = await import("@nestjs/common");
           const { NestFactory } = await import("@nestjs/core");
           const fake = (label) => ({
             connect: async () => ({ label, open: true }),
             disconnect: async (client) => { client.open = false; },
           });
           class AppModule {}
           Module({
             imports: [
               kit.RedisModule.register(fake("default")),
               kit.RedisModule.registerAsync({
                 alias: "cache",
                 useFactory: async () => fake("cache"),
               }),
             ],
             providers: [{
               provide: "consumer",
               inject: [kit.getRedisToken(), kit.getRedisToken("cache")],
               useFactory: (primary, cache) => ({ primary, cache }),
             }],
           })(AppModule);
           const app = await NestFactory.createApplicationContext(AppModule, {
             logger: false,
             abortOnError: false,
           });
           const { primary, cache } = app.get("consumer");
           await app.close();
           const feature = (label) => {
             class Feature {}
             Module({
               imports: [
                 kit.RedisModule.register({ alias: "cache", ...fake(label) }),
               ],
             })(Feature);
             return Feature;
           };
           class DuplicateModule {}
           Module({
             imports: [feature("first"), feature("second")],
           })(DuplicateModule);
           const duplicate = await NestFactory.createApplicationContext(
             DuplicateModule,
             { logger: false, abortOnError: false },
           ).then(() => "bootstrapped", (error) => error.message);
           console.log(JSON.stringify({
             entry: ${resolve}.split("/").at(-1),
             exports: Object.keys(kit).sort(),
             clients: [primary.label, cache.label],
             open: [primary.open, cache.open],
             duplicate,
           }));`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        entry: format === "esm" ? "index.mjs" : "index.cjs",
        exports: [
          "ASYNC_OPTIONS_TYPE",
          "OPTIONS_TYPE",
          "RedisModule",
          "getRedisOptionsToken",
          "getRedisToken",
        ],
        clients: ["default", "cache"],
        open: [false, false],
        duplicate:
          'Redis alias "cache" is registered by more than one RedisModule. Use distinct aliases, or import one registration module wherever the client is shared.',
      });
    },
  );

  it.each(["cts", "mts"] as const)(
    "type-checks a NodeNext .%s consumer against the built declarations",
    async (extension) => {
      const directory = await mkdtemp(
        join(tmpdir(), `nestjs-kit-redis-consumer-${extension}-`),
      );
      const modules = join(directory, "node_modules");
      try {
        await mkdir(join(modules, "@nestjs-kit"), { recursive: true });
        await Promise.all([
          symlink(root, join(modules, name), "dir"),
          symlink(
            join(root, "node_modules", "@nestjs"),
            join(modules, "@nestjs"),
          ),
          symlink(
            join(root, "../../node_modules/@types"),
            join(modules, "@types"),
          ),
        ]);
        await writeFile(join(directory, `consumer.${extension}`), consumer);
        await writeFile(
          join(directory, "tsconfig.json"),
          JSON.stringify({
            compilerOptions: {
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              strict: true,
              noEmit: true,
              skipLibCheck: true,
              types: ["node"],
            },
            files: [`consumer.${extension}`],
          }),
        );
        const result = await execute(process.execPath, [
          compiler,
          "--project",
          join(directory, "tsconfig.json"),
          "--pretty",
          "false",
        ]).catch((error: { stdout?: string }) => {
          throw new Error(String(error.stdout), { cause: error });
        });
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe("");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
