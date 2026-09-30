import { Controller, Get, Inject } from "@nestjs/common";
import {
  BetterAuthService,
  CurrentUser,
  UseAuthInstance,
  getBetterAuthServiceToken,
  type AuthOf,
  type AuthUser,
} from "nestjs-slightly-better-auth";

/** Routes evaluated against the named "admin" instance. */
@UseAuthInstance("admin")
@Controller("admin")
export class AdminController {
  constructor(
    @Inject(getBetterAuthServiceToken("admin"))
    private readonly adminAuth: BetterAuthService<AuthOf<"admin">>,
  ) {}

  @Get("me")
  me(@CurrentUser() operator: AuthUser<"admin">) {
    return { id: operator.id, email: operator.email };
  }

  @Get("session")
  async session() {
    // The named service reads the session the guard resolved for this route.
    const session = await this.adminAuth.getSession();
    return { expiresAt: session?.session.expiresAt };
  }
}
