import { Inject, Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { Strategy } from "./strategy.decorator";
import { StrategyModule } from "./strategy.module";
import { StrategyRegistry, UnknownStrategyError } from "./strategy.registry";
import { getStrategyRegistryToken } from "./strategy.tokens";

interface PaymentStrategy {
  pay(amount: number): string;
}

@Injectable()
class FeeCalculator {
  fee(amount: number): number {
    return Math.round(amount * 0.03);
  }
}

@Module({
  providers: [FeeCalculator],
  exports: [FeeCalculator],
})
class FeeModule {}

@Strategy("card")
@Injectable()
class CardPayment implements PaymentStrategy {
  constructor(private readonly fees: FeeCalculator) {}

  pay(amount: number): string {
    return `card:${amount + this.fees.fee(amount)}`;
  }
}

@Strategy("bank")
@Injectable()
class BankPayment implements PaymentStrategy {
  pay(amount: number): string {
    return `bank:${amount}`;
  }
}

@Strategy("standard")
@Injectable()
class StandardShipping {}

describe("StrategyModule", () => {
  it("injects a registry of DI-constructed strategies selected by key", async () => {
    @Injectable()
    class Checkout {
      constructor(
        @Inject(getStrategyRegistryToken("payment"))
        readonly payments: StrategyRegistry<PaymentStrategy>,
      ) {}
    }
    const module = await Test.createTestingModule({
      imports: [
        StrategyModule.register({
          name: "payment",
          strategies: [CardPayment, BankPayment],
          defaultKey: "bank",
          imports: [FeeModule],
        }),
      ],
      providers: [Checkout],
    }).compile();
    try {
      const { payments } = module.get(Checkout);
      expect(payments.keys()).toEqual(["card", "bank"]);
      expect(payments.get("card")).toBeInstanceOf(CardPayment);
      expect(payments.get("card").pay(100)).toBe("card:103");
      expect(payments.get().pay(100)).toBe("bank:100");
      expect(payments.find("crypto")).toBeUndefined();
      expect([...payments].map(([key]) => key)).toEqual(["card", "bank"]);
      expect(() => payments.get("crypto")).toThrow(UnknownStrategyError);
      expect(() => payments.get("crypto")).toThrow(
        'Strategy group "payment" has no strategy "crypto"; registered keys: "card", "bank"',
      );
    } finally {
      await module.close();
    }
  });

  it("keeps strategy groups and their instances isolated", async () => {
    @Injectable()
    class Consumer {
      constructor(
        @Inject(getStrategyRegistryToken("payment"))
        readonly payments: StrategyRegistry<PaymentStrategy>,
        @Inject(getStrategyRegistryToken("refund"))
        readonly refunds: StrategyRegistry<PaymentStrategy>,
        @Inject(getStrategyRegistryToken("shipping"))
        readonly shipping: StrategyRegistry,
      ) {}
    }
    const module = await Test.createTestingModule({
      imports: [
        StrategyModule.register({
          name: "payment",
          strategies: [BankPayment],
        }),
        StrategyModule.register({
          name: "refund",
          strategies: [BankPayment],
        }),
        StrategyModule.register({
          name: "shipping",
          strategies: [StandardShipping],
        }),
      ],
      providers: [Consumer],
    }).compile();
    try {
      const { payments, refunds, shipping } = module.get(Consumer);
      expect(payments.keys()).toEqual(["bank"]);
      expect(shipping.keys()).toEqual(["standard"]);
      expect(payments.get("bank")).not.toBe(refunds.get("bank"));
      expect(() => payments.get()).toThrow(
        'Strategy group "payment" has no default strategy; pass one of: "bank"',
      );
    } finally {
      await module.close();
    }
  });

  it("keeps keys aligned with instances when the caller reorders its list", async () => {
    const strategies = [CardPayment, BankPayment];
    const registration = StrategyModule.register({
      name: "payment",
      strategies,
      imports: [FeeModule],
    });
    strategies.reverse();
    const module = await Test.createTestingModule({
      imports: [registration],
    }).compile();
    try {
      const payments = module.get<StrategyRegistry<PaymentStrategy>>(
        getStrategyRegistryToken("payment"),
      );
      expect(payments.get("card")).toBeInstanceOf(CardPayment);
      expect(payments.get("bank")).toBeInstanceOf(BankPayment);
    } finally {
      await module.close();
    }
  });

  class Undecorated {}

  class InheritedKey extends BankPayment {}

  @Strategy("bank")
  class DuplicateBank {}

  it.each([
    [
      "an empty name",
      { name: "", strategies: [BankPayment] },
      "StrategyModule requires a non-empty name",
    ],
    [
      "no strategies",
      { name: "payment", strategies: [] },
      'Strategy group "payment" requires at least one strategy',
    ],
    [
      "a class without @Strategy()",
      { name: "payment", strategies: [Undecorated] },
      'Undecorated in strategy group "payment" has no @Strategy() key',
    ],
    [
      "a key inherited from a parent class",
      { name: "payment", strategies: [InheritedKey] },
      'InheritedKey in strategy group "payment" has no @Strategy() key',
    ],
    [
      "a duplicated key",
      { name: "payment", strategies: [BankPayment, DuplicateBank] },
      'Strategy group "payment" registers the key "bank" more than once',
    ],
    [
      "an unregistered default key",
      { name: "payment", strategies: [BankPayment], defaultKey: "card" },
      'Strategy group "payment" has no strategy for its default key "card"',
    ],
  ])("rejects %s at registration", (_case, options, message) => {
    expect(() => StrategyModule.register(options)).toThrow(message);
  });

  it("rejects an empty @Strategy() key", () => {
    expect(() => Strategy("")).toThrow("@Strategy() requires a non-empty key");
  });
});
