---
"nestjs-strategy": minor
---

Add `defineStrategyGroup(name, keys)` to declare a strategy group whose keys are literal types. Editors autocomplete the keys in `group.Strategy(key)`, `defaultKey` and `registry.get(key)`, and a misspelled key fails to compile. `StrategyModule.register({ group, strategies })` requires a strategy for every declared key and rejects undeclared keys, `StrategyRegistry<T, K>` takes a key type, and `registry.has(key)` narrows an untrusted string to a declared key. Registration by `name` with string keys is unchanged.
