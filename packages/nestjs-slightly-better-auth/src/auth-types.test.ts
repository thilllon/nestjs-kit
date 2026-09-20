import { execFile } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const typesPath = join(sourceDirectory, "auth-types.js");
const contractsPath = join(sourceDirectory, "auth-contracts.js");
const compiler = fileURLToPath(
  new URL("../bin/tsc", import.meta.resolve("typescript")),
);

async function compile(source: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "nsba-contract-types-"));
  try {
    await symlink(
      join(sourceDirectory, "../node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    await writeFile(join(directory, "case.mts"), source);
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
        files: ["case.mts"],
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

const assertions = `
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
`;

it("derives unregistered SDK sessions and requires a mapper for custom sessions", async () => {
  await compile(`
import { betterAuth } from "better-auth";
import { customSession } from "better-auth/plugins";
import type { Session, User } from "better-auth";
import type { AuthLike, AuthSession, AuthOf, UserOf, SessionOf, IsRegistered, AdminPermissions, OrgPermissions, PrincipalKind, UnvalidatedBody, DatabaseHookResult, DatabaseHookData } from ${JSON.stringify(typesPath)};
import type { BetterAuthModuleOptions, BetterAuthModuleAsyncOptions, BetterAuthFactoryResult, NoAppOptions, AuthorizationPolicy, Requirement } from ${JSON.stringify(contractsPath)};
${assertions}
type Unregistered = Assert<Equal<IsRegistered, false>>;
type DefaultShape = Assert<Equal<AuthSession, { session: Session; user: User }>>;
type NamedFallback = Assert<Equal<AuthOf<"missing">, AuthLike>>;
type DefaultPermissions = Assert<Equal<AdminPermissions, Record<string, readonly string[]>>>;
type DefaultOrgPermissions = Assert<Equal<OrgPermissions, Record<string, readonly string[]>>>;
// @ts-expect-error Optional principal kinds are absent until their entry augments the registry.
const optionalKind: PrincipalKind = "api-key";
const custom = betterAuth({ plugins: [customSession(async ({ user }) => ({ principal: { uid: user.id }, roles: ["editor"] }))] });
const structural: AuthLike = custom;
type CustomShape = Assert<Equal<SessionOf<typeof custom>, { principal: { uid: string }; roles: string[] }>>;
type NoUser = Assert<Equal<UserOf<typeof custom>, never>>;
const valid: BetterAuthModuleOptions<typeof custom> = { auth: custom, session: { userId: value => value.principal.uid } };
const disabled: BetterAuthModuleOptions<typeof custom> = { auth: custom, session: false };
// @ts-expect-error A custom session without user.id requires the mapper.
const missing: BetterAuthModuleOptions<typeof custom> = { auth: custom };
// @ts-expect-error Empty session options cannot bypass the required mapper.
const empty: BetterAuthModuleOptions<typeof custom> = { auth: custom, session: {} };
const asyncOptions: BetterAuthModuleAsyncOptions<typeof custom> = { name: "tenant", globalGuard: false, useFactory: async () => ({ auth: custom, session: { userId: value => value.principal.uid } }) };
const invalidFactory: BetterAuthFactoryResult<typeof custom> = {
  auth: custom, session: false,
  // @ts-expect-error Registration aliases belong outside the factory.
  name: "tenant",
  // @ts-expect-error App platforms are static.
  platforms: [],
  // @ts-expect-error Sources define providers and are static.
  principals: [],
  // @ts-expect-error Enhancer registration is static.
  globalGuard: false,
};
const named: BetterAuthModuleOptions<typeof custom> & NoAppOptions = {
  auth: custom, session: false, name: "tenant",
  // @ts-expect-error Named instances cannot register app platforms.
  platforms: [],
};
const policy: AuthorizationPolicy<{ projectId: string }> = { id: "project", evaluate: params => params.projectId ? { effect: "allow" } : { effect: "deny", reason: "MISSING_PROJECT" } };
const requirement: Requirement<{ projectId: string }> = { policy, params: { projectId: "p1" } };
// @ts-expect-error Requirement params retain their concrete shape.
const wrongRequirement: Requirement<{ projectId: string }> = { policy, params: { projectId: 123 } };
declare const raw: UnvalidatedBody<{ email: string }>;
// @ts-expect-error Endpoint input has not been validated in hooks.
const email: string = raw.email;
const update: DatabaseHookData<"user.update"> = {};
// @ts-expect-error Delete hooks cannot replace the deleted row.
const deleteResult: DatabaseHookResult<"user.delete", "before"> = { data: { id: "u1" } };
`);
});

it("preserves augmented default and named instances, plugin permissions, and raw hook types", async () => {
  await compile(`
import { betterAuth } from "better-auth";
import { admin, customSession, organization } from "better-auth/plugins";
import type { AuthLike, AuthOf, AuthSession, AuthUser, SessionOf, IsRegistered, AdminPermissions, OrgPermissions, AuthHookContext, EndpointPath, DatabaseHookData } from ${JSON.stringify(typesPath)};
import type { DefaultInstanceCheck } from ${JSON.stringify(contractsPath)};
${assertions}
const primary = betterAuth({ emailAndPassword: { enabled: true }, user: { additionalFields: { department: { type: "string", required: true } } }, plugins: [admin(), organization()] });
const named = betterAuth({ plugins: [customSession(async ({ user }) => ({ uid: user.id }))] });
declare module ${JSON.stringify(typesPath)} {
  interface Register { auth: typeof primary; instances: { tenant: typeof named } }
}
type Registered = Assert<Equal<IsRegistered, true>>;
type DefaultInstance = Assert<Equal<AuthOf, typeof primary>>;
type NamedInstance = Assert<Equal<AuthOf<"tenant">, typeof named>>;
type DefaultSession = Assert<Equal<AuthSession, SessionOf<typeof primary>>>;
type NamedSession = Assert<Equal<AuthSession<"tenant">, { uid: string }>>;
type NamedUser = Assert<Equal<AuthUser<"tenant">, never>>;
type AdditionalUserField = Assert<Equal<AuthUser["department"], string>>;
type MissingAdminPlugin = Assert<Equal<AdminPermissions<"tenant">, never>>;
type MissingOrgPlugin = Assert<Equal<OrgPermissions<"tenant">, never>>;
const adminPermission: AdminPermissions = { user: ["ban"] };
const orgPermission: OrgPermissions = { member: ["create"] };
// @ts-expect-error Plugin permission actions remain literal unions.
const invalidAdmin: AdminPermissions = { user: ["explode"] };
// @ts-expect-error Unknown resources are rejected.
const invalidOrg: OrgPermissions = { imaginary: ["create"] };
const path: EndpointPath = "/sign-up/email";
type LiteralPaths = Assert<Equal<EndpointPath<{ api: { endpoint: { path: "/precise" }; helper: () => void } }>, "/precise">>;
declare const hook: AuthHookContext<"/sign-up/email">;
// @ts-expect-error Even known endpoint body properties remain unvalidated.
const email: string = hook.body.email;
const partialUpdate: DatabaseHookData<"user.update"> = { department: "engineering" };
const check: DefaultInstanceCheck<typeof primary> = {};
// @ts-expect-error The default instance must match the registry.
const wrongDefault: DefaultInstanceCheck<typeof named> = {};
`);
});
