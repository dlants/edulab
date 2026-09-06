import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage } from "@edulab/iso/protocol.ts";
import { expect, it } from "vitest";
import { type Citation, citationText, parse, resolve } from "./citation.ts";
import type { ThreadId } from "./selection.ts";
import { type MessageIdx, type Socket, Thread } from "./thread.ts";
import { ThreadTree } from "./threads.ts";

class FakeSocket implements Socket {
  readonly sent: ClientMessage[] = [];
  private readonly listeners: ((e: MessageEvent<string>) => void)[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  addEventListener(
    _type: "message",
    listener: (e: MessageEvent<string>) => void,
  ) {
    this.listeners.push(listener);
  }
  private deliver(event: Anthropic.RawMessageStreamEvent) {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error("nothing sent");
    const data = JSON.stringify({
      type: "event",
      requestId: last.requestId,
      event,
    });
    for (const listener of [...this.listeners]) {
      listener(new MessageEvent("message", { data }));
    }
  }
  replies(text: string) {
    this.deliver({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: [] },
    });
    this.deliver({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    this.deliver({ type: "content_block_stop", index: 0 });
    this.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  }
}

const cite = (thread: string, index: number): Citation => ({
  thread: thread as ThreadId,
  index: index as MessageIdx,
});

it("splits prose into text and citation spans in order", () => {
  expect(parse("shaky on @message:t0:3 but fluent in @message:t1:0.")).toEqual([
    { type: "text", text: "shaky on " },
    { type: "citation", citation: cite("t0", 3) },
    { type: "text", text: " but fluent in " },
    { type: "citation", citation: cite("t1", 0) },
    { type: "text", text: "." },
  ]);
});

it("leaves malformed references as literal text", () => {
  for (const text of ["@message:t0:", "@message::1", "@message:t0:x"]) {
    expect(parse(text)).toEqual([{ type: "text", text }]);
  }
});

it("round-trips a citation through citationText and parse", () => {
  const citation = cite("t2", 7);
  expect(parse(citationText(citation))).toEqual([
    { type: "citation", citation },
  ]);
});

it("resolves a live address to its message text and nothing else", async () => {
  const socket = new FakeSocket();
  const root = new Thread(socket, { initialTurns: [] });
  const tree = new ThreadTree(socket, root, () => {});
  const turn = root.send("how does backpressure work");
  socket.replies("it does not");
  await turn;

  expect(resolve(tree, cite(tree.root, 0))).toBe("how does backpressure work");
  expect(resolve(tree, cite(tree.root, 1))).toBe("it does not");
  expect(resolve(tree, cite(tree.root, 9))).toBeUndefined();
  expect(resolve(tree, cite("nope", 0))).toBeUndefined();
});
