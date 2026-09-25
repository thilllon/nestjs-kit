import type { INestApplication, NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { betterAuthCorsOrigin } from "nestjs-slightly-better-auth";
import { AppModule } from "./app.module.js";
import { auth } from "./auth.js";

export async function createApp(
  options?: NestApplicationOptions,
): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(),
    options,
  );
  // Browsers on the default instance's trusted origins may send credentials.
  app.enableCors({ origin: betterAuthCorsOrigin(auth), credentials: true });
  app.enableShutdownHooks();
  return app;
}
