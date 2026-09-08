import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/** In deployment the frontend is served from the same origin as the socket,
 * because a websocket cannot be routed through a Render static site rewrite. */
export async function registerStatic(app: FastifyInstance) {
  const root = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../frontend/dist",
  );
  // In dev the frontend is vite's, on 5173, and there is no build to serve.
  if (!existsSync(root)) return;
  await app.register(fastifyStatic, { root });

  // Prototype routes are real paths, so a deep link or a reload has to land on
  // index.html rather than a 404 (mirrors spaFallback in vite.config.ts).
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) return reply.code(404).send();
    return reply.sendFile("index.html");
  });
}
