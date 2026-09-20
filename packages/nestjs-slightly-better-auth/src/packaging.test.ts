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
import { BetterAuthModule, type BetterAuthService } from "nestjs-slightly-better-auth";
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

BetterAuthModule.forRoot({ auth: primary, http: { mount: false } });
BetterAuthModule.forRoot({ name: "admin", auth: admin, session: { userId: value => value.principal.uid } });
BetterAuthModule.forRootAsync({ name: "worker", useFactory: async () => ({ auth: primary }) });

// @ts-expect-error A named custom session without user.id requires an explicit user-id mapper.
BetterAuthModule.forRoot({ name: "admin", auth: admin });
// @ts-expect-error App platforms belong to the default registration.
BetterAuthModule.forRoot({ name: "admin", auth: primary, platforms: [] });
// @ts-expect-error Static aliases cannot come from the asynchronous runtime factory.
BetterAuthModule.forRootAsync({ useFactory: () => ({ auth: primary, name: "hidden" }) });
// @ts-expect-error The default registration must match the public Register augmentation.
BetterAuthModule.forRoot({ auth: admin, session: { userId: value => value.principal.uid } });

declare const adminService: BetterAuthService<typeof admin>;
type CustomServiceSession = Assert<Equal<Awaited<ReturnType<typeof adminService.getSession>>, AuthSession<"admin"> | null>>;
type UnwrappedSdkApi = Assert<Equal<typeof adminService.api, typeof admin.api>>;

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

  it.each(["esm", "cjs"] as const)(
    "initializes and closes default plus named services from the actual %s build",
    (format) => {
      const result = node(
        `process.env.NODE_ENV = "test";
         const kit = ${format === "esm" ? 'await import("./dist/index.mjs")' : '(await import("node:module")).createRequire(import.meta.url)("./dist/index.cjs")'};
         const { Test } = await import("@nestjs/testing");
         const { Logger } = await import("@nestjs/common");
         const { betterAuth } = await import("better-auth");
         const { memoryAdapter } = await import("better-auth/adapters/memory");
         const { nestjs, NESTJS_PLUGIN_ID } = await import("nestjs-slightly-better-auth/plugin");
         Logger.overrideLogger(false);
         const names = ["default", "admin", "backup"];
         const auths = names.map((name) => betterAuth({
           baseURL: "http://localhost:3000",
           secret: crypto.randomUUID().repeat(2),
           database: memoryAdapter({}),
           advanced: { cookiePrefix: name, disableOriginCheck: false },
           plugins: [nestjs()],
         }));
         const originalOptions = auths.map((auth) => auth.options);
         const originalPlugins = auths.map((auth) => auth.options.plugins);
         const moduleRef = await Test.createTestingModule({
           imports: auths.map((auth, index) => kit.BetterAuthModule.forRoot({
             ...(index === 0 ? {} : { name: names[index] }),
             auth,
             http: { mount: false },
             logSummary: false,
           })),
         }).compile();
         const observed = {};
         try {
           await moduleRef.init();
           const services = names.map((name) => moduleRef.get(kit.getBetterAuthServiceToken(name)));
           const handles = names.map((name) => moduleRef.get(kit.getBetterAuthHandleToken(name)));
           observed.originalInstances = services.every((service, index) => service.instance === auths[index] && service.api === auths[index].api);
           observed.distinctServices = new Set(services).size === 3;
           observed.defaultClassAlias = moduleRef.get(kit.BetterAuthService) === services[0];
           observed.namedHandles = handles.every((handle, index) => handle.name === names[index] && handle.instance === auths[index]);
           observed.unmodifiedOptions = auths.every((auth, index) => auth.options === originalOptions[index] && auth.options.plugins === originalPlugins[index]);
           observed.absentScope = services.every((service) => {
             try { service.getSession(); return false; }
             catch (error) { return error.code === "NO_AUTH_SCOPE"; }
           });
         } finally {
           await moduleRef.close();
         }
         observed.closed = (await Promise.all(auths.map((auth) => auth.$context))).every((context) =>
           context.getPlugin(NESTJS_PLUGIN_ID)[Symbol.for("nestjs-slightly-better-auth:bridge")].state === "closed");
         console.log(JSON.stringify(observed));`,
        "--input-type=module",
      );
      expect(JSON.parse(result)).toEqual({
        originalInstances: true,
        distinctServices: true,
        defaultClassAlias: true,
        namedHandles: true,
        unmodifiedOptions: true,
        absentScope: true,
        closed: true,
      });
    },
  );

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
          "AcceptPrincipals",
          "AfterAuth",
          "AfterDatabase",
          "AuthFailures",
          "BeforeAuth",
          "BeforeDatabase",
          "BetterAuthConfigurationError",
          "BetterAuthGuard",
          "BetterAuthInfrastructureError",
          "BetterAuthModule",
          "BetterAuthScopeInterceptor",
          "BetterAuthService",
          "CurrentPrincipal",
          "CurrentSession",
          "CurrentUser",
          "EXTENSION_DEFINITION",
          "ForwardAuthCookies",
          "GUARD_CORE",
          "OptionalAuth",
          "POLICY_INVOKER",
          "PRINCIPAL_RESOLVER",
          "Public",
          "Require",
          "RequireAuth",
          "RequireFreshSession",
          "SCOPE_CORE",
          "SESSION_PRINCIPAL_KIND",
          "SkipDefaultRequirements",
          "SkipOriginCheck",
          "UseAuthInstance",
          "UseBetterAuth",
          "absent",
          "allOf",
          "allow",
          "anyOf",
          "authenticated",
          "betterAuthCorsOrigin",
          "defineExtension",
          "defineHttpPlatform",
          "defineInvocationParam",
          "definePolicy",
          "definePrincipalParam",
          "definePrincipalSource",
          "defineTransport",
          "deny",
          "freshSession",
          "getBetterAuthHandleToken",
          "getBetterAuthInstanceToken",
          "getBetterAuthOptionsToken",
          "getBetterAuthServiceToken",
          "getRawCause",
          "httpTransport",
          "isAuthFailure",
          "isConfigurationError",
          "isInfrastructureError",
          "rejected",
          "requirement",
          "sessionPrincipal",
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
    const paths = new Set([
      manifest.main,
      manifest.module,
      manifest.types,
      ...Object.values(manifest.exports).flatMap((entry) =>
        typeof entry === "string"
          ? [entry]
          : Object.values(entry).flatMap(({ types, default: path }) => [
              types,
              path,
            ]),
      ),
    ]);
    const missing = [...paths].filter(
      (path) => !existsSync(new URL(`../${path}`, import.meta.url)),
    );
    expect(missing).toEqual([]);
  });

  it("loads the isolated plugin in both formats without importing the Nest kernel", () => {
    const result = node(
      `import { createRequire, registerHooks } from "node:module";
       import { pathToFileURL } from "node:url";
       const require = createRequire(import.meta.url);
       const dist = pathToFileURL(process.cwd() + "/dist/").href;
       const external = new Set(["better-auth/api", "better-auth/cookies", "defu"]);
       const seen = new Set();
       const hooks = registerHooks({
         resolve(specifier, context, nextResolve) {
           if (context.parentURL?.startsWith(dist) && !specifier.startsWith(".")) {
             if (!external.has(specifier)) {
               throw new Error("Unexpected plugin runtime dependency: " + specifier);
             }
             seen.add(specifier);
           }
           return nextResolve(specifier, context);
         },
       });
       try {
         const esm = await import(${JSON.stringify(`${manifest.name}/plugin`)});
         const canonicalCjs = require(${JSON.stringify(`${manifest.name}/plugin`)});
         const cjs = require("./dist/plugin.cjs");
         const bridge = Symbol.for("nestjs-slightly-better-auth:bridge");
         const plugins = [esm.nestjs(), cjs.nestjs()];
         console.log(JSON.stringify({
           same: esm === canonicalCjs,
           bridges: plugins.map((plugin) => ({ id: plugin.id, protocol: plugin[bridge].protocol })),
           middlewareLoaded: seen.has("better-auth/api"),
         }));
       } finally {
         hooks.deregister();
       }`,
      "--input-type=module",
    );
    expect(JSON.parse(result)).toEqual({
      same: true,
      bridges: [
        { id: "nestjs-slightly-better-auth", protocol: 4 },
        { id: "nestjs-slightly-better-auth", protocol: 4 },
      ],
      middlewareLoaded: true,
    });
  });

  it("carries public registry augmentation through both built declaration formats", async () => {
    await Promise.all([compileConsumer("mts"), compileConsumer("cts")]);
  });
});
