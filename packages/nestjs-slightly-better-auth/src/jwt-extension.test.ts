import { Test, type TestingModule } from "@nestjs/testing";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { createLocalJWKSet, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AuthHandle,
  PrincipalRequest,
  PrincipalSource,
} from "./auth-contracts.js";
import { isConfigurationError } from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import { getBetterAuthHandleToken } from "./auth-tokens.js";
import {
  JWT_SOURCE_ID,
  type JwtPrincipalOptions,
  jwtPrincipal,
} from "./jwt-extension-fixture.js";
import { nestjs } from "./plugin.js";

const ISSUER = "https://issuer.example";
const AUDIENCE = "https://audience.example";
const TENANT_HOST = { host: "tenant.example" };
const DYNAMIC = { allowedHosts: ["tenant.example"] };
const EXPLICIT_CLAIMS = { jwt: { issuer: ISSUER, audience: AUDIENCE } };

type JwtPluginOptions = NonNullable<Parameters<typeof jwt>[0]>;

function createJwtAuth(
  baseURL: BetterAuthOptions["baseURL"],
  jwtOptions?: JwtPluginOptions,
  cookiePrefix?: string,
) {
  return betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL,
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    advanced: { disableOriginCheck: false, cookiePrefix },
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
    }),
    plugins: [jwt(jwtOptions), nestjs()],
  });
}
type JwtAuth = ReturnType<typeof createJwtAuth>;

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) {
    await close();
  }
});

async function compile(
  instances: readonly {
    auth: JwtAuth;
    name?: string;
    principals?: readonly PrincipalSource[];
  }[],
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: instances.map(({ auth, name, principals = [] }) => {
      const options = {
        auth,
        principals: [...principals],
        http: { mount: false },
        logSummary: false,
      };
      return name === undefined
        ? BetterAuthModule.forRoot(options)
        : BetterAuthModule.forRoot({ ...options, name });
    }),
  }).compile();
}

async function boot(
  baseURL: BetterAuthOptions["baseURL"],
  options: {
    jwt?: JwtPluginOptions;
    principals?: readonly PrincipalSource[];
  } = {},
) {
  const auth = createJwtAuth(baseURL, options.jwt);
  const module = await compile([{ auth, principals: options.principals }]);
  await module.init();
  closes.push(() => module.close());
  return { auth, handle: module.get<AuthHandle>(getBetterAuthHandleToken()) };
}

function bearer(
  auth: AuthHandle,
  token: string,
  headers: HeadersInit = {},
): PrincipalRequest {
  const all = new Headers(headers);
  all.set("authorization", `Bearer ${token}`);
  return {
    auth,
    headers: all,
    cookies: null,
    transport: "test",
    freshness: "default",
    memo: (_key, compute) => compute(),
  };
}

async function mint(
  auth: JwtAuth,
  payload: Record<string, unknown> = { sub: "user-1" },
  overrideOptions?: JwtPluginOptions,
): Promise<string> {
  const { token } = await auth.api.signJWT({
    body: { payload, overrideOptions },
    headers: new Headers(TENANT_HOST),
  });
  return token;
}

function keyId(token: string): string {
  const header = token.split(".")[0]!;
  return JSON.parse(Buffer.from(header, "base64url").toString()).kid;
}

const invalidJwt = {
  outcome: "rejected",
  failure: expect.objectContaining({
    status: 401,
    code: "UNAUTHENTICATED",
    reason: "INVALID_JWT",
    challenge: 'Bearer error="invalid_token"',
  }),
};

describe("JWT principal-source extension (design v7 §4.3.4)", () => {
  it("verifies against the origin of a static baseURL, not its basePath URL", async () => {
    const source = jwtPrincipal();
    const { auth, handle } = await boot("http://localhost:3000/api/auth", {
      principals: [source],
    });
    const token = await mint(auth);
    const { baseURL } = await handle.context();
    expect(baseURL).toBe("http://localhost:3000/api/auth");
    // Control: expecting the basePath URL as issuer fails every valid token.
    await expect(
      jwtVerify(token, createLocalJWKSet(await auth.api.getJwks()), {
        issuer: baseURL,
      }),
    ).rejects.toMatchObject({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED" });
    expect(await source.resolve(bearer(handle, token))).toMatchObject({
      outcome: "authenticated",
      principal: {
        kind: "jwt",
        source: JWT_SOURCE_ID,
        userId: "user-1",
        claims: { iss: "http://localhost:3000", aud: "http://localhost:3000" },
      },
    });
  });

  it("rejects wrong-claim, expired, forged and unsigned tokens without extra key reads", async () => {
    const source = jwtPrincipal();
    const { auth, handle } = await boot("http://localhost:3000", {
      principals: [source],
    });
    const valid = await mint(auth);
    const [header, , signature] = valid.split(".");
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const forgedPayload = encode({
      sub: "admin",
      iss: "http://localhost:3000",
      aud: "http://localhost:3000",
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    const reads = vi.spyOn(auth.api, "getJwks");
    expect(await source.resolve(bearer(handle, valid))).toMatchObject({
      outcome: "authenticated",
    });
    const invalid = [
      await mint(
        auth,
        { sub: "user-1" },
        { jwt: { issuer: "https://x.test" } },
      ),
      await mint(auth, { sub: "user-1", exp: Math.floor(Date.now() / 1000) }),
      `${header}.${forgedPayload}.${signature}`,
      // jose reports an attacker-chosen `alg` as ERR_JOSE_NOT_SUPPORTED.
      `${encode({ alg: "none", typ: "JWT" })}.${forgedPayload}.`,
    ];
    for (const token of invalid) {
      expect(await source.resolve(bearer(handle, token))).toEqual(invalidJwt);
    }
    expect(reads).toHaveBeenCalledTimes(1);
    // A non-JWT bearer credential (a session token) is left to other sources.
    expect(source.appliesTo?.(bearer(handle, "session-token"))).toBe(false);
  });

  it.each([
    { config: "dynamic baseURL without fallback", baseURL: DYNAMIC },
    {
      config: "dynamic baseURL with fallback",
      baseURL: { ...DYNAMIC, fallback: "https://fallback.example" },
    },
    { config: "unset baseURL", baseURL: undefined },
  ])(
    "resolves keys from the request headers with explicit claims under $config",
    async ({ baseURL }) => {
      const source = jwtPrincipal({ issuer: ISSUER, audience: AUDIENCE });
      const { auth, handle } = await boot(baseURL, {
        jwt: EXPLICIT_CLAIMS,
        principals: [source],
      });
      const noInput = auth.api.getJwks();
      if (baseURL && !("fallback" in baseURL)) {
        // Control: without a resolution source the SDK cannot resolve the dynamic host.
        await expect(noInput).rejects.toMatchObject({ statusCode: 500 });
      } else {
        await expect(noInput).resolves.toHaveProperty("keys");
      }
      const token = await mint(auth);
      const reads = vi.spyOn(auth.api, "getJwks");
      const request = bearer(handle, token, TENANT_HOST);
      expect(await source.resolve(request)).toMatchObject({
        outcome: "authenticated",
        principal: { userId: "user-1", claims: { iss: ISSUER, aud: AUDIENCE } },
      });
      expect(await source.resolve(request)).toMatchObject({
        outcome: "authenticated",
      });
      // One cached read, given the request's own headers with host and credential intact.
      expect(reads).toHaveBeenCalledExactlyOnceWith({
        headers: request.headers,
      });
      expect(reads.mock.calls[0]![0]!.headers).toBe(request.headers);
    },
  );

  it.each([
    { config: "unset", baseURL: undefined },
    { config: "dynamic", baseURL: DYNAMIC },
  ])(
    "requires explicit issuer and audience when the shared baseURL is $config",
    async ({ baseURL }) => {
      const partial: JwtPrincipalOptions[] = [
        {},
        { issuer: ISSUER },
        { audience: AUDIENCE },
      ];
      for (const options of partial) {
        const auth = createJwtAuth(baseURL, EXPLICIT_CLAIMS);
        const module = await compile([
          { auth, principals: [jwtPrincipal(options)] },
        ]);
        await expect(module.init()).rejects.toMatchObject({
          code: "AUTH_BOOT_FAILED",
          issues: [
            expect.objectContaining({ code: "JWT_CLAIMS_NOT_CONFIGURED" }),
          ],
        });
        await module.close().catch(() => undefined);
      }
      // Without boot validation the same source fails the request, never with a TypeError.
      const { auth, handle } = await boot(baseURL, { jwt: EXPLICIT_CLAIMS });
      const token = await mint(auth);
      const reads = vi.spyOn(auth.api, "getJwks");
      const failure = await jwtPrincipal({ issuer: ISSUER })
        .resolve(bearer(handle, token, TENANT_HOST))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(isConfigurationError(failure)).toBe(true);
      expect(failure).toMatchObject({
        code: "JWT_CLAIMS_NOT_CONFIGURED",
        phase: "request",
        site: JWT_SOURCE_ID,
      });
      expect(reads).not.toHaveBeenCalled();
    },
  );

  it("throws JWKS storage faults instead of reporting an invalid token, and recovers", async () => {
    const source = jwtPrincipal();
    const { auth, handle } = await boot("http://localhost:3000", {
      principals: [source],
    });
    const token = await mint(auth);
    const { adapter } = await auth.$context;
    const outage = vi
      .spyOn(adapter, "findMany")
      .mockRejectedValue(new Error("jwks store offline"));
    const request = bearer(handle, token);
    // A throw is the source contract's infrastructure signal (5xx), never absent or rejected.
    await expect(source.resolve(request)).rejects.toThrow("jwks store offline");
    // Control: the SDK's verifyJWT reports the same outage like a forged token.
    expect(await auth.api.verifyJWT({ body: { token } })).toEqual({
      payload: null,
    });
    outage.mockRestore();
    // The failed read was not cached.
    expect(await source.resolve(request)).toMatchObject({
      outcome: "authenticated",
    });
    // A stored key that cannot be imported is a storage fault as well.
    const [row] = await adapter.findMany<{ id: string; publicKey: string }>({
      model: "jwks",
    });
    await adapter.update({
      model: "jwks",
      where: [{ field: "id", value: row!.id }],
      update: {
        publicKey: JSON.stringify({ ...JSON.parse(row!.publicKey), x: "AAAA" }),
      },
    });
    await expect(jwtPrincipal().resolve(request)).rejects.toMatchObject({
      name: "DataError",
    });
  });

  it("keeps key caches per Better Auth instance, even for one shared source", async () => {
    const source = jwtPrincipal();
    const primary = createJwtAuth("http://localhost:3000");
    const tenant = createJwtAuth("http://localhost:3000", undefined, "tenant");
    const module = await compile([
      { auth: primary, principals: [source] },
      { auth: tenant, name: "tenant", principals: [source] },
    ]);
    await module.init();
    closes.push(() => module.close());
    const primaryHandle = module.get<AuthHandle>(getBetterAuthHandleToken());
    const tenantHandle = module.get<AuthHandle>(
      getBetterAuthHandleToken("tenant"),
    );
    const primaryToken = await mint(primary);
    const tenantToken = await mint(tenant);
    const primaryReads = vi.spyOn(primary.api, "getJwks");
    const tenantReads = vi.spyOn(tenant.api, "getJwks");
    expect(
      await source.resolve(bearer(primaryHandle, primaryToken)),
    ).toMatchObject({ outcome: "authenticated" });
    expect(
      await source.resolve(bearer(tenantHandle, tenantToken)),
    ).toMatchObject({ outcome: "authenticated" });
    // Both instances sign the same claims, so only the keys tell the tokens apart.
    expect(await source.resolve(bearer(tenantHandle, primaryToken))).toEqual(
      invalidJwt,
    );
    expect(await source.resolve(bearer(primaryHandle, tenantToken))).toEqual(
      invalidJwt,
    );
    expect(primaryReads).toHaveBeenCalledTimes(1);
    expect(tenantReads).toHaveBeenCalledTimes(1);
  });

  it("refetches a rotated key once per cooldown", async () => {
    const source = jwtPrincipal();
    const { auth, handle } = await boot("http://localhost:3000", {
      principals: [source],
    });
    const first = await mint(auth);
    const reads = vi.spyOn(auth.api, "getJwks");
    expect(await source.resolve(bearer(handle, first))).toMatchObject({
      outcome: "authenticated",
    });
    const { adapter } = await auth.$context;
    await adapter.update({
      model: "jwks",
      where: [{ field: "id", value: keyId(first) }],
      update: { expiresAt: new Date(Date.now() - 1000) },
    });
    const rotated = await mint(auth);
    expect(keyId(rotated)).not.toBe(keyId(first));
    // Within the cooldown an unknown key id costs no storage read.
    expect(await source.resolve(bearer(handle, rotated))).toEqual(invalidJwt);
    expect(reads).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
    const results = await Promise.all([
      source.resolve(bearer(handle, rotated)),
      source.resolve(bearer(handle, rotated)),
    ]);
    expect(results).toMatchObject([
      { outcome: "authenticated" },
      { outcome: "authenticated" },
    ]);
    // Concurrent refreshes share one read; the retired key stays in its grace period.
    expect(reads).toHaveBeenCalledTimes(2);
    expect(await source.resolve(bearer(handle, first))).toMatchObject({
      outcome: "authenticated",
    });
    expect(reads).toHaveBeenCalledTimes(2);
  });
});
