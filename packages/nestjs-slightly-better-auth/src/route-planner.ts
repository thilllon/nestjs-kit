import type { ExecutionContext, Type } from "@nestjs/common";
import type { RequirementExpr, RoutePlan } from "./auth-contracts.js";
import {
  BetterAuthConfigurationError,
  isConfigurationError,
} from "./auth-errors.js";
import * as keys from "./auth-tokens.js";
import type { InstanceLookup } from "./instance-registry.js";
import type { PolicyResolver } from "./policy-resolver.js";
import type { TransportRegistry } from "./transport-registry.js";

function classes(target: Type): object[] {
  const result: object[] = [];
  for (
    let current: object | null = target;
    current && current !== Function.prototype;
    current = Object.getPrototypeOf(current)
  ) {
    result.push(current);
  }
  return result;
}
function own<T>(key: symbol, target: object): T | undefined {
  return Reflect.getOwnMetadata(key, target);
}
function closest<T>(key: symbol, targets: readonly object[]): T | undefined {
  for (const target of targets) {
    const value = own<T>(key, target);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}
// biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
export function methodName(target: Type, handler: Function): string {
  for (
    let prototype = target.prototype;
    prototype && prototype !== Object.prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (
        name !== "constructor" &&
        Object.getOwnPropertyDescriptor(prototype, name)?.value === handler
      ) {
        return name;
      }
    }
  }
  throw new BetterAuthConfigurationError(
    "UNKNOWN_HANDLER",
    `Cannot locate handler on ${target.name}`,
  );
}
export class RoutePlanner {
  // biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
  private readonly cache = new WeakMap<Type, WeakMap<Function, RoutePlan>>();

  constructor(
    private readonly instances: InstanceLookup,
    private readonly policies: PolicyResolver,
    private readonly transports: TransportRegistry,
  ) {}

  private prepare(target: Type, method: string) {
    // biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
    const handler = Reflect.get(target.prototype, method) as Function;
    if (typeof handler !== "function") {
      throw new BetterAuthConfigurationError(
        "UNKNOWN_HANDLER",
        `${target.name}.${method} is not a handler`,
      );
    }
    const chain = classes(target);
    const nested =
      this.transports.defaultAccessFor(target, method) === "inherit";
    const levels = nested ? [handler] : [handler, ...chain];
    const site = `${target.name}.${method}`;
    for (const level of levels) {
      const access = own<string>(keys.ACCESS_METADATA, level);
      if (
        (access === "public" || access === "optional") &&
        (own<readonly RequirementExpr[]>(keys.REQUIREMENTS_METADATA, level)
          ?.length ?? 0) > 0
      ) {
        throw new BetterAuthConfigurationError(
          "CONTRADICTORY_ACCESS",
          `${site} combines anonymous access and requirements at the same level`,
        );
      }
    }
    const instance =
      closest<string>(keys.AUTH_INSTANCE_METADATA, [handler, ...chain]) ??
      "default";
    const entry = this.instances.get(instance);
    let access: RoutePlan["access"] = nested
      ? "inherit"
      : entry.options.defaultAccess === "public"
        ? "public"
        : "required";
    for (const level of levels) {
      const declared = own<RoutePlan["access"]>(keys.ACCESS_METADATA, level);
      if (declared) {
        access = declared;
        break;
      }
      if (
        (own<readonly RequirementExpr[]>(keys.REQUIREMENTS_METADATA, level)
          ?.length ?? 0) > 0 ||
        (nested && own(keys.ACCEPT_PRINCIPALS_METADATA, level) !== undefined)
      ) {
        access = "required";
        break;
      }
    }
    const skips =
      closest<boolean>(keys.SKIP_DEFAULT_REQUIREMENTS_METADATA, levels) ===
      true;
    const requirements =
      access === "required"
        ? [
            ...(skips ? [] : (entry.options.defaultRequirements ?? [])),
            ...(nested
              ? []
              : [...chain]
                  .reverse()
                  .flatMap(
                    (level) =>
                      own<readonly RequirementExpr[]>(
                        keys.REQUIREMENTS_METADATA,
                        level,
                      ) ?? [],
                  )),
            ...(own<readonly RequirementExpr[]>(
              keys.REQUIREMENTS_METADATA,
              handler,
            ) ?? []),
          ]
        : [];
    return {
      handler,
      chain,
      levels,
      nested,
      site,
      instance,
      entry,
      access,
      skips,
      requirements,
    };
  }

  requirementsOf(target: Type, method: string): readonly RequirementExpr[] {
    return Object.freeze(this.prepare(target, method).requirements);
  }

  forContext(context: ExecutionContext): RoutePlan {
    try {
      return this.plan(
        context.getClass(),
        methodName(context.getClass(), context.getHandler()),
      );
    } catch (error) {
      if (isConfigurationError(error) && error.phase !== "request") {
        throw BetterAuthConfigurationError.atRequest(error.code, error.detail, {
          site: `${context.getClass().name}.${context.getHandler().name}`,
          hint: error.hint,
        });
      }
      throw error;
    }
  }

  plan(target: Type, method: string): RoutePlan {
    // biome-ignore lint/complexity/noBannedTypes: Nest handler metadata preserves the framework function identity.
    const handler = Reflect.get(target.prototype, method) as Function;
    let cache = this.cache.get(target);
    const previous = cache?.get(handler);
    if (previous) {
      return previous;
    }
    const p = this.prepare(target, method);
    const { entry, levels, chain } = p;
    const allKinds = new Set<string>(
      entry.sources.flatMap((source) => [...source.kinds]),
    );
    const accepts = new Set(
      closest<readonly string[]>(keys.ACCEPT_PRINCIPALS_METADATA, levels) ??
        entry.sources
          .filter((source) => source.acceptance === "default")
          .flatMap((source) => [...source.kinds]),
    );
    let fresh =
      closest<boolean>(keys.FRESHNESS_METADATA, levels) === true ||
      (entry.options.session !== false &&
        entry.options.session?.freshness === "authoritative");
    const admitted = (expression: RequirementExpr): Set<string> => {
      if ("anyOf" in expression) {
        return new Set(
          expression.anyOf.flatMap((child) => [...admitted(child)]),
        );
      }
      if ("allOf" in expression) {
        return intersection(expression.allOf.map(admitted), allKinds);
      }
      const policy = this.policies.resolve(expression.policy);
      const kinds = expression.principals ?? policy.requires?.principals;
      if (expression.freshIdentity ?? policy.requires?.freshIdentity) {
        fresh = true;
      }
      if (kinds) {
        for (const kind of kinds) {
          accepts.add(kind);
        }
      }
      return new Set(
        kinds ??
          entry.sources
            .filter((source) => !source.delegates)
            .flatMap((source) => [...source.kinds]),
      );
    };
    const permitted = p.requirements.map(admitted);
    for (const kind of accepts) {
      if (!allKinds.has(kind)) {
        throw new BetterAuthConfigurationError(
          "UNKNOWN_PRINCIPAL_KIND",
          `${p.site} accepts unavailable principal kind ${kind}`,
        );
      }
    }
    const parameters =
      own<readonly { index: number; kind?: string; reason?: string }[]>(
        keys.PRINCIPAL_PARAMS_METADATA,
        handler,
      ) ?? [];
    if (p.access === "public" && parameters.length) {
      throw new BetterAuthConfigurationError(
        "PUBLIC_READS_PRINCIPAL",
        `${p.site} reads a principal on a public handler`,
        "Use OptionalAuth",
      );
    }
    const principalParams = parameters.flatMap((param) =>
      param.kind ? [{ kind: param.kind, reason: param.reason! }] : [],
    );
    if (p.access !== "inherit") {
      for (const param of principalParams) {
        if ([...accepts].some((kind) => kind !== param.kind)) {
          throw new BetterAuthConfigurationError(
            "PRINCIPAL_PARAM_CONFLICT",
            `${p.site} admits a kind rejected by its principal parameter`,
            "Use CurrentPrincipal and narrow kind",
          );
        }
      }
    }
    if (
      p.access === "required" &&
      permitted.length &&
      !intersection([accepts, ...permitted], allKinds).size
    ) {
      throw new BetterAuthConfigurationError(
        "UNSATISFIABLE_PRINCIPAL_KINDS",
        `${p.site} has no principal kind satisfying its requirements`,
      );
    }
    const forwardDirectCalls =
      closest<boolean>(keys.FORWARD_COOKIES_METADATA, [handler, ...chain]) ??
      entry.options.cookies?.forwardDirectCalls ??
      false;
    const originCheck =
      closest<boolean>(keys.SKIP_ORIGIN_CHECK_METADATA, [handler, ...chain]) ||
      entry.options.originCheck?.mode === "off"
        ? "off"
        : forwardDirectCalls
          ? "form"
          : "cookie";
    const declares =
      forwardDirectCalls ||
      levels.some((level) => {
        const access = own<string>(keys.ACCESS_METADATA, level);
        return (
          access === "required" ||
          access === "optional" ||
          [
            keys.ACCEPT_PRINCIPALS_METADATA,
            keys.REQUIREMENTS_METADATA,
            keys.PRINCIPAL_PARAMS_METADATA,
            keys.INVOCATION_PARAMS_METADATA,
          ].some((key) => own(key, level) !== undefined)
        );
      });
    const plan: RoutePlan = Object.freeze({
      instance: p.instance,
      access: p.access,
      nested: p.nested,
      site: p.site,
      requirements: Object.freeze(p.requirements),
      skipsDefaultRequirements: p.access === "required" && p.skips,
      freshness: fresh ? "authoritative" : "default",
      accepts,
      principalParams: Object.freeze(principalParams),
      originCheck,
      sourceSet: JSON.stringify(
        entry.sources.flatMap((source, index) =>
          source.kinds.some((kind) => accepts.has(kind)) ? [index] : [],
        ),
      ),
      forwardDirectCalls,
      declares,
    });
    if (!cache) {
      cache = new WeakMap();
      this.cache.set(target, cache);
    }
    cache.set(handler, plan);
    return plan;
  }
}
function intersection(
  sets: readonly ReadonlySet<string>[],
  universe: ReadonlySet<string>,
): Set<string> {
  return new Set(
    [...universe].filter((kind) => sets.every((set) => set.has(kind))),
  );
}
