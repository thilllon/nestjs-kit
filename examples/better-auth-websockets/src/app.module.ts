import { Module } from "@nestjs/common";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { socketIoTransport } from "nestjs-slightly-better-auth/websockets";
import { AccountGateway } from "./account.gateway.js";
import { AdminGateway } from "./admin.gateway.js";
import { adminAuth, auth } from "./auth.js";

@Module({
  imports: [
    // The default instance declares the app-wide HTTP platform, which mounts
    // every instance's auth routes, and the Socket.IO transport, which
    // authenticates gateway messages for every instance.
    BetterAuthModule.forRoot({
      auth,
      platforms: [expressPlatform()],
      transports: [socketIoTransport()],
    }),
    // A named instance gets its own injection tokens, mount and cookies.
    BetterAuthModule.forRoot({ name: "admin", auth: adminAuth }),
  ],
  providers: [AccountGateway, AdminGateway],
})
export class AppModule {}
