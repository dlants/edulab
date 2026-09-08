import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import Fastify from "fastify";
import { registerSocket } from "./socket.ts";
import { registerStatic } from "./static.ts";

dotenv.config({
  path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.env"),
});

async function run() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: ANTHROPIC_API_KEY");
  const password = process.env.APP_PASSWORD;
  if (!password) throw new Error("Missing required env var: APP_PASSWORD");

  const app = Fastify({ logger: true });
  await registerSocket(app, apiKey, password);
  await registerStatic(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
