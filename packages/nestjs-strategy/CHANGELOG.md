# nestjs-strategy

## 1.0.0

### Major Changes

- 1fd958f: Introduce strategy-pattern registries for NestJS: name provider classes with `@Strategy(key)`, register them per group with `StrategyModule.register()`, and inject a `StrategyRegistry` that selects DI-constructed strategies by key, with an optional default strategy and validation of keys at registration.
