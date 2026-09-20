import "reflect-metadata";
import type { ModuleRef } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import type { AuthHookContext } from "./auth-types.js";
import type { AuthorizationPolicy, PrincipalSource } from "./auth-contracts.js";
import {
  AcceptPrincipals,
  CurrentPrincipal,
  Public,
  Require,
  RequireAuth,
  SkipDefaultRequirements,
  requirement,
  anyOf,
  allOf,
  UseAuthInstance,
  ForwardAuthCookies,
  BeforeAuth,
  readHookMetadata,
} from "./auth-decorators.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type { InstanceEntry } from "./instance-registry.js";
import { PolicyResolver } from "./policy-resolver.js";
import { RoutePlanner } from "./route-planner.js";
import { CurrentSession } from "./session-principal.js";
import { TransportRegistry } from "./transport-registry.js";

declare module "./auth-types.js" {
  interface PrincipalKinds {
    machine: {
      kind: "machine";
      source: string;
      userId: null;
      delegation?: {
        description: string;
        allows(
          permissions: Readonly<Record<string, readonly string[]>>,
        ): boolean;
      };
    };
  }
}
const sources: PrincipalSource[] = [
  {
    id: "sessions",
    kinds: ["session"],
    acceptance: "default",
    resolve: async () => ({ outcome: "absent" }),
  },
  {
    id: "machines",
    kinds: ["machine"],
    acceptance: "explicit",
    delegates: true,
    resolve: async () => ({ outcome: "absent" }),
  },
];
function fixture(
  defaultRequirements: readonly ReturnType<typeof requirement>[] = [],
  transport?: Partial<TransportRegistry>,
) {
  const entry = {
    name: "default",
    options: { defaultRequirements },
    sources,
  } as unknown as InstanceEntry;
  const entries = {
    get: (name: string) => {
      if (name !== "default") {
        throw new BetterAuthConfigurationError("UNKNOWN_INSTANCE", name);
      }
      return entry;
    },
    list: () => [entry],
  };
  const get = vi.fn();
  const policies = new PolicyResolver({ get } as unknown as ModuleRef);
  const transports = new TransportRegistry();
  Object.assign(transports, transport);
  return {
    planner: new RoutePlanner(entries, policies, transports),
    policies,
    get,
  };
}
const policy = (
  id: string,
  kinds?: ("session" | "machine")[],
): AuthorizationPolicy => ({
  id,
  requires: kinds ? { principals: kinds } : undefined,
  evaluate: () => ({ effect: "allow" }),
});

describe("route planning", () => {
  it.each([false, true])(
    "isolates inherited handler caches in either compilation order %s",
    (reverse) => {
      class Base {
        run() {}
      }
      @Public()
      class Health extends Base {}
      @RequireAuth()
      class Protected extends Base {}
      const { planner } = fixture();
      for (const target of reverse
        ? [Protected, Health]
        : [Health, Protected]) {
        planner.plan(target, "run");
      }
      expect(planner.plan(Health, "run").access).toBe("public");
      expect(planner.plan(Protected, "run").access).toBe("required");
    },
  );
  it("accumulates default/base/derived/method requirements and skips exactly defaults", () => {
    const a = requirement(policy("a"), {}),
      b = requirement(policy("b"), {}),
      c = requirement(policy("c"), {}),
      d = requirement(policy("d"), {});
    @Require(b)
    class Base {
      run() {}
    }
    @Require(c)
    class Child extends Base {
      @Require(d) override run() {}
      @SkipDefaultRequirements() other() {}
    }
    const { planner } = fixture([a]);
    expect(planner.requirementsOf(Child, "run")).toEqual([a, b, c, d]);
    expect(planner.plan(Child, "run").requirements).toEqual([a, b, c, d]);
    expect(planner.plan(Child, "other").requirements).toEqual([b, c]);
  });
  it("resolves instance field requirements once before planning and admits explicit kinds", () => {
    class Policy {
      id = "di";
      requires = { principals: ["machine"] as const, freshIdentity: true };
      evaluate() {
        return { effect: "allow" as const };
      }
    }
    class Controller {
      @Require(requirement(Policy, {})) run() {}
    }
    const { planner, policies, get } = fixture();
    const instance = new Policy();
    get.mockReturnValue(instance);
    expect(policies.resolve(Policy)).toBe(instance);
    expect(planner.plan(Controller, "run")).toMatchObject({
      freshness: "authoritative",
    });
    expect(planner.plan(Controller, "run").accepts.has("machine")).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("rejects conflicting conjunctions but handles disjunction kinds as a union", () => {
    const machine = requirement(policy("machine", ["machine"]), {}),
      session = requirement(policy("session", ["session"]), {});
    class Broken {
      @Require(allOf(machine, session)) run() {}
    }
    class Good {
      @Require(anyOf(machine, session)) run() {}
    }
    const { planner } = fixture();
    expect(() => planner.plan(Broken, "run")).toThrowError(
      expect.objectContaining({ code: "UNSATISFIABLE_PRINCIPAL_KINDS" }),
    );
    expect(planner.plan(Good, "run").accepts).toEqual(
      new Set(["session", "machine"]),
    );
  });
  it("keeps undeclared delegation out of generic policies and unknown names out of plans", () => {
    class Controller {
      @AcceptPrincipals("machine")
      @Require(requirement(policy("generic"), {}))
      run() {}
    }
    class Unknown {
      @UseAuthInstance("missing") run() {}
    }
    const { planner } = fixture();
    expect(() => planner.plan(Controller, "run")).toThrowError(
      expect.objectContaining({ code: "UNSATISFIABLE_PRINCIPAL_KINDS" }),
    );
    expect(() => planner.plan(Unknown, "run")).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_INSTANCE" }),
    );
  });
  it("rejects public parameter reads and mixed-kind constrained readers", () => {
    class PublicReader {
      @Public() run(@CurrentPrincipal() _principal: unknown) {}
    }
    class MixedReader {
      @AcceptPrincipals("session", "machine") run(
        @CurrentSession() _session: unknown,
      ) {}
    }
    const { planner } = fixture();
    expect(() => planner.plan(PublicReader, "run")).toThrowError(
      expect.objectContaining({ code: "PUBLIC_READS_PRINCIPAL" }),
    );
    expect(() => planner.plan(MixedReader, "run")).toThrowError(
      expect.objectContaining({ code: "PRINCIPAL_PARAM_CONFLICT" }),
    );
  });
  it("uses content source keys and ignores nested class access while keeping forwarding", () => {
    @Public()
    @ForwardAuthCookies()
    class Controller {
      one() {}
      two() {}
      @AcceptPrincipals("machine") @RequireAuth() machine() {}
    }
    const { planner } = fixture([], {
      // biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
      defaultAccessFor: (_target: Function, method: string) =>
        method === "two" ? "inherit" : undefined,
    });
    expect(planner.plan(Controller, "one").sourceSet).toBe(
      planner.plan(Controller, "two").sourceSet,
    );
    expect(planner.plan(Controller, "two")).toMatchObject({
      access: "inherit",
      nested: true,
      originCheck: "form",
      declares: true,
    });
    expect(planner.plan(Controller, "machine").sourceSet).not.toBe(
      planner.plan(Controller, "one").sourceSet,
    );
  });
  it("preserves hook declaration order without mutating inherited method metadata", () => {
    class Base {
      @BeforeAuth("/one") @BeforeAuth("/two") hook(_ctx: AuthHookContext) {}
    }
    class Child extends Base {
      @BeforeAuth("/three") other(_ctx: AuthHookContext) {}
    }
    expect(
      readHookMetadata(Child.prototype.hook).hooks.map((item) => item.match),
    ).toEqual(["/two", "/one"]);
    expect(readHookMetadata(Base.prototype.hook).hooks).toHaveLength(2);
    expect(readHookMetadata(Child.prototype.other).hooks).toHaveLength(1);
  });
});

it("treats nested method acceptance as a real required plan while ignoring class acceptance", () => {
  @AcceptPrincipals("machine")
  class Nested {
    classOnly() {}
    @AcceptPrincipals("machine") methodOnly() {}
    @Public() @AcceptPrincipals("machine") explicitPublic() {}
  }
  const { planner } = fixture([], { defaultAccessFor: () => "inherit" });
  expect(planner.plan(Nested, "classOnly")).toMatchObject({
    access: "inherit",
    sourceSet: "[0]",
  });
  expect(planner.plan(Nested, "methodOnly")).toMatchObject({
    access: "required",
    sourceSet: "[1]",
  });
  expect(planner.plan(Nested, "explicitPublic").access).toBe("public");
});
