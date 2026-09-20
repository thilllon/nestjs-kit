import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthContextView,
  AuthHandle,
  PrincipalRequest,
  PrincipalSource,
  ResolutionRequest,
  TransportCall,
} from "./auth-contracts.js";
import { AuthFailures } from "./auth-errors.js";
import type { BridgeBinding, BridgeHandle } from "./bridge-protocol.js";
import { BRIDGE_HANDLE } from "./bridge-protocol.js";
import type { InstanceEntry } from "./instance-registry.js";
import { nestjs } from "./plugin.js";
import { ChainPrincipalResolver } from "./principal-resolver.js";
import { RequestScope } from "./request-scope.js";
import { sessionPrincipal } from "./session-principal.js";
import { TransportRegistry } from "./transport-registry.js";

function fixture(sources: PrincipalSource[]) {
  const scope = new RequestScope();
  const handle = {
    name: "default",
    run: (_init: unknown, fn: () => Promise<unknown>) => fn(),
  } as AuthHandle;
  const entry = {
    name: "default",
    handle,
    sources,
    options: {},
    credentialHeaders: ["cookie"],
    bridge: { clientIpHeader: "x-nsba-ip-test" },
  } as unknown as InstanceEntry;
  const resolver = new ChainPrincipalResolver(
    { get: () => entry, list: () => [entry] },
    scope,
    new TransportRegistry(),
  );
  const call: TransportCall = {
    key: {},
    invocation: {},
    headers: () => new Headers(),
    cookies: null,
    clientIp: null,
    param: () => undefined,
  };
  const request: ResolutionRequest = {
    auth: handle,
    freshness: "default",
    accepts: new Set(["session"]),
    sourceSet: "[0]",
  };
  return { scope, entry, resolver, call, request };
}
describe("principal chain", () => {
  it("shares concurrent request work and never consults explicitly excluded kinds", async () => {
    const session = vi.fn(async () => ({ outcome: "absent" as const })),
      machine = vi.fn(async () => ({ outcome: "absent" as const }));
    const f = fixture([
      {
        id: "machine",
        kinds: ["machine"],
        acceptance: "explicit",
        resolve: machine,
      },
      {
        id: "session",
        kinds: ["session"],
        acceptance: "default",
        resolve: session,
      },
    ]);
    await Promise.all([
      f.resolver.resolve(f.call, f.request),
      f.resolver.resolve({ ...f.call, invocation: {} }, { ...f.request }),
    ]);
    expect(session).toHaveBeenCalledTimes(1);
    expect(machine).not.toHaveBeenCalled();
  });
  it("stops immediately at a presented rejected credential and preserves failures", async () => {
    const failure = AuthFailures.rejected({ status: 429, reason: "QUOTA" }),
      next = vi.fn(async () => ({ outcome: "absent" as const }));
    const f = fixture([
      {
        id: "first",
        kinds: ["session"],
        resolve: async () => ({ outcome: "rejected", failure }),
      },
      { id: "next", kinds: ["session"], resolve: next },
    ]);
    await expect(f.resolver.resolve(f.call, f.request)).resolves.toEqual({
      outcome: "rejected",
      failure,
    });
    expect(next).not.toHaveBeenCalled();
  });
  it("distinguishes source-set contents, excludes spoofed client IP, and uses source identity memo", async () => {
    const seen: Headers[] = [],
      io = vi.fn(async () => true);
    const source: PrincipalSource = {
      id: "one",
      kinds: ["session"],
      async resolve(r) {
        seen.push(r.headers);
        await r.memo("same", io);
        return { outcome: "absent" };
      },
    };
    const f = fixture([source]);
    const call = {
      ...f.call,
      headers: () =>
        new Headers({ "x-nsba-ip-fake": "bad", "x-nsba-ip-test": "spoof" }),
      clientIp: "127.0.0.9",
    };
    await f.resolver.resolve(call, f.request);
    await f.resolver.resolve(call, { ...f.request, sourceSet: "[0,1]" });
    expect(seen).toHaveLength(2);
    expect(io).toHaveBeenCalledTimes(1);
    expect(seen[0]!.get("x-nsba-ip-fake")).toBeNull();
    expect(seen[0]!.get("x-nsba-ip-test")).toBe("127.0.0.9");
  });
  it("bypasses the principal memo only for the producing session-backed source", async () => {
    const session = vi.fn(async () => ({ outcome: "absent" as const })),
      other = vi.fn(async () => ({ outcome: "absent" as const }));
    const f = fixture([
      {
        id: "session",
        kinds: ["session"],
        sessionBacked: true,
        resolve: session,
      },
      { id: "other", kinds: ["session"], resolve: other },
    ]);
    await f.resolver.resolve(f.call, f.request);
    await f.resolver.resolve(f.call, {
      ...f.request,
      freshness: "authoritative",
      reclassify: { sourceId: "session" },
    });
    expect(session).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });
});

describe("session source against the actual SDK", () => {
  it("accepts undefined short-circuit headers normally but requires endpoint provenance authoritatively", async () => {
    const plugin = nestjs();
    const auth = betterAuth({
      baseURL: "http://localhost:3000",
      secret: "private-test-secret-with-at-least-thirty-two-characters",
      plugins: [plugin],
      advanced: { disableOriginCheck: false },
      hooks: {
        before: createAuthMiddleware(async (ctx) =>
          ctx.path === "/get-session"
            ? { user: { id: "short" }, session: { id: "short" } }
            : undefined,
        ),
      },
    });
    const context = await auth.$context;
    const bridge = (plugin as unknown as Record<symbol, BridgeHandle>)[
      BRIDGE_HANDLE
    ]!;
    const empty = { before: [], after: [] };
    const binding: BridgeBinding = {
      owner: { description: "session source test" },
      instance: "default",
      state: "bootstrapped",
      current: () => undefined,
      credentialHeaders: [],
      before: [],
      after: [],
      database: Object.fromEntries(
        ["user", "session", "account", "verification"].flatMap((model) =>
          ["create", "update", "delete"].map((operation) => [
            `${model}.${operation}`,
            empty,
          ]),
        ),
      ) as unknown as BridgeBinding["database"],
      onDropped: () => undefined,
    };
    const registration = bridge.bind(binding);
    const handle: AuthHandle = {
      name: "default",
      instance: auth,
      api: auth.api,
      context: async () => context as unknown as AuthContextView,
      hasPlugin: async (id) => context.hasPlugin(id),
      run: async (_init, fn) => fn(),
      producedByEndpoint: (value) => bridge.producedByEndpoint(value),
      checkOrigin: async () => null,
      isTrustedOrigin: async () => true,
    };
    const append = vi.fn();
    const request: PrincipalRequest = {
      auth: handle,
      headers: new Headers(),
      cookies: { append },
      freshness: "default",
      transport: "test",
      memo: async (_key, fn) => fn(),
    };
    try {
      await expect(sessionPrincipal().resolve(request)).resolves.toMatchObject({
        outcome: "authenticated",
        principal: { userId: "short" },
      });
      await expect(
        sessionPrincipal().resolve({ ...request, freshness: "authoritative" }),
      ).resolves.toEqual({ outcome: "absent" });
      expect(append).not.toHaveBeenCalled();
    } finally {
      registration.close();
    }
  });
});
