import { apiKey } from "@better-auth/api-key";
import { Test, type TestingModule } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Pool, type PoolClient, type PoolConfig } from "pg";
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

interface OwnedPool {
  readonly pool: Pool;
  close(): Promise<void>;
}

/**
 * Creates a pool whose `close()` settles only after every backend it opened has exited.
 * pg-pool resolves `end()` once it has asked each idle client to end, before their sockets
 * close, and emits "remove" only after a client's socket has closed. PostgreSQL keeps a
 * backend's socket open until that backend process exits, so a "remove" for every client
 * reported by "connect" means none of the pool's backends is still attached to the database.
 * The pool has no "error" listener, so a terminated idle backend raises an unhandled error.
 */
function ownedPool(config: PoolConfig): OwnedPool {
  const pool = new Pool(config);
  const open = new Set<PoolClient>();
  let drained: (() => void) | undefined;
  pool.on("connect", (client) => {
    open.add(client);
  });
  pool.on("remove", (client) => {
    open.delete(client);
    if (open.size === 0) {
      drained?.();
    }
  });
  return {
    pool,
    async close() {
      const allRemoved = new Promise<void>((resolve) => {
        drained = resolve;
      });
      await pool.end();
      if (open.size > 0) {
        await allRemoved;
      }
    },
  };
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
      // The observer stays on the maintenance database, which is never dropped.
      const observer = new Pool({ ...connection, max: 1 });
      const database = `auth_keys_${crypto.randomUUID().replaceAll("-", "")}`;
      let db: OwnedPool | undefined;
      let module: TestingModule | undefined;
      let locker: OwnedPool | undefined;
      try {
        await observer.query(`CREATE DATABASE "${database}"`);
        db = ownedPool({
          ...connection,
          database,
          max: 1,
          options: "-c lock_timeout=300ms",
          application_name: "api-key-e2e-auth",
        });
        const { pool } = db;
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
        locker = ownedPool({
          ...connection,
          database,
          max: 1,
          application_name: "api-key-e2e-locker",
        });
        await locker.pool.query("BEGIN");
        await locker.pool.query(
          'SELECT id FROM "apikey" WHERE id = $1 FOR UPDATE',
          [created.id],
        );
        const started = performance.now();
        await expect(
          apiKeyPrincipal({ outageProbe: { slowMs: 100 } }).resolve(
            request(handle, created.key),
          ),
        ).rejects.toMatchObject({ name: "BetterAuthInfrastructureError" });
        expect(performance.now() - started).toBeGreaterThanOrEqual(250);
        await locker.pool.query("ROLLBACK");
        expect(
          (await pool.query('SELECT * FROM "apikey" ORDER BY id')).rows,
        ).toEqual(before);
      } finally {
        await locker?.pool.query("ROLLBACK").catch(() => {});
        await locker?.close();
        await module?.close();
        await db?.close();
        // Every owned pool has closed, so a client backend still attached to the database is a
        // leaked connection. The forced drop terminates it, and its client receives a 57P01
        // error; the leak fails this test while the drop still reclaims the database.
        const { rows: attached } = await observer.query(
          "SELECT application_name, state FROM pg_stat_activity WHERE datname = $1 AND backend_type = 'client backend'",
          [database],
        );
        expect.soft(attached).toEqual([]);
        await observer.query(
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        );
        await observer.end();
      }
    },
  );
});
