import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage } from "@edulab/iso/protocol.ts";
import { expect, it } from "vitest";
import { anchorText, type ThreadId } from "./selection.ts";
import { type Socket, Thread } from "./thread.ts";

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

function toolCall(
  socket: FakeSocket,
  index: number,
  id: string,
  name: string,
  chunks: string[],
) {
  socket.deliver({
    type: "content_block_start",
    index,
    content_block: {
      type: "tool_use",
      id,
      name,
      input: {},
      caller: { type: "direct" },
    },
  });
  for (const partial_json of chunks) {
    socket.deliver({
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json },
    });
  }
}

function setup() {
  const socket = new FakeSocket();
  return { socket, thread: new Thread(socket) };
}

it("accumulates deltas into the streaming assistant message", async () => {
  const { socket, thread } = setup();
  const turn = thread.send("hi");
  expect(thread.messages).toEqual([{ type: "text", role: "user", text: "hi" }]);

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
  expect(thread.messages[1]).toEqual({
    type: "text",
    role: "assistant",
    text: "he",
  });

  socket.deliver({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "llo" },
  });
  socket.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  await turn;

  expect(thread.inFlight).toBe(false);
  expect(thread.messages).toEqual([
    { type: "text", role: "user", text: "hi" },
    { type: "text", role: "assistant", text: "hello" },
  ]);
});

it("sends the whole thread with alternating roles on the second turn", async () => {
  const { socket, thread } = setup();
  const first = thread.send("one");
  socket.stream(["1"]);
  await first;

  const second = thread.send("two");
  socket.stream(["2"]);
  await second;

  expect(thread.messages).toEqual([
    { type: "text", role: "user", text: "one" },
    { type: "text", role: "assistant", text: "1" },
    { type: "text", role: "user", text: "two" },
    { type: "text", role: "assistant", text: "2" },
  ]);
  expect(socket.sent[1]?.params.messages).toEqual([
    { role: "user", content: "one" },
    { role: "assistant", content: [{ type: "text", text: "1" }] },
    { role: "user", content: "two" },
  ]);
});

it("ignores send while a turn is in flight", () => {
  const { socket, thread } = setup();
  void thread.send("one");
  void thread.send("two");
  expect(socket.sent).toHaveLength(1);
  expect(thread.messages).toEqual([
    { type: "text", role: "user", text: "one" },
  ]);
});

it("commits partial text when a turn ends in error", async () => {
  const { socket, thread } = setup();
  const turn = thread.send("hi");
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
  thread.handleFrame({
    type: "error",
    requestId: socket.requestId,
    message: "boom",
  });
  await turn;

  expect(thread.messages).toEqual([
    { type: "text", role: "user", text: "hi" },
    { type: "text", role: "assistant", text: "partial" },
  ]);
});

it("sends the seed as turn 0 but never renders it", async () => {
  const socket = new FakeSocket();
  const thread = new Thread(socket, {
    system: "learning",
    seed: "the framing",
  });
  expect(thread.messages).toEqual([]);

  const first = thread.start();
  socket.stream(["hello"]);
  await first;
  expect(thread.messages).toEqual([
    { type: "text", role: "assistant", text: "hello" },
  ]);

  const second = thread.send("more");
  socket.stream(["ok"]);
  await second;
  for (const sent of socket.sent) {
    expect(sent.params.system).toBe("learning");
    expect(sent.params.messages[0]).toEqual({
      role: "user",
      content: "the framing",
    });
  }
});

it("surfaces a streamed tool call with its json parsed", async () => {
  const { socket, thread } = setup();
  const turn = thread.send("hi");
  toolCall(socket, 0, "t1", "read", ['{"path"', ':"a.txt"}']);
  socket.deliver({ type: "content_block_stop", index: 0 });
  socket.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  await turn;

  expect(thread.messages[1]).toEqual({
    type: "tool_use",
    role: "assistant",
    call: {
      id: "t1",
      name: "read",
      input: { path: "a.txt" },
      inputJson: '{"path":"a.txt"}',
      result: undefined,
    },
  });
});

it("projects text and a tool call in one turn as two entries", async () => {
  const { socket, thread } = setup();
  const turn = thread.send("hi");
  socket.deliver({
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "", citations: null },
  });
  socket.deliver({
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "reading it" },
  });
  socket.deliver({ type: "content_block_stop", index: 0 });
  toolCall(socket, 1, "t1", "read", ['{"path":"a.txt"}']);
  socket.deliver({ type: "content_block_stop", index: 1 });
  socket.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  await turn;

  expect(thread.messages.map((m) => m.type)).toEqual([
    "text",
    "text",
    "tool_use",
  ]);
  // The tool entry that follows must not disturb the offsets an anchor into
  // the prose above it already holds.
  expect(
    anchorText(
      {
        thread: "t" as ThreadId,
        start: { msg: 1, offset: 0 },
        end: { msg: 1, offset: 7 },
      },
      thread.messages,
    ),
  ).toBe("reading");
});

it("pairs a tool_result in the next user turn onto its call", async () => {
  const socket = new FakeSocket();
  const thread = new Thread(socket, {
    initialTurns: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "contents" },
        ],
      },
    ],
  });

  expect(thread.messages).toEqual([
    { type: "text", role: "user", text: "hi" },
    {
      type: "tool_use",
      role: "assistant",
      call: {
        id: "t1",
        name: "read",
        input: {},
        inputJson: "{}",
        result: { status: "ok", text: "contents" },
      },
    },
  ]);
});

it("leaves input undefined while the json is still streaming", async () => {
  const { socket, thread } = setup();
  const turn = thread.send("hi");
  toolCall(socket, 0, "t1", "read", ['{"path"']);

  const streaming = thread.messages[1];
  if (streaming?.type !== "tool_use") throw new Error("expected a tool call");
  expect(streaming.call.input).toBeUndefined();
  expect(streaming.call.inputJson).toBe('{"path"');

  // A stream cut short still has to commit something the API would accept, so
  // the unparsed input becomes {} in the log rather than throwing.
  thread.handleFrame({
    type: "error",
    requestId: socket.requestId,
    message: "boom",
  });
  await turn;
  const committed = thread.messages[1];
  if (committed?.type !== "tool_use") throw new Error("expected a tool call");
  expect(committed.call.input).toEqual({});
});

it("drops the assistant turn when no text arrived", async () => {
  const { socket, thread } = setup();
  const turn = thread.send("hi");
  thread.handleFrame({ type: "done", requestId: socket.requestId });
  await turn;
  expect(thread.messages).toEqual([{ type: "text", role: "user", text: "hi" }]);
});
