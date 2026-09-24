import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import manifest from "../package.json" with { type: "json" };

const execute = promisify(execFile);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const compiler = fileURLToPath(
  new URL("../bin/tsc", import.meta.resolve("typescript")),
);
/** Public specifiers mapped onto their source entries, so consumers compile without `dist`. */
const publicPaths = Object.fromEntries(
  Object.entries(manifest.exports).flatMap(([subpath, conditions]) =>
    typeof conditions === "string"
      ? []
      : [
          [
            `${manifest.name}${subpath.slice(1)}`,
            [
              join(
                sourceDirectory,
                `${basename(conditions.import.default, ".mjs")}.ts`,
              ),
            ],
          ],
        ],
  ),
);
const assertions = `
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
`;

/** Type-checks one consumer module and returns the compiler diagnostics. */
async function diagnostics(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nsba-consumer-types-"));
  try {
    await symlink(
      join(sourceDirectory, "../node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    await writeFile(join(directory, "consumer.mts"), assertions + source);
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          paths: publicPaths,
        },
        files: ["consumer.mts"],
      }),
    );
    const result = await execute(process.execPath, [
      compiler,
      "--project",
      join(directory, "tsconfig.json"),
      "--pretty",
      "false",
    ]);
    return result.stdout + result.stderr;
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      return String(error.stdout);
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("public consumer types from source entries", () => {
  it("derives SDK fallbacks and rejects unknown principal kinds without a registry", {
    timeout: 30_000,
  }, async () => {
    expect(
      await diagnostics(`
import type { Session, User } from "better-auth";
import {
  AcceptPrincipals,
  allow,
  definePolicy,
  definePrincipalParam,
  type AuthPrincipal,
  type AuthSession,
  type BetterAuthService,
  type IsRegistered,
  type PrincipalKind,
} from "nestjs-slightly-better-auth";
import { permission, type AdminPermissions } from "nestjs-slightly-better-auth/admin";
import { orgPermission, type OrgPermissions } from "nestjs-slightly-better-auth/organization";

type Unregistered = Assert<Equal<IsRegistered, false>>;
type FallbackSession = Assert<Equal<AuthSession, { session: Session; user: User }>>;
declare const service: BetterAuthService;
type ServiceSession = Assert<Equal<Awaited<ReturnType<typeof service.getSession>>, { session: Session; user: User } | null>>;
type AnyAdminPermission = Assert<Equal<AdminPermissions, Record<string, readonly string[]>>>;
type AnyOrgPermission = Assert<Equal<OrgPermissions, Record<string, readonly string[]>>>;
permission({ project: ["archive"] });
orgPermission({ project: ["archive"] });

type RootKinds = Assert<Equal<PrincipalKind, "session">>;
declare const principal: AuthPrincipal;
type SessionPrincipalOnly = Assert<Equal<typeof principal.kind, "session">>;
const scoped = definePolicy<{ scope: string }>({ id: "scope", evaluate: () => allow() });
AcceptPrincipals("session");
scoped({ scope: "read" }, { principals: ["session"] });
// @ts-expect-error Route acceptance names only registered principal kinds.
AcceptPrincipals("session", "robot");
// @ts-expect-error Permission overrides name only registered principal kinds.
permission({ user: ["ban"] }, { principals: ["robot"] });
// @ts-expect-error Requirement overrides name only registered principal kinds.
scoped({ scope: "read" }, { principals: ["robot"] });
// @ts-expect-error Principal parameters project only registered principal kinds.
definePrincipalParam({ kind: "robot", reason: "ROBOT_REQUIRED", project: (value) => value });
// @ts-expect-error Policies judge only registered principal kinds.
definePolicy<{ scope: string }, "robot">({ id: "robot", evaluate: () => allow() });
`),
    ).toBe("");
  });

  it("requires a user-id mapper for customSession in every registration shape", {
    timeout: 30_000,
  }, async () => {
    expect(
      await diagnostics(`
import { betterAuth } from "better-auth";
import { customSession } from "better-auth/plugins";
import { BetterAuthModule } from "nestjs-slightly-better-auth";

const standard = betterAuth({});
const custom = betterAuth({ plugins: [customSession(async ({ user }) => ({ principal: { uid: user.id } }))] });

BetterAuthModule.forRoot({ auth: standard });
BetterAuthModule.forRoot({ auth: custom, session: { userId: (value) => value.principal.uid } });
BetterAuthModule.forRoot({ auth: custom, session: false });
BetterAuthModule.forRoot({ name: "custom", auth: custom, session: { userId: (value) => value.principal.uid } });
BetterAuthModule.forRootAsync({ name: "custom", useFactory: async () => ({ auth: custom, session: { userId: (value) => value.principal.uid } }) });
// @ts-expect-error The default customSession registration needs session.userId.
BetterAuthModule.forRoot({ auth: custom });
// @ts-expect-error Session options without userId do not satisfy customSession.
BetterAuthModule.forRoot({ auth: custom, session: { freshness: "authoritative" } });
// @ts-expect-error A named customSession registration needs session.userId.
BetterAuthModule.forRoot({ name: "custom", auth: custom });
// @ts-expect-error An asynchronous factory result needs session.userId.
BetterAuthModule.forRootAsync({ name: "custom", useFactory: async () => ({ auth: custom }) });
`),
    ).toBe("");
  });

  it("keeps static and app-level options outside asynchronous factories", {
    timeout: 30_000,
  }, async () => {
    const source = `
import { betterAuth } from "better-auth";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { rpcTransport } from "nestjs-slightly-better-auth/microservices";

const auth = betterAuth({});
BetterAuthModule.forRootAsync({ platforms: [expressPlatform()], transports: [rpcTransport()], principals: [], globalScope: true, useFactory: async () => ({ auth, http: { mount: false } }) });
BetterAuthModule.forRootAsync({ name: "worker", isGlobal: false, globalGuard: false, useFactory: () => ({ auth }) });
// @ts-expect-error The registration alias is static.
BetterAuthModule.forRootAsync({ useFactory: () => ({ auth, name: "worker" }) });
// @ts-expect-error App platforms are static.
BetterAuthModule.forRootAsync({ useFactory: () => ({ auth, platforms: [expressPlatform()] }) });
// @ts-expect-error App transports are static.
BetterAuthModule.forRootAsync({ useFactory: () => ({ auth, transports: [rpcTransport()] }) });
// @ts-expect-error Principal sources define providers and are static.
BetterAuthModule.forRootAsync({ useFactory: () => ({ auth, principals: [] }) });
// @ts-expect-error Enhancer registration is static.
BetterAuthModule.forRootAsync({ useFactory: () => ({ auth, globalScope: false }) });
// @ts-expect-error Named registrations cannot own app platforms.
BetterAuthModule.forRootAsync({ name: "worker", platforms: [expressPlatform()], useFactory: () => ({ auth }) });
// @ts-expect-error Named registrations cannot own app transports.
BetterAuthModule.forRoot({ name: "worker", auth, transports: [rpcTransport()] });
`;
    expect(await diagnostics(source)).toBe("");
    expect(
      await diagnostics(
        source.replace(
          "// @ts-expect-error Principal sources define providers and are static.\n",
          "",
        ),
      ),
    ).toContain(
      "required in type 'StaticOptionMustBePassedToForRootAsync<\"principals\">'",
    );
  });

  it("types registered default and named instances, their permissions and custom principal kinds", {
    timeout: 30_000,
  }, async () => {
    expect(
      await diagnostics(`
import { betterAuth } from "better-auth";
import { admin, customSession, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import {
  AcceptPrincipals,
  BetterAuthModule,
  allow,
  definePolicy,
  definePrincipalParam,
  deny,
  type AuthOf,
  type AuthPrincipal,
  type AuthPrincipalBase,
  type AuthSession,
  type AuthUser,
  type BetterAuthService,
  type IsRegistered,
  type RegisteredAuth,
} from "nestjs-slightly-better-auth";
import { permission, RequirePermission } from "nestjs-slightly-better-auth/admin";
import { fromParam, orgPermission, RequireOrgPermission } from "nestjs-slightly-better-auth/organization";

const primary = betterAuth({ user: { additionalFields: { department: { type: "string", required: true } } }, plugins: [admin(), organization()] });
const projects = createAccessControl({ project: ["create", "archive"] } as const);
const tenant = betterAuth({ plugins: [admin({ ac: projects, roles: { owner: projects.newRole({ project: ["create", "archive"] }) } }), customSession(async ({ user }) => ({ principal: { uid: user.id } }))] });

interface OAuthPrincipal extends AuthPrincipalBase {
  readonly kind: "oauth-access-token";
  readonly scopes: readonly string[];
}

declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: typeof primary;
    instances: { tenant: typeof tenant };
  }

  interface PrincipalKinds {
    "oauth-access-token": OAuthPrincipal;
  }
}

type Registered = Assert<Equal<IsRegistered, true>>;
type DefaultInstance = Assert<Equal<RegisteredAuth, typeof primary>>;
type NamedInstance = Assert<Equal<AuthOf<"tenant">, typeof tenant>>;
type DefaultUserField = Assert<Equal<AuthUser["department"], string>>;
type NamedSession = Assert<Equal<AuthSession<"tenant">, { principal: { uid: string } }>>;
type NamedUser = Assert<Equal<AuthUser<"tenant">, never>>;
declare const primaryService: BetterAuthService;
declare const tenantService: BetterAuthService<AuthOf<"tenant">>;
type DefaultServiceSession = Assert<Equal<Awaited<ReturnType<typeof primaryService.getSession>>, AuthSession | null>>;
type NamedServiceSession = Assert<Equal<Awaited<ReturnType<typeof tenantService.getSession>>, { principal: { uid: string } } | null>>;
type NamedServiceApi = Assert<Equal<typeof tenantService.api, typeof tenant.api>>;

BetterAuthModule.forRoot({ auth: primary });
BetterAuthModule.forRoot({ name: "tenant", auth: tenant, session: { userId: (value) => value.principal.uid } });
// @ts-expect-error The default registration must use the registered default instance.
BetterAuthModule.forRoot({ auth: tenant, session: { userId: (value) => value.principal.uid } });

permission({ user: ["ban"] });
RequirePermission({ session: ["revoke"] });
permission<"tenant">({ project: ["archive"] });
RequirePermission<"tenant">({ project: ["create"] });
// @ts-expect-error Admin actions stay literal for the registered default instance.
permission({ user: ["explode"] });
// @ts-expect-error The default admin plugin has no project statements.
permission({ project: ["archive"] });
// @ts-expect-error The tenant admin plugin has only project statements.
permission<"tenant">({ user: ["ban"] });
orgPermission({ member: ["create"] }, { organization: fromParam("organizationId") });
RequireOrgPermission({ invitation: ["cancel"] });
// @ts-expect-error Organization resources stay literal for the registered default instance.
orgPermission({ imaginary: ["create"] });
// @ts-expect-error The tenant instance has no organization plugin.
orgPermission<"tenant">({ member: ["create"] });

AcceptPrincipals("session", "oauth-access-token");
permission({ user: ["list"] }, { principals: ["session", "oauth-access-token"] });
const CurrentScopes = definePrincipalParam({ kind: "oauth-access-token", reason: "OAUTH_REQUIRED", project: (value) => value.scopes });
const scoped = definePolicy<{ scope: string }, "oauth-access-token">({
  id: "scope",
  requires: { principals: ["oauth-access-token"] },
  evaluate: ({ scope }, { principal }) => (principal.scopes.includes(scope) ? allow() : deny({ reason: "MISSING_SCOPE" })),
});
declare const principal: AuthPrincipal;
if (principal.kind === "oauth-access-token") {
  const scopes: readonly string[] = principal.scopes;
  void scopes;
}
// @ts-expect-error Kinds outside PrincipalKinds remain unknown.
AcceptPrincipals("robot");
void CurrentScopes;
void scoped;
`),
    ).toBe("");
  });

  // Hook methods spell out the complete SDK signature; #589 tracks narrower compatible signatures.
  it("keeps hook bodies raw and database hook payloads and results SDK-typed", {
    timeout: 30_000,
  }, async () => {
    expect(
      await diagnostics(`
import { betterAuth, type GenericEndpointContext } from "better-auth";
import {
  AfterDatabase,
  BeforeAuth,
  BeforeDatabase,
  type AuthHookContext,
  type DatabaseHookData,
  type DatabaseHookMethod,
} from "nestjs-slightly-better-auth";

const primary = betterAuth({ emailAndPassword: { enabled: true }, user: { additionalFields: { department: { type: "string", required: true } } } });

declare module "nestjs-slightly-better-auth" {
  interface Register {
    auth: typeof primary;
  }
}

type Context = GenericEndpointContext | null | undefined;
type UpdateResult = ReturnType<DatabaseHookMethod<"user.update", "before">>;
type DeleteResult = ReturnType<DatabaseHookMethod<"user.delete", "before">>;

export class Hooks {
  @BeforeAuth("/sign-up/email")
  signUp(ctx: AuthHookContext<"/sign-up/email">) {
    const email: unknown = ctx.body.email;
    // @ts-expect-error Before-hooks see the endpoint body before validation.
    const trusted: string = ctx.body.email;
    void email;
    void trusted;
  }

  // @ts-expect-error A hook cannot declare the raw endpoint body as validated input.
  @BeforeAuth("/sign-up/email")
  validated(ctx: AuthHookContext<"/sign-up/email"> & { body: { email: string } }) {
    void ctx;
  }

  @BeforeDatabase("user.update")
  update(data: DatabaseHookData<"user.update">, ctx: Context): UpdateResult {
    const department: string | undefined = data.department;
    // @ts-expect-error Update payloads contain only the changed fields.
    const required: string = data.department;
    void ctx;
    void department;
    void required;
    return { data: { department: "engineering" } };
  }

  @BeforeDatabase("user.delete")
  veto(user: DatabaseHookData<"user.delete">, ctx: Context): DeleteResult {
    void ctx;
    return user.email !== "owner@example.com";
  }

  @BeforeDatabase("user.delete")
  replace(user: DatabaseHookData<"user.delete">, ctx: Context): DeleteResult {
    void ctx;
    // @ts-expect-error Delete hooks can only abort; the SDK ignores replacement data.
    return { data: { id: user.id } };
  }

  @AfterDatabase("session.create")
  audit(session: DatabaseHookData<"session.create", "after">, ctx: Context): void {
    void session.userId;
    void ctx?.path;
  }

  // @ts-expect-error Database hooks must handle SDK writes outside an endpoint.
  @AfterDatabase("session.create")
  assumesEndpoint(session: DatabaseHookData<"session.create", "after">, ctx: GenericEndpointContext): void {
    void session.userId;
    void ctx.path;
  }
}
`),
    ).toBe("");
  });

  it("adds the API-key principal kind only to programs that import ./api-key", {
    timeout: 30_000,
  }, async () => {
    const [withSubpath, rootOnly] = await Promise.all([
      diagnostics(`
import { betterAuth } from "better-auth";
import { AcceptPrincipals, BetterAuthModule, type AuthPrincipal, type PrincipalKind, type PrincipalOfKind } from "nestjs-slightly-better-auth";
import { permission } from "nestjs-slightly-better-auth/admin";
import { apiKeyPermission, apiKeyPrincipal, type ApiKeyPrincipal } from "nestjs-slightly-better-auth/api-key";

type Kinds = Assert<Equal<PrincipalKind, "session" | "api-key">>;
type KeyPrincipal = Assert<Equal<PrincipalOfKind<"api-key">, ApiKeyPrincipal>>;
AcceptPrincipals("session", "api-key");
permission({ user: ["ban"] }, { principals: ["session", "api-key"] });
apiKeyPermission({ project: ["read"] });
BetterAuthModule.forRoot({ auth: betterAuth({}), principals: [apiKeyPrincipal({ references: (key) => (key.configId === "org" ? "organization" : "user") })] });
declare const principal: AuthPrincipal;
if (principal.kind === "api-key") {
  const keyId: string = principal.keyId;
  const organizationId: string | null = principal.organizationId;
  // @ts-expect-error Verified key principals never expose the raw credential.
  principal.key;
  void keyId;
  void organizationId;
}
`),
      diagnostics(`
import { AcceptPrincipals, type PrincipalKind } from "nestjs-slightly-better-auth";
import { permission } from "nestjs-slightly-better-auth/admin";

type Kinds = Assert<Equal<PrincipalKind, "session">>;
// @ts-expect-error The API-key kind needs the ./api-key subpath in the program.
AcceptPrincipals("session", "api-key");
// @ts-expect-error The API-key kind needs the ./api-key subpath in the program.
permission({ user: ["ban"] }, { principals: ["api-key"] });
`),
    ]);
    expect({ withSubpath, rootOnly }).toEqual({
      withSubpath: "",
      rootOnly: "",
    });
  });
});
