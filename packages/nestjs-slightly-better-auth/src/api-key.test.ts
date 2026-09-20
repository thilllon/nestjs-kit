import { apiKey } from "@better-auth/api-key";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";
import type { AuthHandle, PrincipalRequest } from "./auth-contracts.js";
import { BetterAuthModule } from "./auth-module.js";
import { getBetterAuthHandleToken } from "./auth-tokens.js";
import { nestjs } from "./plugin.js";
import { apiKeyPrincipal } from "./api-key.js";

async function keyFixture(
  options: Parameters<typeof apiKey>[0] = {},
  configId?: string,
) {
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: "http://localhost:3000",
    emailAndPassword: { enabled: true },
    logger: { disabled: true },
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      apikey: [],
    }),
    plugins: [apiKey(options), nestjs()],
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
  const handle = module.get<AuthHandle>(getBetterAuthHandleToken());
  const signup = await auth.api.signUpEmail({
    body: {
      name: "Owner",
      email: `${crypto.randomUUID()}@example.com`,
      password: "password-secure-123",
    },
  });
  const createdKey = await auth.api.createApiKey({
    body: {
      userId: signup.user.id,
      configId,
      permissions: { project: ["read"] },
    },
  });
  return { auth, handle, module, createdKey, userId: signup.user.id };
}
function keyRequest(
  auth: AuthHandle,
  key: string,
  headers = new Headers(),
): PrincipalRequest {
  headers.set("x-api-key", key);
  const memo = new Map<unknown, Promise<unknown>>();
  return {
    auth,
    headers,
    cookies: null,
    freshness: "default",
    transport: "test",
    memo<T>(key: unknown, compute: () => Promise<T>) {
      if (!memo.has(key)) {
        memo.set(key, compute());
      }
      return memo.get(key) as Promise<T>;
    },
  };
}

describe("real SDK API-key principal", () => {
  it("preserves the verified narrow grant without exposing the credential", async () => {
    const fixture = await keyFixture();
    try {
      const result = await apiKeyPrincipal().resolve(
        keyRequest(fixture.handle, fixture.createdKey.key),
      );
      expect(result.outcome).toBe("authenticated");
      if (result.outcome !== "authenticated") {
        throw new Error("expected a verified API-key principal");
      }
      expect(result.principal.delegation.allows({ project: ["read"] })).toBe(
        true,
      );
      expect(result.principal.delegation.allows({ user: ["ban"] })).toBe(false);
      expect(JSON.stringify(result.principal)).not.toContain(
        fixture.createdKey.key,
      );
    } finally {
      await fixture.module.close();
    }
  });
});

it("memoizes quota consumption and forwards only dynamic host context", async () => {
  const f = await keyFixture({ enableSessionForAPIKeys: true });
  try {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(f.auth.api, "verifyApiKey");
    const headers = new Headers({
      cookie: "unrelated=secret",
      authorization: "Bearer ignored",
      host: "localhost:3000",
      "x-forwarded-host": "public.example.com",
      "x-forwarded-proto": "https",
    });
    const request = keyRequest(f.handle, f.createdKey.key, headers);
    const source = apiKeyPrincipal();
    const results = await Promise.all([
      source.resolve(request),
      source.resolve(request),
      source.resolve({ ...request, freshness: "authoritative" }),
    ]);
    expect(results.every((r) => r.outcome === "authenticated")).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect([...new Headers(spy.mock.calls[0]![0]!.headers).entries()]).toEqual([
      ["host", "localhost:3000"],
      ["x-forwarded-host", "public.example.com"],
      ["x-forwarded-proto", "https"],
    ]);
    expect(source.acceptance).toBe("explicit");
    expect(source.delegates).toBe(true);
    expect(source.effects).toEqual({ consumesQuota: true, writes: true });
  } finally {
    await f.module.close();
  }
});
it("rejects synthetic API-key sessions authoritatively", async () => {
  const f = await keyFixture({ enableSessionForAPIKeys: true });
  try {
    const { sessionPrincipal } = await import("./session-principal.js");
    const source = sessionPrincipal();
    expect(
      await source.resolve(keyRequest(f.handle, f.createdKey.key)),
    ).toMatchObject({ outcome: "authenticated" });
    expect(
      await source.resolve({
        ...keyRequest(f.handle, f.createdKey.key),
        freshness: "authoritative",
      }),
    ).toEqual({ outcome: "absent" });
  } finally {
    await f.module.close();
  }
});
it("keeps configuration identity and resolves organization-owned keys without a user", async () => {
  const f = await keyFixture();
  try {
    const seen: unknown[] = [];
    const result = await apiKeyPrincipal({
      references: (key) => {
        seen.push(key.configId);
        return "organization";
      },
    }).resolve(keyRequest(f.handle, f.createdKey.key));
    expect(result).toMatchObject({
      outcome: "authenticated",
      principal: {
        userId: null,
        organizationId: f.userId,
        referenceId: f.userId,
        configId: f.createdKey.configId,
      },
    });
    expect(seen).toEqual([f.createdKey.configId]);
  } finally {
    await f.module.close();
  }
});
it("maps real disabled, expired, usage-exceeded and rate-limited SDK keys", async () => {
  const f = await keyFixture();
  try {
    const sdk = await f.auth.$context;
    const source = apiKeyPrincipal();
    const check = () => source.resolve(keyRequest(f.handle, f.createdKey.key));
    await sdk.adapter.update({
      model: "apikey",
      where: [{ field: "id", value: f.createdKey.id }],
      update: { enabled: false },
    });
    expect(await check()).toMatchObject({
      outcome: "rejected",
      failure: { status: 401, reason: "KEY_DISABLED" },
    });
    await sdk.adapter.update({
      model: "apikey",
      where: [{ field: "id", value: f.createdKey.id }],
      update: { enabled: true, expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await check()).toMatchObject({
      outcome: "rejected",
      failure: { status: 401, reason: "KEY_EXPIRED" },
    });
    const exhausted = await f.auth.api.createApiKey({
      body: { userId: f.userId, remaining: 0 },
    });
    expect(
      await source.resolve(keyRequest(f.handle, exhausted.key)),
    ).toMatchObject({
      outcome: "rejected",
      failure: { status: 429, reason: "USAGE_EXCEEDED" },
    });
    const limited = await f.auth.api.createApiKey({
      body: {
        userId: f.userId,
        rateLimitEnabled: true,
        rateLimitMax: 1,
        rateLimitTimeWindow: 60_000,
      },
    });
    expect(
      await source.resolve(keyRequest(f.handle, limited.key)),
    ).toMatchObject({ outcome: "authenticated" });
    const result = await source.resolve(keyRequest(f.handle, limited.key));
    expect(result).toMatchObject({
      outcome: "rejected",
      failure: { status: 429, reason: "RATE_LIMITED" },
    });
    if (result.outcome !== "rejected") {
      throw new Error("expected rate limit");
    }
    expect(Number(result.failure.headers?.get("retry-after"))).toBeGreaterThan(
      0,
    );
  } finally {
    await f.module.close();
  }
});
it("shares one read/no-op-write probe across concurrent invalid keys and changes no rows", async () => {
  const f = await keyFixture();
  try {
    const { vi } = await import("vitest");
    const context = await f.handle.context();
    const read = vi.spyOn(context.adapter, "findOne");
    const write = vi.spyOn(context.adapter, "updateMany");
    const sdk = await f.auth.$context;
    const before = await sdk.adapter.findMany({ model: "apikey" });
    const source = apiKeyPrincipal();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        source.resolve(keyRequest(f.handle, `invalid-key-long-enough-${i}`)),
      ),
    );
    expect(
      results.every(
        (r) =>
          r.outcome === "rejected" && r.failure.reason === "INVALID_API_KEY",
      ),
    ).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({
      model: "apikey",
      where: [{ field: "key", value: expect.any(String) }],
    });
    expect(
      read.mock.calls.filter(([input]) =>
        input.where?.some(
          (item) =>
            item.field === "key" &&
            typeof item.value === "string" &&
            item.value.length === 36,
        ),
      ),
    ).toHaveLength(1);
    expect(await sdk.adapter.findMany({ model: "apikey" })).toEqual(before);
  } finally {
    await f.module.close();
  }
});
it("turns ambiguous read/write outages and slow invalid verification into infrastructure errors", async () => {
  const f = await keyFixture();
  try {
    const { vi } = await import("vitest");
    const context = await f.handle.context();
    const write = vi
      .spyOn(context.adapter, "updateMany")
      .mockRejectedValue(new Error("read-only store"));
    await expect(
      apiKeyPrincipal().resolve(
        keyRequest(f.handle, "invalid-key-long-enough"),
      ),
    ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
    write.mockRestore();
    const read = vi
      .spyOn(context.adapter, "findOne")
      .mockRejectedValue(new Error("store offline"));
    await expect(
      apiKeyPrincipal().resolve(
        keyRequest(f.handle, "invalid-key-long-enough"),
      ),
    ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
    read.mockRestore();
    const verify = vi.spyOn(f.auth.api, "verifyApiKey");
    verify.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        valid: false,
        error: { code: "INVALID_API_KEY", message: "invalid" },
        key: null,
      };
    });
    await expect(
      apiKeyPrincipal({ outageProbe: { slowMs: 1 } }).resolve(
        keyRequest(f.handle, "invalid-key-long-enough"),
      ),
    ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
    expect(
      await apiKeyPrincipal({ outageProbe: false }).resolve(
        keyRequest(f.handle, "invalid-key-long-enough"),
      ),
    ).toMatchObject({ failure: { status: 401 } });
  } finally {
    await f.module.close();
  }
});
it.each(["FAILED_TO_UPDATE_API_KEY", "FUTURE_SDK_ERROR"])(
  "treats %s as infrastructure",
  async (code) => {
    const f = await keyFixture();
    try {
      const { vi } = await import("vitest");
      vi.spyOn(f.auth.api, "verifyApiKey").mockResolvedValue({
        valid: false,
        error: { code, message: "failure" },
        key: null,
      });
      await expect(
        apiKeyPrincipal().resolve(keyRequest(f.handle, f.createdKey.key)),
      ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
    } finally {
      await f.module.close();
    }
  },
);

it("verifies only the requested SDK configuration", async () => {
  const f = await keyFixture(
    [{ configId: "alpha" }, { configId: "beta" }],
    "alpha",
  );
  try {
    expect(
      await apiKeyPrincipal({ configId: "alpha" }).resolve(
        keyRequest(f.handle, f.createdKey.key),
      ),
    ).toMatchObject({
      outcome: "authenticated",
      principal: { configId: "alpha", userId: f.userId },
    });
    expect(
      await apiKeyPrincipal({ configId: "beta" }).resolve(
        keyRequest(f.handle, f.createdKey.key),
      ),
    ).toMatchObject({ outcome: "rejected" });
  } finally {
    await f.module.close();
  }
});
it("normalizes thrown SDK statuses without turning infrastructure into denial", async () => {
  const f = await keyFixture();
  try {
    const { APIError } = await import("better-auth/api");
    const { vi } = await import("vitest");
    const spy = vi.spyOn(f.auth.api, "verifyApiKey");
    for (const [status, expected] of [
      ["UNAUTHORIZED", 401],
      ["FORBIDDEN", 403],
      ["TOO_MANY_REQUESTS", 429],
    ] as const) {
      spy.mockRejectedValueOnce(new APIError(status, { code: "TEST_FAILURE" }));
      expect(
        await apiKeyPrincipal().resolve(keyRequest(f.handle, f.createdKey.key)),
      ).toMatchObject({
        outcome: "rejected",
        failure: { status: expected, reason: "TEST_FAILURE" },
      });
    }
    spy.mockRejectedValueOnce(
      new APIError("BAD_REQUEST", { code: "INVALID_INPUT" }),
    );
    await expect(
      apiKeyPrincipal().resolve(keyRequest(f.handle, f.createdKey.key)),
    ).rejects.toMatchObject({ name: "BetterAuthConfigurationError" });
    spy.mockRejectedValueOnce(new APIError("INTERNAL_SERVER_ERROR"));
    await expect(
      apiKeyPrincipal().resolve(keyRequest(f.handle, f.createdKey.key)),
    ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
  } finally {
    await f.module.close();
  }
});
it("keeps probe failures shared and retries after the throttle window", async () => {
  const f = await keyFixture();
  try {
    const { vi } = await import("vitest");
    const adapter = (await f.handle.context()).adapter;
    const write = vi
      .spyOn(adapter, "updateMany")
      .mockRejectedValue(new Error("read-only"));
    const source = apiKeyPrincipal();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        source.resolve(keyRequest(f.handle, "invalid-key-long-enough")),
      ),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 1100);
    try {
      write.mockResolvedValue(0);
      expect(
        await source.resolve(keyRequest(f.handle, "invalid-key-long-enough")),
      ).toMatchObject({ failure: { status: 401 } });
      expect(write).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await f.module.close();
  }
});

it("resolves a real organization-owned SDK key with no user identity", async () => {
  const { organization } = await import("better-auth/plugins");
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: "http://localhost:3000",
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      organization: [],
      member: [],
      invitation: [],
      apikey: [],
    }),
    plugins: [organization(), apiKey({ references: "organization" }), nestjs()],
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
    const org = await auth.api.createOrganization({
      headers,
      body: { name: "Organization", slug: `org-${crypto.randomUUID()}` },
    });
    if (!org) {
      throw new Error("expected organization");
    }
    const created = await auth.api.createApiKey({
      body: {
        userId: signup.response.user.id,
        organizationId: org.id,
        permissions: { project: ["read"] },
      },
    });
    const handle = module.get<AuthHandle>(getBetterAuthHandleToken());
    expect(
      await apiKeyPrincipal({ references: "organization" }).resolve(
        keyRequest(handle, created.key),
      ),
    ).toMatchObject({
      outcome: "authenticated",
      principal: { userId: null, referenceId: org.id, organizationId: org.id },
    });
  } finally {
    await module.close();
  }
});

it("rejects a missing API-key plugin and empty permission maps at boot", async () => {
  const { Controller, Get } = await import("@nestjs/common");
  const { RequireApiKeyPermission } = await import("./api-key.js");
  const { createTestAuth } = await import("./test-fixtures.js");
  for (const hasPlugin of [false, true]) {
    @Controller()
    class Guarded {
      @Get()
      @RequireApiKeyPermission(hasPlugin ? {} : { project: ["read"] })
      run() {}
    }
    const auth = createTestAuth({ plugins: hasPlugin ? [apiKey()] : [] });
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          principals: [apiKeyPrincipal()],
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
it("uses the configured credential header and does not verify an absent credential", async () => {
  const f = await keyFixture();
  try {
    const { vi } = await import("vitest");
    const spy = vi.spyOn(f.auth.api, "verifyApiKey");
    const source = apiKeyPrincipal({
      header: "x-machine-key",
      acceptance: "default",
    });
    const request = keyRequest(f.handle, f.createdKey.key);
    expect(source.appliesTo!(request)).toBe(false);
    expect(await source.resolve(request)).toEqual({ outcome: "absent" });
    expect(spy).not.toHaveBeenCalled();
    request.headers.set("x-machine-key", f.createdKey.key);
    expect(await source.resolve(request)).toMatchObject({
      outcome: "authenticated",
    });
    expect(source.credentialHeaders).toEqual(["x-machine-key"]);
    expect(source.acceptance).toBe("default");
  } finally {
    await f.module.close();
  }
});
it("does not confer permissions on a key with no grant", async () => {
  const f = await keyFixture();
  try {
    const key = await f.auth.api.createApiKey({ body: { userId: f.userId } });
    const result = await apiKeyPrincipal().resolve(
      keyRequest(f.handle, key.key),
    );
    if (result.outcome !== "authenticated") {
      throw new Error("expected principal");
    }
    expect(result.principal.delegation.allows({ project: ["read"] })).toBe(
      false,
    );
  } finally {
    await f.module.close();
  }
});
