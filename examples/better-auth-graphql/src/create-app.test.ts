import type { INestApplication } from "@nestjs/common";
import type { Client } from "graphql-ws";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { connect } from "./client.js";
import { createApp } from "./create-app.js";
import { NotesService } from "./notes.service.js";

const origin = "http://localhost:3000";
let app: INestApplication | undefined;
let url: string;
const clients: Client[] = [];

interface Result {
  data?: Record<string, any> | null;
  errors?: readonly {
    message: string;
    extensions?: Record<string, unknown>;
  }[];
}

async function signUp(basePath: string, email: string) {
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
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  return { token: token as string, cookie };
}

async function post(
  query: string,
  headers: Record<string, string> = {},
): Promise<Result> {
  const response = await fetch(`${url}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

function socket(token?: string): Client {
  const client = connect(`${url.replace(/^http/, "ws")}/graphql`, token);
  clients.push(client);
  return client;
}

/** Runs an operation over graphql-ws and resolves with its first result. */
async function first(client: Client, query: string): Promise<Result> {
  const results = client.iterate({ query });
  try {
    const { value } = await results.next();
    return value;
  } finally {
    await results.return?.();
  }
}

function denial(result: Result) {
  return result.errors?.[0]?.extensions;
}

describe("GraphQL example", () => {
  beforeAll(async () => {
    app = await createApp({ logger: false });
    await app.listen(0, "127.0.0.1");
    url = await app.getUrl();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.dispose()));
  });

  afterAll(async () => {
    await app?.close();
  });

  it("authenticates HTTP operations for default and named instances independently", async () => {
    expect(await post("{ status greeting }")).toEqual({
      data: { status: "ok", greeting: "Hello, guest" },
    });
    expect(denial(await post("{ profile { email } }"))).toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });
    const addNote = 'mutation { addNote(text: "Hello") { text author } }';
    expect(denial(await post(addNote, { origin }))).toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });

    const user = await signUp("/api/auth", "ada@example.com");
    expect(
      await post("{ profile { email name } greeting }", {
        cookie: user.cookie,
      }),
    ).toEqual({
      data: {
        profile: { email: "ada@example.com", name: "ada" },
        greeting: "Hello, ada",
      },
    });
    expect(await post(addNote, { cookie: user.cookie, origin })).toEqual({
      data: { addNote: { text: "Hello", author: "ada" } },
    });
    expect(
      denial(await post("{ operator { email } }", { cookie: user.cookie })),
    ).toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401 });

    const operator = await signUp("/api/admin-auth", "grace@example.com");
    expect(operator.cookie).toContain("admin-auth.session_token=");
    const result = await post(
      "{ operator { email } operatorSessionExpiresAt }",
      {
        cookie: operator.cookie,
      },
    );
    expect(result.data?.operator).toEqual({ email: "grace@example.com" });
    expect(Date.parse(result.data?.operatorSessionExpiresAt)).toBeGreaterThan(
      Date.now(),
    );
    expect(
      denial(await post("{ profile { email } }", { cookie: operator.cookie })),
    ).toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401 });
  });

  it("authenticates every graphql-ws operation with the connection's token", async () => {
    const subscription = "subscription { noteAdded { text author } }";
    expect(denial(await first(socket(), subscription))).toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });

    const lin = await signUp("/api/auth", "lin@example.com");
    const client = socket(lin.token);
    const added = vi.spyOn(app!.get(NotesService), "added");
    const notes = client.iterate({ query: subscription });
    const received = notes.next();
    // The resolver subscribes to notes once the guard admits the operation.
    await vi.waitFor(() => expect(added).toHaveBeenCalledOnce());
    await post('mutation { addNote(text: "Live") { id } }', {
      cookie: lin.cookie,
      origin,
    });
    expect((await received).value).toEqual({
      data: { noteAdded: { text: "Live", author: "lin" } },
    });
    expect(await first(client, "{ profile { email } }")).toEqual({
      data: { profile: { email: "lin@example.com" } },
    });

    // Signing out revokes the session. The open subscription keeps the
    // connection, and the next operation on it is rejected.
    const signOut = await fetch(`${url}/api/auth/sign-out`, {
      method: "POST",
      headers: { origin, authorization: `Bearer ${lin.token}` },
    });
    expect(signOut.status).toBe(200);
    expect(denial(await first(client, "{ profile { email } }"))).toMatchObject({
      code: "UNAUTHENTICATED",
      statusCode: 401,
    });
    await notes.return?.();
  });
});
