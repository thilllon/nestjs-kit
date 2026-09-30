import { Module } from "@nestjs/common";
import { BetterAuthModule } from "nestjs-slightly-better-auth";
import { fastifyPlatform } from "nestjs-slightly-better-auth/fastify";
import { AccountController } from "./account.controller.js";
import { AdminController } from "./admin.controller.js";
import { adminAuth, auth } from "./auth.js";

@Module({
  imports: [
    // The default instance declares the app-wide HTTP platform and registers
    // the global guard. The platform mounts every instance's auth routes.
    BetterAuthModule.forRoot({ auth, platforms: [fastifyPlatform()] }),
    // A named instance gets its own injection tokens, mount and cookies.
    // Static options such as the name stay next to useFactory; the factory
    // returns runtime options only.
    BetterAuthModule.forRootAsync({
      name: "admin",
      useFactory: () => ({ auth: adminAuth }),
    }),
  ],
  controllers: [AccountController, AdminController],
})
export class AppModule {}
