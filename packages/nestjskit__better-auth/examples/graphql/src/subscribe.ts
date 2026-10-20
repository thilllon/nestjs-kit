import { parseArgs } from "node:util";
import { connect } from "./client.js";

const usage =
  "Usage: [SESSION_TOKEN=<token>] node dist/subscribe.js [--url <GraphQL WebSocket URL>]";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    url: {
      type: "string",
      default: `ws://localhost:${process.env.PORT ?? 3000}/graphql`,
    },
  },
});
// The token comes from the environment: other local users can usually list a
// process's command-line arguments, but not its environment.
const token = process.env.SESSION_TOKEN || undefined;

/** Prints every added note until the subscription fails or ends. */
async function follow(url: string): Promise<void> {
  const client = connect(url, token);
  try {
    const results = client.iterate({
      query: "subscription { noteAdded { id text author } }",
    });
    for await (const { data, errors } of results) {
      if (errors) {
        console.error(JSON.stringify(errors));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(data?.noteAdded));
    }
  } finally {
    await client.dispose();
  }
}

if (positionals.length > 0) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    await follow(values.url);
  } catch (error) {
    // graphql-ws rejects with an Error, a GraphQL error list or the close
    // event of a connection that the server ended.
    const { code, reason, message } = error as Record<string, unknown>;
    console.error(
      JSON.stringify(Array.isArray(error) ? error : { code, reason, message }),
    );
    process.exitCode = 1;
  }
}
