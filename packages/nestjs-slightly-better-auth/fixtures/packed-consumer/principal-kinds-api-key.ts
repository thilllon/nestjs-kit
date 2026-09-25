// A declaration consumer that imports `./api-key`, whose module augmentation
// adds the API-key principal kind to the program. It imports only this package,
// which lets the packaging tests compile it as ESM and CommonJS in every
// resolution mode.
import {
  AcceptPrincipals,
  type AuthPrincipal,
  type PrincipalKind,
  type PrincipalOfKind,
} from "nestjs-slightly-better-auth";
import {
  type ApiKeyPrincipal,
  apiKeyPermission,
  apiKeyPrincipal,
} from "nestjs-slightly-better-auth/api-key";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

export type Kinds = Assert<Equal<PrincipalKind, "session" | "api-key">>;
export type KeyPrincipal = Assert<
  Equal<PrincipalOfKind<"api-key">, ApiKeyPrincipal>
>;

export const accepted = AcceptPrincipals("session", "api-key");
export const keyKind: PrincipalKind = "api-key";
export const keyPermission = apiKeyPermission({ project: ["read"] });
export const source = apiKeyPrincipal({
  references: (key) => (key.configId === "org" ? "organization" : "user"),
});

export function keyOrganization(principal: AuthPrincipal): string | null {
  if (principal.kind !== "api-key") {
    return null;
  }
  // @ts-expect-error Verified key principals never expose the raw credential.
  void principal.key;
  return principal.organizationId;
}

// @ts-expect-error Unregistered principal kinds stay rejected.
AcceptPrincipals("session", "robot");
