import {
  type GraphChange,
  type GraphEdge,
  type GraphNode,
  isNodeId,
  KnowledgeGraph,
  type NodeId,
} from "../graph.ts";
import { changesIn, readTools, writeTools } from "../graph-tools.ts";
import type { Msg as GraphMsg, Sidebar } from "../graph-view.ts";
import { interactionAt } from "../interactions.ts";
import { layout, type Position } from "../layout.ts";
import { GRAPH_UPDATE_SYSTEM, graphUpdatePrompt } from "../prompt.ts";
import { selectedSample, selectSample } from "../samples/index.ts";
import { overlaps, type ThreadId } from "../selection.ts";
import { type Message, type MessageIdx, runThread, Thread } from "../thread.ts";
import { ThreadTree } from "../threads.ts";
import {
  AppView,
  type GraphUpdate,
  type Msg,
  type State,
  type Updates,
} from "../view.ts";

/** The editable fields of a node or edge: the id addresses it, so it is not
 * part of what the sidebar edits. */
function draftOf(node: GraphNode): Omit<GraphNode, "id">;
function draftOf(edge: GraphEdge): Omit<GraphEdge, "id">;
function draftOf<T extends { id: string }>(item: T): Omit<T, "id"> {
  const { id: _id, ...rest } = item;
  return rest;
}

/** What an update thread did, read off its own transcript: a call that never
 * finished parsing or came back an error changed nothing, so it reports
 * nothing. */
function changesOf(
  messages: ReadonlyArray<Message>,
): ReadonlyArray<GraphChange> {
  return messages.flatMap((m) =>
    m.type === "tool_use" && m.call.input && m.call.result?.status === "ok"
      ? [...changesIn(m.call.result.text)]
      : [],
  );
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
  // Graph updates run one at a time: two in flight would each be handed the
  // pre-update graph and mint rival nodes for the same concept. Appending to
  // this chain is the whole serialization.
  let updates: Promise<void> = Promise.resolve();
  // What each interaction's update is doing, keyed by its address. Derived from
  // the update thread's own tool calls, so it cannot disagree with what the
  // model actually did.
  const graphUpdates = new Map<string, GraphUpdate>();
  const address = (thread: ThreadId, index: MessageIdx) => `${thread}:${index}`;
  function updatesFor(thread: ThreadId): Updates {
    const out = new Map<number, GraphUpdate>();
    for (const [key, update] of graphUpdates) {
      const [id, index] = key.split(":");
      if (id === thread) out.set(Number(index), update);
    }
    return out;
  }
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
    graph: { nodes: [], edges: [], sidebar },
    build: { type: "idle" },
    query: "",
    expanded: new Set(),
    updates: new Map(),
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
    state.updates = updatesFor(focus);
    state.activeMark = node.activeChild;
    const activeChild = node.activeChild;
    if (!activeChild) {
      state.child = null;
      return;
    }
    const child = tree.get(activeChild);
    state.child = {
      messages: child.thread.messages,
      inFlight: child.thread.inFlight,
      draft: child.draft,
      expanded: expandedFor(activeChild),
      updates: updatesFor(activeChild),
    };
  }

  function sync(): void {
    refresh();
    view.sync(state);
  }

  /** One detached thread per user interaction, writing straight into the graph
   * through its tools. Queued against every other update rather than run
   * concurrently, and never awaited by the user: the learning thread answers
   * them regardless, and a failure here is invisible outside the console. */
  function queueGraphUpdate(
    thread: ThreadId,
    index: MessageIdx,
  ): Promise<boolean> {
    const interaction = interactionAt(tree, thread, index);
    const key = address(thread, index);
    graphUpdates.set(key, { type: "running" });
    // The update thread's transcript, as of its last change: the chips are read
    // off the calls it actually made, not off a side channel.
    let transcript: ReadonlyArray<Message> = [];
    const done = updates
      .then(async () => {
        // Read inside the queued step, so this update sees the previous one's
        // writes rather than the graph as it stood when it was enqueued.
        const result = await runThread(socket, {
          system: GRAPH_UPDATE_SYSTEM,
          prompt: graphUpdatePrompt(interaction, graph.render()),
          tools: writeTools(graph),
          yieldSchema: "text",
          onChange: (messages) => {
            transcript = messages;
          },
        });
        if (result.status === "error") {
          console.error(result.error);
          return false;
        }
        return true;
      })
      .catch((e: unknown) => {
        console.error(e);
        return false;
      })
      .then((ok) => {
        graphUpdates.set(key, { type: "done", changes: changesOf(transcript) });
        sync();
        return ok;
      });
    updates = done.then(() => undefined);
    return done;
  }

  /** The sample's own turns: a loaded transcript is a session that happened
   * before this page existed, so no live update ever ran over it. Every turn
   * after these came from an interaction that updated the graph itself, so
   * enumerating once at mount is what keeps the build from double-counting. */
  const sampleInteractions: MessageIdx[] = tree
    .get(tree.root)
    .thread.messages.flatMap((m, i) =>
      m.role === "user" && m.type === "text" ? [i as MessageIdx] : [],
    );

  /** Walks the loaded sample's turns through the same queue the live updates
   * use, so an interaction mid-build interleaves rather than races. */
  function runBuild(): void {
    if (state.build.type !== "idle") return;
    const total = sampleInteractions.length;
    if (total === 0) return;
    state.build = { type: "running", done: 0, total, failed: 0 };
    void (async () => {
      for (const index of sampleInteractions) {
        const ok = await queueGraphUpdate(tree.root, index);
        const build = state.build;
        if (build.type !== "running") return;
        state.build = {
          type: "running",
          done: build.done + 1,
          total: build.total,
          failed: build.failed + (ok ? 0 : 1),
        };
        sync();
      }
      const build = state.build;
      state.build = {
        type: "done",
        failed: build.type === "running" ? build.failed : 0,
      };
      sync();
    })();
  }

  function send(id: ThreadId): void {
    const node = tree.get(id);
    const text = node.draft.trim();
    if (text === "" || node.thread.inFlight) return;
    node.draft = "";
    // Nothing is streaming while the thread is idle, so the turn lands at the
    // end of `messages` - which is its citable address.
    const index = node.thread.messages.length as MessageIdx;
    node.thread.send(text).then(undefined, (e: unknown) => {
      console.error(e);
    });
    void queueGraphUpdate(id, index);
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
      case "CHANGE_CLICKED":
        state.tab = "graph";
        updateGraph(
          isNodeId(msg.id)
            ? { type: "SELECT_NODE", id: msg.id }
            : { type: "SELECT_EDGE", id: msg.id },
        );
        break;
      case "GRAPH_MSG":
        updateGraph(msg.msg);
        break;
      case "SUBMIT":
        send(focus);
        break;
      case "BUILD":
        runBuild();
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
            void queueGraphUpdate(id, 0 as MessageIdx);
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
          case "CHANGE_CLICKED":
            update(state, msg.msg);
            break;
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
