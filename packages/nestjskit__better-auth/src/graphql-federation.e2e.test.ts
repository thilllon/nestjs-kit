import { inspect } from "node:util";
import { ApolloFederationDriver } from "@nestjs/apollo";
import { MercuriusFederationDriver } from "@nestjs/mercurius";
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
  type LoggerService,
} from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import {
  Directive,
  Field,
  GraphQLModule,
  Info,
  ObjectType,
  Parent,
  Query,
  ResolveField,
  ResolveReference,
  Resolver,
} from "@nestjs/graphql";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { organization } from "better-auth/plugins";
import type { GraphQLResolveInfo } from "graphql";
import { describe, expect, it } from "vitest";
import { CurrentPrincipal, Public, RequireAuth } from "./auth-decorators.js";
import type { AuthPrincipal } from "./auth-types.js";
import { expressPlatform } from "./express.js";
import { fastifyPlatform } from "./fastify.js";
import { apolloTransport, mercuriusTransport } from "./graphql.js";
import { fromParam, RequireOrgPermission } from "./organization.js";
import { nestjs } from "./plugin.js";
import { startHttpFixture } from "./test-fixtures.js";

@ObjectType()
@Directive('@key(fields: "id")')
class SecuredEntity {
  @Field(() => String) id!: string;
  @Field(() => String, { nullable: true }) owner!: string;
}
@ObjectType()
@Directive('@key(fields: "id")')
class OrphanEntity {
  @Field(() => String) id!: string;
  @Field(() => String, { nullable: true }) secret!: string;
}
@Injectable()
class CounterGuard implements CanActivate {
  calls = 0;
  canActivate(_context: ExecutionContext) {
    this.calls++;
    return true;
  }
}
@Resolver(() => SecuredEntity)
@RequireOrgPermission(
  { member: ["create"] },
  { organization: fromParam("orgId") },
)
class EntityResolver {
  infos: GraphQLResolveInfo[] = [];
  @Query(() => SecuredEntity)
  @Public()
  entity() {
    return { id: "public" };
  }

  @ResolveReference()
  @RequireAuth({ authoritative: true })
  reference(
    @Parent() representation: { id: string },
    @Info() info: GraphQLResolveInfo,
  ) {
    this.infos.push(info);
    return representation;
  }

  @ResolveField(() => String, { nullable: true })
  owner(@CurrentPrincipal() principal: AuthPrincipal | null) {
    return principal?.userId ?? "anonymous";
  }
}
@Resolver(() => OrphanEntity)
class OrphanResolver {
  @Query(() => OrphanEntity)
  @Public()
  orphan() {
    return { id: "public" };
  }

  @ResolveField(() => String, { nullable: true })
  secret() {
    return "must not leak";
  }
}
const logger = (logs: string[]): LoggerService => ({
  log: (...messages: unknown[]) =>
    logs.push(messages.map((value) => inspect(value)).join(" ")),
  error: (...messages: unknown[]) =>
    logs.push(messages.map((value) => inspect(value)).join(" ")),
  warn: (...messages: unknown[]) =>
    logs.push(messages.map((value) => inspect(value)).join(" ")),
  debug: () => {},
  verbose: () => {},
});
type SchemaMode = "schema-first" | 1 | 2;
async function fixture(
  driver: "apollo" | "mercurius",
  guards = true,
  schema: SchemaMode = "schema-first",
) {
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
    session: { cookieCache: { enabled: true } },
    advanced: { disableOriginCheck: false },
    database: memoryAdapter(database),
    plugins: [organization(), nestjs()],
  });
  const logs: string[] = [];
  const f = await startHttpFixture({
    auth,
    adapter: driver === "apollo" ? new ExpressAdapter() : new FastifyAdapter(),
    platform: driver === "apollo" ? expressPlatform() : fastifyPlatform(),
    transports: [
      driver === "apollo" ? apolloTransport() : mercuriusTransport(),
    ],
    controllers: [],
    imports: [
      GraphQLModule.forRoot({
        driver:
          driver === "apollo"
            ? ApolloFederationDriver
            : MercuriusFederationDriver,
        ...(schema === "schema-first"
          ? {
              typeDefs: `
                extend schema @link(url: "https://specs.apollo.dev/federation/v2.3", import: ["@key"])
                type SecuredEntity @key(fields: "id") { id: String!, owner: String }
                type OrphanEntity @key(fields: "id") { id: String!, secret: String }
                type Query { entity: SecuredEntity!, orphan: OrphanEntity! }
              `,
            }
          : { autoSchemaFile: { federation: schema } }),
        fieldResolverEnhancers: guards
          ? ["guards", "interceptors", "filters"]
          : [],
      }),
    ],
    providers: [
      EntityResolver,
      OrphanResolver,
      CounterGuard,
      { provide: APP_GUARD, useExisting: CounterGuard },
    ],
    moduleOptions: { logSummary: false },
    configure: (app) => {
      app.useLogger(logger(logs));
    },
  });
  try {
    const signup = await auth.api.signUpEmail({
      body: {
        name: "Entity Owner",
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
      id: "member-a",
      organizationId: "A",
      userId: signup.response.user.id,
      role: "owner",
      createdAt: new Date(),
    });
    return {
      ...f,
      logs,
      userId: signup.response.user.id,
      async query(query: string) {
        const response = await fetch(`${f.url}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ query }),
        });
        expect(response.status).toBe(200);
        return response.json();
      },
    };
  } catch (error) {
    await f.close();
    throw error;
  }
}
describe.each([
  ["apollo", "schema-first"],
  ["mercurius", "schema-first"],
  ["apollo", 1],
  ["apollo", 2],
  ["mercurius", 1],
  ["mercurius", 2],
] as const)("native %s federation (schema mode %s)", (driver, schema) => {
  it("authorizes each representation separately even when the driver shares info", async () => {
    const f = await fixture(driver, true, schema);
    try {
      const service = await f.query("{ _service { sdl } }");
      expect(service.errors).toBeUndefined();
      expect(service.data._service.sdl).toContain("type SecuredEntity");
      expect(service.data._service.sdl).toContain('@key(fields: "id")');
      const body = await f.query(
        '{ _entities(representations: [{__typename:"SecuredEntity",id:"1",orgId:"A"},{__typename:"SecuredEntity",id:"2",orgId:"B"}]) { ... on SecuredEntity { id owner } } }',
      );
      expect(body.data._entities).toEqual([{ id: "1", owner: f.userId }, null]);
      expect(body.errors[0].extensions.code).toBe("FORBIDDEN");
      const aliased = await f.query(
        '{ items: _entities(representations: [{__typename:"SecuredEntity",id:"1",orgId:"A"}]) { ... on SecuredEntity { owner } } }',
      );
      expect(aliased.data.items).toEqual([{ owner: f.userId }]);

      const both = await f.query(
        '{ _entities(representations: [{__typename:"SecuredEntity",id:"1",orgId:"A"},{__typename:"SecuredEntity",id:"2",orgId:"A"}]) { ... on SecuredEntity { id owner } } }',
      );
      expect(both.data._entities).toEqual([
        { id: "1", owner: f.userId },
        { id: "2", owner: f.userId },
      ]);
      expect(
        f.logs.some(
          (line) =>
            line.includes("I_CLASS_METADATA_OPERATIONS_ONLY") &&
            line.includes("reference"),
        ),
      ).toBe(true);
      expect(f.logs.some((line) => line.includes("W_ORG_PARAM_MISSING"))).toBe(
        true,
      );
      const infos = f.app.get(EntityResolver).infos;
      expect(infos.at(-1)).toBe(infos.at(-2));
      expect(
        f.logs.some(
          (line) =>
            line.includes("W_FIELD_GUARDS_MULTIPLY_GLOBAL_ENHANCERS") &&
            line.includes("CounterGuard"),
        ),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("rejects entity field inheritance without a guarded reference entry point", async () => {
    const f = await fixture(driver, true, schema);
    try {
      const result = await f.query(
        '{ _entities(representations: [{__typename:"OrphanEntity",id:"1"}]) { ... on OrphanEntity { id secret } } }',
      );
      expect(result.data._entities[0]).toEqual({ id: "1", secret: null });
      expect(result.errors[0]).toMatchObject({
        message: "Internal server error",
        extensions: { reason: "AUTH_MISCONFIGURED", statusCode: 500 },
      });
      expect(
        f.logs.some((line) => line.includes("NO_ENCLOSING_DECISION")),
        f.logs.join("\n"),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("requires field guard coverage before exposing a subgraph", async () => {
    await expect(fixture(driver, false, schema)).rejects.toMatchObject({
      message: expect.stringContaining("FEDERATION_FIELD_GUARDS_REQUIRED"),
    });
  });
  it("measures all global guards on inherited public fields", async () => {
    const f = await fixture(driver, true, schema);
    try {
      const counter = f.app.get(CounterGuard);
      counter.calls = 0;
      expect(
        (await f.query("{ a: entity { owner } b: entity { owner } }")).data,
      ).toEqual({ a: { owner: "anonymous" }, b: { owner: "anonymous" } });
      expect(counter.calls).toBe(4);
    } finally {
      await f.close();
    }
  });
});
