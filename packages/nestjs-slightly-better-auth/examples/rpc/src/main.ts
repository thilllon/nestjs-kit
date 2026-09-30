import { createApp } from "./create-app.js";

const app = await createApp({
  host: process.env.RPC_HOST ?? "127.0.0.1",
  port: Number(process.env.RPC_PORT ?? 4000),
});
await app.startAllMicroservices();
await app.listen(Number(process.env.PORT ?? 3000));
