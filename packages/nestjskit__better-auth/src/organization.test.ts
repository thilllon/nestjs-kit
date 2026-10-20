import type { ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization, customSession } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthHandle, AuthorizationContext } from "./auth-contracts.js";
import { BetterAuthModule } from "./auth-module.js";
import { getBetterAuthHandleToken } from "./auth-tokens.js";
import type { SessionPrincipal } from "./auth-types.js";
import { nestjs } from "./plugin.js";
import {
  activeOrganization,
  ACTIVE_MEMBER_ROLE,
  ACTIVE_ORGANIZATION_ID,
  fromHeader,
  fromParam,
  organizationRef,
  orgMemberPolicy,
  orgPermissionPolicy,
} from "./organization.js";
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close();
  }
});
async function fixture(custom = false) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    organization: [],
    member: [],
    invitation: [],
  };
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: "http://localhost:3000",
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    database: memoryAdapter(database),
    plugins: [
      organization(),
      ...(custom ? [customSession(async ({ user }) => ({ user }))] : []),
      nestjs(),
    ],
  });
  const module = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        auth,
        http: { mount: false },
        logSummary: false,
      }),
    ],
  }).compile();
  await module.init();
  closes.push(() => module.close());
  const handle = module.get<AuthHandle>(getBetterAuthHandleToken());
  const signup = await auth.api.signUpEmail({
    body: {
      name: "Member",
      email: `${crypto.randomUUID()}@example.com`,
      password: "password-secure-123",
    },
    returnHeaders: true,
  });
  const headers = new Headers({
    cookie: signup.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  });
  const a = await auth.api.createOrganization({
    headers,
    body: { name: "A", slug: `a-${crypto.randomUUID()}` },
  });
  const b = await auth.api.createOrganization({
    headers,
    body: { name: "B", slug: `b-${crypto.randomUUID()}` },
  });
  if (!a || !b) {
    throw new Error("expected organizations");
  }
  await auth.api.setActiveOrganization({
    headers,
    body: { organizationId: a.id },
  });
  const session = await auth.api.getSession({ headers });
  const memo = new Map<unknown, Promise<unknown>>();
  function context(input: unknown = a!.id) {
    const values = new Map<symbol, unknown>();
    const ctx: AuthorizationContext<SessionPrincipal> = {
      principal: {
        kind: "session",
        source: "better-auth:session",
        userId: signup.response.user.id,
        session: session as never,
      },
      auth: handle,
      instance: "default",
      transport: "test",
      headers,
      cookies: null,
      handler: { class: class Handler {}, method: "test" },
      execution: {} as ExecutionContext,
      param: () => input,
      provide: (key, value) => {
        values.set(key, value);
      },
      memo<T>(key: unknown, compute: () => Promise<T>) {
        if (!memo.has(key)) {
          memo.set(key, compute());
        }
        return memo.get(key) as Promise<T>;
      },
    };
    return { ctx, values };
  }
  return { auth, handle, a, b, headers, database, context };
}
describe("SDK organization policies", () => {
  it.each([undefined, null, "", " ", 0, {}, [], { $ne: null }])(
    "denies malformed ref %j before SDK I/O",
    async (input) => {
      const f = await fixture();
      const call = vi.spyOn(f.auth.api, "hasPermission");
      const member = vi.spyOn(f.auth.api, "getActiveMemberRole");
      const ctx = f.context().ctx;
      const ref = organizationRef(() => input, {
        missingReason: "INPUT_ORGANIZATION_REQUIRED",
      });
      expect(
        await orgPermissionPolicy.evaluate(
          { permissions: { member: ["create"] }, organization: ref },
          ctx,
        ),
      ).toMatchObject({
        effect: "deny",
        reason: "INPUT_ORGANIZATION_REQUIRED",
      });
      expect(
        await orgMemberPolicy.evaluate({ organization: ref }, ctx),
      ).toMatchObject({
        effect: "deny",
        reason: "INPUT_ORGANIZATION_REQUIRED",
      });
      expect(call).not.toHaveBeenCalled();
      expect(member).not.toHaveBeenCalled();
    },
  );
  it("checks explicit organization IDs, deduplicates inputs and publishes separate A/B invocation values", async () => {
    const f = await fixture();
    f.database.member.find((row) => row.organizationId === f.b.id)!.role =
      "member";
    const read = vi.spyOn(f.auth.api, "getActiveMemberRole");
    const a = f.context(f.a.id);
    const b = f.context(f.b.id);
    const ref = fromParam("orgId");
    expect(
      await orgMemberPolicy.evaluate({ organization: ref }, a.ctx),
    ).toEqual({ effect: "allow" });
    expect(
      await orgMemberPolicy.evaluate({ organization: ref }, b.ctx),
    ).toEqual({ effect: "allow" });
    expect(
      await orgMemberPolicy.evaluate({ organization: ref }, a.ctx),
    ).toEqual({ effect: "allow" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(
      read.mock.calls.map(([input]) => input?.query?.organizationId),
    ).toEqual([f.a.id, f.b.id]);
    expect(a.values.get(ACTIVE_ORGANIZATION_ID)).toBe(f.a.id);
    expect(b.values.get(ACTIVE_ORGANIZATION_ID)).toBe(f.b.id);
    expect(a.values.get(ACTIVE_MEMBER_ROLE)).toBe("owner");
    expect(b.values.get(ACTIVE_MEMBER_ROLE)).toBe("member");
    const permission = vi.spyOn(f.auth.api, "hasPermission");
    const params = { permissions: { member: ["create"] }, organization: ref };
    expect(await orgPermissionPolicy.evaluate(params, a.ctx)).toEqual({
      effect: "allow",
    });
    expect(await orgPermissionPolicy.evaluate(params, b.ctx)).toMatchObject({
      reason: "MISSING_PERMISSION",
    });
    await orgPermissionPolicy.evaluate(params, a.ctx);
    expect(permission).toHaveBeenCalledTimes(2);
  });
  it("revalidates membership despite a retained active organization ID", async () => {
    const f = await fixture();
    f.database.member.splice(0);
    const { ctx, values } = f.context();
    expect(
      await orgMemberPolicy.evaluate(
        { organization: activeOrganization() },
        ctx,
      ),
    ).toMatchObject({ reason: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION" });
    expect(
      await orgPermissionPolicy.evaluate(
        {
          permissions: { member: ["create"] },
          organization: activeOrganization(),
        },
        ctx,
      ),
    ).toMatchObject({ reason: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION" });
    expect(values.size).toBe(0);
  });
  it("resolves a customSession's missing active ID through the SDK once", async () => {
    const f = await fixture(true);
    const spy = vi.spyOn(f.auth.api, "getActiveMember");
    const { ctx, values } = f.context();
    expect(
      await orgMemberPolicy.evaluate(
        { organization: activeOrganization() },
        ctx,
      ),
    ).toEqual({ effect: "allow" });
    expect(
      await orgPermissionPolicy.evaluate(
        {
          organization: activeOrganization(),
          permissions: { member: ["create"] },
        },
        ctx,
      ),
    ).toEqual({ effect: "allow" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(values.get(ACTIVE_ORGANIZATION_ID)).toBe(f.a.id);
  });
  it("treats explicit null active ID as absent without SDK fallback", async () => {
    const f = await fixture(true);
    const { ctx } = f.context();
    const principal = {
      ...ctx.principal,
      session: { session: { activeOrganizationId: null } } as never,
    };
    const spy = vi.spyOn(f.auth.api, "getActiveMember");
    expect(
      await orgMemberPolicy.evaluate(
        { organization: activeOrganization() },
        { ...ctx, principal },
      ),
    ).toMatchObject({ reason: "NO_ACTIVE_ORGANIZATION" });
    expect(spy).not.toHaveBeenCalled();
  });
  it("maps missing active membership for a custom session", async () => {
    const f = await fixture(true);
    await f.auth.api.setActiveOrganization({
      headers: f.headers,
      body: { organizationId: null },
    });
    expect(
      await orgMemberPolicy.evaluate(
        { organization: activeOrganization() },
        f.context().ctx,
      ),
    ).toMatchObject({ reason: "NO_ACTIVE_ORGANIZATION" });
  });
  it("does not publish absent or empty member roles", async () => {
    const f = await fixture();
    f.database.member.find((row) => row.organizationId === f.a.id)!.role = "";
    const { ctx, values } = f.context();
    expect(
      await orgMemberPolicy.evaluate({ organization: fromParam("orgId") }, ctx),
    ).toMatchObject({ effect: "deny" });
    expect(values.size).toBe(0);
  });
  it("supports header IDs without consulting the active ID", async () => {
    const f = await fixture();
    f.headers.set("x-organization-id", f.b.id);
    const { ctx, values } = f.context();
    expect(
      await orgMemberPolicy.evaluate(
        { organization: fromHeader("x-organization-id") },
        ctx,
      ),
    ).toEqual({ effect: "allow" });
    expect(values.get(ACTIVE_ORGANIZATION_ID)).toBe(f.b.id);
  });
});

it("validates organization plugin prerequisites and empty permissions at boot", async () => {
  const { Controller, Get } = await import("@nestjs/common");
  const { RequireOrgPermission } = await import("./organization.js");
  const { createTestAuth } = await import("./test-fixtures.js");
  for (const hasPlugin of [false, true]) {
    @Controller()
    class Guarded {
      @Get()
      @RequireOrgPermission(hasPlugin ? {} : { member: ["create"] })
      run() {}
    }
    const auth = createTestAuth({ plugins: hasPlugin ? [organization()] : [] });
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          http: { mount: false },
          logSummary: false,
        }),
      ],
      controllers: [Guarded],
    }).compile();
    try {
      await expect(module.init()).rejects.toThrow(
        hasPlugin ? "EMPTY_PERMISSIONS" : "PLUGIN_PREREQUISITE",
      );
    } finally {
      await module.close().catch(() => undefined);
    }
  }
});
it("announces active organization/input mismatches and missing parameter inputs", async () => {
  const f = await fixture();
  const { orgMember, orgPermission } = await import("./organization.js");
  const ctx = {
    instance: "default",
    auth: f.handle,
    context: await f.handle.context(),
    production: false,
    hasHttpAdapter: false,
    originCheck: { mode: "cookie" as const, missingOrigin: "reject" as const },
    transports: [],
    sources: [],
    policies: [],
    handlers: [
      {
        inputs: ["orgId"],
        transports: [],
        plan: { site: "Controller.active", requirements: [orgMember()] },
      },
      {
        inputs: ["orgSlug"],
        transports: [],
        plan: {
          site: "Controller.slug",
          requirements: [orgPermission({ member: ["create"] })],
        },
      },
      {
        inputs: [],
        transports: [],
        plan: {
          site: "Reference.resolve",
          requirements: [orgMember({ organization: fromParam("orgId") })],
        },
      },
    ],
  } as unknown as import("./auth-contracts.js").BootAdviceContext;
  const memberAdvice = await orgMemberPolicy.advise!(ctx);
  expect(memberAdvice).toHaveLength(2);
  expect(memberAdvice.map((a) => a.code)).toEqual([
    "W_ORG_PARAM_IGNORED",
    "W_ORG_PARAM_MISSING",
  ]);
  const permissionAdvice = await orgPermissionPolicy.advise!(ctx);
  expect(permissionAdvice).toHaveLength(1);
  expect(permissionAdvice[0]!.hint).toContain("listOrganizations");
});

it("lets unrelated SDK errors reach central reclassification instead of denying permission", async () => {
  const f = await fixture();
  const { APIError } = await import("better-auth/api");
  const noSession = new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED" });
  vi.spyOn(f.auth.api, "hasPermission").mockRejectedValue(noSession);
  await expect(
    orgPermissionPolicy.evaluate(
      { organization: fromParam("orgId"), permissions: { member: ["create"] } },
      f.context().ctx,
    ),
  ).rejects.toBe(noSession);
  const infrastructure = new Error("database unavailable");
  vi.spyOn(f.auth.api, "getActiveMemberRole").mockRejectedValue(infrastructure);
  await expect(
    orgMemberPolicy.evaluate(
      { organization: fromParam("orgId") },
      f.context().ctx,
    ),
  ).rejects.toBe(infrastructure);
});
