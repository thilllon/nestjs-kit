import type {
  AuthorizationPolicy,
  BootAdvice,
  PrincipalSource,
  Requirement,
  SessionPrincipalOptions,
} from "./auth-contracts.js";
import type {
  AuthSession,
  GetSessionWithHeaders,
  SessionPrincipal,
} from "./auth-types.js";
import {
  AuthFailures,
  BetterAuthConfigurationError,
  getAPIErrorHeaders,
} from "./auth-errors.js";
import { definePrincipalParam, Require } from "./auth-decorators.js";
import type { PrincipalReadings } from "./principal-readings.js";
import { absent, authenticated, rejected } from "./principal-resolver.js";

export const SESSION_PRINCIPAL_KIND = "session" as const;
export const CurrentSession = definePrincipalParam({
  kind: SESSION_PRINCIPAL_KIND,
  reason: "SESSION_REQUIRED",
  project: (principal) => principal.session,
});
export const CurrentUser = definePrincipalParam({
  kind: SESSION_PRINCIPAL_KIND,
  reason: "SESSION_REQUIRED",
  project: (principal) =>
    "user" in principal.session ? principal.session.user : undefined,
});
export function readCurrentSession<S = AuthSession>(
  readings: PrincipalReadings,
): S | null {
  return readings.project(readings.current(), {
    kind: SESSION_PRINCIPAL_KIND,
    reason: "SESSION_REQUIRED",
    site: "BetterAuthService.getSession",
    project: (principal) => (principal as SessionPrincipal<S>).session,
  });
}
export function sessionPrincipal<S = AuthSession>(
  options: SessionPrincipalOptions<S> = {},
): PrincipalSource<SessionPrincipal<S>> {
  return {
    id: "better-auth:session",
    kinds: [SESSION_PRINCIPAL_KIND],
    acceptance: "default",
    credentialHeaders: ["cookie", "authorization"],
    sessionBacked: true,
    async resolve(request) {
      const context = await request.auth.context();
      const authoritative = request.freshness === "authoritative";
      const query = {
        ...(authoritative &&
        (context.options.database || context.options.secondaryStorage)
          ? { disableCookieCache: true }
          : {}),
        ...(request.cookies === null ? { disableRefresh: true } : {}),
      };
      let result: GetSessionWithHeaders;
      try {
        result = (await request.auth.run(
          { cookies: request.cookies, forward: "none", internal: true },
          () =>
            request.auth.api.getSession({
              headers: request.headers,
              returnHeaders: true,
              query,
            }),
        )) as GetSessionWithHeaders;
      } catch (error) {
        const failure = AuthFailures.fromAPIError(error);
        if (!failure) {
          throw error;
        }
        const cookies = getAPIErrorHeaders(error).getSetCookie();
        if (cookies.length) {
          request.cookies?.append(cookies);
        }
        return rejected(failure);
      }
      const cookies = result.headers?.getSetCookie() ?? [];
      if (cookies.length) {
        request.cookies?.append(cookies);
      }
      if (
        result.response == null ||
        (authoritative && !request.auth.producedByEndpoint(result.response))
      ) {
        return absent();
      }
      const userId = options.userId
        ? options.userId(result.response as S)
        : ((result.response as { user?: { id?: string } }).user?.id ?? null);
      if (typeof userId !== "string" || !userId) {
        throw BetterAuthConfigurationError.atRequest(
          "SESSION_USER_ID",
          "session.userId must return a nonempty user id for a resolved session",
        );
      }
      return authenticated({
        kind: SESSION_PRINCIPAL_KIND,
        source: "better-auth:session",
        userId,
        session: result.response as S,
      });
    },
    advise(context) {
      const warnings: BootAdvice[] = [];
      if (context.context.hasPlugin("jwt")) {
        warnings.push({
          level: "info",
          code: "I_SESSION_JWT_COST",
          message:
            "Unless disableSettingJwtHeader is enabled, session reads may also sign a JWT.",
        });
      }
      if (context.context.hasPlugin("bearer")) {
        warnings.push({
          level: "info",
          code: "I_SESSION_BEARER_COST",
          message:
            "Without requireSignature, foreign bearer tokens can trigger a session lookup.",
        });
      }
      const sites = context.handlers
        .filter(
          ({ plan }) =>
            (plan.access === "required" || plan.access === "optional") &&
            [...plan.accepts].some((kind) => kind !== SESSION_PRINCIPAL_KIND),
        )
        .map(({ plan }) => plan.site);
      if (sites.length) {
        warnings.push({
          level: "warn",
          code: "W_MIXED_KIND_SESSION_READER",
          message: `If these handlers read getSession(), another authenticated kind throws SESSION_REQUIRED: ${sites.slice(0, 10).join(", ")}`,
          hint: "Use getPrincipal() and narrow p.kind.",
        });
      }
      if (
        context.context.hasPlugin("api-key") &&
        options.apiKeySessions !== false
      ) {
        warnings.push({
          level: "warn",
          code: "W_API_KEY_FULL_SESSION",
          message: `${options.apiKeySessions ? "API-key sessions grant" : "If enableSessionForAPIKeys is enabled, API-key sessions grant"} full session access on ordinary authenticated routes.`,
        });
        if (
          context.policies.some(
            (policy) => policy.requires?.presentsCredentials,
          )
        ) {
          warnings.push({
            level: "warn",
            code: "W_API_KEY_SESSION_MULTIPLIER",
            message:
              "Policies presenting credentials can validate API-key sessions again and consume additional quota.",
          });
        }
      }
      if (
        context.context.hasPlugin("expo") &&
        context.originCheck.missingOrigin === "reject"
      ) {
        warnings.push({
          level: "warn",
          code: "W_ORIGIN_CHECK_NATIVE_CLIENTS",
          message:
            "Native clients must send a trusted Origin for cookie-carrying operations.",
        });
      }
      return warnings;
    },
  };
}
const freshPolicy: AuthorizationPolicy<{ maxAgeSeconds?: number }> = {
  id: "better-auth:session/fresh",
  requires: { principals: [SESSION_PRINCIPAL_KIND] },
  validate(params) {
    if (
      params.maxAgeSeconds !== undefined &&
      (!Number.isFinite(params.maxAgeSeconds) || params.maxAgeSeconds < 0)
    ) {
      throw new BetterAuthConfigurationError(
        "INVALID_FRESH_AGE",
        "maxAgeSeconds must be finite and nonnegative",
      );
    }
  },
  advise(context) {
    return context.context.hasPlugin("custom-session")
      ? [
          {
            level: "warn",
            code: "W_FRESH_SESSION_SHAPE",
            message:
              "freshSession requires custom session results to retain session.createdAt; unsupported shapes deny PRINCIPAL_NOT_SUPPORTED.",
          },
        ]
      : [];
  },
  async evaluate(params, context) {
    const principal = context.principal as SessionPrincipal;
    const createdAt = (
      principal.session as { session?: { createdAt?: unknown } }
    ).session?.createdAt;
    const age =
      params.maxAgeSeconds ??
      (await context.auth.context()).sessionConfig.freshAge;
    if (age === 0) {
      return { effect: "allow" };
    }
    if (
      !(createdAt instanceof Date) &&
      typeof createdAt !== "string" &&
      typeof createdAt !== "number"
    ) {
      return { effect: "deny", reason: "PRINCIPAL_NOT_SUPPORTED" };
    }
    const time = new Date(createdAt).getTime();
    return Number.isFinite(time) && Date.now() - time < age * 1000
      ? { effect: "allow" }
      : { effect: "deny", status: 403, reason: "SESSION_NOT_FRESH" };
  },
};
export const freshSession = (
  options: { maxAgeSeconds?: number } = {},
): Requirement<{ maxAgeSeconds?: number }> => ({
  policy: freshPolicy,
  params: options,
});
export const RequireFreshSession = (options?: {
  maxAgeSeconds?: number;
}): ClassDecorator & MethodDecorator => Require(freshSession(options));
