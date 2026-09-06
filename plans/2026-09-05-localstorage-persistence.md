# Objective and Context

> I want to start persisting the state of the app into LocalStorage. Particularly, the user interactions that happen on top of the sample transcripts, and also any knowledge graph constructions.
>
> We should persist:
>
> - The thread tree (anchors, native anthropic content - we can reconstruct the Messages on load)
> - The knowledge graph
> - info about the knowledge graph construction - which interactions have participated, tool calls that each interaction contributed.
>
> When we load the page, if we have a knowledge graph for a transcript but some interactions haven't been processed, assume that we refreshed while the interaction queue was still processing, and re-enqueue all unprocessed interactions in chronological order (interactions from the root thread go first, in sent order).
>
> The main goal here isn't perfect fidelity, but just not having to re-generate the graph every time I refresh, and being able to populate some additional interaction data.
>
> If some part of the data format changes, and we cannot load from LocalStorage, just drop all state and start fresh.
>
> Also, let's have a button to reset the transcript.

## The entities involved

- `Thread` (`thread.ts`) — owns `turns: Anthropic.MessageParam[]` (the wire log), plus `system`, `seed`, `tools`, `yieldSchema`. `messages: ReadonlyArray<Message>` is *derived* from the log by `project()`; nothing is ever converted back. `turns[0]` is the seed when a seed is present, and `messages` slices it off. Constructor takes `{ system, seed, initialTurns, tools, yieldSchema }` and sets `turns = [seed?, ...initialTurns]` — so **restoring a thread is just passing the persisted log as `initialTurns`**, with no new API on `Thread` beyond a getter for the committed log.
- `TreeNode` / `ThreadTree` (`threads.ts`) — `{ id, origin: { anchor, action } | null, thread, children, activeChild, draft }`, ids minted `t0`, `t1`, ... in creation order. `open()` builds a child's seed with `contextSeed(parent.seed, parent.messages, anchor, graph.render())` and its first turn with `askTurn(...)`.
- `KnowledgeGraph` (`graph.ts`) — private `#nodes`, `#edges`, `#next` (one id counter over both).
- `GraphUpdate` (`view.ts`) — `{ type: "running" } | { type: "done"; changes }`, held in `chat.ts` as `graphUpdates: Map<"<threadId>:<index>", GraphUpdate>`.
- `Build` (`view.ts`) — `idle | running | done`, the sample-transcript batch.
- `Interaction` (`interactions.ts`) — derived on demand from the tree by `interactionAt(tree, thread, index)`; not itself state.
- `Sample` (`samples/index.ts`) — `selectedSample()` reads `?sample=<id>`; switching sample is a page navigation.

## Files

- `packages/frontend/persistence.ts` — **new**. The snapshot types, `toSnapshot` / `restore`, and the localStorage read/write.
- `packages/frontend/persistence.test.ts` — **new**. Round-trip and re-enqueue tests.
- `packages/frontend/thread.ts` — expose the committed log.
- `packages/frontend/threads.ts` — expose the nodes, and add a restoring constructor path.
- `packages/frontend/graph.ts` — snapshot/restore of nodes, edges and the id counter.
- `packages/frontend/prototypes/chat.ts` — load at mount, save after every change, re-enqueue unprocessed interactions, handle `RESET`.
- `packages/frontend/view.ts` — the Reset button and its `Msg`; `State.sample` widens to `SampleId | undefined`.
- `packages/frontend/samples/index.ts` — brand `Sample.id` as `SampleId`, since it is now a storage key and not just a query param.
- `packages/e2e/tests/persistence.spec.ts` — **new**. Reload keeps the transcript and graph; Reset clears them.

# Design

## Storage shape

One key per sample: `edulab:v1:<sampleId>` (`edulab:v1:own` when no sample is selected), so switching sample — already a full page load — picks up that sample's own state and nothing else. The version is part of the key, so a bump orphans old data rather than having to migrate it.

Reads go through a single `load(key): Snapshot | null` that `JSON.parse`s, runs a shallow structural check, and returns `null` on any throw or mismatch — the caller then starts fresh and the stale key is removed. There is deliberately no migration path and no partial recovery: a snapshot is all-or-nothing.

Writes are debounced (~500ms trailing). `sync()` runs on every streamed token, and serializing the whole tree per token is pure waste; a trailing timer keeps the write off the streaming path while still landing promptly after a turn settles. A `QuotaExceededError` on write clears the key and warns — the prototype keeps running, it just stops persisting.

## What is persisted, and what is derived

Persisted: the thread tree's wire logs, origins, drafts, child links; the graph; the completed graph updates; the `Build` state. Everything else in `State` is either derived (`messages`, `marks`, `depth`) or purely presentational (`viewport`, `sidebar`, `expanded`, `tab`, `focus`, `anchor`) and is reconstructed at its default on load. Losing the viewport across a refresh is not worth a field.

A `{ type: "running" }` graph update is **not** persisted. That is the whole re-enqueue mechanism: an update that had not finished when the page went away is simply absent from the snapshot, and therefore shows up as unprocessed on load.

An update thread is never itself persisted — it lives outside the tree and only its *effects* are state. Its writes land in the graph as its tools run, and those are committed like any other graph write, so a refresh mid-update leaves a partially applied update behind: some of the interaction's concepts are in the graph, some are not, and the update record is missing. The re-run then sees its own partial writes as pre-existing graph content. This is why `GRAPH_UPDATE_SYSTEM` and `graphUpdatePrompt` are load-bearing here: the prompt already renders the current graph and offers update-in-place, so a re-run should converge on the same nodes rather than mint rivals. Worth re-reading `prompt.ts` against this case before wiring it up — the recovery story is "the second pass is close to a noop", not "we replay exactly once".

## Well-formedness on serialize

The API rejects a log whose last assistant turn has a `tool_use` with no matching `tool_result`, which is exactly the state a refresh mid-tool-call leaves behind. `toSnapshot` therefore trims trailing turns until every `tool_use` in the log is answered. A dangling trailing *user* turn is fine and is kept — it just never got a reply.

## Restore

1. Read the snapshot for the current sample. On `null`, build the tree from the sample as today.
2. Rebuild the graph from `snapshot.graph`, including `#next`, so newly minted ids cannot collide with restored ones.
3. Rebuild each `TreeNode` in id order: `new Thread(socket, { system, seed, initialTurns: log, tools, yieldSchema })`, where `tools` is `readTools(graph)` for a learning thread and undefined for the root. The seed is persisted verbatim rather than recomputed: `contextSeed` closes over the graph as it stood when the child was opened, and re-deriving it against today's graph would silently rewrite history.
4. Rebuild `graphUpdates` and `build` from the snapshot.

## Re-enqueue

An **interaction** is a user text turn in some thread: for the root, every `role === "user" && type === "text"` message; for a learning thread, its message 0 (the seeded ask) plus any user turns after it.

The sample's own turns are only in scope if a build was started: `snapshot.build.type !== "idle"`. Without that, the user simply never asked for the sample to be processed, and re-enqueuing it on load would build a graph they did not ask for.

On load, collect every in-scope interaction address with no `done` entry in `graphUpdates`, order them root-thread-first by message index, then the remaining threads in id order by message index, and push each through the existing `queueGraphUpdate`. That reuses the serialization chain, so a re-enqueued backlog and a live interaction interleave exactly as they do during a build. If a build was `running` when the page went away, it is restored as `running` with `done` set to the number of already-processed sample interactions, and the resume loop drives it to `done`.

## Reset

A `RESET` message: remove the key, then `window.location.reload()`. Reload rather than a re-mount for the same reason `selectSample` navigates — it is the only way to be sure no scrap of state survives.

## Interfaces

```ts
// persistence.ts
const VERSION = 1;

export type ThreadSnapshot = {
  id: ThreadId;
  origin: Origin | null;
  system: string;
  /** Held apart from `log` because `Thread` does: it is turn 0 of the wire
   * log and is never rendered, so restoring it as an ordinary turn would put
   * it in the transcript. */
  seed: string | Anthropic.ContentBlockParam[] | undefined;
  /** The committed turns after the seed. */
  log: Anthropic.MessageParam[];
  children: ThreadId[];
  activeChild: ThreadId | null;
  draft: string;
};

export type GraphSnapshot = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  next: number;
};

/** One finished graph update, keyed by the interaction that caused it.
 * Running updates are omitted, which is what makes them re-enqueue. */
export type UpdateSnapshot = {
  thread: ThreadId;
  index: MessageIdx;
  changes: GraphChange[];
};

export type Snapshot = {
  version: number;
  sample: SampleId | undefined;
  threads: ThreadSnapshot[];
  nextThreadId: number;
  root: ThreadId;
  graph: GraphSnapshot;
  updates: UpdateSnapshot[];
  build: Build;
};

/** The localStorage key, so nothing else can pass a bare string to the store. */
export type StorageKey = string & { readonly __brand: "StorageKey" };
/** `undefined` is the hand-written transcript, which keys as `own`. */
export function storageKey(sample: SampleId | undefined): StorageKey;
export function loadSnapshot(sample: SampleId | undefined): Snapshot | null;
export function saveSnapshot(snapshot: Snapshot): void;  // debounced
export function clearSnapshot(sample: SampleId | undefined): void;

/** Every user turn in the tree, root first, each thread in index order. */
export function interactionAddresses(
  threads: ReadonlyArray<ThreadSnapshot>,
  root: ThreadId,
  includeSampleTurns: boolean,
  sampleTurnCount: number,
): { thread: ThreadId; index: MessageIdx }[];
```

```ts
// thread.ts
/** The committed wire log, minus the seed turn: what a snapshot stores and
 * what `initialTurns` restores. */
get log(): ReadonlyArray<Anthropic.MessageParam>;
readonly systemPrompt: string;
```

```ts
// threads.ts
/** Every node, in creation order. */
nodes(): ReadonlyArray<TreeNode>;

/** Rebuilds a tree from snapshots rather than from a root thread. `threadOf`
 * mints the Thread for each snapshot, so the caller owns tool wiring. */
static restore(
  socket: Socket,
  snapshots: ReadonlyArray<ThreadSnapshot>,
  root: ThreadId,
  nextId: number,
  onChange: () => void,
  threadOf: (s: ThreadSnapshot) => Thread,
): ThreadTree;
```

```ts
// graph.ts
snapshot(): GraphSnapshot;
static from(snapshot: GraphSnapshot): KnowledgeGraph;
```

```ts
// samples/index.ts
export type SampleId = string & { readonly __brand: "SampleId" };
export type Sample = { id: SampleId; label: string; turns: Anthropic.MessageParam[] };
export function selectedSample(): Sample | undefined;
export function selectSample(id: SampleId | undefined): void;
```

```ts
// view.ts
| { type: "RESET" }
// State.sample and SAMPLE_CHANGED.id widen to `SampleId | undefined`; the
// empty-string sentinel for "write your own" only exists inside the <select>.
```

## Invariants

- A restored thread's `messages` must equal what it projected before the reload, so citations (`thread`, `index`) and anchors keep pointing at the same text. This is why the log is persisted verbatim rather than the derived `Message[]`.
- Thread ids and graph ids must never be re-minted over a restored id: `nextThreadId` and `graph.next` are persisted for exactly this.
- A persisted log is always API-valid: every `tool_use` has a matching `tool_result`.
- Only committed turns are persisted, so a user-facing thread that was mid-stream loses its partial assistant reply. It is not resumed: the transcript comes back as it stood before that request.
- An update thread's partial graph writes survive its lost update record. Re-running an interaction must be idempotent-ish at the prompt level, not at the storage level.
- An update that was `running` at save time is absent from the snapshot, and is therefore re-enqueued on load. Re-enqueuing an interaction twice is *safe* but wasteful — the update thread updates existing nodes rather than duplicating them — so correctness here is about not losing work, not about exactly-once.
- Sample turns are re-enqueued only when a build was started.
- Any parse failure, version mismatch or shape mismatch drops the whole key.
- Nothing in the snapshot is presentational: viewport, sidebar, tab, focus and expansion all reset on load.

# Stages

## graph and thread snapshots — DONE

Landed as `KnowledgeGraph.snapshot()` / `KnowledgeGraph.from()` (`graph.ts`),
`Thread.log` / `Thread.systemPrompt`, and `trimUnansweredTools` (`thread.ts`).

Deviation: the trimming helper lives in `thread.ts` beside the log rather than
in `persistence.ts` — it is a fact about wire-log validity, and `persistence.ts`
does not exist yet. `toSnapshot` will call it.

- Goal: `KnowledgeGraph` and `Thread` can each be taken apart and put back together with no loss.
- Tests (vitest, beside each module):
  - A graph with nodes, edges and deletions round-trips through `snapshot()` / `from()`, and a node created on the restored graph gets an id past every restored one.
  - A `Thread` driven through a text turn and a tool call (via the existing `FakeSocket`) round-trips through `log` + `initialTurns`: the restored thread's `messages` deep-equal the original's, and the next request it sends carries the full restored log.
  - A log whose last assistant turn has an unanswered `tool_use` is trimmed by `toSnapshot`; one whose trailing turn is a bare user turn is not.

## tree snapshot and restore — DONE

Landed as `ThreadTree.nodes()`, `ThreadTree.nextThreadId`, `ThreadTree.restore()`
(`threads.ts`), and the new `persistence.ts` holding `ThreadSnapshot`,
`UpdateSnapshot`, `Snapshot`, `threadSnapshots()` and `interactionAddresses()`.
`SampleId` is branded in `samples/index.ts`.

Deviations:

- `restore` builds through the ordinary constructor (minting the root thread
  once) and then replaces the node map, rather than bypassing the constructor.
  `root` is therefore an assignable field instead of `readonly`.
- `interactionAddresses` needs message indices, not turn indices, so `thread.ts`
  exports `projectLog(turns)` — `project` with nothing streaming.
- `threadSnapshots(tree)` lives in `persistence.ts` and is where
  `trimUnansweredTools` is applied; the full `toSnapshot` / `restore` pair and
  the localStorage read/write are stage 3.
- `sampleTurnCount` is counted in *interactions* (user turns), not turns, since
  that is the unit an address is in.

- Goal: `ThreadTree` round-trips, including a child thread with an origin anchor.
- Tests (`persistence.test.ts`):
  - [x] A tree with a root and two learning children, one of them active, round-trips: `path`, `marks`, `activeChild`, drafts, seeds and each thread's `messages` all match the original.
  - [x] A restored tree does not re-mint an id: the next child is `t3`.
  - [x] `interactionAddresses` returns the root's user turns in index order before any child's, and a child's seeded ask is address 0.
  - [x] With `includeSampleTurns: false`, addresses below `sampleTurnCount` in the root are excluded.

## wiring into the prototype — DONE

Landed as `storageKey` / `loadSnapshot` / `saveSnapshot` / `clearSnapshot` /
`toSnapshot` in `persistence.ts`, and the load-restore-save-re-enqueue wiring in
`prototypes/chat.ts`.

Deviations:

- `runBuild`'s loop became `drain(addresses)`, shared by the build and by the
  load-time backlog, with `advanceBuild` / `finishBuild` split out. The build
  indicator only advances for addresses the build owns (`sampleInteractions`).
- `drain` awaits the socket's `open` event first. Every other send is behind a
  user action, but a backlog is drained straight out of mount, and sending then
  throws `Still in CONNECTING state`.
- `sampleInteractions` is now the *first* `sampleTurnCount` user turns of the
  root rather than all of them: after a restore the root also holds the user's
  own turns, which the build does not own.
- A thread's tools are not persisted. `restore` gives `readTools(graph)` to any
  thread with an origin and none to the root, which is the only distinction the
  app makes.
- `clearSnapshot` exists but is unused until the reset button (stage 4).

- Goal: a refresh keeps the transcript, the graph, and the per-turn change chips; an interrupted build resumes.
- Tests (`packages/e2e/tests/persistence.spec.ts`, stubbed socket):
  - [x] Send a turn, wait for the graph update chip, reload: the transcript, the graph tab's nodes, and the chip are all still there, and no new API request goes out for the already-processed turn.
  - [x] Open a learning thread from a highlight, reload: the mark is still drawn over the parent and clicking it reopens the child with its transcript.
  - [x] An interaction whose update record is missing is re-enqueued on load, and the turn itself is not re-sent.
  - [x] A snapshot with a `running` build (seeded by rewriting the stored JSON in the page) resumes: the sample's interactions are requested and the build indicator reaches "built".
  - [x] Corrupt the stored JSON, load: the app comes up on the bare sample with an empty graph and the bad key is gone.

## reset button — DONE

Landed as the `RESET` `Msg` and a Reset button in the nav (`view.ts`), handled
in `chat.ts` by `clearSnapshot(sample?.id)` followed by
`window.location.reload()`.

Deviation: `State.sample` stayed a bare `string` (empty for "write your own")
rather than widening to `SampleId | undefined` — that only ever feeds the
`<select>`'s value, and `SAMPLE_CHANGED` already narrows on the way out.

- Goal: a Reset control in the nav clears this sample's stored state and reloads.
- Tests (e2e):
  - [x] After a turn and a graph node exist, clicking Reset returns the app to the bare sample transcript with an empty graph, and a further reload does not bring the old state back.
