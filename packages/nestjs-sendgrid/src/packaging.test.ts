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
  getSendGridOptionsToken,
  getSendGridToken,
  SendGridModule,
  SendGridService,
  type SendGridModuleOptions,
} from "nestjs-sendgrid";
import * as api from "nestjs-sendgrid";

type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;
type TypedClient = Assert<IsAny<SendGridService["client"]> extends false ? true : false>;
type TypedMail = Assert<IsAny<SendGridService["mail"]> extends false ? true : false>;

const options: SendGridModuleOptions = {
  apiKey: "SG.key",
  dataResidency: "eu",
  timeout: 10_000,
  impersonateSubuser: "subuser",
};
SendGridModule.register({ ...options, alias: "eu", global: true });
SendGridModule.registerAsync({ alias: "eu", useFactory: async () => options });
// @ts-expect-error Only the "global" and "eu" regions exist.
SendGridModule.register({ apiKey: "SG.key", dataResidency: "us" });
// @ts-expect-error The generated options token stays internal.
void api.MODULE_OPTIONS_TOKEN;

declare const service: SendGridService;
service.client.setDefaultHeader("X-Trace", "1");
const sent: Promise<[{ statusCode: number }, unknown]> = service.mail.send({
  to: "reader@example.com",
  from: "sender@example.com",
  subject: "Hello",
  text: "Hi",
});
// @ts-expect-error Mail Send requires a sender.
void service.mail.send({ to: "reader@example.com", subject: "Hello", text: "Hi" });
const tokens: Array<string | symbol | typeof SendGridService> = [
  getSendGridToken(),
  getSendGridToken("eu"),
  getSendGridOptionsToken(),
];
void sent;
void tokens;
`;

describe("built SendGrid package", () => {
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
           const sdkClient = await import("@sendgrid/client");
           const sdkMail = await import("@sendgrid/mail");
           class AppModule {}
           Module({
             imports: [
               kit.SendGridModule.register({ apiKey: "SG.default" }),
               kit.SendGridModule.registerAsync({
                 alias: "eu",
                 useFactory: async () => ({ apiKey: "SG.eu", dataResidency: "eu" }),
               }),
             ],
             providers: [{
               provide: "consumer",
               inject: [kit.getSendGridToken(), kit.getSendGridToken("eu")],
               useFactory: (primary, regional) => ({ primary, regional }),
             }],
           })(AppModule);
           const app = await NestFactory.createApplicationContext(AppModule, {
             logger: false,
             abortOnError: false,
           });
           const describe = ({ client }) => {
             const request = client.createRequest({ url: "/v3/mail/send" });
             return [request.baseURL, request.headers.Authorization ?? null];
           };
           try {
             const { primary, regional } = app.get("consumer");
             const services = [primary, regional];
             console.log(JSON.stringify({
               entry: ${resolve}.split("/").at(-1),
               exports: Object.keys(kit).sort(),
               distinct: primary !== regional,
               defaultClassToken: app.get(kit.SendGridService) === primary,
               ownSdkInstances: services.every(({ client, mail }) =>
                 client instanceof sdkClient.Client &&
                 mail instanceof sdkMail.MailService &&
                 client !== sdkClient.default &&
                 mail !== sdkMail.default),
               requests: services.map(describe),
               sharedDefault: describe({ client: sdkClient.default }),
             }));
           } finally {
             await app.close();
           }`,
        ],
        { cwd: root, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({
        entry: format === "esm" ? "index.mjs" : "index.cjs",
        exports: [
          "ASYNC_OPTIONS_TYPE",
          "OPTIONS_TYPE",
          "SendGridModule",
          "SendGridService",
          "getSendGridOptionsToken",
          "getSendGridToken",
        ],
        distinct: true,
        defaultClassToken: true,
        ownSdkInstances: true,
        requests: [
          ["https://api.sendgrid.com/", "Bearer SG.default"],
          ["https://api.eu.sendgrid.com/", "Bearer SG.eu"],
        ],
        sharedDefault: ["https://api.sendgrid.com/", null],
      });
    },
  );

  it.each(["cts", "mts"] as const)(
    "type-checks a NodeNext .%s consumer against the built declarations",
    async (extension) => {
      const directory = await mkdtemp(
        join(tmpdir(), `nestjs-sendgrid-consumer-${extension}-`),
      );
      const modules = join(directory, "node_modules");
      try {
        await mkdir(modules);
        await Promise.all([
          symlink(root, join(modules, name), "dir"),
          ...["@nestjs", "@sendgrid"].map((scope) =>
            symlink(join(root, "node_modules", scope), join(modules, scope)),
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
