import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage } from "@edulab/iso/protocol.ts";
import { expect, it } from "vitest";
import { KnowledgeGraph, type NodeId } from "./graph.ts";
import { readTools, writeTools } from "./graph-tools.ts";
import {
  type Socket,
  Thread,
  type ToolName,
  type ToolResult,
} from "./thread.ts";

function setup() {
  const graph = new KnowledgeGraph();
  const tools = writeTools(graph);
  const run = (name: string, input: Record<string, unknown>) => {
    const tool = tools[name as ToolName];
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(input);
  };
  return { graph, tools, run };
}

const text = (result: ToolResult) =>
  result.status === "ok" ? result.text : result.error;

it("readTools offers only get; writeTools offers the mutations too", () => {
  const graph = new KnowledgeGraph();
  expect(Object.keys(readTools(graph))).toEqual(["get"]);
  expect(Object.keys(writeTools(graph)).sort()).toEqual([
    "delete",
    "get",
    "put_edges",
    "put_nodes",
  ]);
});

it("applies a batch of nodes in one call and reports each new id", async () => {
  const { graph, run } = setup();
  const result = await run("put_nodes", {
    nodes: [
      { title: "closures", description: "d", notes: "n", level: 2 },
      { title: "scope", description: "d", notes: "n", level: 1 },
    ],
  });
  expect(result.status).toBe("ok");
  expect(text(result)).toContain("n0");
  expect(text(result)).toContain("n1");
  expect(graph.nodes.map((n) => n.title)).toEqual(["closures", "scope"]);
});

it("edges, get over a mixed list, and delete", async () => {
  const { graph, run } = setup();
  await run("put_nodes", {
    nodes: [
      { title: "a", description: "d", notes: "n", level: 1 },
      { title: "b", description: "d", notes: "n", level: 1 },
    ],
  });
  const edges = await run("put_edges", {
    edges: [{ from: "n0", to: "n1", title: "uses", description: "d" }],
  });
  expect(edges.status).toBe("ok");
  expect(graph.edges).toHaveLength(1);

  const got = await run("get", { ids: ["n0", "e2", "zz"] });
  expect(got.status).toBe("ok");
  expect(text(got)).toContain('node n0 "a"');
  expect(text(got)).toContain('edge e2 "uses"');
  expect(text(got)).toContain("zz: not found");

  const deleted = await run("delete", { ids: ["n0"] });
  expect(deleted.status).toBe("ok");
  expect(text(deleted)).toContain("1 incident edge");
  expect(graph.nodes).toHaveLength(1);
  expect(graph.edges).toHaveLength(0);
});

it("updates in place when an id is given", async () => {
  const { graph, run } = setup();
  await run("put_nodes", {
    nodes: [{ title: "a", description: "d", notes: "n", level: 1 }],
  });
  await run("put_nodes", {
    nodes: [{ id: "n0", title: "a", description: "d2", notes: "n2", level: 4 }],
  });
  expect(graph.nodes).toHaveLength(1);
  expect(graph.node("n0" as NodeId)?.level).toBe(4);
});

it("a bad entry does not stop its neighbours, and the call is still ok", async () => {
  const { graph, run } = setup();
  await run("put_nodes", {
    nodes: [{ title: "a", description: "d", notes: "n", level: 1 }],
  });
  const result = await run("put_nodes", {
    nodes: [
      { title: "a", description: "d", notes: "n", level: 1 },
      { id: "n99", title: "x", description: "d", notes: "n", level: 1 },
      { title: "b", description: "d", notes: "n", level: 1 },
    ],
  });
  expect(result.status).toBe("ok");
  expect(text(result)).toContain("entry 0: error:");
  expect(text(result)).toContain("entry 1: error:");
  expect(text(result)).toContain("entry 2: created");
  expect(graph.nodes.map((n) => n.title)).toEqual(["a", "b"]);

  const bad = await run("put_edges", {
    edges: [{ from: "n0", to: "n99", title: "t", description: "d" }],
  });
  expect(bad.status).toBe("ok");
  expect(text(bad)).toContain("entry 0: error:");
});

it("unusable input comes back as an error result rather than throwing", async () => {
  const { run } = setup();
  expect((await run("put_nodes", { nodes: "not a list" })).status).toBe(
    "error",
  );
  expect((await run("get", {})).status).toBe("error");
  expect((await run("delete", { ids: [] })).status).toBe("error");
  const level = await run("put_nodes", {
    nodes: [{ title: "a", description: "d", notes: "n", level: 7 }],
  });
  expect(text(level)).toContain('"level" must be');
});

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
  deliver(event: Anthropic.RawMessageStreamEvent) {
    const last = this.sent[this.sent.length - 1];
    if (!last) throw new Error("nothing sent");
    this.listener?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "event",
          requestId: last.requestId,
          event,
        }),
      }),
    );
  }
  calls(name: string, input: Record<string, unknown>) {
    this.deliver({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call-1",
        name,
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
  stops() {
    this.deliver({ type: "message_stop" } as Anthropic.RawMessageStreamEvent);
  }
}

it("a real thread streaming a put_nodes call writes to the graph", async () => {
  const graph = new KnowledgeGraph();
  const socket = new FakeSocket();
  const thread = new Thread(socket, { tools: writeTools(graph) });
  const turn = thread.send("map this out");
  socket.calls("put_nodes", {
    nodes: [{ title: "closures", description: "d", notes: "n", level: 3 }],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  socket.stops();
  await turn;

  expect(graph.nodes.map((n) => n.title)).toEqual(["closures"]);
  const call = thread.messages.find((m) => m.type === "tool_use");
  expect(call?.type === "tool_use" && call.call.result).toEqual({
    status: "ok",
    text: 'entry 0: created node n0 "closures"',
  });
  const names =
    socket.sent[0]?.type === "start"
      ? socket.sent[0].params.tools?.map((t) => t.name)
      : [];
  expect(names).toContain("put_nodes");
});
