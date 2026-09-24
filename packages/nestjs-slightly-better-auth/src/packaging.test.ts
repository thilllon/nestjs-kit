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

async function compileConsumer(
  extension: "cts" | "mts",
  source?: string,
): Promise<void> {
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
      source ??
        `import { betterAuth } from "better-auth";
import { customSession } from "better-auth/plugins";
import { BetterAuthModule, type BetterAuthService } from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { fastifyPlatform } from "nestjs-slightly-better-auth/fastify";
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
BetterAuthModule.forRoot({ auth: primary, platforms: [expressPlatform({ clientIp: request => request.ip ?? null })] });
BetterAuthModule.forRoot({ auth: primary, platforms: [fastifyPlatform({ clientIp: request => request.raw.socket.remoteAddress ?? null })] });
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
  it.each([
    { format: "esm", platform: "express" },
    { format: "cjs", platform: "express" },
    { format: "esm", platform: "fastify" },
    { format: "cjs", platform: "fastify" },
  ] as const)(
    "initializes $platform through its actual $format artifact",
    ({ format, platform }) => {
      const result = node(
        `process.env.NODE_ENV = "test";
         const { createRequire } = await import("node:module");
         const require = createRequire(import.meta.url);
         const load = ${format === "esm" ? "path => import(path)" : "path => require(path)"};
         const kit = await load("./dist/index.${format === "esm" ? "mjs" : "cjs"}");
         const platform = await load("./dist/${platform}.${format === "esm" ? "mjs" : "cjs"}");
         const { Test } = await import("@nestjs/testing");
         const { Logger } = await import("@nestjs/common");
         const { ${platform === "express" ? "ExpressAdapter" : "FastifyAdapter"}: Adapter } = await import("@nestjs/platform-${platform}");
         const { betterAuth } = await import("better-auth");
         const { memoryAdapter } = await import("better-auth/adapters/memory");
         const { nestjs, NESTJS_PLUGIN_ID } = await import("nestjs-slightly-better-auth/plugin");
         Logger.overrideLogger(false);
         const auth = betterAuth({
           baseURL: "http://localhost:3000",
           secret: crypto.randomUUID().repeat(2),
           database: memoryAdapter({}),
           logger: { disabled: true },
           plugins: [nestjs()],
         });
         const moduleRef = await Test.createTestingModule({
           imports: [kit.BetterAuthModule.forRoot({
             auth,
             platforms: [platform.${platform}Platform()],
             logSummary: false,
           })],
         }).compile();
         const adapter = new Adapter();
         const app = moduleRef.createNestApplication(adapter, { logger: false });
         const observed = {};
         try {
           await app.init();
           ${platform === "fastify" ? "await adapter.getInstance().ready();" : ""}
           observed.exports = Object.keys(platform).sort();
           observed.adapter = app.getHttpAdapter().getType();
           observed.originalInstance = app.get(kit.BetterAuthService).instance === auth;
           observed.bound = (await auth.$context).getPlugin(NESTJS_PLUGIN_ID)[Symbol.for("nestjs-slightly-better-auth:bridge")].state === "bound";
         } finally {
           await app.close();
         }
         observed.closed = (await auth.$context).getPlugin(NESTJS_PLUGIN_ID)[Symbol.for("nestjs-slightly-better-auth:bridge")].state === "closed";
         console.log(JSON.stringify(observed));`,
        "--input-type=module",
      );
      expect(JSON.parse(result)).toEqual({
        exports: [
          platform === "express" ? "ExpressPlatform" : "FastifyPlatform",
          `${platform}Platform`,
        ],
        adapter: platform,
        originalInstance: true,
        bound: true,
        closed: true,
      });
    },
  );

  it.each(["mts", "cts"] as const)(
    "keeps optional principal kinds out of a root-only .%s consumer",
    async (extension) => {
      await compileConsumer(
        extension,
        `import type { PrincipalKind, PrincipalOfKind } from "nestjs-slightly-better-auth";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type RootKinds = Assert<Equal<PrincipalKind, "session">>;
// @ts-expect-error API-key types require their optional subpath import.
type UnavailableApiKey = PrincipalOfKind<"api-key">;
`,
      );
    },
  );

  it.each(["mts", "cts"] as const)(
    "preserves authorization builders and opt-in principal types for a .%s consumer",
    async (extension) => {
      await compileConsumer(
        extension,
        `import type { PrincipalOfKind } from "nestjs-slightly-better-auth";
import { permission, RequirePermission } from "nestjs-slightly-better-auth/admin";
import { orgPermission, orgMember, fromParam, ActiveOrganizationId } from "nestjs-slightly-better-auth/organization";
import { apiKeyPrincipal, apiKeyPermission, type ApiKeyPrincipal } from "nestjs-slightly-better-auth/api-key";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type KeyAugmentation = Assert<Equal<PrincipalOfKind<"api-key">, ApiKeyPrincipal>>;
declare const principal: PrincipalOfKind<"api-key">;
const owner: string | null = principal.userId;
const organization: string | null = principal.organizationId;
// @ts-expect-error Verified principals never expose the raw credential.
principal.key;
// @ts-expect-error Verified permission grants are read-only.
principal.permissions?.project?.push("write");
permission({ user: ["ban"] }, { principals: ["session", "api-key"] });
RequirePermission({ user: ["list"] });
orgPermission({ member: ["create"] }, { organization: fromParam("organizationId") });
orgMember();
ActiveOrganizationId();
apiKeyPrincipal({ references: key => key.configId === "org" ? "organization" : "user" });
apiKeyPermission({ project: ["read"] });
void owner;
void organization;
`,
      );
    },
  );

  it.each(["esm", "cjs"] as const)(
    "registers authorization units from the actual %s artifacts",
    (format) => {
      const result = node(
        `process.env.NODE_ENV = "test";
         const { createRequire } = await import("node:module");
         const require = createRequire(import.meta.url);
         const load = ${format === "esm" ? "path => import(path)" : "path => require(path)"};
         const kit = await load("./dist/index.${format === "esm" ? "mjs" : "cjs"}");
         const adminUnit = await load("./dist/admin.${format === "esm" ? "mjs" : "cjs"}");
         const orgUnit = await load("./dist/organization.${format === "esm" ? "mjs" : "cjs"}");
         const keyUnit = await load("./dist/api-key.${format === "esm" ? "mjs" : "cjs"}");
         const { Test } = await import("@nestjs/testing");
         const { Logger } = await import("@nestjs/common");
         const { betterAuth } = await import("better-auth");
         const { admin, organization } = await import("better-auth/plugins");
         const { apiKey } = await import("@better-auth/api-key");
         const { memoryAdapter } = await import("better-auth/adapters/memory");
         const { nestjs } = await import("nestjs-slightly-better-auth/plugin");
         Logger.overrideLogger(false);
         const auth = betterAuth({
           baseURL: "http://localhost:3000",
           secret: crypto.randomUUID().repeat(2),
           database: memoryAdapter({}),
           logger: { disabled: true },
           plugins: [admin(), organization(), apiKey(), nestjs()],
         });
         const moduleRef = await Test.createTestingModule({
           imports: [kit.BetterAuthModule.forRoot({ auth, principals: [keyUnit.apiKeyPrincipal()], http: { mount: false }, logSummary: false })],
         }).compile();
         try {
           await moduleRef.init();
           console.log(JSON.stringify({
             originalInstance: moduleRef.get(kit.BetterAuthService).instance === auth,
             adminPolicy: adminUnit.permission({ user: ["ban"] }).policy === adminUnit.adminPermissionPolicy,
             orgPolicy: orgUnit.orgPermission({ member: ["create"] }).policy === orgUnit.orgPermissionPolicy,
             orgMemberPolicy: orgUnit.orgMember().policy === orgUnit.orgMemberPolicy,
             keyKind: keyUnit.API_KEY_PRINCIPAL_KIND,
             keySource: keyUnit.apiKeyPrincipal().kinds,
             keyRequirement: keyUnit.apiKeyPermission({ project: ["read"] }).params,
           }));
         } finally {
           await moduleRef.close();
         }`,
        "--input-type=module",
      );
      expect(JSON.parse(result)).toEqual({
        originalInstance: true,
        adminPolicy: true,
        orgPolicy: true,
        orgMemberPolicy: true,
        keyKind: "api-key",
        keySource: ["api-key"],
        keyRequirement: { project: ["read"] },
      });
    },
  );

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

  it.each(["esm", "cjs"] as const)(
    "loads the root %s entry without testing peers or test runners",
    (format) => {
      const result = node(
        `import { createRequire, registerHooks } from "node:module";
         const require = createRequire(import.meta.url);
         const forbidden = ["@nestjs/testing", "vitest", "jest", "@jest/globals", "node:test", "node:assert", "node:assert/strict", "better-auth/plugins"];
         const hooks = registerHooks({
           resolve(specifier, context, nextResolve) {
             if (forbidden.includes(specifier)) {
               throw new Error("The root entry loaded " + specifier);
             }
             return nextResolve(specifier, context);
           },
         });
         try {
           const kit = ${format === "esm" ? 'await import("./dist/index.mjs")' : 'require("./dist/index.cjs")'};
           console.log(JSON.stringify({ module: typeof kit.BetterAuthModule }));
         } finally {
           hooks.deregister();
         }`,
        "--input-type=module",
      );
      expect(JSON.parse(result)).toEqual({ module: "function" });
    },
  );

  it.each(["esm", "cjs"] as const)(
    "loads ./testing and ./testing/conformance from the actual %s artifacts without a test runner",
    (format) => {
      const result = node(
        `process.env.NODE_ENV = "test";
         import { createRequire, registerHooks } from "node:module";
         const require = createRequire(import.meta.url);
         const runners = ["vitest", "jest", "@jest/globals", "node:test"];
         const hooks = registerHooks({
           resolve(specifier, context, nextResolve) {
             if (runners.includes(specifier)) {
               throw new Error("A testing entry loaded " + specifier);
             }
             return nextResolve(specifier, context);
           },
         });
         const extension = ${JSON.stringify(format === "esm" ? "mjs" : "cjs")};
         const load = ${format === "esm" ? "(path) => import(path)" : "(path) => require(path)"};
         try {
           const kit = await load("./dist/index." + extension);
           const testing = await load("./dist/testing." + extension);
           const conformance = await load("./dist/testing/conformance." + extension);
           const { Test } = await import("@nestjs/testing");
           const { Logger } = await import("@nestjs/common");
           const { betterAuth } = await import("better-auth");
           const { memoryAdapter } = await import("better-auth/adapters/memory");
           const { nestjs } = await import("nestjs-slightly-better-auth/plugin");
           Logger.overrideLogger(false);
           const instance = (cookiePrefix) => betterAuth({
             baseURL: "http://localhost:3000",
             secret: crypto.randomUUID().repeat(2),
             database: memoryAdapter({}),
             logger: { disabled: true },
             advanced: { cookiePrefix },
             plugins: [nestjs()],
           });
           const modules = () => [
             kit.BetterAuthModule.forRoot({ auth: instance("first"), http: { mount: false }, logSummary: false }),
             kit.BetterAuthModule.forRoot({ name: "named", auth: instance("named"), http: { mount: false }, logSummary: false }),
           ];
           const fixed = (userId) => ({ kind: "session", source: "better-auth:session", userId, session: {} });
           const guarded = Test.createTestingModule({ imports: modules() });
           testing.overrideAuthGuard(guarded, { principal: null });
           const guardRef = await guarded.compile();
           await guardRef.init();
           const allowed = await guardRef.get(kit.BetterAuthGuard).canActivate({
             getArgs: () => [{}, {}],
             getClass: () => Object,
             getHandler: () => function handler() {},
             getType: () => "http",
           });
           await guardRef.close();
           const builder = Test.createTestingModule({ imports: modules() });
           testing.overridePrincipal(builder, fixed("default-user"));
           testing.overridePrincipal(builder, fixed("named-user"), { instance: "named" });
           const moduleRef = await builder.compile();
           await moduleRef.init();
           const resolver = moduleRef.get(kit.PRINCIPAL_RESOLVER);
           const call = { key: {}, invocation: {}, headers: () => new Headers(), clientIp: null, cookies: null, param: () => undefined };
           const principals = [];
           for (const name of [undefined, "named"]) {
             const result = await resolver.resolve(call, {
               auth: moduleRef.get(kit.getBetterAuthHandleToken(name)),
               freshness: "default",
               accepts: new Set(["session"]),
               sourceSet: "0",
             });
             principals.push(result.principal?.userId ?? result.outcome);
           }
           await moduleRef.close();
           // One real kit from the artifact: the inlined plugin handshake, decorated harness classes and Nest boots.
           const auth = conformance.createConformanceAuth();
           const credential = async () => {
             const email = crypto.randomUUID() + "@artifact.example";
             const { user } = await auth.api.signUpEmail({ body: { email, password: crypto.randomUUID(), name: "Artifact" } });
             return testing.authHeadersFor(auth, user.id);
           };
           const outcomes = [];
           for (const item of conformance.principalSourceConformance({
             source: kit.sessionPrincipal(),
             auth,
             credentials: {
               valid: credential,
               invalid: () => new Headers({ cookie: "better-auth.session_token=invalid.value" }),
             },
           })) {
             outcomes.push(item.skip === undefined ? ((await item.run())?.skipped ? "skipped" : "passed") : "skipped");
           }
           const registered = [];
           conformance.runConformance(
             [
               { id: "C-run", title: "runs", run: async () => {} },
               { id: "C-skip", title: "skips", skip: "not supported", run: async () => { throw new Error("ran"); } },
             ],
             {
               describe: (name, fn) => { registered.push("describe " + name); fn(); },
               it: (name) => registered.push("it " + name),
             },
           );
           console.log(JSON.stringify({
             testing: Object.keys(testing).sort(),
             conformance: Object.keys(conformance).sort(),
             allowed,
             principals,
             outcomes: [...new Set(outcomes)].sort(),
             registered,
             probe: conformance.conformanceProbePlugin().id,
           }));
         } finally {
           hooks.deregister();
         }`,
        "--input-type=module",
      );
      expect(JSON.parse(result)).toEqual({
        testing: [
          "authHeadersFor",
          "initTestApp",
          "overrideAuthGuard",
          "overrideDecisions",
          "overridePrincipal",
          "stampPrincipal",
          "testPrincipal",
        ],
        conformance: [
          "PROBE_TRUSTED_ORIGIN",
          "conformanceProbePlugin",
          "createConformanceAuth",
          "httpPlatformConformance",
          "policyConformance",
          "principalSourceConformance",
          "runConformance",
          "transportConformance",
        ],
        allowed: true,
        principals: ["default-user", "named-user"],
        outcomes: ["passed", "skipped"],
        registered: [
          "describe C-run",
          "it runs",
          "describe C-skip",
          "it skips (skipped: not supported)",
        ],
        probe: "nestjs-slightly-better-auth-conformance-probe",
      });
    },
  );

  it("keeps the testing entries to their Better Auth specifiers in both formats", () => {
    const result = node(
      `import { createRequire, registerHooks } from "node:module";
       import { pathToFileURL } from "node:url";
       const require = createRequire(import.meta.url);
       const dist = pathToFileURL(process.cwd() + "/dist/").href;
       const seen = { testing: new Set(), conformance: new Set() };
       let current = "testing";
       const hooks = registerHooks({
         resolve(specifier, context, nextResolve) {
           if (context.parentURL?.startsWith(dist) && specifier.startsWith("better-auth")) {
             seen[current].add(specifier);
           }
           return nextResolve(specifier, context);
         },
       });
       try {
         await import("./dist/testing.mjs");
         require("./dist/testing.cjs");
         current = "conformance";
         await import("./dist/testing/conformance.mjs");
         require("./dist/testing/conformance.cjs");
       } finally {
         hooks.deregister();
       }
       console.log(JSON.stringify({
         testing: [...seen.testing].sort(),
         conformance: [...seen.conformance].sort(),
       }));`,
      "--input-type=module",
    );
    const seen = JSON.parse(result) as {
      testing: string[];
      conformance: string[];
    };
    // ./testing is a Nest-facing entry (better-auth/api); ./testing/conformance adds its own row and bundles ./plugin.
    expect(
      seen.testing.filter(
        (specifier) => !["better-auth", "better-auth/api"].includes(specifier),
      ),
    ).toEqual([]);
    expect(
      seen.conformance.filter(
        (specifier) =>
          ![
            "better-auth",
            "better-auth/api",
            "better-auth/plugins",
            "better-auth/adapters/memory",
            "better-auth/cookies",
          ].includes(specifier),
      ),
    ).toEqual([]);
    expect(seen.conformance).toContain("better-auth/adapters/memory");
  });

  it("composes testing overrides from the ESM and CommonJS copies on one builder", () => {
    const result = node(
      `import { createRequire } from "node:module";
       const require = createRequire(import.meta.url);
       const esm = await import("./dist/testing.mjs");
       const cjs = require("./dist/testing.cjs");
       const kit = await import("./dist/index.mjs");
       const { Test } = await import("@nestjs/testing");
       const { Logger } = await import("@nestjs/common");
       const { betterAuth } = await import("better-auth");
       const { memoryAdapter } = await import("better-auth/adapters/memory");
       const { nestjs } = await import("nestjs-slightly-better-auth/plugin");
       Logger.overrideLogger(false);
       const instance = (cookiePrefix) => betterAuth({
         baseURL: "http://localhost:3000",
         secret: crypto.randomUUID().repeat(2),
         database: memoryAdapter({}),
         logger: { disabled: true },
         advanced: { cookiePrefix },
         plugins: [nestjs()],
       });
       const builder = Test.createTestingModule({
         imports: [
           kit.BetterAuthModule.forRoot({ auth: instance("first"), http: { mount: false }, logSummary: false }),
           kit.BetterAuthModule.forRoot({ name: "named", auth: instance("named"), http: { mount: false }, logSummary: false }),
         ],
       });
       const fixed = (userId) => ({ kind: "session", source: "better-auth:session", userId, session: {} });
       cjs.overridePrincipal(builder, fixed("from-cjs"));
       esm.overridePrincipal(builder, fixed("from-esm"), { instance: "named" });
       const seen = [];
       cjs.overrideDecisions(builder, (id) => { seen.push("cjs:" + id); return id === "cjs" ? { effect: "allow" } : undefined; });
       esm.overrideDecisions(builder, (id) => { seen.push("esm:" + id); return { effect: "deny", reason: "ESM" }; });
       const moduleRef = await builder.compile();
       await moduleRef.init();
       const resolver = moduleRef.get(kit.PRINCIPAL_RESOLVER);
       const call = { key: {}, invocation: {}, headers: () => new Headers(), clientIp: null, cookies: null, param: () => undefined };
       const principals = [];
       for (const name of [undefined, "named"]) {
         const result = await resolver.resolve(call, {
           auth: moduleRef.get(kit.getBetterAuthHandleToken(name)),
           freshness: "default",
           accepts: new Set(["session"]),
           sourceSet: "0",
         });
         principals.push(result.principal?.userId ?? result.outcome);
       }
       const invoker = moduleRef.get(kit.POLICY_INVOKER);
       const policy = (id) => ({ id, evaluate: () => ({ effect: "deny", reason: "REAL" }) });
       const decisions = [
         await invoker.invoke(policy("cjs"), {}, { principal: fixed("u1") }),
         await invoker.invoke(policy("other"), {}, { principal: fixed("u1") }),
       ];
       await moduleRef.close();
       console.log(JSON.stringify({ principals, decisions, seen }));`,
      "--input-type=module",
    );
    expect(JSON.parse(result)).toEqual({
      principals: ["from-cjs", "from-esm"],
      decisions: [{ effect: "allow" }, { effect: "deny", reason: "ESM" }],
      seen: ["cjs:cjs", "cjs:other", "esm:other"],
    });
  });

  it.each(["mts", "cts"] as const)(
    "types the testing entries for a .%s consumer",
    async (extension) => {
      await compileConsumer(
        extension,
        `import { overrideAuthGuard, stampPrincipal, testPrincipal } from "nestjs-slightly-better-auth/testing";
import {
  runConformance,
  transportConformance,
  type ConformanceCase,
  type ConformanceRunner,
  type TransportConformanceOptions,
  type PolicyConformanceOptions,
} from "nestjs-slightly-better-auth/testing/conformance";
declare const options: TransportConformanceOptions;
declare const runner: ConformanceRunner;
const cases: ConformanceCase[] = transportConformance(options);
runConformance(cases, runner);
const skipped: string | undefined = cases[0]?.skip;
type Requirement = PolicyConformanceOptions["requirement"];
const source = testPrincipal({ kind: "session", source: "test", userId: "u1", session: {} as never });
const kinds: readonly string[] = source.kinds;
// @ts-expect-error A conformance case needs an id.
const invalid: ConformanceCase = { title: "missing id", run: async () => {} };
void overrideAuthGuard;
void stampPrincipal;
void skipped;
void kinds;
void invalid;
export type { Requirement };
`,
      );
    },
  );
});
