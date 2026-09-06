import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage } from "@edulab/iso/protocol.ts";
import { expect, it } from "vitest";
import { interactionAt } from "./interactions.ts";
import type { Anchor } from "./selection.ts";
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
  get last(): ClientMessage {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error("nothing sent");
    return last;
  }
  private deliver(event: Anthropic.RawMessageStreamEvent) {
    const data = JSON.stringify({
      type: "event",
      requestId: this.last.requestId,
      event,
    });
    for (const listener of [...this.listeners]) {
      listener(new MessageEvent("message", { data }));
    }
  }
  /** Streams one assistant text block, leaving the turn open. */
  streams(text: string) {
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
  }
  replies(text: string) {
    this.streams(text);
    this.deliver({ type: "content_block_stop", index: 0 });
    this.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  }
}

const idx = (n: number) => n as MessageIdx;

function setup() {
  const socket = new FakeSocket();
  const root = new Thread(socket, { initialTurns: [] });
  const tree = new ThreadTree(socket, root, () => {});
  return { socket, tree, root };
}

it("captures a root turn with everything before it and nothing after", async () => {
  const { socket, tree, root } = setup();
  const first = root.send("how does backpressure work");
  socket.replies("it does not");
  await first;
  void root.send("and framing");
  socket.streams("well,");

  const interaction = interactionAt(tree, tree.root, idx(2));
  expect(interaction.text).toBe("and framing");
  expect(interaction.prefix.seed).toBeUndefined();
  expect(interaction.prefix.messages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
  ]);
});

it("captures a learning thread's ask as its message 0, with only the seed as prefix", () => {
  const { socket, tree, root } = setup();
  void root.send("the quick brown fox");
  const anchor: Anchor = {
    thread: tree.root,
    start: { msg: 0, offset: 0 },
    end: { msg: 0, offset: 9 },
  };
  const child = tree.open(anchor, { type: "explain" });
  void tree.get(child).thread.start();
  socket.replies("because");

  const interaction = interactionAt(tree, child, idx(0));
  expect(interaction.text).toContain('Selected: "the quick"');
  expect(interaction.prefix.messages).toEqual([]);
  expect(interaction.prefix.seed).toBe(tree.get(child).thread.seed);
  expect(interaction.prefix.seed).toContain("the quick brown fox");
});

it("shares a prefix between two interactions in the same thread", async () => {
  const { socket, tree, root } = setup();
  const first = root.send("first");
  socket.replies("ok");
  await first;
  const second = root.send("second");
  socket.replies("ok too");
  await second;
  void root.send("third");

  const firstAsk = interactionAt(tree, tree.root, idx(0));
  const secondAsk = interactionAt(tree, tree.root, idx(4));
  expect(
    secondAsk.prefix.messages.slice(0, firstAsk.prefix.messages.length),
  ).toEqual(firstAsk.prefix.messages);
  expect(secondAsk.prefix.messages).toEqual(
    tree.get(tree.root).thread.messages.slice(0, 4),
  );
});

it("refuses an address that is not a user turn", async () => {
  const { socket, tree, root } = setup();
  const turn = root.send("hi");
  socket.replies("hello");
  await turn;
  expect(() => interactionAt(tree, tree.root, idx(1))).toThrow();
  expect(() => interactionAt(tree, tree.root, idx(9))).toThrow();
});
