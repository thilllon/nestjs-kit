import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { AspectInspector } from "nestjs-aspect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "./audit-log.js";
import { createApp } from "./create-app.js";
import { InventoryClient } from "./inventory.client.js";

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
  });

  afterAll(async () => {
    await app?.close();
  });

  it("audits every call into the orders module, from the route handler to the inventory client", async () => {
    expect(await placeOrder("widget")).toEqual({
      status: 201,
      body: {
        id: 1,
        sku: "widget",
        quantity: 2,
        reservation: "reservation-widget-2",
      },
    });

    expect(await auditTrail()).toEqual([
      "call OrdersController.create",
      "call OrdersService.place",
      "call InventoryClient.reserve",
      "return InventoryClient.reserve",
      "return OrdersService.place",
      "return OrdersController.create",
    ]);
  });

  it("retries a transient inventory failure inside one audited call", async () => {
    const order = await placeOrder("flaky");

    expect(order.status).toBe(201);
    expect(app?.get(InventoryClient).attempts.get("flaky")).toBe(3);
    expect(
      (await auditTrail()).filter((entry) => entry.includes("reserve")),
    ).toEqual([
      "call InventoryClient.reserve",
      "return InventoryClient.reserve",
    ]);
  });

  it("stops after the annotated number of attempts and audits the error of each layer", async () => {
    const order = await placeOrder("offline");

    expect(order.status).toBe(503);
    expect(app?.get(InventoryClient).attempts.get("offline")).toBe(3);
    expect(await auditTrail()).toEqual([
      "call OrdersController.create",
      "call OrdersService.place",
      "call InventoryClient.reserve",
      "error InventoryClient.reserve TransientError",
      "error OrdersService.place ServiceUnavailableException",
      "error OrdersController.create ServiceUnavailableException",
    ]);
  });

  it("leaves the audit route outside the orders module unadvised", async () => {
    await auditTrail();

    expect(await auditTrail()).toEqual([]);
  });

  it("reports the advice of the retried method in the order it runs", () => {
    const advisors = app
      ?.get(AspectInspector)
      .advisorsOf(InventoryClient, "reserve")
      .map(({ type, kind }) => `${type.name} ${kind}`);

    expect(advisors).toEqual([
      "AuditAspect before",
      "AuditAspect afterReturning",
      "AuditAspect afterThrowing",
      "RetryAspect around",
    ]);
  });
});
