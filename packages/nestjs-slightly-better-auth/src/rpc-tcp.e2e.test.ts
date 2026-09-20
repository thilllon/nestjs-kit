import type { AddressInfo, Server } from "node:net";
import { inspect } from "node:util";
import {
  Controller,
  Logger,
  Module,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import {
  ClientProxyFactory,
  EventPattern,
  MessagePattern,
  Transport,
} from "@nestjs/microservices";
import { Test } from "@nestjs/testing";
import { createAuthMiddleware } from "better-auth/api";
import { bearer } from "better-auth/plugins";
import { firstValueFrom, timeout } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { OptionalAuth, Public, RequireAuth } from "./auth-decorators.js";
import { BetterAuthGuard } from "./auth-guard.js";
import { BetterAuthModule } from "./auth-module.js";
import { BetterAuthScopeInterceptor } from "./auth-scope-interceptor.js";
import { expressPlatform } from "./express.js";
import { rpcTransport } from "./microservices.js";
import { CurrentUser } from "./session-principal.js";
import { createTestAuth, createTestIdentity } from "./test-fixtures.js";

@Controller()
class TcpController {
  @MessagePattern("private")
  privateMessage(@CurrentUser() user: { id: string }) {
    return { userId: user.id };
  }

  @Public()
  @MessagePattern("public")
  publicMessage() {
    return { value: 1 };
  }
}

describe("RPC TCP", () => {
  it("rejects malformed credentials without logging secrets, SDK I/O, or fallback", async () => {
    let reads = 0;
    let handled = 0;
    const auth = createTestAuth({
      plugins: [bearer()],
      hooks: {
        before: createAuthMiddleware(async (context) => {
          if (context.path === "/get-session") {
            reads++;
          }
        }),
      },
    });
    @Controller()
    class MalformedController {
      @MessagePattern("required")
      required() {
        handled++;
        return "unexpected";
      }

      @OptionalAuth()
      @MessagePattern("optional")
      optional() {
        handled++;
        return "unexpected";
      }
    }
    @Module({
      imports: [
        BetterAuthModule.forRoot({ auth, transports: [rpcTransport()] }),
      ],
      controllers: [MalformedController],
    })
    class Fixture {}
    const app = await NestFactory.createMicroservice(Fixture, {
      transport: Transport.TCP,
      options: { host: "127.0.0.1", port: 0 },
      logger: false,
      abortOnError: false,
    });
    let client: ReturnType<typeof ClientProxyFactory.create> | undefined;
    const logged = vi.spyOn(Logger.prototype, "error");
    try {
      await app.listen();
      const identity = await createTestIdentity(auth);
      const port = (app.unwrap<Server>().address() as AddressInfo).port;
      client = ClientProxyFactory.create({
        transport: Transport.TCP,
        options: { host: "127.0.0.1", port },
      });
      for (const pattern of ["required", "optional"]) {
        const result = await firstValueFrom(
          client
            .send(pattern, {
              auth: {
                cookie: `${identity.cookie}\r\nprivate-rpc-credential`,
                authorization: `Bearer ${identity.token}`,
              },
            })
            .pipe(timeout(4000)),
        ).then(
          (value: unknown) => ({ unexpectedSuccess: value }),
          (error: unknown) => error,
        );
        const diagnostics = inspect(logged.mock.calls, { depth: null });
        expect(diagnostics).not.toContain("private-rpc-credential");
        expect(diagnostics).not.toContain(identity.cookie);
        expect(diagnostics).not.toContain(identity.token);
        expect(result).toMatchObject({
          statusCode: 401,
          code: "UNAUTHENTICATED",
          reason: "MALFORMED_CREDENTIALS",
        });
      }
      expect(reads).toBe(0);
      expect(handled).toBe(0);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
      client?.close();
      await app.close();
    }
  });

  it.each([
    "listen",
    "init-listen",
    "hybrid-inherit",
    "hybrid-explicit",
  ] as const)(
    "authenticates real sessions per message and suppresses refresh (%s)",
    async (mode) => {
      let reads = 0;
      const auth = createTestAuth({
        plugins: [bearer()],
        session: { updateAge: 1 },
        hooks: {
          before: createAuthMiddleware(async (context) => {
            if (context.path === "/get-session") {
              reads++;
            }
          }),
        },
      });
      @Controller()
      class ControllerFixture extends TcpController {}
      if (mode === "hybrid-explicit") {
        UseGuards(BetterAuthGuard)(ControllerFixture);
        UseInterceptors(BetterAuthScopeInterceptor)(ControllerFixture);
      }
      const hybrid = mode.startsWith("hybrid");
      @Module({
        imports: [
          BetterAuthModule.forRoot({
            auth,
            platforms: hybrid ? [expressPlatform()] : [],
            transports: [
              rpcTransport({ inheritAppConfig: mode === "hybrid-inherit" }),
            ],
          }),
        ],
        controllers: [ControllerFixture],
      })
      class Fixture {}
      const config = {
        transport: Transport.TCP as const,
        options: { host: "127.0.0.1", port: 0 },
        logger: false as const,
        abortOnError: false,
      };
      const http = hybrid
        ? await NestFactory.create(Fixture, {
            logger: false,
            abortOnError: false,
          })
        : undefined;
      const app = http
        ? http.connectMicroservice(config, {
            inheritAppConfig: mode === "hybrid-inherit",
          })
        : await NestFactory.createMicroservice(Fixture, config);
      let client: ReturnType<typeof ClientProxyFactory.create> | undefined;
      try {
        if (http) {
          await http.init();
        }
        if (mode === "init-listen") {
          await app.init();
        }
        await app.listen();
        const port = (app.unwrap<Server>().address() as AddressInfo).port;
        client = ClientProxyFactory.create({
          transport: Transport.TCP,
          options: { host: "127.0.0.1", port },
        });
        const send = (pattern: string, data: unknown) =>
          firstValueFrom(client!.send(pattern, data).pipe(timeout(4000)));
        await expect(send("private", { value: 1 })).rejects.toMatchObject({
          statusCode: 401,
          code: "UNAUTHENTICATED",
        });
        const beforePublic = reads;
        await expect(
          send("public", { auth: { cookie: "malformed" } }),
        ).resolves.toEqual({ value: 1 });
        expect(reads).toBe(beforePublic);
        const first = await createTestIdentity(auth);
        const second = await createTestIdentity(auth);
        const context = await auth.$context;
        const agedExpiry = new Date(Date.now() + 60_000);
        await context.internalAdapter.updateSession(first.token, {
          expiresAt: agedExpiry,
          updatedAt: new Date(Date.now() - 10_000),
        });
        const before = await context.internalAdapter.findSession(first.token);
        const beforeReads = reads;
        await expect(
          send("private", { auth: { cookie: first.cookie } }),
        ).resolves.toEqual({ userId: first.userId });
        await expect(
          send("private", {
            auth: { authorization: `Bearer ${second.token}` },
          }),
        ).resolves.toEqual({ userId: second.userId });
        expect(reads - beforeReads).toBe(2);
        expect(
          (await context.internalAdapter.findSession(first.token))?.session,
        ).toEqual(before?.session);
        await context.internalAdapter.deleteSession(first.token);
        await expect(
          send("private", { auth: { cookie: first.cookie } }),
        ).rejects.toMatchObject({ statusCode: 401 });
        await expect(send("private", {})).rejects.toMatchObject({
          statusCode: 401,
        });
      } finally {
        client?.close();
        if (http) {
          await http.close();
        } else {
          await app.close();
        }
      }
    },
  );

  it.each(["message", "event"])(
    "fails boot for hybrid %s handlers without explicit enhancers",
    async (kind) => {
      @Controller()
      class Uncovered {
        @RequireAuth() handler() {
          return true;
        }
      }
      (kind === "message"
        ? MessagePattern("uncovered")
        : EventPattern("uncovered"))(
        Uncovered.prototype,
        "handler",
        Object.getOwnPropertyDescriptor(Uncovered.prototype, "handler")!,
      );
      const module = await Test.createTestingModule({
        imports: [
          BetterAuthModule.forRoot({
            auth: createTestAuth(),
            platforms: [expressPlatform()],
            transports: [rpcTransport()],
          }),
        ],
        controllers: [Uncovered],
      }).compile();
      const app = module.createNestApplication();
      app.connectMicroservice({
        transport: Transport.TCP,
        options: { port: 0 },
      });
      try {
        await expect(app.init()).rejects.toMatchObject({
          issues: expect.arrayContaining([
            expect.objectContaining({ code: "RPC_HANDLER_UNGUARDED" }),
          ]),
        });
      } finally {
        await app.close();
      }
    },
  );

  it("rejects dynamic baseURL without a hostless fallback at boot", async () => {
    const auth = createTestAuth({
      baseURL: { allowedHosts: ["*.example.test"] },
    });
    @Module({
      imports: [
        BetterAuthModule.forRoot({ auth, transports: [rpcTransport()] }),
      ],
      controllers: [TcpController],
    })
    class Fixture {}
    const app = await NestFactory.createMicroservice(Fixture, {
      transport: Transport.TCP,
      options: { port: 0 },
      logger: false,
      abortOnError: false,
    });
    try {
      await expect(app.listen()).rejects.toMatchObject({
        issues: expect.arrayContaining([
          expect.objectContaining({
            code: "DYNAMIC_BASE_URL_WITHOUT_FALLBACK",
          }),
        ]),
      });
    } finally {
      await app.close();
    }
  });
});
