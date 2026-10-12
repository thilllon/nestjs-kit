import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { AspectInspector } from "nestjs-aspect";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CallTrace } from "./call-trace.js";
import { createApp } from "./create-app.js";
import { Database } from "./database.js";
import { InventoryClient } from "./inventory.client.js";
import type { Order } from "./order.js";
import { OrdersRepository } from "./orders.repository.js";
import { OrdersService } from "./orders.service.js";

let app: INestApplication | undefined;
let url: string;

async function placeOrder(sku: string) {
  const response = await fetch(`${url}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku, quantity: 2 }),
  });
  return { status: response.status, body: await response.json() };
}

async function storedOrders(): Promise<Order[]> {
  const response = await fetch(`${url}/orders`);
  return (await response.json()) as Order[];
}

async function callTrace(): Promise<string[]> {
  const response = await fetch(`${url}/trace`);
  const entries = (await response.json()) as {
    event: string;
    member: string;
    error?: string;
  }[];
  return entries.map(({ event, member, error }) =>
    [event, member, error].filter(Boolean).join(" "),
  );
}

describe("basic example", () => {
  beforeAll(async () => {
    app = await createApp({ logger: false });
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  });

  beforeEach(() => {
    app?.get(CallTrace).entries.splice(0);
    app?.get(Database).log.splice(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("traces the calls between the providers of the orders module and leaves the route handlers out", async () => {
    const order = await placeOrder("widget");

    expect(order).toEqual({
      status: 201,
      body: {
        id: expect.any(Number),
        sku: "widget",
        quantity: 2,
        reservation: "reservation-widget-2",
      },
    });
    const trace = await callTrace();
    expect(trace).toEqual([
      "call OrdersService.place",
      "call InventoryClient.reserve",
      "return InventoryClient.reserve",
      "call OrdersService.store",
      "call OrdersRepository.insert",
      "return OrdersRepository.insert",
      "call OrdersRepository.confirm",
      "return OrdersRepository.confirm",
      "return OrdersService.store",
      "return OrdersService.place",
    ]);
    expect(await callTrace()).toEqual(trace);
  });

  it("runs the self-invoked transactional method in one transaction that begins after the reservation", async () => {
    const database = app?.get(Database);
    const inventory = app?.get(InventoryClient) as InventoryClient;
    const reserve = vi
      .spyOn(inventory, "reserve")
      .mockImplementation(async (sku, quantity) => {
        expect(database?.log).toEqual([]);
        return `reservation-${sku}-${quantity}`;
      });

    const { body } = await placeOrder("widget");

    expect(reserve).toHaveBeenCalledOnce();
    expect(database?.log).toEqual(["begin", "commit"]);
    expect(await storedOrders()).toContainEqual(body);
  });

  it("retries a transient inventory failure inside one traced call, outside the transaction", async () => {
    const order = await placeOrder("flaky");

    expect(order.status).toBe(201);
    expect(app?.get(InventoryClient).attempts.get("flaky")).toBe(3);
    expect(app?.get(Database).log).toEqual(["begin", "commit"]);
    expect(
      (await callTrace()).filter((entry) => entry.includes("reserve")),
    ).toEqual([
      "call InventoryClient.reserve",
      "return InventoryClient.reserve",
    ]);
  });

  it("begins no transaction when the reservation fails after the annotated number of attempts", async () => {
    const order = await placeOrder("offline");

    expect(order.status).toBe(503);
    expect(app?.get(InventoryClient).attempts.get("offline")).toBe(3);
    expect(app?.get(Database).log).toEqual([]);
    expect(await callTrace()).toEqual([
      "call OrdersService.place",
      "call InventoryClient.reserve",
      "error InventoryClient.reserve TransientError",
      "error OrdersService.place ServiceUnavailableException",
    ]);
    expect(
      (await storedOrders()).filter(({ sku }) => sku === "offline"),
    ).toEqual([]);
  });

  it("rolls back the stored order when the second write of the transaction fails", async () => {
    const repository = app?.get(OrdersRepository) as OrdersRepository;
    vi.spyOn(repository, "confirm").mockRejectedValue(
      new Error("The connection is closed"),
    );

    const order = await placeOrder("gadget");

    expect(order.status).toBe(500);
    expect(app?.get(Database).log).toEqual(["begin", "rollback"]);
    expect((await callTrace()).slice(-2)).toEqual([
      "error OrdersService.store Error",
      "error OrdersService.place Error",
    ]);
    expect(
      (await storedOrders()).filter(({ sku }) => sku === "gadget"),
    ).toEqual([]);
  });

  it("advises a provider method that is called without a request", async () => {
    const order = await app?.get(OrdersService).place("widget", 1);

    expect(order?.reservation).toBe("reservation-widget-1");
    expect(app?.get(Database).log).toEqual(["begin", "commit"]);
    expect(app?.get(CallTrace).entries.at(0)).toEqual({
      event: "call",
      member: "OrdersService.place",
    });
  });

  it("reports the advice of the transactional and the retried method in the order it runs", () => {
    const inspector = app?.get(AspectInspector);
    const advisors = (
      type: typeof OrdersService | typeof InventoryClient,
      name: string,
    ) =>
      inspector
        ?.advisorsOf(type, name)
        .map(({ type, kind }) => `${type.name} ${kind}`);
    const traced = [
      "CallTraceAspect before",
      "CallTraceAspect afterReturning",
      "CallTraceAspect afterThrowing",
    ];

    expect(advisors(OrdersService, "place")).toEqual(traced);
    expect(advisors(OrdersService, "store")).toEqual([
      ...traced,
      "TransactionAspect around",
    ]);
    expect(advisors(InventoryClient, "reserve")).toEqual([
      ...traced,
      "RetryAspect around",
    ]);
  });
});
