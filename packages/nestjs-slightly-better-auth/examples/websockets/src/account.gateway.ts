import { Inject } from "@nestjs/common";
import {
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from "@nestjs/websockets";
import {
  CurrentUser,
  OptionalAuth,
  Public,
  UseBetterAuth,
  type AuthUser,
} from "nestjs-slightly-better-auth";
import {
  WS_CONNECTION_AUTH,
  type WsConnectionAuth,
} from "nestjs-slightly-better-auth/websockets";
import type { Server } from "socket.io";

/** Messages on the default namespace, evaluated against the default instance. */
@WebSocketGateway()
@UseBetterAuth()
export class AccountGateway implements OnGatewayInit<Server> {
  constructor(
    @Inject(WS_CONNECTION_AUTH)
    private readonly connectionAuth: WsConnectionAuth,
  ) {}

  afterInit(server: Server) {
    // A handshake without a valid session connects as a guest. Malformed
    // credentials, or a session cookie from an untrusted origin, fail with a
    // connect_error before any message.
    server.use(this.connectionAuth.socketIoMiddleware());
  }

  @Public()
  @SubscribeMessage("status")
  status() {
    return { status: "ok" };
  }

  // @UseBetterAuth() requires a session for every message without an access
  // decorator and resolves it again for each message, so a revoked session
  // stops working on an open connection.
  @SubscribeMessage("profile")
  profile(@CurrentUser() user: AuthUser) {
    return { id: user.id, email: user.email, name: user.name };
  }

  @OptionalAuth()
  @SubscribeMessage("greeting")
  greeting(@CurrentUser() user: AuthUser | null) {
    return { message: user ? `Hello, ${user.name}` : "Hello, guest" };
  }
}
