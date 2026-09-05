import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage } from "@edulab/iso/protocol.ts";
import { expect, it } from "vitest";
import { Conversation, type Socket } from "./conversation.ts";

class FakeSocket implements Socket {
  readonly sent: ClientMessage[] = [];
  private listener: ((e: MessageEvent<string>) => void) | undefined;

  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }

  addEventListener(
    _type: "message",
    listener: (e: MessageEvent<string>) => void,
  ) {
    this.listener = listener;
  }

  get requestId(): string {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error("nothing sent");
    return last.requestId;
  }

  deliver(event: Anthropic.RawMessageStreamEvent) {
    this.listener?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "event",
          requestId: this.requestId,
          event,
        }),
      }),
    );
  }

  stream(chunks: string[]) {
    this.deliver({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    });
    for (const text of chunks) {
      this.deliver({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    }
    this.deliver({ type: "content_block_stop", index: 0 });
    this.deliver({
      type: "message_stop",
    } as Anthropic.RawMessageStreamEvent);
  }
}

function setup() {
  const socket = new FakeSocket();
  return { socket, conversation: new Conversation(socket) };
}

it("accumulates deltas into the streaming assistant message", async () => {
  const { socket, conversation } = setup();
  const turn = conversation.send("hi");
  expect(conversation.messages).toEqual([{ role: "user", text: "hi" }]);

  socket.deliver({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  });
  socket.deliver({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "he" },
  });
  expect(conversation.messages[1]).toEqual({ role: "assistant", text: "he" });

  socket.deliver({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "llo" },
  });
  socket.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  await turn;

  expect(conversation.inFlight).toBe(false);
  expect(conversation.messages).toEqual([
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]);
});

it("sends the whole conversation with alternating roles on the second turn", async () => {
  const { socket, conversation } = setup();
  const first = conversation.send("one");
  socket.stream(["1"]);
  await first;

  const second = conversation.send("two");
  socket.stream(["2"]);
  await second;

  expect(conversation.messages).toEqual([
    { role: "user", text: "one" },
    { role: "assistant", text: "1" },
    { role: "user", text: "two" },
    { role: "assistant", text: "2" },
  ]);
  expect(socket.sent[1]?.params.messages).toEqual([
    { role: "user", content: "one" },
    { role: "assistant", content: "1" },
    { role: "user", content: "two" },
  ]);
});

it("ignores send while a turn is in flight", () => {
  const { socket, conversation } = setup();
  void conversation.send("one");
  void conversation.send("two");
  expect(socket.sent).toHaveLength(1);
  expect(conversation.messages).toEqual([{ role: "user", text: "one" }]);
});

it("commits partial text when a turn ends in error", async () => {
  const { socket, conversation } = setup();
  const turn = conversation.send("hi");
  socket.deliver({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  });
  socket.deliver({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "partial" },
  });
  conversation.handleFrame({
    type: "error",
    requestId: socket.requestId,
    message: "boom",
  });
  await turn;

  expect(conversation.messages).toEqual([
    { role: "user", text: "hi" },
    { role: "assistant", text: "partial" },
  ]);
});

it("drops the assistant turn when no text arrived", async () => {
  const { socket, conversation } = setup();
  const turn = conversation.send("hi");
  conversation.handleFrame({ type: "done", requestId: socket.requestId });
  await turn;
  expect(conversation.messages).toEqual([{ role: "user", text: "hi" }]);
});
