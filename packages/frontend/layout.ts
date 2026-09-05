import type { KnowledgeGraph, NodeId } from "./graph.ts";

export type Position = { x: number; y: number };

type Body = { id: NodeId; x: number; y: number; dx: number; dy: number };

const ITERATIONS = 300;
/** The side of the square the simulation runs in before normalization. */
const SIDE = 1;

/** Deterministic: same graph in, same positions out. Coordinates are
 * normalized to [0, 1] so the view scales them to the canvas. */
export function layout(graph: KnowledgeGraph): Map<NodeId, Position> {
  const ids = graph.nodes.map((n) => n.id).sort();
  if (ids.length === 0) return new Map();
  if (ids.length === 1)
    return new Map(ids.map((id) => [id, { x: 0.5, y: 0.5 }]));

  // Initial placement on a circle in id order: no Math.random, so the whole
  // simulation is a pure function of the graph.
  const bodies: Body[] = ids.map((id, i) => {
    const angle = (2 * Math.PI * i) / ids.length;
    return {
      id,
      x: SIDE / 2 + (SIDE / 2) * Math.cos(angle),
      y: SIDE / 2 + (SIDE / 2) * Math.sin(angle),
      dx: 0,
      dy: 0,
    };
  });
  const byId = new Map(bodies.map((b) => [b.id, b]));
  const edges = graph.edges.flatMap((e) => {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    return from && to ? [[from, to] as const] : [];
  });
  const k = Math.sqrt((SIDE * SIDE) / bodies.length);

  for (let step = 0; step < ITERATIONS; step++) {
    const temperature = (SIDE / 10) * (1 - step / ITERATIONS);
    for (const body of bodies) {
      body.dx = 0;
      body.dy = 0;
    }

    bodies.forEach((a, i) => {
      for (const b of bodies.slice(i + 1)) {
        const { ux, uy, dist } = unit(a, b, i);
        const force = (k * k) / dist;
        a.dx += ux * force;
        a.dy += uy * force;
        b.dx -= ux * force;
        b.dy -= uy * force;
      }
    });

    for (const [from, to] of edges) {
      const { ux, uy, dist } = unit(from, to, 0);
      const force = (dist * dist) / k;
      from.dx -= ux * force;
      from.dy -= uy * force;
      to.dx += ux * force;
      to.dy += uy * force;
    }

    for (const body of bodies) {
      const len = Math.hypot(body.dx, body.dy) || 1;
      const scale = Math.min(len, temperature) / len;
      body.x += body.dx * scale;
      body.y += body.dy * scale;
    }
  }

  return normalize(bodies);
}

/** Unit vector from `b` towards `a`, with a deterministic nudge when the two
 * land exactly on top of each other. */
function unit(
  a: Body,
  b: Body,
  seed: number,
): { ux: number; uy: number; dist: number } {
  let dx = a.x - b.x;
  let dy = a.y - b.y;
  let dist = Math.hypot(dx, dy);
  if (dist < 1e-6) {
    dx = 1e-4 * (seed + 1);
    dy = 1e-4;
    dist = Math.hypot(dx, dy);
  }
  return { ux: dx / dist, uy: dy / dist, dist };
}

/** Fit to [0, 1] on both axes independently; a degenerate axis collapses to
 * the middle rather than dividing by zero. */
function normalize(bodies: ReadonlyArray<Body>): Map<NodeId, Position> {
  const span = (values: number[]) => {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return (v: number) => (hi - lo < 1e-9 ? 0.5 : (v - lo) / (hi - lo));
  };
  const fitX = span(bodies.map((b) => b.x));
  const fitY = span(bodies.map((b) => b.y));
  return new Map(bodies.map((b) => [b.id, { x: fitX(b.x), y: fitY(b.y) }]));
}
