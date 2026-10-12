import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import type { Order } from "./order.js";

/**
 * Stands in for a database client. A transaction collects its writes and
 * applies them when it commits; an `AsyncLocalStorage` carries it to every
 * call the transactional work makes, so no method passes it along.
 */
@Injectable()
export class Database {
  private readonly committed = new Map<number, Order>();

  private readonly transaction = new AsyncLocalStorage<Map<number, Order>>();

  /** `"begin"`, `"commit"` and `"rollback"`, in the order they happen. */
  readonly log: string[] = [];

  /** The orders the caller sees: the committed ones and its own writes. */
  orders(): Order[] {
    const writes = this.transaction.getStore() ?? [];
    return [...new Map([...this.committed, ...writes]).values()];
  }

  write(order: Order): void {
    (this.transaction.getStore() ?? this.committed).set(order.id, order);
  }

  /**
   * Runs `work` in a transaction: the active one when there is one, a new
   * one otherwise. A new transaction commits when `work` resolves and
   * discards its writes when `work` rejects.
   */
  async transactional<T>(work: () => Promise<T>): Promise<T> {
    if (this.transaction.getStore()) {
      return work();
    }
    const writes = new Map<number, Order>();
    this.log.push("begin");
    try {
      const result = await this.transaction.run(writes, work);
      for (const [id, order] of writes) {
        this.committed.set(id, order);
      }
      this.log.push("commit");
      return result;
    } catch (error) {
      this.log.push("rollback");
      throw error;
    }
  }
}
