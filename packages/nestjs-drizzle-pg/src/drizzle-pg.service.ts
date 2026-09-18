import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Client, Pool } from "pg";

@Injectable()
export class DrizzlePgService implements OnModuleDestroy {
  private closePromise?: Promise<void>;

  constructor(private readonly connection: Pool | Client) {}

  async ping(): Promise<boolean> {
    try {
      const result = await this.connection.query("SELECT 1");
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  onModuleDestroy(): Promise<void> {
    this.closePromise ??= Promise.resolve()
      .then(() => this.connection.end())
      .catch((error: unknown) => {
        this.closePromise = undefined;
        throw error;
      });
    return this.closePromise;
  }
}
