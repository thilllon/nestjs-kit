import type { BetterAuthOptions } from "better-auth";
import type { DatabaseHookTarget } from "./auth-contracts.js";
import type {
  DatabaseHookData,
  DatabaseHookResult,
  DbHookFn,
} from "./auth-types.js";
import type { BridgeBinding } from "./bridge-protocol.js";

/**
 * Construct all dispatchers once; bindings supply only the late-bound methods.
 *
 * The dispatchers take the SDK's own parameter types, so they satisfy `databaseHooks` whatever
 * instance the program registers. Bound hooks declare `DatabaseHookData`, which adds the
 * registered instance's plugin and additional fields (for example admin()'s `banned`) to the
 * same rows; the dispatcher states that narrowing once when it forwards a payload.
 */
export function createDatabaseDispatchers(
  getBinding: () => BridgeBinding | null,
  countUnbound: () => void,
): NonNullable<BetterAuthOptions["databaseHooks"]> {
  function operation<E extends DatabaseHookTarget>(target: E) {
    const before = async (
      ...[data, ctx]: Parameters<DbHookFn<E, "before">>
    ): Promise<DatabaseHookResult<E, "before">> => {
      const binding = getBinding();
      if (!binding) {
        countUnbound();
        return undefined as DatabaseHookResult<E, "before">;
      }
      const hooks = binding.database[target].before;
      let accumulated: Record<string, unknown> = {};
      let changed = false;
      for (const hook of hooks) {
        const result = await hook(
          (target.endsWith(".create")
            ? { ...data, ...accumulated }
            : data) as DatabaseHookData<E, "before">,
          ctx,
        );
        if (result === false) {
          return false as DatabaseHookResult<E, "before">;
        }
        if (
          !target.endsWith(".delete") &&
          result &&
          typeof result === "object" &&
          "data" in result
        ) {
          accumulated = { ...accumulated, ...result.data };
          changed = true;
        }
      }
      // A generic target cannot express the runtime delete narrowing. Delete
      // never reaches this branch; the public binding keeps its void/false type.
      return (
        changed ? { data: accumulated } : undefined
      ) as DatabaseHookResult<E, "before">;
    };
    const after = async (
      ...[data, ctx]: Parameters<DbHookFn<E, "after">>
    ): Promise<void> => {
      const binding = getBinding();
      if (!binding) {
        countUnbound();
        return;
      }
      for (const hook of binding.database[target].after) {
        await hook(data as DatabaseHookData<E, "after">, ctx);
      }
    };
    return { before, after };
  }
  return {
    user: {
      create: operation("user.create"),
      update: operation("user.update"),
      delete: operation("user.delete"),
    },
    session: {
      create: operation("session.create"),
      update: operation("session.update"),
      delete: operation("session.delete"),
    },
    account: {
      create: operation("account.create"),
      update: operation("account.update"),
      delete: operation("account.delete"),
    },
    verification: {
      create: operation("verification.create"),
      update: operation("verification.update"),
      delete: operation("verification.delete"),
    },
  };
}
