import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";

export function connect(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/socket`);
}

/** Scratch driver for the stage-1 manual check: `edulab.ask("hi")` in the
 * console should log events as they stream in. Replaced by the conversation
 * module in the next stage. */
async function ask(text: string): Promise<void> {
  const socket = connect();
  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => resolve(), { once: true });
  });
  socket.addEventListener("message", (e: MessageEvent<string>) => {
    const frame = JSON.parse(e.data) as ServerFrame;
    console.log(frame);
    if (frame.type !== "event") socket.close();
  });
  const message: ClientMessage = {
    type: "start",
    requestId: crypto.randomUUID(),
    params: {
      model: "claude-sonnet-4-5",
      max_tokens: 1024,
      stream: true,
      messages: [{ role: "user", content: text }],
    },
  };
  socket.send(JSON.stringify(message));
}

(window as unknown as { edulab: { ask: typeof ask } }).edulab = { ask };

const root = document.getElementById("app") ?? document.body;
root.textContent = 'edulab — try edulab.ask("hello") in the console';
