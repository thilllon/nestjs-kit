import { createApp } from "./create-app.js";

const app = await createApp();
await app.listen(Number(process.env.PORT ?? 3000));
