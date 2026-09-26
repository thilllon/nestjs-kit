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

Declare the group and its keys once with `defineStrategyGroup()`. The keys become literal types, so the editor autocompletes them in `@Strategy`, `defaultKey` and `registry.get()`, and a misspelled key is a compile error:

```ts
import {
  BadRequestException,
  Inject,
  Injectable,
  Module,
} from "@nestjs/common";
import {
  defineStrategyGroup,
  StrategyModule,
  type StrategyKeyOf,
  type StrategyRegistry,
} from "nestjs-strategy";

export interface PaymentStrategy {
  pay(amount: number): Promise<string>;
}

export const payment = defineStrategyGroup("payment", ["card", "bank"]);
export type PaymentMethod = StrategyKeyOf<typeof payment>; // "card" | "bank"

@payment.Strategy("card")
@Injectable()
export class CardPayment implements PaymentStrategy {
  async pay(amount: number) {
    return `charged ${amount} to the card`;
  }
}

@payment.Strategy("bank")
@Injectable()
export class BankTransfer implements PaymentStrategy {
  async pay(amount: number) {
    return `requested a transfer of ${amount}`;
  }
}

@Injectable()
export class CheckoutService {
  constructor(
    @Inject(payment.token)
    private readonly payments: StrategyRegistry<PaymentStrategy, PaymentMethod>,
  ) {}

  checkout(method: PaymentMethod, amount: number) {
    return this.payments.get(method).pay(amount);
  }

  checkoutRequest(method: string, amount: number) {
    // has() narrows an untrusted string to PaymentMethod.
    if (!this.payments.has(method)) {
      throw new BadRequestException(`Unsupported payment method: ${method}`);
    }
    return this.checkout(method, amount);
  }
}

@Module({
  imports: [
    StrategyModule.register({
      group: payment,
      strategies: [CardPayment, BankTransfer],
      defaultKey: "card",
    }),
  ],
  providers: [CheckoutService],
})
export class CheckoutModule {}
```

`StrategyModule.register()` instantiates every strategy through Nest dependency injection and exports a `StrategyRegistry` under `payment.token`. With a `group`, registration also requires exactly one strategy for every declared key, so `payments.get(method)` with a `PaymentMethod` never throws `UnknownStrategyError`. Adding a payment method means declaring its key and adding a decorated class to `strategies`; `CheckoutService` does not change.

### Keys without a group

`@Strategy(key)` and `StrategyModule.register({ name, strategies })` accept any string key. The registry is then a `StrategyRegistry<PaymentStrategy>` with `string` keys, injected with `@Inject(getStrategyRegistryToken("payment"))`:

```ts
@Strategy("card")
@Injectable()
export class CardPayment implements PaymentStrategy {
  async pay(amount: number) {
    return `charged ${amount} to the card`;
  }
}

StrategyModule.register({
  name: "payment",
  strategies: [CardPayment, BankTransfer],
  defaultKey: "card",
});
```

## Registry API

| Member                       | Behavior                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `get(key)`                   | Returns the strategy registered for `key`. Throws `UnknownStrategyError` for an unregistered key.          |
| `get()`                      | Returns the `defaultKey` strategy. Throws `UnknownStrategyError` when the group has no default.            |
| `find(key)`                  | Returns the strategy for `key`, or `undefined`. Accepts any string; declared keys are still autocompleted. |
| `has(key)`                   | Reports whether `key` is registered and narrows `key` to the registry's key type.                          |
| `keys()`, `values()`         | Keys and strategies in registration order.                                                                 |
| `entries()`, iteration       | `[key, strategy]` pairs in registration order; `for (const [key, strategy] of registry)` works directly.   |
| `size`, `name`, `defaultKey` | Group size, group name and default key.                                                                    |

`StrategyRegistry<T, K>` types the strategies as `T` and the keys as `K`. `K` defaults to `string`; pass `StrategyKeyOf<typeof group>` for a declared group.

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
  group: payment,
  strategies: [CardPayment, BankTransfer],
  imports: [PaymentGatewayModule],
});
```

Each registration creates its own strategy instances. Nest lifecycle hooks such as `onModuleInit` and `onModuleDestroy` run on them like on any other provider.

## Multiple strategy groups

Register one module per group. Groups are isolated: the same key, or even the same class, can appear in several groups, and each registration has its own instances and registry.

```ts
export const shipping = defineStrategyGroup("shipping", [
  "standard",
  "express",
]);

@Module({
  imports: [
    StrategyModule.register({
      group: payment,
      strategies: [CardPayment, BankTransfer],
    }),
    StrategyModule.register({
      group: shipping,
      strategies: [StandardShipping, ExpressShipping],
      defaultKey: "standard",
    }),
  ],
})
export class OrdersModule {}
```

Inject each registry with `@Inject(payment.token)` or `@Inject(shipping.token)`; for groups registered by `name`, use `@Inject(getStrategyRegistryToken(name))`. Use a distinct name for every group injected together. Set `global: true` to make a group's registry injectable everywhere.

## Validation

`StrategyModule.register()` throws before the application bootstraps when:

- `name` is empty or `strategies` is empty;
- a class has no `@Strategy()` key of its own (keys are not inherited from a parent class);
- two strategies use the same key;
- `defaultKey` is not a registered key;
- with a `group`, a strategy uses a key the group does not declare, or a declared key has no strategy.

`@Strategy("")` throws immediately. `defineStrategyGroup()` throws for an empty name, no keys, an empty key or a duplicated key, and `group.Strategy(key)` throws for an undeclared key passed from untyped code.

## Comparison with Spring

In Spring, beans that implement a strategy interface are injected together as `Map<String, Strategy>` keyed by bean name. This package follows the same model for Nest providers:

| Spring                                          | nestjs-strategy                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------- |
| `@Component("card")` on an implementation       | `@payment.Strategy("card")` on a provider class                  |
| Component scanning of the interface's beans     | `StrategyModule.register({ name, strategies })`                  |
| Injected `Map<String, PaymentStrategy>`         | Injected `StrategyRegistry<PaymentStrategy>`                     |
| `map.get(key)`, `map.getOrDefault(key, …)`      | `registry.get(key)`, `registry.get()` with `defaultKey`          |
| Injected `List<PaymentStrategy>` + `supports()` | `registry.values().find((strategy) => strategy.supports(input))` |

TypeScript interfaces do not exist at runtime, so a group is identified by its `name` instead of by the interface type.

## API

| API                                | Purpose                                             |
| ---------------------------------- | --------------------------------------------------- |
| `defineStrategyGroup(name, keys)`  | Declare a group whose keys are literal types.       |
| `group.Strategy(key)`              | Name a provider class with one of the group's keys. |
| `group.token`                      | Injection token of the group's `StrategyRegistry`.  |
| `StrategyKeyOf<typeof group>`      | Union of the group's keys.                          |
| `@Strategy(key)`                   | Name a provider class as a strategy.                |
| `StrategyModule.register(options)` | Register a strategy group and export its registry.  |
| `getStrategyRegistryToken(name)`   | Injection token of a group's `StrategyRegistry`.    |
| `StrategyRegistry<T>`              | Select strategies by key.                           |
| `UnknownStrategyError`             | Error for an unregistered key or a missing default. |
| `getStrategyKey(target)`           | Read the key a class declares with `@Strategy()`.   |

[Contributing](https://github.com/thilllon/nestjs-kit/blob/main/CONTRIBUTING.md)
