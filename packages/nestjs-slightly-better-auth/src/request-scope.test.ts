import { describe, expect, it } from "vitest";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type { ScopeView } from "./bridge-protocol.js";
import { RequestScope } from "./request-scope.js";

describe("RequestScope", () => {
  it("opens harmless work without reading a missing transport capability", () => {
    const scope = new RequestScope();
    const extractionError = BetterAuthConfigurationError.atRequest(
      "GRAPHQL_CONTEXT_UNRECOGNIZED",
      "No live request is present in the GraphQL context",
    );
    let reads = 0;
    const view: ScopeView = {
      get cookies(): never {
        reads += 1;
        throw extractionError;
      },
      forward: "same-credential",
      inbound: undefined,
      internal: false,
      browserHeaders: undefined,
    };
    expect(scope.run({ view }, () => "public result")).toBe("public result");
    expect(reads).toBe(0);
    expect(() =>
      scope.run({ view }, () => scope.current()!.view.cookies),
    ).toThrow(extractionError);
    expect(reads).toBe(1);
    expect(scope.current()).toBeUndefined();
  });
});

import { vi } from "vitest";
import type { PrincipalResult } from "./auth-contracts.js";
import { AuthFailures } from "./auth-errors.js";

const view: ScopeView = {
  cookies: null,
  forward: "none",
  inbound: undefined,
  browserHeaders: undefined,
  internal: false,
};
const absent: PrincipalResult = { outcome: "absent" };
const input = {
  instance: "default",
  freshness: "default",
  sourceSet: "0,2",
} as const;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("retains lazy descriptors and restores nested and concurrent async scopes", async () => {
  const scope = new RequestScope();
  const a = deferred<void>();
  const b = deferred<void>();
  const stateA = {
    view,
    reading: () => ({ instance: "a", outcome: "absent" as const }),
  } as const;
  const stateB = {
    view,
    reading: () => ({ instance: "b", outcome: "absent" as const }),
  } as const;
  const first = scope.run(stateA, async () => {
    await a.promise;
    expect(scope.current()).toBe(stateA);
    expect(() =>
      scope.run(stateB, () => {
        throw new Error("nested");
      }),
    ).toThrow("nested");
    expect(scope.current()).toBe(stateA);
  });
  const second = scope.run(stateB, async () => {
    await b.promise;
    expect(scope.current()).toBe(stateB);
  });
  b.resolve();
  a.resolve();
  await Promise.all([first, second]);
  expect(scope.current()).toBeUndefined();
});

it("shares in-flight principal reads only for equal request, instance and source content", async () => {
  const scope = new RequestScope();
  const read = deferred<PrincipalResult>();
  const compute = vi.fn(() => read.promise);
  const call = { key: {} };
  const first = scope.memoPrincipal(call, input, compute);
  expect(scope.memoPrincipal(call, { ...input }, compute)).toBe(first);
  const others = [
    scope.memoPrincipal({ key: {} }, input, compute),
    scope.memoPrincipal(call, { ...input, instance: "admin" }, compute),
    scope.memoPrincipal(call, { ...input, sourceSet: "2,0" }, compute),
  ];
  await Promise.resolve();
  expect(compute).toHaveBeenCalledTimes(4);
  read.resolve(absent);
  await Promise.all([first, ...others]);
});

it("retains failed request promises without retaining connection failures", async () => {
  const scope = new RequestScope();
  const connection = {};
  const error = new Error("database unavailable");
  const compute = vi.fn(async () => {
    throw error;
  });
  const call = { key: {}, connection, principalTtlMs: 100 };
  const first = scope.memoPrincipal(call, input, compute);
  await expect(first).rejects.toBe(error);
  expect(scope.memoPrincipal(call, input, compute)).toBe(first);
  await expect(
    scope.memoPrincipal({ ...call, key: {} }, input, compute),
  ).rejects.toBe(error);
  expect(compute).toHaveBeenCalledTimes(2);
  expect(scope.stateFor(connection).connections.size).toBe(0);
});

it("expires connection results and bypasses TTL for authoritative reads", async () => {
  const scope = new RequestScope();
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const connection = {};
    const compute = vi.fn(async () => absent);
    const call = () => ({ key: {}, connection, principalTtlMs: 100 });
    await scope.memoPrincipal(call(), input, compute);
    await scope.memoPrincipal(call(), input, compute);
    expect(compute).toHaveBeenCalledTimes(1);
    await scope.memoPrincipal(
      call(),
      { ...input, freshness: "authoritative" },
      compute,
    );
    expect(compute).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(1100);
    await scope.memoPrincipal(call(), input, compute);
    expect(compute).toHaveBeenCalledTimes(3);
    const failure: PrincipalResult = {
      outcome: "rejected",
      failure: AuthFailures.forbidden("TEMPORARY"),
    };
    clock.mockReturnValue(1200);
    await scope.memoPrincipal(call(), input, async () => failure);
    expect(scope.stateFor(connection).connections.size).toBe(0);
  } finally {
    clock.mockRestore();
  }
});

it("counts distinct authorization keys atomically including reclassification and isolates names", async () => {
  const scope = new RequestScope();
  const request = {};
  const pending = deferred<string>();
  const compute = vi.fn(() => pending.promise);
  const first = scope.memoPolicyIo(
    request,
    "default",
    '["org","a"]',
    compute,
    2,
  );
  expect(
    scope.memoPolicyIo(request, "default", '["org","a"]', compute, 2),
  ).toBe(first);
  const reclassification = scope.memoPolicyIo(
    request,
    "default",
    '["reclassify","session"]',
    compute,
    2,
  );
  await expect(
    scope.memoPolicyIo(request, "default", '["org","b"]', compute, 2),
  ).rejects.toMatchObject({
    status: 429,
    reason: "TOO_MANY_AUTHORIZATION_CHECKS",
  });
  const named = scope.memoPolicyIo(request, "admin", '["org","a"]', compute, 1);
  pending.resolve("ok");
  await Promise.all([first, reclassification, named]);
  expect(compute).toHaveBeenCalledTimes(3);
});

it("keeps decisions and provided values local to each invocation and instance", async () => {
  const scope = new RequestScope();
  const a = {};
  const b = {};
  const compute = vi.fn(async () => ({ effect: "allow" as const }));
  const first = scope.memoDecision(a, "default", "requirement", compute);
  expect(scope.memoDecision(a, "default", "requirement", compute)).toBe(first);
  await Promise.all([
    first,
    scope.memoDecision(b, "default", "requirement", compute),
    scope.memoDecision(a, "admin", "requirement", compute),
  ]);
  expect(compute).toHaveBeenCalledTimes(3);
  const key = Symbol("organization");
  scope.stateFor(a).values.set(scope.valueKey("default", key), "org-a");
  expect(
    scope.stateFor(a).values.get(scope.valueKey("admin", key)),
  ).toBeUndefined();
  expect(
    scope.stateFor(b).values.get(scope.valueKey("default", key)),
  ).toBeUndefined();
});
