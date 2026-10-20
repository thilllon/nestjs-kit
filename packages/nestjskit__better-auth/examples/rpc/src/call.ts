import { parseArgs } from "node:util";
import { createClient, send } from "./client.js";

const usage =
  "Usage: [SESSION_TOKEN=<token>] node dist/call.js <pattern> [--host <host>] [--port <port>]";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    host: { type: "string", default: process.env.RPC_HOST ?? "127.0.0.1" },
    port: { type: "string", default: process.env.RPC_PORT ?? "4000" },
  },
});
// The token comes from the environment: other local users can usually list a
// process's command-line arguments, but not its environment.
const token = process.env.SESSION_TOKEN || undefined;

const [pattern] = positionals;
if (pattern === undefined || positionals.length > 1) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const client = createClient({
    host: values.host,
    port: Number(values.port),
  });
  try {
    console.log(JSON.stringify(await send(client, pattern, token)));
  } catch (error) {
    console.error(
      JSON.stringify(
        error instanceof Error ? { message: error.message } : error,
      ),
    );
    process.exitCode = 1;
  } finally {
    client.close();
  }
}
