import { type Citation, parse, resolve } from "../citation.ts";
import {
  type GraphChange,
  type GraphEdge,
  type GraphNode,
  isNodeId,
  KnowledgeGraph,
  type NodeId,
} from "../graph.ts";
import { changesIn, readTools, writeTools } from "../graph-tools.ts";
import type {
  Chip,
  Citations,
  Msg as GraphMsg,
  Sidebar,
  Viewport,
} from "../graph-view.ts";
import { IDENTITY_VIEWPORT, panZoom } from "../graph-view.ts";
import { interactionAt } from "../interactions.ts";
import { layout, type Position } from "../layout.ts";
import {
  clearSnapshot,
  type InteractionAddress,
  interactionAddresses,
  loadSnapshot,
  saveSnapshot,
  toSnapshot,
} from "../persistence.ts";
import { GRAPH_UPDATE_SYSTEM, graphUpdatePrompt } from "../prompt.ts";
import {
  type SampleId,
  selectedSample,
  selectSample,
} from "../samples/index.ts";
import { overlaps, type ThreadId } from "../selection.ts";
import { type Message, type MessageIdx, runThread, Thread } from "../thread.ts";
import { ThreadTree } from "../threads.ts";
import { PostRenderEventBus } from "../vamp.ts";
import {
  type AppEvent,
  AppView,
  type GraphUpdate,
  type Msg,
  type State,
  type UpdatePaneState,
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
  const opened =
    socket.readyState === WebSocket.OPEN
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          socket.addEventListener("open", () => {
            resolve();
          });
        });
  const sample = selectedSample();
  const snapshot = loadSnapshot(sample?.id);
  // Scoped to the user, not to a thread: it outlives every thread in the tree
  // and is discarded only by a page load.
  const graph = snapshot
    ? KnowledgeGraph.from(snapshot.graph)
    : new KnowledgeGraph();
  const onChange = () => {
    refresh();
    view.sync(state);
    save();
  };
  const tree = snapshot
    ? ThreadTree.restore(
        socket,
        snapshot.threads,
        snapshot.root,
        snapshot.nextThreadId,
        onChange,
        (s) =>
          new Thread(socket, {
            system: s.system,
            seed: s.seed,
            initialTurns: [...s.log],
            // Not persisted: a thread's tools are a fact about what kind of
            // thread it is, and the root has none.
            tools: s.origin ? readTools(graph) : undefined,
          }),
      )
    : new ThreadTree(
        socket,
        new Thread(socket, { initialTurns: sample?.turns }),
        onChange,
      );
  // The thread on the left. Moved only by the arrows.
  let focus = tree.root;
  let sidebar: Sidebar = { type: "closed" };
  // Pan and zoom live beside the sidebar rather than in the view: the view
  // holds no state of its own, and a rebuild of the graph must not recentre it.
  let viewport: Viewport = IDENTITY_VIEWPORT;
  // Graph updates run one at a time: two in flight would each be handed the
  // pre-update graph and mint rival nodes for the same concept. Appending to
  // this chain is the whole serialization.
  let updates: Promise<void> = Promise.resolve();
  // What each interaction's update is doing, keyed by its address. Derived from
  // the update thread's own tool calls, so it cannot disagree with what the
  // model actually did.
  const address = (thread: ThreadId, index: MessageIdx) => `${thread}:${index}`;
  // Only finished updates are persisted: one that was still running when the
  // page went away comes back missing, which is what re-enqueues it.
  const graphUpdates = new Map<string, GraphUpdate>(
    (snapshot?.updates ?? []).map((u) => [
      address(u.thread, u.index),
      { type: "done", changes: u.changes, messages: u.messages },
    ]),
  );

  function save(): void {
    saveSnapshot(
      toSnapshot({
        sample: sample?.id,
        tree,
        graph,
        updates: [...graphUpdates].flatMap(([key, update]) => {
          if (update.type !== "done") return [];
          const [thread, index] = key.split(":");
          return [
            {
              thread: thread as ThreadId,
              index: Number(index) as MessageIdx,
              changes: update.changes,
              messages: update.messages,
            },
          ];
        }),
        build: state.build,
      }),
    );
  }
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
  // The shape a layout is currently being computed for, if any.
  let placing: string | null = null;
  // Purely presentational, and per thread: which messages the user has
  // expanded past the collapsed height.
  const expanded = new Map<ThreadId, Set<number>>();
  // The address of the graph update whose transcript the right pane is
  // reviewing, and the expansion state of its messages.
  let updateFocus: string | null = null;
  const updateExpanded = new Map<string, Set<number>>();
  function updateExpandedFor(key: string): Set<number> {
    let set = updateExpanded.get(key);
    if (!set) {
      set = new Set();
      updateExpanded.set(key, set);
    }
    return set;
  }
  function expandedFor(id: ThreadId): Set<number> {
    let set = expanded.get(id);
    if (!set) {
      set = new Set();
      expanded.set(id, set);
    }
    return set;
  }

  const state: State = {
    sample: sample?.id ?? "",
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
    graph: {
      status: "ready",
      nodes: [],
      edges: [],
      viewport,
      sidebar,
      citations: { description: [], notes: [] },
    },
    build: snapshot?.build ?? { type: "idle" },
    query: "",
    expanded: new Set(),
    updates: new Map(),
    child: null,
    updatePane: null,
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
    if (shape !== placedFor && shape !== placing) {
      placing = shape;
      // Deferred so the browser paints the pending state before the
      // simulation blocks the main thread. If the graph has moved on by the
      // time this lands, the next refresh schedules another run.
      setTimeout(() => {
        placement = layout(graph);
        placedFor = shape;
        placing = null;
        sync();
      }, 0);
    }
    const pending = shape !== placedFor;
    const at = (id: NodeId): Position =>
      placement.get(id) ?? { x: 0.5, y: 0.5 };
    state.graph = {
      status: pending ? "pending" : "ready",
      nodes: pending ? [] : nodes.map((n) => ({ ...n, pos: at(n.id) })),
      edges: pending
        ? []
        : edges.map((e) => ({ ...e, from_: at(e.from), to_: at(e.to) })),
      viewport,
      sidebar,
      citations: citationsOf(),
    };
  }

  /** The citations in the *saved* prose of whatever the sidebar has open. Read
   * off the graph rather than the draft: a half-typed address is not a
   * citation, and one that does not resolve against the tree is not either. */
  function citationsOf(): Citations {
    const chips = (text: string): Chip[] =>
      parse(text).flatMap((span) => {
        if (span.type !== "citation") return [];
        const quote = resolve(tree, span.citation);
        return quote === undefined ? [] : [{ citation: span.citation, quote }];
      });
    switch (sidebar.type) {
      case "closed":
        return { description: [], notes: [] };
      case "edge": {
        const edge = graph.edge(sidebar.id);
        return { description: chips(edge?.description ?? ""), notes: [] };
      }
      case "node": {
        const node = graph.node(sidebar.id);
        return {
          description: chips(node?.description ?? ""),
          notes: chips(node?.notes ?? ""),
        };
      }
    }
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
    state.updatePane = updatePane();
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

  /** The update transcript on the right, live while its thread is still
   * running: it is read straight off the same record the chips come from. */
  function updatePane(): UpdatePaneState | null {
    if (updateFocus === null) return null;
    const update = graphUpdates.get(updateFocus);
    if (!update) return null;
    return {
      messages: update.messages,
      running: update.type === "running",
      expanded: updateExpandedFor(updateFocus),
    };
  }

  function sync(): void {
    refresh();
    view.sync(state);
    save();
  }

  /** One detached thread per user interaction, writing straight into the graph
   * through its tools. Queued against every other update rather than run
   * concurrently, and never awaited by the user: the learning thread answers
   * them regardless, and a failure here is invisible outside the console. */
  function queueGraphUpdate(
    thread: ThreadId,
    index: MessageIdx,
  ): Promise<string | null> {
    const interaction = interactionAt(tree, thread, index);
    const key = address(thread, index);
    graphUpdates.set(key, { type: "running", messages: [] });
    // The update thread's transcript, as of its last change: the chips are read
    // off the calls it actually made, not off a side channel, and the same
    // transcript is what the review pane shows.
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
            graphUpdates.set(key, { type: "running", messages });
            sync();
          },
        });
        if (result.status === "error") {
          console.error(result.error);
          return String(result.error);
        }
        return null;
      })
      .catch((e: unknown) => {
        console.error(e);
        return String(e);
      })
      .then((error) => {
        graphUpdates.set(key, {
          type: "done",
          changes: changesOf(transcript),
          messages: transcript,
        });
        sync();
        return error;
      });
    updates = done.then(() => undefined);
    return done;
  }

  /** The sample's own turns: a loaded transcript is a session that happened
   * before this page existed, so no live update ever ran over it. Every turn
   * after these came from an interaction that updated the graph itself, so
   * enumerating once at mount is what keeps the build from double-counting. */
  const sampleTurnCount = (sample?.turns ?? []).filter(
    (t) => t.role === "user",
  ).length;
  const sampleInteractions: MessageIdx[] = tree
    .get(tree.root)
    .thread.messages.flatMap((m, i) =>
      m.role === "user" && m.type === "text" ? [i as MessageIdx] : [],
    )
    .slice(0, sampleTurnCount);

  function advanceBuild(key: string, error: string | null): void {
    const build = state.build;
    if (build.type !== "running") return;
    state.build = {
      type: "running",
      done: build.done + 1,
      total: build.total,
      failures:
        error === null
          ? build.failures
          : [...build.failures, { address: key, error }],
    };
  }

  function finishBuild(): void {
    const build = state.build;
    if (build.type !== "running") return;
    state.build = { type: "done", failures: build.failures };
  }

  /** Walks the loaded sample's turns through the same queue the live updates
   * use, so an interaction mid-build interleaves rather than races. */
  function runBuild(): void {
    if (state.build.type !== "idle") return;
    const total = sampleInteractions.length;
    if (total === 0) return;
    state.build = { type: "running", done: 0, total, failures: [] };
    void drain(
      sampleInteractions.map((index) => ({ thread: tree.root, index })),
    );
  }

  /** Pushes a backlog of interactions through the update queue, one at a time,
   * advancing the build indicator for the ones the build owns. */
  async function drain(
    addresses: ReadonlyArray<InteractionAddress>,
  ): Promise<void> {
    // A backlog is drained straight out of mount, before the socket has
    // finished connecting; every other send is behind a user action.
    await opened;
    const owned = new Set(sampleInteractions);
    for (const { thread, index } of addresses) {
      const error = await queueGraphUpdate(thread, index);
      if (thread === tree.root && owned.has(index))
        advanceBuild(address(thread, index), error);
      sync();
    }
    finishBuild();
    sync();
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

  /** A citation run forwards: focus the cited thread and put the cited message
   * in front of the user. Focusing a deep thread is just setting each
   * ancestor's `activeChild`, which is the same state a mark click sets, so
   * this introduces no second notion of focus. The scroll cannot happen here -
   * the pane is not showing that thread until after the sync - so it goes out
   * on the post-render bus. */
  function reveal(state: State, citation: Citation): void {
    const path = tree.path(citation.thread);
    path.forEach((id, i) => {
      const next = path[i + 1];
      if (next) tree.get(id).activeChild = next;
    });
    focus = citation.thread;
    state.split = path.length > 1;
    state.tab = "threads";
    state.anchor = null;
    state.query = "";
    updateFocus = null;
    bus.emit({ type: "transcript:reveal", index: citation.index });
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
      case "PAN":
      case "ZOOM":
      case "RESET_VIEW":
        viewport = panZoom(viewport, msg);
        break;
    }
  }

  /** Puts a background update's own transcript on the right. This is review,
   * not descent: nothing hangs off the pane, and closing it hands the right
   * column back to whatever was there. */
  function showUpdate(thread: ThreadId, index: number): void {
    const key = address(thread, index as MessageIdx);
    if (!graphUpdates.has(key)) return;
    updateFocus = key;
    state.split = true;
    state.anchor = null;
  }

  function update(state: State, msg: Msg): void {
    const node = tree.get(focus);
    switch (msg.type) {
      case "DRAFT_CHANGED":
        node.draft = msg.draft;
        break;
      case "SAMPLE_CHANGED":
        selectSample(msg.id === "" ? undefined : (msg.id as SampleId));
        break;
      case "RESET":
        clearSnapshot(sample?.id);
        window.location.reload();
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
        if (msg.msg.type === "CITATION_CLICKED")
          reveal(state, msg.msg.citation);
        else updateGraph(msg.msg);
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
        updateFocus = null;
        break;
      }
      case "GO_BACK": {
        const parent = node.origin?.anchor.thread;
        if (parent === undefined) state.split = false;
        else focus = parent;
        state.anchor = null;
        state.query = "";
        updateFocus = null;
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
        updateFocus = null;
        break;
      case "MARK_CLICKED":
        state.anchor = null;
        node.activeChild = msg.thread;
        updateFocus = null;
        break;
      case "SHOW_UPDATE":
        showUpdate(focus, msg.index);
        break;
      case "UPDATE_MSG":
        switch (msg.msg.type) {
          case "CLOSE":
            updateFocus = null;
            break;
          case "TOGGLE_EXPANDED": {
            if (updateFocus === null) break;
            const set = updateExpandedFor(updateFocus);
            if (!set.delete(msg.msg.index)) set.add(msg.msg.index);
            break;
          }
        }
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
          case "SHOW_UPDATE":
            showUpdate(activeChild, msg.msg.index);
            break;
        }
        break;
      }
    }
    refresh();
  }

  // Scroll and flash are the one thing that cannot live in a reducer or a
  // binding: they need the DOM to already reflect the new focus.
  const bus = new PostRenderEventBus<AppEvent>();

  let dispatching = false;
  function dispatch(msg: Msg): void {
    if (dispatching) throw new Error("dispatch-in-dispatch");
    dispatching = true;
    update(state, msg);
    view.sync(state);
    save();
    bus.flush();
    dispatching = false;
  }

  // e2e specs seed a known graph through this handle rather than driving the
  // extraction thread first, so the sidebar cases stay deterministic.
  (window as unknown as { __graph?: KnowledgeGraph }).__graph = graph;

  refresh();
  const view = new AppView(container, dispatch, state, { bus });

  // An interaction with no `done` update in the snapshot is one whose update
  // never landed - the page went away while it was running - so it is replayed
  // in the order it was first asked in.
  if (snapshot) {
    const pending = interactionAddresses(
      snapshot.threads,
      snapshot.root,
      snapshot.build.type !== "idle",
      sampleTurnCount,
    ).filter(({ thread, index }) => !graphUpdates.has(address(thread, index)));
    if (state.build.type === "running") {
      state.build = {
        type: "running",
        done: sampleInteractions.filter((index) =>
          graphUpdates.has(address(tree.root, index)),
        ).length,
        total: sampleInteractions.length,
        failures: [],
      };
    }
    if (pending.length > 0) void drain(pending);
    else {
      finishBuild();
      sync();
    }
  }
}
