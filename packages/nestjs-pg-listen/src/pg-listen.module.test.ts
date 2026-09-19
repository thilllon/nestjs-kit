import { EventEmitter } from "node:events";
import {
  ConsoleLogger,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnModuleInit,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import createSubscriber, { type Subscriber } from "pg-listen";
import { PG_LISTEN_SUBSCRIBER, PgListenModule } from "./pg-listen.module";
import { PgListenService } from "./pg-listen.service";
import { getPgListenServiceToken, getPgListenSubscriberToken } from "./index";

vi.mock("pg-listen", () => ({ default: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function mockSubscriber() {
  return {
    events: new EventEmitter(),
    notifications: new EventEmitter(),
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listenTo: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn().mockResolvedValue(undefined),
  };
}

let subscriber: ReturnType<typeof mockSubscriber>;
beforeEach(() => {
  subscriber = mockSubscriber();
  vi.mocked(createSubscriber).mockReturnValue(
    subscriber as unknown as Subscriber,
  );
});

describe("PgListenModule", () => {
  it("injects the subscriber, starts after consumer initialization, deduplicates channels and closes once", async () => {
    const received = vi.fn();
    @Injectable()
    class Consumer implements OnModuleInit {
      constructor(
        @Inject(getPgListenSubscriberToken()) readonly client: Subscriber,
      ) {}

      onModuleInit() {
        this.client.notifications.on("updates", received);
      }
    }
    const connection = { connectionString: "postgres://localhost/example" };
    const options = { retryTimeout: 5000 };
    const module = await Test.createTestingModule({
      imports: [
        PgListenModule.register({
          connection,
          options,
          channels: ["updates", "updates", "jobs"],
        }),
      ],
      providers: [Consumer],
    }).compile();
    expect(createSubscriber).toHaveBeenCalledWith(connection, options);
    expect(module.get(Consumer).client).toBe(subscriber);
    expect(module.get(PG_LISTEN_SUBSCRIBER)).toBe(subscriber);
    expect(subscriber.connect).not.toHaveBeenCalled();
    subscriber.connect.mockImplementation(async () => {
      subscriber.notifications.emit("updates", { id: 1 });
    });
    await module.init();
    expect(received).toHaveBeenCalledWith({ id: 1 });
    expect(subscriber.listenTo.mock.calls).toEqual([["updates"], ["jobs"]]);
    await module.close();
    await module.get(PgListenService).onModuleDestroy();
    expect(subscriber.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "isolates default and named registrations with real consumer injection (async=%s)",
    async (async) => {
      const audit = mockSubscriber();
      const jobs = mockSubscriber();
      const clients = { default: subscriber, audit, jobs };
      vi.mocked(createSubscriber).mockImplementation(
        (connection) =>
          clients[
            connection?.application_name as keyof typeof clients
          ] as unknown as Subscriber,
      );
      @Module({
        providers: [
          { provide: "AUDIT_CONFIG", useValue: { application_name: "audit" } },
        ],
        exports: ["AUDIT_CONFIG"],
      })
      class ConfigurationModule {}
      @Injectable()
      class Consumer {
        constructor(
          @Inject(getPgListenSubscriberToken())
          readonly defaultClient: Subscriber,
          @Inject(getPgListenSubscriberToken(""))
          readonly emptyAliasClient: Subscriber,
          @Inject(getPgListenSubscriberToken("default"))
          readonly explicitDefaultClient: Subscriber,
          @Inject(getPgListenSubscriberToken("audit"))
          readonly auditClient: Subscriber,
          @Inject(getPgListenSubscriberToken("jobs"))
          readonly jobsClient: Subscriber,
          @Inject(getPgListenServiceToken())
          readonly defaultService: PgListenService,
          @Inject(getPgListenServiceToken("audit"))
          readonly auditService: PgListenService,
          @Inject(getPgListenServiceToken("jobs"))
          readonly jobsService: PgListenService,
        ) {}
      }
      const auditOptions = {
        connection: { application_name: "audit" },
        channels: ["audit"],
        options: { retryTimeout: 1000 },
      };
      const module = await Test.createTestingModule({
        imports: [
          PgListenModule.register({
            alias: "",
            connection: { application_name: "default" },
            channels: ["default"],
          }),
          async
            ? PgListenModule.registerAsync({
                alias: "audit",
                imports: [ConfigurationModule],
                inject: ["AUDIT_CONFIG"],
                useFactory: async (connection: {
                  application_name: string;
                }) => ({ ...auditOptions, connection }),
              })
            : PgListenModule.register({ alias: "audit", ...auditOptions }),
          PgListenModule.registerAsync({
            alias: "jobs",
            useFactory: () => ({
              connection: { application_name: "jobs" },
              channels: ["jobs"],
              options: { retryTimeout: 2000 },
            }),
          }),
        ],
        providers: [Consumer],
      }).compile();
      const consumer = module.get(Consumer);
      expect(consumer.defaultClient).toBe(subscriber);
      expect(consumer.emptyAliasClient).toBe(subscriber);
      expect(consumer.explicitDefaultClient).toBe(subscriber);
      expect(consumer.auditClient).toBe(audit);
      expect(consumer.jobsClient).toBe(jobs);
      expect(consumer.defaultService).toBe(module.get(PgListenService));
      expect(consumer.auditService.subscriber).toBe(audit);
      expect(consumer.jobsService.subscriber).toBe(jobs);
      expect(module.get(getPgListenSubscriberToken("audit"))).toBe(audit);
      expect(module.get(getPgListenServiceToken("audit"))).toBe(
        consumer.auditService,
      );
      expect(createSubscriber).toHaveBeenCalledWith(
        auditOptions.connection,
        auditOptions.options,
      );
      expect(createSubscriber).toHaveBeenCalledWith(
        { application_name: "jobs" },
        { retryTimeout: 2000 },
      );
      await module.init();
      for (const [name, client] of Object.entries(clients)) {
        expect(client.connect).toHaveBeenCalledOnce();
        expect(client.listenTo.mock.calls).toEqual([[name]]);
      }
      await consumer.auditService.onModuleDestroy();
      expect(audit.close).toHaveBeenCalledOnce();
      expect(jobs.close).not.toHaveBeenCalled();
      expect(subscriber.close).not.toHaveBeenCalled();
      await module.close();
      for (const client of Object.values(clients)) {
        expect(client.close).toHaveBeenCalledOnce();
      }
    },
  );

  it("supports async configuration with imported providers and no initial channels", async () => {
    @Module({
      providers: [{ provide: "PG_CONFIG", useValue: { host: "localhost" } }],
      exports: ["PG_CONFIG"],
    })
    class ConfigurationModule {}
    const module = await Test.createTestingModule({
      imports: [
        PgListenModule.registerAsync({
          imports: [ConfigurationModule],
          inject: ["PG_CONFIG"],
          useFactory: async (connection: { host: string }) => ({ connection }),
        }),
      ],
    }).compile();
    await module.init();
    expect(createSubscriber).toHaveBeenCalledWith(
      { host: "localhost" },
      undefined,
    );
    expect(subscriber.connect).toHaveBeenCalledOnce();
    expect(subscriber.listenTo).not.toHaveBeenCalled();
    await module.close();
  });

  it.each(["connect", "listenTo"] as const)(
    "closes and preserves a %s startup error",
    async (method) => {
      const failure = new Error("database unavailable");
      subscriber[method].mockRejectedValue(failure);
      const module = await Test.createTestingModule({
        imports: [PgListenModule.register({ channels: ["updates"] })],
      }).compile();
      await expect(module.init()).rejects.toBe(failure);
      expect(subscriber.close).toHaveBeenCalledOnce();
      await module.get(PgListenService).onModuleDestroy();
      expect(subscriber.close).toHaveBeenCalledOnce();
    },
  );

  it("preserves startup failure even if cleanup also fails", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    const failure = new Error("connect failed");
    subscriber.connect.mockRejectedValue(failure);
    subscriber.close.mockRejectedValueOnce(new Error("close failed"));
    const module = await Test.createTestingModule({
      imports: [PgListenModule.register({})],
    }).compile();
    await expect(module.init()).rejects.toBe(failure);
    await module.get(PgListenService).onModuleDestroy();
    expect(subscriber.close).toHaveBeenCalledTimes(2);
  });

  it("shares pending close requests and retries after rejection", async () => {
    const pending = deferred();
    subscriber.close.mockReturnValueOnce(pending.promise);
    const module = await Test.createTestingModule({
      imports: [PgListenModule.register({})],
    }).compile();
    const service = module.get(PgListenService);
    const first = service.onModuleDestroy();
    const second = service.onModuleDestroy();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(subscriber.close).toHaveBeenCalledOnce();
    const failure = new Error("close failed");
    const settled = Promise.allSettled([first, second]);
    pending.reject(failure);
    expect(await settled).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ]);
    await service.onModuleDestroy();
    await module.close();
    expect(subscriber.close).toHaveBeenCalledTimes(2);
  });

  it("shares startup-failure cleanup with a concurrent shutdown", async () => {
    const pending = deferred();
    const failure = new Error("startup failed");
    subscriber.connect.mockRejectedValue(failure);
    subscriber.close.mockReturnValue(pending.promise);
    const module = await Test.createTestingModule({
      imports: [PgListenModule.register({})],
    }).compile();
    const service = module.get(PgListenService);
    const startup = service.onApplicationBootstrap();
    const assertion = expect(startup).rejects.toBe(failure);
    await Promise.resolve();
    const shutdown = service.onModuleDestroy();
    await Promise.resolve();
    expect(subscriber.close).toHaveBeenCalledOnce();
    pending.resolve();
    await Promise.all([assertion, shutdown]);
    await module.close();
    expect(subscriber.close).toHaveBeenCalledOnce();
  });

  it.each(["overrideLogger", "useLogger"] as const)(
    "routes its default logger through Nest %s, including startup cleanup errors",
    async (mode) => {
      const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const module = await Test.createTestingModule({
        imports: [PgListenModule.register({})],
      }).compile();
      try {
        if (mode === "overrideLogger") {
          Logger.overrideLogger(logger);
        } else {
          module.useLogger(logger);
        }
        const runtimeError = new Error("subscriber reconnect exhausted");
        subscriber.events.emit("error", runtimeError);
        expect(logger.error).toHaveBeenCalledWith(
          runtimeError.message,
          runtimeError.stack,
          PgListenService.name,
        );
        const startupError = new Error("startup connection failed");
        const cleanupError = new Error("startup cleanup failed");
        subscriber.connect.mockRejectedValueOnce(startupError);
        subscriber.close.mockRejectedValueOnce(cleanupError);
        await expect(module.init()).rejects.toBe(startupError);
        expect(logger.error).toHaveBeenCalledWith(
          "Failed to close PostgreSQL subscriber after startup failure",
          cleanupError,
          PgListenService.name,
        );
        await module.get(PgListenService).onModuleDestroy();
      } finally {
        Logger.overrideLogger(new ConsoleLogger());
      }
    },
  );

  it("isolates injected loggers and preserves errors and cleanup for named registrations", async () => {
    const audit = mockSubscriber();
    const jobs = mockSubscriber();
    vi.mocked(createSubscriber).mockImplementation(
      (connection) =>
        (connection?.application_name === "audit"
          ? audit
          : jobs) as unknown as Subscriber,
    );
    const auditLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const jobsLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const loggerToken = Symbol("AUDIT_LOGGER");
    @Module({
      providers: [{ provide: loggerToken, useValue: auditLogger }],
      exports: [loggerToken],
    })
    class LoggingModule {}
    const module = await Test.createTestingModule({
      imports: [
        PgListenModule.registerAsync({
          alias: "audit",
          imports: [LoggingModule],
          inject: [loggerToken],
          useFactory: (logger: typeof auditLogger) => ({
            logger,
            connection: { application_name: "audit" },
          }),
        }),
        PgListenModule.register({ alias: "jobs", logger: jobsLogger }),
      ],
    }).compile();
    const auditService = module.get<PgListenService>(
      getPgListenServiceToken("audit"),
    );
    const jobsService = module.get<PgListenService>(
      getPgListenServiceToken("jobs"),
    );
    const auditError = new Error("audit exhausted");
    const jobsError = new Error("jobs exhausted");
    audit.events.emit("error", auditError);
    jobs.events.emit("error", jobsError);
    expect(auditLogger.error).toHaveBeenCalledExactlyOnceWith(
      auditError.message,
      auditError.stack,
    );
    expect(jobsLogger.error).toHaveBeenCalledExactlyOnceWith(
      jobsError.message,
      jobsError.stack,
    );
    const startupError = new Error("audit unavailable");
    const cleanupError = new Error("audit cleanup failed");
    audit.connect.mockRejectedValueOnce(startupError);
    audit.close.mockRejectedValueOnce(cleanupError);
    await expect(auditService.onApplicationBootstrap()).rejects.toBe(
      startupError,
    );
    expect(auditLogger.error).toHaveBeenLastCalledWith(
      "Failed to close PostgreSQL subscriber after startup failure",
      cleanupError,
    );
    expect(jobsLogger.error).toHaveBeenCalledTimes(1);
    await jobsService.onApplicationBootstrap();
    expect(jobs.close).not.toHaveBeenCalled();
    await module.close();
    expect(audit.close).toHaveBeenCalledTimes(2);
    expect(jobs.close).toHaveBeenCalledOnce();
  });

  it("logs fatal error events and permits additional application error handlers", async () => {
    const log = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => {});
    const module = await Test.createTestingModule({
      imports: [PgListenModule.register({})],
    }).compile();
    const error = new Error("reconnect exhausted");
    const handler = vi.fn();
    subscriber.events.on("error", handler);
    expect(() => subscriber.events.emit("error", error)).not.toThrow();
    expect(log).toHaveBeenCalledWith(error.message, error.stack);
    expect(handler).toHaveBeenCalledWith(error);
    await module.close();
  });
});
