import { parseArgs } from "node:util";
import { createClient, send } from "./client.js";

const usage =
  "Usage: node dist/call.js <pattern> [--token <session token>] [--host <host>] [--port <port>]";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    token: { type: "string" },
    host: { type: "string", default: process.env.RPC_HOST ?? "127.0.0.1" },
    port: { type: "string", default: process.env.RPC_PORT ?? "4000" },
  },
});

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
    console.log(JSON.stringify(await send(client, pattern, values.token)));
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
