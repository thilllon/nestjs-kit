import type { INestApplication } from "@nestjs/common";
import type { Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { connect, request } from "./client.js";
import { createApp } from "./create-app.js";

const origin = "http://localhost:3000";
let app: INestApplication | undefined;
let url: string;
const sockets: Socket[] = [];

async function signUp(basePath: string, email: string): Promise<string> {
  const response = await fetch(`${url}${basePath}/sign-up/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      name: email.split("@")[0],
      email,
      password: "correct horse battery staple",
    }),
  });
  expect(response.status).toBe(200);
  const { token } = await response.json();
  return token;
}

async function open(namespace: string, token?: string): Promise<Socket> {
  const socket = await connect(`${url}${namespace}`, token);
  sockets.push(socket);
  return socket;
}

describe("WebSocket example", () => {
  beforeAll(async () => {
    app = await createApp({ logger: false });
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  });

  afterEach(() => {
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it("authenticates connections and messages for the default instance", async () => {
    const guest = await open("/");
    expect(await request(guest, "status")).toEqual({ status: "ok" });
    expect(await request(guest, "greeting")).toEqual({
      message: "Hello, guest",
    });
    await expect(request(guest, "profile")).rejects.toMatchObject({
      data: { statusCode: 401, code: "UNAUTHENTICATED" },
    });
    // Connection authentication rejects malformed credentials at the
    // handshake, before Better Auth or any handler sees them.
    await expect(open("/", "forged\r\ntoken")).rejects.toMatchObject({
      data: { statusCode: 401, reason: "MALFORMED_CREDENTIALS" },
    });

    const token = await signUp("/api/auth", "ada@example.com");
    const ada = await open("/", token);
    expect(await request(ada, "profile")).toMatchObject({
      email: "ada@example.com",
      name: "ada",
    });
    expect(await request(ada, "greeting")).toEqual({ message: "Hello, ada" });

    // Every message resolves the session again, so signing out ends access
    // on the connection that is still open.
    const signOut = await fetch(`${url}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin, authorization: `Bearer ${token}` },
    });
    expect(signOut.status).toBe(200);
    await expect(request(ada, "profile")).rejects.toMatchObject({
      data: { statusCode: 401 },
    });
  });

  it("admits only the named instance's sessions to the admin namespace", async () => {
    await expect(open("/admin")).rejects.toMatchObject({
      data: { statusCode: 401 },
    });
    const userToken = await signUp("/api/auth", "lin@example.com");
    await expect(open("/admin", userToken)).rejects.toMatchObject({
      data: { statusCode: 401 },
    });

    const operatorToken = await signUp("/api/admin-auth", "grace@example.com");
    const grace = await open("/admin", operatorToken);
    expect(await request(grace, "me")).toMatchObject({
      email: "grace@example.com",
    });
    const session = await request<{ expiresAt: string }>(grace, "session");
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());

    // The operator's token is no session of the default instance, whose
    // namespace therefore admits the connection only as a guest.
    const operatorOnDefault = await open("/", operatorToken);
    await expect(request(operatorOnDefault, "profile")).rejects.toMatchObject({
      data: { statusCode: 401 },
    });
  });
});
