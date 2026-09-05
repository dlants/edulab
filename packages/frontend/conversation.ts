import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";

const MODEL = "claude-opus-4-5";
const MAX_TOKENS = 16384;
// Task mode: the agent is here to get the user's work done. Learning mode is
// the secondary mode we layer on top of a transcript this produces, so this
// prompt must not pre-emptively tutor - the whole premise of the prototype is
// that a user watching a capable agent work becomes a passive observer.
const SYSTEM = [
  "You are a capable engineering assistant helping the user complete a task.",
  "Work the problem directly: make concrete decisions, write real code, and",
  "state your reasoning as you go rather than asking the user to supply it.",
  "Be concise. Do not quiz the user, do not pad explanations for a beginner,",
  "and do not check whether they are following - just do the work well.",
].join(" ");

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
    // RawMessageStreamEvent is an open union we forward verbatim from the SDK,
    // so an unrecognized event warns rather than throwing - a version bump
    // should not break a stream we can otherwise render.
    switch (event.type) {
      case "content_block_start":
        pending.blocks[event.index] = blockStartText(event.content_block);
        break;
      case "content_block_delta":
        pending.blocks[event.index] =
          (pending.blocks[event.index] ?? "") + deltaText(event.delta);
        break;
      case "message_stop":
        this.commit();
        break;
      case "message_start":
      case "message_delta":
      case "content_block_stop":
        break;
      default:
        console.warn("unhandled stream event", event);
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

/** This prototype has no tools and no thinking, so the non-text variants are
 * listed to be explicitly ignored rather than silently dropped - when we add
 * them, this is where they surface. */
function blockStartText(block: Anthropic.ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    default:
      console.warn("unhandled content block", block);
      return "";
  }
}

function deltaText(delta: Anthropic.RawContentBlockDelta): string {
  switch (delta.type) {
    case "text_delta":
      return delta.text;
    default:
      console.warn("unhandled content block delta", delta);
      return "";
  }
}
