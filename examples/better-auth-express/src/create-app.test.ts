import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./create-app.js";

const origin = "http://localhost:3000";
let app: INestApplication | undefined;
let url: string;

async function signUp(basePath: string, email: string): Promise<Response> {
  return fetch(`${url}${basePath}/sign-up/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      name: email.split("@")[0],
      email,
      password: "correct horse battery staple",
    }),
  });
}

function sessionCookie(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

async function get(path: string, cookie?: string) {
  const response = await fetch(`${url}${path}`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, body: await response.json() };
}

describe("Express example", () => {
  beforeAll(async () => {
    app = await createApp({ logger: false });
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("authenticates default and named instances independently", async () => {
    expect(await get("/account/status")).toEqual({
      status: 200,
      body: { status: "ok" },
    });
    expect((await get("/account/profile")).status).toBe(401);
    expect((await get("/account/greeting")).body).toEqual({
      message: "Hello, guest",
    });

    const user = await signUp("/api/auth", "ada@example.com");
    expect(user.status).toBe(200);
    expect(user.headers.get("access-control-allow-origin")).toBe(origin);
    const userCookie = sessionCookie(user);
    expect(await get("/account/profile", userCookie)).toMatchObject({
      status: 200,
      body: { email: "ada@example.com", name: "ada" },
    });
    expect((await get("/account/greeting", userCookie)).body).toEqual({
      message: "Hello, ada",
    });
    expect((await get("/admin/me", userCookie)).status).toBe(401);

    const operator = await signUp("/api/admin-auth", "grace@example.com");
    expect(operator.status).toBe(200);
    const operatorCookie = sessionCookie(operator);
    expect(operatorCookie).toContain("admin-auth.session_token=");
    expect(await get("/admin/me", operatorCookie)).toMatchObject({
      status: 200,
      body: { email: "grace@example.com" },
    });
    const session = await get("/admin/session", operatorCookie);
    expect(session.status).toBe(200);
    expect(Date.parse(session.body.expiresAt)).toBeGreaterThan(Date.now());
    expect((await get("/account/profile", operatorCookie)).status).toBe(401);
  });
});
