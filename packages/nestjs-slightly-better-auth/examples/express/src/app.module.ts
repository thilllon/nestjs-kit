import { Module } from "@nestjs/common";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { expressPlatform } from "nestjs-slightly-better-auth/express";
import { AccountController } from "./account.controller.js";
import { AdminController } from "./admin.controller.js";
import { adminAuth, auth } from "./auth.js";

@Module({
  imports: [
    // The default instance declares the app-wide HTTP platform and registers
    // the global guard. The platform mounts every instance's auth routes.
    BetterAuthModule.forRoot({ auth, platforms: [expressPlatform()] }),
    // A named instance gets its own injection tokens, mount and cookies.
    BetterAuthModule.forRoot({ name: "admin", auth: adminAuth }),
  ],
  controllers: [AccountController, AdminController],
})
export class AppModule {}
