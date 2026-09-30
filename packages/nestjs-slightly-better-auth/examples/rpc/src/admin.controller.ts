import { Controller, Inject } from "@nestjs/common";
import { MessagePattern } from "@nestjs/microservices";
import {
  BetterAuthService,
  CurrentUser,
  UseAuthInstance,
  UseBetterAuth,
  getBetterAuthServiceToken,
  type AuthOf,
  type AuthUser,
} from "nestjs-slightly-better-auth";

/** Message handlers evaluated against the named "admin" instance. */
@Controller()
@UseAuthInstance("admin")
@UseBetterAuth()
export class AdminController {
  constructor(
    @Inject(getBetterAuthServiceToken("admin"))
    private readonly adminAuth: BetterAuthService<AuthOf<"admin">>,
  ) {}

  @MessagePattern("admin.me")
  me(@CurrentUser() operator: AuthUser<"admin">) {
    return { id: operator.id, email: operator.email };
  }

  @MessagePattern("admin.session")
  async session() {
    // The named service reads the session the guard resolved for this message.
    const session = await this.adminAuth.getSession();
    return { expiresAt: session?.session.expiresAt };
  }
}
