import type { AddressInfo, Server } from "node:net";
import type { INestApplication } from "@nestjs/common";
import type { ClientProxy } from "@nestjs/microservices";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, send } from "./client.js";
import { createApp } from "./create-app.js";

const origin = "http://localhost:3000";
const host = "127.0.0.1";
let app: INestApplication | undefined;
let client: ClientProxy | undefined;
let url: string;

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

function call<T = unknown>(pattern: string, token?: string): Promise<T> {
  return send<T>(client!, pattern, token);
}

describe("RPC example", () => {
  beforeAll(async () => {
    app = await createApp({ host, port: 0 }, { logger: false });
    await app.startAllMicroservices();
    await app.listen(0, host);
    url = await app.getUrl();
    const tcp = app.getMicroservices()[0]!.unwrap<Server>();
    client = createClient({
      host,
      port: (tcp.address() as AddressInfo).port,
    });
  });

  afterAll(async () => {
    client?.close();
    await app?.close();
  });

  it("authenticates each message of the default instance", async () => {
    expect(await call("account.status")).toEqual({ status: "ok" });
    expect(await call("account.greeting")).toEqual({
      message: "Hello, guest",
    });
    await expect(call("account.profile")).rejects.toMatchObject({
      statusCode: 401,
      code: "UNAUTHENTICATED",
    });
    await expect(
      call("account.profile", "not-a-session-token"),
    ).rejects.toMatchObject({ statusCode: 401 });

    const token = await signUp("/api/auth", "ada@example.com");
    expect(await call("account.profile", token)).toMatchObject({
      email: "ada@example.com",
      name: "ada",
    });
    expect(await call("account.greeting", token)).toEqual({
      message: "Hello, ada",
    });

    // Every message resolves the session again, so signing out ends access
    // for the same token.
    const signOut = await fetch(`${url}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin, authorization: `Bearer ${token}` },
    });
    expect(signOut.status).toBe(200);
    await expect(call("account.profile", token)).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("isolates the named instance's messages", async () => {
    const userToken = await signUp("/api/auth", "lin@example.com");
    await expect(call("admin.me")).rejects.toMatchObject({ statusCode: 401 });
    await expect(call("admin.me", userToken)).rejects.toMatchObject({
      statusCode: 401,
    });

    const operatorToken = await signUp("/api/admin-auth", "grace@example.com");
    expect(await call("admin.me", operatorToken)).toMatchObject({
      email: "grace@example.com",
    });
    const session = await call<{ expiresAt: string }>(
      "admin.session",
      operatorToken,
    );
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
    await expect(call("account.profile", operatorToken)).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
