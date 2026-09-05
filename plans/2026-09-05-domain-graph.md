# Objective and Context

Verbatim request:

> next up let's write a plan for the domain graph implementation:
>
> - nodes, edges. Both carry text.
> - each node carries-
>   - a short, unique title describing the domain (up to 5 words)
>   - text describing the domain knowledge
>   - the agent's notes about the user's understanding of that knowledge, also text
>   - a numeric score of the user's understanding. Let's do 4-point scale. I think there's a mastery scale that's something like novice/emerging/mastering/refining? What am I thinking of?
> - edges
>   - are identified by the from node, to node and id (multiple edges can connect 2 nodes)
>   - a short title explaining the edge (1-2 words)
>   - the full text of what the edge represents
> - the graph representation is a single artifact that is scoped to the user and lives outside any given thread
> - threads get access to the graph representation via tools for exploring the graph and editing the graph. I think we can just read the entire contents of the graph (these will be small in the prototype, we can think about progressive disclosure later). Modifying the graph is adding/deleting/modifying nodes and edges.
> - we gain UI for visualizing the graph - lay out the graph in 2d (pick a graph layout algo, something simple). Show just the node + edge titles. Clicking on a node pulls up a sidebar which shows the details and allows for editing. For now just edit the values of the selected node / edge (I think modifying the graph can be done via a chat interface later). Put this UI in a top-level tab. So our current view is "threads", and there's a new "knowledge graph" tab

## On the mastery scale

The existing mastery scales (Marzano, CBAM, the `Emerging / Developing / Proficient / Exemplary` rubric family) all grade *performance on a task*, which is not what we are scoring: this is *the agent's read on whether this user understands this concept*. The scale is:

    1 unfamiliar | 2 emerging | 3 working | 4 fluent

The labels are deliberately loose - the user, the mentor and the agent can interpret them in context. What matters is what the scalar is *for*:

- It is an index for sorting and colouring, not a measurement. The `notes` text carries the meaning.
- A misconception is not a low score. A confidently-held wrong belief reads as fluent. The scale cannot represent it, so misconceptions live in `notes`, and the prompt must say so explicitly.

## Entities

- `KnowledgeGraph` — the single artifact. In-memory, scoped to the page session (no persistence, per the demo constraints in `context.md`). Lives above the thread tree, not inside it.
- `GraphNode` — `{ title, description, notes, level }`. The title is the identity.
- `GraphEdge` — `{ from, to, title, description }`. Keyed by the triple.
- ``readTools(graph)` / `writeTools(graph)` — the `Record<ToolName, Tool>` handed to learning and extraction threads respectively.
- `layout(graph)` — pure `KnowledgeGraph -> Map<NodeId, {x, y}>`.
- `GraphView` — the new tab: canvas plus detail sidebar.

## Relevant files

- `packages/frontend/thread.ts` — `Thread`, and `Tool = { spec: Anthropic.Tool; execute(input): Promise<ToolResult> }`. Tools run client side; a thrown error is already caught and turned into an error `ToolResult`.
- `packages/frontend/threads.ts` — `ThreadTree.open(anchor, action, opts)` already accepts `opts.tools`. This is the injection point; no change to `Thread` is needed.
- `packages/frontend/prototypes/chat.ts` — the single `mount`/`dispatch` loop. Owns the tree; will own the graph too.
- `packages/frontend/view.ts` — `AppView`, the nav bar, and the two-pane body. Gains the tab strip and the tab slot.
- `packages/frontend/prompt.ts` — `LEARNING_SYSTEM` and `seedTurn`. Gains the graph instructions.
- `packages/frontend/vamp.ts` — `Binder`. Note `ref<T extends HTMLElement>` and `bindList` create children with `document.createElement`, so **SVG children are out of pattern**.
- `packages/frontend/learning.ts` — the model to copy for a new view module.
- `packages/e2e/tests/chat.spec.ts` — `page.routeWebSocket` stubbing, including a backend that emits a `tool_use` block.

# Design

Three new modules, one new tab, one prompt change.

**`graph.ts` — the artifact.** A plain class holding `Map<NodeId, GraphNode>` and `Map<EdgeId, GraphEdge>`, with mutation methods that return a discriminated result rather than throwing, so both the tool layer and the sidebar can surface failures the same way. No events, no subscriptions: the app has one dispatch loop and re-derives view state from the graph on every sync, exactly as it already does for the thread tree.

**Identity is an id.** Nodes and edges are keyed by minted opaque ids (`n0`, `e0`), not by their titles. Titles are user- and agent-facing labels that can be edited freely: a rename is a field write, not a cascade, and nothing can dangle. Titles are still required to be unique among nodes — that is what makes the graph readable and stops the agent from minting the same concept twice — but uniqueness is a validated invariant rather than the addressing scheme. The rendered graph shows each id next to its title so the model can address anything it has been shown, and `put_nodes`/`put_edges` create when `id` is omitted and update when it is given. Several edges may join the same pair; they simply have different ids.
`ToolName` is a brand introduced alongside `Tool` in `thread.ts`; `Thread`/`ThreadTree`'s existing `Record<string, Tool>` fields move to it in this stage.

**`graph-tools.ts` — the agent's hands.** Four tools, deliberately CRUD-shaped and boring. All of them take **batches**: a turn that maps out a subgraph should cost one round trip, not one per node.

- `get` — a list of ids, node or edge. Returns everything about each: for a node, its fields plus every incident edge in both directions; for an edge, its fields plus its endpoint ids. Unknown ids are reported per id rather than failing the call.
- `put_nodes` — a list; each entry creates when `id` is omitted and updates when it is given.
- `put_edges` — likewise. Nodes created by an earlier `put_nodes` call are addressable here, so a subgraph is two calls.
- `delete` — a list of ids of either kind; deleting a node cascades to its incident edges, and the result says how many went with it.

**Overview in the seed, detail on request.** `graph.render()` is a plain function, not a tool, and the caller injects its output into the thread's seed: a flat list of ids, titles and levels. That is cheap, always current at the start of the turn, and enough for the agent to know what exists. It is *not* enough to work from — models are bad at holding a symbolic structure in their head across a long conversation, and the descriptions and notes are the part that matters — so `get` exists to pull the full record for the handful of ids a turn actually touches. The single id space (`n0`, `e0`) is what lets `get` take one heterogeneous list rather than two.

Every failure is a `{ status: "error" }` `ToolResult` with a message the model can act on ("no node with id X"), never an exception. Every ok result carries the affected id back, so the model can address what it just created without re-reading anything.

Batching makes the failure mode the interesting part: an entry can fail while its neighbours succeed, so these are **not transactional**. Each tool applies what it can and returns a per-entry line — the new id, or why that entry was rejected — and the call as a whole is an ok `ToolResult` unless the *input* was unusable. A partial failure the model can see and fix beats an all-or-nothing rollback it has to reconstruct, and nothing here is worth a transaction log. No tool ever throws.

**Who gets what.** Learning threads get the whole graph rendered into their seed **and** the `get` tool, so they can pull the full record for anything the overview only names. What they do not get is any way to write to it: how the student model gets updated from a conversation is an open question (mid-turn? on thread close? by a separate pass?) and is deliberately not decided here. The mutation tools are used by the extraction thread of the last stage, which is the one path that writes. The root task thread gets nothing: `thread.ts`'s `SYSTEM` is deliberately task mode, and giving the task agent a student model to maintain would break the premise. All of this rides on `ThreadTree.open`'s existing `opts.tools`.

**`layout.ts` — positions.** A hand-rolled Fruchterman-Reingold: initial placement on a circle in id order, then a fixed number of iterations of repulsion between all pairs plus attraction along edges, with a linearly decaying temperature. No new dependency (the repo has none for this, and `context.md` forbids adding libraries casually), roughly 50 lines, and — crucially — **deterministic**, because the initial placement is derived from the sorted ids rather than from `Math.random()`. Determinism is what makes it testable and what stops the graph from jumping around when the agent adds a node. Fine at this scale; if the graph ever outgrows a few dozen nodes we swap the internals of one pure function.

**`graph-view.ts` — the tab.** Canvas plus sidebar.

- The canvas is a `position: relative` div. Each node is an absolutely-positioned div placed by `bindStyle`; each edge is a **rotated div** (a 1px-tall bar, `transform: rotate()`, `transform-origin: 0 50%`) with its title in a small label div at the midpoint. This is the one non-obvious call in the plan, and it is made to **stay inside vamp**: `bindList` builds children with `createElement`, and `Binder.ref` is typed to `HTMLElement`, so an SVG edge layer would mean either imperative DOM in `sync()` or widening vamp's types. Straight lines are all we need, so divs win. (If we later want curves or arrowheads, the fix is to teach `bindList` a namespace and widen `Ref` to `Element` — a real change, made deliberately, not smuggled in here.)
- Clicking a node or an edge selects it. The sidebar is a `Sidebar` state machine — closed, or open on a node or an edge with the draft it is editing — so "selected but no draft" is unrepresentable. It offers Save, Close and Delete, and a rejected save (a duplicate title) parks the message in the open state rather than discarding the user's typing. Editing is not live-on-keystroke: a half-typed title would be shown to the agent and would churn the layout on every character.
**Tabs.** `main.ts` keeps mounting one prototype, and `chat.ts` keeps its single dispatch loop — the tab is state, not a route. `State` gains `tab: "threads" | "graph"`, the nav bar gains two buttons, and the existing body is wrapped in a slot that switches between the current panes and `GraphView`. Making the tab a URL route would mean either a page load (which would discard the graph) or a second dispatch loop; neither is worth it.

## Interfaces

```ts
// graph.ts
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

export type GraphResult =
  | { status: "ok"; message: string }
  | { status: "error"; error: string };

export class KnowledgeGraph {
  get nodes(): ReadonlyArray<GraphNode>;
  get edges(): ReadonlyArray<GraphEdge>;
  node(id: NodeId): GraphNode | undefined;
  edge(id: EdgeId): GraphEdge | undefined;

  /** Creates with a fresh id when `id` is omitted, updates in place when it is
   * given. Rejects an unknown id, an empty title, or a title already used by
   * another node. */
  // Singular: the batching lives in the tool layer, which loops and collects
  // per-entry results. The graph has no reason to know about batches.
  putNode(node: Omit<GraphNode, "id"> & { id?: NodeId }): GraphResult;
  /** Cascades to incident edges. */
  deleteNode(id: NodeId): GraphResult;
  /** Errors if either endpoint is unknown. */
  putEdge(edge: Omit<GraphEdge, "id"> & { id?: EdgeId }): GraphResult;
  deleteEdge(id: EdgeId): GraphResult;

  /** Everything about each id: a node with its incident edges in both
   * directions, or an edge with its endpoints. Unknown ids come back marked
   * as such rather than failing the batch. */
  get(ids: ReadonlyArray<GraphId>): string;

  /** The overview - one line per node and edge, id and title and level -
   * injected into the seed of any thread that needs it. An empty graph renders
   * as a line saying so, not as "". */
  render(): string;
}
```

```ts
// graph-tools.ts
/** `get` only: what a learning thread gets. */
export function readTools(graph: KnowledgeGraph): Record<ToolName, Tool>;
/** `get`, `put_nodes`, `put_edges`, `delete`: what the extraction thread gets. */
export function writeTools(graph: KnowledgeGraph): Record<ToolName, Tool>;
```

```ts
// layout.ts
export type Position = { x: number; y: number };
/** Deterministic: same graph in, same positions out. Coordinates are
 * normalized to [0, 1] so the view scales them to the canvas. */
export function layout(graph: KnowledgeGraph): Map<NodeId, Position>;
```

```ts
// graph-view.ts
/** The sidebar is a small state machine: nothing selected, or a selection
 * together with the draft being edited. There is no state in which something
 * is selected and there is no draft, so the two are one field. */
export type Sidebar =
  | { type: "closed" }
  | { type: "node"; id: NodeId; draft: Omit<GraphNode, "id">; error: string | null }
  | { type: "edge"; id: EdgeId; draft: Omit<GraphEdge, "id">; error: string | null };

export type State = {
  nodes: ReadonlyArray<GraphNode & { pos: Position }>;
  edges: ReadonlyArray<GraphEdge & { from_: Position; to_: Position }>;
  sidebar: Sidebar;
};

/** `field` is keyed off what is open, so a message for the wrong kind of
 * selection does not typecheck. */
export type Msg =
  | { type: "SELECT_NODE"; id: NodeId }
  | { type: "SELECT_EDGE"; id: EdgeId }
  | { type: "CLOSE" }
  | { type: "NODE_FIELD"; field: "title" | "description" | "notes"; value: string }
  | { type: "LEVEL_CHANGED"; level: Level }
  | { type: "EDGE_FIELD"; field: "title" | "description"; value: string }
  | { type: "SAVE" }
  | { type: "DELETE" };
```

`view.ts` gains `tab: "threads" | "graph"` on `State`, a `{ type: "TAB_CHANGED" }` and a `{ type: "GRAPH_MSG"; msg: GraphMsg }` on `Msg`.

## Invariants

- Ids are minted by the graph, unique across nodes *and* edges, and never reused. Nothing outside `graph.ts` constructs one.
- Node titles are unique among nodes and non-empty. `putNode` rejects a collision rather than overwriting or silently duplicating; a retitle is an ordinary update and touches no edges.
- Every edge endpoint names an existing node. `putEdge` rejects unknown endpoints; `deleteNode` removes incident edges rather than leaving them dangling.
- A node is never its own neighbour by accident: self-edges are rejected, since a self-edge has no meaning in a domain map and would render as a zero-length bar.
- No tool ever throws. Every failure is an error `ToolResult` whose text tells the model how to recover.
- `layout` is a pure function of the graph and returns finite coordinates for every node, including isolated ones and an empty graph.
- The graph outlives every thread and both tabs. Switching tabs must not reset it; only a page load does (which also discards the threads, consistent with the existing sample-switch behaviour).
- The dispatch loop stays single: `GraphView` never holds its own dispatch, and the graph is re-projected onto view state in `refresh()` alongside the thread tree.

# Stages

## the graph artifact — DONE

Landed in `packages/frontend/graph.ts`, tested in `graph.test.ts`. All plan
tests written and green. Deviations: added `isNodeId`/`isEdgeId` helpers and a
`levelLabel` helper (both needed by the tool layer and the view later); the
node/edge id counter is shared, so ids are unique across both kinds as the
invariants require. Empty titles are rejected for edges too, not just nodes.

- Goal: `KnowledgeGraph` exists with its mutation methods and `render()`. Nothing consumes it yet.
- Tests (`graph.test.ts`):
  - Deleting a node removes the edges on both sides of it, and reports how many.
  - Retitling a node leaves its id and its edges untouched, and the new title is what `render()` shows.
  - `putNode` with a title another node already uses is an error, and the graph is unchanged.
  - `putNode`/`putEdge` with an unknown `id`, and `putEdge` to an unknown endpoint, are errors, and the graph is unchanged.
  - Ids are not reused: creating, deleting and creating again yields three distinct ids.
  - Two edges between the same pair coexist, including when their titles match.
  - A self-edge is rejected.
  - `get` of a node id returns its incident edges in both directions; of an edge id, its endpoints; of an unknown id, a marker rather than an error for the whole batch.
  - `render()` of an empty graph is something a model can act on rather than an empty string.

## tools

- Goal: a thread configured with `writeTools` can read and mutate the graph.
- Tests (`graph-tools.test.ts`):
  - Each tool's `execute` returns an ok result and the graph reflects it.
  - `get` with a mixed list of node and edge ids returns a record for each, in one call.
  - `put_nodes` with several entries applies them all in one call, and the result reports the new id for each.
  - A batch with one bad entry (unknown id, unknown endpoint, duplicate title) applies the good entries and reports the bad one; the call still comes back ok, and never throws.
  - Bad input at the call level (not a list, wrong `level`) comes back as an error `ToolResult` and never throws.
  - **The integration that matters**: drive a real `Thread` over the `FakeSocket` from `thread.test.ts`, stream a `put_nodes` tool call, and assert the node landed in the graph and the tool result the model receives says so. This is the seam where a schema/name mismatch would actually bite, so it is checked end to end rather than by calling `execute` directly.

## prompt and wiring

- Goal: learning threads opened from the transcript can read the graph, and use it to pitch their answer.
- `LEARNING_SYSTEM` gains: below is what we believe this user already understands; pitch your answer to it; call `get` for the full record of anything you are about to lean on. Nothing about writing — these threads do not.
- `seedTurn` gains the rendered overview as a section, so a learning thread starts already knowing what the user knows.
- Tests:
  - `prompt.test.ts`: the learning system prompt names `get` and the scale, and `seedTurn` includes the rendered graph.
  - `threads.test.ts`: a thread opened via `tree.open(anchor, action, { tools })` sends those specs on its first request (assert against `FakeSocket.sent`), and the root task thread sends none — the task agent must stay in task mode.

## layout

- Goal: `layout()` returns stable positions.
- Tests (`layout.test.ts`):
  - Same graph twice gives identical coordinates (this is the property the UI depends on; a `Math.random` seed would fail it).
  - Every coordinate is finite and within `[0, 1]`, for: the empty graph, one node, two disconnected nodes, a chain, and a star.
  - Two nodes joined by an edge end up closer than two nodes that are not, in a graph where both pairs exist. This is the only claim the algorithm actually makes; everything else about it is taste.

## the graph tab

- Goal: a "Knowledge graph" tab renders the graph, and clicking a node or edge opens an editable sidebar.
- Tests (`packages/e2e/tests/graph.spec.ts`, socket stubbed as in `chat.spec.ts`):
  - Switching to the tab and back leaves the transcript intact, and the graph intact.
  - Clicking a node fills the sidebar with its title, description, notes and level; editing the title and saving relabels the node on the canvas **and** leaves its edges attached — the retitle seen through the UI.
  - Delete removes the node and its edges from the canvas.
  - The sidebar edits are the only writes at this stage, so the tab is exercised against a graph built in the page's own code. The tool -> graph -> canvas path is tested in the next stage, which is where a writer actually exists.

## seeding the graph from the thread tree

- Goal: an empty graph tab is not a dead end. It shows a single **"Build from this session"** button that runs a detached extraction thread over the whole thread tree and fills the graph in.
- The extraction thread is **not** in `ThreadTree`. `open` requires an anchor, and this thread has no origin passage: it is about the session, not about a highlight. `chat.ts` constructs it directly — `new Thread(socket, { system: EXTRACT_SYSTEM, seed: renderTree(tree), tools: writeTools(graph) })` — holds it in `State` as `build: { status: "idle" | "running" | "done"; error?: string }`, and never renders its transcript. The user sees nodes appearing on the canvas, which is the actual output; a second transcript pane would just be noise.
- `prompt.ts` gains `EXTRACT_SYSTEM` and `renderTree(tree)`. `renderTree` walks the tree depth-first reusing the existing `transcript()` helper, labelling each child with its `actionLabel(origin.action)` and the anchor text it came from — the questions the user asked *are* the evidence about what they did not understand, so they must survive into the seed.
- `EXTRACT_SYSTEM`: extract the domains this session touched; one node per concept, not per file or per message; edges for the relationships that matter; set `level` from what the user's own questions and answers reveal, defaulting to `1 unfamiliar` for concepts they never engaged with; put misconceptions in `notes`. The current graph is rendered into the seed, so a re-run extends it rather than duplicating nodes.
- The button stays available (relabelled "Rebuild") once the graph is non-empty, so the extraction can be re-run after more conversation. It is disabled while running.
- Tests:
  - `prompt.test.ts`: `renderTree` on a root with one child includes the child's action label and its anchor text, and does not lose the root's own turns.
  - `packages/e2e/tests/graph.spec.ts`: with a stubbed backend that answers the extraction request with a `put_nodes` call and a `put_edges` call, clicking the button on an empty tab leaves two nodes and an edge on the canvas, and the threads tab is untouched. **The integration that matters** for this stage: the button is the only path in the product that exercises tools -> graph -> layout -> canvas without a human typing, so it is also the fastest way to evaluate the graph UI at all.

