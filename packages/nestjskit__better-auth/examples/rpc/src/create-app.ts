import type { INestApplication, NestApplicationOptions } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { type MicroserviceOptions, Transport } from "@nestjs/microservices";
import { ExpressAdapter } from "@nestjs/platform-express";
import { AppModule } from "./app.module.js";

export interface RpcAddress {
  host: string;
  port: number;
}

/**
 * Creates a hybrid application: the HTTP server serves Better Auth's routes,
 * and the connected TCP microservice serves the message handlers.
 */
export async function createApp(
  rpc: RpcAddress,
  options?: NestApplicationOptions,
): Promise<INestApplication> {
  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(),
    options,
  );
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: rpc,
  });
  app.enableShutdownHooks();
  return app;
}
