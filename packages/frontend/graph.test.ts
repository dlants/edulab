import { expect, it } from "vitest";
import {
  type EdgeId,
  KnowledgeGraph,
  type Level,
  type NodeId,
} from "./graph.ts";

const addNode = (graph: KnowledgeGraph, title: string, level: Level = 1) => {
  const before = new Set(graph.nodes.map((n) => n.id));
  const result = graph.putNode({
    title,
    description: `about ${title}`,
    notes: "",
    level,
  });
  expect(result.status).toBe("ok");
  const added = graph.nodes.find((n) => !before.has(n.id));
  if (!added) throw new Error("node was not added");
  return added.id;
};

const addEdge = (
  graph: KnowledgeGraph,
  from: NodeId,
  to: NodeId,
  title: string,
) => {
  const before = new Set(graph.edges.map((e) => e.id));
  const result = graph.putEdge({ from, to, title, description: "" });
  expect(result.status).toBe("ok");
  const added = graph.edges.find((e) => !before.has(e.id));
  if (!added) throw new Error("edge was not added");
  return added.id;
};

it("cascades a node delete to the edges on both sides of it", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a");
  const b = addNode(graph, "b");
  const c = addNode(graph, "c");
  addEdge(graph, a, b, "in");
  addEdge(graph, b, c, "out");
  const result = graph.deleteNode(b);
  expect(result).toEqual({
    status: "ok",
    change: { op: "deleted", kind: "node", id: b, title: "b" },
  });
  expect(graph.edges).toEqual([]);
  expect(graph.nodes.map((n) => n.id)).toEqual([a, c]);
});

it("keeps the id and the edges when a node is retitled", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a");
  const b = addNode(graph, "b");
  const edge = addEdge(graph, a, b, "rel");
  expect(
    graph.putNode({
      id: a,
      title: "renamed",
      description: "",
      notes: "",
      level: 2,
    }).status,
  ).toBe("ok");
  expect(graph.node(a)?.title).toBe("renamed");
  expect(graph.edge(edge)).toMatchObject({ from: a, to: b });
  expect(graph.render()).toContain('"renamed"');
  expect(graph.render()).not.toContain('"a"');
});

it("rejects a title another node already uses, leaving the graph unchanged", () => {
  const graph = new KnowledgeGraph();
  addNode(graph, "a");
  const b = addNode(graph, "b");
  const result = graph.putNode({
    title: "a",
    description: "x",
    notes: "",
    level: 1,
  });
  expect(result.status).toBe("error");
  expect(graph.nodes.length).toBe(2);
  expect(
    graph.putNode({ id: b, title: "a", description: "", notes: "", level: 1 })
      .status,
  ).toBe("error");
  expect(graph.node(b)?.title).toBe("b");
});

it("rejects unknown ids and unknown endpoints", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a");
  const b = addNode(graph, "b");
  expect(
    graph.putNode({
      id: "n99" as NodeId,
      title: "x",
      description: "",
      notes: "",
      level: 1,
    }).status,
  ).toBe("error");
  expect(
    graph.putEdge({
      id: "e99" as EdgeId,
      from: a,
      to: b,
      title: "x",
      description: "",
    }).status,
  ).toBe("error");
  expect(
    graph.putEdge({
      from: a,
      to: "n99" as NodeId,
      title: "x",
      description: "",
    }).status,
  ).toBe("error");
  expect(graph.deleteNode("n99" as NodeId).status).toBe("error");
  expect(graph.deleteEdge("e99" as EdgeId).status).toBe("error");
  expect(graph.nodes.length).toBe(2);
  expect(graph.edges).toEqual([]);
});

it("never reuses an id", () => {
  const graph = new KnowledgeGraph();
  const first = addNode(graph, "a");
  graph.deleteNode(first);
  const second = addNode(graph, "a");
  const third = addNode(graph, "b");
  expect(new Set([first, second, third]).size).toBe(3);
});

it("allows several edges between the same pair, even with the same title", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a");
  const b = addNode(graph, "b");
  const one = addEdge(graph, a, b, "rel");
  const two = addEdge(graph, a, b, "rel");
  const back = addEdge(graph, b, a, "rel");
  expect(new Set([one, two, back]).size).toBe(3);
  expect(graph.edges.length).toBe(3);
});

it("rejects a self edge", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a");
  expect(
    graph.putEdge({ from: a, to: a, title: "self", description: "" }).status,
  ).toBe("error");
  expect(graph.edges).toEqual([]);
});

it("reports incident edges, endpoints and unknown ids from get", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a");
  const b = addNode(graph, "b");
  const inbound = addEdge(graph, b, a, "in");
  const outbound = addEdge(graph, a, b, "out");
  const nodeRecord = graph.get([a]);
  expect(nodeRecord).toContain(inbound);
  expect(nodeRecord).toContain(outbound);
  const edgeRecord = graph.get([outbound]);
  expect(edgeRecord).toContain(a);
  expect(edgeRecord).toContain(b);
  const mixed = graph.get([a, "n99" as NodeId]);
  expect(mixed).toContain("n99: not found");
  expect(mixed).toContain('"a"');
});

it("renders an empty graph as something a model can act on", () => {
  expect(new KnowledgeGraph().render()).toContain("empty");
});

it("round-trips through a snapshot, including the id counter", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a", 2);
  const b = addNode(graph, "b");
  const c = addNode(graph, "c");
  addEdge(graph, a, b, "leads to");
  graph.deleteNode(c);

  const restored = KnowledgeGraph.from(
    JSON.parse(JSON.stringify(graph.snapshot())),
  );
  expect(restored.nodes).toEqual(graph.nodes);
  expect(restored.edges).toEqual(graph.edges);

  const fresh = addNode(restored, "d");
  expect(graph.nodes.some((n) => n.id === fresh)).toBe(false);
  expect(restored.node(fresh)?.title).toBe("d");
});
