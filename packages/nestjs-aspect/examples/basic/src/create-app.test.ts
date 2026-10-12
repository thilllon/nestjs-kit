import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { AspectInspector } from "nestjs-aspect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "./audit-log.js";
import { createApp } from "./create-app.js";
import { Database } from "./database.js";
import { InventoryClient } from "./inventory.client.js";
import type { Order } from "./order.js";
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

async function auditTrail(): Promise<string[]> {
  const response = await fetch(`${url}/audit`);
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
    app?.get(AuditLog).entries.splice(0);
    app?.get(Database).log.splice(0);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("audits the calls between the providers of the orders module and leaves the route handlers out", async () => {
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
    expect(await auditTrail()).toEqual([
      "call OrdersService.place",
      "call OrdersRepository.insert",
      "return OrdersRepository.insert",
      "call InventoryClient.reserve",
      "return InventoryClient.reserve",
      "call OrdersRepository.confirm",
      "return OrdersRepository.confirm",
      "return OrdersService.place",
    ]);
  });

  it("commits the order of a service method in one transaction", async () => {
    const { body } = await placeOrder("widget");

    expect(app?.get(Database).log).toEqual(["begin", "commit"]);
    expect(await storedOrders()).toContainEqual(body);
  });

  it("retries a transient inventory failure inside one audited call and one transaction", async () => {
    const order = await placeOrder("flaky");

    expect(order.status).toBe(201);
    expect(app?.get(InventoryClient).attempts.get("flaky")).toBe(3);
    expect(app?.get(Database).log).toEqual(["begin", "commit"]);
    expect(
      (await auditTrail()).filter((entry) => entry.includes("reserve")),
    ).toEqual([
      "call InventoryClient.reserve",
      "return InventoryClient.reserve",
    ]);
  });

  it("rolls back the stored order when the reservation fails after the annotated number of attempts", async () => {
    const order = await placeOrder("offline");

    expect(order.status).toBe(503);
    expect(app?.get(InventoryClient).attempts.get("offline")).toBe(3);
    expect(app?.get(Database).log).toEqual(["begin", "rollback"]);
    expect(await auditTrail()).toEqual([
      "call OrdersService.place",
      "call OrdersRepository.insert",
      "return OrdersRepository.insert",
      "call InventoryClient.reserve",
      "error InventoryClient.reserve TransientError",
      "error OrdersService.place ServiceUnavailableException",
    ]);
    expect(
      (await storedOrders()).filter(({ sku }) => sku === "offline"),
    ).toEqual([]);
  });

  it("advises a provider method that is called without a request", async () => {
    const order = await app?.get(OrdersService).place("widget", 1);

    expect(order?.reservation).toBe("reservation-widget-1");
    expect(app?.get(Database).log).toEqual(["begin", "commit"]);
    expect(app?.get(AuditLog).entries.at(0)).toEqual({
      event: "call",
      member: "OrdersService.place",
    });
  });

  it("reports the advice of the transactional and the retried method in the order it runs", () => {
    const inspector = app?.get(AspectInspector);
    const advisors = (type: typeof OrdersService | typeof InventoryClient) =>
      inspector
        ?.advisorsOf(type, type === OrdersService ? "place" : "reserve")
        .map(({ type, kind }) => `${type.name} ${kind}`);

    expect(advisors(OrdersService)).toEqual([
      "AuditAspect before",
      "AuditAspect afterReturning",
      "AuditAspect afterThrowing",
      "TransactionAspect around",
    ]);
    expect(advisors(InventoryClient)).toEqual([
      "AuditAspect before",
      "AuditAspect afterReturning",
      "AuditAspect afterThrowing",
      "RetryAspect around",
    ]);
  });
});
