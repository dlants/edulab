import type Anthropic from "@anthropic-ai/sdk";
import {
  type EdgeId,
  type GraphChange,
  type GraphId,
  type GraphResult,
  isEdgeId,
  isNodeId,
  type KnowledgeGraph,
  LEVELS,
  type Level,
  type NodeId,
} from "./graph.ts";
import {
  type Tool,
  type ToolName,
  type ToolResult,
  toolset,
} from "./thread.ts";

/** Batches are not transactional: an entry that fails is reported on its own
 * line and its neighbours still apply, so the model can fix one entry rather
 * than reconstruct the whole call. Only unusable *input* fails the call. */
const ok = (lines: ReadonlyArray<string>): ToolResult => ({
  status: "ok",
  text: lines.join("\n"),
});
const err = (error: string): ToolResult => ({ status: "error", error });

const ID_LIST: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    ids: {
      type: "array",
      items: { type: "string" },
      description: "Node ids (n0, n1, ...) and/or edge ids (e0, e1, ...).",
    },
  },
  required: ["ids"],
};

const NODE_PROPERTIES = {
  id: {
    type: "string",
    description:
      "Omit to create a new node; give it to update an existing one.",
  },
  title: {
    type: "string",
    description: "Up to 5 words, unique among nodes.",
  },
  description: { type: "string", description: "What this knowledge is." },
  notes: {
    type: "string",
    description:
      "Your read on this user's grasp of it, including any misconceptions.",
  },
  level: {
    type: "integer",
    enum: [1, 2, 3, 4],
    description: LEVELS.map((label, i) => `${i + 1} ${label}`).join(", "),
  },
} as const;

const EDGE_PROPERTIES = {
  id: {
    type: "string",
    description:
      "Omit to create a new edge; give it to update an existing one.",
  },
  from: { type: "string", description: "Source node id." },
  to: { type: "string", description: "Target node id." },
  title: { type: "string", description: "1-2 words." },
  description: {
    type: "string",
    description: "What the relationship actually is.",
  },
} as const;

function list(input: Record<string, unknown>, key: string): unknown[] | string {
  const value = input[key];
  if (!Array.isArray(value)) return `"${key}" must be an array`;
  return value;
}

function entry(
  value: unknown,
  index: number,
): Record<string, unknown> | string {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : `entry ${index}: not an object`;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

function optionalId(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  return typeof value === "string" ? value : null;
}

function level(value: unknown): Level | undefined {
  return value === 1 || value === 2 || value === 3 || value === 4
    ? value
    : undefined;
}

/** An applied entry is a JSON line, so the transcript chip that reports what an
 * update did parses exactly what the tool returned rather than re-reading prose
 * nobody thinks of as a format. A rejected entry stays a sentence: it is
 * addressed at the model, which has to fix it. */
const line = (index: number, result: GraphResult): string =>
  result.status === "ok"
    ? JSON.stringify(result.change)
    : `entry ${index}: error: ${result.error}`;

/** The changes a tool result reports, for a caller watching a graph update
 * work. Anything that is not one of our JSON lines is prose for the model. */
export function changesIn(text: string): ReadonlyArray<GraphChange> {
  const out: GraphChange[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(raw) as GraphChange;
      if (typeof parsed.title === "string" && typeof parsed.id === "string")
        out.push(parsed);
    } catch {
      // Not ours; the model reads it, we do not.
    }
  }
  return out;
}

function getTool(graph: KnowledgeGraph): Tool {
  return {
    spec: {
      name: "get",
      description:
        "Read the full record for each id: a node with its description, notes, level and every incident edge, or an edge with its endpoints. Unknown ids are reported per id.",
      input_schema: ID_LIST,
    },
    execute: async (input) => {
      const ids = list(input, "ids");
      if (typeof ids === "string") return err(ids);
      if (ids.some((id) => typeof id !== "string"))
        return err("every id must be a string");
      if (ids.length === 0) return err('"ids" is empty');
      return { status: "ok", text: graph.get(ids as GraphId[]) };
    },
  };
}

function putNodesTool(graph: KnowledgeGraph): Tool {
  return {
    spec: {
      name: "put_nodes",
      description:
        "Create or update nodes in one call. An entry with no id creates a node and the result reports its new id; an entry with an id updates that node.",
      input_schema: {
        type: "object",
        properties: {
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: NODE_PROPERTIES,
              required: ["title", "description", "notes", "level"],
            },
          },
        },
        required: ["nodes"],
      },
    },
    execute: async (input) => {
      const nodes = list(input, "nodes");
      if (typeof nodes === "string") return err(nodes);
      if (nodes.length === 0) return err('"nodes" is empty');
      return ok(
        nodes.map((value, index) => {
          const node = entry(value, index);
          if (typeof node === "string") return node;
          const id = optionalId(node.id);
          if (id === null)
            return `entry ${index}: error: "id" must be a string`;
          if (id !== undefined && !isNodeId(id))
            return `entry ${index}: error: ${id} is not a node id`;
          const lvl = level(node.level);
          if (lvl === undefined)
            return `entry ${index}: error: "level" must be 1, 2, 3 or 4`;
          return line(
            index,
            graph.putNode({
              ...(id === undefined ? {} : { id: id as NodeId }),
              title: text(node.title),
              description: text(node.description),
              notes: text(node.notes),
              level: lvl,
            }),
          );
        }),
      );
    },
  };
}

function putEdgesTool(graph: KnowledgeGraph): Tool {
  return {
    spec: {
      name: "put_edges",
      description:
        "Create or update edges in one call. Nodes created by an earlier put_nodes call can be referenced here. Several edges may join the same pair of nodes.",
      input_schema: {
        type: "object",
        properties: {
          edges: {
            type: "array",
            items: {
              type: "object",
              properties: EDGE_PROPERTIES,
              required: ["from", "to", "title", "description"],
            },
          },
        },
        required: ["edges"],
      },
    },
    execute: async (input) => {
      const edges = list(input, "edges");
      if (typeof edges === "string") return err(edges);
      if (edges.length === 0) return err('"edges" is empty');
      return ok(
        edges.map((value, index) => {
          const edge = entry(value, index);
          if (typeof edge === "string") return edge;
          const id = optionalId(edge.id);
          if (id === null)
            return `entry ${index}: error: "id" must be a string`;
          if (id !== undefined && !isEdgeId(id))
            return `entry ${index}: error: ${id} is not an edge id`;
          if (typeof edge.from !== "string" || typeof edge.to !== "string")
            return `entry ${index}: error: "from" and "to" must be node ids`;
          return line(
            index,
            graph.putEdge({
              ...(id === undefined ? {} : { id: id as EdgeId }),
              from: edge.from as NodeId,
              to: edge.to as NodeId,
              title: text(edge.title),
              description: text(edge.description),
            }),
          );
        }),
      );
    },
  };
}

function deleteTool(graph: KnowledgeGraph): Tool {
  return {
    spec: {
      name: "delete",
      description:
        "Delete nodes and edges by id. Deleting a node also deletes every edge incident to it.",
      input_schema: ID_LIST,
    },
    execute: async (input) => {
      const ids = list(input, "ids");
      if (typeof ids === "string") return err(ids);
      if (ids.length === 0) return err('"ids" is empty');
      return ok(
        ids.map((id, index) => {
          if (typeof id !== "string")
            return `entry ${index}: error: id must be a string`;
          if (isNodeId(id)) return line(index, graph.deleteNode(id as NodeId));
          if (isEdgeId(id)) return line(index, graph.deleteEdge(id as EdgeId));
          return `entry ${index}: error: ${id} is not a node or edge id`;
        }),
      );
    },
  };
}

/** `get` only: what a learning thread gets. It reads the student model, it
 * never writes to it. */
export function readTools(graph: KnowledgeGraph): Record<ToolName, Tool> {
  return toolset(getTool(graph));
}

/** `get`, `put_nodes`, `put_edges`, `delete`: what the extraction thread gets. */
export function writeTools(graph: KnowledgeGraph): Record<ToolName, Tool> {
  return toolset(
    getTool(graph),
    putNodesTool(graph),
    putEdgesTool(graph),
    deleteTool(graph),
  );
}
