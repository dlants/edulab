import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";

const MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;
const SYSTEM =
  "You are a patient tutor. Explain concepts clearly and concisely.";

export type Message = { role: "user" | "assistant"; text: string };

/** The subset of WebSocket the conversation uses, so tests can stand in for it. */
export type Socket = {
  send(data: string): void;
  addEventListener(
    type: "message",
    listener: (e: MessageEvent<string>) => void,
  ): void;
};

export class Conversation {
  private readonly turns: Anthropic.MessageParam[] = [];
  private pending: { requestId: string; blocks: string[] } | undefined;
  private settle: (() => void) | undefined;
  onChange: (() => void) | undefined;

  private readonly socket: Socket;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.addEventListener("message", (e: MessageEvent<string>) => {
      this.handleFrame(JSON.parse(e.data) as ServerFrame);
    });
  }

  /** Committed turns plus the one currently streaming. */
  get messages(): ReadonlyArray<Message> {
    const committed = this.turns.map(
      (turn): Message => ({
        role: turn.role === "assistant" ? "assistant" : "user",
        text: textOf(turn),
      }),
    );
    const streaming = this.pending?.blocks.join("");
    if (streaming) committed.push({ role: "assistant", text: streaming });
    return committed;
  }

  get inFlight(): boolean {
    return this.pending !== undefined;
  }

  send(text: string): Promise<void> {
    if (this.pending) return Promise.resolve();
    this.turns.push({ role: "user", content: text });
    const requestId = crypto.randomUUID();
    this.pending = { requestId, blocks: [] };
    const message: ClientMessage = {
      type: "start",
      requestId,
      params: {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: SYSTEM,
        stream: true,
        messages: [...this.turns],
      },
    };
    this.socket.send(JSON.stringify(message));
    this.onChange?.();
    return new Promise<void>((resolve) => {
      this.settle = resolve;
    });
  }

  handleFrame(frame: ServerFrame): void {
    const pending = this.pending;
    if (!pending || frame.requestId !== pending.requestId) return;
    switch (frame.type) {
      case "event":
        this.handleEvent(frame.event);
        break;
      case "done":
      case "error":
        // A turn that ends without a message_stop still commits whatever text
        // arrived, so the next turn's array stays valid.
        this.commit();
        break;
    }
    this.onChange?.();
  }

  private handleEvent(event: Anthropic.RawMessageStreamEvent): void {
    const pending = this.pending;
    if (!pending) return;
    switch (event.type) {
      case "content_block_start":
        pending.blocks[event.index] =
          event.content_block.type === "text" ? event.content_block.text : "";
        break;
      case "content_block_delta":
        if (event.delta.type === "text_delta") {
          pending.blocks[event.index] =
            (pending.blocks[event.index] ?? "") + event.delta.text;
        }
        break;
      case "message_stop":
        this.commit();
        break;
      default:
        break;
    }
  }

  private commit(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const text = pending.blocks.join("");
    // MessageParam content must be non-empty, so an empty response is dropped.
    if (text.length > 0) this.turns.push({ role: "assistant", content: text });
    this.settle?.();
    this.settle = undefined;
  }
}

function textOf(turn: Anthropic.MessageParam): string {
  if (typeof turn.content === "string") return turn.content;
  return turn.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}
