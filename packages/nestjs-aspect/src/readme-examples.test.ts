// The code examples of README.md, executed. Every `ts` block of the README
// is part of this file, apart from its import statements, its `export`
// keywords and its comment lines; the first test compares the two.
//
// The README declares the infrastructure its examples depend on as abstract
// classes. `InfrastructureModule` binds them to the in-memory
// implementations of this file.

import "reflect-metadata";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type BeforeApplicationShutdown,
  ForbiddenException,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import {
  DiscoveryModule,
  DiscoveryService,
  MetadataScanner,
  NestFactory,
  Reflector,
} from "@nestjs/core";
import {
  Test,
  type TestingModule,
  TestingModuleBuilder,
} from "@nestjs/testing";
import { defer, lastValueFrom, mergeAll, type Observable } from "rxjs";
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
  introduced,
  isIntroduced,
  type JoinPointOf,
  type MethodInterceptor,
  Pointcut as P,
  type ProceedingJoinPointOf,
  type ReturnValueAdapter,
} from "./index";
import { observableAdapter } from "./rxjs";
import { RecordingLogger } from "./weaving-fixture";

// ---------------------------------------------------------------------------
// Quick start
// ---------------------------------------------------------------------------

const Audited = createAnnotation<
  "Audited",
  string,
  (subject: string, ...rest: any[]) => Promise<unknown>
>("Audited");

const audited = P.annotated(Audited);

@Injectable()
class Actor {
  private readonly storage = new AsyncLocalStorage<string>();

  run<T>(actor: string, work: () => T): T {
    return this.storage.run(actor, work);
  }

  current(): string | undefined {
    return this.storage.getStore();
  }
}

interface AuditEntry {
  action: string;
  actor: string;
  subject: string;
  outcome: "ok" | "failed";
  error?: string;
}

@Injectable()
class AuditLog {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

@Aspect()
class AuditAspect {
  constructor(
    private readonly actor: Actor,
    private readonly log: AuditLog,
  ) {}

  @AfterReturning(audited)
  async succeeded(joinPoint: JoinPointOf<typeof audited>): Promise<void> {
    await this.log.record(this.entry(joinPoint, "ok"));
  }

  @AfterThrowing(audited)
  async failed(
    joinPoint: JoinPointOf<typeof audited>,
    error: unknown,
  ): Promise<void> {
    await this.log.record({
      ...this.entry(joinPoint, "failed"),
      error: error instanceof Error ? error.name : typeof error,
    });
  }

  private entry(
    joinPoint: JoinPointOf<typeof audited>,
    outcome: AuditEntry["outcome"],
  ): AuditEntry {
    return {
      action: joinPoint.annotation(Audited),
      actor: this.actor.current() ?? "anonymous",
      subject: joinPoint.args[0],
      outcome,
    };
  }
}

@Injectable()
class MemberService {
  private readonly roles = new Map<string, string>();

  @Audited("member.invite")
  async invite(memberId: string, role: string): Promise<void> {
    this.roles.set(memberId, role);
  }

  @Audited("member.remove")
  async remove(memberId: string): Promise<void> {
    if (!this.roles.delete(memberId)) {
      throw new NotFoundException(`Unknown member ${memberId}`);
    }
  }
}

@Injectable()
class ApiKeyService {
  private readonly revoked = new Set<string>();

  @Audited("api-key.revoke")
  async revoke(keyId: string): Promise<void> {
    this.revoked.add(keyId);
  }
}

@Module({
  imports: [AspectModule.forRoot()],
  providers: [Actor, AuditLog, AuditAspect, MemberService, ApiKeyService],
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
  providers: [Actor, AuditLog, AuditAspect, MemberService, ApiKeyService],
})
class ConfiguredAppModule {}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

interface RetryOptions {
  attempts: number;
  backoffMilliseconds: number;
}

class TransientError extends Error {}

const Retryable = createAnnotation<
  "Retryable",
  RetryOptions,
  (...args: any[]) => Promise<unknown>
>("Retryable", { requiresAdvice: true });

const RequiresPermission = createAnnotation<"RequiresPermission", string>(
  "RequiresPermission",
  { requiresAdvice: true },
);

const Evicts = createAnnotation<
  "Evicts",
  (...args: any[]) => string,
  (...args: any[]) => Promise<unknown>
>("Evicts");

// ---------------------------------------------------------------------------
// In-memory infrastructure, which the README names but does not show
// ---------------------------------------------------------------------------

class TransportError extends Error {}

abstract class Transport {
  abstract send<T>(operation: string, payload: object): Promise<T>;
}

abstract class Cache {
  abstract wrap<T>(key: string, load: () => Promise<T>): Promise<T>;

  abstract del(key: string): Promise<void>;
}

interface TransactionOptions {
  isolation?: "read committed" | "serializable";
}

interface Connection {
  get(key: string): Promise<number | undefined>;

  set(key: string, value: number): Promise<void>;
}

abstract class DatabaseClient implements Connection {
  abstract get(key: string): Promise<number | undefined>;

  abstract set(key: string, value: number): Promise<void>;

  abstract transaction<T>(
    work: (transaction: Connection) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

abstract class JobLocks {
  abstract acquire(name: string): Promise<(() => Promise<void>) | undefined>;
}

abstract class ErrorReporter {
  abstract report(source: string, error: unknown): Promise<void>;
}

/**
 * The remote systems behind `Transport`. An operation answers with its
 * scripted outcomes in order and repeats the last one; an `Error` outcome
 * rejects the call.
 */
const upstream = {
  calls: [] as { operation: string; payload: object }[],
  outcomes: new Map<string, unknown[]>(),
  answer(operation: string, ...outcomes: unknown[]): void {
    this.outcomes.set(operation, outcomes);
  },
  callsOf(operation: string): object[] {
    return this.calls
      .filter((call) => call.operation === operation)
      .map(({ payload }) => payload);
  },
};

@Injectable()
class ScriptedTransport extends Transport {
  async send<T>(operation: string, payload: object): Promise<T> {
    upstream.calls.push({ operation, payload });
    const outcomes = upstream.outcomes.get(operation) ?? [];
    const outcome = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome as T;
  }
}

const cacheState = {
  entries: new Map<string, unknown>(),
  failure: undefined as Error | undefined,
};

@Injectable()
class MemoryCache extends Cache {
  async wrap<T>(key: string, load: () => Promise<T>): Promise<T> {
    if (!cacheState.entries.has(key)) {
      cacheState.entries.set(key, await load());
    }
    return cacheState.entries.get(key) as T;
  }

  async del(key: string): Promise<void> {
    if (cacheState.failure) {
      throw cacheState.failure;
    }
    cacheState.entries.delete(key);
  }
}

/** `"begin"`, `"commit"` and `"rollback"` of every transaction, in order. */
const transactionLog: string[] = [];

/**
 * A key-value store with optimistic transactions. A serializable
 * transaction that read a row which another transaction has since changed
 * fails its commit with the SQLSTATE of a serialization failure.
 */
@Injectable()
class MemoryDatabaseClient extends DatabaseClient {
  private readonly rows = new Map<string, { value: number; version: number }>();

  async get(key: string): Promise<number | undefined> {
    return this.rows.get(key)?.value;
  }

  async set(key: string, value: number): Promise<void> {
    const version = (this.rows.get(key)?.version ?? 0) + 1;
    this.rows.set(key, { value, version });
  }

  async transaction<T>(
    work: (transaction: Connection) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    const isolation = options.isolation ?? "read committed";
    const reads = new Map<string, number>();
    const writes = new Map<string, number>();
    transactionLog.push(`begin ${isolation}`);
    try {
      const result = await work({
        get: async (key) => {
          if (writes.has(key)) {
            return writes.get(key);
          }
          const row = this.rows.get(key);
          if (!reads.has(key)) {
            reads.set(key, row?.version ?? 0);
          }
          return row?.value;
        },
        set: async (key, value) => {
          writes.set(key, value);
        },
      });
      if (isolation === "serializable") {
        for (const [key, version] of reads) {
          if ((this.rows.get(key)?.version ?? 0) !== version) {
            throw Object.assign(
              new Error("could not serialize access due to concurrent update"),
              { code: "40001" },
            );
          }
        }
      }
      for (const [key, value] of writes) {
        const version = (this.rows.get(key)?.version ?? 0) + 1;
        this.rows.set(key, { value, version });
      }
      transactionLog.push("commit");
      return result;
    } catch (error) {
      transactionLog.push("rollback");
      throw error;
    }
  }
}

const heldLocks = new Set<string>();

@Injectable()
class MemoryJobLocks extends JobLocks {
  async acquire(name: string): Promise<(() => Promise<void>) | undefined> {
    if (heldLocks.has(name)) {
      return undefined;
    }
    heldLocks.add(name);
    return async () => {
      heldLocks.delete(name);
    };
  }
}

const errorReports = {
  received: [] as string[],
  failure: undefined as Error | undefined,
};

@Injectable()
class RecordingErrorReporter extends ErrorReporter {
  async report(source: string, error: unknown): Promise<void> {
    if (errorReports.failure) {
      throw errorReports.failure;
    }
    errorReports.received.push(`${source}: ${error}`);
  }
}

const infrastructure = [
  { provide: Transport, useClass: ScriptedTransport },
  { provide: Cache, useClass: MemoryCache },
  { provide: DatabaseClient, useClass: MemoryDatabaseClient },
  { provide: JobLocks, useClass: MemoryJobLocks },
  { provide: ErrorReporter, useClass: RecordingErrorReporter },
];

@Module({
  providers: infrastructure,
  exports: infrastructure.map(({ provide }) => provide),
})
class InfrastructureModule {}

// ---------------------------------------------------------------------------
// The example application
// ---------------------------------------------------------------------------

@Injectable()
class PaymentClient {
  constructor(private readonly transport: Transport) {}

  @Retryable({ attempts: 3, backoffMilliseconds: 200 })
  async charge(idempotencyKey: string, amount: number): Promise<string> {
    return this.transport.send("payments/charge", { idempotencyKey, amount });
  }

  @Retryable({ attempts: 3, backoffMilliseconds: 200 })
  async refund(idempotencyKey: string, chargeId: string): Promise<string> {
    return this.transport.send("payments/refund", { idempotencyKey, chargeId });
  }

  async *settlements(day: string): AsyncGenerator<string> {
    let cursor: string | undefined;
    do {
      const page = await this.transport.send<{
        items: string[];
        next?: string;
      }>("payments/settlements", { day, cursor });
      yield* page.items;
      cursor = page.next;
    } while (cursor);
  }
}

@Injectable()
class ShippingClient {
  constructor(private readonly transport: Transport) {}

  @Retryable({ attempts: 2, backoffMilliseconds: 200 })
  async quote(destination: string): Promise<number> {
    return this.transport.send("shipping/quote", { destination });
  }

  async book(orderId: string, destination: string): Promise<string> {
    return this.transport.send("shipping/book", { orderId, destination });
  }

  track(shipmentId: string): Observable<string> {
    return defer(() =>
      this.transport.send<string[]>("shipping/track", { shipmentId }),
    ).pipe(mergeAll());
  }
}

@Injectable()
class ProductRepository {
  private readonly prices = new Map<string, number>();

  async findPrice(sku: string): Promise<number | undefined> {
    return this.prices.get(sku);
  }

  async savePrice(sku: string, price: number): Promise<void> {
    this.prices.set(sku, price);
  }

  async remove(sku: string): Promise<void> {
    this.prices.delete(sku);
  }
}

const priceKey = (sku: string) => `price:${sku}`;

@Injectable()
class CatalogService {
  constructor(
    private readonly products: ProductRepository,
    private readonly cache: Cache,
  ) {}

  async price(sku: string): Promise<number | undefined> {
    return this.cache.wrap(priceKey(sku), () => this.products.findPrice(sku));
  }

  @RequiresPermission("catalog:write")
  @Evicts(priceKey)
  async reprice(sku: string, price: number): Promise<void> {
    await this.products.savePrice(sku, price);
  }

  @RequiresPermission("catalog:write")
  @Evicts(priceKey)
  async discontinue(sku: string): Promise<void> {
    await this.products.remove(sku);
  }
}

@Injectable()
class CheckoutService {
  constructor(
    private readonly catalog: CatalogService,
    private readonly payments: PaymentClient,
    private readonly shipping: ShippingClient,
  ) {}

  async pay(
    orderId: string,
    sku: string,
    destination: string,
  ): Promise<string> {
    const price = await this.catalog.price(sku);
    if (price === undefined) {
      throw new NotFoundException(`Unknown product ${sku}`);
    }
    const delivery = await this.shipping.quote(destination);
    return this.payments.charge(`charge:${orderId}`, price + delivery);
  }

  @RequiresPermission("payments:refund")
  async refund(orderId: string, chargeId: string): Promise<string> {
    return this.payments.refund(`refund:${orderId}`, chargeId);
  }

  @RequiresPermission("orders:ship")
  async ship(orderId: string, destination: string): Promise<string> {
    return this.shipping.book(orderId, destination);
  }
}

@Module({
  imports: [InfrastructureModule],
  providers: [
    PaymentClient,
    ShippingClient,
    ProductRepository,
    CatalogService,
    CheckoutService,
  ],
  exports: [
    PaymentClient,
    ShippingClient,
    ProductRepository,
    CatalogService,
    CheckoutService,
  ],
})
class ShopModule {}

// ---------------------------------------------------------------------------
// Pointcuts
// ---------------------------------------------------------------------------

const retryable = P.annotated(Retryable);
const guarded = P.annotated(RequiresPermission);
const evicting = P.annotated(Evicts);

const asynchronous = P.matching({
  methodMatcher: { isRuntime: false, matches: (method) => method.isAsync },
});

const clients = P.inModule(ShopModule).and(P.bean("*Client"));
const clientCalls = clients.and(asynchronous);

// ---------------------------------------------------------------------------
// Advice
// ---------------------------------------------------------------------------

@Injectable()
class Permissions {
  private readonly granted = new Map<string, Set<string>>();

  grant(actor: string, permission: string): void {
    const permissions = this.granted.get(actor) ?? new Set<string>();
    this.granted.set(actor, permissions.add(permission));
  }

  allows(actor: string | undefined, permission: string): boolean {
    return (
      actor !== undefined && (this.granted.get(actor)?.has(permission) ?? false)
    );
  }
}

@Aspect({ order: 0 })
class PermissionAspect {
  constructor(
    private readonly actor: Actor,
    private readonly permissions: Permissions,
  ) {}

  @Before(guarded)
  check(joinPoint: JoinPointOf<typeof guarded>): void {
    const actor = this.actor.current();
    const permission = joinPoint.annotation(RequiresPermission);
    if (!this.permissions.allows(actor, permission)) {
      throw new ForbiddenException(
        `${actor ?? "anonymous"} lacks ${permission}`,
      );
    }
  }
}

@Aspect({ order: 50 })
class CacheEvictionAspect {
  private readonly logger = new Logger(CacheEvictionAspect.name);

  constructor(private readonly cache: Cache) {}

  @AfterReturning(evicting)
  async evict(joinPoint: JoinPointOf<typeof evicting>): Promise<void> {
    const key = joinPoint.annotation(Evicts)(...joinPoint.args);
    try {
      await this.cache.del(key);
    } catch (error) {
      this.logger.warn(`Cannot evict ${key}: ${error}`);
    }
  }
}

class UpstreamUnavailableError extends TransientError {}

@Aspect({ order: 30 })
class UpstreamErrorAspect {
  @AfterThrowing(clients, { throwing: TransportError })
  translate(
    joinPoint: JoinPointOf<typeof clients>,
    error: TransportError,
  ): never {
    const { targetType, name } = joinPoint.signature;
    throw new UpstreamUnavailableError(
      `${targetType.name}.${String(name)} did not answer`,
      { cause: error },
    );
  }
}

@Injectable()
class InFlightCalls implements BeforeApplicationShutdown {
  private count = 0;

  private drained?: () => void;

  enter(): void {
    this.count += 1;
  }

  leave(): void {
    this.count -= 1;
    if (this.count === 0) {
      this.drained?.();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.count > 0) {
      await new Promise<void>((resolve) => {
        this.drained = resolve;
      });
    }
  }
}

@Aspect({ order: 10 })
class DrainAspect {
  constructor(private readonly calls: InFlightCalls) {}

  @Before(clientCalls)
  enter(): void {
    this.calls.enter();
  }

  @After(clientCalls)
  leave(): void {
    this.calls.leave();
  }
}

@Aspect({ order: 20 })
class RetryAspect {
  @Around(retryable)
  async retry(
    joinPoint: ProceedingJoinPointOf<typeof retryable>,
  ): Promise<unknown> {
    const { attempts, backoffMilliseconds } = joinPoint.annotation(Retryable);
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await joinPoint.proceed();
      } catch (error) {
        if (!(error instanceof TransientError) || attempt >= attempts) {
          throw error;
        }
        const ceiling = backoffMilliseconds * 2 ** (attempt - 1);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * ceiling),
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

const conflicts = new Set(["40001", "40P01"]);

@Injectable()
class Database {
  private readonly active = new AsyncLocalStorage<Connection>();

  constructor(private readonly client: DatabaseClient) {}

  get connection(): Connection {
    return this.active.getStore() ?? this.client;
  }

  async transactional<T>(
    work: () => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    if (this.active.getStore()) {
      return work();
    }
    try {
      return await this.client.transaction(
        (transaction) => this.active.run(transaction, work),
        options,
      );
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (typeof code === "string" && conflicts.has(code)) {
        throw new TransientError("The transaction lost a conflict", {
          cause: error,
        });
      }
      throw error;
    }
  }
}

const Transactional = createAnnotation<
  "Transactional",
  TransactionOptions,
  (...args: any[]) => Promise<unknown>
>("Transactional", { requiresAdvice: true });

const transactional = P.annotated(Transactional).or(
  P.withinAnnotated(Transactional).and(asynchronous),
);

@Aspect({ order: 100 })
class TransactionAspect {
  constructor(private readonly database: Database) {}

  @Around(transactional)
  run(
    joinPoint: ProceedingJoinPointOf<typeof transactional>,
  ): Promise<unknown> {
    return this.database.transactional(
      async () => joinPoint.proceed(),
      joinPoint.findAnnotation(Transactional),
    );
  }
}

class InsufficientFundsError extends Error {}

@Injectable()
class WalletRepository {
  constructor(private readonly database: Database) {}

  async balance(owner: string): Promise<number> {
    return (await this.database.connection.get(owner)) ?? 0;
  }

  async add(owner: string, amount: number): Promise<void> {
    const balance = (await this.balance(owner)) + amount;
    if (balance < 0) {
      throw new InsufficientFundsError(`${owner} cannot pay ${-amount}`);
    }
    await this.database.connection.set(owner, balance);
  }
}

@Injectable()
@Transactional({ isolation: "serializable" })
class WalletService {
  constructor(private readonly wallets: WalletRepository) {}

  @Retryable({ attempts: 3, backoffMilliseconds: 50 })
  async deposit(owner: string, amount: number): Promise<void> {
    await this.wallets.add(owner, amount);
  }

  @Retryable({ attempts: 3, backoffMilliseconds: 50 })
  async move(from: string, to: string, amount: number): Promise<void> {
    await this.wallets.add(from, -amount);
    await this.wallets.add(to, amount);
  }
}

@Module({
  imports: [AspectModule.forRoot(), InfrastructureModule],
  providers: [
    Database,
    TransactionAspect,
    RetryAspect,
    WalletRepository,
    WalletService,
  ],
})
class WalletModule {}

const Scheduled = Reflector.createDecorator<{
  name: string;
  everyMilliseconds: number;
}>();

const scheduled = P.annotated(Scheduled);

@Aspect()
class JobAspect {
  private readonly logger = new Logger(JobAspect.name);

  constructor(
    private readonly actor: Actor,
    private readonly locks: JobLocks,
    private readonly reporter: ErrorReporter,
  ) {}

  @Around(scheduled)
  async run(
    joinPoint: ProceedingJoinPointOf<typeof scheduled>,
  ): Promise<unknown> {
    const name =
      joinPoint.findAnnotation(Scheduled)?.name ??
      String(joinPoint.signature.name);
    const release = await this.locks.acquire(name);
    if (!release) {
      return undefined;
    }
    try {
      return await this.actor.run(`job:${name}`, async () =>
        joinPoint.proceed(),
      );
    } catch (error) {
      await this.reporter
        .report(name, error)
        .catch((failure) =>
          this.logger.warn(`Cannot report the failure of ${name}: ${failure}`),
        );
      throw error;
    } finally {
      await release();
    }
  }
}

/**
 * Stands in for the scheduler of a scheduling package: it calls every
 * method that carries `@Scheduled` on a timer, and logs a rejection.
 * `fire` runs a job as its timer does and resolves or rejects with it.
 */
@Injectable()
class Scheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly jobs = new Map<string, () => Promise<unknown>>();

  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onApplicationBootstrap(): void {
    for (const { instance } of this.discovery.getProviders()) {
      if (instance === null || typeof instance !== "object") {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance);
      for (const methodName of this.scanner.getAllMethodNames(prototype)) {
        const schedule = this.reflector.get(Scheduled, instance[methodName]);
        if (!schedule) {
          continue;
        }
        const run = async () => instance[methodName]();
        this.jobs.set(schedule.name, run);
        const timer = setInterval(
          () => void run().catch(() => undefined),
          schedule.everyMilliseconds,
        );
        this.timers.push(timer.unref());
      }
    }
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers.splice(0)) {
      clearInterval(timer);
    }
  }

  fire(name: string): Promise<unknown> {
    const run = this.jobs.get(name);
    if (!run) {
      throw new Error(`Unknown job ${name}`);
    }
    return run();
  }
}

@Module({
  imports: [DiscoveryModule],
  providers: [Scheduler],
  exports: [Scheduler],
})
class SchedulerModule {}

@Injectable()
class PriceSyncJob {
  constructor(
    private readonly transport: Transport,
    private readonly catalog: CatalogService,
  ) {}

  @Scheduled({ name: "price-sync", everyMilliseconds: 60_000 })
  async sync(): Promise<void> {
    const prices = await this.transport.send<Record<string, number>>(
      "supplier/prices",
      {},
    );
    for (const [sku, price] of Object.entries(prices)) {
      await this.catalog.reprice(sku, price);
    }
  }
}

@Module({
  imports: [
    AspectModule.forRoot(),
    ShopModule,
    SchedulerModule,
    InfrastructureModule,
  ],
  providers: [
    Actor,
    Permissions,
    PermissionAspect,
    RetryAspect,
    CacheEvictionAspect,
    JobAspect,
    PriceSyncJob,
  ],
})
class JobsModule {}

@Injectable()
class UserRepository {
  private readonly names = new Map<number, string>();

  async findName(id: number): Promise<string | undefined> {
    return this.names.get(id);
  }

  async rename(id: number, name: string): Promise<void> {
    if (name === "") {
      throw new RangeError("A name is required");
    }
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

const repositoryCalls = P.all(
  P.inModule(PersistenceModule),
  P.bean("*Repository"),
  asynchronous,
);

interface CallTotals {
  calls: number;
  errors: number;
  milliseconds: number;
}

@Injectable()
class CallStatistics {
  private readonly totals = new Map<string, CallTotals>();

  record(member: string, failed: boolean, milliseconds: number): void {
    const totals = this.totals.get(member) ?? {
      calls: 0,
      errors: 0,
      milliseconds: 0,
    };
    totals.calls += 1;
    totals.errors += failed ? 1 : 0;
    totals.milliseconds += milliseconds;
    this.totals.set(member, totals);
  }

  summary(): Record<string, CallTotals> {
    return Object.fromEntries(this.totals);
  }
}

@Aspect()
class RepositoryTimingAspect {
  constructor(private readonly statistics: CallStatistics) {}

  @Around(repositoryCalls)
  async time(
    joinPoint: ProceedingJoinPointOf<typeof repositoryCalls>,
  ): Promise<unknown> {
    const { targetType, name } = joinPoint.signature;
    const member = `${targetType.name}.${String(name)}`;
    const started = performance.now();
    let failed = true;
    try {
      const result = await joinPoint.proceed();
      failed = false;
      return result;
    } finally {
      this.statistics.record(member, failed, performance.now() - started);
    }
  }
}

@Module({
  imports: [AspectModule.forRoot(), PersistenceModule],
  providers: [CallStatistics, RepositoryTimingAspect],
})
class ReportingModule {}

// ---------------------------------------------------------------------------
// Asynchronous join points
// ---------------------------------------------------------------------------

@Module({
  imports: [
    AspectModule.forRoot({ returnValueAdapters: [observableAdapter] }),
    ShopModule,
  ],
  providers: [
    Actor,
    Permissions,
    PermissionAspect,
    RetryAspect,
    UpstreamErrorAspect,
  ],
})
class TrackingModule {}

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

@Module({
  imports: [
    AspectModule.forRoot({
      returnValueAdapters: [observableAdapter, asyncGeneratorAdapter],
    }),
    ShopModule,
  ],
  providers: [
    Actor,
    Permissions,
    PermissionAspect,
    RetryAspect,
    UpstreamErrorAspect,
  ],
})
class StreamingModule {}

/** Records what the advice of an async generator method receives. */
const settlementPages = P.method(PaymentClient, "settlements");

@Aspect()
class SettlementProbe {
  readonly seen: string[] = [];

  @After(settlementPages)
  after(): void {
    this.seen.push("after");
  }

  @AfterReturning(settlementPages)
  afterReturning(
    _joinPoint: JoinPointOf<typeof settlementPages>,
    last: unknown,
  ): void {
    this.seen.push(`after returning ${last}`);
  }
}

// ---------------------------------------------------------------------------
// Advisors
// ---------------------------------------------------------------------------

@Advisor()
class TransactionAdvisor {
  static readonly pointcut = transactional;

  readonly order = 100;

  readonly advice: MethodInterceptor = {
    invoke: (invocation) =>
      this.database.transactional(
        async () => invocation.proceed(),
        invocation.joinPoint.findAnnotation(Transactional),
      ),
  };

  constructor(private readonly database: Database) {}
}

// ---------------------------------------------------------------------------
// Instantiation models and introductions
// ---------------------------------------------------------------------------

@Injectable()
class BreakerSettings {
  readonly threshold = 3;

  readonly coolDownMilliseconds = 30_000;
}

class CircuitOpenError extends Error {}

@Aspect({ instantiation: "perClass", order: 25 })
class CircuitBreakerAspect {
  private failures = 0;

  private openUntil = 0;

  constructor(private readonly settings: BreakerSettings) {}

  @Around(clientCalls)
  async guard(
    joinPoint: ProceedingJoinPointOf<typeof clientCalls>,
  ): Promise<unknown> {
    if (Date.now() < this.openUntil) {
      const { targetType } = joinPoint.signature;
      throw new CircuitOpenError(`${targetType.name} is unavailable`);
    }
    try {
      const result = await joinPoint.proceed();
      this.failures = 0;
      return result;
    } catch (error) {
      if (error instanceof TransientError) {
        this.failures += 1;
        if (this.failures >= this.settings.threshold) {
          this.openUntil = Date.now() + this.settings.coolDownMilliseconds;
        }
      }
      throw error;
    }
  }
}

abstract class Lockable {
  abstract lock(): void;

  abstract get locked(): boolean;
}

class DefaultLockable implements Lockable {
  private isLocked = false;

  lock(): void {
    this.isLocked = true;
  }

  get locked(): boolean {
    return this.isLocked;
  }
}

@Aspect()
class LockableAspect {
  @DeclareParents(P.within(ProductRepository), { use: DefaultLockable })
  static readonly mixin: Lockable;
}

// ---------------------------------------------------------------------------
// Ordering: the README shows the trace of this aspect, not its code
// ---------------------------------------------------------------------------

@Injectable()
class Greeter {
  async greet(): Promise<string> {
    return "hello";
  }
}

const greeting = P.method(Greeter, "greet");

const trace: string[] = [];

@Aspect()
class NestingAspect {
  @AfterThrowing(greeting)
  afterThrowing(): void {
    trace.push("after throwing");
  }

  @AfterReturning(greeting)
  afterReturning(): void {
    trace.push("after returning");
  }

  @After(greeting)
  after(): void {
    trace.push("after");
  }

  @Before(greeting)
  before(): void {
    trace.push("before");
  }

  @Around(greeting)
  async around(
    joinPoint: ProceedingJoinPointOf<typeof greeting>,
  ): Promise<string> {
    trace.push("around: before proceed");
    const result = await joinPoint.proceed();
    trace.push("around: after proceed");
    return result;
  }
}

// ---------------------------------------------------------------------------

const opened: (() => Promise<unknown>)[] = [];

const immediately = setTimeout;

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
// Timers fire without their delay, which removes the backoff of
// `RetryAspect`.
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
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
  ) => immediately(callback, 0)) as typeof setTimeout);
});

const shopAspects = [Actor, Permissions, PermissionAspect, RetryAspect];

/** The shop module with the aspects its annotations require and `providers`. */
async function shop(
  providers: (new (...args: any[]) => unknown)[] = [],
  returnValueAdapters: ReturnValueAdapter<any>[] = [],
) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AspectModule.forRoot({ report: false, returnValueAdapters }),
      ShopModule,
      InfrastructureModule,
    ],
    providers: [...shopAspects, ...providers],
  })
    .setLogger(new RecordingLogger())
    .compile();
  return moduleRef.init();
}

/** The README states this type for `P.args(String, Number)`. */
const typedArguments = P.args(String, Number);
const _typedArguments: (
  joinPoint: JoinPointOf<typeof typedArguments>,
) => readonly [string, number] = (joinPoint) => joinPoint.args;
const quoting = P.method(ShippingClient, "quote");
const _quoting: (joinPoint: JoinPointOf<typeof quoting>) => readonly [string] =
  (joinPoint) => joinPoint.args;

/** The members `aspect` advises, in the order the inspector lists them. */
function advisedBy(
  inspector: AspectInspector,
  aspect: new (...args: any[]) => unknown,
): string[] {
  return inspector
    .advisedMembers()
    .filter(({ advisors }) => advisors.some(({ type }) => type === aspect))
    .map(({ type, name }) => `${type.name}.${String(name)}`);
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((close) => close()));
  trace.length = 0;
  upstream.calls.length = 0;
  upstream.outcomes.clear();
  cacheState.entries.clear();
  cacheState.failure = undefined;
  transactionLog.length = 0;
  heldLocks.clear();
  errorReports.received.length = 0;
  errorReports.failure = undefined;
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

const readme = readFileSync(join(__dirname, "../README.md"), "utf8");

describe("README examples", () => {
  it("are the code of this file", () => {
    const source = normalize(readFileSync(__filename, "utf8"));
    const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map(
      ([, code]) => code,
    );

    expect(blocks.length).toBeGreaterThan(25);
    const missing = blocks.filter(
      (block) => !source.includes(normalize(block)),
    );
    expect(missing).toEqual([]);
  });

  it("quick start: records the actor, the subject and the outcome of every audited call", async () => {
    const app = await NestFactory.createApplicationContext(AppModule);
    const members = app.get(MemberService);

    await app.get(Actor).run("alice", async () => {
      await members.invite("member-7", "editor");
      await app.get(ApiKeyService).revoke("key-3");
    });
    await members.remove("member-9").catch(() => undefined);

    const { entries } = app.get(AuditLog);

    expect(entries).toEqual([
      {
        action: "member.invite",
        actor: "alice",
        subject: "member-7",
        outcome: "ok",
      },
      {
        action: "api-key.revoke",
        actor: "alice",
        subject: "key-3",
        outcome: "ok",
      },
      {
        action: "member.remove",
        actor: "anonymous",
        subject: "member-9",
        outcome: "failed",
        error: "NotFoundException",
      },
    ]);
  });

  it("forRootAsync: takes the report level from an injected provider, and the README shows that report", async () => {
    const logger = new RecordingLogger();
    const moduleRef = await Test.createTestingModule({
      imports: [ConfiguredAppModule],
    })
      .setLogger(logger)
      .compile();
    await moduleRef.init();

    const report = logger.messages("log");
    expect(report).toEqual([
      "MemberService.invite <- AuditAspect.succeeded (afterReturning, no order)",
      "MemberService.invite <- AuditAspect.failed (afterThrowing, no order)",
      "MemberService.remove <- AuditAspect.succeeded (afterReturning, no order)",
      "MemberService.remove <- AuditAspect.failed (afterThrowing, no order)",
      "ApiKeyService.revoke <- AuditAspect.succeeded (afterReturning, no order)",
      "ApiKeyService.revoke <- AuditAspect.failed (afterThrowing, no order)",
    ]);
    expect(readme).toContain(`\`\`\`\n${report.join("\n")}\n\`\`\``);
  });

  it("annotations: fails the bootstrap when no aspect handles a requiresAdvice annotation", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false }), ShopModule],
    })
      .setLogger(new RecordingLogger())
      .compile();

    const failure = await moduleRef.init().catch((error) => error);

    expect(failure).toBeInstanceOf(AspectConfigurationError);
    expect(failure.message).toContain("PaymentClient.charge (@Retryable)");
    expect(failure.message).toContain(
      "CatalogService.reprice (@RequiresPermission)",
    );
  });

  it("before advice: rejects a guarded call of an actor without the permission, whoever makes the call", async () => {
    const app = await shop();
    const actor = app.get(Actor);
    upstream.answer("payments/refund", "refund-1");

    const checkout = app.get(CheckoutService);
    app.get(Permissions).grant("support-agent", "payments:refund");

    const refund = await actor.run("support-agent", () =>
      checkout.refund("order-1", "charge-1"),
    );
    const denied = await checkout
      .refund("order-1", "charge-1")
      .catch((error) => error);

    expect(refund).toBe("refund-1");
    expect(denied).toBeInstanceOf(ForbiddenException);
    expect(denied.message).toBe("anonymous lacks payments:refund");
    expect(upstream.callsOf("payments/refund")).toEqual([
      { idempotencyKey: "refund:order-1", chargeId: "charge-1" },
    ]);
    await expect(
      actor.run("support-agent", () => checkout.ship("order-1", "Lisbon")),
    ).rejects.toThrow("support-agent lacks orders:ship");
    expect(upstream.callsOf("shipping/book")).toEqual([]);
  });

  it("after-returning advice: evicts the cached value after a successful write, and not after a failed one", async () => {
    const app = await shop([CacheEvictionAspect]);
    const catalog = app.get(CatalogService);
    const products = app.get(ProductRepository);
    const editor = <T>(work: () => T) => app.get(Actor).run("editor", work);
    app.get(Permissions).grant("editor", "catalog:write");

    await editor(() => catalog.reprice("widget", 10));
    expect(await catalog.price("widget")).toBe(10);

    await editor(() => catalog.reprice("widget", 12));
    expect(await catalog.price("widget")).toBe(12);

    vi.spyOn(products, "savePrice").mockRejectedValueOnce(new Error("down"));
    await expect(editor(() => catalog.reprice("widget", 15))).rejects.toThrow(
      "down",
    );
    expect(cacheState.entries.get("price:widget")).toBe(12);

    await catalog.reprice("widget", 20).catch(() => undefined);
    expect(cacheState.entries.get("price:widget")).toBe(12);

    await editor(() => catalog.discontinue("widget"));
    expect(await catalog.price("widget")).toBeUndefined();
  });

  it("after-returning advice: keeps the result of the write when the eviction fails", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockReturnValue();
    const app = await shop([CacheEvictionAspect]);
    const catalog = app.get(CatalogService);
    app.get(Permissions).grant("editor", "catalog:write");
    cacheState.failure = new Error("The cache is unreachable");

    await expect(
      app.get(Actor).run("editor", () => catalog.reprice("widget", 10)),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      "Cannot evict price:widget: Error: The cache is unreachable",
    );
  });

  it("after-throwing advice: replaces the transport error of every client method and no other error", async () => {
    const app = await shop([UpstreamErrorAspect]);
    const shipping = app.get(ShippingClient);
    const timeout = new TransportError("timeout");

    upstream.answer("shipping/book", timeout);
    const failure = await shipping
      .book("order-1", "Lisbon")
      .catch((error) => error);

    expect(failure).toBeInstanceOf(UpstreamUnavailableError);
    expect(failure.message).toBe("ShippingClient.book did not answer");
    expect(failure.cause).toBe(timeout);

    upstream.answer("shipping/book", new RangeError("Unknown destination"));
    await expect(shipping.book("order-1", "Atlantis")).rejects.toThrow(
      RangeError,
    );
  });

  it("after advice: holds the shutdown until the pending client calls have settled", async () => {
    const app = await shop([InFlightCalls, DrainAspect]);
    let answer: (shipment: string) => void = () => undefined;
    upstream.answer(
      "shipping/book",
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    );

    const booking = app.get(ShippingClient).book("order-1", "Lisbon");
    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => immediately(resolve, 20));
    expect(closed).toBe(false);

    answer("shipment-1");
    await expect(booking).resolves.toBe("shipment-1");
    await closing;
    expect(closed).toBe(true);
  });

  it("after advice: counts a failed call as settled and leaves a result that is no promise alone", async () => {
    const app = await shop([InFlightCalls, DrainAspect]);
    upstream.answer("shipping/book", new TransportError("timeout"));

    await expect(
      app.get(ShippingClient).book("order-1", "Lisbon"),
    ).rejects.toThrow("timeout");
    app.get(ShippingClient).track("shipment-1");
    app.get(PaymentClient).settlements("2026-10-12");

    expect(advisedBy(app.get(AspectInspector), DrainAspect)).toEqual([
      "PaymentClient.charge",
      "PaymentClient.refund",
      "ShippingClient.quote",
      "ShippingClient.book",
    ]);
    await expect(app.close()).resolves.toBeUndefined();
  });

  it("around advice: repeats a call after a transient error, up to the attempts of the annotation", async () => {
    const app = await shop([UpstreamErrorAspect]);
    const payments = app.get(PaymentClient);
    const timeout = new TransportError("timeout");

    upstream.answer("payments/charge", timeout, timeout, "charge-1");
    await expect(payments.charge("charge:order-1", 30)).resolves.toBe(
      "charge-1",
    );
    expect(upstream.callsOf("payments/charge")).toEqual(
      Array(3).fill({ idempotencyKey: "charge:order-1", amount: 30 }),
    );

    upstream.answer("payments/refund", timeout);
    await expect(payments.refund("refund:order-1", "charge-1")).rejects.toThrow(
      UpstreamUnavailableError,
    );
    expect(upstream.callsOf("payments/refund")).toHaveLength(3);

    upstream.answer("shipping/quote", timeout);
    await expect(app.get(ShippingClient).quote("Lisbon")).rejects.toThrow(
      UpstreamUnavailableError,
    );
    expect(upstream.callsOf("shipping/quote")).toHaveLength(2);
  });

  it("around advice: repeats neither another error nor a call without the annotation", async () => {
    const app = await shop([UpstreamErrorAspect]);

    upstream.answer("payments/charge", new RangeError("The card is expired"));
    await expect(
      app.get(PaymentClient).charge("charge:order-1", 30),
    ).rejects.toThrow("The card is expired");
    expect(upstream.callsOf("payments/charge")).toHaveLength(1);

    upstream.answer("shipping/book", new TransportError("timeout"));
    await expect(
      app.get(ShippingClient).book("order-1", "Lisbon"),
    ).rejects.toThrow(UpstreamUnavailableError);
    expect(upstream.callsOf("shipping/book")).toHaveLength(1);
  });

  it("around advice: waits up to the doubled backoff before each further attempt", async () => {
    const app = await shop([UpstreamErrorAspect]);
    const timeout = new TransportError("timeout");
    upstream.answer("payments/charge", timeout, timeout, "charge-1");
    vi.spyOn(Math, "random").mockReturnValue(1);
    vi.mocked(setTimeout).mockRestore();
    vi.useFakeTimers();

    const charge = app.get(PaymentClient).charge("charge:order-1", 30);
    await vi.advanceTimersByTimeAsync(199);
    expect(upstream.callsOf("payments/charge")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(upstream.callsOf("payments/charge")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(399);
    expect(upstream.callsOf("payments/charge")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    await expect(charge).resolves.toBe("charge-1");
  });

  it("transaction recipe: repeats the transaction that lost a conflict in a new one", async () => {
    const app = await NestFactory.createApplicationContext(WalletModule);
    const service = app.get(WalletService);
    const wallets = app.get(WalletRepository);

    await service.deposit("alice", 25);
    await Promise.all([
      service.move("alice", "bob", 10),
      service.move("alice", "carol", 10),
    ]);

    const balances = [
      await wallets.balance("alice"),
      await wallets.balance("bob"),
      await wallets.balance("carol"),
    ];

    expect(balances).toEqual([5, 10, 10]);
    expect(transactionLog).toEqual([
      "begin serializable",
      "commit",
      "begin serializable",
      "begin serializable",
      "commit",
      "rollback",
      "begin serializable",
      "commit",
    ]);

    const inspector = app.get(AspectInspector);
    const chain = inspector
      .advisorsOf(WalletService, "move")
      .map(({ type, kind, order }) => `${type.name} ${kind} ${order}`);

    expect(chain).toEqual([
      "RetryAspect around 20",
      "TransactionAspect around 100",
    ]);
  });

  it("transaction recipe: discards the writes of a method that fails, and does not repeat it", async () => {
    const app = await NestFactory.createApplicationContext(WalletModule);
    const service = app.get(WalletService);
    const wallets = app.get(WalletRepository);
    await service.deposit("alice", 25);
    transactionLog.length = 0;
    const add = wallets.add.bind(wallets);
    vi.spyOn(wallets, "add").mockImplementation(async (owner, amount) => {
      if (owner === "bob") {
        throw new Error("The connection is closed");
      }
      return add(owner, amount);
    });

    await expect(service.move("alice", "bob", 10)).rejects.toThrow(
      "The connection is closed",
    );
    await expect(service.move("alice", "carol", 30)).rejects.toThrow(
      InsufficientFundsError,
    );

    expect(await wallets.balance("alice")).toBe(25);
    expect(transactionLog).toEqual([
      "begin serializable",
      "rollback",
      "begin serializable",
      "rollback",
    ]);
  });

  it("transaction recipe: gives up after the attempts of the annotation", async () => {
    const app = await NestFactory.createApplicationContext(WalletModule);
    const client = app.get(DatabaseClient);
    vi.spyOn(client, "transaction").mockRejectedValue(
      Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    );

    const failure = await app
      .get(WalletService)
      .deposit("alice", 25)
      .catch((error) => error);

    expect(failure).toBeInstanceOf(TransientError);
    expect(failure.cause.message).toBe("deadlock detected");
    expect(client.transaction).toHaveBeenCalledTimes(3);
  });

  it("transaction recipe: joins the transaction that is active when the method is called", async () => {
    const app = await NestFactory.createApplicationContext(WalletModule);
    const database = app.get(Database);
    const service = app.get(WalletService);
    const wallets = app.get(WalletRepository);
    await service.deposit("alice", 15);
    transactionLog.length = 0;

    await expect(
      database.transactional(async () => {
        await service.move("alice", "bob", 10);
        await service.move("alice", "carol", 10);
      }),
    ).rejects.toThrow("alice cannot pay 10");

    expect(transactionLog).toEqual(["begin read committed", "rollback"]);
    expect(await wallets.balance("bob")).toBe(0);
  });

  it("transaction recipe: fails the bootstrap without the aspect, and the call where the bootstrap is lenient", async () => {
    const metadata = {
      imports: [InfrastructureModule],
      providers: [Database, RetryAspect, WalletRepository, WalletService],
    };
    const strict = await Test.createTestingModule({
      ...metadata,
      imports: [AspectModule.forRoot({ report: false }), ...metadata.imports],
    })
      .setLogger(new RecordingLogger())
      .compile();

    await expect(strict.init()).rejects.toThrow("WalletService.move");
    await strict.close().catch(() => undefined);

    const lenient = await Test.createTestingModule({
      ...metadata,
      imports: [
        AspectModule.forRoot({ report: false, strict: false }),
        ...metadata.imports,
      ],
    })
      .setLogger(new RecordingLogger())
      .compile();
    await lenient.init();

    await expect(
      Promise.resolve().then(() =>
        lenient.get(WalletService).deposit("alice", 1),
      ),
    ).rejects.toThrow(AspectConfigurationError);
    expect(await lenient.get(WalletRepository).balance("alice")).toBe(0);
  });

  it("job recipe: runs a scheduled method as its own actor, skips it under a held lock and reports its failure", async () => {
    upstream.answer(
      "supplier/prices",
      { widget: 12 },
      new TransportError("timeout"),
    );

    const app = await NestFactory.createApplicationContext(JobsModule);
    const scheduler = app.get(Scheduler);
    app.get(Permissions).grant("job:price-sync", "catalog:write");

    await scheduler.fire("price-sync");
    const price = await app.get(CatalogService).price("widget");

    const release = await app.get(JobLocks).acquire("price-sync");
    await scheduler.fire("price-sync");
    await release?.();

    const failure = await scheduler.fire("price-sync").catch((error) => error);

    expect(price).toBe(12);
    expect(upstream.callsOf("supplier/prices")).toHaveLength(2);
    expect(failure).toBeInstanceOf(TransportError);
    expect(errorReports.received).toEqual(["price-sync: Error: timeout"]);
    expect(heldLocks.size).toBe(0);
  });

  it("job recipe: denies the job a permission its actor lacks, and keeps the error of the job when the report fails", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn").mockReturnValue();
    upstream.answer("supplier/prices", { widget: 12 });
    errorReports.failure = new Error("The tracker is unreachable");
    const app = await NestFactory.createApplicationContext(JobsModule);

    await expect(app.get(Scheduler).fire("price-sync")).rejects.toThrow(
      "job:price-sync lacks catalog:write",
    );

    expect(warn).toHaveBeenCalledWith(
      "Cannot report the failure of price-sync: Error: The tracker is unreachable",
    );
    expect(await app.get(CatalogService).price("widget")).toBeUndefined();
    expect(heldLocks.size).toBe(0);
  });

  it("timing recipe: records the calls of the asynchronous methods of every repository of the module", async () => {
    const app = await NestFactory.createApplicationContext(ReportingModule);
    const users = app.get(UserRepository);

    await users.rename(1, "Ada");
    await users.rename(1, "").catch(() => undefined);
    await users.findName(1);
    users.size();
    await app.get(OrderRepository).findByUser(1);
    await app.get(IdGenerator).next();

    const summary = app.get(CallStatistics).summary();
    const recorded = Object.entries(summary).map(
      ([member, { calls, errors }]) =>
        `${member}: ${calls} calls, ${errors} failed`,
    );

    expect(recorded).toEqual([
      "UserRepository.rename: 2 calls, 1 failed",
      "UserRepository.findName: 1 calls, 0 failed",
      "OrderRepository.findByUser: 1 calls, 0 failed",
    ]);
    expect(
      Object.values(summary).every(({ milliseconds }) => milliseconds >= 0),
    ).toBe(true);
  });

  it("ordering: nests the advice of one aspect by kind, as the README lists it", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false })],
      providers: [Greeter, NestingAspect],
    }).compile();

    await moduleRef.get(Greeter).greet();

    expect(trace).toEqual([
      "around: before proceed",
      "before",
      "after returning",
      "after",
      "around: after proceed",
    ]);
    expect(readme).toContain(`\`\`\`\n${trace.join("\n")}\n\`\`\``);
  });

  it("ordering: runs the aspects of the shop in the order of their numbers", async () => {
    const app = await shop([
      BreakerSettings,
      CircuitBreakerAspect,
      UpstreamErrorAspect,
      InFlightCalls,
      DrainAspect,
      CacheEvictionAspect,
    ]);
    const inspector = app.get(AspectInspector);
    const chain = (type: new (...args: any[]) => unknown, name: string) =>
      inspector
        .advisorsOf(type, name)
        .map(({ type, order }) => `${order} ${type.name}`);

    expect([...new Set(chain(PaymentClient, "charge"))]).toEqual([
      "10 DrainAspect",
      "20 RetryAspect",
      "25 CircuitBreakerAspect",
      "30 UpstreamErrorAspect",
    ]);
    expect(chain(CatalogService, "reprice")).toEqual([
      "0 PermissionAspect",
      "50 CacheEvictionAspect",
    ]);
  });

  it("inspection: pins the members a structural pointcut selects", async () => {
    const app = await shop([UpstreamErrorAspect]);

    const inspector = app.get(AspectInspector);
    const selected = inspector
      .advisedMembers()
      .filter(({ advisors }) =>
        advisors.some(({ type }) => type === UpstreamErrorAspect),
      )
      .map(({ type, name }) => `${type.name}.${String(name)}`);

    expect(selected).toEqual([
      "PaymentClient.charge",
      "PaymentClient.refund",
      "PaymentClient.settlements",
      "ShippingClient.quote",
      "ShippingClient.book",
      "ShippingClient.track",
    ]);
  });

  it("observables: translates the error notification of a cold Observable", async () => {
    upstream.answer("shipping/track", new TransportError("timeout"));

    const app = await NestFactory.createApplicationContext(TrackingModule);

    const updates = app.get(ShippingClient).track("shipment-1");
    const lost = await lastValueFrom(updates).catch((error) => error);

    expect(lost).toBeInstanceOf(UpstreamUnavailableError);
    expect(lost.message).toBe("ShippingClient.track did not answer");

    upstream.answer("shipping/track", ["packed", "shipped"]);
    const delivered = app.get(ShippingClient).track("shipment-2");
    expect(upstream.callsOf("shipping/track")).toHaveLength(1);
    await expect(lastValueFrom(delivered)).resolves.toBe("shipped");
  });

  it("other result types: translates the error a later iteration of an async generator raises", async () => {
    upstream.answer(
      "payments/settlements",
      { items: ["settlement-1", "settlement-2"], next: "page-2" },
      new TransportError("timeout"),
    );

    const app = await NestFactory.createApplicationContext(StreamingModule);

    const settlements: string[] = [];
    let failure: unknown;
    try {
      for await (const settlement of app
        .get(PaymentClient)
        .settlements("2026-10-12")) {
        settlements.push(settlement);
      }
    } catch (error) {
      failure = error;
    }

    expect(settlements).toEqual(["settlement-1", "settlement-2"]);
    expect(failure).toBeInstanceOf(UpstreamUnavailableError);
    expect((failure as Error).message).toBe(
      "PaymentClient.settlements did not answer",
    );
    expect(upstream.callsOf("payments/settlements")).toEqual([
      { day: "2026-10-12", cursor: undefined },
      { day: "2026-10-12", cursor: "page-2" },
    ]);
  });

  it("other result types: runs after-returning advice at the last item and after advice also at an early exit", async () => {
    upstream.answer("payments/settlements", {
      items: ["settlement-1", "settlement-2"],
    });
    const app = await shop([SettlementProbe], [asyncGeneratorAdapter]);
    const payments = app.get(PaymentClient);
    const { seen } = app.get(SettlementProbe);

    const settlements = payments.settlements("2026-10-12");
    expect(seen).toEqual([]);
    for await (const settlement of settlements) {
      expect(settlement).toMatch(/^settlement-/);
      expect(seen).toEqual([]);
    }
    expect(seen).toEqual(["after returning settlement-2", "after"]);

    seen.length = 0;
    for await (const settlement of payments.settlements("2026-10-12")) {
      expect(settlement).toBe("settlement-1");
      break;
    }
    expect(seen).toEqual(["after"]);
  });

  it("observables and other result types: without the adapters, the advice misses the error of a stream", async () => {
    upstream.answer("shipping/track", new TransportError("timeout"));
    upstream.answer("payments/settlements", new TransportError("timeout"));
    const app = await shop([UpstreamErrorAspect, SettlementProbe]);

    await expect(
      lastValueFrom(app.get(ShippingClient).track("shipment-1")),
    ).rejects.toBeInstanceOf(TransportError);
    const settlements = app.get(PaymentClient).settlements("2026-10-12");
    expect(app.get(SettlementProbe).seen).toEqual([
      "after returning [object AsyncGenerator]",
      "after",
    ]);
    await expect(settlements.next()).rejects.toBeInstanceOf(TransportError);
  });

  it("advisors: runs a MethodInterceptor around the join points of the static pointcut", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AspectModule.forRoot({ report: false }), InfrastructureModule],
      providers: [
        Database,
        TransactionAdvisor,
        RetryAspect,
        WalletRepository,
        WalletService,
      ],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(WalletService);

    await service.deposit("alice", 5);
    await expect(service.move("alice", "bob", 10)).rejects.toThrow(
      InsufficientFundsError,
    );

    expect(transactionLog).toEqual([
      "begin serializable",
      "commit",
      "begin serializable",
      "rollback",
    ]);
    expect(
      moduleRef
        .get(AspectInspector)
        .advisorsOf(WalletService, "move")
        .map(({ type, order }) => `${order} ${type.name}`),
    ).toEqual(["20 RetryAspect", "100 TransactionAdvisor"]);
  });

  it("instantiation models: keeps the state of a perClass aspect per advised class", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = await shop([
      BreakerSettings,
      CircuitBreakerAspect,
      UpstreamErrorAspect,
    ]);
    const shipping = app.get(ShippingClient);
    const book = () => shipping.book("order-1", "Lisbon");
    upstream.answer("shipping/book", new TransportError("timeout"));
    upstream.answer("payments/charge", "charge-1");

    for (let failure = 1; failure <= 3; failure += 1) {
      await expect(book()).rejects.toBeInstanceOf(UpstreamUnavailableError);
    }
    await expect(book()).rejects.toThrow("ShippingClient is unavailable");
    await expect(shipping.quote("Lisbon")).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    expect(upstream.callsOf("shipping/book")).toHaveLength(3);
    expect(upstream.callsOf("shipping/quote")).toHaveLength(0);
    await expect(
      app.get(PaymentClient).charge("charge:order-1", 30),
    ).resolves.toBe("charge-1");

    vi.advanceTimersByTime(30_000);
    await expect(book()).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await expect(book()).rejects.toBeInstanceOf(CircuitOpenError);
    expect(upstream.callsOf("shipping/book")).toHaveLength(4);

    vi.advanceTimersByTime(30_000);
    upstream.answer("shipping/book", "shipment-1");
    await expect(book()).resolves.toBe("shipment-1");
    upstream.answer("shipping/book", new TransportError("timeout"));
    await expect(book()).rejects.toBeInstanceOf(UpstreamUnavailableError);
    await expect(book()).rejects.toBeInstanceOf(UpstreamUnavailableError);
  });

  it("introductions: adds the members of the interface to each object of the selected class", async () => {
    const app = await shop([LockableAspect]);

    const products = app.get(ProductRepository);
    if (isIntroduced(products, Lockable)) {
      products.lock();
    }
    const locked = introduced(products, Lockable).locked;

    expect(locked).toBe(true);
    expect(isIntroduced(app.get(CatalogService), Lockable)).toBe(false);
  });

  describe("AuditAspect", () => {
    let moduleRef: TestingModule;
    const record = vi.fn();

    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(AuditLog)
        .useValue({ record })
        .compile();
    });

    afterEach(() => moduleRef.close());

    it("records who invited a member", async () => {
      await moduleRef
        .get(Actor)
        .run("alice", () =>
          moduleRef.get(MemberService).invite("member-7", "editor"),
        );

      expect(record).toHaveBeenCalledWith({
        action: "member.invite",
        actor: "alice",
        subject: "member-7",
        outcome: "ok",
      });
    });
  });

  it("testing: an object created outside a live application runs without advice", async () => {
    const add = vi.fn();
    const service = new WalletService({ add } as unknown as WalletRepository);

    await service.move("alice", "bob", 10);

    expect(add.mock.calls).toEqual([
      ["alice", -10],
      ["bob", 10],
    ]);
    expect(transactionLog).toEqual([]);
  });
});
