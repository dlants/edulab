import Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";

export async function registerSocket(app: FastifyInstance, apiKey: string) {
  const client = new Anthropic({ apiKey });
  await app.register(websocket);

  app.get("/api/socket", { websocket: true }, (socket) => {
    const send = (frame: ServerFrame) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };

    socket.on("message", (data: Buffer) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        socket.close(4400, "bad_request");
        return;
      }
      void run(message);
    });

    // The server is a pipe: it forwards every event to the client tagged with
    // the request id, and always terminates the request with done | error.
    async function run(message: ClientMessage) {
      const { requestId } = message;
      try {
        const stream = client.messages.stream(message.params);
        for await (const event of stream) {
          send({ type: "event", requestId, event });
        }
        send({ type: "done", requestId });
      } catch (err) {
        send({
          type: "error",
          requestId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}
