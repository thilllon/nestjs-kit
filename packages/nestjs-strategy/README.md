# nestjs-strategy

**The strategy pattern for NestJS.** Name interchangeable providers with `@Strategy(key)`, register them as a group, and inject one registry that selects the implementation by key at runtime.

[![npm version](https://img.shields.io/npm/v/nestjs-strategy)](https://www.npmjs.com/package/nestjs-strategy)
[![npm monthly downloads](https://img.shields.io/npm/dm/nestjs-strategy)](https://www.npmjs.com/package/nestjs-strategy)
[![CI](https://img.shields.io/github/actions/workflow/status/thilllon/nestjs-kit/ci.yml?branch=main)](https://github.com/thilllon/nestjs-kit/actions/workflows/ci.yml)

## Install

```sh
pnpm add nestjs-strategy
```

Requires **Node.js 24+** and **NestJS 12**. Ships ESM, CommonJS, and TypeScript declarations.

## Define and select strategies

Declare the common interface, implement it in providers, and name each implementation with `@Strategy(key)`:

```ts
import { Inject, Injectable, Module } from "@nestjs/common";
import {
  getStrategyRegistryToken,
  Strategy,
  StrategyModule,
  type StrategyRegistry,
} from "nestjs-strategy";

export interface PaymentStrategy {
  pay(amount: number): Promise<string>;
}

@Strategy("card")
@Injectable()
export class CardPayment implements PaymentStrategy {
  async pay(amount: number) {
    return `charged ${amount} to the card`;
  }
}

@Strategy("bank")
@Injectable()
export class BankTransfer implements PaymentStrategy {
  async pay(amount: number) {
    return `requested a transfer of ${amount}`;
  }
}

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(getStrategyRegistryToken("payment"))
    private readonly payments: StrategyRegistry<PaymentStrategy>,
  ) {}

  checkout(method: string, amount: number) {
    return this.payments.get(method).pay(amount);
  }
}

@Module({
  imports: [
    StrategyModule.register({
      name: "payment",
      strategies: [CardPayment, BankTransfer],
      defaultKey: "card",
    }),
  ],
  providers: [CheckoutService],
})
export class CheckoutModule {}
```

`StrategyModule.register()` instantiates every strategy through Nest dependency injection and exports a `StrategyRegistry` under `getStrategyRegistryToken(name)`. Adding a payment method means adding a decorated class to `strategies`; `CheckoutService` does not change.

## Registry API

| Member                       | Behavior                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| `get(key)`                   | Returns the strategy registered for `key`. Throws `UnknownStrategyError` for an unregistered key.        |
| `get()`                      | Returns the `defaultKey` strategy. Throws `UnknownStrategyError` when the group has no default.          |
| `find(key)`                  | Returns the strategy for `key`, or `undefined`.                                                          |
| `has(key)`                   | Reports whether `key` is registered.                                                                     |
| `keys()`, `values()`         | Keys and strategies in registration order.                                                               |
| `entries()`, iteration       | `[key, strategy]` pairs in registration order; `for (const [key, strategy] of registry)` works directly. |
| `size`, `name`, `defaultKey` | Group size, group name and default key.                                                                  |

`UnknownStrategyError` exposes `group`, `key` and `registeredKeys`, and its message lists the registered keys. Map it to an HTTP error in your controller or exception filter when the key comes from a request.

To select by capability instead of by key, iterate over the strategies:

```ts
const strategy = registry
  .values()
  .find((candidate) => candidate.supports(order));
```

## Dependencies of strategies

Strategies are ordinary providers and may inject other providers. List the modules that export those providers in `imports`:

```ts
StrategyModule.register({
  name: "payment",
  strategies: [CardPayment, BankTransfer],
  imports: [PaymentGatewayModule],
});
```

Each registration creates its own strategy instances. Nest lifecycle hooks such as `onModuleInit` and `onModuleDestroy` run on them like on any other provider.

## Multiple strategy groups

Register one module per group. Groups are isolated: the same key, or even the same class, can appear in several groups, and each registration has its own instances and registry.

```ts
@Module({
  imports: [
    StrategyModule.register({
      name: "payment",
      strategies: [CardPayment, BankTransfer],
    }),
    StrategyModule.register({
      name: "shipping",
      strategies: [StandardShipping, ExpressShipping],
      defaultKey: "standard",
    }),
  ],
})
export class OrdersModule {}
```

Inject each registry with `@Inject(getStrategyRegistryToken("payment"))` or `@Inject(getStrategyRegistryToken("shipping"))`. Use a distinct `name` for every group injected together. Set `isGlobal: true` to make a group's registry injectable everywhere.

## Validation

`StrategyModule.register()` throws before the application bootstraps when:

- `name` is empty or `strategies` is empty;
- a class has no `@Strategy()` key of its own (keys are not inherited from a parent class);
- two strategies use the same key;
- `defaultKey` is not a registered key.

`@Strategy("")` throws immediately.

## Comparison with Spring

In Spring, beans that implement a strategy interface are injected together as `Map<String, Strategy>` keyed by bean name. This package follows the same model for Nest providers:

| Spring                                          | nestjs-strategy                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `@Component("card")` on an implementation       | `@Strategy("card")` on a provider class                          |
| Component scanning of the interface's beans     | `StrategyModule.register({ name, strategies })`                  |
| Injected `Map<String, PaymentStrategy>`         | Injected `StrategyRegistry<PaymentStrategy>`                     |
| `map.get(key)`, `map.getOrDefault(key, …)`      | `registry.get(key)`, `registry.get()` with `defaultKey`          |
| Injected `List<PaymentStrategy>` + `supports()` | `registry.values().find((strategy) => strategy.supports(input))` |

TypeScript interfaces do not exist at runtime, so a group is identified by its `name` instead of by the interface type.

## API

| API                                | Purpose                                             |
| ---------------------------------- | --------------------------------------------------- |
| `@Strategy(key)`                   | Name a provider class as a strategy.                |
| `StrategyModule.register(options)` | Register a strategy group and export its registry.  |
| `getStrategyRegistryToken(name)`   | Injection token of a group's `StrategyRegistry`.    |
| `StrategyRegistry<T>`              | Select strategies by key.                           |
| `UnknownStrategyError`             | Error for an unregistered key or a missing default. |
| `getStrategyKey(target)`           | Read the key a class declares with `@Strategy()`.   |

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
