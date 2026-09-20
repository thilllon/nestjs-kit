import { IntrinsicException } from "@nestjs/common/exceptions/intrinsic.exception.js";
import { describe, expect, it, vi } from "vitest";
import type {
  InvocationLineage,
  PrincipalReading,
  TransportCall,
} from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  isConfigurationError,
} from "./auth-errors.js";
import { PrincipalReadings } from "./principal-readings.js";
import { RequestScope } from "./request-scope.js";

const principal: Extract<PrincipalReading, { outcome: "authenticated" }> = {
  instance: "admin",
  outcome: "authenticated",
  principal: {
    kind: "session",
    source: "session",
    userId: "one",
    session: {
      session: {
        id: "s",
        userId: "one",
        token: "opaque",
        expiresAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      user: {
        id: "one",
        name: "One",
        email: "one@example.test",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    },
  },
};
function lineage(
  carrier: object,
  position: string,
  enclosing: readonly string[],
  assertReadable?: InvocationLineage["assertReadable"],
): InvocationLineage {
  return { carrier, position, enclosing: () => enclosing, assertReadable };
}
const inherited = {
  access: "inherit",
  instance: "default",
  site: "Fields.owner",
} as const;
function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("Expected a throw");
}

describe("principal readings", () => {
  it("reads the nearest enclosing position across instances without sibling leakage", () => {
    const readers = new PrincipalReadings(new RequestScope());
    const carrier = {};
    readers.recordLineage(lineage(carrier, "1:me", []), {
      instance: "default",
      outcome: "absent",
    });
    readers.recordLineage(lineage(carrier, "1:reports", []), principal);
    expect(
      readers.read({
        args: [],
        plan: inherited,
        lineage: lineage(carrier, "1:reports.0.owner", [
          "1:reports.0",
          "1:reports",
        ]),
      }),
    ).toBe(principal);
    expect(
      readers.read({
        args: [],
        plan: inherited,
        lineage: lineage(carrier, "1:me.id", ["1:me"]),
      }),
    ).toMatchObject({ outcome: "absent", instance: "default" });
    expect(() =>
      readers.read({
        args: [],
        plan: inherited,
        lineage: lineage(carrier, "2:reports.owner", ["2:reports"]),
      }),
    ).toThrow("Authentication is misconfigured");
  });

  it("validates authenticated inherited reads with the current arguments, leaving no-identity lazy", () => {
    const readers = new PrincipalReadings(new RequestScope());
    const carrier = {};
    const error = BetterAuthConfigurationError.atRequest(
      "GRAPHQL_CONTEXT_UNRECOGNIZED",
      "No live request",
    );
    const live = vi.fn(() => {
      throw error;
    });
    readers.recordLineage(lineage(carrier, "1:reports", []), principal);
    const args = [{ current: true }];
    expect(() =>
      readers.read({
        args,
        plan: inherited,
        lineage: lineage(carrier, "1:reports.id", ["1:reports"], live),
      }),
    ).toThrow(error);
    expect(live).toHaveBeenCalledWith(args);
    readers.recordLineage(lineage(carrier, "1:public", []), {
      instance: "default",
      outcome: "no-identity",
    });
    expect(
      readers.read({
        args,
        plan: inherited,
        lineage: lineage(carrier, "1:public.id", ["1:public"], live),
      }),
    ).toMatchObject({ outcome: "no-identity" });
    expect(live).toHaveBeenCalledTimes(1);
  });

  it("finds transport metadata without DI and validates the reader's own args", () => {
    const readers = new PrincipalReadings(new RequestScope());
    const carrier = {};
    const assertReadable = vi.fn();
    readers.recordLineage(
      {
        carrier,
        position: "1:root",
        enclosing: (args) => [String(args[0])],
        assertReadable,
      },
      principal,
    );
    const args = ["1:root", {}, carrier, {}];
    expect(readers.read({ args })).toBe(principal);
    expect(assertReadable).toHaveBeenCalledWith(args);
  });

  it("keeps public reads independent of throwing transport capabilities", () => {
    const readers = new PrincipalReadings(new RequestScope());
    const call = {
      get headers(): never {
        throw new Error("must stay lazy");
      },
      get cookies(): never {
        throw new Error("must stay lazy");
      },
    } as unknown as TransportCall;
    expect(
      readers.read({
        args: [],
        call,
        plan: { access: "public", instance: "default", site: "Public.index" },
      }),
    ).toEqual({ outcome: "no-identity", instance: "default" });
  });

  it("accepts equivalent HTTP argument arrays but rejects sibling invocation stamps", () => {
    const readers = new PrincipalReadings(new RequestScope());
    const req = {};
    const response = {};
    const args = [req, response, undefined];
    readers.stamp(args, "default", { outcome: "absent" });
    expect(readers.read({ args: [...args] })).toMatchObject({
      outcome: "absent",
    });
    expect(() => readers.read({ args: [req, {}, undefined] })).toThrow(
      "Authentication is misconfigured",
    );
    const socket = {};
    const first = [socket, { payload: "one" }];
    const second = [socket, { payload: "two" }];
    readers.stamp(first, "default", { outcome: "absent" });
    readers.stamp(second, "default", {
      outcome: "authenticated",
      principal: principal.principal,
    });
    expect(readers.read({ args: first })).toMatchObject({ outcome: "absent" });
    expect(readers.read({ args: second })).toMatchObject({
      outcome: "authenticated",
    });
  });

  it("does not downgrade wrong-kind authenticated readings to anonymous", () => {
    const scope = new RequestScope();
    const readers = new PrincipalReadings(scope);
    const spec = {
      kind: "session",
      reason: "SESSION_REQUIRED",
      site: "Fields.session",
      project: () => "value",
    };
    const input = { args: [{}] };
    // PrincipalKinds is augmentable; model a separately installed machine source.
    const machine = {
      instance: "admin",
      outcome: "authenticated",
      principal: { kind: "machine", source: "machine", userId: null },
    } as unknown as PrincipalReading;
    const first = caught(() => readers.project(machine, spec, input));
    const second = caught(() => readers.project(machine, spec, input));
    expect(first).toMatchObject({
      code: "SESSION_REQUIRED",
      message: "Authentication is misconfigured",
    });
    expect(first).not.toBeInstanceOf(IntrinsicException);
    expect(second).toBeInstanceOf(IntrinsicException);
    expect(isConfigurationError(second)).toBe(true);
    expect(second).toMatchObject({
      code: "SESSION_REQUIRED",
      extensions: { reason: "AUTH_MISCONFIGURED" },
    });
    expect(
      readers.project({ outcome: "absent", instance: "admin" }, spec),
    ).toBeNull();
  });

  it("shares guard and reader error delivery and partitions carrier-only batches", () => {
    const scope = new RequestScope();
    const readers = new PrincipalReadings(scope);
    const carrier = {};
    const request = {};
    const firstLineage = lineage(carrier, "1:root", []);
    const error = () =>
      BetterAuthConfigurationError.atRequest("SESSION_REQUIRED", "specific", {
        site: "Fields.session",
      });
    expect(
      scope.surfaced(request, error(), {
        instance: "admin",
        site: "Fields.session",
        lineage: firstLineage,
      }),
    ).toBe(false);
    expect(
      readers.deliver(
        error(),
        { args: [], lineage: lineage(carrier, "1:root.20", ["1:root"]) },
        "admin",
      ),
    ).toBeInstanceOf(IntrinsicException);
    expect(
      readers.deliver(
        error(),
        { args: [], lineage: lineage(carrier, "2:root", []) },
        "admin",
      ),
    ).not.toBeInstanceOf(IntrinsicException);
    expect(
      readers.deliver(error(), { args: [], lineage: firstLineage }, "other"),
    ).not.toBeInstanceOf(IntrinsicException);
    expect(
      readers.deliver(
        BetterAuthConfigurationError.atRequest("NO_AUTH_RESULT", "specific", {
          site: "Fields.session",
        }),
        { args: [], lineage: firstLineage },
        "admin",
      ),
    ).not.toBeInstanceOf(IntrinsicException);
  });

  it("does not invent a shared scope for unscoped service calls", () => {
    const readers = new PrincipalReadings(new RequestScope());
    const first = caught(() => readers.current());
    const second = caught(() => readers.current());
    expect(first).toMatchObject({ code: "NO_AUTH_SCOPE" });
    expect(second).toMatchObject({ code: "NO_AUTH_SCOPE" });
    expect(second).not.toBeInstanceOf(IntrinsicException);
    expect(second).not.toBe(first);
  });
});

it("uses own invocation results over enclosing results and keeps named results distinct", () => {
  const readers = new PrincipalReadings(new RequestScope());
  const carrier = {};
  const invocation = {};
  const parent = lineage(carrier, "1:parent", []);
  const nested = lineage(carrier, "1:parent.child", ["1:parent"]);
  readers.recordLineage(parent, principal);
  readers.record(
    { invocation, lineage: nested },
    { outcome: "absent", instance: "default" },
  );
  readers.record({ invocation }, { ...principal, instance: "admin" });
  const call = { invocation, lineage: nested } as TransportCall;
  expect(
    readers.read({
      args: [],
      call,
      plan: { access: "optional", instance: "default", site: "Fields.child" },
    }),
  ).toMatchObject({ outcome: "absent" });
  expect(
    readers.read({
      args: [],
      call,
      plan: { access: "required", instance: "admin", site: "Fields.child" },
    }),
  ).toMatchObject({ outcome: "authenticated", instance: "admin" });
});

it("reports missing guard ordering distinctly and deduplicates by handler site", () => {
  const readers = new PrincipalReadings(new RequestScope());
  const args = [{}];
  const plan = {
    access: "required",
    instance: "default",
    site: "Reports.root",
  } as const;
  expect(
    caught(() => readers.read({ args, plan, beforeGuard: true })),
  ).toMatchObject({ code: "PRINCIPAL_READ_BEFORE_GUARD" });
  const missing = caught(() => readers.read({ args, plan }));
  expect(missing).toMatchObject({ code: "NO_AUTH_RESULT" });
  expect(missing).not.toBeInstanceOf(IntrinsicException);
  expect(caught(() => readers.read({ args, plan }))).toBeInstanceOf(
    IntrinsicException,
  );
  expect(
    caught(() =>
      readers.read({ args, plan: { ...plan, site: "Reports.other" } }),
    ),
  ).not.toBeInstanceOf(IntrinsicException);
});

it("deduplicates lineage-only readers by their operation rather than the last recorded sibling", () => {
  const readers = new PrincipalReadings(new RequestScope());
  const carrier = {};
  const enclosing = (args: readonly unknown[]) => [String(args[0])];
  readers.recordLineage({ carrier, position: "1:root", enclosing }, principal);
  readers.recordLineage({ carrier, position: "2:root", enclosing }, principal);
  const error = () =>
    BetterAuthConfigurationError.atRequest("SESSION_REQUIRED", "specific", {
      site: "Fields.session",
    });
  const first = { args: ["1:root", carrier] };
  const second = { args: ["2:root", carrier] };
  expect(readers.deliver(error(), first, "admin")).not.toBeInstanceOf(
    IntrinsicException,
  );
  expect(readers.deliver(error(), second, "admin")).not.toBeInstanceOf(
    IntrinsicException,
  );
  expect(readers.deliver(error(), first, "admin")).toBeInstanceOf(
    IntrinsicException,
  );
});
