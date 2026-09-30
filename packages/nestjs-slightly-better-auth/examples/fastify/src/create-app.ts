import type { INestApplication, NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import { betterAuthCorsOrigin } from "nestjs-slightly-better-auth";
import { AppModule } from "./app.module.js";
import { auth } from "./auth.js";

export async function createApp(
  options?: NestApplicationOptions,
): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule,
    new FastifyAdapter(),
    options,
  );
  // Browsers on the default instance's trusted origins may send credentials.
  app.enableCors({ origin: betterAuthCorsOrigin(auth), credentials: true });
  app.enableShutdownHooks();
  return app;
}
