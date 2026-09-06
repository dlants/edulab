import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage } from "@edulab/iso/protocol.ts";
import { expect, it } from "vitest";
import { KnowledgeGraph } from "./graph.ts";
import { readTools } from "./graph-tools.ts";
import type { Anchor } from "./selection.ts";
import { type Socket, Thread } from "./thread.ts";
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

  deliver(event: Anthropic.RawMessageStreamEvent) {
    const requestId = this.last.requestId;
    const data = JSON.stringify({ type: "event", requestId, event });
    for (const listener of [...this.listeners]) {
      listener(new MessageEvent("message", { data }));
    }
  }

  yields(input: Record<string, unknown>) {
    this.deliver({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call-1",
        name: "yield",
        input: {},
        caller: { type: "direct" },
      },
    });
    this.deliver({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
    });
    this.deliver({ type: "content_block_stop", index: 0 });
    this.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  }
}

const SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: { grade: { type: "string" } },
  required: ["grade"],
};

/** A tree whose root has one committed user turn, so there is something to
 * anchor a child onto. */
function setup() {
  const socket = new FakeSocket();
  const root = new Thread(socket, { initialTurns: [] });
  const tree = new ThreadTree(socket, root, () => {});
  void root.send("the quick brown fox");
  const anchor: Anchor = {
    thread: tree.root,
    start: { msg: 0, offset: 0 },
    end: { msg: 0, offset: 9 },
  };
  return { socket, tree, anchor };
}

it("passes a yield schema to a child and surfaces its settled value", async () => {
  const { socket, tree, anchor } = setup();
  const child = tree.open(anchor, { type: "quiz" }, { yieldSchema: SCHEMA });
  const turn = tree.get(child).thread.start();

  expect(socket.last.params.tools).toEqual([
    { name: "yield", description: expect.any(String), input_schema: SCHEMA },
  ]);

  socket.yields({ grade: "got it" });
  expect(await turn).toEqual({
    type: "yielded",
    value: { type: "structured", value: { grade: "got it" } },
  });
  expect(tree.result(child)).toEqual({
    type: "yielded",
    value: { type: "structured", value: { grade: "got it" } },
  });
});

it("seeds a child with context and sends the ask as its first visible turn", () => {
  const { socket, tree, anchor } = setup();
  const child = tree.open(anchor, { type: "explain" });
  const node = tree.get(child);
  void node.thread.start();

  const turns = socket.last.params.messages;
  expect(turns).toHaveLength(2);
  expect(turns[0]?.content).toBe(node.thread.seed);
  expect(turns[0]?.content).not.toContain("Selected:");
  expect(turns[1]?.content).toContain('Selected: "the quick"');

  // The seed stays hidden; the ask is the thread's own message 0.
  expect(node.thread.messages).toHaveLength(1);
  expect(node.thread.messages[0]).toMatchObject({
    role: "user",
    text: turns[1]?.content,
  });
});

it("offers no tools to a child opened without any", () => {
  const { socket, tree, anchor } = setup();
  const child = tree.open(anchor, { type: "explain" });
  void tree.get(child).thread.start();
  expect(socket.last.params.tools).toBeUndefined();
});

it("sends a child's tools on its first request, and none for the root task thread", () => {
  const { socket, tree, anchor } = setup();
  expect(socket.last.params.tools).toBeUndefined();
  const graph = new KnowledgeGraph();
  const child = tree.open(
    anchor,
    { type: "explain" },
    {
      tools: readTools(graph),
      graph: graph.render(),
    },
  );
  void tree.get(child).thread.start();
  expect(socket.last.params.tools?.map((t) => t.name)).toEqual(["get"]);
  expect(tree.get(child).thread.seed).toContain(graph.render());
});
