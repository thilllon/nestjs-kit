import { EventEmitter } from "node:events";
import { Injectable, Logger, Module, type OnModuleInit } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import createSubscriber, { type Subscriber } from "pg-listen";
import {
  InjectPgListen,
  PG_LISTEN_SUBSCRIBER,
  PgListenModule,
} from "./pg-listen.module";
import { PgListenService } from "./pg-listen.service";

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
      constructor(@InjectPgListen() readonly client: Subscriber) {}
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
