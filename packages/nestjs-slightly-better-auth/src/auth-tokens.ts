/** Stable Nest injection tokens shared by every package copy and module format. */
function instanceToken(base: string, alias?: string): string {
  return alias === undefined || alias === "" || alias === "default"
    ? base
    : `${base}_${alias}`;
}

export function getBetterAuthInstanceToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_INSTANCE", alias);
}

export function getBetterAuthOptionsToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_OPTIONS", alias);
}

export function getBetterAuthServiceToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_SERVICE", alias);
}

export function getBetterAuthHandleToken(alias?: string): string {
  return instanceToken("NESTJS_SLIGHTLY_BETTER_AUTH_HANDLE", alias);
}

// Shared application collaborators and metadata must also survive duplicate copies.
export const INSTANCE_REGISTRY = Symbol.for(
  "nestjs-slightly-better-auth:instance-registry",
);
export const REQUEST_SCOPE = Symbol.for(
  "nestjs-slightly-better-auth:request-scope",
);
export const PRINCIPAL_READINGS = Symbol.for(
  "nestjs-slightly-better-auth:principal-readings",
);
export const ROUTE_PLANNER = Symbol.for(
  "nestjs-slightly-better-auth:route-planner",
);
export const TRANSPORT_REGISTRY = Symbol.for(
  "nestjs-slightly-better-auth:transport-registry",
);
export const POLICY_RESOLVER = Symbol.for(
  "nestjs-slightly-better-auth:policy-resolver",
);
export const MOUNT_COORDINATOR = Symbol.for(
  "nestjs-slightly-better-auth:mount-coordinator",
);
export const GUARD_CORE = Symbol.for("nestjs-slightly-better-auth:guard-core");
export const SCOPE_CORE = Symbol.for("nestjs-slightly-better-auth:scope-core");
export const PRINCIPAL_RESOLVER = Symbol.for(
  "nestjs-slightly-better-auth:principal-resolver",
);
export const POLICY_INVOKER = Symbol.for(
  "nestjs-slightly-better-auth:policy-invoker",
);
export const PLATFORMS = Symbol.for("nestjs-slightly-better-auth:platforms");
export const TRANSPORTS = Symbol.for("nestjs-slightly-better-auth:transports");
export const ACCESS_METADATA = Symbol.for("nestjs-slightly-better-auth:access");
export const ACCEPT_PRINCIPALS_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:accept-principals",
);
export const REQUIREMENTS_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:requirements",
);
export const SKIP_DEFAULT_REQUIREMENTS_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:skip-default-requirements",
);
export const FRESHNESS_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:freshness",
);
export const AUTH_INSTANCE_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:auth-instance",
);
export const PRINCIPAL_PARAMS_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:principal-params",
);
export const INVOCATION_PARAMS_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:invocation-params",
);
export const FORWARD_COOKIES_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:forward-cookies",
);
export const SKIP_ORIGIN_CHECK_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:skip-origin-check",
);
export const USE_BETTER_AUTH_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:use-better-auth",
);
export const HOOK_METADATA = Symbol.for("nestjs-slightly-better-auth:hook");
export const DB_HOOK_METADATA = Symbol.for(
  "nestjs-slightly-better-auth:db-hook",
);
export const AUTH_ENHANCER = Symbol.for("nestjs-slightly-better-auth:enhancer");

export function getPrincipalSourcesToken(instance: string): symbol {
  return Symbol.for(
    `nestjs-slightly-better-auth:principal-sources:${instance}`,
  );
}

export function getExtensionToken(
  point: "platforms" | "transports" | "principals",
  instance: string,
  index: number,
): symbol {
  return Symbol.for(
    `nestjs-slightly-better-auth:ext:${point}:${instance}:${index}`,
  );
}

export const READER_CONTEXT = Symbol.for(
  "nestjs-slightly-better-auth:reader-context",
);
export const INVOCATION_VALUES = Symbol.for(
  "nestjs-slightly-better-auth:invocation",
);
