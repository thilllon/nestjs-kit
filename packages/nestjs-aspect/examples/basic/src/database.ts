import { AsyncLocalStorage } from "node:async_hooks";
import { Injectable } from "@nestjs/common";
import { TransientError } from "./retryable.js";

/** A transaction read a row that another transaction changed before it. */
export class ConflictError extends TransientError {}

interface Row {
  value: unknown;
  version: number;
}

interface Transaction {
  /** The version of each row the transaction has read. */
  reads: Map<string, number>;
  writes: Map<string, unknown>;
}

/**
 * Stands in for a database client with serializable transactions. A
 * transaction collects its writes and applies them when it commits, unless
 * a row it has read has changed since: the commit then fails with a
 * `ConflictError`. An `AsyncLocalStorage` carries the transaction to every
 * call the transactional work makes, so no method passes it along.
 */
@Injectable()
export class Database {
  private readonly rows = new Map<string, Row>();

  private readonly sequences = new Map<string, number>();

  private readonly active = new AsyncLocalStorage<Transaction>();

  /** `"begin"`, `"commit"` and `"rollback"`, in the order they happen. */
  readonly log: string[] = [];

  /** The next number of a sequence; like a database sequence, it never rolls back. */
  nextId(sequence: string): number {
    const id = (this.sequences.get(sequence) ?? 0) + 1;
    this.sequences.set(sequence, id);
    return id;
  }

  get<T>(key: string): T | undefined {
    const transaction = this.active.getStore();
    if (transaction?.writes.has(key)) {
      return transaction.writes.get(key) as T;
    }
    const row = this.rows.get(key);
    if (transaction && !transaction.reads.has(key)) {
      transaction.reads.set(key, row?.version ?? 0);
    }
    return row?.value as T | undefined;
  }

  /** The rows whose key starts with `prefix`, in insertion order. */
  list<T>(prefix: string): T[] {
    const written = this.active.getStore()?.writes.keys() ?? [];
    return [...new Set([...this.rows.keys(), ...written])]
      .filter((key) => key.startsWith(prefix))
      .map((key) => this.get<T>(key))
      .filter((value) => value !== undefined);
  }

  set(key: string, value: unknown): void {
    const transaction = this.active.getStore();
    if (transaction) {
      transaction.writes.set(key, value);
    } else {
      this.apply(key, value);
    }
  }

  /**
   * Runs `work` in a transaction: the active one when there is one, a new
   * one otherwise. A new transaction commits when `work` resolves and
   * discards its writes when `work` rejects or the commit finds a conflict.
   */
  async transactional<T>(work: () => Promise<T>): Promise<T> {
    if (this.active.getStore()) {
      return work();
    }
    const transaction: Transaction = { reads: new Map(), writes: new Map() };
    this.log.push("begin");
    try {
      const result = await this.active.run(transaction, work);
      for (const [key, version] of transaction.reads) {
        if ((this.rows.get(key)?.version ?? 0) !== version) {
          throw new ConflictError(`Another transaction changed ${key}`);
        }
      }
      for (const [key, value] of transaction.writes) {
        this.apply(key, value);
      }
      this.log.push("commit");
      return result;
    } catch (error) {
      this.log.push("rollback");
      throw error;
    }
  }

  private apply(key: string, value: unknown): void {
    const version = (this.rows.get(key)?.version ?? 0) + 1;
    this.rows.set(key, { value, version });
  }
}
