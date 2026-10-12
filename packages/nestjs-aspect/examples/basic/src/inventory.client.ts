import { Injectable } from "@nestjs/common";
import { InventoryTransport } from "./inventory.transport.js";
import { Retryable } from "./retryable.js";

/** The client of the remote inventory service. */
@Injectable()
export class InventoryClient {
  constructor(private readonly transport: InventoryTransport) {}

  /**
   * Reserves stock. The idempotency key makes the call safe to repeat: the
   * service answers a repeated key with the reservation it already made,
   * also when the answer to the first request was lost.
   */
  @Retryable({ attempts: 3, backoffMilliseconds: 100 })
  async reserve(
    idempotencyKey: string,
    sku: string,
    quantity: number,
  ): Promise<string> {
    return this.transport.reserve({ idempotencyKey, sku, quantity });
  }
}
