import { apiKey } from "@better-auth/api-key";
import { admin, organization } from "better-auth/plugins";
import { adminPermissionPolicy } from "./admin.js";
import type { ConformanceCase } from "./auth-contracts.js";
import type { AuthPrincipal, PrincipalKind } from "./auth-types.js";
import { createConformanceAuth, kitIdentity } from "./conformance-fixtures.js";
import { policyConformance } from "./conformance-policy.js";
import type {
  PolicyConformanceOptions,
  PolicyDelivery,
} from "./conformance-policy-harness.js";
import { organizationRef, orgPermissionPolicy } from "./organization.js";

function sessionPrincipal(userId: string): AuthPrincipal {
  return {
    kind: "session",
    source: "better-auth:session",
    userId,
    session: {
      user: { id: userId },
      session: { id: "conformance", createdAt: new Date() },
    },
  } as unknown as AuthPrincipal;
}

/**
 * The policy kit on the built-in admin permission policy (or a stand-in with its id), on an instance with a cookie
 * cache and API-key sessions, as testing-conformance.test.ts runs it.
 */
export async function adminPolicyOptions(
  policy: typeof adminPermissionPolicy = adminPermissionPolicy,
): Promise<PolicyConformanceOptions> {
  const auth = createConformanceAuth({
    session: { cookieCache: { enabled: true } },
    plugins: [admin(), apiKey({ enableSessionForAPIKeys: true })],
  });
  const administrator = await kitIdentity(auth, { role: "admin" });
  const member = await kitIdentity(auth, { role: "user" });
  return {
    requirement: {
      policy,
      params: { permissions: { user: ["ban"] } },
      principals: ["session", "api-key" as PrincipalKind],
    },
    auth,
    allowingPrincipal: async () => sessionPrincipal(administrator.userId),
    denyingPrincipal: async () => sessionPrincipal(member.userId),
  };
}

/**
 * The policy kit on the built-in organization permission policy (or a stand-in with its id), on an instance with a
 * cookie cache and API-key sessions, as testing-conformance.test.ts runs it.
 */
export async function organizationPolicyOptions(
  policy: typeof orgPermissionPolicy = orgPermissionPolicy,
): Promise<PolicyConformanceOptions> {
  const auth = createConformanceAuth({
    session: { cookieCache: { enabled: true } },
    plugins: [organization(), apiKey({ enableSessionForAPIKeys: true })],
  });
  const owner = await kitIdentity(auth);
  const outsider = await kitIdentity(auth);
  const created = await (
    auth.api as unknown as {
      createOrganization(input: {
        headers: Headers;
        body: { name: string; slug: string };
      }): Promise<{ id: string }>;
    }
  ).createOrganization({
    headers: new Headers({ cookie: owner.cookie }),
    body: {
      name: "Conformance",
      slug: `conformance-${globalThis.crypto.randomUUID()}`,
    },
  });
  return {
    requirement: {
      policy,
      params: {
        permissions: { organization: ["update"] },
        organization: organizationRef(() => created.id),
      },
    },
    auth,
    allowingPrincipal: async () => sessionPrincipal(owner.userId),
    denyingPrincipal: async () => sessionPrincipal(outsider.userId),
  };
}

/**
 * The delivery variants of the rows of the unit `options` runs, for one delivery: rows of the other units are left out,
 * while a row the delivery cannot carry stays in the list with its skip reason.
 */
export function policyDeliveryCases(
  options: PolicyConformanceOptions,
  delivery: PolicyDelivery,
): ConformanceCase[] {
  return policyConformance({ ...options, deliveries: [delivery] }).filter(
    (item) =>
      item.title.startsWith(`${delivery.name}: `) &&
      !item.skip?.startsWith("the requirement contains no built-in"),
  );
}
