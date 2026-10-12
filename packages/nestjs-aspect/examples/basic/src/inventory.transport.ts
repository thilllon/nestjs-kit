import { Injectable } from "@nestjs/common";
import { TransientError } from "./retryable.js";

/** The remote inventory service has no stock for the request. */
export class OutOfStockError extends Error {}

/**
 * What `InventoryClient` sends its requests through. `reserve` rejects with
 * a `TransientError` when no answer arrives, and with an `OutOfStockError`
 * when the service refuses the reservation.
 */
export abstract class InventoryTransport {
  abstract reserve(request: {
    idempotencyKey: string;
    sku: string;
    quantity: number;
  }): Promise<string>;
}

/**
 * Stands in for the remote inventory service. It keeps one reservation per
 * idempotency key: a request that repeats a key gets the reservation of the
 * first one. The SKU selects the behavior:
 *
 * - `flaky`: the service stores the reservation, and the answers to the
 *   first two requests of a key are lost;
 * - `offline`: no request is answered;
 * - `sold-out`: the service refuses the reservation;
 * - any other SKU: the reservation succeeds.
 */
@Injectable()
export class InMemoryInventory extends InventoryTransport {
  /** The reservation of each idempotency key. */
  readonly reservations = new Map<string, string>();

  /** Number of requests per idempotency key, repeated ones included. */
  readonly requests = new Map<string, number>();

  async reserve(request: {
    idempotencyKey: string;
    sku: string;
    quantity: number;
  }): Promise<string> {
    const { idempotencyKey, sku, quantity } = request;
    const count = (this.requests.get(idempotencyKey) ?? 0) + 1;
    this.requests.set(idempotencyKey, count);
    if (sku === "offline") {
      throw new TransientError(`The inventory service is unreachable`);
    }
    if (sku === "sold-out") {
      throw new OutOfStockError(`No stock for ${quantity} of ${sku}`);
    }
    if (!this.reservations.has(idempotencyKey)) {
      const number = this.reservations.size + 1;
      this.reservations.set(idempotencyKey, `reservation-${number}`);
    }
    if (sku === "flaky" && count <= 2) {
      throw new TransientError(`The answer of the inventory service is lost`);
    }
    return this.reservations.get(idempotencyKey) as string;
  }
}
