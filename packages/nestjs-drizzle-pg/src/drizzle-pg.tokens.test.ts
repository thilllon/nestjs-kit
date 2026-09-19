import { Inject, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import {
  DrizzlePgModule,
  DrizzlePgService,
  getDrizzlePgToken,
  getDrizzlePgServiceToken,
  getPgConnectionToken,
} from "./index";

it.each([false, true])(
  "isolates real pools and databases for adversarial aliases (reverse=%s)",
  async (reverse) => {
    const aliases = [
      "default",
      "primary",
      "CONNECTION_primary",
      "SERVICE_primary",
      "CONNECTION_default",
      "SERVICE_default",
      "connection:primary",
      "database:default",
      "service:primary",
      "default:",
      "DEFAULT",
      "database_primary",
      "connection_primary",
      "service_default",
    ];
    @Injectable()
    class Consumer {
      readonly values: unknown[];
      constructor(...values: unknown[]) {
        this.values = values;
      }
    }
    for (const [index, alias] of aliases.entries()) {
      Inject(getDrizzlePgToken(alias))(Consumer, undefined, index * 3);
      Inject(getPgConnectionToken(alias))(Consumer, undefined, index * 3 + 1);
      Inject(getDrizzlePgServiceToken(alias))(
        Consumer,
        undefined,
        index * 3 + 2,
      );
    }
    const registrations = aliases.map((alias, index) => {
      const options = {
        pgConfig: {
          type: "pool" as const,
          config: { application_name: alias },
        },
      };
      return index % 2
        ? DrizzlePgModule.registerAsync({
            alias,
            useFactory: async () => options,
          })
        : DrizzlePgModule.register({ ...options, alias });
    });
    if (reverse) {
      registrations.reverse();
    }
    const app = await Test.createTestingModule({
      imports: registrations,
      providers: [Consumer],
    }).compile();
    const closing: ReturnType<typeof vi.spyOn>[] = [];
    try {
      const values = app.get(Consumer).values;
      expect(new Set(values).size).toBe(aliases.length * 3);
      for (const [index, alias] of aliases.entries()) {
        const db = values[index * 3] as NodePgDatabase & { $client: Pool };
        const pool = values[index * 3 + 1] as Pool;
        const service = values[index * 3 + 2] as DrizzlePgService;
        expect(pool).toBeInstanceOf(Pool);
        expect(pool.options.application_name).toBe(alias);
        expect(db.$client).toBe(pool);
        expect(service).toBeInstanceOf(DrizzlePgService);
        closing.push(vi.spyOn(pool, "end"));
        if (alias === "CONNECTION_primary") {
          await service.onModuleDestroy();
          expect(pool.ended).toBe(true);
        }
      }
    } finally {
      await app.close();
    }
    for (const close of closing) {
      expect(close).toHaveBeenCalledOnce();
    }
  },
);
