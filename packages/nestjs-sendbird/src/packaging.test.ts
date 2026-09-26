import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = join(__dirname, "..");
const packageName = "nestjs-sendbird";
const sdk = "@sendbird/sendbird-platform-sdk-typescript";
const compiler = join(
  dirname(createRequire(__filename).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

/** Runs inside the package root so its name resolves through `exports`. */
const bootstrap = `
  const { Module } = common;
  class AppModule {}
  Module({
    imports: [
      kit.SendbirdModule.register({ appId: "primary-app", apiToken: "primary-token" }),
      kit.SendbirdModule.registerAsync({
        alias: "secondary",
        useFactory: async () => ({ appId: "secondary-app", apiToken: "secondary-token" }),
      }),
    ],
  })(AppModule);
  const app = await core.NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const services = [app.get(kit.getSendbirdToken()), app.get(kit.getSendbirdToken("secondary"))];
    console.log(JSON.stringify({
      exports: Object.keys(kit).sort(),
      defaultIsClass: app.get(kit.SendbirdService) === services[0],
      distinct: services[0] !== services[1],
      members: Object.keys(services[1]).sort(),
      hosts: services.map((service) =>
        service.configuration.baseServer.makeRequestContext("/v3/users", "GET").getUrl()),
    }));
  } finally {
    await app.close();
  }
`;

const consumers = {
  esm: `import * as kit from "${packageName}";
import * as common from "@nestjs/common";
import * as core from "@nestjs/core";
${bootstrap}`,
  cjs: `const kit = require("${packageName}");
const common = require("@nestjs/common");
const core = require("@nestjs/core");
(async () => {${bootstrap}})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`,
};

const declarations = `import type { SendbirdUser } from "${sdk}";
import {
  getSendbirdOptionsToken,
  getSendbirdToken,
  SendbirdModule,
  SendbirdService,
  type SendbirdModuleOptions,
} from "${packageName}";
// @ts-expect-error The generated options token stays internal.
import { MODULE_OPTIONS_TOKEN } from "${packageName}";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

const options: SendbirdModuleOptions = { appId: "app", apiToken: "token" };
SendbirdModule.register({ ...options, alias: "primary", global: true });
SendbirdModule.registerAsync({ alias: "secondary", useFactory: async () => options });
SendbirdModule.register({ ...options, configuration: { promiseMiddleware: [] } });
// @ts-expect-error Authentication belongs to the registration.
SendbirdModule.register({ ...options, configuration: { authMethods: {} } });

declare const service: SendbirdService;
type UserResult = Assert<Equal<Awaited<ReturnType<typeof service.users.viewAUser>>, SendbirdUser>>;
const token: typeof SendbirdService | string = getSendbirdToken("secondary");
const optionsToken: string | symbol = getSendbirdOptionsToken();
void token;
void optionsToken;
`;

describe("built Sendbird package", () => {
  it.each(["esm", "cjs"] as const)(
    "bootstraps default and named registrations from the actual %s artifact",
    (format) => {
      const output = execFileSync(
        process.execPath,
        [
          ...(format === "esm" ? ["--input-type=module"] : []),
          "--eval",
          consumers[format],
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        exports: [
          "ASYNC_OPTIONS_TYPE",
          "OPTIONS_TYPE",
          "SendbirdModule",
          "SendbirdService",
          "getSendbirdOptionsToken",
          "getSendbirdToken",
        ],
        defaultIsClass: true,
        distinct: true,
        members: [
          "announcements",
          "bots",
          "configuration",
          "groupChannels",
          "messages",
          "metadata",
          "moderation",
          "openChannels",
          "statistics",
          "users",
        ],
        hosts: [
          "https://api-primary-app.sendbird.com/v3/users",
          "https://api-secondary-app.sendbird.com/v3/users",
        ],
      });
    },
  );

  it.each(["cts", "mts"] as const)(
    "type-checks a NodeNext .%s consumer against the built declarations",
    async (extension) => {
      const directory = await mkdtemp(
        join(tmpdir(), `nestjs-sendbird-consumer-${extension}-`),
      );
      const modules = join(directory, "node_modules");
      try {
        await mkdir(join(modules, "@sendbird"), { recursive: true });
        await Promise.all([
          symlink(root, join(modules, packageName), "dir"),
          symlink(join(root, "node_modules", sdk), join(modules, sdk), "dir"),
          symlink(
            join(root, "../../node_modules/@types"),
            join(modules, "@types"),
            "dir",
          ),
        ]);
        await writeFile(join(directory, `consumer.${extension}`), declarations);
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
        expect(result).toEqual({ stdout: "", stderr: "" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
