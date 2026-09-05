import { expect, it } from "vitest";
import { KnowledgeGraph, type NodeId } from "./graph.ts";
import { layout } from "./layout.ts";

const addNode = (graph: KnowledgeGraph, title: string): NodeId => {
  const before = new Set(graph.nodes.map((n) => n.id));
  expect(
    graph.putNode({ title, description: "", notes: "", level: 1 }).status,
  ).toBe("ok");
  const added = graph.nodes.find((n) => !before.has(n.id));
  if (!added) throw new Error("node was not added");
  return added.id;
};

const addEdge = (graph: KnowledgeGraph, from: NodeId, to: NodeId) => {
  expect(
    graph.putEdge({ from, to, title: "rel", description: "" }).status,
  ).toBe("ok");
};

const chain = (n: number) => {
  const graph = new KnowledgeGraph();
  const ids = Array.from({ length: n }, (_, i) => addNode(graph, `node ${i}`));
  ids.forEach((id, i) => {
    const previous = ids[i - 1];
    if (previous) addEdge(graph, previous, id);
  });
  return graph;
};

const star = (n: number) => {
  const graph = new KnowledgeGraph();
  const hub = addNode(graph, "hub");
  for (let i = 0; i < n; i++) addEdge(graph, hub, addNode(graph, `leaf ${i}`));
  return graph;
};

const disconnected = (n: number) => {
  const graph = new KnowledgeGraph();
  for (let i = 0; i < n; i++) addNode(graph, `node ${i}`);
  return graph;
};

it("is deterministic", () => {
  const graph = star(5);
  expect([...layout(graph)]).toEqual([...layout(graph)]);
});

it.each([
  ["empty", new KnowledgeGraph()],
  ["one node", disconnected(1)],
  ["two disconnected nodes", disconnected(2)],
  ["a chain", chain(5)],
  ["a star", star(6)],
])("returns finite coordinates in [0, 1] for %s", (_name, graph) => {
  const positions = layout(graph);
  expect(positions.size).toBe(graph.nodes.length);
  for (const p of positions.values()) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(1);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(1);
  }
});

it("places connected nodes closer than unconnected ones", () => {
  const graph = new KnowledgeGraph();
  const a = addNode(graph, "a");
  const b = addNode(graph, "b");
  const c = addNode(graph, "c");
  const d = addNode(graph, "d");
  addEdge(graph, a, b);
  addEdge(graph, c, d);

  const positions = layout(graph);
  const dist = (p: NodeId, q: NodeId) => {
    const pp = positions.get(p);
    const qq = positions.get(q);
    if (!pp || !qq) throw new Error("node was not laid out");
    return Math.hypot(pp.x - qq.x, pp.y - qq.y);
  };
  expect(dist(a, b)).toBeLessThan(dist(a, c));
  expect(dist(c, d)).toBeLessThan(dist(b, d));
});
