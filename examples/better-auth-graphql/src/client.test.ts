import { describe, expect, it } from "vitest";
import { connect } from "./client.js";

describe("graphql-ws client", () => {
  it("sends a token only over wss:// or to a loopback host", async () => {
    expect(() => connect("ws://api.example.com/graphql", "token")).toThrow(
      "Refusing to send a session token over ws:// to api.example.com",
    );
    // Clients connect lazily, so creating them opens no connection.
    const clients = [
      connect("wss://api.example.com/graphql", "token"),
      connect("ws://localhost:3000/graphql", "token"),
      connect("ws://[::1]:3000/graphql", "token"),
      connect("ws://api.example.com/graphql"),
    ];
    await Promise.all(clients.map((client) => client.dispose()));
  });
});
