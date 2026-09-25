import { randomUUID } from "node:crypto";
import type { AddressInfo, Server as NetServer } from "node:net";
import {
  Client as GrpcClient,
  credentials as grpcCredentials,
  loadPackageDefinition,
  Metadata,
  Server as GrpcServer,
  ServerCredentials,
  type ServiceError,
} from "@grpc/grpc-js";
import { fromJSON, type PackageDefinition } from "@grpc/proto-loader";
import { headers as natsHeaders } from "@nats-io/transport-node";
import {
  Controller,
  Inject,
  type INestApplication,
  type INestMicroservice,
  Module,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import {
  type ClientOptions,
  type ClientProxy,
  ClientProxyFactory,
  GrpcMethod,
  MessagePattern,
  type MicroserviceOptions,
  MqttRecordBuilder,
  NatsRecordBuilder,
  Payload,
  RmqRecordBuilder,
  ServerGrpc,
  Transport,
} from "@nestjs/microservices";
import { ExpressAdapter } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { Kafka, logLevel } from "kafkajs";
import { firstValueFrom, timeout } from "rxjs";
import { afterAll, describe, expect, it } from "vitest";
import { adminPermissionPolicy } from "./admin.js";
import type {
  AuthTransport,
  ConformanceCase,
  ExtensionRef,
} from "./auth-contracts.js";
import { UseBetterAuth } from "./auth-decorators.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { BetterAuthService } from "./auth-service.js";
import type { AuthLike } from "./auth-types.js";
import { runConformance } from "./conformance-fixtures.js";
import type { PolicyDelivery } from "./conformance-policy-harness.js";
import {
  type FixtureHandler,
  type TransportConformanceOptions,
  type TransportFixtures,
  type TransportInvocationResult,
  transportConformance,
} from "./conformance-transport.js";
import { expressPlatform } from "./express.js";
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
  type RpcCredentialCarrier,
  rmqCarrier,
  rpcTransport,
} from "./microservices.js";
import {
  adminPolicyOptions,
  organizationPolicyOptions,
  policyDeliveryCases,
} from "./policy-kit-fixtures.js";

type FixtureName = Exclude<keyof TransportFixtures, "graph">;

const REPLY_TIMEOUT_MS = 8000;
const BROKER_TIMEOUT_MS = 60_000;

function flatten(fixtures: TransportFixtures): Map<string, FixtureHandler> {
  const handlers = new Map<string, FixtureHandler>();
  for (const [name, value] of Object.entries(fixtures)) {
    if (name === "graph") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        handlers.set(`${name}${index}`, item);
      }
    } else {
      handlers.set(name, value as FixtureHandler);
    }
  }
  return handlers;
}

/** One booted fixture app: its message patterns and, once listening, its client. */
interface Boot {
  readonly id: string;
  readonly handlers: Map<string, FixtureHandler>;
  readonly microservice: INestMicroservice;
  /** Starts the transport server: standalone listen() or hybrid startAllMicroservices(). */
  readonly start: () => Promise<void>;
  readonly state: { client?: Promise<RpcClient>; server?: RpcServer };
}

interface RpcClient {
  send(
    fixture: string,
    input: Record<string, unknown>,
    headers: Headers,
  ): Promise<TransportInvocationResult>;
  /** Resolves once the connected client receives every reply produced from now on (broker consumers). */
  ready?(timeoutMs: number): Promise<void>;
  close(): Promise<void>;
}

/** The transport server options of one boot, and what the client needs to reach it. */
interface RpcServer {
  readonly options: MicroserviceOptions;
  readonly port?: () => number;
  readonly definition?: PackageDefinition;
  /** Resolves once the started server receives every request produced from now on (broker consumers). */
  readonly ready?: (timeoutMs: number) => Promise<void>;
}

/** One RPC transport family: its credential carrier, handler decorator, server and client. */
interface RpcFamily {
  readonly carriers?: readonly RpcCredentialCarrier[];
  /** Hybrid: connect the microservice to an Express app (explicit handler claims). */
  readonly hybrid?: boolean;
  handler(boot: string, fixture: string): MethodDecorator;
  /** Wraps a handler's result for the wire (gRPC messages are typed). */
  reply?(body: unknown): unknown;
  server(boot: string, fixtures: readonly string[]): Promise<RpcServer>;
  connect(boot: Boot): Promise<RpcClient>;
  /** Releases broker resources after the family's cases. */
  release?(): Promise<void>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** An RpcException payload as the kit's error. */
function rpcFailure(error: unknown): TransportInvocationResult {
  const value = (error ?? {}) as Record<string, unknown>;
  return {
    ok: false,
    error: {
      statusCode:
        typeof value.statusCode === "number" ? value.statusCode : undefined,
      code: text(value.code),
      reason: text(value.reason),
      message: text(value.message),
    },
    setCookies: [],
  };
}

/** A ClientProxy family: the credential envelope decides the carrier. */
function proxyClient(
  client: ClientProxy,
  pattern: (fixture: string) => string,
  envelope: (data: Record<string, unknown>, headers: Headers) => unknown,
): RpcClient {
  return {
    async send(fixture, input, headers) {
      try {
        const body = await firstValueFrom(
          client
            .send(pattern(fixture), envelope(input, headers))
            .pipe(timeout(REPLY_TIMEOUT_MS)),
        );
        return { ok: true, body, setCookies: [] };
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new Error(`${fixture}: no reply`);
        }
        return rpcFailure(error);
      }
    },
    close: async () => {
      await client.close();
    },
  };
}

function isEmpty(headers: Headers): boolean {
  return headers.keys().next().done === true;
}

/** Rejects when `promise` does not settle in time, so a stalled broker step fails its case with the step's name. */
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${label} did not finish in ${REPLY_TIMEOUT_MS} ms`),
            ),
          REPLY_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Credentials in the message payload's `auth` object (payloadCarrier). */
function payloadEnvelope(
  data: Record<string, unknown>,
  headers: Headers,
): unknown {
  return isEmpty(headers)
    ? data
    : { ...data, auth: Object.fromEntries(headers) };
}

function tcp(hybrid: boolean): RpcFamily {
  return {
    hybrid,
    handler: (_boot, fixture) => MessagePattern(fixture),
    async server() {
      return {
        options: {
          transport: Transport.TCP,
          options: { host: "127.0.0.1", port: 0 },
        },
      };
    },
    async connect(boot) {
      const address = boot.microservice
        .unwrap<NetServer>()
        .address() as AddressInfo;
      const client = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port: address.port },
      });
      await client.connect();
      return proxyClient(client, (fixture) => fixture, payloadEnvelope);
    },
  };
}

/** Binds the real Nest gRPC server to an ephemeral port and exposes it. */
class EphemeralGrpc extends ServerGrpc {
  port = 0;

  override async createClient(): Promise<GrpcServer> {
    const server = new GrpcServer();
    this.port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        "127.0.0.1:0",
        ServerCredentials.createInsecure(),
        (error, port) => {
          if (error) {
            reject(error);
          } else {
            resolve(port);
          }
        },
      ),
    );
    return server;
  }
}

/** gRPC statuses of the gRPC carrier (design v7 §13.3) and the failures they stand for. */
const GRPC_STATUS: Readonly<Record<number, { status: number; code: string }>> =
  {
    16: { status: 401, code: "UNAUTHENTICATED" },
    7: { status: 403, code: "FORBIDDEN" },
    8: { status: 429, code: "RATE_LIMITED" },
  };

/** One `Kit` service with a method per fixture; inputs are the kit's input names, replies carry JSON. */
function grpcDefinition(fixtures: readonly string[]): PackageDefinition {
  return fromJSON(
    {
      nested: {
        kit: {
          nested: {
            Kit: {
              methods: Object.fromEntries(
                fixtures.map((fixture) => [
                  fixture,
                  { requestType: "Input", responseType: "Reply" },
                ]),
              ),
            },
            Input: {
              fields: {
                orgId: { type: "string", id: 1 },
                email: { type: "string", id: 2 },
                password: { type: "string", id: 3 },
              },
            },
            Reply: { fields: { json: { type: "string", id: 1 } } },
          },
        },
      },
    } as unknown as Parameters<typeof fromJSON>[0],
    { keepCase: true, defaults: false },
  );
}

type GrpcStub = GrpcClient &
  Record<
    string,
    (
      input: object,
      metadata: Metadata,
      callback: (error: ServiceError | null, reply?: { json?: string }) => void,
    ) => unknown
  >;

function grpc(): RpcFamily {
  return {
    handler: (_boot, fixture) => GrpcMethod("Kit", fixture),
    reply: (body) => ({ json: JSON.stringify(body ?? null) }),
    async server(_boot, fixtures) {
      const definition = grpcDefinition(fixtures);
      const strategy = new EphemeralGrpc({
        package: "kit",
        packageDefinition: definition,
      });
      return { options: { strategy }, port: () => strategy.port, definition };
    },
    async connect(boot) {
      const server = boot.state.server!;
      const Service = (
        loadPackageDefinition(server.definition!).kit as unknown as {
          Kit: new (
            address: string,
            channel: ReturnType<typeof grpcCredentials.createInsecure>,
          ) => GrpcStub;
        }
      ).Kit;
      const client = new Service(
        `127.0.0.1:${server.port!()}`,
        grpcCredentials.createInsecure(),
      );
      return {
        send: (fixture, input, headers) =>
          new Promise((resolve) => {
            const metadata = new Metadata();
            for (const [name, value] of headers) {
              metadata.set(name, value);
            }
            client[fixture]!(input, metadata, (error, reply) => {
              if (!error) {
                resolve({
                  ok: true,
                  body: JSON.parse(reply?.json ?? "null"),
                  setCookies: [],
                });
                return;
              }
              const mapped = GRPC_STATUS[error.code];
              resolve({
                ok: false,
                error: {
                  statusCode: mapped?.status ?? 500,
                  code: mapped?.code,
                  message: error.details,
                },
                setCookies: [],
              });
            });
          }),
        close: async () => client.close(),
      };
    },
  };
}

const port = (name: string, fallback: number) =>
  Number(process.env[name] ?? fallback);

function nats(): RpcFamily {
  const options: MicroserviceOptions = {
    transport: Transport.NATS,
    options: { servers: [`nats://127.0.0.1:${port("NATS_PORT", 54222)}`] },
  };
  return {
    carriers: [natsCarrier()],
    handler: (boot, fixture) => MessagePattern(`${boot}.${fixture}`),
    server: async () => ({ options }),
    async connect(boot) {
      const client = ClientProxyFactory.create(options as ClientOptions);
      await client.connect();
      return proxyClient(
        client,
        (fixture) => `${boot.id}.${fixture}`,
        (data, headers) => {
          if (isEmpty(headers)) {
            return data;
          }
          const values = natsHeaders();
          for (const [name, value] of headers) {
            values.set(name, value);
          }
          return new NatsRecordBuilder(data).setHeaders(values).build();
        },
      );
    },
  };
}

function rmq(): RpcFamily {
  const options = (queue: string): MicroserviceOptions => ({
    transport: Transport.RMQ,
    options: {
      urls: [
        `amqp://nestjs_kit_test:local_test_password@127.0.0.1:${port("RABBITMQ_PORT", 55672)}`,
      ],
      queue,
      // RabbitMQ 4 refuses transient non-exclusive queues.
      queueOptions: { durable: true, autoDelete: true },
      noAck: true,
    },
  });
  return {
    carriers: [rmqCarrier()],
    handler: (_boot, fixture) => MessagePattern(fixture),
    server: async (boot) => ({ options: options(boot) }),
    async connect(boot) {
      const client = ClientProxyFactory.create(
        options(boot.id) as ClientOptions,
      );
      await client.connect();
      return proxyClient(
        client,
        (fixture) => fixture,
        (data, headers) =>
          isEmpty(headers)
            ? data
            : new RmqRecordBuilder(data)
                .setOptions({ headers: Object.fromEntries(headers) })
                .build(),
      );
    },
  };
}

function mqtt(): RpcFamily {
  const options: MicroserviceOptions = {
    transport: Transport.MQTT,
    options: {
      url: `mqtt://127.0.0.1:${port("MQTT_PORT", 51883)}`,
      protocolVersion: 5,
    },
  };
  return {
    carriers: [mqttCarrier()],
    handler: (boot, fixture) => MessagePattern(`${boot}.${fixture}`),
    server: async () => ({ options }),
    async connect(boot) {
      const client = ClientProxyFactory.create(options as ClientOptions);
      await client.connect();
      return proxyClient(
        client,
        (fixture) => `${boot.id}.${fixture}`,
        // An MQTT v5 publish without credentials carries no user properties.
        (data, headers) =>
          isEmpty(headers)
            ? data
            : new MqttRecordBuilder(data)
                .setProperties({ userProperties: Object.fromEntries(headers) })
                .build(),
      );
    },
  };
}

function redis(): RpcFamily {
  const options: MicroserviceOptions = {
    transport: Transport.REDIS,
    options: { host: "127.0.0.1", port: port("REDIS_PORT", 56379) },
  };
  return {
    carriers: [payloadCarrier()],
    handler: (boot, fixture) => MessagePattern(`${boot}.${fixture}`),
    server: async () => ({ options }),
    async connect(boot) {
      const client = ClientProxyFactory.create(options as ClientOptions);
      await client.connect();
      return proxyClient(
        client,
        (fixture) => `${boot.id}.${fixture}`,
        payloadEnvelope,
      );
    },
  };
}

/**
 * Kafka topics are created once per kit run and shared by its boots. Each boot's server joins its own consumer group,
 * which starts at the log end once ready, so no boot reads another boot's requests. One client serves every boot of
 * the run, so its reply consumer group joins once; correlation ids keep the boots' replies apart.
 */
function kafka(): RpcFamily {
  const run = `nsba-kit-${randomUUID()}`;
  const brokers = [`127.0.0.1:${port("KAFKA_PORT", 59092)}`];
  const admin = new Kafka({
    clientId: `${run}-admin`,
    brokers,
    logLevel: logLevel.NOTHING,
  }).admin();
  let topics: Promise<string[]> | undefined;
  let shared: Promise<ReadyClientKafka> | undefined;
  const pattern = (fixture: string) => `${run}.${fixture}`;
  const ensureTopics = (fixtures: readonly string[]) => {
    topics ??= (async () => {
      const names = fixtures.flatMap((fixture) => [
        pattern(fixture),
        `${pattern(fixture)}.reply`,
      ]);
      await admin.connect();
      await admin.createTopics({
        waitForLeaders: true,
        topics: names.map((topic) => ({
          topic,
          numPartitions: 1,
          replicationFactor: 1,
        })),
      });
      return names;
    })();
    return topics;
  };
  const options = (id: string) => ({
    client: { brokers, clientId: id, logLevel: logLevel.NOTHING },
    consumer: { groupId: id, ...kafkaTestConsumer },
    subscribe: { fromBeginning: false },
  });
  const sharedClient = (fixtures: Iterable<string>) => {
    shared ??= (async () => {
      const client = new ReadyClientKafka(options(`${run}-client`));
      for (const fixture of fixtures) {
        client.subscribeToResponseOf(pattern(fixture));
      }
      try {
        await client.connect();
      } catch (error) {
        // The next boot connects a new client instead of repeating this failure.
        shared = undefined;
        await client.close();
        throw error;
      }
      return client;
    })();
    return shared;
  };
  return {
    carriers: [kafkaCarrier()],
    handler: (_boot, fixture) => MessagePattern(pattern(fixture)),
    async server(boot, fixtures) {
      await ensureTopics(fixtures);
      const strategy = new ReadyServerKafka(options(boot));
      return {
        options: { strategy },
        ready: (timeoutMs) => strategy.ready(timeoutMs),
      };
    },
    async connect(boot) {
      const client = await sharedClient(boot.handlers.keys());
      return {
        ...proxyClient(
          client as unknown as ClientProxy,
          pattern,
          (data, headers) => ({
            value: data,
            headers: Object.fromEntries(
              [...headers].map(([name, value]) => [name, Buffer.from(value)]),
            ),
          }),
        ),
        ready: (timeoutMs) => client.ready(timeoutMs),
        // release() closes the shared client after the run.
        close: async () => undefined,
      };
    },
    async release() {
      try {
        const client = await shared?.catch(() => undefined);
        await client?.close();
      } finally {
        if (topics) {
          try {
            await admin.deleteTopics({ topics: await topics });
          } finally {
            await admin.disconnect();
          }
        }
      }
    },
  };
}

const boots = new WeakMap<object, Boot>();

/** A fixture controller: one message handler per kit fixture; the payload is the fixture's input. */
function fixtureController(
  family: RpcFamily,
  boot: string,
  handlers: Map<string, FixtureHandler>,
  explicit: boolean,
) {
  @Controller()
  class RpcFixtureController {
    constructor(
      @Inject(BetterAuthService) readonly service: BetterAuthService,
    ) {}
  }
  if (explicit) {
    // A hybrid app's microservice does not inherit the global guard (inheritAppConfig: false).
    UseBetterAuth()(RpcFixtureController);
  }
  for (const [name, fixture] of handlers) {
    const method = async function (
      this: RpcFixtureController,
      ...args: unknown[]
    ) {
      const count = fixture.params.length;
      const body = await fixture.handle(
        args.slice(0, count),
        (args[count] ?? {}) as Record<string, unknown>,
        { service: this.service },
      );
      return family.reply ? family.reply(body) : body;
    };
    Object.defineProperty(method, "name", { value: name });
    Object.defineProperty(RpcFixtureController.prototype, name, {
      value: method,
      writable: true,
      configurable: true,
    });
    const descriptor = Object.getOwnPropertyDescriptor(
      RpcFixtureController.prototype,
      name,
    )!;
    for (const [index, param] of fixture.params.entries()) {
      param(RpcFixtureController.prototype, name, index);
    }
    Payload()(RpcFixtureController.prototype, name, fixture.params.length);
    for (const decorator of [
      family.handler(boot, name),
      ...fixture.decorators,
    ].reverse()) {
      decorator(RpcFixtureController.prototype, name, descriptor);
    }
  }
  return RpcFixtureController;
}

type RpcAppOptions = Pick<
  Parameters<TransportConformanceOptions["createApp"]>[2],
  | "globalGuard"
  | "override"
  | "defaultRequirements"
  | "principals"
  | "globalScope"
  | "appEnhancers"
  | "logger"
  | "logSummary"
>;

/** Boots a microservice (hybrid: an Express app with it connected) serving `handlers` as message patterns. */
async function createRpcApp(
  family: RpcFamily,
  transport: ExtensionRef<AuthTransport>,
  handlers: Map<string, FixtureHandler>,
  auth: AuthLike,
  options: RpcAppOptions,
): Promise<INestApplication> {
  const id = `nsba-${randomUUID()}`;
  const server = await family.server(id, [...handlers.keys()]);
  @Module({
    imports: [
      BetterAuthModule.forRoot({
        auth,
        platforms: family.hybrid ? [expressPlatform()] : [],
        transports: [transport],
        globalGuard: options.globalGuard,
        principals: options.principals,
        ...(options.defaultRequirements
          ? { defaultRequirements: options.defaultRequirements }
          : {}),
        ...(options.globalScope === undefined
          ? {}
          : { globalScope: options.globalScope }),
        logSummary: options.logSummary ?? false,
      } as never),
    ],
    controllers: [
      fixtureController(
        family,
        id,
        handlers,
        !!family.hybrid && options.globalGuard,
      ),
    ],
    providers: options.appEnhancers
      ? [
          { provide: APP_GUARD, useClass: BetterAuthGuard },
          {
            provide: APP_INTERCEPTOR,
            useClass: BetterAuthScopeInterceptor,
          },
        ]
      : [],
  })
  class RpcFixtureModule {}
  let builder = Test.createTestingModule({ imports: [RpcFixtureModule] });
  if (options.override) {
    builder = options.override(builder);
  }
  const moduleRef = await builder.compile();
  const logger = options.logger ?? false;
  let app: INestApplication | INestMicroservice;
  let microservice: INestMicroservice;
  let start: () => Promise<void>;
  if (family.hybrid) {
    const http = moduleRef.createNestApplication(new ExpressAdapter(), {
      logger,
    });
    microservice = http.connectMicroservice(server.options);
    app = http;
    start = async () => {
      await http.startAllMicroservices();
    };
  } else {
    microservice = moduleRef.createNestMicroservice({
      ...server.options,
      logger,
    });
    app = microservice;
    start = async () => {
      await microservice.listen();
    };
  }
  try {
    await app.init();
  } catch (error) {
    await app.close();
    throw error;
  }
  const state: Boot["state"] = { server };
  const close = app.close.bind(app);
  app.close = async () => {
    try {
      const connected = await state.client?.catch(() => undefined);
      if (connected) {
        await within(connected.close(), "closing the client");
      }
    } finally {
      await within(close(), "closing the app");
    }
  };
  const nest = app as unknown as INestApplication;
  boots.set(nest, { id, handlers, microservice, start, state });
  return nest;
}

/** The boot's client, started with its transport server on the first invocation. */
function clientOf(
  family: RpcFamily,
  app: INestApplication,
): Promise<RpcClient> {
  const boot = boots.get(app)!;
  boot.state.client ??= (async () => {
    await within(boot.start(), "the transport server");
    const connected = await within(
      family.connect(boot),
      "the client connection",
    );
    try {
      // A broker consumer can join its group and fix its start offsets after listen() and connect() resolve.
      await Promise.all([
        boot.state.server?.ready?.(REPLY_TIMEOUT_MS),
        connected.ready?.(REPLY_TIMEOUT_MS),
      ]);
    } catch (error) {
      await connected.close();
      throw error;
    }
    return connected;
  })();
  return boot.state.client;
}

/**
 * The built-in RPC transport, exposed through a real microservice: one message pattern per fixture, credentials in the
 * family's native carrier. A boot starts its server and client on its first invocation, so boots that serve no request
 * validate without reaching a broker.
 */
function rpcHarness(family: RpcFamily): TransportConformanceOptions {
  const transport = rpcTransport(
    family.carriers ? { carriers: family.carriers } : {},
  );
  return {
    transport,
    expectCookieCapable: false,
    expectBrowserLeg: false,
    createApp: (fixtures, auth, options) =>
      createRpcApp(family, transport, flatten(fixtures), auth, options),
    async invoke(app, handler, headers, input = {}) {
      const name: string =
        handler === "triple" || handler === "tripleMixed"
          ? `${handler}0`
          : (handler satisfies FixtureName);
      return (await clientOf(family, app)).send(
        name,
        input,
        new Headers(headers),
      );
    },
  };
}

/**
 * The policy kit's delivery over the built-in RPC transport: the kit's handlers as message patterns of a real
 * microservice, credentials in the family's native carrier and the input in the payload.
 */
function rpcDelivery(name: string, family: RpcFamily): PolicyDelivery {
  const transport = rpcTransport(
    family.carriers ? { carriers: family.carriers } : {},
  );
  return {
    name,
    createApp: (handlers, auth, options) =>
      createRpcApp(family, transport, new Map(Object.entries(handlers)), auth, {
        globalGuard: true,
        ...options,
      }),
    invoke: async (app, handler, headers, input = {}) =>
      (await clientOf(family, app)).send(handler, input, new Headers(headers)),
  };
}

/**
 * Runs the kit, with the family's inapplicable cases skipped for the given reasons. Broker cases get a longer timeout:
 * each serving boot connects to the broker, and a Kafka boot waits until its consumer groups are ready.
 */
function runFamily(
  family: RpcFamily,
  options: {
    skips?: Readonly<Record<string, string>>;
    timeoutMs?: number;
  } = {},
): void {
  const skips = options.skips ?? {};
  const cases: ConformanceCase[] = transportConformance(rpcHarness(family)).map(
    (item) => (item.id in skips ? { ...item, skip: skips[item.id] } : item),
  );
  runConformance(cases, {
    describe,
    it: (name, fn) => it(name, fn, options.timeoutMs),
  });
  if (family.release) {
    afterAll(() => family.release!(), 60_000);
  }
}

describe("transport kit on the built-in RPC transport over TCP", () => {
  runFamily(tcp(false));
});

describe("transport kit on the built-in RPC transport over TCP in a hybrid app", () => {
  runFamily(tcp(true));
});

describe("transport kit on the built-in RPC transport over gRPC", () => {
  runFamily(grpc(), {
    skips: {
      "T-error-shape":
        "gRPC delivers only a status and a message (design v7 §13.3); rpc-grpc.e2e.test.ts asserts statuses 16, 7, 8 and 13",
    },
  });
});

describe("transport kit on the built-in RPC transport over NATS", () => {
  runFamily(nats(), { timeoutMs: BROKER_TIMEOUT_MS });
});

describe("transport kit on the built-in RPC transport over RabbitMQ", () => {
  runFamily(rmq(), { timeoutMs: BROKER_TIMEOUT_MS });
});

describe("transport kit on the built-in RPC transport over MQTT", () => {
  runFamily(mqtt(), { timeoutMs: BROKER_TIMEOUT_MS });
});

describe("transport kit on the built-in RPC transport over Redis", () => {
  runFamily(redis(), { timeoutMs: BROKER_TIMEOUT_MS });
});

describe("transport kit on the built-in RPC transport over Kafka", () => {
  runFamily(kafka(), { timeoutMs: BROKER_TIMEOUT_MS });
});

describe("policy kit rows over the built-in RPC transport over TCP", async () => {
  const delivery = rpcDelivery("RPC over TCP", tcp(false));
  runConformance(
    [
      ...policyDeliveryCases(await adminPolicyOptions(), delivery),
      ...policyDeliveryCases(await organizationPolicyOptions(), delivery),
    ],
    { describe, it },
  );
});

describe("policy kit rows over the built-in RPC transport over TCP in a hybrid app", async () => {
  const delivery = rpcDelivery("hybrid RPC over TCP", tcp(true));
  runConformance(
    [
      ...policyDeliveryCases(await adminPolicyOptions(), delivery),
      ...policyDeliveryCases(await organizationPolicyOptions(), delivery),
    ],
    { describe, it },
  );
});

describe("RPC policy delivery mutations", () => {
  it("fails Z-admin-rejects-api-key-session over RPC for an admin policy without fresh identity", async () => {
    const cases = policyDeliveryCases(
      await adminPolicyOptions({
        ...adminPermissionPolicy,
        requires: { ...adminPermissionPolicy.requires, freshIdentity: false },
      }),
      rpcDelivery("RPC over TCP", tcp(false)),
    );
    await expect(
      cases
        .find((item) => item.id === "Z-admin-rejects-api-key-session")!
        .run(),
    ).rejects.toThrow(/x-api-key alone on @RequirePermission.*: allowed/);
  });
});
