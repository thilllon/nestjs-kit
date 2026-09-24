import {
  type DynamicModule,
  Module,
  type ModuleMetadata,
  type Type,
} from "@nestjs/common";
import { getStrategyKey } from "./strategy.decorator";
import { StrategyRegistry } from "./strategy.registry";
import { getStrategyRegistryToken } from "./strategy.tokens";

export interface StrategyModuleOptions {
  /** Strategy group name; `getStrategyRegistryToken(name)` injects its registry. */
  name: string;
  /** Provider classes, each decorated with `@Strategy(key)`. */
  strategies: Type[];
  /** Key of the strategy returned by `registry.get()` without a key. */
  defaultKey?: string;
  /** Modules whose exported providers the strategies inject. */
  imports?: ModuleMetadata["imports"];
  /** Registers the module globally. Defaults to `false`. */
  isGlobal?: boolean;
}

@Module({})
export class StrategyModule {
  /**
   * Instantiates the strategies through Nest dependency injection and exports
   * their `StrategyRegistry` under `getStrategyRegistryToken(name)`.
   */
  static register(options: StrategyModuleOptions): DynamicModule {
    const { name, defaultKey, imports = [], isGlobal } = options;
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
      return key;
    });
    const token = getStrategyRegistryToken(name);
    // Validates duplicate and default keys before bootstrap.
    new StrategyRegistry(
      name,
      keys.map((key, index) => [key, strategies[index]] as const),
      defaultKey,
    );
    return {
      module: StrategyModule,
      global: isGlobal ?? false,
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
