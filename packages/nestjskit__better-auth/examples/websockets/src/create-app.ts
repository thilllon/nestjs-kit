import type { INestApplication, NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { AppModule } from "./app.module.js";

export async function createApp(
  options?: NestApplicationOptions,
): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(),
    options,
  );
  // Socket.IO shares the HTTP server that serves Better Auth's routes.
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();
  return app;
}
