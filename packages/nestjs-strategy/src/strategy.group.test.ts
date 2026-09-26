import { Inject, Injectable, type Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, expectTypeOf, it } from "vitest";
import { Strategy } from "./strategy.decorator";
import { defineStrategyGroup, type StrategyKeyOf } from "./strategy.group";
import { StrategyModule } from "./strategy.module";
import type { StrategyRegistry } from "./strategy.registry";

interface PaymentStrategy {
  pay(amount: number): string;
}

const payment = defineStrategyGroup("payment", ["card", "bank"]);
type PaymentMethod = StrategyKeyOf<typeof payment>;

@payment.Strategy("card")
@Injectable()
class CardPayment implements PaymentStrategy {
  pay(amount: number): string {
    return `card:${amount}`;
  }
}

@payment.Strategy("bank")
@Injectable()
class BankPayment implements PaymentStrategy {
  pay(amount: number): string {
    return `bank:${amount}`;
  }
}

@Strategy("crypto")
@Injectable()
class CryptoPayment implements PaymentStrategy {
  pay(amount: number): string {
    return `crypto:${amount}`;
  }
}

describe("defineStrategyGroup", () => {
  it("injects a registry that selects every declared key", async () => {
    @Injectable()
    class Checkout {
      constructor(
        @Inject(payment.token)
        readonly payments: StrategyRegistry<PaymentStrategy, PaymentMethod>,
      ) {}

      pay(method: string, amount: number): string {
        if (!this.payments.has(method)) {
          return "unsupported";
        }
        return this.payments.get(method).pay(amount);
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        StrategyModule.register({
          group: payment,
          strategies: [CardPayment, BankPayment],
          defaultKey: "bank",
        }),
      ],
      providers: [Checkout],
    }).compile();
    try {
      const checkout = module.get(Checkout);
      expect(checkout.payments.name).toBe("payment");
      expect(checkout.payments.keys()).toEqual(["card", "bank"]);
      expect(checkout.pay("card", 10)).toBe("card:10");
      expect(checkout.pay("crypto", 10)).toBe("unsupported");
      expect(checkout.payments.get().pay(10)).toBe("bank:10");
      expect(checkout.payments.find("crypto")).toBeUndefined();
    } finally {
      await module.close();
    }
  });

  it.each([
    [
      "a strategy with an undeclared key",
      [CardPayment, BankPayment, CryptoPayment],
      'CryptoPayment in strategy group "payment" uses the undeclared key "crypto"; declared keys: "card", "bank"',
    ],
    [
      "a declared key without a strategy",
      [CardPayment],
      'Strategy group "payment" has no strategy for its declared keys: "bank"',
    ],
  ])("rejects %s at registration", (_case, strategies, message) => {
    expect(() =>
      StrategyModule.register({
        group: payment,
        strategies: strategies as Type[],
      }),
    ).toThrow(message);
  });

  it("rejects a group that defineStrategyGroup() did not create", () => {
    expect(() =>
      StrategyModule.register({
        group: { name: "payment" } as never,
        strategies: [CardPayment],
      }),
    ).toThrow(
      "StrategyModule requires a group created by defineStrategyGroup()",
    );
  });

  it("rejects a default key the group does not register", () => {
    expect(() =>
      StrategyModule.register({
        group: payment,
        strategies: [CardPayment, BankPayment],
        defaultKey: "crypto" as never,
      }),
    ).toThrow(
      'Strategy group "payment" has no strategy for its default key "crypto"',
    );
  });

  it.each([
    [
      "an empty name",
      "",
      ["card"],
      "defineStrategyGroup() requires a non-empty name",
    ],
    ["no keys", "payment", [], 'Strategy group "payment" declares no keys'],
    [
      "an empty key",
      "payment",
      [""],
      'Strategy group "payment" declares an empty key',
    ],
    [
      "a duplicated key",
      "payment",
      ["card", "card"],
      'Strategy group "payment" declares the key "card" more than once',
    ],
  ])("rejects %s", (_case, name, keys, message) => {
    expect(() =>
      defineStrategyGroup(name, keys as unknown as [string, ...string[]]),
    ).toThrow(message);
  });

  it("rejects an undeclared key passed to the group decorator", () => {
    expect(() => payment.Strategy("crypto" as PaymentMethod)).toThrow(
      'Strategy group "payment" declares no key "crypto"; declared keys: "card", "bank"',
    );
  });

  it("exposes the declared keys and registry token read-only", () => {
    expect(payment.keys).toEqual(["card", "bank"]);
    expect(payment.token).toBe("STRATEGY_REGISTRY_payment");
    expect(Object.isFrozen(payment)).toBe(true);
    expect(Object.isFrozen(payment.keys)).toBe(true);
  });
});

// Compile-time contracts, checked by the package typecheck. The function is never called.
export function keyTypeContracts(
  registry: StrategyRegistry<PaymentStrategy, PaymentMethod>,
  untyped: StrategyRegistry<PaymentStrategy>,
  input: string,
): void {
  expectTypeOf<PaymentMethod>().toEqualTypeOf<"card" | "bank">();
  expectTypeOf(payment.keys).toEqualTypeOf<readonly ("card" | "bank")[]>();
  expectTypeOf(registry.keys()).toEqualTypeOf<("card" | "bank")[]>();
  expectTypeOf(registry.get("card")).toEqualTypeOf<PaymentStrategy>();
  // @ts-expect-error "crypto" is not a declared key.
  registry.get("crypto");
  expectTypeOf(registry.find("crypto")).toEqualTypeOf<
    PaymentStrategy | undefined
  >();
  if (registry.has(input)) {
    expectTypeOf(input).toEqualTypeOf<"card" | "bank">();
  }
  // @ts-expect-error The group decorator accepts only declared keys.
  payment.Strategy("crypto");
  // @ts-expect-error The default key must be a declared key.
  StrategyModule.register({
    group: payment,
    strategies: [CardPayment, BankPayment],
    defaultKey: "crypto",
  });
  // @ts-expect-error A registration names its group or its name, not both.
  StrategyModule.register({ group: payment, name: "payment", strategies: [] });
  expectTypeOf(untyped.get("any-key")).toEqualTypeOf<PaymentStrategy>();
  expectTypeOf(untyped.keys()).toEqualTypeOf<string[]>();
}
