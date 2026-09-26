import {
  type DynamicModule,
  Module,
  type ModuleMetadata,
  type Type,
} from "@nestjs/common";
import { getStrategyKey } from "./strategy.decorator";
import { quoted, type StrategyGroup } from "./strategy.group";
import { StrategyRegistry } from "./strategy.registry";
import { getStrategyRegistryToken } from "./strategy.tokens";

interface StrategyModuleBaseOptions {
  /** Provider classes, each decorated with `@Strategy(key)`. */
  strategies: Type[];
  /** Modules whose exported providers the strategies inject. */
  imports?: ModuleMetadata["imports"];
  /** Registers the module globally. Defaults to `false`. */
  global?: boolean;
}

export interface StrategyModuleOptions extends StrategyModuleBaseOptions {
  /** Strategy group name; `getStrategyRegistryToken(name)` injects its registry. */
  name: string;
  /** Key of the strategy returned by `registry.get()` without a key. */
  defaultKey?: string;
  group?: never;
}

export interface StrategyGroupModuleOptions<K extends string>
  extends StrategyModuleBaseOptions {
  /**
   * Group declared with `defineStrategyGroup()`. The strategies must register
   * every declared key and no other key.
   */
  group: StrategyGroup<K>;
  /** Declared key of the strategy returned by `registry.get()` without a key. */
  defaultKey?: NoInfer<K>;
  name?: never;
}

@Module({})
export class StrategyModule {
  /**
   * Instantiates the strategies through Nest dependency injection and exports
   * their `StrategyRegistry` under `getStrategyRegistryToken(name)`.
   */
  static register<K extends string>(
    options: StrategyModuleOptions | StrategyGroupModuleOptions<K>,
  ): DynamicModule {
    const { group, defaultKey, imports = [] } = options;
    if (group !== undefined && !isStrategyGroup(group)) {
      throw new Error(
        "StrategyModule requires a group created by defineStrategyGroup()",
      );
    }
    const name = group === undefined ? options.name : group.name;
    if (typeof name !== "string" || name === "") {
      throw new Error("StrategyModule requires a non-empty name");
    }
    if (!Array.isArray(options.strategies) || options.strategies.length === 0) {
      throw new Error(
        `Strategy group "${name}" requires at least one strategy`,
      );
    }
    // Providers, injection order and keys share one snapshot of the caller's list.
    const strategies = [...options.strategies];
    const keys = strategies.map((strategy) => {
      const key = getStrategyKey(strategy);
      if (key === undefined) {
        throw new Error(
          `${strategy.name} in strategy group "${name}" has no @Strategy() key`,
        );
      }
      if (group !== undefined && !group.keys.includes(key as K)) {
        throw new Error(
          `${strategy.name} in strategy group "${name}" uses the undeclared key "${key}"; declared keys: ${quoted(group.keys)}`,
        );
      }
      return key;
    });
    const token = getStrategyRegistryToken(name);
    // Validates duplicate and default keys before bootstrap.
    new StrategyRegistry(
      name,
      keys.map((key, index) => [key, strategies[index]] as const),
      defaultKey,
    );
    const missing =
      group === undefined
        ? []
        : group.keys.filter((key) => !keys.includes(key));
    if (missing.length > 0) {
      throw new Error(
        `Strategy group "${name}" has no strategy for its declared keys: ${quoted(missing)}`,
      );
    }
    return {
      module: StrategyModule,
      global: options.global ?? false,
      imports,
      providers: [
        ...strategies,
        {
          provide: token,
          inject: strategies,
          useFactory: (...instances: unknown[]) =>
            new StrategyRegistry(
              name,
              keys.map((key, index) => [key, instances[index]] as const),
              defaultKey,
            ),
        },
      ],
      exports: [token],
    };
  }
}

function isStrategyGroup(value: unknown): value is StrategyGroup {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { name, keys } = value as Partial<StrategyGroup>;
  return typeof name === "string" && Array.isArray(keys);
}
