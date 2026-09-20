import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = fileURLToPath(
  new URL("../bin/tsc", import.meta.resolve("typescript")),
);

function node(script: string, ...flags: string[]): string {
  return execFileSync(process.execPath, [...flags, "--eval", script], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

async function compileConsumer(extension: "cts" | "mts"): Promise<void> {
  const directory = await mkdtemp(
    join(tmpdir(), `nsba-built-consumer-${extension}-`),
  );
  const modules = join(directory, "node_modules");
  try {
    await mkdir(modules);
    await Promise.all([
      symlink(root, join(modules, manifest.name), "dir"),
      symlink(
        join(root, "node_modules", "better-auth"),
        join(modules, "better-auth"),
        "dir",
      ),
      symlink(
        join(root, "../../node_modules", "@types"),
        join(modules, "@types"),
        "dir",
      ),
    ]);
    await writeFile(
      join(directory, `consumer.${extension}`),
      `import { betterAuth } from "better-auth";
import { customSession } from "better-auth/plugins";
import type {
  AuthOf,
  AuthPrincipalBase,
  AuthSession,
  AuthUser,
  PrincipalKind,
  PrincipalOfKind,
  RegisteredAuth,
  RegisteredInstances,
} from "nestjs-slightly-better-auth";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

const primary = betterAuth({
  user: {
    additionalFields: {
      department: { type: "string", required: true },
    },
  },
});
const admin = betterAuth({
  plugins: [
    customSession(async ({ user }) => ({
      principal: { uid: user.id },
      roles: ["editor"],
    })),
  ],
});

interface ApiKeyPrincipal extends AuthPrincipalBase {
  readonly kind: "api-key";
  readonly keyId: string;
}

declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: typeof primary;
    instances: { admin: typeof admin };
  }

  interface PrincipalKinds {
    "api-key": ApiKeyPrincipal;
  }
}

type DefaultInstance = Assert<Equal<RegisteredAuth, typeof primary>>;
type NamedInstance = Assert<Equal<AuthOf<"admin">, typeof admin>>;
type RegisteredNamedInstance = Assert<Equal<RegisteredInstances["admin"], typeof admin>>;
type AdditionalUserField = Assert<Equal<AuthUser["department"], string>>;
type CustomSessionUserId = Assert<Equal<AuthSession<"admin">["principal"]["uid"], string>>;
type AugmentedPrincipal = Assert<Equal<PrincipalOfKind<"api-key">, ApiKeyPrincipal>>;

const kind: PrincipalKind = "api-key";
// @ts-expect-error PrincipalKinds controls the accepted kind literals.
const invalidKind: PrincipalKind = "unknown";
void kind;
void invalidKind;
`,
    );
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
    ]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      throw new Error(String(error.stdout), { cause: error });
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("built authentication package", () => {
  it("shares one module identity between canonical Node import and require", () => {
    const result = node(
      `import { createRequire } from "node:module";
       const require = createRequire(import.meta.url);
       const name = ${JSON.stringify(manifest.name)};
       const imported = await import(name);
       const required = require(name);
       console.log(JSON.stringify({
         same: imported === required,
         imported: import.meta.resolve(name),
         required: require.resolve(name),
       }));`,
      "--input-type=module",
    );
    expect(JSON.parse(result)).toEqual({
      same: true,
      imported: expect.stringMatching(/\/dist\/index\.mjs$/),
      required: expect.stringMatching(/\/dist\/index\.mjs$/),
    });
  });

  it("loads the actual CJS artifact and interoperates with ESM through Nest tokens and error brands", () => {
    const result = node(`
      const cjs = require("./dist/index.cjs");
      (async () => {
        const esm = await import("./dist/index.mjs");
        const { Test } = await import("@nestjs/testing");
        const esmHelpers = [
          esm.getBetterAuthInstanceToken,
          esm.getBetterAuthOptionsToken,
          esm.getBetterAuthServiceToken,
          esm.getBetterAuthHandleToken,
        ];
        const cjsHelpers = [
          cjs.getBetterAuthInstanceToken,
          cjs.getBetterAuthOptionsToken,
          cjs.getBetterAuthServiceToken,
          cjs.getBetterAuthHandleToken,
        ];
        const defaultValues = esmHelpers.map((_, index) => ({ id: \`default-\${index}\` }));
        const namedValues = cjsHelpers.map((_, index) => ({ id: \`admin-\${index}\` }));
        const moduleRef = await Test.createTestingModule({
          providers: [
            ...esmHelpers.map((helper, index) => ({
              provide: helper(),
              useValue: defaultValues[index],
            })),
            ...cjsHelpers.map((helper, index) => ({
              provide: helper("admin"),
              useValue: namedValues[index],
            })),
            {
              provide: "default-consumer",
              inject: cjsHelpers.map((helper) => helper()),
              useFactory: (...values) => values,
            },
            {
              provide: "named-consumer",
              inject: esmHelpers.map((helper) => helper("admin")),
              useFactory: (...values) => values,
            },
          ],
        }).compile();
        const failureFromEsm = esm.AuthFailures.forbidden("DENIED");
        const failureFromCjs = cjs.AuthFailures.unauthenticated();
        const configurationFromEsm = new esm.BetterAuthConfigurationError("BAD", "bad");
        const infrastructureFromCjs = new cjs.BetterAuthInfrastructureError(new Error("offline"));
        const runtimeExports = [
          "AuthFailures",
          "BetterAuthConfigurationError",
          "BetterAuthInfrastructureError",
          "getBetterAuthHandleToken",
          "getBetterAuthInstanceToken",
          "getBetterAuthOptionsToken",
          "getBetterAuthServiceToken",
          "getRawCause",
          "isAuthFailure",
          "isConfigurationError",
          "isInfrastructureError",
        ];
        console.log(JSON.stringify({
          cjsPath: require.resolve("./dist/index.cjs"),
          defaultInjected: moduleRef
            .get("default-consumer")
            .every((value, index) => value === defaultValues[index]),
          namedInjected: moduleRef
            .get("named-consumer")
            .every((value, index) => value === namedValues[index]),
          brands: [
            cjs.isAuthFailure(failureFromEsm),
            esm.isAuthFailure(failureFromCjs),
            cjs.isConfigurationError(configurationFromEsm),
            esm.isInfrastructureError(infrastructureFromCjs),
          ],
          runtimeExportsMatch:
            JSON.stringify(Object.keys(esm).sort()) === JSON.stringify(runtimeExports) &&
            JSON.stringify(Object.keys(cjs).sort()) === JSON.stringify(runtimeExports),
        }));
        await moduleRef.close();
      })().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    `);
    expect(JSON.parse(result)).toEqual({
      cjsPath: expect.stringMatching(/\/dist\/index\.cjs$/),
      defaultInjected: true,
      namedInjected: true,
      brands: [true, true, true, true],
      runtimeExportsMatch: true,
    });
  });

  it("includes every declared entry point and both declaration formats", () => {
    const entry = manifest.exports["."];
    const paths = new Set([
      manifest.main,
      manifest.module,
      manifest.types,
      ...Object.values(entry).flatMap(({ types, default: path }) => [
        types,
        path,
      ]),
      manifest.exports["./package.json"],
    ]);
    const missing = [...paths].filter(
      (path) => !existsSync(new URL(`../${path}`, import.meta.url)),
    );
    expect(missing).toEqual([]);
  });

  it("carries public registry augmentation through both built declaration formats", async () => {
    await Promise.all([compileConsumer("mts"), compileConsumer("cts")]);
  });
});
