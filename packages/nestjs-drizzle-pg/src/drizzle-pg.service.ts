import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Client, Pool } from "pg";
import { getPgConnectionToken } from "./drizzle-pg.interface";

@Injectable()
export class DrizzlePgService implements OnModuleDestroy {
  constructor(
    @Inject(getPgConnectionToken()) private readonly connection: Pool | Client,
  ) {}

  async ping(): Promise<boolean> {
    try {
      const result = await this.connection.query("SELECT 1");
      return result.rowCount === 1;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection.end();
  }
}
