import { apiKey } from "@better-auth/api-key";
import { Controller, Get } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { RequirePermission } from "./admin.js";
import { apiKeyPrincipal, RequireApiKeyPermission } from "./api-key.js";
import { RequireAuth } from "./auth-decorators.js";
import { expressPlatform } from "./express.js";
import {
  ActiveMemberRole,
  ActiveOrganizationId,
  fromParam,
  RequireOrgMember,
  RequireOrgPermission,
} from "./organization.js";
import { nestjs } from "./plugin.js";
import { startHttpFixture } from "./test-fixtures.js";

@Controller()
class AuthorizedController {
  @Get("ordinary")
  @RequireAuth()
  ordinary() {
    return { ok: true };
  }

  @Get("key/read")
  @RequireApiKeyPermission({ project: ["read"] })
  read() {
    return { ok: true };
  }

  @Get("key/write")
  @RequireApiKeyPermission({ project: ["write"] })
  write() {
    return { ok: true };
  }

  @Get("admin")
  @RequirePermission({ user: ["list"] }, { principals: ["session", "api-key"] })
  admin() {
    return { ok: true };
  }

  @Get("session-admin")
  @RequirePermission({ user: ["list"] })
  sessionAdmin() {
    return { ok: true };
  }

  @Get("organizations/:orgId")
  @RequireOrgMember({ organization: fromParam("orgId") })
  member(
    @ActiveOrganizationId() organizationId: string,
    @ActiveMemberRole() role: string,
  ) {
    return { organizationId, role };
  }

  @Get("organizations/:orgId/manage")
  @RequireOrgPermission(
    { member: ["create"] },
    { organization: fromParam("orgId") },
  )
  manage(@ActiveOrganizationId() organizationId: string) {
    return { organizationId };
  }
}
async function fixture(syntheticSessions = false) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    apikey: [],
    organization: [],
    member: [],
    invitation: [],
  };
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: "http://localhost:3000",
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: true } },
    database: memoryAdapter(database),
    plugins: [
      admin(),
      organization(),
      apiKey({ enableSessionForAPIKeys: syntheticSessions }),
      nestjs(),
    ],
  });
  const moduleOptions = { principals: [apiKeyPrincipal()], logSummary: false };
  const http = await startHttpFixture({
    auth,
    adapter: new ExpressAdapter(),
    platform: expressPlatform(),
    controllers: [AuthorizedController],
    moduleOptions,
  });
  try {
    const signup = await auth.api.signUpEmail({
      body: {
        name: "Owner",
        email: `${crypto.randomUUID()}@example.com`,
        password: "password-secure-123",
      },
      returnHeaders: true,
    });
    const headers = new Headers({
      cookie: signup.headers
        .getSetCookie()
        .map((line) => line.split(";")[0])
        .join("; "),
    });
    database.user[0]!.role = "admin";
    return {
      auth,
      http,
      database,
      userId: signup.response.user.id,
      headers,
      get: (path: string, headers: HeadersInit) =>
        fetch(`${http.url}${path}`, { headers }),
    };
  } catch (error) {
    await http.close();
    throw error;
  }
}
describe("native Express authorization", () => {
  it("admits API keys explicitly and enforces both owner permissions and narrow grants", async () => {
    const f = await fixture();
    try {
      const key = await f.auth.api.createApiKey({
        body: { userId: f.userId, permissions: { project: ["read"] } },
      });
      const headers = { "x-api-key": key.key };
      expect((await f.get("/ordinary", headers)).status).toBe(401);
      expect((await f.get("/key/read", headers)).status).toBe(200);
      const write = await f.get("/key/write", headers);
      expect(write.status).toBe(403);
      expect(await write.json()).toMatchObject({
        reason: "MISSING_PERMISSION",
      });
      const narrow = await f.get("/admin", headers);
      expect(narrow.status).toBe(403);
      expect(await narrow.json()).toMatchObject({
        reason: "INSUFFICIENT_SCOPE",
      });
      const wide = await f.auth.api.createApiKey({
        body: { userId: f.userId, permissions: { user: ["list"] } },
      });
      expect((await f.get("/admin", { "x-api-key": wide.key })).status).toBe(
        200,
      );
      f.database.user[0]!.role = "user";
      const demoted = await f.get("/admin", { "x-api-key": wide.key });
      expect(demoted.status).toBe(403);
      expect(await demoted.json()).toMatchObject({
        reason: "MISSING_PERMISSION",
      });
      f.database.user[0]!.role = "admin";
      f.database.user[0]!.banned = true;
      const banned = await f.get("/admin", { "x-api-key": wide.key });
      expect(banned.status).toBe(401);
      expect(await banned.json()).toMatchObject({ reason: "USER_BANNED" });
    } finally {
      await f.http.close();
    }
  });
  it("rejects SDK synthetic API-key sessions on authoritative admin routes", async () => {
    const f = await fixture(true);
    try {
      const key = await f.auth.api.createApiKey({
        body: { userId: f.userId, permissions: { user: ["list"] } },
      });
      expect((await f.get("/ordinary", { "x-api-key": key.key })).status).toBe(
        200,
      );
      expect(
        (await f.get("/session-admin", { "x-api-key": key.key })).status,
      ).toBe(401);
      await expect(
        f.auth.api.listUsers({
          headers: new Headers({ "x-api-key": key.key }),
          query: {},
        }),
      ).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      await f.http.close();
    }
  });
  it("rejects a revoked warm cookie on admin routes just as the SDK does", async () => {
    const f = await fixture();
    try {
      const first = await f.get("/session-admin", f.headers);
      expect(first.status).toBe(200);
      const cookies = new Map(
        f.headers
          .get("cookie")!
          .split("; ")
          .map((line) => [line.split("=")[0], line]),
      );
      for (const line of first.headers.getSetCookie()) {
        const cookie = line.split(";")[0]!;
        cookies.set(cookie.split("=")[0]!, cookie);
      }
      f.headers.set("cookie", [...cookies.values()].join("; "));
      f.database.session.splice(0);
      expect((await f.get("/session-admin", f.headers)).status).toBe(401);
      await expect(
        f.auth.api.listUsers({ headers: f.headers, query: {} }),
      ).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      await f.http.close();
    }
  });
  it("checks each requested organization and exposes only successful invocation values", async () => {
    const f = await fixture();
    try {
      const a = await f.auth.api.createOrganization({
        headers: f.headers,
        body: { name: "A", slug: `a-${crypto.randomUUID()}` },
      });
      const b = await f.auth.api.createOrganization({
        headers: f.headers,
        body: { name: "B", slug: `b-${crypto.randomUUID()}` },
      });
      if (!a || !b) {
        throw new Error("expected organizations");
      }
      f.database.member.find((member) => member.organizationId === b.id)!.role =
        "member";
      const [ra, rb] = await Promise.all([
        f.get(`/organizations/${a.id}`, f.headers),
        f.get(`/organizations/${b.id}`, f.headers),
      ]);
      expect(await ra.json()).toEqual({ organizationId: a.id, role: "owner" });
      expect(await rb.json()).toEqual({ organizationId: b.id, role: "member" });
      expect(
        (await f.get(`/organizations/${a.id}/manage`, f.headers)).status,
      ).toBe(200);
      expect(
        (await f.get(`/organizations/${b.id}/manage`, f.headers)).status,
      ).toBe(403);
      f.database.member.splice(0);
      const removed = await f.get(`/organizations/${a.id}`, f.headers);
      expect(removed.status).toBe(403);
      expect(await removed.json()).toMatchObject({
        reason: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
      });
    } finally {
      await f.http.close();
    }
  });
});
