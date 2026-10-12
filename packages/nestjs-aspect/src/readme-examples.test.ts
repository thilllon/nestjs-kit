// The code examples of README.md, executed. Every `ts` block of the README
// is part of this file, apart from its import statements, its `export`
// keywords and its comment lines; the first test compares the two.

import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable, Module, Scope } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Test, TestingModuleBuilder } from "@nestjs/testing";
import { lastValueFrom, type Observable, of } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  type JoinPointOf,
  type MethodInterceptor,
  Pointcut as P,
  type Pointcut,
  type ProceedingJoinPointOf,
  type ReturnValueAdapter,
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
  started(joinPoint: JoinPointOf<typeof audited>): void {
    this.trail.entries.push(
      `${joinPoint.annotation(Audited)}: ${joinPoint.toString()}`,
    );
  }

  @AfterReturning(audited)
  returned(joinPoint: JoinPointOf<typeof audited>, result: unknown): void {
    this.trail.entries.push(
      `${joinPoint.annotation(Audited)} returned ${result}`,
    );
  }

  @AfterThrowing(audited)
  failed(joinPoint: JoinPointOf<typeof audited>, error: unknown): void {
    this.trail.entries.push(
      `${joinPoint.annotation(Audited)} failed: ${error}`,
    );
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

  @Retryable({ attempts: 2 })
  async refund(receipt: string): Promise<string> {
    return `refund-${receipt}`;
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

// Reads by naming convention, in any class.
const reads = P.any(P.name("find*"), P.name("get*"), P.name("list*"));

// Every other method of a module: PaymentGateway.charge,
// PaymentGateway.refund, AccountService.open and AccountService.deposit.
const billingWrites = inBilling.and(reads.not());

// Methods of one class by name: AccountService.open and
// AccountService.deposit.
const accountChanges = P.within(AccountService).and(P.name(/^(open|deposit)$/));

// The classes of a module by provider token: PaymentGateway.charge and
// PaymentGateway.refund.
const gateways = P.all(inBilling, P.bean("*Gateway"));

// The calls of annotated methods by argument: those of
// PaymentGateway.charge, not those of PaymentGateway.refund.
const accountCharges = P.annotated(Retryable).and(P.args(Account, P.REST));

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

@Injectable()
class Maintenance {
  readOnly = false;
}

@Aspect()
class MaintenanceAspect {
  constructor(private readonly maintenance: Maintenance) {}

  @Before(billingWrites)
  check(joinPoint: JoinPointOf<typeof billingWrites>): void {
    if (this.maintenance.readOnly) {
      const { targetType, name } = joinPoint.signature;
      throw new Error(
        `${targetType.name}.${String(name)} is unavailable: the application is read-only`,
      );
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
  record(joinPoint: JoinPointOf<typeof charge>, receipt: string): void {
    const [account, amount] = joinPoint.args;
    this.ledger.lines.push(`${receipt}: ${amount} from ${account.id}`);
  }
}

@Aspect()
class DeclineAspect {
  constructor(private readonly ledger: Ledger) {}

  @AfterThrowing(charge, { throwing: DeclinedError })
  record(joinPoint: JoinPointOf<typeof charge>, error: DeclinedError): void {
    this.ledger.lines.push(
      `declined ${joinPoint.args[0].id}: ${error.message}`,
    );
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
  async retry(
    joinPoint: ProceedingJoinPointOf<typeof retryable>,
  ): Promise<unknown> {
    const { attempts } = joinPoint.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await joinPoint.proceed();
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
  record(joinPoint: JoinPointOf<typeof queries>): void {
    this.seen.push(String(joinPoint.signature.name));
  }
}

/** Records the calls `accountCharges` selects, with what its shape types. */
@Aspect()
class AccountChargeAspect {
  readonly seen: string[] = [];

  @Before(accountCharges)
  record(joinPoint: JoinPointOf<typeof accountCharges>): void {
    const { attempts } = joinPoint.annotation(Retryable);
    this.seen.push(
      `${String(joinPoint.signature.name)} of ${joinPoint.args[0].id}, ${attempts} attempts`,
    );
  }
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

const trace: string[] = [];

@Aspect({ order: 1 })
class OuterAspect {
  @Around(charge)
  async around(
    joinPoint: ProceedingJoinPointOf<typeof charge>,
  ): Promise<string> {
    trace.push("outer around: before proceed");
    const receipt = await joinPoint.proceed();
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
  record(joinPoint: JoinPointOf<typeof quotes>, last: number): void {
    this.closing.set(joinPoint.args[0], last);
  }
}

@Module({
  imports: [AspectModule.forRoot({ returnValueAdapters: [observableAdapter] })],
  providers: [PriceFeed, ClosingPriceAspect],
})
class FeedModule {}

// ---------------------------------------------------------------------------
// Other result types
// ---------------------------------------------------------------------------

const asyncGeneratorAdapter: ReturnValueAdapter<AsyncGenerator<unknown>> = {
  supports(value: unknown): value is AsyncGenerator<unknown> {
    return Object.prototype.toString.call(value) === "[object AsyncGenerator]";
  },
  async *onSuccess(value, callback) {
    let last: unknown;
    for await (const item of value) {
      last = item;
      yield item;
    }
    await callback(last);
  },
  async *onError(value, callback) {
    try {
      yield* value;
    } catch (error) {
      await callback(error);
      throw error;
    }
  },
  async *finally(value, callback) {
    try {
      yield* value;
    } finally {
      await callback();
    }
  },
};

@Injectable()
class EventStore {
  readonly events = new Map<string, string[]>();

  async *replay(stream: string): AsyncGenerator<string> {
    const events = this.events.get(stream);
    if (!events) {
      throw new Error(`Unknown stream ${stream}`);
    }
    yield* events;
  }
}

const replays = P.method(EventStore, "replay");

@Aspect()
class ReplayAspect {
  readonly lines: string[] = [];

  @After(replays)
  closed(joinPoint: JoinPointOf<typeof replays>): void {
    this.lines.push(`${joinPoint.args[0]} closed`);
  }

  @AfterReturning(replays)
  finished(joinPoint: JoinPointOf<typeof replays>, last: unknown): void {
    this.lines.push(`${joinPoint.args[0]} ended with ${last}`);
  }

  @AfterThrowing(replays)
  failed(joinPoint: JoinPointOf<typeof replays>, error: unknown): void {
    this.lines.push(`${joinPoint.args[0]} failed: ${error}`);
  }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

@Injectable()
class Database {
  private readonly committed = new Map<string, number>();

  private readonly transaction = new AsyncLocalStorage<Map<string, number>>();

  readonly log: string[] = [];

  read(key: string): number {
    const writes = this.transaction.getStore();
    return writes?.get(key) ?? this.committed.get(key) ?? 0;
  }

  write(key: string, value: number): void {
    (this.transaction.getStore() ?? this.committed).set(key, value);
  }

  async transactional<T>(work: () => Promise<T>): Promise<T> {
    if (this.transaction.getStore()) {
      return work();
    }
    const writes = new Map<string, number>();
    this.log.push("begin");
    try {
      const result = await this.transaction.run(writes, work);
      for (const [key, value] of writes) {
        this.committed.set(key, value);
      }
      this.log.push("commit");
      return result;
    } catch (error) {
      this.log.push("rollback");
      throw error;
    }
  }
}

const Transactional = createAnnotation<
  "Transactional",
  void,
  (...args: any[]) => Promise<unknown>
>("Transactional", { requiresAdvice: true });

const transactional = P.annotated(Transactional);

@Aspect({ order: 100 })
class TransactionAspect {
  constructor(private readonly database: Database) {}

  @Around(transactional)
  run(
    joinPoint: ProceedingJoinPointOf<typeof transactional>,
  ): Promise<unknown> {
    return this.database.transactional(() => joinPoint.proceed());
  }
}

@Injectable()
class WalletRepository {
  constructor(private readonly database: Database) {}

  async balance(owner: string): Promise<number> {
    return this.database.read(owner);
  }

  async add(owner: string, amount: number): Promise<void> {
    const balance = this.database.read(owner) + amount;
    if (balance < 0) {
      throw new RangeError(`${owner} cannot pay ${-amount}`);
    }
    this.database.write(owner, balance);
  }
}

@Injectable()
class WalletService {
  constructor(private readonly wallets: WalletRepository) {}

  @Transactional()
  async move(from: string, to: string, amount: number): Promise<void> {
    await this.wallets.add(to, amount);
    await this.wallets.add(from, -amount);
  }

  async payEach(
    from: string,
    recipients: string[],
    amount: number,
  ): Promise<void> {
    for (const to of recipients) {
      await this.move(from, to, amount);
    }
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [Database, TransactionAspect, WalletRepository, WalletService],
})
class WalletModule {}

const Job = createAnnotation<
  "Job",
  string,
  (...args: any[]) => Promise<unknown>
>("Job", { requiresAdvice: true });

const jobs = P.annotated(Job);

@Injectable()
class ErrorReporter {
  readonly reports: string[] = [];

  report(source: string, error: unknown): void {
    this.reports.push(`${source}: ${error}`);
  }
}

@Aspect()
class JobAspect {
  constructor(private readonly reporter: ErrorReporter) {}

  @AfterThrowing(jobs)
  failed(joinPoint: JoinPointOf<typeof jobs>, error: unknown): void {
    this.reporter.report(joinPoint.annotation(Job), error);
  }
}

@Injectable()
class Outbox {
  readonly pending: string[] = [];

  readonly sent: string[] = [];

  async flush(): Promise<void> {
    while (this.pending.length > 0) {
      if (this.pending[0] === "") {
        throw new Error("Cannot send an empty message");
      }
      this.sent.push(...this.pending.splice(0, 1));
    }
  }
}

@Injectable()
class OutboxRelayJob {
  constructor(private readonly outbox: Outbox) {}

  @Job("outbox-relay")
  async relay(): Promise<void> {
    await this.outbox.flush();
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [ErrorReporter, JobAspect, Outbox, OutboxRelayJob],
})
class JobsModule {}

@Injectable()
class UserRepository {
  private readonly names = new Map<number, string>();

  async findName(id: number): Promise<string | undefined> {
    return this.names.get(id);
  }

  async rename(id: number, name: string): Promise<void> {
    this.names.set(id, name);
  }

  size(): number {
    return this.names.size;
  }
}

@Injectable()
class OrderRepository {
  async findByUser(userId: number): Promise<string[]> {
    return userId === 1 ? ["order-1"] : [];
  }
}

@Injectable()
class IdGenerator {
  private last = 0;

  async next(): Promise<number> {
    this.last += 1;
    return this.last;
  }
}

@Module({
  providers: [UserRepository, OrderRepository, IdGenerator],
  exports: [UserRepository, OrderRepository, IdGenerator],
})
class PersistenceModule {}

const repositoryQueries = P.all(
  P.inModule(PersistenceModule),
  P.bean("*Repository"),
  P.matching({
    methodMatcher: { isRuntime: false, matches: (method) => method.isAsync },
  }),
);

@Injectable()
class Timings {
  readonly samples: { member: string; milliseconds: number }[] = [];
}

@Aspect()
class RepositoryTimingAspect {
  constructor(private readonly timings: Timings) {}

  @Around(repositoryQueries)
  async time(
    joinPoint: ProceedingJoinPointOf<typeof repositoryQueries>,
  ): Promise<unknown> {
    const { targetType, name } = joinPoint.signature;
    const started = performance.now();
    try {
      return await joinPoint.proceed();
    } finally {
      this.timings.samples.push({
        member: `${targetType.name}.${String(name)}`,
        milliseconds: performance.now() - started,
      });
    }
  }
}

@Module({
  imports: [AspectModule.forRoot(), PersistenceModule],
  providers: [Timings, RepositoryTimingAspect],
})
class ReportingModule {}

// ---------------------------------------------------------------------------
// Advisors
// ---------------------------------------------------------------------------

@Advisor()
class TransactionAdvisor {
  static readonly pointcut = P.annotated(Transactional).or(
    P.withinAnnotated(Transactional),
  );

  readonly order = 100;

  readonly advice: MethodInterceptor = {
    invoke: (invocation) =>
      this.database.transactional(async () => invocation.proceed()),
  };

  constructor(private readonly database: Database) {}
}

@Injectable()
@Transactional()
class InvoiceService {
  constructor(private readonly database: Database) {}

  async issue(account: Account, amount: number): Promise<string> {
    this.database.write(`invoiced:${account.id}`, amount);
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
  record(joinPoint: JoinPointOf<typeof sessions>): void {
    joinPoint.introduced(UsageTracked).incrementUseCount();
  }
}

// ---------------------------------------------------------------------------

const billingProviders = [Ledger, RetryAspect];

const opened: (() => Promise<unknown>)[] = [];

/** Has `afterEach` close `application`, unless the test has closed it. */
function track<T extends { close(): Promise<unknown> }>(application: T): T {
  const close = application.close.bind(application);
  let closing: Promise<unknown> | undefined;
  application.close = () => {
    closing ??= close();
    return closing;
  };
  // Nest rejects close() with the error of a failed init().
  opened.push(() => application.close().catch(() => undefined));
  return application;
}

// The examples create their applications as the README shows it, without a
// helper. The functions that create them are observed instead, so a test
// that fails leaves no live application over the classes of this file.
beforeEach(() => {
  const compile = TestingModuleBuilder.prototype.compile;
  vi.spyOn(TestingModuleBuilder.prototype, "compile").mockImplementation(
    async function (this: TestingModuleBuilder, ...args) {
      return track(await compile.apply(this, args));
    },
  );
  const create = NestFactory.createApplicationContext.bind(NestFactory);
  vi.spyOn(NestFactory, "createApplicationContext").mockImplementation(
    async (module: Parameters<typeof create>[0]) =>
      track(await create(module, { logger: false })),
  );
});

/** A module with the billing module, the retry aspect and `providers`. */
async function billing(...providers: (new (...args: any[]) => unknown)[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [AspectModule.forRoot({ report: false }), BillingModule],
    providers: [...billingProviders, ...providers],
  }).compile();
  return moduleRef.init();
}

/**
 * The members of the billing module `pointcut` matches statically, as the
 * advised members of an aspect with that pointcut.
 */
async function matchedBy(pointcut: Pointcut<any>): Promise<string[]> {
  @Aspect()
  class Probe {
    @Before(pointcut)
    probe(): void {}
  }
  const moduleRef = await billing(Probe);
  return moduleRef
    .get(AspectInspector)
    .advisedMembers()
    .filter(({ advisors }) => advisors.some(({ type }) => type === Probe))
    .map(({ type, name }) => `${type.name}.${String(name)}`)
    .sort();
}

/** A module with `AspectModule` and `providers`, compiled and initialized. */
async function application(
  providers: (new (...args: any[]) => unknown)[],
  returnValueAdapters: ReturnValueAdapter<any>[] = [],
) {
  const moduleRef = await Test.createTestingModule({
    imports: [AspectModule.forRoot({ report: false, returnValueAdapters })],
    providers,
  }).compile();
  return moduleRef.init();
}

afterEach(async () => {
  vi.restoreAllMocks();
  trace.length = 0;
  await Promise.all(opened.splice(0).map((close) => close()));
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
    const app = await NestFactory.createApplicationContext(AppModule);
    const transfers = app.get(TransferService);

    await transfers.transfer("alice", "bob", 25);
    await transfers.transfer("alice", "bob", 0).catch(() => undefined);

    const { entries } = app.get(AuditTrail);
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

  it("pointcut composition: selects by name, module, provider token and their combinations", async () => {
    expect(await matchedBy(reads)).toEqual([
      "AccountService.find",
      "AccountService.findAll",
    ]);
    expect(await matchedBy(billingWrites)).toEqual([
      "AccountService.deposit",
      "AccountService.open",
      "PaymentGateway.charge",
      "PaymentGateway.refund",
    ]);
    expect(await matchedBy(accountChanges)).toEqual([
      "AccountService.deposit",
      "AccountService.open",
    ]);
    expect(await matchedBy(gateways)).toEqual([
      "PaymentGateway.charge",
      "PaymentGateway.refund",
    ]);
  });

  it("pointcut composition: narrows annotated methods to the calls whose arguments match", async () => {
    const moduleRef = await billing(AccountChargeAspect);
    const gateway = moduleRef.get(PaymentGateway);

    const receipt = await gateway.charge(new Account("acc-1", 100), 30);
    await gateway.refund(receipt);

    expect(moduleRef.get(AccountChargeAspect).seen).toEqual([
      "charge of acc-1, 3 attempts",
    ]);
  });

  it("before advice: prevents the calls its pointcut selects by throwing", async () => {
    const app = await billing(Maintenance, MaintenanceAspect);
    const accounts = app.get(AccountService);
    const account = accounts.open("acc-1");

    app.get(Maintenance).readOnly = true;

    expect(() => accounts.deposit(account, 40)).toThrow(
      "AccountService.deposit is unavailable: the application is read-only",
    );
    expect(account.balance).toBe(0);
    expect(accounts.find("acc-1")).toBe(account);
    await expect(app.get(PaymentGateway).charge(account, 5)).rejects.toThrow(
      "PaymentGateway.charge is unavailable",
    );

    const inspector = app.get(AspectInspector);
    const selected = inspector
      .advisedMembers()
      .filter(({ advisors }) =>
        advisors.some(({ type }) => type === MaintenanceAspect),
      )
      .map(({ type, name }) => `${type.name}.${String(name)}`);

    expect(selected).toEqual([
      "PaymentGateway.charge",
      "PaymentGateway.refund",
      "AccountService.open",
      "AccountService.deposit",
    ]);
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
    const feed = moduleRef.get(PriceFeed);
    const { closing } = moduleRef.get(ClosingPriceAspect);

    const stream = feed.quotes("ACME");
    expect(closing.size).toBe(0);
    await lastValueFrom(stream);

    expect([...closing]).toEqual([["ACME", 103]]);
  });

  it("other result types: follows an async generator to its end with a custom adapter", async () => {
    const moduleRef = await application(
      [EventStore, ReplayAspect],
      [asyncGeneratorAdapter],
    );
    const store = moduleRef.get(EventStore);
    const { lines } = moduleRef.get(ReplayAspect);
    store.events.set("orders", ["created", "paid", "shipped"]);

    const replay = store.replay("orders");
    expect(lines).toEqual([]);
    const events: string[] = [];
    for await (const event of replay) {
      events.push(event);
      expect(lines).toEqual([]);
    }
    expect(events).toEqual(["created", "paid", "shipped"]);
    expect(lines).toEqual(["orders ended with shipped", "orders closed"]);

    lines.length = 0;
    for await (const event of store.replay("orders")) {
      expect(event).toBe("created");
      break;
    }
    expect(lines).toEqual(["orders closed"]);

    lines.length = 0;
    await expect(store.replay("missing").next()).rejects.toThrow(
      "Unknown stream missing",
    );
    expect(lines).toEqual([
      "missing failed: Error: Unknown stream missing",
      "missing closed",
    ]);
  });

  it("other result types: runs after advice at the return of the generator without the adapter", async () => {
    const moduleRef = await application([EventStore, ReplayAspect]);
    const { lines } = moduleRef.get(ReplayAspect);

    const replay = moduleRef.get(EventStore).replay("missing");
    expect(lines).toEqual([
      "missing ended with [object AsyncGenerator]",
      "missing closed",
    ]);
    lines.length = 0;
    await expect(replay.next()).rejects.toThrow("Unknown stream missing");

    expect(lines).toEqual([]);
  });

  it("transaction recipe: runs each self-invoked call in its own transaction and rolls back the failed one", async () => {
    const app = await NestFactory.createApplicationContext(WalletModule);
    const wallets = app.get(WalletRepository);
    const service = app.get(WalletService);

    await wallets.add("alice", 25);

    await service.move("alice", "bob", 10);
    await service.payEach("alice", ["bob", "carol"], 10).catch(() => undefined);

    const balances = [
      await wallets.balance("alice"),
      await wallets.balance("bob"),
      await wallets.balance("carol"),
    ];
    const { log } = app.get(Database);

    expect(balances).toEqual([5, 20, 0]);
    expect(log).toEqual([
      "begin",
      "commit",
      "begin",
      "commit",
      "begin",
      "rollback",
    ]);
  });

  it("transaction recipe: joins the transaction that is active when the method is called", async () => {
    const app = await NestFactory.createApplicationContext(WalletModule);
    const database = app.get(Database);
    const wallets = app.get(WalletRepository);
    const service = app.get(WalletService);
    await wallets.add("alice", 15);

    await expect(
      database.transactional(async () => {
        await service.move("alice", "bob", 10);
        await service.move("alice", "carol", 10);
      }),
    ).rejects.toThrow("alice cannot pay 10");

    expect(database.log).toEqual(["begin", "rollback"]);
    expect(await wallets.balance("bob")).toBe(0);
  });

  it("transaction recipe: keeps concurrent transactions apart", async () => {
    const app = await NestFactory.createApplicationContext(WalletModule);
    const wallets = app.get(WalletRepository);
    const service = app.get(WalletService);
    await wallets.add("alice", 10);

    const outcomes = await Promise.allSettled([
      service.move("alice", "bob", 10),
      service.move("dave", "carol", 10),
    ]);

    expect(outcomes.map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await wallets.balance("bob")).toBe(10);
    expect(await wallets.balance("carol")).toBe(0);
  });

  it("transaction recipe: fails the bootstrap without the aspect, and the call where the bootstrap is lenient", async () => {
    const providers = [Database, WalletRepository, WalletService];
    const strict = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false })],
      providers,
    })
      .setLogger(new RecordingLogger())
      .compile();

    await expect(strict.init()).rejects.toThrow("WalletService.move");
    await strict.close().catch(() => undefined);

    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false, strict: false })],
      providers,
    })
      .setLogger(new RecordingLogger())
      .compile();
    await moduleRef.init();

    expect(() => moduleRef.get(WalletService).move("alice", "bob", 1)).toThrow(
      AspectConfigurationError,
    );
    expect(await moduleRef.get(WalletRepository).balance("bob")).toBe(0);
  });

  it("job recipe: reports the failure of a job and leaves the error to its caller", async () => {
    const app = await NestFactory.createApplicationContext(JobsModule);
    const job = app.get(OutboxRelayJob);
    const outbox = app.get(Outbox);

    outbox.pending.push("welcome");
    await job.relay();
    outbox.pending.push("");
    const [outcome] = await Promise.allSettled([job.relay()]);

    const { reports } = app.get(ErrorReporter);

    expect(outbox.sent).toEqual(["welcome"]);
    expect(outcome.status).toBe("rejected");
    expect(outbox.pending).toEqual([""]);
    expect(reports).toEqual([
      "outbox-relay: Error: Cannot send an empty message",
    ]);
  });

  it("timing recipe: times the asynchronous methods of the repositories of the module, selected without a decorator", async () => {
    const app = await NestFactory.createApplicationContext(ReportingModule);
    const users = app.get(UserRepository);

    await users.rename(1, "Ada");
    await users.findName(1);
    users.size();
    await app.get(OrderRepository).findByUser(1);
    await app.get(IdGenerator).next();

    const { samples } = app.get(Timings);
    const timed = samples.map(({ member }) => member);

    expect(timed).toEqual([
      "UserRepository.rename",
      "UserRepository.findName",
      "OrderRepository.findByUser",
    ]);
    expect(samples.every(({ milliseconds }) => milliseconds >= 0)).toBe(true);
  });

  it("advisors: runs a MethodInterceptor around the methods of an annotated class", async () => {
    const moduleRef = await application([
      Database,
      InvoiceService,
      TransactionAdvisor,
    ]);
    const invoices = moduleRef.get(InvoiceService);
    const database = moduleRef.get(Database);

    await expect(invoices.issue(new Account("acc-1"), 10)).resolves.toBe(
      "invoice-acc-1-10",
    );
    await expect(invoices.issue(new Account("acc-2"), 0)).rejects.toThrow(
      RangeError,
    );

    expect(database.log).toEqual(["begin", "commit", "begin", "rollback"]);
    expect(database.read("invoiced:acc-1")).toBe(10);
    expect(database.read("invoiced:acc-2")).toBe(0);
  });

  it("instantiation models: keeps the state of a perTarget aspect per target object", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false })],
      providers: [Session, Ledger, CallCountAspect],
    }).compile();
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
      {
        type: PaymentGateway,
        declaringType: PaymentGateway,
        name: "refund",
        kind: "method",
        advisors: [advisors[0]],
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
