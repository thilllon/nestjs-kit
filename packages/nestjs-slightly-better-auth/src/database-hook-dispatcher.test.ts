import {
  betterAuth,
  type BetterAuthOptions,
  type BetterAuthPlugin,
} from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getWithHooks } from "better-auth/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHookMethod } from "./auth-types.js";
import type { BridgeBinding, BridgeHandle } from "./bridge-protocol.js";
import { createDatabaseDispatchers } from "./database-hook-dispatcher.js";
import { nestjs } from "./plugin.js";

function binding(): BridgeBinding {
  return {
    owner: { description: "db parity" },
    instance: "default",
    state: "bootstrapped",
    current: () => undefined,
    credentialHeaders: [],
    before: [],
    after: [],
    onDropped: () => undefined,
    database: {
      "user.create": { before: [], after: [] },
      "user.update": { before: [], after: [] },
      "user.delete": { before: [], after: [] },
      "session.create": { before: [], after: [] },
      "session.update": { before: [], after: [] },
      "session.delete": { before: [], after: [] },
      "account.create": { before: [], after: [] },
      "account.update": { before: [], after: [] },
      "account.delete": { before: [], after: [] },
      "verification.create": { before: [], after: [] },
      "verification.update": { before: [], after: [] },
      "verification.delete": { before: [], after: [] },
    },
  };
}
const options = {
  baseURL: "https://db.test",
  secret: "db-parity-secret-at-least-thirty-two-characters",
  logger: { disabled: true },
} satisfies BetterAuthOptions;
const date = new Date("2026-01-01T00:00:00Z");
const row = {
  id: "user-one",
  name: " original ",
  email: "one@example.test",
  emailVerified: false,
  createdAt: date,
  updatedAt: date,
};

describe("native SDK database hook parity", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(date);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("chains create data and gives update/updateMany hooks original input, preserving earlier plugin deltas", async () => {
    const execute = async (native: boolean) => {
      const data: Record<string, unknown[]> = {};
      const seen: unknown[] = [];
      const create: DatabaseHookMethod<"user.create", "before">[] = [
        (user) => {
          seen.push(["create1", user.name]);
          return { data: { name: `${user.name}-first` } };
        },
        (user) => {
          seen.push(["create2", user.name]);
          return { data: { image: `${user.name}-image` } };
        },
      ];
      const update: DatabaseHookMethod<"user.update", "before">[] = [
        (user) => {
          seen.push(["update1", user.name]);
          return { data: { image: "updated-image" } };
        },
        (user) => {
          seen.push(["update2", user.name]);
          return;
        },
      ];
      const first: NonNullable<BetterAuthOptions["databaseHooks"]> = {
        user: {
          create: {
            before: async (user) => ({ data: { name: user.name.trim() } }),
          },
          update: {
            before: async (user) => ({ data: { name: user.name?.trim() } }),
          },
        },
      };
      const bound = binding();
      const selected = {
        ...bound,
        database: {
          ...bound.database,
          "user.create": { before: create, after: [] },
          "user.update": { before: update, after: [] },
        },
      };
      const hooks = native
        ? [
            first,
            ...create.map((method) => ({
              user: {
                create: {
                  before: async (...args: Parameters<typeof method>) =>
                    method(...args),
                },
              },
            })),
            ...update.map((method) => ({
              user: {
                update: {
                  before: async (...args: Parameters<typeof method>) =>
                    method(...args),
                },
              },
            })),
          ]
        : [
            first,
            createDatabaseDispatchers(
              () => selected,
              () => undefined,
            ),
          ];
      const auth = betterAuth<BetterAuthOptions>({
        ...options,
        database: memoryAdapter(data),
      });
      const ctx = await auth.$context;
      const db = getWithHooks(ctx.adapter, {
        options: ctx.options,
        hooks: hooks.map((item, index) => ({
          source: `plugin:${index}`,
          hooks: item,
        })),
      });
      await db.createWithHooks(row, "user");
      const created = structuredClone(data.user);
      await db.updateWithHooks(
        { name: " update " },
        [{ field: "id", value: row.id }],
        "user",
      );
      const updated = structuredClone(data.user);
      await db.updateManyWithHooks(
        { name: " many " },
        [{ field: "id", value: row.id }],
        "user",
      );
      return { created, updated, many: data.user, seen };
    };
    const native = await execute(true);
    expect(await execute(false)).toEqual(native);
    expect(native.created).toMatchObject([
      { name: "original-first", image: "original-first-image" },
    ]);
    expect(native.updated).toMatchObject([
      { name: "update", image: "updated-image" },
    ]);
    expect(native.many).toMatchObject([
      { name: "many", image: "updated-image" },
    ]);
    expect(native.seen).toEqual([
      ["create1", "original"],
      ["create2", "original-first"],
      ["update1", " update "],
      ["update2", " update "],
      ["update1", " many "],
      ["update2", " many "],
    ]);
  });

  it.each(["create", "update", "delete"] as const)(
    "aborts %s on false and skips remaining methods and after effects",
    async (operation) => {
      const execute = async (native: boolean) => {
        const data: Record<string, unknown[]> = {
          user: [structuredClone(row)],
        };
        const events: string[] = [];
        const first = async () => false;
        const later = async () => {
          events.push("later");
        };
        const after = async () => {
          events.push("after");
        };
        const bound = binding();
        const target = `user.${operation}` as const;
        const selected = {
          ...bound,
          database: {
            ...bound.database,
            [target]: { before: [first, later], after: [after] },
          },
        };
        const hooks = native
          ? [
              { user: { [operation]: { before: first, after } } },
              { user: { [operation]: { before: later } } },
            ]
          : [
              createDatabaseDispatchers(
                () => selected,
                () => undefined,
              ),
            ];
        const ctx = await betterAuth<BetterAuthOptions>({
          ...options,
          database: memoryAdapter(data),
        }).$context;
        const db = getWithHooks(ctx.adapter, {
          options: ctx.options,
          hooks: hooks.map((item, index) => ({
            source: `plugin:${index}`,
            hooks: item,
          })),
        });
        if (operation === "create") {
          await db.createWithHooks({ ...row, id: "new" }, "user");
        } else if (operation === "update") {
          await db.updateWithHooks(
            { name: "changed" },
            [{ field: "id", value: row.id }],
            "user",
          );
          await db.updateManyWithHooks(
            { name: "changed" },
            [{ field: "id", value: row.id }],
            "user",
          );
        } else {
          await db.deleteWithHooks([{ field: "id", value: row.id }], "user");
          await db.deleteManyWithHooks(
            [{ field: "id", value: row.id }],
            "user",
          );
        }
        return { data, events };
      };
      const native = await execute(true);
      expect(await execute(false)).toEqual(native);
      expect(native.events).toEqual([]);
      expect(native.data.user).toEqual([row]);
    },
  );

  it("runs after effects after the SDK transaction commits, through actual plugin init", async () => {
    const execute = async (native: boolean) => {
      const data: Record<string, unknown[]> = {};
      const events: string[] = [];
      const after: DatabaseHookMethod<"user.create", "after"> = async (
        user,
        ctx,
      ) => {
        expect(ctx).toBeUndefined();
        expect(data.user).toHaveLength(1);
        events.push(`after:${user.name}`);
      };
      const plugin = nestjs();
      const bound = binding();
      (plugin as unknown as Record<symbol, BridgeHandle>)[
        Symbol.for("nestjs-slightly-better-auth:bridge")
      ].bind({
        ...bound,
        database: {
          ...bound.database,
          "user.create": { before: [], after: [after] },
        },
      });
      const nativePlugin: BetterAuthPlugin = {
        id: "native-db",
        init: () => ({
          options: {
            databaseHooks: {
              user: { create: { after: async (...args) => after(...args) } },
            },
          },
        }),
      };
      const factory = memoryAdapter(data);
      const auth = betterAuth({
        ...options,
        database: (config: BetterAuthOptions) => {
          const adapter = factory(config);
          adapter.transaction = async (callback) => {
            events.push("begin");
            const result = await callback(adapter);
            events.push("commit");
            return result;
          };
          return adapter;
        },
        plugins: [native ? nativePlugin : plugin],
      });
      await (await auth.$context).internalAdapter.createOAuthUser(
        { name: "committed", email: "new@example.test", emailVerified: false },
        { providerId: "test", accountId: "one" },
      );
      return {
        events,
        rows: data.user?.length,
        accounts: data.account?.length,
      };
    };
    const native = await execute(true);
    expect(await execute(false)).toEqual(native);
    expect(native.events).toEqual(["begin", "commit", "after:committed"]);
  });

  it("registers generated database sequences as native plugins and as compiled hooks", async () => {
    for (let seed = 0; seed < 12; seed++) {
      const execute = async (native: boolean) => {
        const data: Record<string, unknown[]> = {
          user: [structuredClone(row)],
          account: [
            {
              id: "account-one",
              userId: row.id,
              providerId: "credential",
              accountId: row.id,
              password: "old",
              createdAt: date,
              updatedAt: date,
            },
          ],
        };
        const seen: unknown[] = [];
        const create: DatabaseHookMethod<"user.create", "before">[] = [];
        const update: DatabaseHookMethod<"user.update", "before">[] = [];
        const many: DatabaseHookMethod<"account.update", "before">[] = [];
        for (let index = 0; index < 1 + (seed % 4); index++) {
          create.push((user) => {
            seen.push(["create", index, user.name]);
            return { data: { name: `${user.name}-${index}` } };
          });
          update.push((user) => {
            seen.push(["update", index, user.name]);
            return index % 2
              ? { data: { name: `changed-${seed}-${index}` } }
              : { data: { image: `image-${index}` } };
          });
          many.push((account) => {
            seen.push(["many", index, account.password]);
            return { data: { scope: `scope-${index}` } };
          });
        }
        const first: BetterAuthPlugin = {
          id: "preceding",
          init: () => ({
            options: {
              databaseHooks: {
                user: {
                  create: {
                    before: async (user) => ({
                      data: { name: user.name.trim() },
                    }),
                  },
                  update: {
                    before: async (user) => ({
                      data: { name: user.name?.trim() },
                    }),
                  },
                },
                account: {
                  update: {
                    before: async (account) => ({
                      data: { password: account.password?.trim() },
                    }),
                  },
                },
              },
            },
          }),
        };
        const plugins: BetterAuthPlugin[] = [];
        if (native) {
          for (const [index, method] of create.entries()) {
            plugins.push({
              id: `create-${index}`,
              init: () => ({
                options: {
                  databaseHooks: {
                    user: {
                      create: { before: async (...args) => method(...args) },
                    },
                  },
                },
              }),
            });
          }
          for (const [index, method] of update.entries()) {
            plugins.push({
              id: `update-${index}`,
              init: () => ({
                options: {
                  databaseHooks: {
                    user: {
                      update: { before: async (...args) => method(...args) },
                    },
                  },
                },
              }),
            });
          }
          for (const [index, method] of many.entries()) {
            plugins.push({
              id: `many-${index}`,
              init: () => ({
                options: {
                  databaseHooks: {
                    account: {
                      update: { before: async (...args) => method(...args) },
                    },
                  },
                },
              }),
            });
          }
        } else {
          const plugin = nestjs();
          const bound = binding();
          (plugin as unknown as Record<symbol, BridgeHandle>)[
            Symbol.for("nestjs-slightly-better-auth:bridge")
          ].bind({
            ...bound,
            database: {
              ...bound.database,
              "user.create": { before: create, after: [] },
              "user.update": { before: update, after: [] },
              "account.update": { before: many, after: [] },
            },
          });
          plugins.push(plugin);
        }
        const ctx = await betterAuth({
          ...options,
          database: memoryAdapter(data),
          plugins: [first, ...plugins],
        }).$context;
        const created = await ctx.internalAdapter.createOAuthUser(
          {
            name: " generated ",
            email: "generated@example.test",
            emailVerified: false,
          },
          { providerId: "test", accountId: "generated" },
        );
        const updated = await ctx.internalAdapter.updateUser(row.id, {
          name: " update ",
        });
        await ctx.internalAdapter.updatePassword(row.id, " password ");
        const accounts = await ctx.internalAdapter.findAccounts(row.id);
        return {
          created: { name: created.user.name },
          updated: { name: updated.name, image: updated.image },
          many: accounts.map((account) => ({
            password: account.password,
            scope: account.scope,
          })),
          seen,
        };
      };
      const native = await execute(true);
      expect(await execute(false)).toEqual(native);
      expect(native.many).toEqual([
        { password: "password", scope: `scope-${seed % 4}` },
      ]);
    }
  });

  it("counts every unbound DB dispatcher and dispatches closed bindings", async () => {
    let count = 0;
    let selected: BridgeBinding | null = null;
    const dispatchers = createDatabaseDispatchers(
      () => selected,
      () => {
        count++;
      },
    );
    for (const model of Object.values(dispatchers)) {
      for (const operation of Object.values(model)) {
        await operation.before?.(row as never, null);
        await operation.after?.(row as never, null);
      }
    }
    expect(count).toBe(24);
    const bound = binding();
    selected = {
      ...bound,
      state: "closed",
      database: {
        ...bound.database,
        "user.create": { before: [() => false], after: [] },
      },
    };
    expect(await dispatchers.user?.create?.before?.(row, null)).toBe(false);
    expect(count).toBe(24);
  });
});
