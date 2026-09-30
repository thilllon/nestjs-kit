import { Controller } from "@nestjs/common";
import { MessagePattern } from "@nestjs/microservices";
import {
  CurrentUser,
  OptionalAuth,
  Public,
  UseBetterAuth,
  type AuthUser,
} from "nestjs-slightly-better-auth";

/**
 * Message handlers evaluated against the default instance. In a hybrid
 * application, Nest applies global guards to message handlers only with
 * `inheritAppConfig`, so the controller applies the guard and scope itself.
 */
@Controller()
@UseBetterAuth()
export class AccountController {
  @Public()
  @MessagePattern("account.status")
  status() {
    return { status: "ok" };
  }

  // Every message without an access decorator requires a session, which the
  // transport resolves again for each message.
  @MessagePattern("account.profile")
  profile(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, name: user.name };
  }

  @OptionalAuth()
  @MessagePattern("account.greeting")
  greeting(@CurrentUser() user: AuthUser | null) {
    return { message: user ? `Hello, ${user.name}` : "Hello, guest" };
  }
}
