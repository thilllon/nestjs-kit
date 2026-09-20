import type { ModuleRef } from "@nestjs/core";
import type { AuthorizationPolicy, PolicyRef } from "./auth-contracts.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";

export class PolicyResolver {
  private readonly cache = new Map<
    PolicyRef<unknown>,
    AuthorizationPolicy<any, any>
  >();

  constructor(private readonly moduleRef: ModuleRef) {}

  resolve<P>(reference: PolicyRef<P>): AuthorizationPolicy<P, any> {
    const cached = this.cache.get(reference);
    if (cached) {
      return cached;
    }
    let policy: AuthorizationPolicy<P, any>;
    try {
      policy =
        typeof reference === "object" &&
        reference !== null &&
        "evaluate" in reference
          ? reference
          : this.moduleRef.get(reference as never, { strict: false });
    } catch {
      throw new BetterAuthConfigurationError(
        "UNRESOLVED_POLICY",
        "A requirement references a policy that is not registered as a provider",
      );
    }
    if (
      !policy ||
      typeof policy.evaluate !== "function" ||
      typeof policy.id !== "string"
    ) {
      throw new BetterAuthConfigurationError(
        "UNRESOLVED_POLICY",
        "A requirement must reference an authorization policy",
      );
    }
    this.cache.set(reference, policy);
    return policy;
  }
}
