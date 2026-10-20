import {
  Controller,
  Get,
  Inject,
  Module,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import { admin, organization } from "better-auth/plugins";
import { afterEach, describe, expect, it } from "vitest";
import { RequirePermission } from "./admin.js";
import {
  CurrentPrincipal,
  UseAuthInstance,
  UseBetterAuth,
} from "./auth-decorators.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthService } from "./auth-service.js";
import { getBetterAuthServiceToken } from "./auth-tokens.js";
import type { AuthLike, AuthPrincipal } from "./auth-types.js";
import { allow } from "./authorization-evaluator.js";
import {
  createConformanceAuth,
  kitIdentity,
  probeOf,
  type ProbeState,
  sendRaw,
} from "./conformance-fixtures.js";
import { expressPlatform } from "./express.js";
import { organizationRef, RequireOrgPermission } from "./organization.js";
import { CurrentSession } from "./session-principal.js";
import {
  initTestApp,
  overrideAuthGuard,
  overrideDecisions,
  overridePrincipal,
  stampPrincipal,
} from "./testing.js";

const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

function principal(userId: string): AuthPrincipal {
  return {
    kind: "session",
    source: "better-auth:session",
    userId,
    session: { user: { id: userId }, session: { id: `session-${userId}` } },
  } as unknown as AuthPrincipal;
}

interface Fixture {
  readonly auth: AuthLike;
  readonly second: AuthLike;
  readonly probe: ProbeState;
  readonly secondProbe: ProbeState;
  readonly organizationId: string;
  builder(): TestingModuleBuilder;
}

/** One compiled module: a globally guarded route, an explicit @UseBetterAuth() route and a named-instance route. */
async function fixture(): Promise<Fixture> {
  const auth = createConformanceAuth({ plugins: [organization()] });
  const second = createConformanceAuth({
    basePath: "/api/named-auth",
    advanced: { cookiePrefix: "named" },
  });
  const probe = await probeOf(auth);
  const secondProbe = await probeOf(second);
  const owner = await kitIdentity(auth);
  const created = await (
    auth.api as unknown as {
      createOrganization(input: {
        headers: Headers;
        body: { name: string; slug: string };
      }): Promise<{ id: string }>;
    }
  ).createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: { name: "Fixture", slug: `fixture-${crypto.randomUUID()}` },
  });

  @Controller("global")
  class GlobalController {
    constructor(
      @Inject(BetterAuthService) private readonly service: BetterAuthService,
    ) {}

    @Get()
    async global(@CurrentPrincipal() current: AuthPrincipal | null) {
      return {
        decorator: current?.userId ?? null,
        service: (await this.service.getPrincipal())?.userId ?? null,
      };
    }

    @RequireOrgPermission(
      { organization: ["update"] },
      { organization: organizationRef(() => created.id) },
    )
    @Get("organization")
    organization() {
      return { allowed: true };
    }
  }

  @UseBetterAuth()
  @Controller("explicit")
  class ExplicitController {
    @Get()
    explicit(@CurrentSession() session: { user: { id: string } } | null) {
      return { session: session?.user.id ?? null };
    }
  }

  @UseAuthInstance("named")
  @UseBetterAuth()
  @Controller("named")
  class NamedController {
    constructor(
      @Inject(getBetterAuthServiceToken("named"))
      private readonly service: BetterAuthService,
    ) {}

    @Get()
    async named(@CurrentPrincipal() current: AuthPrincipal | null) {
      return {
        decorator: current?.userId ?? null,
        service: (await this.service.getPrincipal())?.userId ?? null,
      };
    }
  }

  @Module({
    imports: [
      BetterAuthModule.forRoot({
        auth,
        platforms: [expressPlatform()],
        logSummary: false,
      } as never),
      BetterAuthModule.forRoot({
        name: "named",
        auth: second,
        logSummary: false,
      } as never),
    ],
    controllers: [GlobalController, ExplicitController, NamedController],
  })
  class FixtureModule {}

  return {
    auth,
    second,
    probe,
    secondProbe,
    organizationId: created.id,
    builder: () => Test.createTestingModule({ imports: [FixtureModule] }),
  };
}

async function start(builder: TestingModuleBuilder): Promise<string> {
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication(new ExpressAdapter(), {
    logger: false,
  });
  apps.push(app);
  await initTestApp(app);
  await app.listen(0, "127.0.0.1");
  return app.getUrl();
}

async function get(url: string, headers: Record<string, string> = {}) {
  const response = await sendRaw(url, { headers });
  return {
    status: response.status,
    body: JSON.parse(response.body.toString("utf8") || "null") as Record<
      string,
      unknown
    >,
  };
}

function sessionReads(probe: ProbeState): number {
  return probe.calls.filter((path) => path === "/get-session").length;
}

describe("overrideAuthGuard", () => {
  it("replaces the global and the explicit guard sites with one override and no SDK resolution", async () => {
    const f = await fixture();
    const calls: string[] = [];
    const builder = f.builder();
    overrideAuthGuard(builder, {
      canActivate(ctx: ExecutionContext) {
        calls.push(ctx.getHandler().name);
        stampPrincipal(ctx, principal("stand-in"));
        return true;
      },
    });
    const url = await start(builder);
    expect(await get(`${url}/global`)).toEqual({
      status: 200,
      body: { decorator: "stand-in", service: "stand-in" },
    });
    expect(await get(`${url}/explicit`)).toEqual({
      status: 200,
      body: { session: "stand-in" },
    });
    expect(calls).toContain("global");
    expect(calls).toContain("explicit");
    expect(sessionReads(f.probe)).toBe(0);
  });

  it("stamps the { principal } stand-in per invocation and per handler instance", async () => {
    const f = await fixture();
    const builder = f.builder();
    overrideAuthGuard(builder, {
      principal: (ctx) => {
        const user = ctx
          .switchToHttp()
          .getRequest<{ headers: Record<string, string> }>().headers[
          "x-test-user"
        ];
        return user ? principal(user) : null;
      },
    });
    const url = await start(builder);
    const users = Array.from({ length: 8 }, (_, index) => `user-${index}`);
    const answers = await Promise.all(
      users.map((user) => get(`${url}/global`, { "x-test-user": user })),
    );
    expect(answers.map((answer) => answer.body.decorator)).toEqual(users);
    expect(await get(`${url}/global`)).toEqual({
      status: 200,
      body: { decorator: null, service: null },
    });
    expect(await get(`${url}/named`, { "x-test-user": "named-user" })).toEqual({
      status: 200,
      body: { decorator: "named-user", service: "named-user" },
    });
    expect(sessionReads(f.probe) + sessionReads(f.secondProbe)).toBe(0);
  });

  it("answers NO_AUTH_RESULT generically when a stand-in guard stamps nothing", async () => {
    const f = await fixture();
    const builder = f.builder();
    overrideAuthGuard(builder, { canActivate: () => true } as CanActivate);
    const url = await start(builder);
    const response = await get(`${url}/explicit`);
    expect(response).toEqual({
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    });
  });

  it("cannot be replaced by overrideProvider plus overrideGuard of BetterAuthGuard", async () => {
    const standIn: CanActivate = {
      canActivate(ctx) {
        stampPrincipal(ctx, principal("stand-in"));
        return true;
      },
    };
    const first = await fixture();
    const providerThenGuard = first
      .builder()
      .overrideProvider(BetterAuthGuard)
      .useValue(standIn)
      .overrideGuard(BetterAuthGuard)
      .useValue(standIn);
    const url = await start(providerThenGuard);
    // The later overrideGuard discarded the provider override: APP_GUARD runs the real guard.
    expect((await get(`${url}/global`)).status).toBe(401);
    const second = await fixture();
    const guardThenProvider = second
      .builder()
      .overrideGuard(BetterAuthGuard)
      .useValue(standIn)
      .overrideProvider(BetterAuthGuard)
      .useValue(standIn);
    const otherUrl = await start(guardThenProvider);
    expect((await get(`${otherUrl}/global`)).status).toBe(200);
    // The @UseBetterAuth() injectable kept the real guard.
    expect((await get(`${otherUrl}/explicit`)).status).toBe(401);
  });
});

describe("overridePrincipal and overrideDecisions on real routes", () => {
  it("keeps real acceptance and policies, and stubs organization decisions", async () => {
    const f = await fixture();
    const plain = f.builder();
    overridePrincipal(plain, principal("fixed-user"));
    const url = await start(plain);
    expect(await get(`${url}/global`)).toEqual({
      status: 200,
      body: { decorator: "fixed-user", service: "fixed-user" },
    });
    // The organization policy calls Better Auth with sessionless headers; re-classification answers absent.
    expect(await get(`${url}/global/organization`)).toMatchObject({
      status: 401,
      body: { code: "UNAUTHENTICATED" },
    });
    expect(sessionReads(f.probe)).toBe(0);
    const decided = f.builder();
    overridePrincipal(decided, principal("fixed-user"));
    overrideDecisions(decided, (policyId) =>
      policyId === "better-auth:organization/permission" // gitleaks:allow: public policy identifier
        ? allow()
        : undefined,
    );
    const decidedUrl = await start(decided);
    expect(await get(`${decidedUrl}/global/organization`)).toEqual({
      status: 200,
      body: { allowed: true },
    });
  });

  it("replaces only the named instance it targets", async () => {
    const f = await fixture();
    const builder = f.builder();
    overridePrincipal(builder, principal("named-fixed"), { instance: "named" });
    const url = await start(builder);
    expect(await get(`${url}/named`)).toEqual({
      status: 200,
      body: { decorator: "named-fixed", service: "named-fixed" },
    });
    expect((await get(`${url}/global`)).status).toBe(401);
    expect(sessionReads(f.secondProbe)).toBe(0);
  });
});

describe("overrideDecisions falling back to the real admin policy", () => {
  it("answers USER_NOT_FOUND without a stored user and the stored role's verdict otherwise", async () => {
    const auth = createConformanceAuth({ plugins: [admin()] });
    const administrator = await kitIdentity(auth, { role: "admin" });
    const member = await kitIdentity(auth, { role: "user" });

    @Controller("users")
    class UsersController {
      @RequirePermission({ user: ["list"] })
      @Get()
      list() {
        return { allowed: true };
      }
    }

    @Module({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          platforms: [expressPlatform()],
          logSummary: false,
        } as never),
      ],
      controllers: [UsersController],
    })
    class AdminModule {}

    const cases = [
      // The fixed session claims the opposite role: the policy judges the stored user row.
      [
        "missing-user",
        "admin",
        { status: 401, body: { reason: "USER_NOT_FOUND" } },
      ],
      [administrator.userId, "user", { status: 200, body: { allowed: true } }],
      [
        member.userId,
        "admin",
        { status: 403, body: { reason: "MISSING_PERMISSION" } },
      ],
    ] as const;
    for (const [userId, role, expected] of cases) {
      const builder = Test.createTestingModule({ imports: [AdminModule] });
      overridePrincipal(builder, {
        kind: "session",
        source: "better-auth:session",
        userId,
        session: {
          user: { id: userId, role },
          session: { id: `session-${userId}` },
        },
      } as unknown as AuthPrincipal);
      overrideDecisions(builder, () => undefined);
      const url = await start(builder);
      expect(await get(`${url}/users`)).toMatchObject(expected);
    }
  });
});
