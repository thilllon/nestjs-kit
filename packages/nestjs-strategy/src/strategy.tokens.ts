/** Injection token of the `StrategyRegistry` registered under `name`. */
export function getStrategyRegistryToken(name: string): string {
  return `STRATEGY_REGISTRY_${name}`;
}
