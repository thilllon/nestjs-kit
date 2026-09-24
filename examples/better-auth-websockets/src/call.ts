import { parseArgs } from "node:util";
import { connect, request, type GatewayError } from "./client.js";

const usage =
  "Usage: node dist/call.js <event> [--namespace <name>] [--token <session token>] [--url <server URL>]";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    namespace: { type: "string", default: "/" },
    token: { type: "string" },
    url: { type: "string", default: "http://localhost:3000" },
  },
});

async function call(event: string): Promise<void> {
  const namespace = values.namespace.replace(/^\/?/, "/");
  const socket = await connect(`${values.url}${namespace}`, values.token);
  try {
    console.log(JSON.stringify(await request(socket, event)));
  } finally {
    socket.close();
  }
}

const [event] = positionals;
if (event === undefined || positionals.length > 1) {
  console.error(usage);
  process.exitCode = 2;
} else {
  try {
    await call(event);
  } catch (error) {
    const { data, message } = error as GatewayError;
    console.error(JSON.stringify(data ?? { message }));
    process.exitCode = 1;
  }
}
