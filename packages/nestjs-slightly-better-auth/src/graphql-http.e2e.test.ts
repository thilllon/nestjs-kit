import { ApolloDriver } from "@nestjs/apollo";
import { MercuriusDriver } from "@nestjs/mercurius";
import {
  Args,
  Field,
  GraphQLModule,
  Mutation,
  ObjectType,
  Query,
  ResolveField,
  Resolver,
} from "@nestjs/graphql";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { BetterAuthModule } from "./auth-module.js";
import { CurrentPrincipal, RequireAuth } from "./auth-decorators.js";
import type { AuthPrincipal } from "./auth-types.js";
import { expressPlatform } from "./express.js";
import { fastifyPlatform } from "./fastify.js";
import { apolloTransport, mercuriusTransport } from "./graphql.js";
import { fromParam, RequireOrgPermission } from "./organization.js";
import { nestjs } from "./plugin.js";

@ObjectType()
class GraphProject {
  @Field(() => String) id!: string;
}
@Resolver(() => GraphProject)
class ProjectsResolver {
  @Query(() => GraphProject, { nullable: true })
  @RequireAuth({ authoritative: true })
  @RequireOrgPermission(
    { member: ["create"] },
    { organization: fromParam("orgId") },
  )
  projects(@Args("orgId", { type: () => String }) orgId: string) {
    return { id: orgId };
  }

  @ResolveField(() => String)
  id(@CurrentPrincipal() principal: AuthPrincipal | null) {
    return principal?.userId ?? "anonymous";
  }
}

describe.each(["apollo", "mercurius"] as const)(
  "native %s GraphQL HTTP",
  (driver) => {
    it("makes independent aliased organization decisions with one real SDK session read", async () => {
      const database: Record<string, Record<string, unknown>[]> = {
        user: [],
        session: [],
        account: [],
        verification: [],
        organization: [],
        member: [],
        invitation: [],
      };
      let sessionReads = 0;
      const memory = memoryAdapter(database);
      const auth = betterAuth({
        secret: crypto.randomUUID() + crypto.randomUUID(),
        baseURL: "http://localhost:3000",
        logger: { disabled: true },
        emailAndPassword: { enabled: true },
        session: { cookieCache: { enabled: true } },
        advanced: { disableOriginCheck: false },
        database: (options: Parameters<typeof memory>[0]) => {
          const adapter = memory(options);
          return {
            ...adapter,
            findOne: async (
              input: Parameters<ReturnType<typeof memory>["findOne"]>[0],
            ) => {
              if (input.model === "session") {
                sessionReads++;
              }
              return adapter.findOne(input);
            },
          };
        },
        plugins: [organization(), nestjs()],
      });
      const module = await Test.createTestingModule({
        imports: [
          GraphQLModule.forRoot({
            driver: driver === "apollo" ? ApolloDriver : MercuriusDriver,
            autoSchemaFile: true,
            fieldResolverEnhancers: ["guards", "interceptors", "filters"],
            allowBatchedHttpRequests: true,
            allowBatchedQueries: true,
          }),
          BetterAuthModule.forRoot({
            auth,
            logSummary: false,
            limits: { maxAuthorizationCallsPerRequest: 2 },
            platforms: [
              driver === "apollo" ? expressPlatform() : fastifyPlatform(),
            ],
            transports: [
              driver === "apollo" ? apolloTransport() : mercuriusTransport(),
            ],
          }),
        ],
        providers: [ProjectsResolver],
      }).compile();
      const app = module.createNestApplication(
        driver === "apollo" ? new ExpressAdapter() : new FastifyAdapter(),
        { logger: false },
      );
      try {
        await app.listen(0, "127.0.0.1");
        const signup = await auth.api.signUpEmail({
          body: {
            name: "Owner",
            email: `${crypto.randomUUID()}@example.com`,
            password: "password-secure-123",
          },
          returnHeaders: true,
        });
        const cookie = signup.headers
          .getSetCookie()
          .map((line) => line.split(";")[0])
          .join("; ");
        database.organization.push(
          { id: "A", name: "A", slug: "a", createdAt: new Date() },
          { id: "B", name: "B", slug: "b", createdAt: new Date() },
        );
        database.member.push({
          id: "membership-a",
          organizationId: "A",
          userId: signup.response.user.id,
          role: "owner",
          createdAt: new Date(),
        });
        sessionReads = 0;
        const response = await fetch(`${await app.getUrl()}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            query:
              '{ a: projects(orgId: "A") { id } b: projects(orgId: "B") { id } }',
          }),
        });
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.data.a).toEqual({ id: signup.response.user.id });
        expect(
          body.errors.some(
            (error: { path: string[] }) => error.path[0] === "b",
          ),
        ).toBe(true);
        expect(sessionReads).toBe(1);
        const limited = await fetch(`${await app.getUrl()}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({
            query:
              '{ a: projects(orgId:"A"){id} b: projects(orgId:"B"){id} c: projects(orgId:"C"){id} }',
          }),
        });
        const limitedBody = await limited.json();
        expect(limited.status).toBe(200);
        expect(
          limitedBody.errors.some(
            (error: { extensions: { code: string; statusCode: number } }) =>
              error.extensions.code === "RATE_LIMITED" &&
              error.extensions.statusCode === 429,
          ),
        ).toBe(true);
        sessionReads = 0;
        const batch = await fetch(`${await app.getUrl()}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify([
            { query: '{ projects(orgId:"A"){id} }' },
            { query: '{ projects(orgId:"B"){id} }' },
          ]),
        });
        const batchBody = await batch.json();
        expect(batchBody[0].data.projects).toEqual({
          id: signup.response.user.id,
        });
        expect(batchBody[1].data.projects).toBeNull();
        expect(sessionReads).toBe(1);
      } finally {
        await app.close();
      }
    });
  },
);

// These fixtures exercise transport failures through the drivers' actual error pipelines.
import { apiKey } from "@better-auth/api-key";
import { Inject, type LoggerService } from "@nestjs/common";
import {
  AcceptPrincipals,
  ForwardAuthCookies,
  Public,
} from "./auth-decorators.js";
import { apiKeyPrincipal } from "./api-key.js";
import { getBetterAuthServiceToken } from "./auth-tokens.js";
import { BetterAuthService } from "./auth-service.js";
import { CurrentSession } from "./session-principal.js";
import type { AuthSession } from "./auth-types.js";
import { startHttpFixture } from "./test-fixtures.js";

@ObjectType()
class SecurityRow {
  @Field(() => String, { nullable: true }) value!: string;
  @Field(() => String, { nullable: true }) session!: string;
  @Field(() => String, { nullable: true }) forwarded!: string;
}
@Resolver(() => SecurityRow)
@RequireAuth()
class SecurityResolver {
  sideEffects = 0;
  constructor(
    @Inject(getBetterAuthServiceToken())
    private readonly auth: BetterAuthService,
  ) {}

  @Query(() => String, { nullable: true })
  @Public()
  harmless() {
    return "harmless";
  }

  @Query(() => String, { nullable: true })
  guarded() {
    this.sideEffects++;
    return "guarded";
  }

  @Mutation(() => String, { nullable: true })
  change() {
    this.sideEffects++;
    return "changed";
  }

  @Query(() => String, { nullable: true })
  @Public()
  async direct() {
    await this.auth.api.getSession({ headers: new Headers() });
    this.sideEffects++;
    return "direct";
  }

  @Query(() => [SecurityRow])
  @Public()
  publicRows() {
    return [{}, {}];
  }

  @Query(() => [SecurityRow])
  rows() {
    return Array.from({ length: 20 }, () => ({}));
  }

  @Query(() => [SecurityRow])
  @AcceptPrincipals("api-key")
  keyRows() {
    return Array.from({ length: 20 }, () => ({}));
  }

  @ResolveField(() => String, { nullable: true })
  value(@CurrentPrincipal() principal: AuthPrincipal | null) {
    return principal?.userId ?? "anonymous";
  }

  @ResolveField(() => String, { nullable: true })
  session(@CurrentSession() session: AuthSession | null) {
    return session ? "session" : "anonymous";
  }

  @ResolveField(() => String, { nullable: true })
  @ForwardAuthCookies()
  forwarded(@CurrentPrincipal() principal: AuthPrincipal | null) {
    this.sideEffects++;
    return principal?.userId ?? "anonymous";
  }
}
function replyWithRequest(reply: unknown, request: unknown): object {
  return reply !== null && typeof reply === "object"
    ? new Proxy(reply, {
        get(target, key) {
          return key === "request" ? request : Reflect.get(target, key, target);
        },
      })
    : { request };
}
async function securityFixture(
  driver: "apollo" | "mercurius" | "apollo-fastify",
  options: {
    context?: unknown;
    guards?: boolean;
    filters?: boolean;
    interceptors?: boolean;
    outage?: boolean;
  } = {},
) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    apikey: [],
  };
  const memory = memoryAdapter(database);
  let reads = 0;
  let outage = false;
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: "http://localhost:3000",
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    advanced: { disableOriginCheck: false },
    session: { updateAge: 1 },
    database: (config: Parameters<typeof memory>[0]) => {
      const adapter = memory(config);
      return {
        ...adapter,
        findOne: async (input: Parameters<typeof adapter.findOne>[0]) => {
          if (input.model === "session") {
            reads++;
            if (outage) {
              throw new Error("credential-database-private-detail");
            }
          }
          return adapter.findOne(input);
        },
      };
    },
    plugins: [apiKey(), nestjs()],
  });
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const logger: LoggerService = {
    log: () => {},
    error: (error: unknown) => {
      errors.push(error);
    },
    warn: (...message: unknown[]) => {
      warnings.push(message.map(String).join(" "));
    },
    debug: () => {},
    verbose: () => {},
  };
  const f = await startHttpFixture({
    auth,
    adapter: driver === "apollo" ? new ExpressAdapter() : new FastifyAdapter(),
    platform: driver === "apollo" ? expressPlatform() : fastifyPlatform(),
    transports: [
      driver === "mercurius" ? mercuriusTransport() : apolloTransport(),
    ],
    principals: [apiKeyPrincipal()],
    controllers: [],
    imports: [
      GraphQLModule.forRoot({
        driver: driver === "mercurius" ? MercuriusDriver : ApolloDriver,
        autoSchemaFile: true,
        fieldResolverEnhancers:
          options.guards === false
            ? []
            : [
                "guards",
                ...(options.interceptors === false ? [] : ["interceptors"]),
                ...(options.filters === false ? [] : ["filters"]),
              ],
        ...(options.context === undefined ? {} : { context: options.context }),
      }),
    ],
    providers: [SecurityResolver],
    moduleOptions: { logSummary: false },
    configure: (app) => {
      app.useLogger(logger);
    },
  });
  try {
    const signup = await auth.api.signUpEmail({
      body: {
        name: "Security Owner",
        email: `${crypto.randomUUID()}@example.com`,
        password: "password-secure-123",
      },
      returnHeaders: true,
    });
    const cookie = signup.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    database.session[0]!.updatedAt = new Date(Date.now() - 60_000);
    database.session[0]!.expiresAt = new Date(
      new Date(String(database.session[0]!.expiresAt)).getTime() - 60_000,
    );
    reads = 0;
    outage = options.outage ?? false;
    return {
      ...f,
      auth,
      cookie,
      userId: signup.response.user.id,
      reads: () => reads,
      errors,
      warnings,
      resolver: f.app.get(SecurityResolver),
      async query(query: string, headers: Record<string, string> = {}) {
        const response = await fetch(`${f.url}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ query }),
        });
        return { response, body: await response.json() };
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
describe.each(["apollo", "mercurius", "apollo-fastify"] as const)(
  "native %s GraphQL security",
  (driver) => {
    it("keeps inherited public fields anonymous despite resolver-class authentication", async () => {
      const f = await securityFixture(driver);
      try {
        const { body } = await f.query("{ publicRows { value } }");
        expect(body).toEqual({
          data: {
            publicRows: [{ value: "anonymous" }, { value: "anonymous" }],
          },
        });
        expect(f.reads()).toBe(0);
      } finally {
        await f.close();
      }
    });
    it("runs form CSRF before inherited fields without principal I/O", async () => {
      const f = await securityFixture(driver);
      try {
        const denied = await f.query("{ publicRows { forwarded } }", {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site",
        });
        expect(denied.body.errors).toHaveLength(2);
        expect(denied.body.errors[0].extensions).toMatchObject({
          code: "FORBIDDEN",
          statusCode: 403,
        });
        expect(f.resolver.sideEffects).toBe(0);
        expect(f.reads()).toBe(0);
        const allowed = await f.query("{ publicRows { forwarded } }", {
          origin: "http://localhost:3000",
        });
        expect(allowed.body.data.publicRows).toEqual([
          { forwarded: "anonymous" },
          { forwarded: "anonymous" },
        ]);
        expect(f.reads()).toBe(0);
      } finally {
        await f.close();
      }
    });
    it("requires guards for inherited form forwarding at boot", async () => {
      await expect(securityFixture(driver, { guards: false })).rejects.toThrow(
        "FIELD_RESOLVER_UNGUARDED",
      );
    });
    it("keeps HTTP 200 denial extensions and native response cookie forwarding", async () => {
      const f = await securityFixture(driver);
      try {
        const denied = await f.query("{ guarded }");
        expect(denied.response.status).toBe(200);
        expect(denied.body.errors[0].extensions).toMatchObject({
          code: "UNAUTHENTICATED",
          statusCode: 401,
        });
        expect(f.errors).toHaveLength(0);
        const accepted = await f.query("{ guarded }", { cookie: f.cookie });
        expect(accepted.body).toEqual({ data: { guarded: "guarded" } });
        expect(accepted.response.headers.getSetCookie().length).toBeGreaterThan(
          0,
        );
      } finally {
        await f.close();
      }
    });
    it("denies cross-origin cookie mutations before session reads or resolver effects", async () => {
      const f = await securityFixture(driver);
      try {
        const { response, body } = await f.query("mutation { change }", {
          cookie: f.cookie,
          origin: "https://evil.example",
        });
        expect(response.status).toBe(200);
        expect(body.errors[0].extensions).toMatchObject({
          code: "FORBIDDEN",
          statusCode: 403,
        });
        expect(f.reads()).toBe(0);
        expect(f.resolver.sideEffects).toBe(0);
      } finally {
        await f.close();
      }
    });
    it("logs a shared infrastructure failure once across twenty aliases", async () => {
      const f = await securityFixture(driver, { outage: true });
      try {
        const { body, response } = await f.query(
          `{ ${Array.from({ length: 20 }, (_, index) => `a${index}: guarded`).join(" ")} }`,
          { cookie: f.cookie },
        );
        expect(response.status).toBe(200);
        expect(body.errors).toHaveLength(20);
        for (const error of body.errors) {
          expect(error).toMatchObject({
            message: "Internal server error",
            extensions: { reason: "AUTH_UNAVAILABLE", statusCode: 500 },
          });
        }
        expect(JSON.stringify(body)).not.toContain(
          "credential-database-private-detail",
        );
        expect(f.errors).toHaveLength(1);
        expect(f.reads()).toBe(1);
        expect(f.resolver.sideEffects).toBe(0);
      } finally {
        await f.close();
      }
    });
    it.each([false, true])(
      "logs wrong-kind inherited readers once across twenty list items (interceptors=%s)",
      async (interceptors) => {
        const f = await securityFixture(driver, { interceptors });
        try {
          const key = await f.auth.api.createApiKey({
            body: { userId: f.userId },
          });
          const { body, response } = await f.query("{ keyRows { session } }", {
            "x-api-key": key.key,
          });
          expect(response.status).toBe(200);
          expect(body.errors).toHaveLength(20);
          expect(body.data.keyRows).toEqual(
            Array.from({ length: 20 }, () => ({ session: null })),
          );
          expect(
            body.errors.every(
              (error: { message: string }) =>
                error.message === "Authentication is misconfigured",
            ),
          ).toBe(true);
          expect(f.errors).toHaveLength(1);
          expect(
            f.warnings.some((warning) =>
              warning.includes("W_NESTED_PRINCIPAL_PARAM"),
            ),
          ).toBe(true);
        } finally {
          await f.close();
        }
      },
    );
    it("denies nested reader errors safely and warns when the host disables field filters", async () => {
      const f = await securityFixture(driver, { filters: false });
      try {
        const key = await f.auth.api.createApiKey({
          body: { userId: f.userId },
        });
        const { body } = await f.query("{ keyRows { session } }", {
          "x-api-key": key.key,
        });
        expect(body.errors).toHaveLength(20);
        expect(f.errors).toHaveLength(0);
        expect(
          f.warnings.some((warning) =>
            warning.includes("W_FIELD_EXCEPTION_FILTERS_DISABLED"),
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    });
    it("rejects a static context object at boot", async () => {
      await expect(
        securityFixture(driver, { context: { req: {} } }),
      ).rejects.toThrow("GRAPHQL_STATIC_CONTEXT");
    });
    it("allows harmless public unknown contexts while direct auth and guarded work fail closed", async () => {
      const f = await securityFixture(driver, {
        context: (_request: unknown, reply: unknown) => ({
          req: { headers: {} },
          get reply() {
            return replyWithRequest(reply, { raw: { method: "POST" } });
          },
          set reply(_reply: unknown) {},
        }),
      });
      try {
        const { body } = await f.query("{ harmless direct guarded }");
        expect(body.data, JSON.stringify(body)).toEqual({
          harmless: "harmless",
          direct: null,
          guarded: null,
        });
        expect(body.errors).toHaveLength(2);
        expect(
          body.errors.map((error: { message: string }) => error.message).sort(),
        ).toEqual(
          [
            "An error occurred during hook matcher execution. Check the logs for more details.",
            "Internal server error",
          ].sort(),
        );
        expect(f.reads()).toBe(0);
        expect(f.resolver.sideEffects).toBe(0);
      } finally {
        await f.close();
      }
    });
    it("rejects a context function retaining a completed request", async () => {
      let context: object | undefined;
      const f = await securityFixture(driver, {
        context: (input: unknown, reply: unknown) => {
          const req =
            driver === "apollo" ? (input as { req: unknown }).req : input;
          context ??= {
            req,
            get reply() {
              return replyWithRequest(reply, req);
            },
            set reply(_reply: unknown) {},
          };
          return context;
        },
      });
      try {
        expect(
          (await f.query("{ guarded }", { cookie: f.cookie })).body.data,
        ).toEqual({ guarded: "guarded" });
        const second = await f.query("{ guarded }");
        expect(
          second.body.errors?.[0],
          JSON.stringify(second.body),
        ).toMatchObject({
          message: "Internal server error",
          extensions: { reason: "AUTH_MISCONFIGURED" },
        });
        expect(f.resolver.sideEffects).toBe(1);
        expect(f.reads()).toBe(1);
      } finally {
        await f.close();
      }
    });
  },
);

import type { PrincipalSource } from "./auth-contracts.js";
import { sessionPrincipal } from "./session-principal.js";

@ObjectType()
class Branch {
  @Field(() => String, { nullable: true }) reader!: string;
  @Field(() => Branch, { nullable: true }) publicNested!: Branch;
  @Field(() => Branch, { nullable: true }) guardedNested!: Branch;
}
@Resolver(() => Branch)
class BranchResolver {
  @Query(() => Branch)
  sessionOnly() {
    return {};
  }

  @Query(() => Branch)
  @AcceptPrincipals("session", "api-key")
  mixed() {
    return {};
  }

  @Query(() => Branch)
  @Public()
  publicBranch() {
    return {};
  }

  @ResolveField(() => String, { nullable: true })
  reader(@CurrentPrincipal() principal: AuthPrincipal | null) {
    return principal?.userId ?? null;
  }

  @ResolveField(() => Branch)
  @Public()
  publicNested() {
    return {};
  }
}
@Resolver(() => Branch)
class GuardedBranchResolver {
  @ResolveField(() => Branch)
  @RequireAuth()
  guardedNested() {
    return {};
  }
}
function delayedSource(
  source: PrincipalSource,
  delay: number,
): PrincipalSource {
  return {
    ...source,
    async resolve(request) {
      if (delay) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      return source.resolve(request);
    },
  };
}
describe.each(["apollo", "mercurius"] as const)(
  "native %s mixed lineage",
  (driver) => {
    for (const guards of [false, true]) {
      for (const sessionFirst of [false, true]) {
        for (const forwarding of [false, true]) {
          it(`keeps sibling and public-nested readings isolated (guards=${guards}, sessionFirst=${sessionFirst}, forwarding=${forwarding})`, async () => {
            const database: Record<string, Record<string, unknown>[]> = {
              user: [],
              session: [],
              account: [],
              verification: [],
              apikey: [],
            };
            const auth = betterAuth({
              secret: crypto.randomUUID() + crypto.randomUUID(),
              baseURL: "http://localhost:3000",
              logger: { disabled: true },
              emailAndPassword: { enabled: true },
              advanced: { disableOriginCheck: false },
              database: memoryAdapter(database),
              plugins: [apiKey(), nestjs()],
            });
            const f = await startHttpFixture({
              auth,
              adapter:
                driver === "apollo"
                  ? new ExpressAdapter()
                  : new FastifyAdapter(),
              platform:
                driver === "apollo" ? expressPlatform() : fastifyPlatform(),
              transports: [
                driver === "apollo"
                  ? apolloTransport({
                      fieldResolverCoverage: forwarding ? "warn" : "error",
                    })
                  : mercuriusTransport({
                      fieldResolverCoverage: forwarding ? "warn" : "error",
                    }),
              ],
              principals: [
                delayedSource(apiKeyPrincipal(), sessionFirst ? 20 : 0),
                delayedSource(sessionPrincipal(), sessionFirst ? 0 : 20),
              ],
              moduleOptions: {
                session: false,
                logSummary: false,
                cookies: { forwardDirectCalls: forwarding },
              },
              controllers: [],
              providers: [
                BranchResolver,
                ...(guards ? [GuardedBranchResolver] : []),
              ],
              imports: [
                GraphQLModule.forRoot({
                  driver: driver === "apollo" ? ApolloDriver : MercuriusDriver,
                  autoSchemaFile: true,
                  fieldResolverEnhancers: guards
                    ? ["guards", "interceptors", "filters"]
                    : [],
                }),
              ],
              configure: (app) => {
                app.useLogger(false);
              },
            });
            try {
              const y = await auth.api.signUpEmail({
                body: {
                  name: "Y",
                  email: `${crypto.randomUUID()}@example.com`,
                  password: "password-secure-123",
                },
                returnHeaders: true,
              });
              const x = await auth.api.signUpEmail({
                body: {
                  name: "X",
                  email: `${crypto.randomUUID()}@example.com`,
                  password: "password-secure-123",
                },
              });
              const key = await auth.api.createApiKey({
                body: { userId: x.user.id },
              });
              const cookie = y.headers
                .getSetCookie()
                .map((line) => line.split(";")[0])
                .join("; ");
              const query = `{ sessionOnly { reader publicNested { reader } } mixed { reader ${guards ? "guardedNested { reader }" : ""} } publicBranch { reader } }`;
              const response = await fetch(`${f.url}/graphql`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  cookie,
                  "x-api-key": key.key,
                  origin: "http://localhost:3000",
                },
                body: JSON.stringify({ query }),
              });
              expect(await response.json()).toEqual({
                data: {
                  sessionOnly: {
                    reader: y.response.user.id,
                    publicNested: { reader: y.response.user.id },
                  },
                  mixed: {
                    reader: x.user.id,
                    ...(guards
                      ? { guardedNested: { reader: y.response.user.id } }
                      : {}),
                  },
                  publicBranch: { reader: null },
                },
              });
            } finally {
              await f.close();
            }
          });
        }
      }
    }
  },
);

import { UseAuthInstance } from "./auth-decorators.js";
@ObjectType()
class CrossInstanceRow {
  @Field(() => String, { nullable: true }) reader!: string;
  @Field(() => String, { nullable: true }) sessionReader!: string;
}
@Resolver(() => CrossInstanceRow)
class CrossInstanceResolver {
  @Query(() => CrossInstanceRow)
  ordinaryInstance() {
    return {};
  }

  @Query(() => CrossInstanceRow)
  @UseAuthInstance("secondary")
  @AcceptPrincipals("api-key")
  secondaryInstance() {
    return {};
  }

  @ResolveField(() => String, { nullable: true })
  reader(@CurrentPrincipal() principal: AuthPrincipal | null) {
    return principal?.userId;
  }

  @ResolveField(() => String, { nullable: true })
  sessionReader(@CurrentSession() session: AuthSession | null) {
    return session?.user.id;
  }
}
describe.each(["apollo", "mercurius"] as const)(
  "native %s cross-instance lineage",
  (driver) => {
    it("inherits the enclosing instance and warns about kinds across the entire schema", async () => {
      const database = () => ({
        user: [],
        session: [],
        account: [],
        verification: [],
        apikey: [],
      });
      const primary = betterAuth({
        secret: crypto.randomUUID() + crypto.randomUUID(),
        baseURL: "http://localhost:3000",
        logger: { disabled: true },
        emailAndPassword: { enabled: true },
        advanced: { disableOriginCheck: false },
        database: memoryAdapter(database()),
        plugins: [nestjs()],
      });
      const secondary = betterAuth({
        secret: crypto.randomUUID() + crypto.randomUUID(),
        baseURL: "http://localhost:3000",
        logger: { disabled: true },
        emailAndPassword: { enabled: true },
        advanced: { disableOriginCheck: false, cookiePrefix: "secondary" },
        database: memoryAdapter(database()),
        plugins: [apiKey(), nestjs()],
      });
      const warnings: string[] = [];
      const f = await startHttpFixture({
        auth: primary,
        adapter:
          driver === "apollo" ? new ExpressAdapter() : new FastifyAdapter(),
        platform: driver === "apollo" ? expressPlatform() : fastifyPlatform(),
        transports: [
          driver === "apollo" ? apolloTransport() : mercuriusTransport(),
        ],
        controllers: [],
        providers: [CrossInstanceResolver],
        moduleOptions: { logSummary: false },
        imports: [
          BetterAuthModule.forRoot({
            name: "secondary",
            auth: secondary,
            session: false,
            principals: [apiKeyPrincipal()],
            http: { mount: false },
            logSummary: false,
          }),
          GraphQLModule.forRoot({
            driver: driver === "apollo" ? ApolloDriver : MercuriusDriver,
            autoSchemaFile: true,
            fieldResolverEnhancers: ["guards", "interceptors", "filters"],
          }),
        ],
        configure: (app) => {
          app.useLogger({
            log: () => {},
            error: () => {},
            warn: (...values: unknown[]) => {
              warnings.push(values.map(String).join(" "));
            },
          });
        },
      });
      try {
        const signUp = {
          name: "Owner",
          email: `${crypto.randomUUID()}@example.com`,
          password: "password-secure-123",
        };
        const y = await primary.api.signUpEmail({
          body: signUp,
          returnHeaders: true,
        });
        const x = await secondary.api.signUpEmail({ body: signUp });
        const key = await secondary.api.createApiKey({
          body: { userId: x.user.id },
        });
        const cookie = y.headers
          .getSetCookie()
          .map((line) => line.split(";")[0])
          .join("; ");
        const response = await fetch(`${f.url}/graphql`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie,
            "x-api-key": key.key,
          },
          body: JSON.stringify({
            query:
              "{ ordinaryInstance { reader } secondaryInstance { reader } }",
          }),
        });
        expect(await response.json()).toEqual({
          data: {
            ordinaryInstance: { reader: y.response.user.id },
            secondaryInstance: { reader: x.user.id },
          },
        });
        expect(
          warnings.some(
            (warning) =>
              warning.includes("W_NESTED_PRINCIPAL_PARAM") &&
              warning.includes("CrossInstanceResolver.sessionReader"),
          ),
        ).toBe(true);
      } finally {
        await f.close();
      }
    });
  },
);
