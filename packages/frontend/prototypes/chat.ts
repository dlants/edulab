import {
  type GraphEdge,
  type GraphNode,
  KnowledgeGraph,
  type NodeId,
} from "../graph.ts";
import { readTools, writeTools } from "../graph-tools.ts";
import type { Build, Msg as GraphMsg, Sidebar } from "../graph-view.ts";
import { layout, type Position } from "../layout.ts";
import { actionLabel, EXTRACT_SYSTEM, renderTree } from "../prompt.ts";
import { selectedSample, selectSample } from "../samples/index.ts";
import { anchorText, overlaps, type ThreadId } from "../selection.ts";
import { Thread } from "../thread.ts";
import { ThreadTree } from "../threads.ts";
import { AppView, type Msg, type State } from "../view.ts";

/** The editable fields of a node or edge: the id addresses it, so it is not
 * part of what the sidebar edits. */
function draftOf(node: GraphNode): Omit<GraphNode, "id">;
function draftOf(edge: GraphEdge): Omit<GraphEdge, "id">;
function draftOf<T extends { id: string }>(item: T): Omit<T, "id"> {
  const { id: _id, ...rest } = item;
  return rest;
}

function connect(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/socket`);
}

/** Prototype 1: the task transcript, with learning threads hanging off the
 * passages the user picks out of it. */
export function mount(container: HTMLElement): void {
  // One socket for the whole app: every Thread adds its own
  // listener and drops frames whose requestId it does not own, so streams
  // interleave over the single connection.
  const socket = connect();
  // Scoped to the user, not to a thread: it outlives every thread in the tree
  // and is discarded only by a page load.
  const graph = new KnowledgeGraph();
  const tree = new ThreadTree(
    socket,
    new Thread(socket, { initialTurns: selectedSample()?.turns }),
    () => {
      refresh();
      view.sync(state);
    },
  );
  // The thread on the left. Moved only by the arrows.
  let focus = tree.root;
  let sidebar: Sidebar = { type: "closed" };
  // The extraction pass. Detached from the tree - it has no anchor and no
  // pane; the nodes appearing on the canvas are the only thing the user sees
  // of it.
  let build: Build = { type: "idle" };
  // The layout is a few hundred iterations, and refresh() runs on every
  // keystroke, so it is recomputed only when the shape of the graph changes.
  let placement = new Map<NodeId, Position>();
  let placedFor = "";
  // Purely presentational, and per thread: which messages the user has
  // expanded past the collapsed height.
  const expanded = new Map<ThreadId, Set<number>>();
  function expandedFor(id: ThreadId): Set<number> {
    let set = expanded.get(id);
    if (!set) {
      set = new Set();
      expanded.set(id, set);
    }
    return set;
  }

  const state: State = {
    sample: selectedSample()?.id ?? "",
    messages: [],
    inFlight: false,
    draft: "",
    split: false,
    depth: 0,
    canDescend: false,
    thread: focus,
    marks: [],
    activeMark: null,
    anchor: null,
    tab: "threads",
    graph: { nodes: [], edges: [], sidebar, build },
    query: "",
    origin: null,
    expanded: new Set(),
    child: null,
  };

  /** Re-projects the tree onto the view's state. Everything but the fields the
   * user is editing is derived, so this runs after every dispatch. */
  /** The graph projected onto view state: positions from `layout`, and the
   * sidebar the user is editing. */
  function refreshGraph(): void {
    const nodes = graph.nodes;
    const edges = graph.edges;
    const shape = [
      ...nodes.map((n) => n.id),
      ...edges.map((e) => `${e.id}:${e.from}->${e.to}`),
    ].join(",");
    if (shape !== placedFor) {
      placement = layout(graph);
      placedFor = shape;
    }
    const at = (id: NodeId): Position =>
      placement.get(id) ?? { x: 0.5, y: 0.5 };
    state.graph = {
      nodes: nodes.map((n) => ({ ...n, pos: at(n.id) })),
      edges: edges.map((e) => ({ ...e, from_: at(e.from), to_: at(e.to) })),
      sidebar,
      build,
    };
  }

  function refresh(): void {
    refreshGraph();
    const node = tree.get(focus);
    state.thread = focus;
    state.depth = state.split ? tree.path(focus).length : 0;
    state.canDescend = node.activeChild !== null;
    state.messages = node.thread.messages;
    state.inFlight = node.thread.inFlight;
    state.draft = node.draft;
    state.marks = tree.marks(focus);
    state.expanded = expandedFor(focus);
    const own = node.origin;
    state.origin = own
      ? {
          action: actionLabel(own.action),
          quote: anchorText(
            own.anchor,
            tree.get(own.anchor.thread).thread.messages,
          ),
        }
      : null;
    state.activeMark = node.activeChild;
    const activeChild = node.activeChild;
    if (!activeChild) {
      state.child = null;
      return;
    }
    const child = tree.get(activeChild);
    const origin = child.origin;
    state.child = {
      action: origin ? actionLabel(origin.action) : "",
      messages: child.thread.messages,
      inFlight: child.thread.inFlight,
      draft: child.draft,
      expanded: expandedFor(activeChild),
    };
  }

  function send(id: ThreadId): void {
    const node = tree.get(id);
    const text = node.draft.trim();
    if (text === "" || node.thread.inFlight) return;
    node.draft = "";
    node.thread.send(text).then(undefined, (e: unknown) => {
      console.error(e);
    });
  }

  /** One detached thread over the whole session, writing straight into the
   * graph through its tools. Its transcript is never rendered: a second pane
   * of prose nobody asked for would just be noise. */
  function runBuild(): void {
    if (build.type === "running") return;
    build = { type: "running" };
    const thread = new Thread(socket, {
      system: EXTRACT_SYSTEM,
      seed: renderTree(tree, graph.render()),
      tools: writeTools(graph),
    });
    const sync = () => {
      refresh();
      view.sync(state);
    };
    thread.onChange = sync;
    thread.start().then(
      (result) => {
        build =
          result.type === "error"
            ? { type: "error", error: result.message }
            : { type: "done" };
        sync();
      },
      (e: unknown) => {
        build = { type: "error", error: String(e) };
        sync();
      },
    );
  }
  /** The graph tab's own reducer. It writes to the graph and to `sidebar`;
   * everything the canvas shows is re-derived in refreshGraph(). */
  function updateGraph(msg: GraphMsg): void {
    switch (msg.type) {
      case "SELECT_NODE": {
        const node = graph.node(msg.id);
        if (!node) break;
        sidebar = {
          type: "node",
          id: node.id,
          draft: draftOf(node),
          error: null,
        };
        break;
      }
      case "SELECT_EDGE": {
        const edge = graph.edge(msg.id);
        if (!edge) break;
        sidebar = {
          type: "edge",
          id: edge.id,
          draft: draftOf(edge),
          error: null,
        };
        break;
      }
      case "CLOSE":
        sidebar = { type: "closed" };
        break;
      case "NODE_FIELD":
        if (sidebar.type === "node") sidebar.draft[msg.field] = msg.value;
        break;
      case "LEVEL_CHANGED":
        if (sidebar.type === "node") sidebar.draft.level = msg.level;
        break;
      case "EDGE_FIELD":
        if (sidebar.type === "edge") sidebar.draft[msg.field] = msg.value;
        break;
      case "SAVE": {
        if (sidebar.type === "closed") break;
        const result =
          sidebar.type === "node"
            ? graph.putNode({ id: sidebar.id, ...sidebar.draft })
            : graph.putEdge({ id: sidebar.id, ...sidebar.draft });
        // A rejected save keeps the draft, so the user's typing survives.
        sidebar.error = result.status === "error" ? result.error : null;
        break;
      }
      case "BUILD":
        runBuild();
        break;
      case "DELETE": {
        if (sidebar.type === "closed") break;
        if (sidebar.type === "node") graph.deleteNode(sidebar.id);
        else graph.deleteEdge(sidebar.id);
        sidebar = { type: "closed" };
        break;
      }
    }
  }

  function update(state: State, msg: Msg): void {
    const node = tree.get(focus);
    switch (msg.type) {
      case "DRAFT_CHANGED":
        node.draft = msg.draft;
        break;
      case "SAMPLE_CHANGED":
        selectSample(msg.id === "" ? undefined : msg.id);
        break;
      case "TAB_CHANGED":
        state.tab = msg.tab;
        break;
      case "GRAPH_MSG":
        updateGraph(msg.msg);
        break;
      case "SUBMIT":
        send(focus);
        break;
      case "GO_DEEPER": {
        if (!state.split) {
          state.split = true;
          break;
        }
        const child = node.activeChild;
        if (!child) break;
        focus = child;
        state.anchor = null;
        state.query = "";
        break;
      }
      case "GO_BACK": {
        const parent = node.origin?.anchor.thread;
        if (parent === undefined) state.split = false;
        else focus = parent;
        state.anchor = null;
        state.query = "";
        break;
      }
      case "TOGGLE_EXPANDED": {
        const set = expandedFor(focus);
        if (!set.delete(msg.index)) set.add(msg.index);
        break;
      }
      case "SELECTION_CHANGED":
        state.anchor = msg.anchor;
        node.activeChild = null;
        break;
      case "MARK_CLICKED":
        state.anchor = null;
        node.activeChild = msg.thread;
        break;
      case "LEARNING_MSG":
        switch (msg.msg.type) {
          case "ACTION": {
            const anchor = state.anchor;
            if (!anchor || overlaps(state.marks, anchor)) break;
            const id = tree.open(anchor, msg.msg.action, {
              tools: readTools(graph),
              graph: graph.render(),
            });
            state.anchor = null;
            state.query = "";
            tree
              .get(id)
              .thread.start()
              .then(undefined, (e: unknown) => {
                console.error(e);
              });
            break;
          }
          case "QUERY_CHANGED":
            state.query = msg.msg.query;
            break;
        }
        break;
      case "CHILD_MSG": {
        const activeChild = node.activeChild;
        if (!activeChild) break;
        switch (msg.msg.type) {
          case "DRAFT_CHANGED":
            tree.get(activeChild).draft = msg.msg.draft;
            break;
          case "SUBMIT":
            send(activeChild);
            break;
          case "TOGGLE_EXPANDED": {
            const set = expandedFor(activeChild);
            if (!set.delete(msg.msg.index)) set.add(msg.msg.index);
            break;
          }
        }
        break;
      }
    }
    refresh();
  }

  let dispatching = false;
  function dispatch(msg: Msg): void {
    if (dispatching) throw new Error("dispatch-in-dispatch");
    dispatching = true;
    update(state, msg);
    view.sync(state);
    dispatching = false;
  }

  // e2e specs seed a known graph through this handle rather than driving the
  // extraction thread first, so the sidebar cases stay deterministic.
  (window as unknown as { __graph?: KnowledgeGraph }).__graph = graph;

  refresh();
  const view = new AppView(container, dispatch, state);
}
