import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { Test } from "@nestjs/testing";
import {
  ApiException,
  ServerConfiguration,
} from "@sendbird/sendbird-platform-sdk-typescript";
import { describe, expect, it } from "vitest";
import { SendbirdModule } from "./sendbird.module";
import { SendbirdService } from "./sendbird.service";

/** Serves one fixed response on an ephemeral loopback port. */
async function loopback(status: number, body: string) {
  const received: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    received.push(request.headers);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const module = await Test.createTestingModule({
    imports: [
      SendbirdModule.register({
        appId: "local",
        apiToken: "registration-token",
        configuration: {
          baseServer: new ServerConfiguration("http://127.0.0.1:{port}", {
            port: String(port),
          }),
        },
      }),
    ],
  }).compile();
  return {
    received,
    sendbird: module.get(SendbirdService),
    async close() {
      await module.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("Sendbird HTTP requests", () => {
  it("sends the registration token only when a call omits its own", async () => {
    const { received, sendbird, close } = await loopback(
      200,
      JSON.stringify({ user_id: "reader" }),
    );
    try {
      await sendbird.users.viewAUser({ userId: "reader" });
      await sendbird.users.viewAUser({ userId: "reader", apiToken: "call" });
      // These generated methods spell the header "Api-Token".
      await sendbird.bots.viewBotById({ botUserid: "bot" });
      await sendbird.bots.viewBotById({ botUserid: "bot", apiToken: "call" });
      // An explicit empty token is sent as-is rather than replaced.
      await sendbird.users.viewAUser({ userId: "reader", apiToken: "" });
      // An undefined token (such as an unset environment variable) counts as
      // omitted, as the README documents.
      await sendbird.users.viewAUser({ userId: "reader", apiToken: undefined });
      expect(received.map((headers) => headers["api-token"])).toEqual([
        "registration-token",
        "call",
        "registration-token",
        "call",
        "",
        "registration-token",
      ]);
    } finally {
      await close();
    }
  });

  it("rejects non-2xx responses with the SDK's ApiException unchanged", async () => {
    const body = JSON.stringify({
      error: true,
      code: 400401,
      message: 'Invalid value: "api_token".',
    });
    const { sendbird, close } = await loopback(401, body);
    try {
      const failure = await sendbird.users
        .viewAUser({ userId: "reader" })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ApiException);
      expect(failure).toMatchObject({ code: 401, body });
    } finally {
      await close();
    }
  });
});
