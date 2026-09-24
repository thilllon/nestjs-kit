import { Controller, Get } from "@nestjs/common";
import {
  CurrentUser,
  OptionalAuth,
  Public,
  type AuthUser,
} from "nestjs-slightly-better-auth";

/** Routes evaluated against the default instance. */
@Controller("account")
export class AccountController {
  @Public()
  @Get("status")
  status() {
    return { status: "ok" };
  }

  // The global guard requires a session on every route without an access
  // decorator, and @CurrentUser() injects that session's user.
  @Get("profile")
  profile(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, name: user.name };
  }

  @OptionalAuth()
  @Get("greeting")
  greeting(@CurrentUser() user: AuthUser | null) {
    return { message: user ? `Hello, ${user.name}` : "Hello, guest" };
  }
}
