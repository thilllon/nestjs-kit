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
import { BetterAuthService } from "./auth-service.js";
import {
  CurrentPrincipal,
  OptionalAuth,
  Public,
  RequireAuth,
} from "./auth-decorators.js";
import type {
  AuthPrincipalBase,
  AuthTransport,
  PrincipalSource,
} from "./auth-contracts.js";
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

interface QueryTokenPrincipal extends AuthPrincipalBase {
  readonly kind: "query-token";
  readonly userId: string;
}
declare module "./index.js" {
  interface PrincipalKinds {
    "query-token": QueryTokenPrincipal;
  }
}
/** An application source that authenticates the request URL's access_token query parameter. */
function queryTokenSource(
  owners: ReadonlyMap<string, string>,
  urls: string[],
): PrincipalSource {
  return {
    id: "query-token",
    kinds: ["query-token"],
    acceptance: "default",
    async resolve(request) {
      if (!request.request) {
        return { outcome: "absent" };
      }
      urls.push(request.request.url);
      const token = new URL(request.request.url).searchParams.get(
        "access_token",
      );
      const userId = token === null ? undefined : owners.get(token);
      return userId === undefined
        ? { outcome: "absent" }
        : {
            outcome: "authenticated",
            principal: { kind: "query-token", source: "query-token", userId },
          };
    },
  };
}

/** The session cookie a resolver's direct call carries; the test sets it per fixture. */
let directCallCookie = "";
@Resolver()
class SocketResolver {
  calls = 0;

  constructor(private readonly service: BetterAuthService) {}

  @Query(() => String)
  async sessions(@CurrentPrincipal() principal: AuthPrincipal) {
    const api = this.service.api as unknown as {
      listSessions(input: { headers: Headers }): Promise<unknown[]>;
    };
    const sessions = await api.listSessions({
      headers: new Headers({ cookie: directCallCookie }),
    });
    return `${principal.userId}:${sessions.length}`;
  }

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
  | "apollo-fastify-default"
  | "apollo-fastify-custom"
  | "mercurius"
  | "mercurius-native";
interface Result {
  data?: Record<string, unknown> | null;
  errors?: readonly {
    message: string;
    extensions?: Readonly<Record<string, unknown>>;
  }[];
}
/** Resolves on the client's next close event, which follows the server's close frame. */
function closed(client: Client): Promise<void> {
  return new Promise((resolve) => {
    const off = client.on("closed", () => {
      off();
      resolve();
    });
  });
}
/** Opens a graphql-transport-ws connection and resolves once the server acknowledged its connection_init. */
function acknowledged(
  url: string,
  headers: Record<string, string>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, "graphql-transport-ws", { headers });
    socket.once("error", reject);
    socket.once("open", () => {
      socket.send(JSON.stringify({ type: "connection_init", payload: {} }));
    });
    socket.on("message", (data) => {
      if (
        (JSON.parse(String(data)) as { type?: unknown }).type ===
        "connection_ack"
      ) {
        resolve(socket);
      }
    });
  });
}
/**
 * A GraphQL context function for `mode` that returns a fresh object for every operation, or the
 * first operation's object for every later one (a cached context, a configuration error).
 */
function graphqlContext(mode: Mode, shape: "cached" | "fresh") {
  const custom = mode === "apollo-custom" || mode === "apollo-fastify-custom";
  let cached: object | undefined;
  const build = (
    context: {
      req?: unknown;
      extra?: { request?: unknown };
      connectionParams?: unknown;
    },
    reply?: unknown,
  ): object =>
    mode.startsWith("mercurius")
      ? { req: context, reply }
      : custom
        ? {
            req: context.req ?? context.extra?.request,
            extra: context.extra,
            connectionParams: context.connectionParams,
          }
        : { ...context };
  return shape === "cached"
    ? (context: Parameters<typeof build>[0], reply?: unknown) =>
        (cached ??= build(context, reply))
    : build;
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
  context?: (
    context: {
      req?: unknown;
      extra?: { request?: unknown };
      connectionParams?: unknown;
    },
    reply?: unknown,
  ) => object,
  principals: readonly PrincipalSource[] = [],
) {
  const database: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  let reads = 0;
  let sessionCalls = 0;
  let hold: { started: () => void; released: Promise<void> } | undefined;
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
            const current = hold;
            if (current) {
              hold = undefined;
              current.started();
              await current.released;
            }
          }
          return adapter.findOne(input);
        },
      };
    },
    plugins: [bearer(), nestjs()],
  });
  const mercurius = mode.startsWith("mercurius");
  const fastify = mercurius || mode.startsWith("apollo-fastify");
  const transport = (
    mercurius
      ? mercuriusTransport(transportOptions)
      : apolloTransport(transportOptions)
  ) as AuthTransport;
  // Counts the operations that reach the transport, whatever their outcome.
  let described = 0;
  const describe = transport.describe.bind(transport);
  transport.describe = (context, kit) => {
    described++;
    return describe(context, kit);
  };
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
        ...(mode === "apollo-custom" || mode === "apollo-fastify-custom"
          ? {
              // Keeps graphql-ws's extra ({ socket, request }) beside a custom req.
              context: (context: {
                req?: unknown;
                extra?: { request?: unknown };
                connectionParams?: unknown;
              }) => ({
                req: context.req ?? context.extra?.request,
                extra: context.extra,
                connectionParams: context.connectionParams,
              }),
            }
          : {}),
        ...(context ? { context } : {}),
      }),
      BetterAuthModule.forRoot({
        auth,
        logSummary: false,
        platforms: [fastify ? fastifyPlatform() : expressPlatform()],
        principals,
        transports: [transport],
      }),
    ],
    providers: [SocketResolver],
  }).compile();
  const errors: unknown[][] = [];
  const app = module.createNestApplication(
    fastify ? new FastifyAdapter() : new ExpressAdapter(),
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
    const url = `${String(app.getHttpServer().address().address === "127.0.0.1" ? "ws://127.0.0.1" : "ws://localhost")}:${app.getHttpServer().address().port}/graphql`;
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
      described: () => described,
      /** Signs up another user and returns its id and session cookie. */
      async signUp() {
        const other = await auth.api.signUpEmail({
          headers: new Headers({ host: "localhost:3000" }),
          body: {
            name: "Later Caller",
            email: `${crypto.randomUUID()}@example.com`,
            password: "password-secure-123",
          },
          returnHeaders: true,
        });
        return {
          userId: other.response.user.id,
          cookie: other.headers
            .getSetCookie()
            .map((line) => line.split(";")[0])
            .join("; "),
        };
      },
      /** Holds the next session read until release() is called. */
      holdSessionRead() {
        let started = () => {};
        let release = () => {};
        const reached = new Promise<void>((resolve) => {
          started = resolve;
        });
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        hold = { started, released };
        return { reached, release };
      },
      database,
      oldUpdatedAt,
      reads: () => reads,
      sessionCalls: () => sessionCalls,
      /** The graphql-ws endpoint of the app. */
      url,
      /** A null connectionParams sends connection_init without a payload, like a browser client. */
      client(
        headers: Record<string, string>,
        connectionParams: Record<string, unknown> | null = {},
      ) {
        class HeaderSocket extends WebSocket {
          constructor(address: string | URL, protocols?: string | string[]) {
            super(address, protocols, { headers });
          }
        }
        const client = createClient({
          url,
          webSocketImpl: HeaderSocket,
          ...(connectionParams ? { connectionParams } : {}),
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
  "apollo-fastify-default",
  "apollo-fastify-custom",
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
  it("keeps a disconnect during authentication a socket outcome without an ERROR log", async () => {
    const f = await fixture(mode);
    try {
      const held = f.holdSessionRead();
      const client = f.client({
        cookie: f.cookie,
        origin: "http://localhost:3000",
      });
      void execute(client, "{ who }").catch(() => undefined);
      await held.reached;
      await client.dispose();
      // Let the server observe the close before the session read completes.
      await new Promise((resolve) => setTimeout(resolve, 250));
      held.release();
      const deadline = Date.now() + 3000;
      while (
        f.calls() === 0 &&
        f.errors.length === 0 &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(inspect(f.errors)).not.toContain("misconfigured");
      expect(f.errors).toEqual([]);
      expect(f.calls()).toBe(1);
    } finally {
      await f.close();
    }
  });
  it("runs operations of a connection that closes before they start without an ERROR log", async () => {
    const f = await fixture(mode);
    try {
      for (let round = 0; round < 5; round++) {
        const socket = await acknowledged(f.url, {
          cookie: f.cookie,
          origin: "http://localhost:3000",
        });
        const socketClosed = new Promise((resolve) => {
          socket.once("close", resolve);
        });
        // One tick: graphql-ws still awaits each operation's context when the close arrives.
        socket.send(
          JSON.stringify({
            id: "query",
            type: "subscribe",
            payload: { query: "query { who }" },
          }),
        );
        socket.send(
          JSON.stringify({
            id: "subscription",
            type: "subscribe",
            payload: { query: "subscription { notice }" },
          }),
        );
        socket.close();
        await socketClosed;
      }
      // Let the server finish the operations of the closed connections.
      await new Promise((resolve) => setTimeout(resolve, 250));
      // The closed connections' operations reached the transport.
      expect(f.described()).toBeGreaterThan(0);
      expect(inspect(f.errors, { depth: Infinity })).not.toMatch(
        /AUTH_MISCONFIGURED|GRAPHQL_CONTEXT_STALE_REQUEST/,
      );
      expect(f.errors).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it.each(["cached", "fresh"] as const)(
    "answers a later connection under a %s context with its own principal or anonymously",
    async (shape) => {
      const mercurius = mode.startsWith("mercurius");
      const f = await fixture(mode, {}, false, graphqlContext(mode, shape));
      try {
        const later = await f.signUp();
        const origin = "http://localhost:3000";
        const first = f.client({ cookie: f.cookie, origin });
        const firstClosed = closed(first);
        expect(await execute(first, "{ who }")).toEqual({
          data: { who: f.userId },
        });
        await first.dispose();
        await firstClosed;
        const second = f.client({ cookie: later.cookie, origin });
        const results = [
          await execute(second, "{ who optionalWho }"),
          await execute(second, "subscription { notice }"),
        ];
        expect(inspect(results, { depth: Infinity })).not.toContain(f.userId);
        if (shape === "fresh" || mercurius) {
          // Mercurius builds every socket operation's context from its per-connection subscription context.
          expect(results).toEqual([
            { data: { who: later.userId, optionalWho: later.userId } },
            { data: { notice: later.userId } },
          ]);
          expect(f.errors).toEqual([]);
          return;
        }
        // The cached context carries the first connection, closed before these operations started: they read no
        // credential of it, so required work is denied as unauthenticated and optional work runs anonymously.
        expect(results[0]!.data).toEqual({
          who: null,
          optionalWho: "anonymous",
        });
        expect(results[0]!.errors).toHaveLength(1);
        expect(results[1]!.errors).toHaveLength(1);
        for (const error of results.flatMap((result) => result.errors ?? [])) {
          expect(error.extensions).toMatchObject({
            code: "UNAUTHENTICATED",
            statusCode: 401,
          });
        }
        expect(await execute(second, "{ harmless }")).toEqual({
          data: { harmless: "public" },
        });
        expect(f.errors).toEqual([]);
        // The first connection's who and the later connection's optionalWho reached a resolver.
        expect(f.calls()).toBe(2);
      } finally {
        await f.close();
      }
    },
  );
  it.each(["cached", "fresh"] as const)(
    "never authenticates a later connection under a %s context with an earlier connection's query token",
    async (shape) => {
      const owners = new Map([
        ["earlier-token", "earlier-owner"],
        ["later-token", "later-owner"],
      ]);
      const urls: string[] = [];
      const f = await fixture(mode, {}, false, graphqlContext(mode, shape), [
        queryTokenSource(owners, urls),
      ]);
      /** A graphql-ws client whose upgrade request carries `token` in its query string. */
      const connect = (token: string) => {
        const client = createClient({
          url: `${f.url}?access_token=${token}`,
          webSocketImpl: class extends WebSocket {
            constructor(address: string | URL, protocols?: string | string[]) {
              super(address, protocols, {
                headers: { origin: "http://localhost:3000" },
              });
            }
          },
          retryAttempts: 0,
        });
        return client;
      };
      const first = connect("earlier-token");
      try {
        const firstClosed = closed(first);
        expect(await execute(first, "{ who }")).toEqual({
          data: { who: "earlier-owner" },
        });
        await first.dispose();
        await firstClosed;
        const second = connect("later-token");
        try {
          const results = [
            await execute(second, "{ who optionalWho }"),
            await execute(second, "subscription { notice }"),
          ];
          expect(inspect(results, { depth: Infinity })).not.toContain(
            "earlier-owner",
          );
          if (shape === "fresh" || mode.startsWith("mercurius")) {
            expect(results).toEqual([
              { data: { who: "later-owner", optionalWho: "later-owner" } },
              { data: { notice: "later-owner" } },
            ]);
          } else {
            // The cached context carries the first connection, closed before these operations
            // started: the source receives the upgrade path without its query string.
            expect(results[0]!.data).toEqual({
              who: null,
              optionalWho: "anonymous",
            });
            for (const error of results.flatMap(
              (result) => result.errors ?? [],
            )) {
              expect(error.extensions).toMatchObject({
                code: "UNAUTHENTICATED",
                statusCode: 401,
              });
            }
            expect(results[1]!.errors).toHaveLength(1);
            expect(urls.at(-1)).toMatch(/^http:\/\/[^/?#]+\/graphql$/);
          }
          expect(f.errors).toEqual([]);
        } finally {
          await second.dispose();
        }
      } finally {
        await first.dispose();
        await f.close();
      }
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
  it("lets a connectionParams session cookie make caller-session direct calls", async () => {
    const f = await fixture(mode);
    try {
      directCallCookie = f.cookie;
      const expected = { data: { sessions: `${f.userId}:1` } };
      const upgrades: Record<string, string>[] = [
        { origin: "http://localhost:3000" },
        {},
        { origin: "https://evil.example" },
      ];
      for (const upgrade of upgrades) {
        expect(
          await execute(
            f.client(upgrade, { cookie: f.cookie }),
            "{ sessions }",
          ),
        ).toEqual(expected);
      }
      expect(
        await execute(
          f.client({ cookie: f.cookie, origin: "http://localhost:3000" }),
          "{ sessions }",
        ),
      ).toEqual(expected);
      expect(f.errors).toEqual([]);
    } finally {
      directCallCookie = "";
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
  describe.each([
    ["without a connection_init payload", null],
    ["with an empty connection_init payload", {}],
  ] as const)("%s", (_payload, connectionParams) => {
    it("authenticates upgrade-request cookies for queries, mutations and subscriptions", async () => {
      const f = await fixture(mode);
      try {
        const client = f.client(
          { cookie: f.cookie, origin: "http://localhost:3000" },
          connectionParams,
        );
        expect(await execute(client, "{ who }")).toEqual({
          data: { who: f.userId },
        });
        expect(await execute(client, "mutation { change }")).toEqual({
          data: { change: f.userId },
        });
        expect(await execute(client, "subscription { notice }")).toEqual({
          data: { notice: f.userId },
        });
        expect(f.reads()).toBe(3);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
    it("treats a connection without credentials as anonymous", async () => {
      const f = await fixture(mode);
      try {
        const client = f.client(
          { origin: "http://localhost:3000" },
          connectionParams,
        );
        expect(await execute(client, "{ harmless }")).toEqual({
          data: { harmless: "public" },
        });
        expect(await execute(client, "{ optionalWho }")).toEqual({
          data: { optionalWho: "anonymous" },
        });
        for (const query of [
          "{ who }",
          "mutation { change }",
          "subscription { notice }",
        ]) {
          const result = await execute(client, query);
          expect(result.errors, JSON.stringify(result)).toHaveLength(1);
          expect(result.errors?.[0]?.extensions).toMatchObject({
            code: "UNAUTHENTICATED",
            statusCode: 401,
          });
        }
        expect(f.calls()).toBe(1);
        expect(f.reads()).toBe(0);
        expect(f.errors).toEqual([]);
      } finally {
        await f.close();
      }
    });
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

describe.each(["apollo-default", "apollo-fastify-default"] as const)(
  "native %s socket classification",
  (mode) => {
    it("fails closed when a custom context keeps the upgrade request without graphql-ws extra", async () => {
      const f = await fixture(mode, {}, false, (context) => ({
        req: context.extra?.request,
        connectionParams: context.connectionParams,
      }));
      try {
        const client = f.client({
          authorization: f.bearer,
          origin: "http://localhost:3000",
        });
        for (const query of [
          "{ who }",
          "mutation { change }",
          "subscription { notice }",
        ]) {
          const result = await execute(client, query);
          expect(result.errors?.[0], JSON.stringify(result)).toMatchObject({
            message: "Internal server error",
            extensions: { reason: "AUTH_MISCONFIGURED" },
          });
        }
        expect(f.calls()).toBe(0);
        expect(f.reads()).toBe(0);
      } finally {
        await f.close();
      }
    });
  },
);
