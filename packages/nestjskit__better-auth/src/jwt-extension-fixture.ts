/**
 * Test fixture: the third-party JWT principal source from design v7 §4.3.4. It uses only
 * root exports and verifies bearer tokens issued by better-auth's JWT plugin with jose.
 * This is not a built-in unit; the package exports no JWT source.
 */
import {
  createLocalJWKSet,
  errors,
  type JSONWebKeySet,
  type JWTPayload,
  jwtVerify,
} from "jose";
import {
  type AuthContextView,
  type AuthPrincipalBase,
  AuthFailures,
  BetterAuthConfigurationError,
  type PrincipalResult,
  type PrincipalSource,
  absent,
  authenticated,
  definePrincipalSource,
  rejected,
} from "./index.js";

export const JWT_SOURCE_ID = "fixture:better-auth-jwt";

export interface JwtPrincipal extends AuthPrincipalBase {
  readonly kind: "jwt";
  readonly claims: JWTPayload;
}

declare module "./index.js" {
  interface PrincipalKinds {
    jwt: JwtPrincipal;
  }
}

export interface JwtPrincipalOptions {
  /** Must equal the JWT plugin's `jwt.issuer`. Required when the shared baseURL is empty. */
  readonly issuer?: string;
  /** Must equal the JWT plugin's `jwt.audience`. Required when the shared baseURL is empty. */
  readonly audience?: string;
  /** Minimum age of cached keys before an unknown `kid` refetches them. Default 30 s. */
  readonly refetchCooldownMs?: number;
}

interface JwtApi {
  getJwks(input: { headers: Headers }): Promise<JSONWebKeySet>;
}

interface KeySet {
  readonly getKey: ReturnType<typeof createLocalJWKSet>;
  readonly fetchedAt: number;
}

// jose codes caused by the presented token. Every other failure is infrastructure.
const INVALID_TOKEN = new Set([
  "ERR_JWT_EXPIRED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_INVALID",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JOSE_ALG_NOT_ALLOWED",
  // An attacker-chosen header algorithm such as `none` or an unknown `crit` parameter.
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWKS_NO_MATCHING_KEY",
  "ERR_JWKS_MULTIPLE_MATCHING_KEYS",
]);
const JWT_BEARER = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]*)$/i;

/**
 * Better Auth signs `iss` and `aud` with the baseURL origin; `AuthContextView.baseURL`
 * carries the basePath. An empty shared baseURL (unset or dynamic) has no stable origin,
 * so explicit claims are required and never derived from request headers or the token.
 */
function expectedClaims(
  context: AuthContextView,
  options: JwtPrincipalOptions,
): { issuer: string; audience: string } | null {
  const origin = context.baseURL ? new URL(context.baseURL).origin : undefined;
  const issuer = options.issuer ?? origin;
  const audience = options.audience ?? origin;
  return issuer && audience ? { issuer, audience } : null;
}

const CLAIMS_DETAIL =
  "The JWT principal source has no issuer/audience: the shared baseURL is empty.";
const CLAIMS_HINT =
  "Set jwt.issuer and jwt.audience on the JWT plugin and the same values on the source.";

class KeyCache {
  #current: Promise<KeySet> | undefined;

  get(load: () => Promise<JSONWebKeySet>): Promise<KeySet> {
    this.#current ??= this.#fetch(load);
    return this.#current;
  }

  /** Concurrent refreshes of the same stale set share one read. */
  refresh(
    stale: Promise<KeySet>,
    load: () => Promise<JSONWebKeySet>,
  ): Promise<KeySet> {
    if (this.#current === stale) {
      this.#current = this.#fetch(load);
    }
    return this.get(load);
  }

  #fetch(load: () => Promise<JSONWebKeySet>): Promise<KeySet> {
    const pending = load().then((jwks) => ({
      getKey: createLocalJWKSet(jwks),
      fetchedAt: Date.now(),
    }));
    // A failed read is not cached, so the next request retries storage.
    pending.catch(() => {
      if (this.#current === pending) {
        this.#current = undefined;
      }
    });
    return pending;
  }
}

function joseCode(error: unknown): string | undefined {
  return error instanceof errors.JOSEError ? error.code : undefined;
}

function invalidToken(error: unknown): PrincipalResult<never> {
  if (!INVALID_TOKEN.has(joseCode(error) ?? "")) {
    throw error;
  }
  return rejected(
    AuthFailures.rejected({
      status: 401,
      reason: "INVALID_JWT",
      challenge: 'Bearer error="invalid_token"',
    }),
  );
}

export function jwtPrincipal(
  options: JwtPrincipalOptions = {},
): PrincipalSource<JwtPrincipal> {
  const cooldownMs = options.refetchCooldownMs ?? 30_000;
  // Keys belong to one Better Auth instance, even if this source is registered twice.
  const caches = new WeakMap<object, KeyCache>();
  const cacheFor = (instance: object): KeyCache => {
    let cache = caches.get(instance);
    if (!cache) {
      cache = new KeyCache();
      caches.set(instance, cache);
    }
    return cache;
  };
  return definePrincipalSource<JwtPrincipal>({
    id: JWT_SOURCE_ID,
    kinds: ["jwt"],
    credentialHeaders: ["authorization"],
    requires: { plugins: ["jwt"] },
    appliesTo: (request) =>
      JWT_BEARER.test(request.headers.get("authorization") ?? ""),
    advise(boot) {
      if (!expectedClaims(boot.context, options)) {
        throw new BetterAuthConfigurationError(
          "JWT_CLAIMS_NOT_CONFIGURED",
          `'${boot.instance}': ${CLAIMS_DETAIL}`,
          CLAIMS_HINT,
        );
      }
      return [];
    },
    async resolve(request) {
      const token = JWT_BEARER.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!token) {
        return absent();
      }
      const claims = expectedClaims(await request.auth.context(), options);
      if (!claims) {
        throw BetterAuthConfigurationError.atRequest(
          "JWT_CLAIMS_NOT_CONFIGURED",
          CLAIMS_DETAIL,
          { site: JWT_SOURCE_ID, hint: CLAIMS_HINT },
        );
      }
      const cache = cacheFor(request.auth.instance);
      // The request headers carry the host a dynamic baseURL resolves from. They pass
      // unchanged, inside the resolver's internal scope. A `request` input would make
      // better-auth answer with a Response instead of the key set.
      const load = () =>
        (request.auth.api as unknown as JwtApi).getJwks({
          headers: request.headers,
        });
      const verify = async (keys: KeySet) => {
        const { payload } = await jwtVerify(token, keys.getKey, claims);
        return authenticated<JwtPrincipal>({
          kind: "jwt",
          source: JWT_SOURCE_ID,
          userId: typeof payload.sub === "string" ? payload.sub : null,
          claims: payload,
        });
      };
      const cached = cache.get(load);
      // A storage failure rejects here and propagates as an infrastructure error.
      const keys = await cached;
      try {
        return await verify(keys);
      } catch (error) {
        if (
          joseCode(error) !== "ERR_JWKS_NO_MATCHING_KEY" ||
          Date.now() - keys.fetchedAt < cooldownMs
        ) {
          return invalidToken(error);
        }
      }
      // A rotated key: refetch once, at most once per cooldown.
      return verify(await cache.refresh(cached, load)).catch(invalidToken);
    },
  });
}
