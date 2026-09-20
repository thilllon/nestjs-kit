import "reflect-metadata";
import type { ExecutionContext } from "@nestjs/common";
import type { ModuleRef } from "@nestjs/core";
import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import type {
  AuthHandle,
  AuthorizationPolicy,
  PrincipalResolver,
  PrincipalResult,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import type { AuthPrincipal } from "./auth-types.js";
import {
  AuthorizationEvaluator,
  DefaultPolicyInvoker,
} from "./authorization-evaluator.js";
import type { InstanceEntry } from "./instance-registry.js";
import { PolicyResolver } from "./policy-resolver.js";
import { RequestScope } from "./request-scope.js";
class Controller {
  run() {}
}
const execution = {
  getClass: () => Controller,
  getHandler: () => Controller.prototype.run,
} as unknown as ExecutionContext;
const principal = {
  kind: "session",
  source: "session",
  userId: "u",
  session: {},
} as AuthPrincipal;
function fixture(
  policy: AuthorizationPolicy,
  resolve: PrincipalResolver["resolve"] = vi.fn(
    async (): Promise<PrincipalResult> => ({ outcome: "absent" }),
  ),
  limit = 100,
) {
  const scope = new RequestScope();
  const auth = {
    name: "default",
    run: (_init: unknown, fn: () => Promise<unknown>) => fn(),
  } as AuthHandle;
  const entry = {
    name: "default",
    handle: auth,
    options: { limits: { maxAuthorizationCallsPerRequest: limit } },
    bridge: { clientIpHeader: null },
    credentialHeaders: ["x-secret"],
    sources: [{ id: "session", sessionBacked: true }],
  } as unknown as InstanceEntry;
  const evaluator = new AuthorizationEvaluator(
    new PolicyResolver({} as ModuleRef),
    new DefaultPolicyInvoker(),
    { resolve } as PrincipalResolver,
    scope,
  );
  const call: TransportCall = {
    key: {},
    invocation: {},
    headers: () => new Headers(),
    clientIp: null,
    cookies: null,
    param: () => undefined,
  };
  const plan = {
    instance: "default",
    requirements: [{ policy, params: {} }],
    accepts: new Set(["session"]),
    sourceSet: "[0]",
    site: "Controller.run",
  } as unknown as RoutePlan;
  return {
    scope,
    entry,
    evaluator,
    call,
    plan,
    resolve,
    run: (current = call) =>
      evaluator.evaluate(plan, principal, current, entry, execution, "test"),
  };
}
describe("authorization evaluation", () => {
  it("isolates decisions per invocation while memoizing concrete I/O per request", async () => {
    const io = vi.fn(async () => true),
      evaluate = vi.fn(async (_params, context) => {
        await context.memo(JSON.stringify(["read", context.param("id")]), io);
        return { effect: "allow" as const };
      });
    const f = fixture({ id: "io", evaluate });
    const a = { ...f.call, param: () => 1 },
      b = { ...f.call, invocation: {}, param: () => 1 },
      c = { ...f.call, invocation: {}, param: () => 2 };
    await Promise.all([f.run(a), f.run(a), f.run(b), f.run(c)]);
    expect(evaluate).toHaveBeenCalledTimes(3);
    expect(io).toHaveBeenCalledTimes(2);
  });
  it("enforces the 100-distinct-call request budget including reclassification", async () => {
    const io = vi.fn(async () => true);
    const f = fixture({
      id: "budget",
      async evaluate(_p, c) {
        await c.memo(String(c.param("id")), io);
        return { effect: "allow" };
      },
    });
    for (let id = 0; id < 100; id++) {
      await f.run({ ...f.call, invocation: {}, param: () => id });
    }
    await expect(
      f.run({ ...f.call, invocation: {}, param: () => 100 }),
    ).rejects.toMatchObject({
      status: 429,
      reason: "TOO_MANY_AUTHORIZATION_CHECKS",
    });
    expect(io).toHaveBeenCalledTimes(100);
    Object.assign(f.plan, {
      requirements: [
        {
          policy: {
            id: "expired",
            evaluate() {
              throw APIError.fromStatus("UNAUTHORIZED");
            },
          },
          params: {},
        },
      ],
    });
    await expect(f.run({ ...f.call, invocation: {} })).rejects.toMatchObject({
      status: 429,
    });
    expect(f.resolve).not.toHaveBeenCalled();
  });
  it("shares one generic-401 reread and one outage identity between concurrent invocations", async () => {
    const resolve = vi.fn(async () => ({
      outcome: "authenticated" as const,
      principal,
    }));
    const f = fixture(
      {
        id: "lost",
        evaluate() {
          throw APIError.fromStatus("UNAUTHORIZED");
        },
      },
      resolve,
    );
    const results = await Promise.allSettled([
      f.run(),
      f.run({ ...f.call, invocation: {} }),
    ]);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");
    if (results[0].status === "rejected" && results[1].status === "rejected") {
      expect(results[0].reason).toBe(results[1].reason);
    }
  });
  it.each(["USER_BANNED", "NOT_ALLOWED"])(
    "maps coded 401 %s to 403 without a reread",
    async (code) => {
      const f = fixture({
        id: "coded",
        evaluate() {
          throw new APIError("UNAUTHORIZED", { code, message: "sensitive" });
        },
      });
      await expect(f.run()).resolves.toMatchObject({
        effect: "deny",
        status: 403,
        reason: code,
      });
      expect(f.resolve).not.toHaveBeenCalled();
    },
  );
  it("maps malformed policy calls to configuration errors and redacts outages", async () => {
    const bad = fixture({
      id: "bad",
      evaluate() {
        throw new APIError("BAD_REQUEST", { message: "invalid" });
      },
    });
    await expect(bad.run()).rejects.toMatchObject({
      code: "BETTER_AUTH_REJECTED_CALL",
    });
    const outage = fixture({
      id: "outage",
      evaluate() {
        throw new Error("database failed for highly-secret-token");
      },
    });
    outage.call.headers = () =>
      new Headers({ "x-secret": "highly-secret-token" });
    await expect(outage.run()).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "database failed for [REDACTED]",
      }),
    });
  });
  it("does not extend a delegated principal through a policy with no admitted kinds", async () => {
    const evaluate = vi.fn(() => ({ effect: "allow" as const }));
    const f = fixture({ id: "generic", evaluate });
    const delegated = {
      ...principal,
      delegation: { description: "narrow", allows: () => false },
    };
    await expect(
      f.evaluator.evaluate(
        f.plan,
        delegated,
        f.call,
        f.entry,
        execution,
        "test",
      ),
    ).resolves.toMatchObject({
      effect: "deny",
      reason: "PRINCIPAL_NOT_SUPPORTED",
    });
    expect(evaluate).not.toHaveBeenCalled();
  });
});

it("fresh-session policy matches the SDK boundary, disabled check and unsupported shape", async () => {
  const { freshSession } = await import("./session-principal.js");
  const requirement = freshSession({ maxAgeSeconds: 10 });
  const policy = new PolicyResolver({} as ModuleRef).resolve(
    requirement.policy,
  );
  const context = (createdAt: unknown) =>
    ({
      principal: {
        kind: "session",
        source: "session",
        userId: "u",
        session: { session: { createdAt } },
      },
    }) as unknown as import("./auth-contracts.js").AuthorizationContext;
  vi.useFakeTimers();
  try {
    vi.setSystemTime(20_000);
    await expect(
      policy.evaluate(requirement.params, context(new Date(10_000))),
    ).resolves.toMatchObject({
      effect: "deny",
      status: 403,
      reason: "SESSION_NOT_FRESH",
    });
    await expect(
      policy.evaluate(requirement.params, context(new Date(10_001))),
    ).resolves.toMatchObject({ effect: "allow" });
    await expect(
      policy.evaluate({ maxAgeSeconds: 0 }, context(undefined)),
    ).resolves.toMatchObject({ effect: "allow" });
    await expect(
      policy.evaluate(requirement.params, context(undefined)),
    ).resolves.toMatchObject({
      effect: "deny",
      reason: "PRINCIPAL_NOT_SUPPORTED",
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  {
    name: "anyOf stops on its first allow",
    tree: "any-allow",
    calls: ["allow"],
    decision: { effect: "allow" },
  },
  {
    name: "anyOf keeps the first denial reason but gives 401 precedence",
    tree: "any-deny",
    calls: ["deny403", "deny401"],
    decision: {
      effect: "deny",
      status: 401,
      reason: "FIRST_DENIAL",
      message: "deny403 or deny401",
    },
  },
  {
    name: "allOf stops on its first denial",
    tree: "all-deny",
    calls: ["deny403"],
    decision: { effect: "deny", status: 403, reason: "FIRST_DENIAL" },
  },
  {
    name: "nested alternatives preserve sequential short circuits",
    tree: "nested",
    calls: ["deny403", "allow"],
    decision: { effect: "allow" },
  },
  {
    name: "allOf evaluates all children until every child allows",
    tree: "all-allow",
    calls: ["allow", "secondAllow"],
    decision: { effect: "allow" },
  },
])("$name", async ({ tree, calls, decision }) => {
  const { anyOf, allOf, requirement } = await import("./auth-decorators.js");
  const observed: string[] = [];
  const leaf = (
    id: string,
    answer: import("./auth-contracts.js").AuthorizationDecision,
  ) =>
    requirement(
      {
        id,
        evaluate() {
          observed.push(id);
          return answer;
        },
      },
      {},
      { label: id },
    );
  const allow = leaf("allow", { effect: "allow" }),
    secondAllow = leaf("secondAllow", { effect: "allow" });
  const deny403 = leaf("deny403", {
      effect: "deny",
      status: 403,
      reason: "FIRST_DENIAL",
    }),
    deny401 = leaf("deny401", {
      effect: "deny",
      status: 401,
      reason: "SECOND_DENIAL",
    });
  const unused = requirement(
    {
      id: "unused",
      evaluate() {
        throw new Error("short-circuited policy ran");
      },
    },
    {},
  );
  const expressions: Record<
    string,
    import("./auth-contracts.js").RequirementExpr
  > = {
    "any-allow": anyOf(allow, unused),
    "any-deny": anyOf(deny403, deny401),
    "all-deny": allOf(deny403, unused),
    nested: anyOf(allOf(deny403, unused), allOf(allow)),
    "all-allow": allOf(allow, secondAllow),
  };
  const f = fixture({
    id: "unused-fixture",
    evaluate: () => ({ effect: "allow" }),
  });
  Object.assign(f.plan, { requirements: [expressions[tree]] });
  await expect(f.run()).resolves.toMatchObject(decision);
  expect(observed).toEqual(calls);
});

it("keeps policy symbol identity within the request across separate invocation decisions", async () => {
  const a = Symbol("same"),
    b = Symbol("same"),
    registered = Symbol.for("nestjs-slightly-better-auth:test-policy-memo");
  const io = vi.fn(async () => true);
  const f = fixture({
    id: "symbols",
    async evaluate(_params, context) {
      await Promise.all([
        context.memo(a, io),
        context.memo(a, io),
        context.memo(b, io),
        context.memo(registered, io),
      ]);
      return { effect: "allow" };
    },
  });
  await f.run();
  await f.run({ ...f.call, invocation: {} });
  expect(io).toHaveBeenCalledTimes(3);
  await f.run({ ...f.call, key: {}, invocation: {} });
  expect(io).toHaveBeenCalledTimes(6);
});
