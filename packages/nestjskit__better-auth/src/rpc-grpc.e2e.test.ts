import { fileURLToPath } from "node:url";
import {
  Client,
  credentials,
  loadPackageDefinition,
  Metadata,
  Server,
  ServerCredentials,
  type ServiceError,
  type ClientUnaryCall,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { Controller, Logger, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { GrpcMethod, ServerGrpc } from "@nestjs/microservices";
import { APIError } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { describe, expect, it, vi } from "vitest";
import { Public, Require, UseBetterAuth } from "./auth-decorators.js";
import { BetterAuthModule } from "./auth-module.js";
import { expressPlatform } from "./express.js";
import { rpcTransport } from "./microservices.js";
import { CurrentUser } from "./session-principal.js";
import { createTestAuth, createTestIdentity } from "./test-fixtures.js";

const protoPath = fileURLToPath(
  new URL("../fixtures/auth.proto", import.meta.url),
);
// Preserve the real Nest service binding while exposing the actual ephemeral port.
class EphemeralGrpc extends ServerGrpc {
  port = 0;

  override async createClient(): Promise<Server> {
    const server = new Server();
    this.port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        "127.0.0.1:0",
        ServerCredentials.createInsecure(),
        (error, port) => {
          if (error) {
            reject(error);
          } else {
            resolve(port);
          }
        },
      ),
    );
    return server;
  }
}

type GrpcClient = Client &
  Record<
    string,
    (
      data: object,
      metadata: Metadata,
      callback: (error: ServiceError | null, result: unknown) => void,
    ) => ClientUnaryCall
  >;

describe("RPC gRPC", () => {
  it.each(["standalone", "hybrid"])(
    "uses real metadata sessions and delivers 16/7/8/13 statuses (%s)",
    async (mode) => {
      let secret = "";
      const auth = createTestAuth({
        plugins: [bearer()],
        session: { updateAge: 1 },
      });
      @Controller()
      @UseBetterAuth()
      class GrpcController {
        @GrpcMethod("AuthProbe", "Private")
        privateMessage(@CurrentUser() user: { id: string }) {
          return { userId: user.id };
        }

        @Public()
        @GrpcMethod("AuthProbe", "Public")
        publicMessage() {
          return { value: "public" };
        }

        @Require({
          policy: {
            id: "rpc-forbidden",
            evaluate: () => ({ effect: "deny", reason: "MISSING_PERMISSION" }),
          },
          params: {},
        })
        @GrpcMethod("AuthProbe", "Forbidden")
        forbidden() {
          return {};
        }

        @Require({
          policy: {
            id: "rpc-limited",
            evaluate: () => {
              throw new APIError("TOO_MANY_REQUESTS", {
                code: "RATE_LIMITED",
                message: "Slow down",
              });
            },
          },
          params: {},
        })
        @GrpcMethod("AuthProbe", "Limited")
        limited() {
          return {};
        }

        @Require({
          policy: {
            id: "rpc-outage",
            evaluate: () => {
              throw new Error(`database unavailable cookie=${secret}`);
            },
          },
          params: {},
        })
        @GrpcMethod("AuthProbe", "Outage")
        outage() {
          return {};
        }
      }
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            platforms: mode === "hybrid" ? [expressPlatform()] : [],
            transports: [rpcTransport()],
          }),
        ],
        controllers: [GrpcController],
      })
      class Fixture {}
      const strategy = new EphemeralGrpc({ package: "auth", protoPath });
      const http =
        mode === "hybrid"
          ? await NestFactory.create(Fixture, {
              logger: false,
              abortOnError: false,
            })
          : undefined;
      const app = http
        ? http.connectMicroservice({ strategy })
        : await NestFactory.createMicroservice(Fixture, {
            strategy,
            logger: false,
            abortOnError: false,
          });
      let client: GrpcClient | undefined;
      const logged = vi.spyOn(Logger.prototype, "error");
      try {
        if (http) {
          await http.init();
        }
        await app.listen();
        const definition = loadPackageDefinition(loadSync(protoPath));
        const Service = (
          definition.auth as unknown as {
            AuthProbe: new (
              address: string,
              channelCredentials: ReturnType<typeof credentials.createInsecure>,
            ) => GrpcClient;
          }
        ).AuthProbe;
        client = new Service(
          `127.0.0.1:${strategy.port}`,
          credentials.createInsecure(),
        );
        const responseHeaders: Metadata[] = [];
        const call = (method: string, metadata = new Metadata()) =>
          new Promise<unknown>((resolve, reject) => {
            const pending = client![method]!({}, metadata, (error, result) => {
              if (error) {
                reject(error);
              } else {
                resolve(result);
              }
            });
            pending.on("metadata", (metadata: Metadata) =>
              responseHeaders.push(metadata),
            );
            pending.on("status", (status: { metadata: Metadata }) =>
              responseHeaders.push(status.metadata),
            );
          });
        await expect(call("private")).rejects.toMatchObject({ code: 16 });
        await expect(call("public")).resolves.toEqual({ value: "public" });
        const first = await createTestIdentity(auth);
        const second = await createTestIdentity(auth);
        secret = first.cookie;
        const context = await auth.$context;
        await context.internalAdapter.updateSession(first.token, {
          expiresAt: new Date(Date.now() + 60_000),
          updatedAt: new Date(Date.now() - 10_000),
        });
        const before = await context.internalAdapter.findSession(first.token);
        const metadata = new Metadata();
        metadata.set("cookie", first.cookie);
        const bearerMetadata = new Metadata();
        bearerMetadata.set("authorization", `Bearer ${second.token}`);
        await expect(call("private", metadata)).resolves.toEqual({
          userId: first.userId,
        });
        await expect(call("private", bearerMetadata)).resolves.toEqual({
          userId: second.userId,
        });
        await expect(call("forbidden", metadata)).rejects.toMatchObject({
          code: 7,
          details: "Forbidden",
        });
        await expect(call("limited", metadata)).rejects.toMatchObject({
          code: 8,
          details: "Too Many Requests",
        });
        await expect(call("outage", metadata)).rejects.toMatchObject({
          code: 13,
          details: "Internal server error",
        });
        const errors = logged.mock.calls
          .flat()
          .filter((value) => value instanceof Error);
        expect(errors).toHaveLength(1);
        expect(responseHeaders.length).toBeGreaterThan(0);
        expect(
          responseHeaders.every(
            (headers) => headers.get("set-cookie").length === 0,
          ),
        ).toBe(true);
        const errorText = errors
          .map(
            (error) =>
              `${error.message} ${error.stack} ${error.cause instanceof Error ? `${error.cause.message} ${error.cause.stack}` : ""}`,
          )
          .join("\n");
        expect(errorText).not.toContain(first.token);
        expect(errorText).not.toContain(first.cookie);
        expect(
          (await context.internalAdapter.findSession(first.token))?.session,
        ).toEqual(before?.session);
        await (await auth.$context).internalAdapter.deleteSession(first.token);
        await expect(call("private", metadata)).rejects.toMatchObject({
          code: 16,
        });
      } finally {
        logged.mockRestore();
        client?.close();
        if (http) {
          await http.close();
        } else {
          await app.close();
        }
      }
    },
  );
});
