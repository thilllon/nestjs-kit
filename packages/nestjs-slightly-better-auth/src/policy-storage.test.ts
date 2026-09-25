import { PGlite } from "@electric-sql/pglite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { bearer, testUtils } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { adminPermissionPolicy } from "./admin.js";
import type { ConformanceCase } from "./auth-contracts.js";
import type { AuthLike } from "./auth-types.js";
import {
  conformanceProbePlugin,
  KIT_BASE_URL,
} from "./conformance-fixtures.js";
import { policyConformance } from "./conformance-policy.js";
import { nestjs } from "./plugin.js";
import { adminPolicyOptions } from "./policy-kit-fixtures.js";

interface PgResult {
  rows: unknown[];
  rowCount: number;
  command: string | undefined;
}

/**
 * A pg-style pool over one in-process PGlite database, which Better Auth detects as PostgreSQL and serves through its
 * Kysely adapter (PostgresDialect). PGlite runs one session: the kit's requests are sequential, so the adapter's
 * transactions do not interleave.
 */
function pglitePool(db: PGlite) {
  return {
    async connect() {
      return {
        async query(sql: string, params: readonly unknown[] = []) {
          const result = await db.query(sql, [...params]);
          return {
            rows: result.rows,
            rowCount: result.affectedRows ?? result.rows.length,
            command: /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase(),
          } satisfies PgResult;
        },
        release() {},
      };
    },
    async end() {},
  };
}

/**
 * The storage job's variant (design v7 §14.2): each kit-built instance gets its own PGlite database, migrated with
 * Better Auth's getMigrations() for its plugins, plus what createConformanceAuth() adds.
 */
function pgliteVariant(databases: PGlite[]) {
  return async (
    overrides: Omit<BetterAuthOptions, "database">,
  ): Promise<AuthLike> => {
    const db = new PGlite();
    databases.push(db);
    const auth = betterAuth<BetterAuthOptions>({
      secret: globalThis.crypto.randomUUID() + globalThis.crypto.randomUUID(),
      baseURL: KIT_BASE_URL,
      emailAndPassword: { enabled: true },
      logger: { disabled: true },
      ...overrides,
      session: { ...overrides.session, updateAge: 0 },
      advanced: { ...overrides.advanced, disableOriginCheck: false },
      plugins: [
        testUtils(),
        bearer(),
        conformanceProbePlugin(),
        ...(overrides.plugins ?? []),
        nestjs(),
      ],
      database: pglitePool(db) as never,
    });
    await (await getMigrations(auth.options)).runMigrations();
    return auth as unknown as AuthLike;
  };
}

async function nullRoleCase(
  policy: typeof adminPermissionPolicy,
  databases: PGlite[],
): Promise<ConformanceCase> {
  return policyConformance({
    ...(await adminPolicyOptions(policy)),
    variant: pgliteVariant(databases),
  }).find((item) => item.id === "Z-admin-null-role")!;
}

async function closeAll(databases: readonly PGlite[]): Promise<void> {
  await Promise.all(databases.map((db) => db.close()));
}

describe("policy kit storage job on PGlite with Better Auth's Kysely adapter", () => {
  it("answers Z-admin-null-role for SQL NULL and empty stored roles as listUsers does", async () => {
    const databases: PGlite[] = [];
    try {
      const item = await nullRoleCase(adminPermissionPolicy, databases);
      await expect(item.run()).resolves.toBeUndefined();
      expect(databases).toHaveLength(1);
      const [db] = databases;
      const column = await db!.query<{ is_nullable: string }>(
        `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'role'`,
      );
      expect(column.rows).toEqual([{ is_nullable: "YES" }]);
      const roles = await db!.query<{ role: string | null }>(
        `SELECT role FROM "user" WHERE role IS NULL OR role = '' ORDER BY role NULLS FIRST`,
      );
      // The NULL role, the NULL role listed in adminUserIds and the empty-string role the case stored.
      expect(roles.rows).toEqual([
        { role: null },
        { role: null },
        { role: "" },
      ]);
    } finally {
      await closeAll(databases);
    }
  });

  it("fails Z-admin-null-role on PGlite for an admin policy that trusts the stored role", async () => {
    const databases: PGlite[] = [];
    try {
      const item = await nullRoleCase(
        {
          ...adminPermissionPolicy,
          async evaluate({ permissions }, context) {
            const owner = await (
              await context.auth.context()
            ).internalAdapter.findUserById(context.principal.userId!);
            const result = await (
              context.auth.api as unknown as {
                userHasPermission(input: {
                  body: { role: string; permissions: object };
                }): Promise<{ success: boolean }>;
              }
            ).userHasPermission({
              body: {
                role: (owner as { role: string }).role.split(",").join(","),
                permissions,
              },
            });
            return result.success
              ? { effect: "allow" }
              : { effect: "deny", reason: "MISSING_PERMISSION" };
          },
        },
        databases,
      );
      await expect(item.run()).rejects.toThrow(/a NULL role/);
    } finally {
      await closeAll(databases);
    }
  });
});
