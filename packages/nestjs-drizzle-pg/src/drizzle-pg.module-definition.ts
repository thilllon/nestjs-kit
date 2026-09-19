import { DrizzlePgService } from "./drizzle-pg.service";
import { ConfigurableModuleBuilder } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client, Pool } from "pg";
import {
  defaultTokenAlias,
  type DrizzlePgModuleExtras,
  type DrizzlePgModuleOptions,
  getDrizzlePgToken,
  getDrizzlePgServiceToken,
  getPgConnectionToken,
} from "./drizzle-pg.interface";

const {
  ConfigurableModuleClass,
  MODULE_OPTIONS_TOKEN: moduleOptionsToken,
  ASYNC_OPTIONS_TYPE,
  OPTIONS_TYPE,
} = new ConfigurableModuleBuilder<DrizzlePgModuleOptions>()
  .setExtras<DrizzlePgModuleExtras>(
    { alias: defaultTokenAlias, isGlobal: false },
    (definition, extras) => {
      const connectionToken = getPgConnectionToken(extras.alias);
      const drizzleToken = getDrizzlePgToken(extras.alias);
      const serviceToken = getDrizzlePgServiceToken(extras.alias);

      definition.providers ??= [];
      definition.exports ??= [];

      definition.providers.push(
        {
          provide: connectionToken,
          inject: [getDrizzlePgOptionsToken()],
          useFactory: async (options: DrizzlePgModuleOptions) => {
            if (options.pgConfig?.type === "pool") {
              return new Pool(options.pgConfig.config);
            }
            const client = new Client(options.pgConfig?.config);
            try {
              await client.connect();
            } catch (error) {
              await client.end().catch(() => undefined);
              throw error;
            }
            return client;
          },
        },
        {
          provide: drizzleToken,
          inject: [getDrizzlePgOptionsToken(), connectionToken],
          useFactory: (
            options: DrizzlePgModuleOptions,
            connection: Pool | Client,
          ): NodePgDatabase<Record<string, unknown>> => {
            return drizzle(connection, options.drizzleConfig ?? {});
          },
        },
      );

      definition.providers.push({
        provide: serviceToken,
        inject: [connectionToken],
        useFactory: (connection: Pool | Client) =>
          new DrizzlePgService(connection),
      });
      definition.exports.push(connectionToken, drizzleToken, serviceToken);

      definition.global = extras.isGlobal;

      return definition;
    },
  )
  .build();

export { ConfigurableModuleClass, OPTIONS_TYPE, ASYNC_OPTIONS_TYPE };

export function getDrizzlePgOptionsToken(): string | symbol {
  return moduleOptionsToken;
}
