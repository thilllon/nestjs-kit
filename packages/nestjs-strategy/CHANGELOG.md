# nestjs-strategy

## 1.1.0

### Minor Changes

- 7662ae9: Add `defineStrategyGroup(name, keys)` to declare a strategy group whose keys are literal types. Editors autocomplete the keys in `group.Strategy(key)`, `defaultKey` and `registry.get(key)`, and a misspelled key fails to compile. `StrategyModule.register({ group, strategies })` requires a strategy for every declared key and rejects undeclared keys, `StrategyRegistry<T, K>` takes a key type, and `registry.has(key)` narrows an untrusted string to a declared key. Registration by `name` with string keys is unchanged.

## 1.0.0

### Major Changes

- 1fd958f: Introduce strategy-pattern registries for NestJS: name provider classes with `@Strategy(key)`, register them per group with `StrategyModule.register()`, and inject a `StrategyRegistry` that selects DI-constructed strategies by key, with an optional default strategy and validation of keys at registration.
