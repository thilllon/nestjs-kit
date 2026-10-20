// light-my-request's inject() re-parents Express's module-level request and response
// prototypes onto its own Readable-based Request and Response for the whole process. Injected
// requests are then not http.IncomingMessage instances, and requests that later reach a real
// listening Express server in the same process fail inside light-my-request itself. This suite
// therefore never listens and lives in its own file, away from the other Express suites.
import type { IncomingMessage } from "node:http";
import { ApolloDriver } from "@nestjs/apollo";
import { Controller, Get, Module, Req } from "@nestjs/common";
import { GraphQLModule, Query, Resolver } from "@nestjs/graphql";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { inject } from "light-my-request";
import { describe, expect, it } from "vitest";
import { CurrentPrincipal, RequireAuth } from "./auth-decorators.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthService } from "./auth-service.js";
import type { AuthPrincipal } from "./auth-types.js";
import { expressPlatform } from "./express.js";
import { apolloTransport } from "./graphql.js";
import { createTestAuth, createTestIdentity } from "./test-fixtures.js";

const auth = createTestAuth();

@Resolver()
class ViewerResolver {
  @Query(() => String)
  @RequireAuth()
  viewer(@CurrentPrincipal() principal: AuthPrincipal) {
    return principal.userId;
  }
}

@Controller("direct")
class DirectController {
  constructor(private readonly service: BetterAuthService<typeof auth>) {}

  // Direct caller-session calls need a guarded handler that passed its origin check.
  @RequireAuth()
  @Get("session")
  async session(@Req() request: IncomingMessage) {
    const session = await this.service.api.getSession({
      headers: this.service.headersFrom(request),
    });
    return { userId: session?.user.id ?? null };
  }
}

@Module({
  imports: [
    GraphQLModule.forRoot({ driver: ApolloDriver, autoSchemaFile: true }),
    BetterAuthModule.forRoot({
      auth,
      logSummary: false,
      platforms: [expressPlatform()],
      transports: [apolloTransport()],
    }),
  ],
  controllers: [DirectController],
  providers: [ViewerResolver],
})
class AppModule {}

describe("Express requests dispatched through light-my-request", () => {
  it("authenticates Apollo operations and headersFrom for injected requests", async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app = module.createNestApplication(new ExpressAdapter(), {
      logger: false,
    });
    try {
      await app.init();
      const identity = await createTestIdentity(auth);
      const express = app.getHttpAdapter().getInstance();
      const graphql = (cookie?: string) =>
        inject(express, {
          method: "POST",
          url: "/graphql",
          headers: {
            "content-type": "application/json",
            host: "localhost:3000",
            origin: "http://localhost:3000",
            ...(cookie ? { cookie } : {}),
          },
          payload: JSON.stringify({ query: "{ viewer }" }),
        });

      const authenticated = await graphql(identity.cookie);
      expect(authenticated.json()).toEqual({
        data: { viewer: identity.userId },
      });
      const anonymous = await graphql();
      expect(anonymous.json().errors?.[0]?.extensions).toMatchObject({
        statusCode: 401,
      });

      const direct = await inject(express, {
        method: "GET",
        url: "/direct/session",
        headers: {
          host: "localhost:3000",
          origin: "http://localhost:3000",
          cookie: identity.cookie,
        },
      });
      expect(direct.statusCode, direct.body).toBe(200);
      expect(direct.json()).toEqual({ userId: identity.userId });
    } finally {
      await app.close();
    }
  });
});
