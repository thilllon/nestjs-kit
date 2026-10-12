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
import { CallStatistics, type CallTotals } from "./call-statistics.js";
import { createApp } from "./create-app.js";
import { ConflictError, Database } from "./database.js";
import { InventoryClient } from "./inventory.client.js";
import {
  InMemoryInventory,
  InventoryTransport,
} from "./inventory.transport.js";
import type { Order, OrderEvent } from "./order.js";
import { OrdersRepository } from "./orders.repository.js";
import { OrdersService } from "./orders.service.js";
import { TransientError } from "./retryable.js";

let app: INestApplication;
let url: string;
let database: Database;
let inventory: InMemoryInventory;

async function placeOrder(sku: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${url}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku, quantity: 2 }),
  });
  return { status: response.status, body: await response.json() };
}

async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${url}/${path}`);
  return (await response.json()) as T;
}

async function storedOrder(id: number): Promise<Order | undefined> {
  return (await read<Order[]>("orders")).find((order) => order.id === id);
}

async function eventsOf(orderId: number): Promise<string[]> {
  return (await read<OrderEvent[]>("orders/events"))
    .filter((event) => event.orderId === orderId)
    .map(({ type }) => type);
}

/** `"member: calls/errors"` for every member the statistics hold. */
async function statistics(): Promise<string[]> {
  const summary = await read<Record<string, CallTotals>>("statistics");
  return Object.entries(summary).map(
    ([member, { calls, errors }]) => `${member}: ${calls}/${errors}`,
  );
}

describe("basic example", () => {
  beforeAll(async () => {
    vi.stubEnv("RECONCILE_INTERVAL_MILLISECONDS", "20");
    app = await createApp({ logger: false });
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
    database = app.get(Database);
    inventory = app.get(InventoryTransport);
  });

  beforeEach(() => {
    // Removes the backoff of RetryAspect.
    vi.spyOn(Math, "random").mockReturnValue(0);
    app.get(CallStatistics).reset();
    database.log.splice(0);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Leaves no pending order to the reconciliation worker of a later test.
    const orders = app.get(OrdersService);
    for (const order of await orders.list()) {
      await orders.cancel(order.id);
    }
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await app.close();
  });

  it("stores the order and its event together, and confirms it with the reservation", async () => {
    const { status, body } = await placeOrder("widget");

    expect(status).toBe(201);
    expect(body).toEqual({
      id: expect.any(Number),
      sku: "widget",
      quantity: 2,
      createdAt: expect.any(Number),
      status: "confirmed",
      reservation: inventory.reservations.get(`order-${body.id}`),
    });
    expect(await storedOrder(body.id)).toEqual(body);
    expect(await eventsOf(body.id)).toEqual([
      "order.created",
      "order.confirmed",
    ]);
  });

  it("records the calls of the repositories and the client, selected without a decorator, and no other call", async () => {
    await placeOrder("widget");

    expect(await statistics()).toEqual([
      "OrdersRepository.insert: 1/0",
      "OutboxRepository.append: 2/0",
      "InventoryClient.reserve: 1/0",
      "OrdersRepository.find: 1/0",
      "OrdersRepository.save: 1/0",
    ]);
  });

  it("holds no transaction open during the call of the inventory service", async () => {
    const reserve = vi
      .spyOn(inventory, "reserve")
      .mockImplementation(async () => {
        expect(database.log).toEqual(["begin", "commit"]);
        return "reservation-during-no-transaction";
      });

    const { body } = await placeOrder("widget");

    expect(reserve).toHaveBeenCalledOnce();
    expect(body.reservation).toBe("reservation-during-no-transaction");
    expect(database.log).toEqual(["begin", "commit", "begin", "commit"]);
  });

  it("repeats a reservation whose answer is lost, with the same idempotency key, as one recorded call", async () => {
    const { status, body } = await placeOrder("flaky");

    const key = `order-${body.id}`;
    expect(status).toBe(201);
    expect(body.status).toBe("confirmed");
    expect(inventory.requests.get(key)).toBe(3);
    expect(body.reservation).toBe(inventory.reservations.get(key));
    expect(
      [...inventory.reservations.keys()].filter((entry) => entry === key),
    ).toHaveLength(1);
    expect(await statistics()).toContain("InventoryClient.reserve: 1/0");
  });

  it("waits between the attempts, up to a limit that doubles", async () => {
    vi.mocked(Math.random).mockReturnValue(1);
    const timeouts = vi.spyOn(globalThis, "setTimeout");

    await app.get(InventoryClient).reserve("backoff", "flaky", 1);

    const waits = timeouts.mock.calls
      .map(([, milliseconds]) => milliseconds)
      .filter((milliseconds) => milliseconds === 100 || milliseconds === 200);
    expect(waits).toEqual([100, 200]);
  });

  it("cancels the order when the inventory service refuses the reservation, without a second attempt", async () => {
    const { status, body } = await placeOrder("sold-out");

    const [order] = (await read<Order[]>("orders")).slice(-1);
    expect(status).toBe(409);
    expect(body.message).toBe("No stock for 2 of sold-out");
    expect(order).toMatchObject({ sku: "sold-out", status: "cancelled" });
    expect(inventory.requests.get(`order-${order.id}`)).toBe(1);
    expect(await eventsOf(order.id)).toEqual([
      "order.created",
      "order.cancelled",
    ]);
    expect(await statistics()).toContain("InventoryClient.reserve: 1/1");
  });

  it("discards the event of a change whose second write fails", async () => {
    const orders = app.get(OrdersService);
    const order = await orders.create("gadget", 1);
    database.log.splice(0);
    vi.spyOn(app.get(OrdersRepository), "save").mockRejectedValue(
      new Error("The connection is closed"),
    );

    await expect(orders.confirm(order.id, "reservation-9")).rejects.toThrow(
      "The connection is closed",
    );

    expect(database.log).toEqual(["begin", "rollback"]);
    expect(await storedOrder(order.id)).toMatchObject({ status: "pending" });
    expect(await eventsOf(order.id)).toEqual(["order.created"]);
  });

  it("repeats the change that loses a conflict in a new transaction, which sees the other change", async () => {
    const orders = app.get(OrdersService);
    const order = await orders.create("gadget", 1);
    database.log.splice(0);

    const [confirmed, cancelled] = await Promise.all([
      orders.confirm(order.id, "reservation-9"),
      orders.cancel(order.id),
    ]);

    expect(database.log).toEqual([
      "begin",
      "begin",
      "commit",
      "rollback",
      "begin",
      "commit",
    ]);
    expect(confirmed.status).toBe("confirmed");
    expect(cancelled).toEqual(confirmed);
    expect(await eventsOf(order.id)).toEqual([
      "order.created",
      "order.confirmed",
    ]);
  });

  it("gives up a transaction that keeps losing conflicts after the attempts of the annotation", async () => {
    const orders = app.get(OrdersService);
    const order = await orders.create("gadget", 1);
    const transactional = vi
      .spyOn(database, "transactional")
      .mockRejectedValue(new ConflictError("Another transaction won"));

    await expect(orders.cancel(order.id)).rejects.toThrow(
      "Another transaction won",
    );

    expect(transactional).toHaveBeenCalledTimes(3);
  });

  it("completes a pending order from the worker timer, without a request, under the same aspects", async () => {
    const reserve = vi
      .spyOn(inventory, "reserve")
      .mockRejectedValue(new TransientError("The service is unreachable"));

    const { status, body } = await placeOrder("widget");

    expect(status).toBe(201);
    expect(body.status).toBe("pending");
    expect(reserve.mock.calls.length).toBeGreaterThanOrEqual(3);

    reserve.mockRestore();
    app.get(CallStatistics).reset();
    database.log.splice(0);
    await vi.waitFor(async () => {
      expect(await storedOrder(body.id)).toMatchObject({
        status: "confirmed",
        reservation: inventory.reservations.get(`order-${body.id}`),
      });
    });

    expect(database.log).toEqual(["begin", "commit"]);
    expect(await statistics()).toEqual(
      expect.arrayContaining([
        "InventoryClient.reserve: 1/0",
        "OrdersRepository.save: 1/0",
      ]),
    );
    expect(await eventsOf(body.id)).toEqual([
      "order.created",
      "order.confirmed",
    ]);
  });

  it("reports the advice of each method in the order it runs", () => {
    const inspector = app.get(AspectInspector);
    const advisors = (type: new (...args: any[]) => unknown, name: string) =>
      inspector
        .advisorsOf(type, name)
        .map(({ type, order }) => `${order} ${type.name}`);

    expect(advisors(OrdersService, "confirm")).toEqual([
      "20 RetryAspect",
      "100 TransactionAspect",
    ]);
    expect(advisors(InventoryClient, "reserve")).toEqual([
      "10 StatisticsAspect",
      "20 RetryAspect",
    ]);
    expect(advisors(OrdersRepository, "save")).toEqual(["10 StatisticsAspect"]);
    expect(advisors(OrdersService, "list")).toEqual([]);
  });
});
