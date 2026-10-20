import type { ExecutionContext } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, customSession } from "better-auth/plugins";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminPermissionPolicy, permission } from "./admin.js";
import type { AuthHandle, AuthorizationContext } from "./auth-contracts.js";
import { BetterAuthModule } from "./auth-module.js";
import { getBetterAuthHandleToken } from "./auth-tokens.js";
import type { AuthPrincipal } from "./auth-types.js";
import { nestjs } from "./plugin.js";
import { sessionPrincipal } from "./session-principal.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close();
  }
});
async function fixture(
  options: Parameters<typeof admin>[0] = {},
  transformRole?: unknown,
) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: "http://localhost:3000",
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: true } },
    database: memoryAdapter(database),
    plugins: [
      admin(options),
      ...(transformRole === undefined
        ? []
        : [
            customSession(async ({ user, session }) => ({
              user: { ...user, role: transformRole },
              session,
            })),
          ]),
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
      name: "Owner",
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
  const userId = signup.response.user.id;
  const principal: AuthPrincipal = {
    kind: "session",
    source: "better-auth:session",
    userId,
    session: { user: signup.response.user, session: { id: "unused" } } as never,
  };
  function context(p = principal): AuthorizationContext {
    const memo = new Map<unknown, Promise<unknown>>();
    return {
      principal: p,
      auth: handle,
      instance: "default",
      transport: "test",
      headers,
      cookies: null,
      handler: { class: class Handler {}, method: "test" },
      execution: {} as ExecutionContext,
      param: () => undefined,
      provide: () => {},
      memo<T>(key: unknown, compute: () => Promise<T>) {
        if (!memo.has(key)) {
          memo.set(key, compute());
        }
        return memo.get(key) as Promise<T>;
      },
    };
  }
  return { auth, handle, userId, headers, context, database };
}
const permissions = { user: ["list"] };
describe("SDK admin permission parity", () => {
  it.each([null, "", "user", "admin", "user,admin"])(
    "uses stored role %s and matches listUsers",
    async (role) => {
      const f = await fixture();
      f.database.user[0]!.role = role;
      const sdk = await f.auth.api.userHasPermission({
        body: { userId: f.userId, permissions: { user: ["list"] } },
      });
      const listed = await f.auth.api
        .listUsers({ headers: f.headers, query: {} })
        .then(
          () => true,
          () => false,
        );
      const spy = vi.spyOn(f.auth.api, "userHasPermission");
      const decision = await adminPermissionPolicy.evaluate(
        { permissions },
        f.context(),
      );
      expect(decision.effect === "allow").toBe(sdk.success);
      expect(decision.effect === "allow").toBe(listed);
      expect(spy).toHaveBeenCalledWith({
        body: { userId: f.userId, permissions },
      });
    },
  );
  it("delegates NULL roles in adminUserIds to the SDK", async () => {
    const ids: string[] = [];
    const f = await fixture({ adminUserIds: ids });
    ids.push(f.userId);
    f.database.user[0]!.role = null;
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context()),
    ).toEqual({ effect: "allow" });
    await expect(
      f.auth.api.listUsers({ headers: f.headers, query: {} }),
    ).resolves.toBeDefined();
  });
  it.each(["admin", ["admin"], "Friendly administrator"])(
    "ignores customSession role %s",
    async (transformed) => {
      const f = await fixture({}, transformed);
      f.database.user[0]!.role = "user";
      expect(
        await adminPermissionPolicy.evaluate({ permissions }, f.context()),
      ).toEqual({ effect: "deny", reason: "MISSING_PERMISSION" });
      await expect(
        f.auth.api.listUsers({ headers: f.headers, query: {} }),
      ).rejects.toMatchObject({ statusCode: 403 });
      f.database.user[0]!.role = "admin";
      expect(
        await adminPermissionPolicy.evaluate({ permissions }, f.context()),
      ).toEqual({ effect: "allow" });
    },
  );
  it("requires authoritative identity and rejects a revoked warm cookie session", async () => {
    const f = await fixture();
    f.database.user[0]!.role = "admin";
    const warm = await f.auth.api.getSession({
      headers: f.headers,
      returnHeaders: true,
    });
    const cookies = new Map(
      f.headers
        .get("cookie")!
        .split("; ")
        .map((line) => [line.split("=")[0], line]),
    );
    for (const line of warm.headers.getSetCookie()) {
      const cookie = line.split(";")[0]!;
      cookies.set(cookie.split("=")[0]!, cookie);
    }
    f.headers.set("cookie", [...cookies.values()].join("; "));
    f.database.session.splice(0);
    expect(await f.auth.api.getSession({ headers: f.headers })).not.toBeNull();
    const request = {
      auth: f.handle,
      headers: f.headers,
      cookies: null,
      transport: "test",
      freshness: "authoritative" as const,
      memo: <T>(_key: unknown, compute: () => Promise<T>) => compute(),
    };
    expect(await sessionPrincipal().resolve(request)).toEqual({
      outcome: "absent",
    });
    expect(adminPermissionPolicy.requires?.freshIdentity).toBe(true);
    await expect(
      f.auth.api.listUsers({ headers: f.headers, query: {} }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
  it("maps deletion between identity and policy to USER_NOT_FOUND", async () => {
    const f = await fixture();
    f.database.user.splice(0);
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context()),
    ).toMatchObject({ effect: "deny", status: 401, reason: "USER_NOT_FOUND" });
  });
  it("requires both delegated owner's role and credential grant and denies bans/deletion", async () => {
    const f = await fixture();
    f.database.user[0]!.role = "admin";
    const p: AuthPrincipal = {
      kind: "api-key",
      source: "test",
      userId: f.userId,
      referenceId: f.userId,
      organizationId: null,
      keyId: "id",
      configId: null,
      permissions: {},
      delegation: { description: "test grant", allows: () => false },
    };
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context(p)),
    ).toMatchObject({ reason: "INSUFFICIENT_SCOPE" });
    const allowed = {
      ...p,
      delegation: { description: "wide grant", allows: () => true },
    };
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context(allowed)),
    ).toEqual({ effect: "allow" });
    f.database.user[0]!.banned = true;
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context(allowed)),
    ).toMatchObject({ status: 401, reason: "USER_BANNED" });
    f.database.user[0]!.banExpires = new Date(Date.now() - 1000);
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context(allowed)),
    ).toEqual({ effect: "allow" });
    f.database.user[0]!.role = null;
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context(allowed)),
    ).toMatchObject({ reason: "MISSING_PERMISSION" });
    f.database.user.splice(0);
    expect(
      await adminPermissionPolicy.evaluate({ permissions }, f.context(allowed)),
    ).toMatchObject({ status: 401, reason: "USER_NOT_FOUND" });
    expect(
      await adminPermissionPolicy.evaluate(
        { permissions },
        f.context({ ...allowed, userId: null }),
      ),
    ).toMatchObject({ reason: "USER_REQUIRED" });
    expect(
      permission(permissions, { principals: ["session", "api-key"] })
        .principals,
    ).toEqual(["session", "api-key"]);
  });
});

it("validates admin plugin prerequisites and empty permissions at boot", async () => {
  const { Controller, Get } = await import("@nestjs/common");
  const { RequirePermission } = await import("./admin.js");
  const { createTestAuth } = await import("./test-fixtures.js");
  for (const hasPlugin of [false, true]) {
    @Controller()
    class Guarded {
      @Get()
      @RequirePermission(hasPlugin ? {} : permissions)
      run() {}
    }
    const auth = createTestAuth({ plugins: hasPlugin ? [admin()] : [] });
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
