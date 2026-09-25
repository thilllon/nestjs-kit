import assert from "node:assert/strict";
import { Inject, Injectable, Scope } from "@nestjs/common";
import { APIError } from "better-auth/api";
import type {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationPolicy,
  Requirement,
} from "./auth-contracts.js";
import { Require } from "./auth-decorators.js";
import {
  isAuthFailure,
  isConfigurationError,
  isInfrastructureError,
} from "./auth-errors.js";
import type { AuthPrincipal } from "./auth-types.js";
import {
  bootIssueCodes,
  type ConformanceCase,
  conformanceCase,
  conformanceSkip,
  type ConformanceOutcome,
  createConformanceAuth,
  settle,
} from "./conformance-fixtures.js";
import {
  betterAuthCalls,
  boot,
  type Harness,
  hasPlugin,
  KIT_ROUTE,
  type PolicyConformanceOptions,
  requirementsOf,
  sdkContext,
  sessionHeaders,
  sessionReads,
  staticPolicies,
  withHarness,
} from "./conformance-policy-harness.js";
import { unitPolicyCases } from "./conformance-policy-units.js";

export type { PolicyConformanceOptions } from "./conformance-policy-harness.js";

const noGrant = {
  description: "conformance: no grant",
  allows: () => false,
};

/**
 * The evaluator's answer to a session that ended between the guard's read and the policy's call: 401 (the guard's
 * UNAUTHENTICATED) with Better Auth's generic code as `reason`, or UNAUTHENTICATED when the 401 carried no code.
 */
function isSessionLoss(decision: AuthorizationDecision): boolean {
  return (
    decision.effect === "deny" &&
    decision.status === 401 &&
    (decision.reason === "UNAUTHORIZED" ||
      decision.reason === "UNAUTHENTICATED")
  );
}

/** Storage operations on the session model since `from` (database reads and writes of sessions). */
function sessionStorage(storage: readonly string[], from: number): number {
  return storage.slice(from).filter((entry) => entry.endsWith(":session"))
    .length;
}

const SCOPED_DEPENDENCY =
  "nestjs-slightly-better-auth:conformance/request-scoped-dependency";

/**
 * The unit's first policy as a DI class policy with one injected dependency, whose provider scope the case chooses:
 * the same requirement then boots with a singleton dependency and fails B11 with a request-scoped one.
 */
function classPolicyFor(policy: AuthorizationPolicy<unknown>) {
  @Injectable()
  class ConformanceClassPolicy implements AuthorizationPolicy<unknown> {
    readonly id = `${policy.id}#conformance-class`;
    readonly requires = policy.requires;

    constructor(
      @Inject(SCOPED_DEPENDENCY)
      readonly dependency: { readonly scope: string },
    ) {}

    evaluate(
      params: unknown,
      context: AuthorizationContext,
    ): AuthorizationDecision | Promise<AuthorizationDecision> {
      return policy.evaluate(params, context as never);
    }
  }
  return ConformanceClassPolicy;
}

/**
 * The authorization-policy kit (invariants Z1–Z6 and the unit-specific rows of design §14.1). Each principal is judged
 * through the real AuthorizationEvaluator, so the delegation gate, error normalization and the per-invocation
 * decision memo apply exactly as in the guard; an infrastructure error thrown here is the guard's 5xx. Cases that
 * need route planning, acceptance or principal resolution send an in-process request through the real
 * BetterAuthGuard. Storage outages are injected into the instance's database adapter, so an endpoint that swallows a
 * storage error into a 401 is exercised; APIError mapping uses the probe plugin's before hook. Requirements must name
 * policy objects (see PolicyConformanceOptions.requirement). Unit-specific cases run when the requirement contains
 * the built-in admin, organization or API-key policy and skip with the reason otherwise.
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
  const infraThrows =
    (warmCache: boolean) =>
    async ({ decide, probe, auth }: Harness): Promise<ConformanceOutcome> => {
      const principal = await options.allowingPrincipal();
      if (warmCache && (!principal.userId || principal.delegation)) {
        return conformanceSkip(
          "the allowing principal carries no session cookie for a cookie cache",
        );
      }
      const headers = warmCache
        ? await sessionHeaders(auth, principal.userId!, { warmCache: true })
        : undefined;
      if (headers === null) {
        return conformanceSkip(
          "the instance's session.cookieCache is off; run the kit on an instance with session.cookieCache.enabled for this variant",
        );
      }
      const customSession = await hasPlugin(auth, "custom-session");
      let calls = probe.calls.length;
      let storage = probe.storage.length;
      const result = await settle(() =>
        decide(principal, {
          ...(headers ? { headers } : {}),
          beforeEvaluate: () => {
            calls = probe.calls.length;
            storage = probe.storage.length;
            probe.storageFault = () => new Error("conformance storage outage");
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
      if (customSession && result.ok && isSessionLoss(result.value)) {
        // RK2: customSession swallows the failure of its inner session read, the re-classification read included.
        return;
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
    };
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
      "a storage outage after the session read is infrastructure, never a denial (cookie cache off)",
      infraThrows(false),
    ),
    add(
      "Z-infra-throws",
      "a storage outage after the session read is infrastructure, never a denial (warm cookie cache)",
      infraThrows(true),
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
      "Z-policy-session-lost",
      "a session lost before the policy's call is 401, a storage failure there is 5xx, each with one re-read per request",
      async ({ decide, probe, auth }) => {
        const principal = await options.allowingPrincipal();
        if (principal.source !== "better-auth:session" || !principal.userId) {
          return conformanceSkip(
            "the allowing principal is not a session principal of the built-in session source",
          );
        }
        const userId = principal.userId;
        const sdk = await sdkContext(auth);
        const customSession = await hasPlugin(auth, "custom-session");
        // Revoked: both invocations of one request answer 401 and share one re-classification read.
        const revoked = {
          key: {},
          headers: await sessionHeaders(auth, userId),
        };
        let reads = probe.calls.length;
        let storage = probe.storage.length;
        const first = await decide(principal, {
          key: revoked.key,
          invocation: {},
          headers: revoked.headers!,
          beforeEvaluate: async () => {
            await sdk.internalAdapter.deleteUserSessions(userId);
            reads = probe.calls.length;
            storage = probe.storage.length;
          },
        });
        if (
          first.effect === "allow" &&
          sessionStorage(probe.storage, storage) === 0
        ) {
          return conformanceSkip(
            "the policy's Better Auth calls do not read the principal's session",
          );
        }
        const second = await decide(principal, {
          key: revoked.key,
          invocation: {},
          headers: revoked.headers!,
        });
        for (const decision of [first, second]) {
          assert.ok(
            isSessionLoss(decision),
            `a session revoked before the policy's call must deny 401 UNAUTHENTICATED: ${JSON.stringify(decision)}`,
          );
        }
        assert.equal(
          sessionReads(probe, reads),
          1,
          `two invocations of one request re-read the session ${sessionReads(probe, reads)} times`,
        );
        // Storage failure at the same point: infrastructure (customSession: the documented 401, RK2).
        const failing = {
          key: {},
          headers: await sessionHeaders(auth, userId),
        };
        const outcomes = [];
        for (const index of [0, 1]) {
          outcomes.push(
            await settle(() =>
              decide(principal, {
                key: failing.key,
                invocation: {},
                headers: failing.headers!,
                beforeEvaluate: () => {
                  if (index === 0) {
                    reads = probe.calls.length;
                  }
                  probe.storageFault = () =>
                    new Error("conformance storage outage");
                },
              }),
            ),
          );
        }
        probe.storageFault = undefined;
        for (const outcome of outcomes) {
          if (customSession) {
            assert.ok(
              outcome.ok && isSessionLoss(outcome.value),
              `with customSession a storage failure must answer the documented 401: ${outcome.ok ? JSON.stringify(outcome.value) : String(outcome.error)}`,
            );
          } else {
            assert.ok(
              !outcome.ok && isInfrastructureError(outcome.error),
              `a storage failure at the policy's call must be infrastructure: ${JSON.stringify(outcome.ok && outcome.value)}`,
            );
          }
        }
        assert.equal(
          sessionReads(probe, reads),
          1,
          `two invocations of one request re-read the session ${sessionReads(probe, reads)} times during the outage`,
        );
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
      "Z-singleton",
      "the policy as a class with a request-scoped dependency fails boot; with a singleton dependency it boots",
      async () => {
        const leaf = requirementsOf(options.requirement)[0]!;
        const policy = known[0]!;
        const bootWith = (scope: Scope) => {
          const ClassPolicy = classPolicyFor(policy);
          const requirement: Requirement = {
            ...leaf,
            policy: ClassPolicy as never,
          };
          return settle(() =>
            boot(options.auth, leaf, {
              routes: { [KIT_ROUTE]: [Require(requirement)] },
              sources: options.sources,
              providers: [
                ClassPolicy,
                {
                  provide: SCOPED_DEPENDENCY,
                  useFactory: () => ({ scope: String(scope) }),
                  scope,
                },
              ],
            }),
          );
        };
        const singleton = await bootWith(Scope.DEFAULT);
        if (!singleton.ok) {
          assert.fail(
            `the class policy with a singleton dependency failed boot: ${String(singleton.error)}`,
          );
        }
        await singleton.value.moduleRef.close();
        const scoped = await bootWith(Scope.REQUEST);
        if (scoped.ok) {
          await scoped.value.moduleRef.close();
          assert.fail("a class policy with a request-scoped dependency booted");
        }
        assert.ok(
          bootIssueCodes(scoped.error).includes("NON_SINGLETON_EXTENSION"),
          `boot did not report NON_SINGLETON_EXTENSION (B11): ${String(scoped.error)}`,
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
    ...unitPolicyCases(options, known),
  ];
}
