// The code examples of README.md, executed. Every `ts` block of the README
// is part of this file, apart from its import statements, its `export`
// keywords and its comment lines; the first test compares the two.

import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable, Logger, Module, Scope } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { lastValueFrom, type Observable, of } from "rxjs";
import { afterEach, describe, expect, it } from "vitest";
import {
  Advisor,
  After,
  AfterReturning,
  AfterThrowing,
  Around,
  Aspect,
  AspectConfigurationError,
  AspectInspector,
  AspectModule,
  type AspectReportLevel,
  Before,
  createAnnotation,
  DeclareParents,
  isIntroduced,
  type JP,
  type MethodInterceptor,
  P,
  type PJP,
} from "./index";
import { observableAdapter } from "./rxjs";
import { RecordingLogger } from "./weaving-fixture";

// ---------------------------------------------------------------------------
// Quick start
// ---------------------------------------------------------------------------

const Audited = createAnnotation<"Audited", string>("Audited");

const audited = P.annotated(Audited);

@Injectable()
class AuditTrail {
  readonly entries: string[] = [];
}

@Aspect()
class AuditAspect {
  constructor(private readonly trail: AuditTrail) {}

  @Before(audited)
  started(jp: JP<typeof audited>): void {
    this.trail.entries.push(`${jp.annotation(Audited)}: ${jp.toString()}`);
  }

  @AfterReturning(audited)
  returned(jp: JP<typeof audited>, result: unknown): void {
    this.trail.entries.push(`${jp.annotation(Audited)} returned ${result}`);
  }

  @AfterThrowing(audited)
  failed(jp: JP<typeof audited>, error: unknown): void {
    this.trail.entries.push(`${jp.annotation(Audited)} failed: ${error}`);
  }
}

@Injectable()
class TransferService {
  @Audited("transfer")
  async transfer(from: string, to: string, amount: number): Promise<number> {
    if (amount <= 0) {
      throw new RangeError(`Cannot move ${amount} from ${from} to ${to}`);
    }
    return amount;
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [TransferService, AuditTrail, AuditAspect],
})
class AppModule {}

// ---------------------------------------------------------------------------
// forRootAsync
// ---------------------------------------------------------------------------

@Injectable()
class Settings {
  readonly aspectReport: AspectReportLevel | false = "log";
}

@Module({
  providers: [Settings],
  exports: [Settings],
})
class SettingsModule {}

@Module({
  imports: [
    AspectModule.forRootAsync({
      imports: [SettingsModule],
      inject: [Settings],
      useFactory: (settings: Settings) => ({ report: settings.aspectReport }),
    }),
  ],
  providers: [TransferService, AuditTrail, AuditAspect],
})
class ConfiguredAppModule {}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

interface RetryOptions {
  attempts: number;
}

const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });

const Internal = createAnnotation<"Internal">("Internal");

class Account {
  constructor(
    readonly id: string,
    public balance = 0,
  ) {}
}

class DeclinedError extends Error {}

@Injectable()
class PaymentGateway {
  readonly failures: Error[] = [];

  @Retryable({ attempts: 3 })
  async charge(account: Account, amount: number): Promise<string> {
    const failure = this.failures.shift();
    if (failure) {
      throw failure;
    }
    account.balance -= amount;
    return `receipt-${account.id}-${amount}`;
  }
}

@Injectable()
class AccountService {
  private readonly accounts = new Map<string, Account>();

  open(id: string): Account {
    const account = new Account(id);
    this.accounts.set(id, account);
    return account;
  }

  find(id: string): Account | undefined {
    return this.accounts.get(id);
  }

  @Internal()
  findAll(): Account[] {
    return [...this.accounts.values()];
  }

  deposit(account: Account, amount: number): Account {
    account.balance += amount;
    return account;
  }
}

@Module({
  providers: [PaymentGateway, AccountService],
  exports: [PaymentGateway, AccountService],
})
class BillingModule {}

// ---------------------------------------------------------------------------
// Pointcuts
// ---------------------------------------------------------------------------

const retryable = P.annotated(Retryable);
const charge = P.method(PaymentGateway, "charge");
const inBilling = P.inModule(BillingModule);
const queries = inBilling.and(P.name("find*")).and(P.annotated(Internal).not());
const deposits = P.within(AccountService).and(P.args(Account, Number));

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

@Aspect()
class DepositLimitAspect {
  @Before(deposits)
  check(jp: JP<typeof deposits>): void {
    const [account, amount] = jp.args;
    if (amount <= 0) {
      throw new RangeError(`Cannot deposit ${amount} into ${account.id}`);
    }
  }
}

@Injectable()
class Ledger {
  readonly lines: string[] = [];
}

@Aspect()
class ReceiptAspect {
  constructor(private readonly ledger: Ledger) {}

  @AfterReturning(charge)
  record(jp: JP<typeof charge>, receipt: string): void {
    const [account, amount] = jp.args;
    this.ledger.lines.push(`${receipt}: ${amount} from ${account.id}`);
  }
}

@Aspect()
class DeclineAspect {
  constructor(private readonly ledger: Ledger) {}

  @AfterThrowing(charge, { throwing: DeclinedError })
  record(jp: JP<typeof charge>, error: DeclinedError): void {
    this.ledger.lines.push(`declined ${jp.args[0].id}: ${error.message}`);
  }
}

@Aspect()
class InFlightAspect {
  inFlight = 0;

  @Before(charge)
  enter(): void {
    this.inFlight += 1;
  }

  @After(charge)
  leave(): void {
    this.inFlight -= 1;
  }
}

@Aspect({ order: 20 })
class RetryAspect {
  @Around(retryable)
  async retry(jp: PJP<typeof retryable>): Promise<unknown> {
    const { attempts } = jp.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await jp.proceed();
      } catch (error) {
        if (error instanceof DeclinedError || attempt >= attempts) {
          throw error;
        }
      }
    }
  }
}

/** Records the calls `queries` selects; the README shows the pointcut only. */
@Aspect()
class QueryAspect {
  readonly seen: string[] = [];

  @Before(queries)
  record(jp: JP<typeof queries>): void {
    this.seen.push(String(jp.signature.name));
  }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const trace: string[] = [];

@Aspect({ order: 1 })
class OuterAspect {
  @Around(charge)
  async around(jp: PJP<typeof charge>): Promise<string> {
    trace.push("outer around: before proceed");
    const receipt = await jp.proceed();
    trace.push("outer around: after proceed");
    return receipt;
  }

  @Before(charge)
  before(): void {
    trace.push("outer before");
  }

  @After(charge)
  after(): void {
    trace.push("outer after");
  }

  @AfterReturning(charge)
  afterReturning(): void {
    trace.push("outer after returning");
  }
}

@Aspect({ order: 2 })
class InnerAspect {
  @Before(charge)
  before(): void {
    trace.push("inner before");
  }

  @AfterReturning(charge)
  afterReturning(): void {
    trace.push("inner after returning");
  }
}

// ---------------------------------------------------------------------------
// Observables
// ---------------------------------------------------------------------------

@Injectable()
class PriceFeed {
  quotes(symbol: string): Observable<number> {
    return symbol === "ACME" ? of(101, 102, 103) : of();
  }
}

const quotes = P.method(PriceFeed, "quotes");

@Aspect()
class ClosingPriceAspect {
  readonly closing = new Map<string, number>();

  @AfterReturning(quotes)
  record(jp: JP<typeof quotes>, last: number): void {
    this.closing.set(jp.args[0], last);
  }
}

@Module({
  imports: [AspectModule.forRoot({ returnValueAdapters: [observableAdapter] })],
  providers: [PriceFeed, ClosingPriceAspect],
})
class FeedModule {}

// ---------------------------------------------------------------------------
// Advisors
// ---------------------------------------------------------------------------

const Transactional = createAnnotation<"Transactional">("Transactional");

@Injectable()
class TransactionManager {
  readonly log: string[] = [];

  async run(work: () => unknown): Promise<unknown> {
    this.log.push("begin");
    try {
      const result = await work();
      this.log.push("commit");
      return result;
    } catch (error) {
      this.log.push("rollback");
      throw error;
    }
  }
}

@Advisor()
class TransactionAdvisor {
  static readonly pointcut = P.annotated(Transactional).or(
    P.withinAnnotated(Transactional),
  );

  readonly order = 100;

  readonly advice: MethodInterceptor = {
    invoke: (invocation) => this.transactions.run(() => invocation.proceed()),
  };

  constructor(private readonly transactions: TransactionManager) {}
}

@Injectable()
@Transactional()
class InvoiceService {
  async issue(account: Account, amount: number): Promise<string> {
    if (amount <= 0) {
      throw new RangeError(`Cannot invoice ${amount}`);
    }
    return `invoice-${account.id}-${amount}`;
  }
}

// ---------------------------------------------------------------------------
// Instantiation models and introductions
// ---------------------------------------------------------------------------

@Injectable({ scope: Scope.TRANSIENT })
class Session {
  touch(): string {
    return "touched";
  }
}

const sessions = P.within(Session);

@Aspect({ instantiation: "perTarget" })
class CallCountAspect {
  private calls = 0;

  constructor(private readonly ledger: Ledger) {}

  @Before(sessions)
  count(): void {
    this.calls += 1;
    this.ledger.lines.push(`call ${this.calls} of this session`);
  }
}

abstract class UsageTracked {
  abstract incrementUseCount(): void;

  abstract get useCount(): number;
}

class DefaultUsageTracked implements UsageTracked {
  private count = 0;

  incrementUseCount(): void {
    this.count += 1;
  }

  get useCount(): number {
    return this.count;
  }
}

@Aspect()
class UsageTrackingAspect {
  @DeclareParents(sessions, { use: DefaultUsageTracked })
  static readonly mixin: UsageTracked;

  @Before(sessions)
  record(jp: JP<typeof sessions>): void {
    jp.introduced(UsageTracked).incrementUseCount();
  }
}

// ---------------------------------------------------------------------------

const billingProviders = [Ledger, RetryAspect];

const opened: { close(): Promise<unknown> }[] = [];

/** A module with the billing module, the retry aspect and `providers`. */
async function billing(...providers: (new (...args: any[]) => unknown)[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [AspectModule.forRoot({ report: false }), BillingModule],
    providers: [...billingProviders, ...providers],
  }).compile();
  opened.push(moduleRef);
  return moduleRef.init();
}

afterEach(async () => {
  trace.length = 0;
  await Promise.all(opened.splice(0).map((closable) => closable.close()));
});

/** Drops what a README block and this file may differ in. */
function normalize(code: string): string {
  return code
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^import\s[\s\S]*?\sfrom\s+"[^"]+";$/gm, "")
    .replace(/^export\s+/gm, "")
    .replace(/\s+/g, "")
    .replace(/,([)\]}])/g, "$1");
}

describe("README examples", () => {
  it("are the code of this file", () => {
    const readme = readFileSync(join(__dirname, "../README.md"), "utf8");
    const source = normalize(readFileSync(__filename, "utf8"));
    const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map(
      ([, code]) => code,
    );

    expect(blocks.length).toBeGreaterThan(10);
    const missing = blocks.filter(
      (block) => !source.includes(normalize(block)),
    );
    expect(missing).toEqual([]);
  });

  it("quick start: audits an annotated method through its outcome", async () => {
    Logger.overrideLogger(false);
    const app = await NestFactory.createApplicationContext(AppModule);
    const transfers = app.get(TransferService);

    await transfers.transfer("alice", "bob", 25);
    await transfers.transfer("alice", "bob", 0).catch(() => undefined);

    const { entries } = app.get(AuditTrail);
    opened.push(app);
    expect(entries).toEqual([
      'transfer: TransferService.transfer("alice", "bob", 25)',
      "transfer returned 25",
      'transfer: TransferService.transfer("alice", "bob", 0)',
      "transfer failed: RangeError: Cannot move 0 from alice to bob",
    ]);
  });

  it("forRootAsync: takes the report level from an injected provider", async () => {
    const logger = new RecordingLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfiguredAppModule],
    })
      .setLogger(logger)
      .compile();
    opened.push(moduleRef);
    await moduleRef.init();

    expect(logger.messages("log")).toEqual([
      "TransferService.transfer <- AuditAspect.started (before, no order)",
      "TransferService.transfer <- AuditAspect.returned (afterReturning, no order)",
      "TransferService.transfer <- AuditAspect.failed (afterThrowing, no order)",
    ]);
  });

  it("annotations: fails the bootstrap when no aspect handles a requiresAdvice annotation", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false }), BillingModule],
    })
      .setLogger(new RecordingLogger())
      .compile();

    await expect(moduleRef.init()).rejects.toThrow(AspectConfigurationError);
    await expect(moduleRef.init()).rejects.toThrow(
      "PaymentGateway.charge (@Retryable)",
    );
  });

  it("pointcuts: selects the queries of the module without the internal one", async () => {
    const moduleRef = await billing(QueryAspect);
    const accounts = moduleRef.get(AccountService);

    accounts.open("acc-1");
    accounts.find("acc-1");
    accounts.findAll();

    expect(moduleRef.get(QueryAspect).seen).toEqual(["find"]);
  });

  it("before advice: prevents the join point by throwing, for the calls its arguments match", async () => {
    const moduleRef = await billing(DepositLimitAspect);
    const accounts = moduleRef.get(AccountService);
    const account = accounts.open("acc-1");

    expect(accounts.deposit(account, 40).balance).toBe(40);
    expect(() => accounts.deposit(account, -5)).toThrow(
      "Cannot deposit -5 into acc-1",
    );
    expect(account.balance).toBe(40);
  });

  it("after-returning and after-throwing advice: follow the settlement of the promise", async () => {
    const moduleRef = await billing(ReceiptAspect, DeclineAspect);
    const gateway = moduleRef.get(PaymentGateway);
    const account = new Account("acc-1", 100);

    await gateway.charge(account, 30);
    gateway.failures.push(new DeclinedError("card expired"));
    await expect(gateway.charge(account, 30)).rejects.toThrow("card expired");

    expect(moduleRef.get(Ledger).lines).toEqual([
      "receipt-acc-1-30: 30 from acc-1",
      "declined acc-1: card expired",
    ]);
  });

  it("after advice: runs once the charge settles, whatever its outcome", async () => {
    const moduleRef = await billing(InFlightAspect);
    const gateway = moduleRef.get(PaymentGateway);
    const inFlight = moduleRef.get(InFlightAspect);

    const pending = gateway.charge(new Account("acc-1", 100), 30);
    expect(inFlight.inFlight).toBe(1);
    await pending;
    expect(inFlight.inFlight).toBe(0);

    gateway.failures.push(new DeclinedError("card expired"));
    await expect(gateway.charge(new Account("acc-2"), 5)).rejects.toThrow();
    expect(inFlight.inFlight).toBe(0);
  });

  it("around advice: retries with the attempts of the annotation", async () => {
    const moduleRef = await billing();
    const gateway = moduleRef.get(PaymentGateway);
    const account = new Account("acc-1", 100);

    gateway.failures.push(new Error("timeout"), new Error("timeout"));
    await expect(gateway.charge(account, 30)).resolves.toBe("receipt-acc-1-30");

    gateway.failures.push(
      new Error("timeout"),
      new Error("timeout"),
      new Error("still down"),
    );
    await expect(gateway.charge(account, 30)).rejects.toThrow("still down");

    gateway.failures.push(new DeclinedError("card expired"), new Error("x"));
    await expect(gateway.charge(account, 30)).rejects.toThrow("card expired");
    expect(gateway.failures).toHaveLength(1);
  });

  it("ordering: nests the aspects by order and the advice of one aspect by kind", async () => {
    const moduleRef = await billing(InnerAspect, OuterAspect);

    await moduleRef.get(PaymentGateway).charge(new Account("acc-1", 100), 30);

    expect(trace).toEqual([
      "outer around: before proceed",
      "outer before",
      "inner before",
      "inner after returning",
      "outer after returning",
      "outer after",
      "outer around: after proceed",
    ]);
  });

  it("observables: passes the last emitted value to after-returning advice at completion", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FeedModule],
    }).compile();
    opened.push(moduleRef);
    const feed = moduleRef.get(PriceFeed);
    const { closing } = moduleRef.get(ClosingPriceAspect);

    const stream = feed.quotes("ACME");
    expect(closing.size).toBe(0);
    await lastValueFrom(stream);

    expect([...closing]).toEqual([["ACME", 103]]);
  });

  it("advisors: runs a MethodInterceptor around the methods of an annotated class", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false })],
      providers: [InvoiceService, TransactionManager, TransactionAdvisor],
    }).compile();
    opened.push(moduleRef);
    const invoices = moduleRef.get(InvoiceService);

    await expect(invoices.issue(new Account("acc-1"), 10)).resolves.toBe(
      "invoice-acc-1-10",
    );
    await expect(invoices.issue(new Account("acc-1"), 0)).rejects.toThrow(
      RangeError,
    );

    expect(moduleRef.get(TransactionManager).log).toEqual([
      "begin",
      "commit",
      "begin",
      "rollback",
    ]);
  });

  it("instantiation models: keeps the state of a perTarget aspect per target object", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false })],
      providers: [Session, Ledger, CallCountAspect],
    }).compile();
    opened.push(moduleRef);
    await moduleRef.init();
    const first = await moduleRef.resolve(Session);
    const second = await moduleRef.resolve(Session);

    first.touch();
    first.touch();
    second.touch();

    expect(moduleRef.get(Ledger).lines).toEqual([
      "call 1 of this session",
      "call 2 of this session",
      "call 1 of this session",
    ]);
  });

  it("introductions: adds the members of the interface to each matched object", async () => {
    const app = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false })],
      providers: [Session, UsageTrackingAspect],
    }).compile();
    opened.push(app);

    const session = await app.resolve(Session);
    session.touch();
    session.touch();
    const uses = isIntroduced(session, UsageTracked) ? session.useCount : 0;

    expect(uses).toBe(2);
    const other = await app.resolve(Session);
    expect(isIntroduced(other, UsageTracked) && other.useCount).toBe(0);
  });

  it("inspector: lists the advisors of a member in the order their advice runs", async () => {
    const app = await billing(ReceiptAspect);

    const inspector = app.get(AspectInspector);
    const advisors = inspector.advisorsOf(PaymentGateway, "charge");
    const members = inspector.advisedMembers(PaymentGateway);

    expect(advisors).toEqual([
      { type: RetryAspect, methodName: "retry", kind: "around", order: 20 },
      {
        type: ReceiptAspect,
        methodName: "record",
        kind: "afterReturning",
        order: undefined,
      },
    ]);
    expect(members).toEqual([
      {
        type: PaymentGateway,
        declaringType: PaymentGateway,
        name: "charge",
        kind: "method",
        advisors,
      },
    ]);
  });

  it("testing: advises after compile() without init(), and not an object outside a live application", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    await moduleRef.get(TransferService).transfer("alice", "bob", 25);
    const { entries } = moduleRef.get(AuditTrail);
    await moduleRef.close();

    expect(entries).toHaveLength(2);

    const unmanaged = new TransferService();
    await unmanaged.transfer("alice", "bob", 25);

    expect(entries).toHaveLength(2);
  });
});
