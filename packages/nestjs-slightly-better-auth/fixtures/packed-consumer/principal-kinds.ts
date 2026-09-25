// A declaration consumer that does not import `./api-key`, so its program must
// not know the API-key principal kind. It imports only this package, which lets
// the packaging tests compile it as ESM and CommonJS in every resolution mode.
import {
  AcceptPrincipals,
  type AuthPrincipal,
  type PrincipalKind,
} from "nestjs-slightly-better-auth";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;

export type SessionKindOnly = Assert<Equal<PrincipalKind, "session">>;
export type SessionPrincipalOnly = Assert<
  Equal<AuthPrincipal["kind"], "session">
>;

export const accepted = AcceptPrincipals("session");
export const kind: PrincipalKind = "session";
// @ts-expect-error The API-key kind needs the ./api-key subpath in the program.
AcceptPrincipals("session", "api-key");
// @ts-expect-error The API-key kind needs the ./api-key subpath in the program.
export const keyKind: PrincipalKind = "api-key";
