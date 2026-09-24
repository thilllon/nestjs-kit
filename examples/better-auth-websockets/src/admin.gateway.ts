import { Inject } from "@nestjs/common";
import {
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import {
  BetterAuthService,
  CurrentUser,
  UseAuthInstance,
  UseBetterAuth,
  getBetterAuthServiceToken,
  type AuthOf,
  type AuthUser,
} from "nestjs-slightly-better-auth";
import {
  WS_CONNECTION_AUTH,
  type WsConnectionAuth,
} from "nestjs-slightly-better-auth/websockets";
import type { Namespace } from "socket.io";

/** Messages on the /admin namespace, evaluated against the named "admin" instance. */
@WebSocketGateway({ namespace: "admin" })
@UseAuthInstance("admin")
@UseBetterAuth()
export class AdminGateway implements OnGatewayInit<Namespace> {
  constructor(
    @Inject(WS_CONNECTION_AUTH)
    private readonly connectionAuth: WsConnectionAuth,
    @Inject(getBetterAuthServiceToken("admin"))
    private readonly adminAuth: BetterAuthService<AuthOf<"admin">>,
  ) {}

  afterInit(namespace: Namespace) {
    // Only a handshake with an admin-instance session joins this namespace.
    namespace.use(
      this.connectionAuth.socketIoMiddleware({
        required: true,
        instance: "admin",
      }),
    );
  }

  @SubscribeMessage("me")
  me(@CurrentUser() operator: AuthUser<"admin">) {
    return { id: operator.id, email: operator.email };
  }

  @SubscribeMessage("session")
  async session() {
    // The named service reads the session the guard resolved for this message.
    const session = await this.adminAuth.getSession();
    return { expiresAt: session?.session.expiresAt };
  }
}
