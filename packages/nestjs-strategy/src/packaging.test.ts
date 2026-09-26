import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const root = join(__dirname, "..");
const packageName = "nestjs-strategy";
const compiler = join(
  dirname(createRequire(__filename).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

/** Runs inside the package root so its name resolves through `exports`. */
const bootstrap = `
  const { Injectable, Module } = common;
  class Fees { fee(amount) { return amount / 10; } }
  Injectable()(Fees);
  class FeesModule {}
  Module({ providers: [Fees], exports: [Fees] })(FeesModule);
  class Card {
    constructor(fees) { this.fees = fees; }
    pay(amount) { return "card:" + (amount + this.fees.fee(amount)); }
  }
  kit.Strategy("card")(Card);
  Injectable()(Card);
  Reflect.defineMetadata("design:paramtypes", [Fees], Card);
  class Bank { pay(amount) { return "bank:" + amount; } }
  kit.Strategy("bank")(Bank);
  Injectable()(Bank);
  const shipping = kit.defineStrategyGroup("shipping", ["standard", "express"]);
  class Standard {}
  shipping.Strategy("standard")(Standard);
  Injectable()(Standard);
  class Express {}
  shipping.Strategy("express")(Express);
  Injectable()(Express);
  class AppModule {}
  Module({
    imports: [
      kit.StrategyModule.register({
        name: "payment",
        strategies: [Card, Bank],
        defaultKey: "bank",
        imports: [FeesModule],
      }),
      kit.StrategyModule.register({
        group: shipping,
        strategies: [Standard, Express],
        defaultKey: "standard",
      }),
    ],
  })(AppModule);
  const app = await core.NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const registry = app.get(kit.getStrategyRegistryToken("payment"));
    let unknown;
    try {
      registry.get("crypto");
    } catch (error) {
      unknown = error instanceof kit.UnknownStrategyError;
    }
    console.log(JSON.stringify({
      exports: Object.keys(kit).sort(),
      isRegistry: registry instanceof kit.StrategyRegistry,
      keys: registry.keys(),
      card: registry.get("card").pay(100),
      fallback: registry.get().pay(100),
      unknown,
      grouped: app.get(shipping.token).keys(),
      groupedDefault: app.get(shipping.token).get() instanceof Standard,
    }));
  } finally {
    await app.close();
  }
`;

const consumers = {
  esm: `import "reflect-metadata";
import * as kit from "${packageName}";
import * as common from "@nestjs/common";
import * as core from "@nestjs/core";
${bootstrap}`,
  cjs: `require("reflect-metadata");
const kit = require("${packageName}");
const common = require("@nestjs/common");
const core = require("@nestjs/core");
(async () => {${bootstrap}})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});`,
};

const declarations = `import {
  defineStrategyGroup,
  getStrategyKey,
  getStrategyRegistryToken,
  Strategy,
  StrategyModule,
  StrategyRegistry,
  UnknownStrategyError,
  type StrategyKeyOf,
  type StrategyModuleOptions,
} from "${packageName}";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

interface Payment {
  pay(amount: number): string;
}

@Strategy("card")
class Card implements Payment {
  pay(amount: number): string {
    return String(amount);
  }
}

const options: StrategyModuleOptions = { name: "payment", strategies: [Card], defaultKey: "card" };
StrategyModule.register({ ...options, global: true, imports: [] });
// @ts-expect-error A strategy group needs a name.
StrategyModule.register({ strategies: [Card] });

declare const registry: StrategyRegistry<Payment>;
type Selected = Assert<Equal<ReturnType<typeof registry.get>, Payment>>;
type Found = Assert<Equal<ReturnType<typeof registry.find>, Payment | undefined>>;
const token: string = getStrategyRegistryToken("payment");
const key: string | undefined = getStrategyKey(Card);
const error = new UnknownStrategyError("payment", "crypto", ["card"]);
const keys: readonly string[] = error.registeredKeys;
for (const [name, strategy] of registry) {
  const entry: [string, Payment] = [name, strategy];
  void entry;
}
void token;
void key;
void keys;

const payment = defineStrategyGroup("payment", ["card", "bank"]);
type Method = StrategyKeyOf<typeof payment>;
type Declared = Assert<Equal<Method, "card" | "bank">>;

@payment.Strategy("bank")
class Bank implements Payment {
  pay(amount: number): string {
    return String(amount);
  }
}

// @ts-expect-error The group decorator accepts only declared keys.
payment.Strategy("crypto");
StrategyModule.register({ group: payment, strategies: [Card, Bank], defaultKey: "card" });
// @ts-expect-error The default key must be a declared key.
StrategyModule.register({ group: payment, strategies: [Card, Bank], defaultKey: "crypto" });

declare const typed: StrategyRegistry<Payment, Method>;
type TypedKeys = Assert<Equal<ReturnType<typeof typed.keys>, Method[]>>;
typed.get("card");
// @ts-expect-error A typed registry selects only declared keys.
typed.get("crypto");
declare const input: string;
if (typed.has(input)) {
  const narrowed: Method = input;
  void narrowed;
}
const optional: Payment | undefined = typed.find(input);
void optional;
`;

describe("built strategy package", () => {
  it.each(["esm", "cjs"] as const)(
    "bootstraps a strategy registry from the actual %s artifact",
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
          "Strategy",
          "StrategyModule",
          "StrategyRegistry",
          "UnknownStrategyError",
          "defineStrategyGroup",
          "getStrategyKey",
          "getStrategyRegistryToken",
        ],
        isRegistry: true,
        keys: ["card", "bank"],
        card: "card:110",
        fallback: "bank:100",
        unknown: true,
        grouped: ["standard", "express"],
        groupedDefault: true,
      });
    },
  );

  it.each(["cts", "mts"] as const)(
    "type-checks a NodeNext .%s consumer against the built declarations",
    async (extension) => {
      const directory = await mkdtemp(
        join(tmpdir(), `nestjs-strategy-consumer-${extension}-`),
      );
      const modules = join(directory, "node_modules");
      try {
        await mkdir(modules, { recursive: true });
        await Promise.all([
          symlink(root, join(modules, packageName), "dir"),
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
              experimentalDecorators: true,
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
