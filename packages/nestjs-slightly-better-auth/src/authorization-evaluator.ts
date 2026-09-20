import type { ExecutionContext } from "@nestjs/common";
import type {
  AuthorizationContext,
  AuthorizationDecision,
  AuthorizationPolicy,
  PolicyInvoker,
  PrincipalResolver,
  Requirement,
  RequirementExpr,
  RequirementOptions,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import type {
  AuthPrincipal,
  PrincipalKind,
  PrincipalOfKind,
} from "./auth-types.js";
import { createInfrastructureError, isAuthFailure } from "./auth-errors.js";
import { INVOCATION_VALUES } from "./auth-tokens.js";
import type { InstanceEntry } from "./instance-registry.js";
import type { PolicyResolver } from "./policy-resolver.js";
import {
  MemoKeys,
  normalizeForRequest,
  requestHeaders,
} from "./principal-resolver.js";
import type { RequestScope } from "./request-scope.js";
import { methodName } from "./route-planner.js";

export const allow = (): AuthorizationDecision => ({ effect: "allow" });
export const deny = (input: {
  reason: string;
  status?: 401 | 403;
  message?: string;
  challenge?: string;
}): AuthorizationDecision => ({ effect: "deny", ...input });
export function definePolicy<P, K extends PrincipalKind = PrincipalKind>(
  policy: AuthorizationPolicy<P, PrincipalOfKind<K>>,
): (params: P, options?: RequirementOptions) => Requirement<P> {
  return (params, options) => ({ policy, params, ...options });
}
export class DefaultPolicyInvoker implements PolicyInvoker {
  async invoke<P>(
    policy: AuthorizationPolicy<P, any>,
    params: P,
    context: AuthorizationContext,
  ): Promise<AuthorizationDecision> {
    return policy.evaluate(params, context);
  }
}
export class AuthorizationEvaluator {
  private readonly keys = new MemoKeys();

  constructor(
    private readonly policies: PolicyResolver,
    private readonly invoker: PolicyInvoker,
    private readonly resolver: PrincipalResolver,
    private readonly scope: RequestScope,
  ) {}

  async evaluate(
    plan: RoutePlan,
    principal: AuthPrincipal,
    call: TransportCall,
    entry: InstanceEntry,
    execution: ExecutionContext,
    transport: string,
  ): Promise<AuthorizationDecision> {
    if (!plan.requirements.length) {
      return allow();
    }
    const headers = requestHeaders(call, entry);
    const context: AuthorizationContext = {
      principal,
      instance: entry.name,
      transport,
      headers,
      cookies: call.cookies,
      request: call.request,
      param: (name) => call.param(name),
      handler: {
        class: execution.getClass(),
        method: methodName(execution.getClass(), execution.getHandler()),
      },
      auth: entry.handle,
      execution,
      memo: <T>(
        key: string | object | symbol,
        fn: () => Promise<T>,
      ): Promise<T> =>
        this.scope.memoPolicyIo(
          call.key,
          entry.name,
          this.keys.key(call.key, "policy-io", key),
          fn,
          entry.options.limits?.maxAuthorizationCallsPerRequest,
        ),
      provide: (slot, value) => {
        this.scope
          .stateFor(call.invocation)
          .values.set(this.scope.valueKey(entry.name, slot), value);
        let instances = Reflect.get(call.invocation, INVOCATION_VALUES) as
          | Map<string, Map<symbol, unknown>>
          | undefined;
        if (!instances) {
          instances = new Map();
          Object.defineProperty(call.invocation, INVOCATION_VALUES, {
            value: instances,
          });
        }
        let values = instances.get(entry.name);
        if (!values) {
          values = new Map();
          instances.set(entry.name, values);
        }
        values.set(slot, value);
      },
    };
    const evaluate = (
      expression: RequirementExpr,
    ): Promise<AuthorizationDecision> =>
      this.scope.memoDecision(
        call.invocation,
        entry.name,
        this.keys.key(call.invocation, "decision", expression),
        async () => {
          if ("anyOf" in expression || "allOf" in expression) {
            const disjunction = "anyOf" in expression;
            const children =
              "anyOf" in expression ? expression.anyOf : expression.allOf;
            const denials: Extract<
              AuthorizationDecision,
              { effect: "deny" }
            >[] = [];
            for (const child of children) {
              const decision = await evaluate(child);
              if (decision.effect === "allow" && disjunction) {
                return decision;
              }
              if (decision.effect === "deny") {
                if (!disjunction) {
                  return decision;
                }
                denials.push(decision);
              }
            }
            if (!disjunction) {
              return allow();
            }
            return deny({
              reason: denials[0]?.reason ?? "NO_REQUIREMENT_SATISFIED",
              status: denials.some((d) => d.status === 401) ? 401 : 403,
              message: children
                .map((child) =>
                  "policy" in child
                    ? (child.label ?? this.policies.resolve(child.policy).id)
                    : "requirement group",
                )
                .join(" or "),
            });
          }
          const policy = this.policies.resolve(expression.policy);
          const kinds = expression.principals ?? policy.requires?.principals;
          if (
            (kinds && !kinds.includes(principal.kind)) ||
            (!kinds && principal.delegation)
          ) {
            return deny({ reason: "PRINCIPAL_NOT_SUPPORTED" });
          }
          try {
            return await entry.handle.run(
              {
                cookies: call.cookies,
                forward: "same-credential",
                inbound: () => headers,
                internal: true,
              },
              () => this.invoker.invoke(policy, expression.params, context),
            );
          } catch (error) {
            const normalized = normalizeForRequest(
              error,
              "policy",
              plan.site,
              entry,
              headers,
            );
            if (isAuthFailure(normalized)) {
              if (normalized.status === 429) {
                throw normalized;
              }
              return deny({
                status: normalized.status,
                reason: normalized.reason ?? normalized.code,
                message: normalized.message,
                challenge: normalized.challenge,
              });
            }
            const source = entry.sources.find(
              (item) => item.id === principal.source && item.sessionBacked,
            );
            if (source) {
              await this.scope.memoPolicyIo(
                call.key,
                entry.name,
                JSON.stringify(["reclassify", source.id]),
                async () => {
                  const result = await this.resolver.resolve(call, {
                    auth: entry.handle,
                    freshness: "authoritative",
                    accepts: plan.accepts,
                    sourceSet: plan.sourceSet,
                    reclassify: { sourceId: source.id },
                  });
                  if (result.outcome === "authenticated") {
                    throw createInfrastructureError(normalized.sessionLoss, {
                      headers,
                      credentialHeaders: entry.credentialHeaders,
                      exposeRawCause: entry.options.errors?.exposeRawCause,
                    });
                  }
                  return result;
                },
                entry.options.limits?.maxAuthorizationCallsPerRequest,
              );
            }
            return deny({
              status: 401,
              reason: normalized.reason ?? "UNAUTHENTICATED",
            });
          }
        },
      );
    for (const expression of plan.requirements) {
      const decision = await evaluate(expression);
      if (decision.effect === "deny") {
        return decision;
      }
    }
    return allow();
  }
}
