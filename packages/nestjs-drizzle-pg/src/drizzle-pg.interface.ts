import type { DrizzleConfig } from "drizzle-orm";
import type { ClientConfig, PoolConfig } from "pg";
import { DrizzlePgService } from "./drizzle-pg.service";

export interface DrizzlePgModuleOptions {
  drizzleConfig?: DrizzleConfig<Record<string, unknown>>;
  pgConfig?:
    | { type: "pool"; config: PoolConfig }
    | { type: "client"; config: ClientConfig };
}

export type DrizzlePgModuleExtras = {
  alias?: string;
  isGlobal?: boolean;
};

export const defaultTokenAlias = "default";

export const getDrizzlePgToken = (name = defaultTokenAlias): string =>
  `DRIZZLE_PG_${name || defaultTokenAlias}`;

export const getPgConnectionToken = (name = defaultTokenAlias): string =>
  `DRIZZLE_PG_CONNECTION_${name || defaultTokenAlias}`;

export const getDrizzlePgServiceToken = (
  name = defaultTokenAlias,
): string | typeof DrizzlePgService =>
  !name || name === defaultTokenAlias
    ? DrizzlePgService
    : `DRIZZLE_PG_SERVICE_${name}`;
