import { inspect } from "node:util";
import { ApolloDriver } from "@nestjs/apollo";
import { MercuriusDriver } from "@nestjs/mercurius";
import {
  GraphQLModule,
  Mutation,
  Query,
  Resolver,
  Subscription,
} from "@nestjs/graphql";
import { ExpressAdapter } from "@nestjs/platform-express";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { memoryAdapter } from "better-auth/adapters/memory";
import { bearer } from "better-auth/plugins";
import { createClient, type Client } from "graphql-ws";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import { BetterAuthModule } from "./auth-module.js";
import {
  CurrentPrincipal,
  OptionalAuth,
  Public,
  RequireAuth,
} from "./auth-decorators.js";
import type { AuthPrincipal } from "./auth-types.js";
import { expressPlatform } from "./express.js";
import { fastifyPlatform } from "./fastify.js";
import {
  apolloTransport,
  mercuriusTransport,
  mercuriusSubscriptionContext,
  type GraphqlTransportOptions,
} from "./graphql.js";
import { nestjs } from "./plugin.js";

@Resolver()
class SocketResolver {
  calls = 0;

  @Query(() => String, { nullable: true })
  @OptionalAuth()
  optionalWho(@CurrentPrincipal() principal: AuthPrincipal | null) {
    this.calls++;
    return principal?.userId ?? "anonymous";
  }

  @Query(() => String)
  @Public()
  harmless() {
    return "public";
  }

  @Query(() => String, { nullable: true })
  who(@CurrentPrincipal() principal: AuthPrincipal) {
    this.calls++;
    return principal.userId;
  }

  @Query(() => String, { nullable: true })
  @RequireAuth({ authoritative: true })
  authoritative(@CurrentPrincipal() principal: AuthPrincipal) {
    return principal.userId;
  }

  @Mutation(() => String, { nullable: true })
  change(@CurrentPrincipal() principal: AuthPrincipal) {
    return principal.userId;
  }

  @Subscription(() => String, { nullable: true })
  async *notice(@CurrentPrincipal() principal: AuthPrincipal) {
    yield { notice: principal.userId };
  }
}
type Mode =
  | "apollo-default"
  | "apollo-custom"
  | "mercurius"
  | "mercurius-native";
interface Result {
  data?: Record<string, unknown> | null;
  errors?: readonly {
    message: string;
    extensions?: Readonly<Record<string, unknown>>;
  }[];
}
function execute(client: Client, query: string): Promise<Result> {
  return new Promise((resolve, reject) => {
    let result: Result | undefined;
    let dispose = () => {};
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error("GraphQL socket operation timed out"));
    }, 5000);
    dispose = client.subscribe(
      { query },
      {
        next(value) {
          result = value;
          clearTimeout(timeout);
          resolve(value);
          queueMicrotask(() => dispose());
        },
        error(error) {
          clearTimeout(timeout);
          if (Array.isArray(error)) {
            resolve({ errors: error });
          } else {
            reject(error);
          }
        },
        complete() {
          clearTimeout(timeout);
          if (result) {
            resolve(result);
          } else {
            reject(new Error("GraphQL operation completed without a result"));
          }
        },
      },
    );
  });
}
async function fixture(
  mode: Mode,
  transportOptions: GraphqlTransportOptions = {},
  dynamicBaseURL = false,
) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  let reads = 0;
  let sessionCalls = 0;
  const memory = memoryAdapter(database);
  const auth = betterAuth({
    secret: crypto.randomUUID() + crypto.randomUUID(),
    baseURL: dynamicBaseURL
      ? {
          allowedHosts: ["localhost:3000", "127.0.0.1:*", "edge.example.test"],
          protocol: "http",
        }
      : "http://localhost:3000",
    trustedOrigins: ["http://localhost:3000"],
    advanced: { disableOriginCheck: false },
    logger: { disabled: true },
    emailAndPassword: { enabled: true },
    session: { updateAge: 1 },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path === "/get-session") {
          sessionCalls++;
        }
      }),
    },
    database: (options: Parameters<typeof memory>[0]) => {
      const adapter = memory(options);
      return {
        ...adapter,
        findOne: async (input: Parameters<typeof adapter.findOne>[0]) => {
          if (input.model === "session") {
            reads++;
          }
          return adapter.findOne(input);
        },
      };
    },
    plugins: [bearer(), nestjs()],
  });
  const mercurius = mode.startsWith("mercurius");
  const module = await Test.createTestingModule({
    imports: [
      GraphQLModule.forRoot({
        driver: mercurius ? MercuriusDriver : ApolloDriver,
        autoSchemaFile: true,
        ...(mercurius
          ? {
              subscription: {
                fullWsTransport: true,
                ...(mode === "mercurius"
                  ? { context: mercuriusSubscriptionContext() }
                  : {}),
              },
            }
          : { subscriptions: { "graphql-ws": true } }),
        ...(mode === "apollo-custom"
          ? {
              context: (context: {
                req?: unknown;
                extra?: { request?: unknown };
                connectionParams?: unknown;
              }) => ({
                req: context.req ?? context.extra?.request,
                connectionParams: context.connectionParams,
              }),
            }
          : {}),
      }),
      BetterAuthModule.forRoot({
        auth,
        logSummary: false,
        platforms: [mercurius ? fastifyPlatform() : expressPlatform()],
        transports: [
          mercurius
            ? mercuriusTransport(transportOptions)
            : apolloTransport(transportOptions),
        ],
      }),
    ],
    providers: [SocketResolver],
  }).compile();
  const errors: unknown[][] = [];
  const app = module.createNestApplication(
    mercurius ? new FastifyAdapter() : new ExpressAdapter(),
    {
      logger: {
        log() {},
        warn() {},
        error(...args: unknown[]) {
          errors.push(args);
        },
      },
    },
  );
  const clients: Client[] = [];
  try {
    await app.listen(0, "127.0.0.1");
    const signup = await auth.api.signUpEmail({
      headers: new Headers({ host: "localhost:3000" }),
      body: {
        name: "Socket Owner",
        email: `${crypto.randomUUID()}@example.com`,
        password: "password-secure-123",
      },
      returnHeaders: true,
    });
    const cookie = signup.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
    const oldUpdatedAt = new Date(Date.now() - 60_000);
    database.session[0]!.updatedAt = oldUpdatedAt;
    database.session[0]!.expiresAt = new Date(
      new Date(String(database.session[0]!.expiresAt)).getTime() - 60_000,
    );
    reads = 0;
    sessionCalls = 0;
    return {
      userId: signup.response.user.id,
      cookie,
      bearer: `Bearer ${signup.response.token}`,
      errors,
      calls: () => module.get(SocketResolver).calls,
      database,
      oldUpdatedAt,
      reads: () => reads,
      sessionCalls: () => sessionCalls,
      client(
        headers: Record<string, string>,
        connectionParams: Record<string, unknown> = {},
      ) {
        class HeaderSocket extends WebSocket {
          constructor(address: string | URL, protocols?: string | string[]) {
            super(address, protocols, { headers });
          }
        }
        const client = createClient({
          url: `${String(app.getHttpServer().address().address === "127.0.0.1" ? "ws://127.0.0.1" : "ws://localhost")}:${app.getHttpServer().address().port}/graphql`,
          webSocketImpl: HeaderSocket,
          connectionParams,
          retryAttempts: 0,
        });
        clients.push(client);
        return client;
      },
      async close() {
        await Promise.all(clients.map((client) => client.dispose()));
        await app.close();
      },
    };
  } catch (error) {
    await app.close();
    throw error;
  }
}
describe.each([
  "apollo-default",
  "apollo-custom",
  "mercurius",
  "mercurius-native",
] as const)("native %s socket operations", (mode) => {
  describe.each(["default", "override"] as const)(
    "%s credential conversion",
    (mapping) => {
      it.each(["authorization", "cookie"] as const)(
        "rejects malformed %s without fallback, disclosure or authentication work",
        async (name) => {
          const marker = `SYNTHETIC_${mode}_${mapping}_${name}_PRIVATE`;
          const malformed = `${marker}\r\nInjected: value`;
          let replacement: Record<string, string> = {};
          let mappings = 0;
          const f = await fixture(
            mode,
            mapping === "override"
              ? {
                  subscriptionCredentials: () => {
                    mappings++;
                    return replacement;
                  },
                }
              : {},
          );
          try {
            const fallback: Record<string, string> =
              name === "authorization"
                ? { cookie: f.cookie }
                : { authorization: f.bearer };
            replacement = { ...fallback, [name]: malformed };
            const client = f.client(
              { ...fallback, origin: "http://localhost:3000" },
              mapping === "default" ? { [name]: malformed } : {},
            );
            expect(await execute(client, "{ harmless }")).toEqual({
              data: { harmless: "public" },
            });
            expect(mappings).toBe(0);
            expect(f.reads()).toBe(0);
            const result = await execute(
              client,
              "{ a: who b: who c: optionalWho d: optionalWho }",
            );
            // Unbounded inspection reaches nested GraphQL error messages and extensions.
            expect(
              inspect([result, f.errors], {
                depth: Infinity,
                maxArrayLength: Infinity,
                maxStringLength: Infinity,
              }),
            ).not.toContain(marker);
            expect(result.errors).toHaveLength(4);
            for (const error of result.errors ?? []) {
              expect(error.extensions).toMatchObject({
                code: "UNAUTHENTICATED",
                statusCode: 401,
                reason: "MALFORMED_CREDENTIALS",
              });
            }
            expect(result.data).toEqual({ a: null, b: null, c: null, d: null });
            expect(f.errors).toEqual([]);
            expect(f.reads()).toBe(0);
            expect(f.calls()).toBe(0);
            expect(f.sessionCalls()).toBe(0);
            // Prove the alternate credential really authenticates if presented alone.
            replacement = fallback;
            expect(
              await execute(
                f.client({ ...fallback, origin: "http://localhost:3000" }),
                "{ who }",
              ),
            ).toEqual({ data: { who: f.userId } });
            expect(f.reads()).toBe(1);
            expect(f.calls()).toBe(1);
            expect(f.sessionCalls()).toBe(1);
          } finally {
            await f.close();
          }
        },
      );
    },
  );
  it("authenticates queries, mutations and subscriptions independently and never refreshes", async () => {
    const f = await fixture(mode);
    try {
      const client = f.client({
        cookie: f.cookie,
        origin: "http://localhost:3000",
      });
      expect(await execute(client, "{ a: who b: who }")).toEqual({
        data: { a: f.userId, b: f.userId },
      });
      expect(f.reads()).toBe(1);
      expect(await execute(client, "mutation { change }")).toEqual({
        data: { change: f.userId },
      });
      expect(await execute(client, "subscription { notice }")).toEqual({
        data: { notice: f.userId },
      });
      expect(f.reads()).toBe(3);
      expect(f.database.session[0]!.updatedAt).toEqual(f.oldUpdatedAt);
    } finally {
      await f.close();
    }
  });
  it("checks the untouched ambient cookie origin on every operation before session I/O", async () => {
    const f = await fixture(mode);
    try {
      const client = f.client(
        { cookie: f.cookie, origin: "https://evil.example" },
        {
          cookie: "junk",
          authorization: "junk",
          origin: "http://localhost:3000",
        },
      );
      for (const query of [
        "{ who }",
        "mutation { change }",
        "subscription { notice }",
      ]) {
        const result = await execute(client, query);
        expect(result.errors?.[0]?.extensions).toMatchObject({
          code: "FORBIDDEN",
          statusCode: 403,
        });
      }
      expect(f.reads()).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("does not turn connection-init Origin into ambient browser evidence", async () => {
    const f = await fixture(mode);
    try {
      const client = f.client(
        { cookie: f.cookie },
        { origin: "http://localhost:3000" },
      );
      expect(
        (await execute(client, "subscription { notice }")).errors?.[0]
          ?.extensions,
      ).toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      expect(f.reads()).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("replaces allow-listed credentials and excludes unlisted connection values", async () => {
    const f = await fixture(mode);
    try {
      const client = f.client(
        { cookie: "old=invalid", origin: "http://localhost:3000" },
        { CoOkIe: f.cookie, origin: "https://evil.example" },
      );
      expect(await execute(client, "{ who }")).toEqual({
        data: { who: f.userId },
      });
      const invalid = f.client(
        { cookie: f.cookie, origin: "http://localhost:3000" },
        { cookie: "invalid=value" },
      );
      expect(
        (await execute(invalid, "{ who }")).errors?.[0]?.extensions,
      ).toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401 });
    } finally {
      await f.close();
    }
  });
  it("shares TTL only within a connection and bypasses it for authoritative plans", async () => {
    const f = await fixture(mode, { subscriptionPrincipalTtlMs: 60_000 });
    try {
      const client = f.client({
        cookie: f.cookie,
        origin: "http://localhost:3000",
      });
      expect((await execute(client, "{ who }")).data).toEqual({
        who: f.userId,
      });
      expect((await execute(client, "mutation { change }")).data).toEqual({
        change: f.userId,
      });
      expect(f.reads()).toBe(1);
      f.database.session.splice(0);
      expect(
        (await execute(client, "{ authoritative }")).errors?.[0]?.extensions
          ?.code,
      ).toBe("UNAUTHENTICATED");
      expect(f.reads()).toBe(2);
      const other = f.client({
        cookie: f.cookie,
        origin: "http://localhost:3000",
      });
      expect(
        (await execute(other, "{ who }")).errors?.[0]?.extensions?.code,
      ).toBe("UNAUTHENTICATED");
    } finally {
      await f.close();
    }
  });
  it("preserves host metadata when custom credential extraction uses dynamic SDK base URLs", async () => {
    let cookie = "";
    const f = await fixture(
      mode,
      { subscriptionCredentials: () => ({ cookie }) },
      true,
    );
    cookie = f.cookie;
    try {
      const client = f.client({
        origin: "http://localhost:3000",
        "x-forwarded-host": "edge.example.test",
        "x-forwarded-proto": "http",
      });
      expect((await execute(client, "{ who }")).data).toEqual({
        who: f.userId,
      });
    } finally {
      await f.close();
    }
  });
});
