import { isAPIError } from "better-auth/api";
import type { AuthorizationPolicy, Requirement } from "./auth-contracts.js";
import { Require } from "./auth-decorators.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type {
  AdminPermissions,
  AuthPrincipal,
  PrincipalKind,
} from "./auth-types.js";
export type { AdminPermissions } from "./auth-types.js";
export interface PermissionOptions {
  principals?: readonly PrincipalKind[];
}
export interface AdminPermissionParams {
  readonly permissions: AdminPermissions;
}
interface AdminApi {
  userHasPermission(input: {
    body: {
      userId: string;
      role?: string;
      permissions: Readonly<Record<string, readonly string[]>>;
    };
  }): Promise<{ success: boolean }>;
}
export const adminPermissionPolicy: AuthorizationPolicy<
  AdminPermissionParams,
  AuthPrincipal
> = {
  id: "better-auth:admin/permission",
  requires: {
    plugins: ["admin"],
    principals: ["session"],
    freshIdentity: true,
    hostlessCalls: true,
  },
  validate({ permissions }) {
    if (
      !Object.keys(permissions).length ||
      Object.values(permissions).some(
        (actions) => !Array.isArray(actions) || !actions.length,
      )
    ) {
      throw new BetterAuthConfigurationError(
        "EMPTY_PERMISSIONS",
        "Admin permissions must contain a resource and actions.",
      );
    }
  },
  async evaluate({ permissions }, context) {
    const { principal } = context;
    if (!principal.userId) {
      return { effect: "deny", reason: "USER_REQUIRED" };
    }
    const userId = principal.userId;
    let role: string | undefined;
    if (principal.delegation) {
      const owner = await context.memo(
        JSON.stringify(["admin:owner", userId]),
        async () =>
          (await context.auth.context()).internalAdapter.findUserById(userId),
      );
      if (!owner) {
        return { effect: "deny", status: 401, reason: "USER_NOT_FOUND" };
      }
      if (
        owner.banned &&
        (!owner.banExpires || new Date(owner.banExpires).getTime() > Date.now())
      ) {
        return { effect: "deny", status: 401, reason: "USER_BANNED" };
      }
      if (typeof owner.role === "string" && owner.role.length) {
        role = owner.role;
      }
    }
    const stablePermissions = Object.entries(permissions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([resource, actions]) => [resource, [...actions].sort()]);
    try {
      const result = await context.memo(
        JSON.stringify([
          "admin:userHasPermission",
          userId,
          role ?? null,
          stablePermissions,
        ]),
        () =>
          context.auth.run(
            {
              cookies: context.cookies,
              inbound: () => context.headers,
              internal: true,
            },
            () =>
              (context.auth.api as unknown as AdminApi).userHasPermission({
                body: {
                  userId,
                  permissions,
                  ...(role === undefined ? {} : { role }),
                },
              }),
          ),
      );
      if (!result.success) {
        return { effect: "deny", reason: "MISSING_PERMISSION" };
      }
    } catch (error) {
      if (
        isAPIError(error) &&
        error.statusCode === 400 &&
        error.body?.message === "user not found"
      ) {
        return { effect: "deny", status: 401, reason: "USER_NOT_FOUND" };
      }
      throw error;
    }
    if (principal.delegation && !principal.delegation.allows(permissions)) {
      return { effect: "deny", reason: "INSUFFICIENT_SCOPE" };
    }
    return { effect: "allow" };
  },
};
export function permission<N extends string = "default">(
  permissions: AdminPermissions<N>,
  options: PermissionOptions = {},
): Requirement<AdminPermissionParams> {
  return {
    policy: adminPermissionPolicy,
    params: { permissions: permissions as AdminPermissions },
    ...(options.principals ? { principals: options.principals } : {}),
  };
}
export function RequirePermission<N extends string = "default">(
  permissions: AdminPermissions<N>,
  options?: PermissionOptions,
): ClassDecorator & MethodDecorator {
  return Require(permission<N>(permissions, options));
}
