import { Module } from "@nestjs/common";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { rpcTransport } from "nestjs-slightly-better-auth/microservices";
import { AccountController } from "./account.controller.js";
import { AdminController } from "./admin.controller.js";
import { adminAuth, auth } from "./auth.js";

@Module({
  imports: [
    // The default instance declares the HTTP platform, which mounts every
    // instance's auth routes, and the RPC transport, which authenticates
    // microservice messages for every instance.
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      transports: [rpcTransport()],
    }),
    // A named instance gets its own injection tokens, mount and cookies.
    BetterAuthModule.forRoot({ name: "admin", auth: adminAuth }),
  ],
  controllers: [AccountController, AdminController],
})
export class AppModule {}
