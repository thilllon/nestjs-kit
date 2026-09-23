import { apiKey } from "@better-auth/api-key";
import { Test, type TestingModule } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { apiKeyPrincipal } from "./api-key.js";
import type { AuthHandle, PrincipalRequest } from "./auth-contracts.js";
import { BetterAuthModule } from "./auth-module.js";
import { getBetterAuthHandleToken } from "./auth-tokens.js";
import { nestjs } from "./plugin.js";

const connection = {
  host: "127.0.0.1",
  port: Number(process.env.PGPORT ?? 55432),
  user: "nestjs_kit_test",
  password: "local_test_password",
  database: "nestjs_kit_test",
  connectionTimeoutMillis: 3000,
  statement_timeout: 3000,
};
/**
 * `DROP DATABASE ... WITH (FORCE)` terminates whatever backend is still attached, which
 * can reach a pooled client that is already closing. pg reports that as an idle-client
 * error, and without a listener it becomes an unhandled exception that fails the run even
 * though every test passed. Other errors still propagate.
 */
function ignoreAdministratorTermination(pool: Pool): Pool {
  pool.on("error", (error: Error & { code?: string }) => {
    if (error.code !== "57P01") {
      throw error;
    }
  });
  return pool;
}
function request(auth: AuthHandle, key: string): PrincipalRequest {
  const memo = new Map<unknown, Promise<unknown>>();
  return {
    auth,
    headers: new Headers({ "x-api-key": key }),
    cookies: null,
    freshness: "default",
    transport: "postgres-e2e",
    memo<T>(key: unknown, compute: () => Promise<T>) {
      if (!memo.has(key)) {
        memo.set(key, compute());
      }
      return memo.get(key) as Promise<T>;
    },
  };
}
describe("real PostgreSQL API-key outage classification", () => {
  it.each(["default", "uuid", "serial"] as const)(
    "uses a no-op logical key probe with %s IDs and detects read-only and row-lock failures",
    async (mode) => {
      const observer = ignoreAdministratorTermination(
        new Pool({ ...connection, max: 1 }),
      );
      const database = `auth_keys_${crypto.randomUUID().replaceAll("-", "")}`;
      let pool: Pool | undefined;
      let module: TestingModule | undefined;
      let locker: Pool | undefined;
      try {
        await observer.query(`CREATE DATABASE "${database}"`);
        pool = ignoreAdministratorTermination(
          new Pool({
            ...connection,
            database,
            max: 1,
            options: "-c lock_timeout=300ms",
          }),
        );
        const auth = betterAuth({
          database: pool,
          secret: crypto.randomUUID() + crypto.randomUUID(),
          baseURL: "http://localhost:3000",
          logger: { disabled: true },
          emailAndPassword: { enabled: true },
          advanced:
            mode === "default" ? {} : { database: { generateId: mode } },
          plugins: [apiKey(), nestjs()],
        });
        await (await getMigrations(auth.options)).runMigrations();
        module = await Test.createTestingModule({
          imports: [
            BetterAuthModule.forRoot({
              auth,
              http: { mount: false },
              logSummary: false,
            }),
          ],
        }).compile();
        await module.init();
        const handle = module.get<AuthHandle>(getBetterAuthHandleToken());
        const signup = await auth.api.signUpEmail({
          body: {
            name: "Owner",
            email: `${crypto.randomUUID()}@example.com`,
            password: "password-secure-123",
          },
        });
        const created = await auth.api.createApiKey({
          body: { userId: signup.user.id, permissions: { project: ["read"] } },
        });
        const source = apiKeyPrincipal({ outageProbe: { slowMs: 100 } });
        expect(
          await source.resolve(request(handle, created.key)),
        ).toMatchObject({ outcome: "authenticated" });
        const before = (await pool.query('SELECT * FROM "apikey" ORDER BY id'))
          .rows;
        const context = await handle.context();
        const write = vi.spyOn(context.adapter, "updateMany");
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            source.resolve(request(handle, `invalid-postgres-key-${i}`)),
          ),
        );
        expect(
          results.every(
            (result) =>
              result.outcome === "rejected" && result.failure.status === 401,
          ),
        ).toBe(true);
        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]![0].where).toEqual([
          { field: "key", value: expect.stringMatching(/^[a-f\d-]{36}$/) },
        ]);
        expect(
          (await pool.query('SELECT * FROM "apikey" ORDER BY id')).rows,
        ).toEqual(before);
        write.mockRestore();
        // The SDK's own key usage write is denied; even the zero-row write probe must detect this.
        await pool.query("SET default_transaction_read_only = on");
        await expect(
          apiKeyPrincipal().resolve(request(handle, created.key)),
        ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
        await pool.query("SET default_transaction_read_only = off");
        expect(
          (await pool.query('SELECT * FROM "apikey" ORDER BY id')).rows,
        ).toEqual(before);
        locker = ignoreAdministratorTermination(
          new Pool({ ...connection, database, max: 1 }),
        );
        await locker.query("BEGIN");
        await locker.query('SELECT id FROM "apikey" WHERE id = $1 FOR UPDATE', [
          created.id,
        ]);
        const started = performance.now();
        await expect(
          apiKeyPrincipal({ outageProbe: { slowMs: 100 } }).resolve(
            request(handle, created.key),
          ),
        ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
        expect(performance.now() - started).toBeGreaterThanOrEqual(250);
        await locker.query("ROLLBACK");
        expect(
          (await pool.query('SELECT * FROM "apikey" ORDER BY id')).rows,
        ).toEqual(before);
      } finally {
        await locker?.query("ROLLBACK").catch(() => {});
        await locker?.end();
        await module?.close();
        await pool?.end();
        await observer.query(
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        );
        await observer.end();
      }
    },
  );
});
