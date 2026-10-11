import { Injectable } from "@nestjs/common";
import { Retryable, TransientError } from "./retryable.js";

/**
 * Stands in for a remote inventory service. The SKU selects the behavior:
 * `flaky` fails twice before each success, `offline` fails every time and
 * every other SKU succeeds.
 */
@Injectable()
export class InventoryClient {
  /** Number of calls of `reserve` per SKU, retries included. */
  readonly attempts = new Map<string, number>();

  @Retryable({ attempts: 3 })
  async reserve(sku: string, quantity: number): Promise<string> {
    const attempt = (this.attempts.get(sku) ?? 0) + 1;
    this.attempts.set(sku, attempt);
    if (sku === "offline" || (sku === "flaky" && attempt % 3 !== 0)) {
      throw new TransientError(
        `The inventory service did not answer for ${sku}`,
      );
    }
    return `reservation-${sku}-${quantity}`;
  }
}
