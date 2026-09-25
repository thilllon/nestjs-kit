import assert from "node:assert/strict";
import { isAPIError } from "better-auth/api";
import { admin, customSession, organization } from "better-auth/plugins";
import type {
  AuthorizationPolicy,
  Requirement,
  RequirementExpr,
} from "./auth-contracts.js";
import { Require, RequireAuth } from "./auth-decorators.js";
import { INVOCATION_VALUES } from "./auth-tokens.js";
import type { AuthLike, PrincipalKind } from "./auth-types.js";
import { allow } from "./authorization-evaluator.js";
import {
  bootIssueCodes,
  type ConformanceCase,
  conformanceCase,
  conformanceSkip,
  type ConformanceOutcome,
  createConformanceAuth,
  KIT_BASE_URL,
  settle,
} from "./conformance-fixtures.js";
import {
  betterAuthCalls,
  boot,
  cookieCacheEnabled,
  describeOutcome,
  hasPlugin,
  KIT_KEY_HEADER,
  type KitKeys,
  kitKeyPrincipal,
  kitKeySource,
  kitUser,
  type PolicyConformanceOptions,
  type RequestOutcome,
  requirementsOf,
  sdkContext,
  sessionHeaders,
  sessionPrincipalOf,
  withHarness,
  withRequests,
} from "./conformance-policy-harness.js";
import {
  ACTIVE_ORGANIZATION_ID,
  activeOrganization,
  fromParam,
  orgMember,
  type OrganizationRef,
  organizationRef,
  orgPermission,
} from "./organization.js";

const ADMIN_POLICY = "better-auth:admin/permission";
const ORG_POLICIES = new Set([
  "better-auth:organization/permission", // gitleaks:allow: public policy identifier
  "better-auth:organization/member",
]);
const API_KEY_POLICY = "better-auth:api-key/permission";
const SDK_KEY_HEADER = "x-api-key";
const MOCK_SESSION_HEADER = "x-conformance-mock-session";
const SESSION_KIND = "session" as PrincipalKind;
const API_KEY_KIND = "api-key" as PrincipalKind;
const BOTH_KINDS = [SESSION_KIND, API_KEY_KIND] as const;
const UNAUTHENTICATED = "UNAUTHENTICATED";

type Permissions = Readonly<Record<string, readonly string[]>>;

interface SdkApi {
  getSession(input: { headers: Headers }): Promise<unknown>;
  listUsers(input: { headers: Headers; query: object }): Promise<unknown>;
  banUser(input: {
    headers: Headers;
    body: { userId: string };
  }): Promise<unknown>;
  createApiKey(input: {
    body: {
      userId: string;
      permissions?: Permissions;
      remaining?: number;
      rateLimitEnabled?: boolean;
    };
  }): Promise<{ id: string; key: string }>;
  createOrganization(input: {
    headers: Headers;
    body: { name: string; slug: string };
  }): Promise<{ id: string }>;
  setActiveOrganization(input: {
    headers: Headers;
    body: { organizationId: string };
  }): Promise<unknown>;
}

function api(auth: AuthLike): SdkApi {
  return auth.api as unknown as SdkApi;
}

/** Better Auth's own answer for a server call: 200, or the APIError status (500 for any other throw). */
async function sdkStatus(call: () => Promise<unknown>): Promise<number> {
  const result = await settle(call);
  if (result.ok) {
    return 200;
  }
  return isAPIError(result.error) ? result.error.statusCode : 500;
}

function statusOf(outcome: RequestOutcome): number {
  return outcome.ok ? 200 : outcome.status;
}

function leafWith(
  expression: RequirementExpr,
  match: (policy: AuthorizationPolicy<unknown>) => boolean,
): Requirement | undefined {
  return requirementsOf(expression).find((item) =>
    match(item.policy as AuthorizationPolicy<unknown>),
  );
}

function adminRequirement(
  policy: AuthorizationPolicy<unknown>,
  permissions: Permissions,
  principals?: readonly PrincipalKind[],
): Requirement {
  return {
    policy,
    params: { permissions },
    ...(principals ? { principals } : {}),
  };
}

function withOrganization(
  leaf: Requirement,
  organization: OrganizationRef,
): Requirement {
  return {
    ...leaf,
    params: { ...(leaf.params as object), organization },
  };
}

async function createKey(
  auth: AuthLike,
  userId: string,
  body: { permissions?: Permissions; remaining?: number } = {},
): Promise<{ id: string; key: string }> {
  return api(auth).createApiKey({
    body: { userId, rateLimitEnabled: false, ...body },
  });
}

/** Whether Better Auth turns the key into a session (apiKey({ enableSessionForAPIKeys: true })). */
async function keySessions(auth: AuthLike, key: string): Promise<boolean> {
  const session = await settle(() =>
    api(auth).getSession({ headers: new Headers({ [SDK_KEY_HEADER]: key }) }),
  );
  return session.ok && !!session.value;
}

async function remainingOf(auth: AuthLike, keyId: string): Promise<number> {
  const row = await (await sdkContext(auth)).adapter.findOne<{
    remaining: number | null;
  }>({ model: "apikey", where: [{ field: "id", value: keyId }] });
  return row?.remaining ?? Number.NaN;
}

async function createOrganizationFor(
  auth: AuthLike,
  headers: Headers,
): Promise<string> {
  return (
    await api(auth).createOrganization({
      headers,
      body: {
        name: "Conformance",
        slug: `conformance-${globalThis.crypto.randomUUID()}`,
      },
    })
  ).id;
}

async function setRole(
  auth: AuthLike,
  userId: string,
  role: string | null,
): Promise<void> {
  await (await sdkContext(auth)).adapter.update({
    model: "user",
    where: [{ field: "id", value: userId }],
    update: { role },
  });
}

function assertDenied(
  outcome: RequestOutcome,
  status: number,
  reason: string | undefined,
  message: string,
): void {
  assert.equal(outcome.ok, false, `${message}: allowed`);
  assert.equal(
    statusOf(outcome),
    status,
    `${message}: ${describeOutcome(outcome)}`,
  );
  if (reason !== undefined && !outcome.ok) {
    assert.equal(
      outcome.reason ?? outcome.code,
      reason,
      `${message}: ${describeOutcome(outcome)}`,
    );
  }
}

/**
 * The unit-specific rows of design §14.1 and the core class-policy row. Each unit's cases run when the requirement
 * contains that built-in policy, and skip with the reason otherwise; instances the case needs in another configuration
 * (customSession shapes, adminUserIds, a dynamic baseURL) are built by the kit with createConformanceAuth().
 */
export function unitPolicyCases(
  options: PolicyConformanceOptions,
  known: readonly AuthorizationPolicy<unknown>[],
): ConformanceCase[] {
  const { auth } = options;
  const adminPolicy = known.find((policy) => policy.id === ADMIN_POLICY);
  const orgLeaf = leafWith(options.requirement, (policy) =>
    ORG_POLICIES.has(policy.id),
  );
  const keyLeaf = leafWith(
    options.requirement,
    (policy) => policy.id === API_KEY_POLICY,
  );
  const noAdmin = adminPolicy
    ? undefined
    : `the requirement contains no built-in admin permission policy (${ADMIN_POLICY})`;
  const noOrg = orgLeaf
    ? undefined
    : "the requirement contains no built-in organization policy";
  const admin_ = adminPolicy!;
  const adminCase = (
    id: string,
    title: string,
    run: () => Promise<ConformanceOutcome>,
    skip = noAdmin,
  ) => conformanceCase(id, title, run, skip);
  return [
    adminCase(
      "Z-admin-rejects-api-key",
      "an admin-owned API-key principal is denied PRINCIPAL_NOT_SUPPORTED without a Better Auth call, and 401 on a request",
      async () => {
        const principal = await options.delegatedPrincipal!();
        const requirement = adminRequirement(admin_, { user: ["ban"] });
        await withHarness({ auth, requirement }, async ({ decide, probe }) => {
          const calls = probe.calls.length;
          const storage = probe.storage.length;
          const decision = await decide(principal);
          assert.equal(decision.effect, "deny", JSON.stringify(decision));
          assert.equal(
            (decision as { reason?: string }).reason,
            "PRINCIPAL_NOT_SUPPORTED",
            JSON.stringify(decision),
          );
          assert.deepEqual(
            probe.calls.slice(calls),
            [],
            "the evaluator called Better Auth for an unsupported principal",
          );
          assert.equal(
            probe.storage.length,
            storage,
            "the evaluator read storage for an unsupported principal",
          );
        });
        const keys: KitKeys = {
          keys: new Map([
            [
              "conformance-admin-key",
              { userId: principal.userId ?? "", grant: { user: ["ban"] } },
            ],
          ]),
          verifications: 0,
        };
        return withRequests(
          auth,
          {
            routes: { ban: [Require(requirement)] },
            sources: [kitKeySource(keys)],
          },
          async ({ request }) => {
            const outcome = await request("ban", {
              [KIT_KEY_HEADER]: "conformance-admin-key",
            });
            assertDenied(
              outcome,
              401,
              UNAUTHENTICATED,
              "an API key on a session-only admin route",
            );
            assert.equal(
              keys.verifications,
              0,
              "the route verified an API key it does not accept",
            );
          },
        );
      },
      noAdmin ??
        (options.delegatedPrincipal
          ? undefined
          : "the options give no delegatedPrincipal()"),
    ),
    adminCase(
      "Z-admin-rejects-api-key-session",
      "an admin's API-key session is rejected on admin and authoritative routes and accepted on default-freshness routes",
      async () => {
        if (!(await hasPlugin(auth, "api-key"))) {
          return conformanceSkip("the instance has no apiKey() plugin");
        }
        const adminId = await kitUser(auth, { role: "admin" });
        const otherId = await kitUser(auth, { role: "user" });
        const key = await createKey(auth, adminId, {
          permissions: { project: ["read"] },
        });
        if (!(await keySessions(auth, key.key))) {
          return conformanceSkip(
            "the instance's apiKey() plugin does not set enableSessionForAPIKeys (or reads no x-api-key header)",
          );
        }
        const keyHeaders = new Headers({ [SDK_KEY_HEADER]: key.key });
        assert.equal(
          await sdkStatus(() =>
            api(auth).listUsers({ headers: keyHeaders, query: {} }),
          ),
          401,
          "Better Auth's listUsers accepted an API-key session",
        );
        assert.equal(
          await sdkStatus(() =>
            api(auth).banUser({
              headers: keyHeaders,
              body: { userId: otherId },
            }),
          ),
          401,
          "Better Auth's banUser accepted an API-key session",
        );
        const cookie = (await sessionHeaders(auth, adminId))!.get("cookie")!;
        return withRequests(
          auth,
          {
            routes: {
              ban: [Require(adminRequirement(admin_, { user: ["ban"] }))],
              authoritative: [RequireAuth({ authoritative: true })],
              ordinary: [RequireAuth()],
            },
          },
          async ({ request }) => {
            assertDenied(
              await request("ban", keyHeaders),
              401,
              undefined,
              "x-api-key alone on @RequirePermission({ user: ['ban'] })",
            );
            assertDenied(
              await request("authoritative", keyHeaders),
              401,
              undefined,
              "x-api-key alone on @RequireAuth({ authoritative: true })",
            );
            const ordinary = await request("ordinary", keyHeaders);
            assert.equal(
              ordinary.ok,
              true,
              `a default-freshness route rejected the key session: ${describeOutcome(ordinary)}`,
            );
            assertDenied(
              await request("authoritative", {
                cookie,
                [SDK_KEY_HEADER]: key.key,
              }),
              401,
              undefined,
              "the admin's cookie with the key on an authoritative route (RK27)",
            );
          },
        );
      },
    ),
    adminCase(
      "Z-admin-banned",
      "a banned or signed-out admin with a warm cookie cache is denied on the next request; a banned key owner until banExpires",
      async () => {
        if (!(await cookieCacheEnabled(auth))) {
          return conformanceSkip(
            "the instance's session.cookieCache is off; run the kit on an instance with session.cookieCache.enabled",
          );
        }
        const sdk = await sdkContext(auth);
        const banning = await sessionHeaders(
          auth,
          await kitUser(auth, { role: "admin" }),
        );
        await withRequests(
          auth,
          {
            routes: {
              list: [Require(adminRequirement(admin_, { user: ["list"] }))],
            },
          },
          async ({ request }) => {
            for (const variant of ["banned", "signed out everywhere"]) {
              const userId = await kitUser(auth, { role: "admin" });
              const headers = (await sessionHeaders(auth, userId, {
                warmCache: true,
              }))!;
              const before = await request("list", headers);
              assert.equal(
                before.ok,
                true,
                `${variant}: the admin was denied before: ${describeOutcome(before)}`,
              );
              if (variant === "banned") {
                await api(auth).banUser({
                  headers: banning!,
                  body: { userId },
                });
              } else {
                await sdk.internalAdapter.deleteUserSessions(userId);
              }
              assertDenied(
                await request("list", headers),
                401,
                undefined,
                `${variant}: the warm cookie cache still admitted the admin`,
              );
            }
          },
        );
        return withHarness(
          {
            auth,
            requirement: adminRequirement(
              admin_,
              { user: ["set-role"] },
              BOTH_KINDS,
            ),
          },
          async ({ decide }) => {
            const ownerId = await kitUser(auth, { role: "admin" });
            const principal = kitKeyPrincipal(ownerId, { user: ["set-role"] });
            assert.equal(
              (await decide(principal)).effect,
              "allow",
              "the admin's key was denied before the ban",
            );
            await sdk.internalAdapter.updateUser(ownerId, {
              banned: true,
              banExpires: new Date(Date.now() + 3_600_000),
            });
            assert.deepEqual(
              await decide(principal),
              { effect: "deny", status: 401, reason: "USER_BANNED" },
              "a banned owner's key was not denied USER_BANNED",
            );
            await sdk.internalAdapter.updateUser(ownerId, {
              banExpires: new Date(Date.now() - 1_000),
            });
            assert.equal(
              (await decide(principal)).effect,
              "allow",
              "the key stayed denied after banExpires passed",
            );
          },
        );
      },
    ),
    adminCase(
      "Z-admin-custom-session-role",
      "with customSession role shapes, @RequirePermission answers as Better Auth's listUsers, never a 500",
      async () => {
        const computed = new Map<string, string>();
        const shapes: [
          string,
          (user: { id: string; role?: unknown }) => unknown,
        ][] = [
          ["an array role", (user) => [user.role]],
          [
            "a display label",
            (user) => (user.role === "admin" ? "Administrator" : "Member"),
          ],
          [
            "a role computed from app data",
            (user) => computed.get(user.id) ?? "viewer",
          ],
        ];
        for (const [shape, roleOf] of shapes) {
          const kitAuth = createConformanceAuth({
            plugins: [
              admin(),
              customSession(async ({ user, session }) => ({
                user: {
                  ...user,
                  role: roleOf(user as { id: string; role?: unknown }),
                },
                session,
              })),
            ],
          });
          const adminId = await kitUser(kitAuth, { role: "admin" });
          const plainId = await kitUser(kitAuth, { role: "user" });
          computed.set(adminId, "user");
          computed.set(plainId, "admin");
          await withRequests(
            kitAuth,
            {
              routes: {
                list: [Require(adminRequirement(admin_, { user: ["list"] }))],
              },
            },
            async ({ request }) => {
              for (const [name, userId] of [
                ["admin", adminId],
                ["plain user", plainId],
              ] as const) {
                const headers = (await sessionHeaders(kitAuth, userId))!;
                const expected = await sdkStatus(() =>
                  api(kitAuth).listUsers({ headers, query: {} }),
                );
                const outcome = await request("list", headers);
                assert.notEqual(
                  statusOf(outcome),
                  500,
                  `${shape}, ${name}: ${describeOutcome(outcome)}`,
                );
                assert.equal(
                  statusOf(outcome),
                  expected,
                  `${shape}, ${name}: the route answered ${describeOutcome(outcome)}, listUsers ${expected}`,
                );
              }
            },
          );
        }
      },
    ),
    adminCase(
      "Z-admin-deleted-user",
      "a deleted key owner and a user deleted after the guard's read are denied 401 USER_NOT_FOUND, never 5xx",
      () =>
        withHarness(
          {
            auth,
            requirement: adminRequirement(
              admin_,
              { user: ["list"] },
              BOTH_KINDS,
            ),
          },
          async ({ decide, logger }) => {
            const sdk = await sdkContext(auth);
            const ownerId = await kitUser(auth, { role: "admin" });
            await sdk.internalAdapter.deleteUser(ownerId);
            const delegated = await settle(() =>
              decide(kitKeyPrincipal(ownerId, { user: ["list"] })),
            );
            assert.deepEqual(
              delegated.ok && delegated.value,
              { effect: "deny", status: 401, reason: "USER_NOT_FOUND" },
              `a key whose owner was deleted: ${String(!delegated.ok && delegated.error)}`,
            );
            const userId = await kitUser(auth, { role: "admin" });
            const headers = (await sessionHeaders(auth, userId))!;
            const principal = await sessionPrincipalOf(auth, headers);
            const session = await settle(() =>
              decide(principal, {
                headers,
                beforeEvaluate: () => sdk.internalAdapter.deleteUser(userId),
              }),
            );
            assert.deepEqual(
              session.ok && session.value,
              { effect: "deny", status: 401, reason: "USER_NOT_FOUND" },
              `a user deleted between the guard's read and the policy's call: ${String(!session.ok && session.error)}`,
            );
            assert.deepEqual(
              logger.errors(),
              [],
              "a deleted user was logged as an error",
            );
          },
        ),
    ),
    adminCase(
      "Z-admin-null-role",
      "a NULL or empty stored role answers 403 MISSING_PERMISSION as listUsers does, adminUserIds allows, never a 500",
      async () => {
        const listedId = `conformance-listed-${globalThis.crypto.randomUUID()}`;
        const kitAuth = createConformanceAuth({
          plugins: [admin({ adminUserIds: [listedId] })],
        });
        const nullId = await kitUser(kitAuth, { role: "user" });
        await kitUser(kitAuth, { id: listedId, role: "user" });
        const emptyId = await kitUser(kitAuth, { role: "user" });
        await setRole(kitAuth, nullId, null);
        await setRole(kitAuth, listedId, null);
        await setRole(kitAuth, emptyId, "");
        const rows = [
          ["a NULL role", nullId, 403],
          ["a NULL role listed in adminUserIds", listedId, 200],
          ["an empty-string role", emptyId, 403],
        ] as const;
        await withRequests(
          kitAuth,
          {
            routes: {
              list: [Require(adminRequirement(admin_, { user: ["list"] }))],
            },
          },
          async ({ request }) => {
            for (const [name, userId, status] of rows) {
              const headers = (await sessionHeaders(kitAuth, userId))!;
              assert.equal(
                await sdkStatus(() =>
                  api(kitAuth).listUsers({ headers, query: {} }),
                ),
                status,
                `${name}: Better Auth's listUsers answered otherwise`,
              );
              const outcome = await request("list", headers);
              if (status === 200) {
                assert.equal(
                  outcome.ok,
                  true,
                  `${name}, session: ${describeOutcome(outcome)}`,
                );
              } else {
                assertDenied(
                  outcome,
                  403,
                  "MISSING_PERMISSION",
                  `${name}, session`,
                );
              }
            }
          },
        );
        return withHarness(
          {
            auth: kitAuth,
            requirement: adminRequirement(
              admin_,
              { user: ["list"] },
              BOTH_KINDS,
            ),
          },
          async ({ decide }) => {
            for (const [name, userId, status] of rows) {
              const result = await settle(() =>
                decide(kitKeyPrincipal(userId, { user: ["list"] })),
              );
              assert.ok(
                result.ok,
                `${name}, API key: the policy threw ${String(!result.ok && result.error)}`,
              );
              assert.deepEqual(
                result.value,
                status === 200
                  ? { effect: "allow" }
                  : { effect: "deny", reason: "MISSING_PERMISSION" },
                `${name}, API key`,
              );
            }
          },
        );
      },
    ),
    adminCase(
      "Z-admin-dynamic-base-url",
      "a dynamic baseURL without fallback fails boot (B20); with fallback the admin route is decided",
      async () => {
        const allowedHosts = [new URL(KIT_BASE_URL).host];
        const requirement = adminRequirement(admin_, { user: ["list"] });
        const without = await settle(() =>
          boot(
            createConformanceAuth({
              baseURL: { allowedHosts },
              plugins: [admin()],
            }),
            requirement,
          ),
        );
        if (without.ok) {
          await without.value.moduleRef.close();
          assert.fail("a dynamic baseURL without fallback booted");
        }
        assert.ok(
          bootIssueCodes(without.error).includes(
            "DYNAMIC_BASE_URL_WITHOUT_FALLBACK",
          ),
          String(without.error),
        );
        const kitAuth = createConformanceAuth({
          baseURL: { allowedHosts, fallback: KIT_BASE_URL },
          plugins: [admin()],
        });
        const adminId = await kitUser(kitAuth, { role: "admin" });
        const plainId = await kitUser(kitAuth, { role: "user" });
        return withRequests(
          kitAuth,
          { routes: { list: [Require(requirement)] } },
          async ({ request }) => {
            const allowed = await request(
              "list",
              (await sessionHeaders(kitAuth, adminId))!,
            );
            assert.equal(
              allowed.ok,
              true,
              `the admin was not allowed: ${describeOutcome(allowed)}`,
            );
            assertDenied(
              await request("list", (await sessionHeaders(kitAuth, plainId))!),
              403,
              "MISSING_PERMISSION",
              "a plain user",
            );
          },
        );
      },
    ),
    conformanceCase(
      "Z-org-ref-types",
      "fromParam rejects non-string organization inputs without a call; a literal 'active' is an ID; customSession shapes use getActiveMember",
      async () => {
        const leaf = orgLeaf!;
        const ownerId = await kitUser(auth);
        const headers = (await sessionHeaders(auth, ownerId))!;
        const organizationId = await createOrganizationFor(auth, headers);
        await withRequests(
          auth,
          {
            routes: {
              org: [Require(withOrganization(leaf, fromParam("orgId")))],
            },
          },
          async ({ request, probe, logger }) => {
            for (const value of [{ $ne: null }, 123, ["a"], ""]) {
              const from = probe.calls.length;
              assertDenied(
                await request("org", headers, { orgId: value }),
                403,
                "ORGANIZATION_REQUIRED",
                `orgId ${JSON.stringify(value)}`,
              );
              assert.deepEqual(
                betterAuthCalls(probe, from),
                [],
                `orgId ${JSON.stringify(value)} reached Better Auth`,
              );
            }
            const valid = await request("org", headers, {
              orgId: organizationId,
            });
            assert.equal(
              valid.ok,
              true,
              `the owner's organization ID was denied: ${describeOutcome(valid)}`,
            );
            assert.deepEqual(logger.errors(), []);
          },
        );
        await api(auth).setActiveOrganization({
          headers,
          body: { organizationId },
        });
        const principal = await sessionPrincipalOf(auth, headers);
        await withHarness(
          {
            auth,
            requirement: {
              anyOf: [
                withOrganization(
                  leaf,
                  organizationRef(() => "active"),
                ),
                withOrganization(leaf, activeOrganization()),
              ],
            },
          },
          async ({ decide, probe }) => {
            const from = probe.calls.length;
            const decision = await decide(principal, { headers });
            assert.equal(
              decision.effect,
              "allow",
              `the default ref denied the active organization: ${JSON.stringify(decision)}`,
            );
            assert.equal(
              betterAuthCalls(probe, from).length,
              2,
              `a literal 'active' and the default ref made ${betterAuthCalls(probe, from).length} calls`,
            );
          },
        );
        const shaped = createConformanceAuth({
          plugins: [
            organization(),
            customSession(async ({ user, session }) => ({
              user,
              session: {
                id: session.id,
                userId: session.userId,
                token: session.token,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                expiresAt: session.expiresAt,
              },
            })),
          ],
        });
        const shapedOwner = await kitUser(shaped);
        const shapedHeaders = (await sessionHeaders(shaped, shapedOwner))!;
        const shapedOrganization = await createOrganizationFor(
          shaped,
          shapedHeaders,
        );
        await api(shaped).setActiveOrganization({
          headers: shapedHeaders,
          body: { organizationId: shapedOrganization },
        });
        const shapedPrincipal = await sessionPrincipalOf(shaped, shapedHeaders);
        return withHarness(
          {
            auth: shaped,
            requirement: withOrganization(leaf, activeOrganization()),
          },
          async ({ decide, probe }) => {
            const from = probe.calls.length;
            const invocation = {};
            const decision = await decide(shapedPrincipal, {
              headers: shapedHeaders,
              invocation,
            });
            assert.equal(decision.effect, "allow", JSON.stringify(decision));
            assert.ok(
              betterAuthCalls(probe, from).includes(
                "/organization/get-active-member",
              ),
              `the default ref did not call getActiveMember: ${betterAuthCalls(probe, from).join(", ")}`,
            );
            const published = (
              Reflect.get(invocation, INVOCATION_VALUES) as
                | Map<string, Map<symbol, unknown>>
                | undefined
            )
              ?.get("default")
              ?.get(ACTIVE_ORGANIZATION_ID);
            assert.equal(
              published,
              shapedOrganization,
              "the policy did not publish the active organization ID",
            );
          },
        );
      },
      noOrg,
    ),
    conformanceCase(
      "Z-apikey-quota-per-request",
      "an API-key session on org policies spends 3 per request, with W_API_KEY_SESSION_MULTIPLIER naming them",
      async () => {
        if (!(await hasPlugin(auth, "api-key"))) {
          return conformanceSkip("the instance has no apiKey() plugin");
        }
        const ownerId = await kitUser(auth);
        const headers = (await sessionHeaders(auth, ownerId))!;
        const organizationId = await createOrganizationFor(auth, headers);
        const key = await createKey(auth, ownerId, { remaining: 100 });
        if (!(await keySessions(auth, key.key))) {
          return conformanceSkip(
            "the instance's apiKey() plugin does not set enableSessionForAPIKeys (or reads no x-api-key header)",
          );
        }
        const permission = orgPermission(
          { organization: ["update"] },
          { organization: fromParam("orgId") },
        );
        const member = orgMember({ organization: fromParam("orgId") });
        const routes = { quota: [Require(permission, member)] };
        await withRequests(auth, { routes }, async ({ request }) => {
          const before = await remainingOf(auth, key.id);
          const outcome = await request(
            "quota",
            { [SDK_KEY_HEADER]: key.key },
            { orgId: organizationId },
          );
          assert.equal(
            outcome.ok,
            true,
            `the key owner's organization route was denied: ${describeOutcome(outcome)}`,
          );
          assert.equal(
            before - (await remainingOf(auth, key.id)),
            3,
            "one request with two credential-presenting org policies must spend 3",
          );
        });
        const advice = async (
          target: AuthLike,
          session?: { apiKeySessions: boolean },
        ) => {
          const booted = await boot(target, undefined, {
            routes,
            ...(session ? { session } : {}),
          });
          await booted.moduleRef.close();
          return booted.logger.entries
            .filter((entry) => entry.level === "warn")
            .map((entry) => entry.text);
        };
        const line = (lines: readonly string[], code: string) =>
          lines.find((text) => text.startsWith(`${code}:`));
        const conditional = "If enableSessionForAPIKeys is enabled";
        for (const [label, lines, factual] of [
          ["by default", await advice(auth), false],
          [
            "with session.apiKeySessions: true",
            await advice(auth, { apiKeySessions: true }),
            true,
          ],
        ] as const) {
          const full = line(lines, "W_API_KEY_FULL_SESSION");
          const multiplier = line(lines, "W_API_KEY_SESSION_MULTIPLIER");
          assert.ok(full, `${label}: no W_API_KEY_FULL_SESSION`);
          assert.ok(multiplier, `${label}: no W_API_KEY_SESSION_MULTIPLIER`);
          for (const id of [permission.policy, member.policy].map(
            (policy) => (policy as AuthorizationPolicy<unknown>).id,
          )) {
            assert.ok(
              multiplier.includes(id),
              `${label}: W_API_KEY_SESSION_MULTIPLIER does not name ${id}: ${multiplier}`,
            );
          }
          for (const text of [full, multiplier]) {
            assert.equal(
              text.includes(conditional),
              !factual,
              `${label}: ${text}`,
            );
          }
        }
        for (const [label, lines] of [
          [
            "with session.apiKeySessions: false",
            await advice(auth, { apiKeySessions: false }),
          ],
          [
            "without the api-key plugin",
            await advice(createConformanceAuth({ plugins: [organization()] })),
          ],
        ] as const) {
          assert.deepEqual(
            lines.filter((text) => text.startsWith("W_API_KEY_")),
            [],
            `${label}: API-key session advice was emitted`,
          );
        }
      },
      noOrg,
    ),
    conformanceCase(
      "Z-apikey-quota-per-request",
      "a key resolved by an API-key source on @RequireApiKeyPermission spends 1 per request",
      async () => {
        const leaf = keyLeaf!;
        if (!(await hasPlugin(auth, "api-key"))) {
          return conformanceSkip("the instance has no apiKey() plugin");
        }
        const sources = options.sources ?? [];
        if (
          !sources.some(
            (source) =>
              typeof source === "object" &&
              source !== null &&
              "kinds" in source &&
              (source.kinds as readonly string[]).includes(API_KEY_KIND),
          )
        ) {
          return conformanceSkip(
            "the options give no source of the 'api-key' kind (sources: [apiKeyPrincipal()])",
          );
        }
        const ownerId = await kitUser(auth);
        const key = await createKey(auth, ownerId, {
          remaining: 100,
          permissions: leaf.params as Permissions,
        });
        return withRequests(
          auth,
          { routes: { quota: [Require(options.requirement)] }, sources },
          async ({ request }) => {
            const before = await remainingOf(auth, key.id);
            const outcome = await request("quota", {
              [SDK_KEY_HEADER]: key.key,
            });
            assert.equal(
              outcome.ok,
              true,
              `a key granting the requirement was denied: ${describeOutcome(outcome)}`,
            );
            assert.equal(
              before - (await remainingOf(auth, key.id)),
              1,
              "one request on @RequireApiKeyPermission must spend 1",
            );
          },
        );
      },
      keyLeaf
        ? undefined
        : `the requirement contains no built-in API-key permission policy (${API_KEY_POLICY})`,
    ),
    conformanceCase(
      "Z-class-policy-requires",
      "a class policy's instance requires field sets accepted kinds and freshness, by class and by string token",
      async () => {
        const evaluations = { principals: 0, fresh: 0 };
        class PrincipalsPolicy implements AuthorizationPolicy<object> {
          readonly id =
            "nestjs-slightly-better-auth:conformance/class-principals";
          readonly requires = { principals: BOTH_KINDS };

          evaluate() {
            evaluations.principals++;
            return allow();
          }
        }
        class FreshPolicy implements AuthorizationPolicy<object> {
          readonly id = "nestjs-slightly-better-auth:conformance/class-fresh";
          readonly requires = { freshIdentity: true };

          evaluate() {
            evaluations.fresh++;
            return allow();
          }
        }
        const principalsToken =
          "nestjs-slightly-better-auth:conformance/class-principals-token";
        const freshToken =
          "nestjs-slightly-better-auth:conformance/class-fresh-token";
        const userId = await kitUser(auth);
        const user = await (await sdkContext(auth)).adapter.findOne<
          Record<string, unknown>
        >({ model: "user", where: [{ field: "id", value: userId }] });
        const keys: KitKeys = {
          keys: new Map([["conformance-class-key", { userId, grant: {} }]]),
          verifications: 0,
        };
        return withRequests(
          auth,
          {
            routes: {
              principalsClass: [
                Require({ policy: PrincipalsPolicy as never, params: {} }),
              ],
              principalsToken: [
                Require({ policy: principalsToken, params: {} }),
              ],
              freshClass: [
                Require({ policy: FreshPolicy as never, params: {} }),
              ],
              freshToken: [Require({ policy: freshToken, params: {} })],
              ordinary: [RequireAuth()],
            },
            sources: [kitKeySource(keys)],
            providers: [
              PrincipalsPolicy,
              FreshPolicy,
              { provide: principalsToken, useClass: PrincipalsPolicy },
              { provide: freshToken, useClass: FreshPolicy },
            ],
          },
          async ({ request, probe }) => {
            for (const route of ["principalsClass", "principalsToken"]) {
              const verifications = keys.verifications;
              const count = evaluations.principals;
              const outcome = await request(route, {
                [KIT_KEY_HEADER]: "conformance-class-key",
              });
              assert.equal(
                outcome.ok,
                true,
                `${route}: an API key was not admitted: ${describeOutcome(outcome)}`,
              );
              assert.equal(
                keys.verifications,
                verifications + 1,
                `${route}: the key source did not run`,
              );
              assert.equal(evaluations.principals, count + 1);
            }
            // A session a plugin's before hook places for /get-session, as apiKey's enableSessionForAPIKeys does.
            probe.respond = (path, headers) =>
              path === "/get-session" && headers?.has(MOCK_SESSION_HEADER)
                ? {
                    user,
                    session: {
                      id: `conformance-mock-${userId}`,
                      token: "conformance-mock",
                      userId,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                      expiresAt: new Date(Date.now() + 3_600_000),
                    },
                  }
                : undefined;
            const mocked = { [MOCK_SESSION_HEADER]: "1" };
            const ordinary = await request("ordinary", mocked);
            assert.equal(
              ordinary.ok,
              true,
              `a default-freshness route rejected the hook-placed session: ${describeOutcome(ordinary)}`,
            );
            for (const route of ["freshClass", "freshToken"]) {
              assertDenied(
                await request(route, mocked),
                401,
                undefined,
                `${route}: a hook-placed session on a freshIdentity route`,
              );
            }
            assert.equal(
              evaluations.fresh,
              0,
              "a freshIdentity class policy was evaluated for a hook-placed session",
            );
          },
        );
      },
    ),
  ];
}
