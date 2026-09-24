import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { Metadata } from "@grpc/grpc-js";
import { headers as natsHeaders } from "@nats-io/transport-node";
import {
  KafkaContext,
  MqttContext,
  NatsContext,
  RmqContext,
  TcpContext,
} from "@nestjs/microservices";
import { describe, expect, it, vi } from "vitest";
import type { AuthTransport } from "./auth-contracts.js";
import { AuthFailures, isAuthFailure } from "./auth-errors.js";
import {
  defaultCarriers,
  grpcCarrier,
  kafkaCarrier,
  mqttCarrier,
  natsCarrier,
  payloadCarrier,
  rmqCarrier,
  rpcTransport,
} from "./microservices.js";

function context(data: unknown, carrier: unknown) {
  const context = new ExecutionContextHost([data, carrier]);
  context.setType("rpc");
  return context;
}

describe("RPC carriers", () => {
  it.each([
    "secret\r\ninjected",
    "\nsecret",
    "secret\0suffix",
    "secret\u0100",
    Buffer.from("secret\n"),
    ["valid", "secret\r"],
    [Buffer.from("secret\n")],
    [],
    null,
    {},
    42,
  ])(
    "rejects malformed credential values without retaining conversion errors (%#)",
    (cookie) => {
      const selected = payloadCarrier();
      let failure: unknown;
      try {
        selected.headers(
          context({ auth: { cookie, authorization: "Bearer valid" } }, {}),
        );
      } catch (error) {
        failure = error;
      }
      expect(isAuthFailure(failure)).toBe(true);
      expect(failure).toMatchObject({
        status: 401,
        reason: "MALFORMED_CREDENTIALS",
      });
      expect(JSON.stringify(failure)).not.toContain("secret");
      expect(failure).not.toHaveProperty("cause");
      expect(failure).not.toHaveProperty("stack");
    },
  );

  it("sanitizes invalid allowlisted names and raw custom HeadersInit conversion failures", () => {
    const carrier = kafkaCarrier({ headers: ["invalid\nname"] });
    const ctx = context(
      {},
      { getMessage: () => ({ headers: { "invalid\nname": "secret" } }) },
    );
    let failure: unknown;
    try {
      carrier.headers(ctx);
    } catch (error) {
      failure = error;
    }
    expect(isAuthFailure(failure)).toBe(true);
    expect(JSON.stringify(failure)).not.toContain("secret");
    const fallback = vi.fn(() => ({ cookie: "valid" }));
    const transport = rpcTransport({
      carriers: [
        {
          id: "raw",
          matches: () => true,
          headers: () => [["cookie", "secret\ninvalid"]],
        },
        { id: "fallback", matches: () => true, headers: fallback },
      ],
    }) as AuthTransport;
    failure = undefined;
    try {
      transport.describe(ctx, { http: null }).headers();
    } catch (error) {
      failure = error;
    }
    expect(isAuthFailure(failure)).toBe(true);
    expect(JSON.stringify(failure)).not.toContain("secret");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("extracts only normalized allowed credential fields across native context shapes", () => {
    const values = {
      Authorization: "Bearer token",
      COOKIE: "session=signed",
      "x-api-key": "key",
      host: "evil.test",
      "x-forwarded-host": "evil.test",
      "set-cookie": "leak",
      origin: "evil.test",
    };
    const metadata = new Metadata();
    const nats = natsHeaders();
    for (const [key, value] of Object.entries(values)) {
      metadata.set(key, value);
      nats.set(key, value);
    }
    const cases = [
      [grpcCarrier(), context({}, metadata)],
      [natsCarrier(), context({}, new NatsContext(["topic", nats]))],
      [
        kafkaCarrier(),
        context(
          {},
          new KafkaContext([
            {
              headers: Object.fromEntries(
                Object.entries(values).map(([key, value]) => [
                  key,
                  Buffer.from(value),
                ]),
              ),
            },
            0,
            "topic",
            {},
            async () => {},
            {},
          ] as unknown as ConstructorParameters<typeof KafkaContext>[0]),
        ),
      ],
      [
        rmqCarrier(),
        context(
          {},
          new RmqContext([{ properties: { headers: values } }, {}, "topic"]),
        ),
      ],
      [
        mqttCarrier(),
        context(
          {},
          new MqttContext([
            "topic",
            { properties: { userProperties: values } },
          ]),
        ),
      ],
      [
        payloadCarrier(),
        context(
          { auth: values },
          new TcpContext([{}, "topic"] as ConstructorParameters<
            typeof TcpContext
          >[0]),
        ),
      ],
    ] as const;
    for (const [carrier, ctx] of cases) {
      expect(carrier.matches(ctx), carrier.id).toBe(true);
      expect(
        Object.fromEntries(new Headers(carrier.headers(ctx))),
        carrier.id,
      ).toEqual({
        authorization: "Bearer token",
        cookie: "session=signed",
        "x-api-key": "key",
      });
    }
    expect(defaultCarriers.map(({ id }) => id)).toEqual([
      "grpc",
      "nats",
      "kafka",
      "rmq",
      "mqtt",
      "payload",
    ]);
  });

  it("permits explicit case-insensitive allowlists while keeping hostless metadata excluded", () => {
    const metadata = new Metadata();
    metadata.set("x-custom", "accepted");
    metadata.set("host", "evil");
    metadata.set("cookie", "ignored");
    expect(
      Object.fromEntries(
        new Headers(
          grpcCarrier({ metadata: ["X-CUSTOM", "HOST"] }).headers(
            context({}, metadata),
          ),
        ),
      ),
    ).toEqual({ "x-custom": "accepted" });
    expect(
      payloadCarrier({ field: "credentials" }).matches(
        context({ credentials: {} }, {}),
      ),
    ).toBe(true);
  });

  it.each([
    null,
    3,
    "plain",
    [],
    {},
    { auth: null },
    { auth: [] },
    Object.create({ auth: { cookie: "inherited" } }),
  ])(
    "treats unsafe or absent payload envelopes as missing credentials",
    (data) => {
      expect(payloadCarrier().matches(context(data, {}))).toBe(false);
    },
  );

  it("defers carrier selection and extraction, uses first match, and suppresses refresh", () => {
    const extract = vi.fn(() => ({ cookie: "first" }));
    const matches = vi.fn(() => true);
    const later = vi.fn(() => ({ cookie: "second" }));
    const transport = rpcTransport({
      carriers: [
        { id: "first", matches, headers: extract },
        { id: "later", matches, headers: later },
      ],
    }) as AuthTransport;
    const ctx = context({ value: 3 }, {});
    expect(transport.handles(ctx)).toBe(true);
    const call = transport.describe(ctx, { http: null });
    expect(matches).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(call.key).toBe(ctx.switchToRpc().getContext());
    expect(call.cookies).toBeNull();
    expect(call.clientIp).toBeNull();
    expect(call.browser).toBeUndefined();
    expect(call.param("value")).toBe(3);
    expect(call.headers().get("cookie")).toBe("first");
    expect(later).not.toHaveBeenCalled();
    const empty = rpcTransport({ carriers: [] }) as AuthTransport;
    expect(empty.handles(ctx)).toBe(true);
    expect([...empty.describe(ctx, { http: null }).headers()]).toEqual([]);
    expect(
      empty.toException(AuthFailures.unauthenticated(), ctx),
    ).toMatchObject({ message: "Unauthorized" });
  });
});
