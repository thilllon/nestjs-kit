import { role } from "better-auth/plugins/access";
import type {
  AuthHandle,
  AuthPrincipalBase,
  AuthorizationPolicy,
  PrincipalDelegation,
  PrincipalSource,
  Requirement,
} from "./auth-contracts.js";
import { Require } from "./auth-decorators.js";
import {
  AuthFailures,
  BetterAuthConfigurationError,
  BetterAuthInfrastructureError,
  normalizeThrown,
} from "./auth-errors.js";
import { absent, authenticated, rejected } from "./principal-resolver.js";

export const API_KEY_PRINCIPAL_KIND = "api-key" as const;
export interface ApiKeyPrincipal extends AuthPrincipalBase {
  readonly kind: "api-key";
  readonly keyId: string;
  readonly configId: string | null;
  readonly referenceId: string;
  readonly userId: string | null;
  readonly organizationId: string | null;
  readonly permissions: Readonly<Record<string, readonly string[]>> | null;
  readonly delegation: PrincipalDelegation;
}
// The public module identity survives declaration bundling in both output formats.
declare module "nestjs-slightly-better-auth" {
  interface PrincipalKinds {
    "api-key": ApiKeyPrincipal;
  }
}
export interface ApiKeyPrincipalOptions {
  header?: string;
  configId?: string;
  references?:
    | "user"
    | "organization"
    | ((key: { readonly configId: string | null }) => "user" | "organization");
  /**
   * Default true: slow INVALID_API_KEY results (>500 ms) throw infrastructure errors,
   * then fast failures share one read/no-op-write probe per second per instance.
   * false disables both checks; { slowMs: false } keeps only the probe.
   * Set slowMs below pool lock/statement timeouts and above custom hashing costs.
   * Fast failures confined to one row, or secondary storage without database fallback,
   * may still look like invalid keys. A statement-level trigger can observe the zero-row write.
   */
  outageProbe?: boolean | { readonly slowMs?: number | false };
  acceptance?: "default" | "explicit";
}
interface VerifiedKey {
  id: string;
  configId?: string | null;
  referenceId: string;
  permissions?: Record<string, readonly string[]> | null;
}
interface Verification {
  valid: boolean;
  key?: VerifiedKey | null;
  error?: { code?: string; details?: { tryAgainIn?: number } } | null;
}
interface KeyApi {
  verifyApiKey(input: {
    body: { key: string; configId?: string };
    headers: Headers;
  }): Promise<Verification>;
}
export function apiKeyPrincipal(
  options: ApiKeyPrincipalOptions = {},
): PrincipalSource<ApiKeyPrincipal> {
  const header = options.header ?? "x-api-key";
  const slowMs =
    typeof options.outageProbe === "object"
      ? (options.outageProbe.slowMs ?? 500)
      : 500;
  if (
    !header.trim() ||
    (slowMs !== false && (!Number.isFinite(slowMs) || slowMs < 0))
  ) {
    throw new BetterAuthConfigurationError(
      "INVALID_API_KEY_OPTIONS",
      "API-key header must be nonempty and slowMs must be finite and nonnegative.",
    );
  }
  const verificationMemo = Symbol("api-key-verification");
  const probes = new WeakMap<
    object,
    { at: number; pending: boolean; result: Promise<void> }
  >();
  async function probe(auth: AuthHandle): Promise<void> {
    const previous = probes.get(auth.instance);
    if (previous && (previous.pending || Date.now() - previous.at < 1000)) {
      return previous.result;
    }
    const result = (async () => {
      const context = await auth.context();
      // The logical key column is string-valued for default, UUID and serial IDs.
      const where = [{ field: "key", value: crypto.randomUUID() }];
      await context.adapter.findOne({ model: "apikey", where });
      await context.adapter.updateMany({
        model: "apikey",
        where,
        update: { updatedAt: new Date() },
      });
    })();
    const state = { at: Date.now(), pending: true, result };
    probes.set(auth.instance, state);
    void result.then(
      () => {
        state.pending = false;
      },
      () => {
        state.pending = false;
      },
    );
    return result;
  }
  return {
    id: "better-auth:api-key",
    kinds: [API_KEY_PRINCIPAL_KIND],
    acceptance: options.acceptance ?? "explicit",
    delegates: true,
    credentialHeaders: [header],
    effects: { consumesQuota: true, writes: true },
    requires: { plugins: ["api-key"] },
    appliesTo: (request) => request.headers.has(header),
    async resolve(request) {
      if (!request.headers.has(header)) {
        return absent();
      }
      return request.memo(verificationMemo, async () => {
        const key = request.headers.get(header)!;
        const headers = new Headers();
        for (const name of ["host", "x-forwarded-host", "x-forwarded-proto"]) {
          const value = request.headers.get(name);
          if (value !== null) {
            headers.set(name, value);
          }
        }
        const started = performance.now();
        try {
          const result = await request.auth.run(
            {
              cookies: request.cookies,
              inbound: () => request.headers,
              internal: true,
            },
            () =>
              (request.auth.api as unknown as KeyApi).verifyApiKey({
                body: {
                  key,
                  ...(options.configId === undefined
                    ? {}
                    : { configId: options.configId }),
                },
                headers,
              }),
          );
          if (result.valid) {
            const verified = result.key;
            if (
              !verified ||
              typeof verified.id !== "string" ||
              typeof verified.referenceId !== "string"
            ) {
              throw new BetterAuthInfrastructureError(
                new Error("Malformed API-key verification result"),
              );
            }
            const configId = verified.configId ?? null;
            const references =
              typeof options.references === "function"
                ? options.references({ configId })
                : (options.references ?? "user");
            const permissions = verified.permissions ?? null;
            const grant = role(permissions ?? {});
            return authenticated({
              kind: API_KEY_PRINCIPAL_KIND,
              source: "better-auth:api-key",
              keyId: verified.id,
              configId,
              referenceId: verified.referenceId,
              userId: references === "user" ? verified.referenceId : null,
              organizationId:
                references === "organization" ? verified.referenceId : null,
              permissions,
              delegation: {
                description: "api-key permissions",
                allows: (requested) => grant.authorize(requested).success,
              },
            });
          }
          const code = result.error?.code;
          if (code === "RATE_LIMITED" || code === "USAGE_EXCEEDED") {
            const retry = result.error?.details?.tryAgainIn;
            return rejected(
              AuthFailures.rejected({
                status: 429,
                reason: code,
                ...(code === "RATE_LIMITED" && typeof retry === "number"
                  ? { retryAfterSeconds: retry / 1000 }
                  : {}),
              }),
            );
          }
          if (code === "INVALID_API_KEY" && options.outageProbe !== false) {
            if (slowMs !== false && performance.now() - started > slowMs) {
              throw new BetterAuthInfrastructureError(
                new Error("API-key verification exceeded the outage threshold"),
              );
            }
            await probe(request.auth);
          }
          if (
            code === "INVALID_API_KEY" ||
            code === "KEY_NOT_FOUND" ||
            code === "KEY_DISABLED" ||
            code === "KEY_EXPIRED"
          ) {
            return rejected(
              AuthFailures.rejected({ status: 401, reason: code }),
            );
          }
          throw new BetterAuthInfrastructureError(
            new Error(
              `Unexpected API-key verification error: ${code ?? "missing code"}`,
            ),
          );
        } catch (error) {
          const failure = normalizeThrown(
            error,
            "source",
            "better-auth:api-key",
            [key],
          );
          if ("sessionLoss" in failure) {
            throw new BetterAuthInfrastructureError(error, { secrets: [key] });
          }
          return rejected(failure);
        }
      });
    },
  };
}
const apiKeyPermissionPolicy: AuthorizationPolicy<
  Record<string, string[]>,
  ApiKeyPrincipal
> = {
  id: "better-auth:api-key/permission",
  requires: { plugins: ["api-key"], principals: [API_KEY_PRINCIPAL_KIND] },
  validate(permissions) {
    if (
      !Object.keys(permissions).length ||
      Object.values(permissions).some(
        (actions) => !Array.isArray(actions) || !actions.length,
      )
    ) {
      throw new BetterAuthConfigurationError(
        "EMPTY_PERMISSIONS",
        "API-key permissions must contain a resource and actions.",
      );
    }
  },
  evaluate(permissions, context) {
    return context.principal.delegation.allows(permissions)
      ? { effect: "allow" }
      : { effect: "deny", reason: "MISSING_PERMISSION" };
  },
};
export function apiKeyPermission(
  permissions: Record<string, string[]>,
): Requirement<Record<string, string[]>> {
  return { policy: apiKeyPermissionPolicy, params: permissions };
}
export function RequireApiKeyPermission(
  permissions: Record<string, string[]>,
): ClassDecorator & MethodDecorator {
  return Require(apiKeyPermission(permissions));
}
