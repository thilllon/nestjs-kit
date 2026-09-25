import { randomUUID } from "node:crypto";
import { Controller, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxyFactory,
  MessagePattern,
  MqttRecordBuilder,
  NatsRecordBuilder,
  Payload,
  RmqRecordBuilder,
  Transport,
  type ClientProxy,
  type ClientOptions,
  type KafkaOptions,
  type MicroserviceOptions,
} from "@nestjs/microservices";
import { headers as natsHeaders } from "@nats-io/transport-node";
import { bearer } from "better-auth/plugins";
import { Kafka, logLevel } from "kafkajs";
import { firstValueFrom, timeout } from "rxjs";
import { describe, expect, it } from "vitest";
import { Public } from "./auth-decorators.js";
import { BetterAuthModule } from "./auth-module.js";
import {
  kafkaTestConsumer,
  ReadyClientKafka,
  ReadyServerKafka,
} from "./kafka-fixture.js";
import {
  kafkaCarrier,
  mqttCarrier,
  natsCarrier,
  payloadCarrier,
  rmqCarrier,
  rpcTransport,
} from "./microservices.js";
import { CurrentUser } from "./session-principal.js";
import { createTestAuth, createTestIdentity } from "./test-fixtures.js";

const carrierFactories = {
  nats: natsCarrier,
  kafka: kafkaCarrier,
  rmq: rmqCarrier,
  mqtt: mqttCarrier,
  redis: payloadCarrier,
};
type Family = keyof typeof carrierFactories;
function kafkaOptions(id: string): Required<KafkaOptions>["options"] {
  return {
    client: {
      brokers: [`127.0.0.1:${process.env.KAFKA_PORT ?? 59092}`],
      clientId: id,
      logLevel: logLevel.NOTHING,
    },
    consumer: { groupId: id, ...kafkaTestConsumer },
    subscribe: { fromBeginning: false },
  };
}
function options(family: Family, id: string): MicroserviceOptions {
  switch (family) {
    case "nats":
      return {
        transport: Transport.NATS,
        options: {
          servers: [`nats://127.0.0.1:${process.env.NATS_PORT ?? 54222}`],
        },
      };
    case "kafka":
      return { transport: Transport.KAFKA, options: kafkaOptions(id) };
    case "rmq":
      return {
        transport: Transport.RMQ,
        options: {
          urls: [
            `amqp://nestjs_kit_test:local_test_password@127.0.0.1:${process.env.RABBITMQ_PORT ?? 55672}`,
          ],
          queue: id,
          queueOptions: { durable: true, autoDelete: true },
          noAck: true,
        },
      };
    case "mqtt":
      return {
        transport: Transport.MQTT,
        options: {
          url: `mqtt://127.0.0.1:${process.env.MQTT_PORT ?? 51883}`,
          protocolVersion: 5,
        },
      };
    case "redis":
      return {
        transport: Transport.REDIS,
        options: {
          host: "127.0.0.1",
          port: Number(process.env.REDIS_PORT ?? 56379),
        },
      };
  }
}
function envelope(
  family: Family,
  data: object,
  credentials: Record<string, string>,
): unknown {
  switch (family) {
    case "nats": {
      const headers = natsHeaders();
      for (const [key, value] of Object.entries(credentials)) {
        headers.set(key, value);
      }
      return new NatsRecordBuilder(data).setHeaders(headers).build();
    }
    case "kafka":
      return {
        value: data,
        headers: Object.fromEntries(
          Object.entries(credentials).map(([key, value]) => [
            key,
            Buffer.from(value),
          ]),
        ),
      };
    case "rmq":
      return new RmqRecordBuilder(data)
        .setOptions({ headers: credentials })
        .build();
    case "mqtt":
      return new MqttRecordBuilder(data)
        .setProperties({ userProperties: credentials })
        .build();
    case "redis":
      return { ...data, auth: credentials };
  }
}

describe("RPC real broker carriers", () => {
  it.each(Object.keys(carrierFactories) as Family[])(
    "authenticates isolated per-message identities over %s",
    async (family) => {
      const id = `nsba-${family}-${randomUUID()}`;
      const protectedPattern = `${id}.private`;
      const publicPattern = `${id}.public`;
      const auth = createTestAuth({
        plugins: [bearer()],
        session: { updateAge: 1 },
      });
      @Controller()
      class BrokerController {
        @MessagePattern(protectedPattern)
        privateMessage(
          @CurrentUser() user: { id: string },
          @Payload() payload: { value: string },
        ) {
          return { userId: user.id, received: payload.value };
        }

        @Public()
        @MessagePattern(publicPattern)
        publicMessage(@Payload() payload: { value: string }) {
          return { received: payload.value };
        }
      }
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            transports: [
              rpcTransport({ carriers: [carrierFactories[family]()] }),
            ],
          }),
        ],
        controllers: [BrokerController],
      })
      class Fixture {}
      const config = options(family, id);
      const admin =
        family === "kafka"
          ? new Kafka({
              clientId: `${id}-admin`,
              brokers: [`127.0.0.1:${process.env.KAFKA_PORT ?? 59092}`],
              logLevel: logLevel.NOTHING,
            }).admin()
          : undefined;
      const topics = [
        protectedPattern,
        publicPattern,
        `${protectedPattern}.reply`,
        `${publicPattern}.reply`,
      ];
      let app:
        | Awaited<ReturnType<typeof NestFactory.createMicroservice>>
        | undefined;
      let client: ClientProxy | undefined;
      try {
        if (admin) {
          await admin.connect();
          await admin.createTopics({
            waitForLeaders: true,
            topics: topics.map((topic) => ({
              topic,
              numPartitions: 1,
              replicationFactor: 1,
            })),
          });
        }
        const server =
          family === "kafka"
            ? new ReadyServerKafka(kafkaOptions(id))
            : undefined;
        app = await NestFactory.createMicroservice(Fixture, {
          ...(server ? { strategy: server } : config),
          logger: false,
          abortOnError: false,
        });
        await app.listen();
        if (server) {
          const kafka = new ReadyClientKafka(kafkaOptions(id));
          client = kafka as unknown as ClientProxy;
          kafka.subscribeToResponseOf(protectedPattern);
          kafka.subscribeToResponseOf(publicPattern);
          await kafka.connect();
          // Both consumer groups fix their start offsets after listen() and connect() resolve.
          await Promise.all([server.ready(8000), kafka.ready(8000)]);
        } else {
          client = ClientProxyFactory.create(config as ClientOptions);
          await client.connect();
        }
        const send = (pattern: string, data: unknown) =>
          firstValueFrom(client!.send(pattern, data).pipe(timeout(8000)));
        await expect(
          send(protectedPattern, { value: "absent" }),
        ).rejects.toMatchObject({ statusCode: 401, code: "UNAUTHENTICATED" });
        await expect(
          send(
            publicPattern,
            family === "kafka"
              ? envelope(family, { value: "native" }, {})
              : { value: "native" },
          ),
        ).resolves.toEqual({ received: "native" });
        const first = await createTestIdentity(auth);
        const second = await createTestIdentity(auth);
        const context = await auth.$context;
        await context.internalAdapter.updateSession(first.token, {
          expiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date(Date.now() - 10_000),
        });
        const before = await context.internalAdapter.findSession(first.token);
        await expect(
          send(
            protectedPattern,
            envelope(
              family,
              { value: "cookie" },
              {
                Cookie: first.cookie,
                host: "untrusted.invalid",
                "x-forwarded-host": "untrusted.invalid",
                "set-cookie": "must-not-echo",
              },
            ),
          ),
        ).resolves.toEqual({ userId: first.userId, received: "cookie" });
        await expect(
          send(
            protectedPattern,
            envelope(
              family,
              { value: "bearer" },
              { Authorization: `Bearer ${second.token}` },
            ),
          ),
        ).resolves.toEqual({ userId: second.userId, received: "bearer" });
        expect(
          (await context.internalAdapter.findSession(first.token))?.session,
        ).toEqual(before?.session);
        await context.internalAdapter.deleteSession(first.token);
        await expect(
          send(
            protectedPattern,
            envelope(family, { value: "revoked" }, { cookie: first.cookie }),
          ),
        ).rejects.toMatchObject({ statusCode: 401 });
        await expect(
          send(protectedPattern, { value: "absent-again" }),
        ).rejects.toMatchObject({ statusCode: 401 });
      } finally {
        try {
          await client?.close();
        } finally {
          try {
            await app?.close();
          } finally {
            if (admin) {
              try {
                await admin.deleteTopics({ topics });
              } finally {
                await admin.disconnect();
              }
            }
          }
        }
      }
    },
    60_000,
  );
});
