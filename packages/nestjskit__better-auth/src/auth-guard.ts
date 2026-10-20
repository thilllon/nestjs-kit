import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type {
  AuthTransport,
  PrincipalResolver,
  RoutePlan,
  TransportCall,
} from "./auth-contracts.js";
import {
  AuthFailures,
  BetterAuthConfigurationError,
  isAuthFailure,
  isConfigurationError,
  isInfrastructureError,
} from "./auth-errors.js";
import { AUTH_ENHANCER, GUARD_CORE } from "./auth-tokens.js";
import type { AuthorizationEvaluator } from "./authorization-evaluator.js";
import type { InstanceLookup } from "./instance-registry.js";
import type { PrincipalReadings } from "./principal-readings.js";
import type { RequestScope } from "./request-scope.js";
import type { RoutePlanner } from "./route-planner.js";
import type { TransportRegistry } from "./transport-registry.js";

@Injectable()
export class BetterAuthGuard implements CanActivate {
  static readonly [AUTH_ENHANCER] = "guard";
  readonly [AUTH_ENHANCER] = "guard";

  constructor(
    @Inject(GUARD_CORE) private readonly core: Pick<GuardCore, "canActivate">,
  ) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return this.core.canActivate(context);
  }
}
export class GuardCore implements CanActivate {
  constructor(
    private readonly instances: InstanceLookup,
    private readonly planner: RoutePlanner,
    private readonly transports: TransportRegistry,
    private readonly resolver: PrincipalResolver,
    private readonly evaluator: AuthorizationEvaluator,
    private readonly scope: RequestScope,
    private readonly readings: PrincipalReadings,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let transport: AuthTransport | undefined;
    let call: TransportCall | undefined;
    let plan: RoutePlan | undefined;
    try {
      plan = this.planner.forContext(context);
      if (plan.access === "inherit") {
        transport = this.transports.find(context);
        const lineage = transport?.lineage?.(context);
        if (lineage && !this.readings.enclosing(lineage, context.getArgs())) {
          call = this.transports.describe(context, transport);
          throw BetterAuthConfigurationError.atRequest(
            "NO_ENCLOSING_DECISION",
            "An inherited invocation has no enclosing guard decision",
            { site: plan.site },
          );
        }
        if (plan.originCheck !== "form") {
          return true;
        }
      }
      if (plan.access === "public" && plan.originCheck !== "form") {
        const lineage = this.transports.find(context)?.lineage?.(context);
        if (lineage && !plan.nested) {
          this.readings.recordLineage(lineage, {
            outcome: "no-identity",
            instance: plan.instance,
          });
        }
        return true;
      }
      transport = this.transports.select(context);
      call = this.transports.describe(context, transport);
      const entry = this.instances.get(plan.instance);
      if (plan.originCheck !== "off") {
        const browser = call.browser;
        if (browser) {
          if (plan.originCheck === "form" || browser.enforce) {
            const failure = await entry.origin.check(browser, plan.originCheck);
            if (failure) {
              throw failure;
            }
          } else {
            await entry.origin.advisory(browser);
          }
        }
      }
      if (plan.access === "inherit") {
        return true;
      }
      if (plan.access === "public") {
        if (!plan.nested) {
          this.readings.record(call, {
            outcome: "no-identity",
            instance: plan.instance,
          });
        }
        return true;
      }
      const result = await this.resolver.resolve(call, {
        auth: entry.handle,
        freshness: plan.freshness,
        accepts: plan.accepts,
        sourceSet: plan.sourceSet,
      });
      this.readings.record(call, { ...result, instance: plan.instance });
      if (result.outcome === "rejected") {
        throw result.failure;
      }
      if (result.outcome === "absent") {
        if (plan.access === "optional") {
          return true;
        }
        throw AuthFailures.unauthenticated();
      }
      if (!plan.accepts.has(result.principal.kind)) {
        throw AuthFailures.forbidden("PRINCIPAL_NOT_SUPPORTED");
      }
      const decision = await this.evaluator.evaluate(
        plan,
        result.principal,
        call,
        entry,
        context,
        transport.id,
      );
      if (decision.effect === "deny") {
        throw AuthFailures.rejected({
          status: decision.status ?? 403,
          reason: decision.reason,
          message: decision.message,
          challenge: decision.challenge,
        });
      }
      return true;
    } catch (error) {
      if (isAuthFailure(error) && transport) {
        const mapping =
          plan && this.instances.get(plan.instance).options.errors?.map;
        throw mapping
          ? mapping(error, context, transport.id)
          : transport.toException(error, context);
      }
      if (
        (isConfigurationError(error) || isInfrastructureError(error)) &&
        transport
      ) {
        const repeated = call
          ? this.scope.surfaced(call.key, error, {
              instance: plan?.instance ?? "default",
              site: plan?.site ?? "guard",
              lineage: call.lineage,
            })
          : false;
        throw (
          transport.toInternalException?.(error, context, { repeated }) ?? error
        );
      }
      throw error;
    }
  }
}
