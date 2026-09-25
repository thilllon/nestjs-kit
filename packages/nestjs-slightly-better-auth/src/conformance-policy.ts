import assert from "node:assert/strict";
import { Controller, Get, type ExecutionContext } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { APIError } from "better-auth/api";
import type {
  AuthorizationDecision,
  AuthorizationPolicy,
  PolicyInvoker,
  PrincipalResolver,
  PrincipalSource,
  Requirement,
  RequirementExpr,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import { Require } from "./auth-decorators.js";
import {
  BetterAuthConfigurationError,
  isAuthFailure,
  isConfigurationError,
  isInfrastructureError,
} from "./auth-errors.js";
import { BetterAuthModule } from "./auth-module.js";
import {
  INSTANCE_REGISTRY,
  POLICY_INVOKER,
  POLICY_RESOLVER,
  PRINCIPAL_RESOLVER,
  REQUEST_SCOPE,
  ROUTE_PLANNER,
} from "./auth-tokens.js";
import type { AuthLike, AuthPrincipal } from "./auth-types.js";
import { AuthorizationEvaluator } from "./authorization-evaluator.js";
import {
  bootIssueCodes,
  type ConformanceCase,
  conformanceCase,
  conformanceSkip,
  type ConformanceOutcome,
  createConformanceAuth,
  probeOf,
  type ProbeState,
  settle,
} from "./conformance-fixtures.js";
import type { InstanceRegistry } from "./instance-registry.js";
import type { PolicyResolver } from "./policy-resolver.js";
import type { RequestScope } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import { authHeadersFor } from "./testing.js";

export interface PolicyConformanceOptions {
  /**
   * The requirement to judge. Its policies must be policy objects: the kit boots no application providers, so a class
   * or token reference cannot resolve. For a DI policy, pass an instance built with its dependencies (new MyPolicy(deps)).
   */
  requirement: RequirementExpr;
  /**
   * The Better Auth instance the principals belong to. It must include conformanceProbePlugin(), testUtils(), the
   * policy's plugins and nestjs(): createConformanceAuth({ plugins }) builds one. Session principals are judged with
   * real session headers for their user (testUtils().getAuthHeaders).
   */
  auth: AuthLike;
  allowingPrincipal(): Promise<AuthPrincipal>;
  denyingPrincipal(): Promise<AuthPrincipal>;
  delegatedPrincipal?(): Promise<AuthPrincipal>;
}

function requirementsOf(expression: RequirementExpr): Requirement[] {
  return "anyOf" in expression
    ? expression.anyOf.flatMap(requirementsOf)
    : "allOf" in expression
      ? expression.allOf.flatMap(requirementsOf)
      : [expression];
}

function isPolicyObject(value: unknown): value is AuthorizationPolicy<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as AuthorizationPolicy<unknown>).evaluate === "function"
  );
}

/** The policy objects of a requirement; the kit rejects class and token references up front. */
function staticPolicies(
  expression: RequirementExpr,
): AuthorizationPolicy<unknown>[] {
  return requirementsOf(expression).map((item) => {
    if (!isPolicyObject(item.policy)) {
      throw new BetterAuthConfigurationError(
        "CONFORMANCE_POLICY_OBJECT_REQUIRED",
        `policyConformance received a requirement whose policy is a class or injection token (${String((item.policy as { name?: unknown })?.name ?? item.policy)}); the kit registers no application providers to resolve it.`,
        "Pass the policy object, e.g. requirement(new MyPolicy(dependencies), params).",
      );
    }
    return item.policy;
  });
}

function controllerFor(expression: RequirementExpr) {
  @Controller()
  class PolicyConformanceController {
    @Get("nestjs-slightly-better-auth-policy-conformance")
    handle(): void {}
  }
  Require(expression)(
    PolicyConformanceController.prototype,
    "handle",
    Object.getOwnPropertyDescriptor(
      PolicyConformanceController.prototype,
      "handle",
    )!,
  );
  return PolicyConformanceController;
}

interface Harness {
  readonly probe: ProbeState;
  readonly invocations: { count: number };
  readonly policies: PolicyResolver;
  decide(
    principal: AuthPrincipal,
    call?: {
      key?: object;
      invocation?: object;
      /** Runs after the principal's session headers exist, right before evaluation. */
      beforeEvaluate?: () => void;
    },
  ): Promise<AuthorizationDecision>;
  close(): Promise<void>;
}

/**
 * Placeholder sources for the non-session kinds a requirement names, so boot validation (B15) sees producers of
 * every judged kind. They never resolve anything: the kit hands principals to the evaluator directly.
 */
function kindSources(expression: RequirementExpr): PrincipalSource[] {
  const kinds = new Set<string>();
  const policies = staticPolicies(expression);
  requirementsOf(expression).forEach((item, index) => {
    for (const kind of item.principals ??
      policies[index]?.requires?.principals ??
      []) {
      kinds.add(kind);
    }
  });
  kinds.delete("session");
  return [...kinds].map((kind) => ({
    id: `nestjs-slightly-better-auth:conformance-kind:${kind}`,
    kinds: [kind] as PrincipalSource["kinds"],
    acceptance: "explicit",
    delegates: true,
    resolve: async () => ({ outcome: "absent" }) as const,
  }));
}

async function boot(
  auth: AuthLike,
  expression: RequirementExpr,
): Promise<{
  moduleRef: TestingModule;
  controller: ReturnType<typeof controllerFor>;
}> {
  const controller = controllerFor(expression);
  const moduleRef = await Test.createTestingModule({
    imports: [
      BetterAuthModule.forRoot({
        auth,
        principals: kindSources(expression),
        http: { mount: false },
        logSummary: false,
      } as never),
    ],
    controllers: [controller],
  }).compile();
  moduleRef.useLogger(false);
  try {
    await moduleRef.init();
  } catch (error) {
    await moduleRef.close().catch(() => undefined);
    throw error;
  }
  return { moduleRef, controller };
}

async function harness(options: PolicyConformanceOptions): Promise<Harness> {
  const probe = await probeOf(options.auth);
  const { moduleRef, controller } = await boot(
    options.auth,
    options.requirement,
  );
  const real = moduleRef.get<PolicyInvoker>(POLICY_INVOKER);
  const invocations = { count: 0 };
  const counting: PolicyInvoker = {
    invoke(policy, params, context) {
      invocations.count++;
      return real.invoke(policy, params, context);
    },
  };
  const policies = moduleRef.get<PolicyResolver>(POLICY_RESOLVER);
  const evaluator = new AuthorizationEvaluator(
    policies,
    counting,
    moduleRef.get<PrincipalResolver>(PRINCIPAL_RESOLVER),
    moduleRef.get<RequestScope>(REQUEST_SCOPE),
  );
  const plan: RoutePlan = moduleRef
    .get<RoutePlanner>(ROUTE_PLANNER)
    .plan(controller, "handle");
  const entry = moduleRef
    .get<InstanceRegistry>(INSTANCE_REGISTRY)
    .get("default");
  const execution = {
    getClass: () => controller,
    getHandler: () => controller.prototype.handle,
    getArgs: () => [],
    getArgByIndex: () => undefined,
    getType: () => "nestjs-slightly-better-auth:conformance",
  } as unknown as ExecutionContext;
  return {
    probe,
    invocations,
    policies,
    async decide(principal, ids = {}) {
      const headers =
        principal.userId && !principal.delegation
          ? await authHeadersFor(options.auth, principal.userId)
          : new Headers();
      const key = ids.key ?? {};
      const call: TransportCall = {
        key,
        invocation: ids.invocation ?? key,
        headers: () => new Headers(headers),
        clientIp: null,
        cookies: null,
        param: () => undefined,
      };
      ids.beforeEvaluate?.();
      return evaluator.evaluate(
        plan,
        principal,
        call,
        entry,
        execution,
        "conformance",
      );
    },
    close: () => moduleRef.close(),
  };
}

async function withHarness(
  options: PolicyConformanceOptions,
  fn: (harness: Harness) => Promise<ConformanceOutcome>,
): Promise<ConformanceOutcome> {
  const value = await harness(options);
  try {
    return await fn(value);
  } finally {
    value.probe.fault = undefined;
    value.probe.storageFault = undefined;
    await value.close();
  }
}

/**
 * Judges one principal against a requirement through the real evaluator, as policyConformance does, and reports how
 * many policy evaluations ran. The principal-source kit uses it for the policy rows of S-apikey-org-key.
 */
export async function judgePrincipal(
  auth: AuthLike,
  requirement: RequirementExpr,
  principal: AuthPrincipal,
): Promise<{ decision: AuthorizationDecision; evaluations: number }> {
  const unused = async (): Promise<AuthPrincipal> => principal;
  const value = await harness({
    requirement,
    auth,
    allowingPrincipal: unused,
    denyingPrincipal: unused,
  });
  try {
    const decision = await value.decide(principal);
    return { decision, evaluations: value.invocations.count };
  } finally {
    await value.close();
  }
}

function betterAuthCalls(probe: ProbeState, from: number): string[] {
  return probe.calls.slice(from).filter((path) => path !== "/get-session");
}

const noGrant = {
  description: "conformance: no grant",
  allows: () => false,
};

/**
 * The authorization-policy kit (invariants Z1–Z6). Each principal is judged through the real AuthorizationEvaluator,
 * so the delegation gate, error normalization and the per-invocation decision memo apply exactly as in the guard; an
 * infrastructure error thrown here is the guard's 5xx. Storage outages are injected into the instance's database
 * adapter, so an endpoint that swallows a storage error into a 401 is exercised; APIError mapping uses the probe
 * plugin's before hook. Requirements must name policy objects (see PolicyConformanceOptions.requirement).
 */
export function policyConformance(
  options: PolicyConformanceOptions,
): ConformanceCase[] {
  const add = (
    id: string,
    title: string,
    run: (harness: Harness) => Promise<ConformanceOutcome>,
    skip?: string,
  ) => conformanceCase(id, title, () => withHarness(options, run), skip);
  const known = staticPolicies(options.requirement);
  // Z5 is about leaves that name no kinds; a leaf that names the delegated kind may allow it, so any naming leaf skips.
  const kindsNamed = requirementsOf(options.requirement).some(
    (item, index) =>
      item.principals !== undefined ||
      known[index]?.requires?.principals !== undefined,
  );
  const plugins = [
    ...new Set(known.flatMap((policy) => policy.requires?.plugins ?? [])),
  ];
  return [
    add(
      "Z-deny-decision",
      "the allowing principal is allowed and the denying principal gets a deny value, never a throw",
      async ({ decide }) => {
        const allowed = await decide(await options.allowingPrincipal());
        assert.equal(
          allowed.effect,
          "allow",
          `the allowing principal was denied: ${JSON.stringify(allowed)}`,
        );
        const result = await settle(async () =>
          decide(await options.denyingPrincipal()),
        );
        assert.equal(
          result.ok,
          true,
          `the policy threw for a denial: ${String(!result.ok && result.error)}`,
        );
        const decision = result.ok ? result.value : undefined;
        assert.equal(decision?.effect, "deny");
        assert.equal(
          typeof (decision as { reason?: unknown }).reason,
          "string",
        );
      },
    ),
    add(
      "Z-infra-throws",
      "a storage outage after the session read is infrastructure, never a denial",
      async ({ decide, probe }) => {
        const principal = await options.allowingPrincipal();
        let calls = probe.calls.length;
        let storage = probe.storage.length;
        const result = await settle(() =>
          decide(principal, {
            beforeEvaluate: () => {
              calls = probe.calls.length;
              storage = probe.storage.length;
              probe.storageFault = () =>
                new Error("conformance storage outage");
            },
          }),
        );
        probe.storageFault = undefined;
        if (
          betterAuthCalls(probe, calls).length === 0 &&
          probe.storage.length === storage
        ) {
          return conformanceSkip(
            "the policy read no storage and called no Better Auth endpoint for the allowing principal",
          );
        }
        assert.equal(
          result.ok,
          false,
          `a storage outage was decided: ${JSON.stringify(result.ok && result.value)}`,
        );
        assert.ok(
          isInfrastructureError(!result.ok && result.error),
          String(!result.ok && result.error),
        );
      },
    ),
    add(
      "Z-apierror-mapping",
      "APIErrors escaping the policy map to re-classification, denials, 429, configuration and infrastructure errors",
      async ({ decide, probe }) => {
        const principal = await options.allowingPrincipal();
        const sessionBacked = principal.source === "better-auth:session";
        const variants: {
          error: () => unknown;
          expect: (
            result: Awaited<ReturnType<typeof settle<AuthorizationDecision>>>,
          ) => void;
        }[] = [
          ...[
            () => new APIError("UNAUTHORIZED"),
            () =>
              new APIError("UNAUTHORIZED", {
                code: "UNAUTHORIZED",
                message: "Unauthorized",
              }),
          ].map((error) => ({
            error,
            expect: (
              result: Awaited<ReturnType<typeof settle<AuthorizationDecision>>>,
            ) => {
              if (sessionBacked) {
                assert.ok(
                  !result.ok && isInfrastructureError(result.error),
                  `a generic 401 with a live session must be infrastructure: ${JSON.stringify(result.ok && result.value)}`,
                );
              } else {
                assert.deepEqual(result.ok && result.value, {
                  effect: "deny",
                  status: 401,
                  reason: "UNAUTHENTICATED",
                });
              }
            },
          })),
          {
            error: () =>
              new APIError("UNAUTHORIZED", {
                code: "CONFORMANCE_CODED",
                message: "coded",
              }),
            expect: (result) => {
              assert.equal(result.ok && result.value.effect, "deny");
              assert.equal(
                result.ok && (result.value as { reason?: string }).reason,
                "CONFORMANCE_CODED",
              );
              assert.equal(
                result.ok && (result.value as { status?: number }).status,
                403,
              );
            },
          },
          {
            error: () =>
              new APIError("FORBIDDEN", {
                code: "CONFORMANCE_FORBIDDEN",
                message: "forbidden",
              }),
            expect: (result) => {
              assert.equal(
                result.ok && (result.value as { reason?: string }).reason,
                "CONFORMANCE_FORBIDDEN",
              );
            },
          },
          {
            error: () => new APIError("TOO_MANY_REQUESTS"),
            expect: (result) => {
              assert.ok(
                !result.ok &&
                  isAuthFailure(result.error) &&
                  result.error.status === 429,
                "a 429 must propagate as a rate-limit failure",
              );
            },
          },
          {
            error: () => new APIError("BAD_REQUEST", { code: "CONFORMANCE" }),
            expect: (result) => {
              assert.ok(
                !result.ok && isConfigurationError(result.error),
                "another 4xx must be a configuration error",
              );
            },
          },
          {
            error: () => new APIError("INTERNAL_SERVER_ERROR"),
            expect: (result) => {
              assert.ok(
                !result.ok && isInfrastructureError(result.error),
                "a 5xx must be infrastructure",
              );
            },
          },
        ];
        for (const variant of variants) {
          const from = probe.calls.length;
          probe.fault = (path) =>
            path === "/get-session" ? undefined : variant.error();
          const result = await settle(() => decide(principal));
          probe.fault = undefined;
          if (betterAuthCalls(probe, from).length === 0) {
            return conformanceSkip(
              "the policy calls no Better Auth endpoint for the allowing principal",
            );
          }
          variant.expect(result);
        }
      },
    ),
    add(
      "Z-delegation-scope",
      "a delegated principal is never allowed beyond its own grant",
      async ({ decide }) => {
        const principal = await options.delegatedPrincipal!();
        assert.ok(
          principal.delegation,
          "delegatedPrincipal() must carry delegation",
        );
        const narrowed = { ...principal, delegation: noGrant } as AuthPrincipal;
        const decision = await decide(narrowed);
        assert.equal(
          decision.effect,
          "deny",
          "the policy widened a delegated principal beyond its grant",
        );
      },
      options.delegatedPrincipal
        ? undefined
        : "the options give no delegatedPrincipal()",
    ),
    add(
      "Z-delegation-unnamed-denied",
      "a requirement that names no kinds never judges a delegated principal",
      async ({ decide }) => {
        const principal = options.delegatedPrincipal
          ? await options.delegatedPrincipal()
          : ({
              ...(await options.allowingPrincipal()),
              delegation: { description: "conformance", allows: () => true },
            } as AuthPrincipal);
        const decision = await decide(principal);
        // anyOf denials add a status and a joined message; the effect and reason are the invariant.
        assert.equal(decision.effect, "deny", JSON.stringify(decision));
        assert.equal(
          (decision as { reason?: string }).reason,
          "PRINCIPAL_NOT_SUPPORTED",
          JSON.stringify(decision),
        );
      },
      kindsNamed
        ? "a requirement leaf names the principal kinds it judges"
        : undefined,
    ),
    add(
      "Z-per-invocation",
      "decisions are per invocation while identical inputs share one Better Auth call",
      async ({ decide, probe, invocations }) => {
        const principal = await options.allowingPrincipal();
        const key = {};
        const first = {};
        const from = probe.calls.length;
        await decide(principal, { key, invocation: first });
        const afterFirst = betterAuthCalls(probe, from).length;
        const count = invocations.count;
        await decide(principal, { key, invocation: {} });
        assert.ok(
          invocations.count > count,
          "a decision was reused for another invocation",
        );
        assert.equal(
          betterAuthCalls(probe, from).length,
          afterFirst,
          "identical inputs in one request called Better Auth again",
        );
        const reused = invocations.count;
        await decide(principal, { key, invocation: first });
        assert.equal(
          invocations.count,
          reused,
          "one invocation evaluated the same requirement twice",
        );
      },
    ),
    conformanceCase(
      "Z-boot-prerequisite",
      "an instance without the policy's plugin prerequisites fails boot",
      async () => {
        const result = await settle(() =>
          boot(createConformanceAuth(), options.requirement),
        );
        if (result.ok) {
          await result.value.moduleRef.close();
          assert.fail("an instance without the policy's plugins booted");
        }
        assert.ok(
          bootIssueCodes(result.error).includes("PLUGIN_PREREQUISITE"),
          String(result.error),
        );
      },
      plugins.length
        ? undefined
        : "the policy declares no plugin prerequisites",
    ),
  ];
}
