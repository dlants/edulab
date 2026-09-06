/** One id space over nodes and edges, so `get` takes a single list. */
export type GraphId = NodeId | EdgeId;
/** Minted by the graph (`n0`, `n1`, ...). Opaque; never derived from the title. */
export type NodeId = string & { readonly __brand: "NodeId" };
/** Minted by the graph (`e0`, `e1`, ...). */
export type EdgeId = string & { readonly __brand: "EdgeId" };

/** The agent's estimate, not a measurement. A misconception can look fluent,
 * so it belongs in `notes`, not here. */
export type Level = 1 | 2 | 3 | 4;
export const LEVELS = ["unfamiliar", "emerging", "working", "fluent"] as const;

export const levelLabel = (level: Level) => `${level} ${LEVELS[level - 1]}`;

export type GraphNode = {
  id: NodeId;
  /** Unique among nodes and non-empty, up to ~5 words. A label, not the key. */
  title: string;
  /** What the domain knowledge itself is. */
  description: string;
  /** The agent's read on this user's grasp of it, including misconceptions. */
  notes: string;
  level: Level;
};

export type GraphEdge = {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  /** 1-2 words. Several edges may join the same pair. */
  title: string;
  description: string;
};

/** One applied mutation. Structured rather than prose because it is read twice:
 * by the model, off the tool result, and by the transcript chip that reports
 * what a background graph update just did. */
export type GraphChange = {
  op: "created" | "updated" | "deleted";
  kind: "node" | "edge";
  id: GraphId;
  title: string;
};
export type GraphResult =
  | { status: "ok"; change: GraphChange }
  | { status: "error"; error: string };

/** The graph, flattened for storage. `next` travels with it so ids minted on a
 * restored graph cannot collide with restored ones. */
export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  next: number;
};
export const isNodeId = (id: string): id is NodeId => id.startsWith("n");
export const isEdgeId = (id: string): id is EdgeId => id.startsWith("e");

export class KnowledgeGraph {
  #nodes = new Map<NodeId, GraphNode>();
  #edges = new Map<EdgeId, GraphEdge>();
  #next = 0;

  get nodes(): ReadonlyArray<GraphNode> {
    return [...this.#nodes.values()];
  }

  get edges(): ReadonlyArray<GraphEdge> {
    return [...this.#edges.values()];
  }

  snapshot(): GraphSnapshot {
    return {
      nodes: [...this.#nodes.values()],
      edges: [...this.#edges.values()],
      next: this.#next,
    };
  }
  static from(snapshot: GraphSnapshot): KnowledgeGraph {
    const graph = new KnowledgeGraph();
    for (const node of snapshot.nodes) graph.#nodes.set(node.id, node);
    for (const edge of snapshot.edges) graph.#edges.set(edge.id, edge);
    graph.#next = snapshot.next;
    return graph;
  }
  node(id: NodeId): GraphNode | undefined {
    return this.#nodes.get(id);
  }

  edge(id: EdgeId): GraphEdge | undefined {
    return this.#edges.get(id);
  }

  /** Creates with a fresh id when `id` is omitted, updates in place when it is
   * given. Rejects an unknown id, an empty title, or a title already used by
   * another node. */
  putNode(node: Omit<GraphNode, "id"> & { id?: NodeId }): GraphResult {
    const title = node.title.trim();
    if (title === "") return { status: "error", error: "node title is empty" };
    if (node.id !== undefined && !this.#nodes.has(node.id))
      return { status: "error", error: `no node with id ${node.id}` };
    for (const other of this.#nodes.values())
      if (other.title === title && other.id !== node.id)
        return {
          status: "error",
          error: `title "${title}" is already used by node ${other.id}`,
        };
    const id = node.id ?? (`n${this.#next++}` as NodeId);
    this.#nodes.set(id, {
      id,
      title,
      description: node.description,
      notes: node.notes,
      level: node.level,
    });
    return {
      status: "ok",
      change: {
        op: node.id === undefined ? "created" : "updated",
        kind: "node",
        id,
        title,
      },
    };
  }

  /** Cascades to incident edges. */
  deleteNode(id: NodeId): GraphResult {
    const node = this.#nodes.get(id);
    if (!node) return { status: "error", error: `no node with id ${id}` };
    for (const edge of [...this.#edges.values()])
      if (edge.from === id || edge.to === id) this.#edges.delete(edge.id);
    this.#nodes.delete(id);
    return {
      status: "ok",
      change: { op: "deleted", kind: "node", id, title: node.title },
    };
  }

  /** Errors if either endpoint is unknown. */
  putEdge(edge: Omit<GraphEdge, "id"> & { id?: EdgeId }): GraphResult {
    const title = edge.title.trim();
    if (title === "") return { status: "error", error: "edge title is empty" };
    if (edge.id !== undefined && !this.#edges.has(edge.id))
      return { status: "error", error: `no edge with id ${edge.id}` };
    if (!this.#nodes.has(edge.from))
      return { status: "error", error: `no node with id ${edge.from}` };
    if (!this.#nodes.has(edge.to))
      return { status: "error", error: `no node with id ${edge.to}` };
    if (edge.from === edge.to)
      return {
        status: "error",
        error: "an edge may not join a node to itself",
      };
    const id = edge.id ?? (`e${this.#next++}` as EdgeId);
    this.#edges.set(id, {
      id,
      from: edge.from,
      to: edge.to,
      title,
      description: edge.description,
    });
    return {
      status: "ok",
      change: {
        op: edge.id === undefined ? "created" : "updated",
        kind: "edge",
        id,
        title,
      },
    };
  }

  deleteEdge(id: EdgeId): GraphResult {
    const edge = this.#edges.get(id);
    if (!edge) return { status: "error", error: `no edge with id ${id}` };
    this.#edges.delete(id);
    return {
      status: "ok",
      change: { op: "deleted", kind: "edge", id, title: edge.title },
    };
  }

  /** Everything about each id: a node with its incident edges in both
   * directions, or an edge with its endpoints. Unknown ids come back marked
   * as such rather than failing the batch. */
  get(ids: ReadonlyArray<GraphId>): string {
    return ids.map((id) => this.#record(id)).join("\n\n");
  }

  #record(id: GraphId): string {
    const node = this.#nodes.get(id as NodeId);
    if (node) {
      const incident = this.edges.filter(
        (e) => e.from === node.id || e.to === node.id,
      );
      return [
        `node ${node.id} "${node.title}" level ${levelLabel(node.level)}`,
        `description: ${node.description}`,
        `notes: ${node.notes}`,
        incident.length === 0
          ? "edges: (none)"
          : [
              "edges:",
              ...incident.map(
                (e) =>
                  `  ${e.id} "${e.title}" ${this.#label(e.from)} -> ${this.#label(e.to)}`,
              ),
            ].join("\n"),
      ].join("\n");
    }
    const edge = this.#edges.get(id as EdgeId);
    if (edge)
      return [
        `edge ${edge.id} "${edge.title}" ${this.#label(edge.from)} -> ${this.#label(edge.to)}`,
        `description: ${edge.description}`,
      ].join("\n");
    return `${id}: not found`;
  }

  #label(id: NodeId): string {
    const node = this.#nodes.get(id);
    return node ? `${id} "${node.title}"` : `${id} (missing)`;
  }

  /** The overview - one line per node and edge, id and title and level -
   * injected into the seed of any thread that needs it. An empty graph renders
   * as a line saying so, not as "". */
  render(): string {
    if (this.#nodes.size === 0 && this.#edges.size === 0)
      return "The knowledge graph is empty: it has no nodes and no edges yet.";
    return [
      "nodes:",
      ...this.nodes.map(
        (n) => `  ${n.id} "${n.title}" - ${levelLabel(n.level)}`,
      ),
      "edges:",
      ...(this.#edges.size === 0
        ? ["  (none)"]
        : this.edges.map((e) => `  ${e.id} "${e.title}" ${e.from} -> ${e.to}`)),
    ].join("\n");
  }
}
