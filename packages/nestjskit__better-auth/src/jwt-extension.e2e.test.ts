import {
  type ArgumentsHost,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
} from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import type { Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  AcceptPrincipals,
  BeforeAuth,
  CurrentPrincipal,
  RequireAuth,
} from "./auth-decorators.js";
import { BetterAuthInfrastructureError } from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import type { AuthHookContext, AuthPrincipal } from "./auth-types.js";
import { expressPlatform } from "./express.js";
import { jwtPrincipal } from "./jwt-extension-fixture.js";
import { nestjs } from "./plugin.js";

const ISSUER = "https://issuer.example";
const AUDIENCE = "https://audience.example";

@Controller("jwt")
class JwtController {
  @Get("principal")
  @AcceptPrincipals("jwt")
  principal(@CurrentPrincipal() principal: AuthPrincipal) {
    return { kind: principal.kind, userId: principal.userId };
  }

  @Get("session")
  @RequireAuth()
  session() {
    return { ok: true };
  }
}

class JwksHooks {
  readonly calls: { host: string | null; authorization: string | null }[] = [];

  readonly external: string[] = [];

  @BeforeAuth("/jwks")
  observe(ctx: AuthHookContext<"/jwks">) {
    this.calls.push({
      host: ctx.headers?.get("host") ?? null,
      authorization: ctx.headers?.get("authorization") ?? null,
    });
  }

  @BeforeAuth("/jwks", { skipInternal: true })
  observeExternal(ctx: AuthHookContext<"/jwks">) {
    this.external.push(ctx.path);
  }
}

@Catch(BetterAuthInfrastructureError)
class InfrastructureFilter implements ExceptionFilter {
  catch(error: BetterAuthInfrastructureError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(500)
      .json({ reason: error.extensions.reason });
  }
}

describe("JWT principal-source extension over Express", () => {
  it("resolves keys from the real request host under a dynamic baseURL without fallback", async () => {
    const auth = betterAuth({
      secret: crypto.randomUUID() + crypto.randomUUID(),
      baseURL: { allowedHosts: ["127.0.0.1:*"] },
      logger: { disabled: true },
      emailAndPassword: { enabled: true },
      advanced: { disableOriginCheck: false },
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
        jwks: [],
      }),
      plugins: [jwt({ jwt: { issuer: ISSUER, audience: AUDIENCE } }), nestjs()],
    });
    const module = await Test.createTestingModule({
      imports: [
        BetterAuthModule.forRoot({
          auth,
          platforms: [expressPlatform()],
          principals: [jwtPrincipal({ issuer: ISSUER, audience: AUDIENCE })],
          logSummary: false,
        }),
      ],
      controllers: [JwtController],
      providers: [JwksHooks, InfrastructureFilter],
    }).compile();
    const app = module.createNestApplication(new ExpressAdapter());
    try {
      app.useGlobalFilters(app.get(InfrastructureFilter));
      await app.init();
      await app.listen(0, "127.0.0.1");
      const url = await app.getUrl();
      const host = new URL(url).host;
      const hooks = app.get(JwksHooks);
      const signUp = await fetch(`${url}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { origin: url, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Machine Owner",
          email: `${crypto.randomUUID()}@example.com`,
          password: "password-secure-123",
        }),
      });
      expect(signUp.status).toBe(200);
      const { user } = (await signUp.json()) as { user: { id: string } };
      const cookie = signUp.headers
        .getSetCookie()
        .map((line) => line.split(";", 1)[0])
        .join("; ");
      const minted = await fetch(`${url}/api/auth/token`, {
        headers: { cookie },
      });
      const { token } = (await minted.json()) as { token: string };
      const get = (path: string, bearer: string) =>
        fetch(`${url}${path}`, {
          headers: { authorization: `Bearer ${bearer}` },
        });

      // Storage down on a cold key cache: an infrastructure 500, not a 401.
      const { adapter } = await auth.$context;
      const outage = vi
        .spyOn(adapter, "findMany")
        .mockRejectedValue(new Error("jwks store offline"));
      const down = await get("/jwt/principal", token);
      expect(down.status).toBe(500);
      expect(await down.json()).toEqual({ reason: "AUTH_UNAVAILABLE" });
      outage.mockRestore();

      const verified = await get("/jwt/principal", token);
      expect(verified.status).toBe(200);
      expect(await verified.json()).toEqual({ kind: "jwt", userId: user.id });
      // Both reads carried the request's host and credential as internal calls.
      const internal = { host, authorization: `Bearer ${token}` };
      expect(hooks.calls).toEqual([internal, internal]);
      expect(hooks.external).toEqual([]);
      // Control: an application's own JWKS request reaches both hooks.
      expect((await fetch(`${url}/api/auth/jwks`)).status).toBe(200);
      expect(hooks.external).toEqual(["/jwks"]);

      // The source's acceptance is explicit: other routes never verify the token.
      expect((await get("/jwt/session", token)).status).toBe(401);
      expect(hooks.calls).toHaveLength(3);

      const foreign = await auth.api.signJWT({
        body: {
          payload: { sub: user.id },
          overrideOptions: {
            jwt: { issuer: "https://other.example", audience: AUDIENCE },
          },
        },
        headers: new Headers({ host }),
      });
      const denied = await get("/jwt/principal", foreign.token);
      expect(denied.status).toBe(401);
      expect(denied.headers.get("www-authenticate")).toBe(
        'Bearer error="invalid_token"',
      );
      expect(await denied.json()).toMatchObject({
        code: "UNAUTHENTICATED",
        reason: "INVALID_JWT",
      });
    } finally {
      await app.close();
    }
  });
});
