import { isAPIError } from "better-auth/api";
import type {
  AuthorizationContext,
  AuthorizationPolicy,
  BootAdvice,
  BootAdviceContext,
  Requirement,
  RequirementExpr,
} from "./auth-contracts.js";
import { defineInvocationParam, Require } from "./auth-decorators.js";
import { BetterAuthConfigurationError } from "./auth-errors.js";
import type { OrgPermissions, SessionPrincipal } from "./auth-types.js";
export type { OrgPermissions } from "./auth-types.js";
export interface OrganizationRef {
  (ctx: AuthorizationContext): unknown | Promise<unknown>;
  readonly missingReason?: string;
}
export interface OrgPermissionParams {
  readonly permissions: OrgPermissions;
  readonly organization: OrganizationRef;
}
export interface OrgMemberParams {
  readonly organization: OrganizationRef;
}
export const ACTIVE_ORGANIZATION_ID = Symbol.for(
  "nestjs-slightly-better-auth:org:active-organization-id",
);
export const ACTIVE_MEMBER_ROLE = Symbol.for(
  "nestjs-slightly-better-auth:org:active-member-role",
);
export const ActiveOrganizationId = defineInvocationParam(
  ACTIVE_ORGANIZATION_ID,
  { missing: "ORGANIZATION_REQUIRED" },
);
export const ActiveMemberRole = defineInvocationParam(ACTIVE_MEMBER_ROLE, {
  missing: "MEMBER_ROLE_REQUIRED",
});
const REF = Symbol.for("nestjs-slightly-better-auth:org:ref");
type MarkedRef = OrganizationRef & {
  readonly [REF]?: { kind: "active" } | { kind: "param"; name: string };
};
interface OrgApi {
  hasPermission(input: {
    headers: Headers;
    body: { organizationId: string; permissions: OrgPermissions };
  }): Promise<{ success: boolean }>;
  getActiveMemberRole(input: {
    headers: Headers;
    query: { organizationId: string };
  }): Promise<{ role?: string | null }>;
  getActiveMember(input: {
    headers: Headers;
  }): Promise<{ organizationId?: string }>;
}
export function organizationRef(
  resolve: (ctx: AuthorizationContext) => unknown | Promise<unknown>,
  options: { missingReason?: string } = {},
): OrganizationRef {
  return Object.assign((ctx: AuthorizationContext) => resolve(ctx), options);
}
export function activeOrganization(): OrganizationRef {
  return Object.assign(
    organizationRef(
      async (ctx) => {
        const session = (ctx.principal as SessionPrincipal).session as {
          session?: { activeOrganizationId?: unknown };
        };
        const value = session.session?.activeOrganizationId;
        if (value !== undefined) {
          return value;
        }
        if (!(await ctx.auth.hasPlugin("custom-session"))) {
          return undefined;
        }
        try {
          const member = await ctx.memo(
            JSON.stringify(["org:activeMember"]),
            () =>
              ctx.auth.run(
                {
                  cookies: ctx.cookies,
                  inbound: () => ctx.headers,
                  internal: true,
                },
                () =>
                  (ctx.auth.api as unknown as OrgApi).getActiveMember({
                    headers: ctx.headers,
                  }),
              ),
          );
          return member?.organizationId;
        } catch (error) {
          if (
            isAPIError(error) &&
            error.statusCode === 400 &&
            (error.body?.code === "NO_ACTIVE_ORGANIZATION" ||
              error.body?.code === "MEMBER_NOT_FOUND")
          ) {
            return undefined;
          }
          throw error;
        }
      },
      { missingReason: "NO_ACTIVE_ORGANIZATION" },
    ),
    { [REF]: { kind: "active" as const } },
  );
}
export function fromParam(name: string): OrganizationRef {
  return Object.assign(
    organizationRef((ctx) => ctx.param(name)),
    { [REF]: { kind: "param" as const, name } },
  );
}
export function fromHeader(name: string): OrganizationRef {
  return organizationRef((ctx) => ctx.headers.get(name));
}
function requirements(expressions: readonly RequirementExpr[]): Requirement[] {
  return expressions.flatMap((expression) =>
    "anyOf" in expression
      ? requirements(expression.anyOf)
      : "allOf" in expression
        ? requirements(expression.allOf)
        : [expression],
  );
}
function advise(
  ctx: BootAdviceContext,
  policy: AuthorizationPolicy<any, any>,
): BootAdvice[] {
  const advice: BootAdvice[] = [];
  for (const handler of ctx.handlers) {
    for (const requirement of requirements(handler.plan.requirements)) {
      if (requirement.policy !== policy) {
        continue;
      }
      const ref = (requirement.params as OrgMemberParams)
        .organization as MarkedRef;
      const marker = ref[REF];
      if (marker?.kind === "active") {
        const input = handler.inputs.find((name) =>
          ["orgId", "organizationId", "organization", "orgSlug"].includes(name),
        );
        if (input) {
          advice.push({
            level: "warn",
            code: "W_ORG_PARAM_IGNORED",
            message: `${handler.plan.site} checks the active organization but accepts ${input}.`,
            hint:
              input === "orgSlug"
                ? "Map the slug to an ID with organizationRef and auth.api.listOrganizations({ headers })."
                : `Use fromParam('${input}').`,
          });
        }
      } else if (
        marker?.kind === "param" &&
        !handler.inputs.includes(marker.name)
      ) {
        advice.push({
          level: "warn",
          code: "W_ORG_PARAM_MISSING",
          message: `${handler.plan.site} reads ${marker.name}, absent from claimed inputs: ${handler.inputs.join(", ") || "none"}.`,
          hint: "Use the correct input name, a method-level organizationRef, or SkipDefaultRequirements with a method-level requirement.",
        });
      }
    }
  }
  return advice;
}
const requires = {
  plugins: ["organization"],
  principals: ["session" as const],
  presentsCredentials: true,
};
export const orgPermissionPolicy: AuthorizationPolicy<
  OrgPermissionParams,
  SessionPrincipal
> = {
  id: "better-auth:organization/permission", // gitleaks:allow: public policy identifier
  requires,
  advise: (ctx) => advise(ctx, orgPermissionPolicy),
  validate({ permissions }) {
    if (
      !Object.keys(permissions).length ||
      Object.values(permissions).some(
        (actions) => !Array.isArray(actions) || !actions.length,
      )
    ) {
      throw new BetterAuthConfigurationError(
        "EMPTY_PERMISSIONS",
        "Organization permissions must contain a resource and actions.",
      );
    }
  },
  async evaluate({ permissions, organization }, context) {
    const organizationId = await organization(context);
    if (typeof organizationId !== "string" || !organizationId.trim()) {
      return {
        effect: "deny",
        reason: organization.missingReason ?? "ORGANIZATION_REQUIRED",
      };
    }
    const stable = Object.entries(permissions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([resource, actions]) => [resource, [...actions].sort()]);
    try {
      const result = await context.memo(
        JSON.stringify(["org:hasPermission", organizationId, stable]),
        () =>
          context.auth.run(
            {
              cookies: context.cookies,
              inbound: () => context.headers,
              internal: true,
            },
            () =>
              (context.auth.api as unknown as OrgApi).hasPermission({
                headers: context.headers,
                body: { organizationId, permissions },
              }),
          ),
      );
      if (!result.success) {
        return { effect: "deny", reason: "MISSING_PERMISSION" };
      }
      context.provide(ACTIVE_ORGANIZATION_ID, organizationId);
      return { effect: "allow" };
    } catch (error) {
      if (
        isAPIError(error) &&
        error.body?.code === "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION"
      ) {
        return {
          effect: "deny",
          reason: "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION",
        };
      }
      throw error;
    }
  },
};
export const orgMemberPolicy: AuthorizationPolicy<
  OrgMemberParams,
  SessionPrincipal
> = {
  id: "better-auth:organization/member",
  requires,
  advise: (ctx) => advise(ctx, orgMemberPolicy),
  async evaluate({ organization }, context) {
    const organizationId = await organization(context);
    if (typeof organizationId !== "string" || !organizationId.trim()) {
      return {
        effect: "deny",
        reason: organization.missingReason ?? "ORGANIZATION_REQUIRED",
      };
    }
    try {
      const result = await context.memo(
        JSON.stringify(["org:activeMemberRole", organizationId]),
        () =>
          context.auth.run(
            {
              cookies: context.cookies,
              inbound: () => context.headers,
              internal: true,
            },
            () =>
              (context.auth.api as unknown as OrgApi).getActiveMemberRole({
                headers: context.headers,
                query: { organizationId },
              }),
          ),
      );
      if (typeof result.role !== "string" || !result.role.trim()) {
        return {
          effect: "deny",
          reason: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
        };
      }
      context.provide(ACTIVE_ORGANIZATION_ID, organizationId);
      context.provide(ACTIVE_MEMBER_ROLE, result.role);
      return { effect: "allow" };
    } catch (error) {
      if (
        isAPIError(error) &&
        error.body?.code === "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION"
      ) {
        return {
          effect: "deny",
          reason: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
        };
      }
      throw error;
    }
  },
};
export function orgPermission<N extends string = "default">(
  permissions: OrgPermissions<N>,
  options: { organization?: OrganizationRef } = {},
): Requirement<OrgPermissionParams> {
  return {
    policy: orgPermissionPolicy,
    params: {
      permissions: permissions as OrgPermissions,
      organization: options.organization ?? activeOrganization(),
    },
  };
}
export function RequireOrgPermission<N extends string = "default">(
  permissions: OrgPermissions<N>,
  options?: { organization?: OrganizationRef },
): ClassDecorator & MethodDecorator {
  return Require(orgPermission<N>(permissions, options));
}
export function orgMember(
  options: { organization?: OrganizationRef } = {},
): Requirement<OrgMemberParams> {
  return {
    policy: orgMemberPolicy,
    params: { organization: options.organization ?? activeOrganization() },
  };
}
export function RequireOrgMember(options?: {
  organization?: OrganizationRef;
}): ClassDecorator & MethodDecorator {
  return Require(orgMember(options));
}
