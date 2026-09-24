import { describe, expect, it } from "vitest";
import { graphqlLineage, graphqlInvocation } from "./graphql-lineage.js";

function info(operation: object, keys: readonly (string | number)[]) {
  let path:
    | { key: string | number; prev?: unknown; typename?: string }
    | undefined;
  for (const key of keys) {
    path = { key, prev: path, typename: "Project" };
  }
  return { operation, path };
}
describe("GraphQL invocation lineage", () => {
  it("isolates aliases, list indexes and batched operations while preserving ancestors", () => {
    const carrier = {};
    const operation = {};
    const a = graphqlLineage([null, {}, carrier, info(operation, ["a"])]);
    const child = graphqlLineage([
      {},
      {},
      carrier,
      info(operation, ["a", 0, "owner"]),
    ]);
    const sibling = graphqlLineage([
      {},
      {},
      carrier,
      info(operation, ["b", 0, "owner"]),
    ]);
    const batch = graphqlLineage([{}, {}, carrier, info({}, ["a"])]);
    expect([
      ...child.enclosing([{}, {}, carrier, info(operation, ["a", 0, "owner"])]),
    ]).toContain(a.position);
    expect(sibling.position).not.toBe(child.position);
    expect(batch.position).not.toBe(a.position);
  });
  it("normalizes Apollo reference arguments and uses each representation as invocation", () => {
    const carrier = {};
    const shared = info({}, ["_entities"]);
    const a = { __typename: "Project", id: "A" };
    const b = { __typename: "Project", id: "B" };
    expect(graphqlInvocation([a, carrier, shared], true)).toBe(a);
    expect(graphqlInvocation([b, {}, carrier, shared], true)).toBe(b);
    expect(graphqlLineage([a, carrier, shared], true).position).toBe(
      graphqlLineage([b, {}, carrier, shared], true).position,
    );
    expect([
      ...graphqlLineage([
        a,
        {},
        carrier,
        info(shared.operation, ["_entities", 0, "owner"]),
      ]).enclosing([
        a,
        {},
        carrier,
        info(shared.operation, ["_entities", 0, "owner"]),
      ]),
    ]).toContain(graphqlLineage([a, carrier, shared], true).position);
  });
});

import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host.js";
import type {
  AuthTransport,
  HttpRequestAccessor,
  PrincipalReading,
} from "./auth-contracts.js";
import { apolloTransport, type GraphqlTransportOptions } from "./graphql.js";
import { isAuthFailure } from "./auth-errors.js";
import { PrincipalReadings } from "./principal-readings.js";
import { RequestScope } from "./request-scope.js";

describe("GraphQL envelope and inherited readings", () => {
  it.each([false, true])(
    "keeps ancestors independent across principal settlement orders (reverse=%s)",
    (reverse) => {
      const carrier = {};
      const operation = {};
      const readings = new PrincipalReadings(new RequestScope());
      const a = [null, {}, carrier, info(operation, ["a"])];
      const b = [null, {}, carrier, info(operation, ["b"])];
      const session: PrincipalReading = {
        outcome: "authenticated",
        instance: "primary",
        principal: {
          kind: "session",
          source: "better-auth:session",
          userId: "A",
          session: {
            session: {
              id: "session",
              userId: "A",
              token: "opaque",
              expiresAt: new Date(),
              createdAt: new Date(),
              updatedAt: new Date(),
            },
            user: {
              id: "A",
              name: "A",
              email: "a@example.test",
              emailVerified: true,
              createdAt: new Date(),
              updatedAt: new Date(),
            },
          },
        },
      };
      const anonymous: PrincipalReading = {
        outcome: "no-identity",
        instance: "other",
      };
      const writes = [
        [a, session],
        [b, anonymous],
      ] as const;
      for (const [args, reading] of reverse ? [...writes].reverse() : writes) {
        readings.record(
          {
            invocation: graphqlInvocation(args),
            lineage: graphqlLineage(args),
          },
          reading,
        );
      }
      const childA = [{}, {}, carrier, info(operation, ["a", 2, "owner"])];
      const childB = [{}, {}, carrier, info(operation, ["b", 0, "owner"])];
      expect(
        readings.read({
          args: childA,
          lineage: graphqlLineage(childA),
          plan: {
            access: "inherit",
            instance: "different-field-instance",
            site: "Row.owner",
          },
        }),
      ).toBe(session);
      expect(
        readings.read({
          args: childB,
          lineage: graphqlLineage(childB),
          plan: { access: "inherit", instance: "primary", site: "Row.owner" },
        }),
      ).toBe(anonymous);
      expect(readings.read({ args: childA })).toBe(session);
      expect(readings.read({ args: childB })).toBe(anonymous);
    },
  );
  it("builds an unknown context envelope harmlessly and fails only when consuming credentials", () => {
    class Resolver {
      query() {}
    }
    const context = new ExecutionContextHost(
      [
        null,
        {},
        { req: { headers: { cookie: "forged" } } },
        info({}, ["query"]),
      ],
      Resolver,
      Resolver.prototype.query,
    );
    context.setType("graphql");
    const transport = apolloTransport() as AuthTransport;
    const call = transport.describe(context, { http: null });
    expect(call.key).toBe(context.getArgs()[2]);
    expect(call.invocation).toBe(context.getArgs()[3]);
    expect(() => call.headers()).toThrow("Authentication is misconfigured");
    expect(() => call.cookies).toThrow("Authentication is misconfigured");
    expect(() => call.browser).toThrow("Authentication is misconfigured");
  });
  it("checks the current descendant's request liveness instead of closing over its ancestor", () => {
    let live = true;
    const native = {};
    const http: HttpRequestAccessor = {
      isRequest: (value) => value === native,
      isLive: () => live,
      key: () => native,
      headers: () => new Headers(),
      request: () => ({ method: "POST", url: "http://localhost/graphql" }),
      clientIp: () => null,
      param: () => undefined,
      cookieSink: () => null,
    };
    class Resolver {
      query() {}
    }
    const carrier = { req: native };
    const operation = {};
    const context = new ExecutionContextHost(
      [null, {}, carrier, info(operation, ["query"])],
      Resolver,
      Resolver.prototype.query,
    );
    context.setType("graphql");
    const transport = apolloTransport() as AuthTransport;
    const call = transport.describe(context, { http });
    const readings = new PrincipalReadings(new RequestScope());
    readings.record(call, {
      outcome: "authenticated",
      instance: "default",
      principal: {
        kind: "session",
        source: "better-auth:session",
        userId: "A",
        session: {
          session: {
            id: "session",
            userId: "A",
            token: "opaque",
            expiresAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
          },
          user: {
            id: "A",
            name: "A",
            email: "a@example.test",
            emailVerified: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        },
      },
    });
    live = false;
    const child = [{}, {}, carrier, info(operation, ["query", "owner"])];
    expect(() => readings.read({ args: child })).toThrow(
      "Authentication is misconfigured",
    );
    try {
      readings.read({ args: child });
    } catch (error) {
      expect(error).toHaveProperty("code", "GRAPHQL_CONTEXT_STALE_REQUEST");
    }
  });
});

describe("GraphQL socket credential envelopes", () => {
  it("preserves host routing for an override and keeps browser headers independent", () => {
    class Resolver {
      query() {}
    }
    const request = {
      headers: {
        host: "internal:3000",
        "x-forwarded-host": "auth.example.test",
        "x-forwarded-proto": "https",
        cookie: "ambient=credential",
        origin: "https://browser.example.test",
        upgrade: "websocket",
      },
      url: "/graphql",
    };
    const carrier = {
      req: {
        connectionParams: {
          cookie: "replacement=credential",
          origin: "https://spoof.example.test",
        },
        extra: { request },
      },
    };
    const context = new ExecutionContextHost(
      [null, {}, carrier, info({}, ["query"])],
      Resolver,
      Resolver.prototype.query,
    );
    context.setType("graphql");
    const transport = apolloTransport({
      subscriptionCredentials: () => ({
        authorization: "Bearer selected",
        "x-forwarded-host": "explicit.example.test",
      }),
    }) as AuthTransport;
    const call = transport.describe(context, { http: null });
    expect(call.headers().get("authorization")).toBe("Bearer selected");
    expect(call.headers().get("host")).toBe("internal:3000");
    expect(call.headers().get("x-forwarded-host")).toBe(
      "explicit.example.test",
    );
    expect(call.headers().get("x-forwarded-proto")).toBe("https");
    expect(call.browser?.headers().get("origin")).toBe(
      "https://browser.example.test",
    );
    expect(call.browser?.headers().get("cookie")).toBe("ambient=credential");
    expect(call.browser?.enforce).toBe(true);
    expect(call.browser?.url).toBe("http://internal:3000/graphql");
    expect(call.cookies).toBeNull();
    expect(call.key).toBe(carrier);
    expect(call.connection).toBe(request);
  });
});

function socketHeaders(
  options: GraphqlTransportOptions,
  params: Record<string, unknown> = {},
) {
  class Resolver {
    query() {}
  }
  const context = new ExecutionContextHost(
    [
      null,
      {},
      {
        req: {
          connectionParams: params,
          extra: {
            request: {
              headers: {
                host: "localhost:3000",
                upgrade: "websocket",
                cookie: "valid=fallback",
              },
              rawHeaders: [
                "host",
                "localhost:3000",
                "upgrade",
                "websocket",
                "cookie",
                "valid=fallback",
              ],
              url: "/graphql",
            },
          },
        },
      },
      info({}, ["query"]),
    ],
    Resolver,
    Resolver.prototype.query,
  );
  context.setType("graphql");
  return (apolloTransport(options) as AuthTransport).describe(context, {
    http: null,
  }).headers;
}

describe("GraphQL malformed credential conversion", () => {
  it.each([
    "secret\r\nInjected: value",
    "secret\r",
    "secret\n",
    "secret\0",
    "secret\u0100",
    null,
    12,
    {},
    [],
    ["secret"],
  ])(
    "rejects a selected malformed value without retaining its cause (%j)",
    (value) => {
      const headers = socketHeaders({}, { authorization: value });
      let failure: unknown;
      try {
        headers();
      } catch (error) {
        failure = error;
      }
      expect(isAuthFailure(failure)).toBe(true);
      expect(failure).toMatchObject({
        status: 401,
        code: "UNAUTHENTICATED",
        reason: "MALFORMED_CREDENTIALS",
      });
      expect(failure).not.toHaveProperty("cause");
      expect(failure).not.toHaveProperty("stack");
      expect(JSON.stringify(failure)).not.toContain("secret");
    },
  );
  it.each<Record<string, string>>([
    { authorization: "secret\r\nInjected: value" },
    { authorization: "secret\u0100" },
    { "invalid header": "secret" },
  ])("sanitizes custom HeadersInit conversion (%j)", (input) => {
    const headers = socketHeaders({ subscriptionCredentials: () => input });
    let failure: unknown;
    try {
      headers();
    } catch (error) {
      failure = error;
    }
    expect(isAuthFailure(failure)).toBe(true);
    expect(failure).toMatchObject({
      status: 401,
      reason: "MALFORMED_CREDENTIALS",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("stack");
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
  it("presents no credentials when the custom mapping returns undefined", () => {
    const headers = socketHeaders(
      { subscriptionCredentials: () => undefined },
      { authorization: "Bearer connection-param", cookie: "param=credential" },
    )();
    expect([...headers]).toEqual([["host", "localhost:3000"]]);
  });
  it("sanitizes invalid selected header names and ignores unselected values", () => {
    expect(() =>
      socketHeaders(
        { connectionParamHeaders: ["invalid header"] },
        { "invalid header": "secret" },
      )(),
    ).toThrow();
    expect(
      socketHeaders({}, { unselected: "secret\r\n" })().get("cookie"),
    ).toBe("valid=fallback");
  });
  it.each([
    new Error("mapper programming error"),
    new TypeError("mapper programming error"),
  ])("preserves callback programming errors (%j)", (error) => {
    const headers = socketHeaders({
      subscriptionCredentials: () => {
        throw error;
      },
    });
    expect(headers).toThrow(error);
    try {
      headers();
    } catch (actual) {
      expect(actual).toBe(error);
    }
  });
});

import type { AbstractHttpAdapter } from "@nestjs/core";
import { ExpressPlatform } from "./express-platform.js";
import { FastifyPlatform } from "./fastify-platform.js";

function httpCarrier(platform: "express" | "fastify") {
  const headers = {
    host: "localhost:3000",
    upgrade: "websocket",
    cookie: "session=credential",
  };
  const written: string[] = [];
  const state = { live: true };
  if (platform === "express") {
    const res = {
      get writableEnded() {
        return !state.live;
      },
      setHeader: (_name: string, value: string[]) => {
        written.push(...value);
      },
      getHeader: () => undefined,
    };
    const req = {
      method: "POST",
      url: "/graphql",
      originalUrl: "/graphql",
      protocol: "http",
      host: "localhost:3000",
      headers,
      ip: "203.0.113.7",
      socket: {},
      res,
    };
    return {
      http: new ExpressPlatform().requests,
      carrier: { req },
      key: req,
      written,
      state,
    };
  }
  const fastify = new FastifyPlatform();
  let onRequest:
    | ((request: unknown, reply: unknown, done: () => void) => void)
    | undefined;
  fastify.prepare({
    adapter: {
      getInstance: () => ({
        addHook: (_name: string, hook: typeof onRequest) => {
          onRequest = hook;
        },
      }),
    } as unknown as AbstractHttpAdapter,
    logger: console,
    route: () => undefined,
  });
  const raw = { headers, httpVersionMajor: 1 };
  const reply = {
    get sent() {
      return !state.live;
    },
    raw: { headersSent: false },
    header: (_name: string, value: string) => {
      written.push(value);
    },
  };
  const req = {
    raw,
    headers: raw.headers,
    method: "POST",
    protocol: "http",
    host: "localhost:3000",
    originalUrl: "/graphql",
    ip: "203.0.113.7",
  };
  onRequest?.(req, reply, () => {});
  return {
    http: fastify.requests,
    carrier: { req },
    key: raw,
    written,
    state,
  };
}
function graphqlContext(carrier: object) {
  class Resolver {
    query() {}
  }
  const context = new ExecutionContextHost(
    [null, {}, carrier, info({}, ["query"])],
    Resolver,
    Resolver.prototype.query,
  );
  context.setType("graphql");
  return context;
}

describe("GraphQL HTTP classification with a client Upgrade header", () => {
  it.each(["express", "fastify"] as const)(
    "keeps a %s Apollo HTTP request carrying Upgrade: websocket on the platform path",
    (platform) => {
      const f = httpCarrier(platform);
      const call = (apolloTransport() as AuthTransport).describe(
        graphqlContext(f.carrier),
        { http: f.http },
      );
      expect(call.connection).toBeUndefined();
      expect(call.key).toBe(f.key);
      expect(call.clientIp).toBe("203.0.113.7");
      expect(call.request).toEqual({
        method: "POST",
        url: "http://localhost:3000/graphql",
      });
      expect(call.browser?.enforce).toBe(false);
      expect(call.cookies?.append(["refreshed=1"])).not.toBe(false);
      expect(f.written).toEqual(["refreshed=1"]);
      f.state.live = false;
      let failure: unknown;
      try {
        call.headers();
      } catch (error) {
        failure = error;
      }
      expect(failure).toHaveProperty("code", "GRAPHQL_CONTEXT_STALE_REQUEST");
    },
  );
  it.each(["express", "fastify"] as const)(
    "keeps graphql-ws and subscriptions-transport upgrade requests on the socket path with %s predicates",
    (platform) => {
      const { http } = httpCarrier(platform);
      const request = {
        headers: { host: "localhost:3000", upgrade: "websocket" },
        url: "/graphql",
      };
      for (const carrier of [
        { req: { connectionParams: {}, extra: { request } } },
        { req: request },
        { extra: { request } },
      ]) {
        const call = (apolloTransport() as AuthTransport).describe(
          graphqlContext(carrier),
          { http },
        );
        expect(call.connection).toBe(request);
        expect(call.key).toBe(carrier);
        expect(call.clientIp).toBeNull();
        expect(call.cookies).toBeNull();
      }
    },
  );
});
