import { randomUUID } from "node:crypto";
import { Injectable, type OnModuleInit } from "@nestjs/common";
import { Test, type TestingModule } from "@nestjs/testing";
import { Client } from "pg";
import type { Subscriber } from "pg-listen";
import { expect, it } from "vitest";
import { InjectPgListen, PgListenModule } from "./pg-listen.module";

it("delivers JSON notifications from an independent SQL connection and releases its session on shutdown", async () => {
  const applicationName = `pg-listen-e2e-${randomUUID()}`;
  const channel = `kit_${randomUUID().replaceAll("-", "")}`;
  const received: unknown[] = [];
  const connection = {
    host: "127.0.0.1",
    port: Number(process.env.PGPORT ?? 55432),
    user: "nestjs_kit_test",
    password: "local_test_password",
    database: "nestjs_kit_test",
    connectionTimeoutMillis: 3_000,
    statement_timeout: 3_000,
  };
  @Injectable()
  class Notifications implements OnModuleInit {
    constructor(@InjectPgListen() private readonly subscriber: Subscriber) {}
    onModuleInit() {
      this.subscriber.notifications.on(channel, (payload: unknown) =>
        received.push(payload),
      );
    }
  }
  const sender = new Client(connection);
  let module: TestingModule | undefined;
  try {
    await sender.connect();
    module = await Test.createTestingModule({
      imports: [
        PgListenModule.register({
          connection: { ...connection, application_name: applicationName },
          channels: [channel],
        }),
      ],
      providers: [Notifications],
    }).compile();
    await module.init();
    const payload = {
      id: randomUUID(),
      nested: { ready: true },
      text: "안녕하세요",
    };
    await sender.query("select pg_notify($1, $2)", [
      channel,
      JSON.stringify(payload),
    ]);
    await expect.poll(() => received, { timeout: 5_000 }).toEqual([payload]);
    const active = await sender.query(
      "select count(*)::int as count from pg_stat_activity where application_name = $1",
      [applicationName],
    );
    expect(active.rows[0].count).toBe(1);
    const closing = module;
    module = undefined;
    await closing.close();
    await expect
      .poll(async () => {
        const result = await sender.query(
          "select count(*)::int as count from pg_stat_activity where application_name = $1",
          [applicationName],
        );
        return result.rows[0].count;
      })
      .toBe(0);
  } finally {
    try {
      await module?.close();
    } finally {
      await sender.end();
    }
  }
});
