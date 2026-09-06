# Objective and Context

Verbatim request:

> I want to update the way we generate the knowledge graph from the session.
>
> - rather than pushing the entire thread tree in at once, I want to instead do a traversal of the threads one at a time. We will traverse each thread in the tree in a dfs order.
> - instead of pushing the whole thread it at once, I want to traverse every user interaction, and ask the agent to just reflect on that interaction in the context of the domain graph.
>
> - What are the relevant domain concepts that the user is interacting with here? Are they represented in the graph?
> - What understanding is the user demonstrating here? Make sure the relevant concepts are represented in the graph and our notes are up to date.
> - Does the interaction lead us to believe that the user lacks understanding or has a misconception about a concept?
> - focus on just the things that are relevant to his particular interaction.
> - keep the number of nodes and edges small and coarse. Only split concepts when it feels useful for representing some nuance about the user's understanding.
>
> We're going to use our programmatic thread interface for this

> I want to add emphasis on the agent grounding its notes about the user in the user's actual interactions - things the user wrote and interactions the user made (clicking "I don't understand this" for example). To do this, let's introduce a bit of DSL to the plaintext output - an agent can reference a thread + message id, via something like @message:threadId:messageId. When we render the text for a node (the node content or assistants notes about the user) we should render this as a link, so we can click it and navigate to the appropriate place in the thread tree. This means we need to provide the message with the threadId and messageId that the agent is currently looking at, which should be easy when we iterate.

> now that I see this - interactions in chronological order, at the moment the user does something. I'm realizing - we shouldn't do this as a batch on the graph page. We should just do it at the moment of interaction. So when the user performs an interaction we kick off the interaction thread (the one that exists now, that can read the domain graph and responds to the user), and we kick off a domain graph update thread (that runs in the background). I think the animation of domain graphs is appealing but not super relevant to this new mode.

This replaces the one-shot extraction that landed in `plans/2026-09-05-domain-graph.md`. That pass rendered the whole tree into one seed and asked a single thread to map the session: an enormous prompt whose output quality is unobservable, with no reason for the model to attend to any particular thing the user said. The unit of evidence about what a user understands is **one user interaction**, so that becomes the unit of extraction — and since it is one interaction, there is nothing to batch. Every interaction the user makes fans out into two threads: the learning thread that answers them, and a background graph update that updates the graph. The graph stops being a thing you go and build and becomes a thing that is simply true of the session so far.

## Entities

- `Interaction` — one user interaction, captured at the moment it happens: the thread it is in, its address, its text, and the thread's seed plus transcript up to that point. New; lives in `interactions.ts`.
- `GRAPH_UPDATE_SYSTEM` / `graphUpdatePrompt(interaction, graph)` — the per-interaction prompt, replacing `EXTRACT_SYSTEM` / `renderTree`.
- `runThread` (`thread.ts`) — the programmatic interface each graph update runs through; unattended, tools client side, settles on `yield`.
- `GraphUpdate` — the record of one background update, keyed by the address of the interaction that triggered it: its status and the changes it made. Owned by `chat.ts`, rendered in the transcript.
- `GraphChange` — one applied mutation as `chat.ts` reads it off the update thread's tool calls: created/updated/deleted, node/edge, title. Derived, not stored anywhere else.
- `Build` — the sample-transcript batch: `{ type: "idle" | "running" | "done"; done: number; total: number; failed: number }`. Moves from `graph-view.ts` to the header in `view.ts`.- `Citation` — `@message:<threadId>:<index>`, a reference from graph prose back into the transcript. Parsed by a new `citation.ts`; rendered as a chip in the sidebar; navigable.

## Relevant files

- `packages/frontend/prototypes/chat.ts` — the single dispatch loop; owns the tree and the graph, and `runBuild()`. The one wiring point: `SUBMIT` and `ACTION` gain a graph update alongside what they already do, and `runBuild` is deleted.
- `packages/frontend/threads.ts` — `ThreadTree`, `TreeNode { origin, thread, children }`, `open(anchor, action, opts)`. Unchanged.
- `packages/frontend/thread.ts` — `runThread(socket, { prompt, system, tools, yieldSchema })`, `Thread`, `Message`. `prompt`/`seed` widen to accept content blocks.
- `packages/frontend/prompt.ts` — owns `EXTRACT_SYSTEM`, `renderTree`, `transcript`, `line`, `actionLabel`. The first two are replaced here; the rest is reused.
- `packages/frontend/selection.ts` — `Anchor`, `anchorText`, `ThreadId`.
- `packages/frontend/graph.ts` / `graph-tools.ts` — `KnowledgeGraph.render()`, `writeTools(graph)`. Unchanged.
- `packages/frontend/graph-view.ts` — the toolbar and `Build` (the "Build from this session" button and its status line), which move out of this file and into the header; the sidebar, which gains citation chips.
- `packages/frontend/samples/index.ts` — `selectedSample()`, `selectSample()`. The sample whose turns the build walks.
- `packages/frontend/view.ts` — `AppView`, the nav bar, `MARK_CLICKED`. Gains message-level focus so a citation can land on a message.
- `packages/e2e/tests/graph.spec.ts` — stubs the socket and asserts the tools -> graph -> canvas path.

# Design

**Graph update happens at the moment of interaction.** The user submits a turn or clicks "I don't understand this"; `chat.ts` does what it already does, and *additionally* builds an `Interaction` from what it has right there in the dispatch — the focused thread, the index the turn landed at, the text — and hands it to a background graph update. No traversal, no timestamps, no ordering problem: the knowledge graph update threads happen in the order the user acts, because they *are* the user acting. The batch design needed timestamps stamped onto every turn purely to reconstruct an order that this design gets for free.

This covers the **root task thread** as well as the learning threads. What the user asks the agent to do, and how they ask for it, is evidence about what they know: the framing of a task request, the vocabulary in it, the constraints they thought to state and the ones they did not. Nothing about the mechanism is specific to learning mode — any user turn anywhere in the tree gets a graph update.

**Note for the deliverable: participation is elective and explicit.** Everything above describes a system that silently builds a model of a person from everything they type, which is not a thing you may switch on for someone. In the shipped form the user opts in, sees that the graph exists, can read every note about them and the interaction each note cites (which is part of why citations are in this plan at all), and can turn it off or delete it. This prototype triggers updates unconditionally because the demo has one user, no persistence and a page-load lifetime, and because a consent gate in front of the interesting behaviour makes the demo worse without teaching us anything. That is a deliberate scaffolding shortcut in the same family as "no auth, no database", and it belongs in the presentation as a stated constraint rather than as an oversight.

The two threads are peers, not nested. The learning thread answers the user and reads the graph; the graph update thread writes to the graph and is never rendered. Neither waits on the other, and the user's answer is never delayed by bookkeeping.

**Knowledge graph update threads are serialized.** They are kicked off concurrently with the learning thread but queued against *each other*: `chat.ts` keeps a promise chain and appends to it, so update N+1 starts only once N has settled. Two knowledge graph update threads in flight would each be handed the pre-update graph overview and would happily mint rival nodes for the same concept, which is the exact failure the graph-in-the-prompt exists to prevent. A user who types faster than the model can keep up just builds a short queue; nothing is dropped and nothing is shown to them about it.

**Context is the whole thread prefix.** The cheap thing — sending only the turn and a window around it — is an optimization, and optimizing before we know whether the model can produce good notes at all is backwards. So a graph update sees everything that led to the interaction: its thread's seed and its transcript from the top. The interaction ends at the user's turn; what the agent says back is not evidence about the user, and the updating thread runs the same model, so it can infer the shape of the reply without being shown it. Quadratic in tokens over a thread, and at prototype scale affordable.

**A learning thread's ask becomes its message 0.** Today `seedTurn` bundles three things into one hidden turn: the parent's transcript up to the anchor, the passage the user highlighted, and what they asked of it. Only the first is context; the other two are the interaction, and burying them in the seed is what forced an "opening" to be a special kind of interaction addressed at somebody else's message. So the seed keeps the context — parent transcript, graph overview — and the highlighted passage plus the ask are pushed as the thread's first *visible* user turn. `ThreadOpts` already has both `seed` and `initialTurns`; they stop being mutually exclusive, `turns` becomes `[seed, ...initialTurns]` and `messages` drops only the seed.

That buys three things at once. Every interaction is now literally a message in the thread it happened in, so `Interaction` is `{ thread, index }` with no branch and citations have nothing special to say about openings. The transcript shows the user's own ask at the top of the learning pane, which is more honest than the origin header rendering it as chrome. And the seed stays exactly the cacheable part, which is what the prompt structure wanted anyway.

`Thread.messages` still hides the seed, so an interaction reads `thread.seed` directly for its prefix.

**The prompt is prefix-stable.** In order: base prompt, the thread's seed, the transcript prefix, the knowledge graph overview, the turn under the microscope, the questions. Everything through the transcript prefix is shared with every earlier interaction in that thread; everything from the graph on is volatile, because the previous graph update just rewrote the graph. Putting the graph before the transcript would make every graph update a cache miss.

To actually get the cache hit, `graphUpdatePrompt` returns content blocks rather than one string: base prompt, seed and prefix as one text block carrying `cache_control: { type: "ephemeral" }`, the volatile tail as a second. `RunThreadOpts.prompt` and `ThreadOpts.seed` widen from `string` to `string | Anthropic.ContentBlockParam[]`; `Thread.messages` already drops the seed, so nothing renders it. The backend forwards `MessageCreateParams` unexamined, so nothing there changes.

**The prompt is a graph update, not an extraction.** `GRAPH_UPDATE_SYSTEM` reframes the job: you are looking at one interaction, in the context of a graph that already exists; what domain concepts does it touch, are they in the graph, what understanding did the user demonstrate, and does anything here read as a gap or a misconception. Then the restraint clauses, which are what actually control output size: touch only what this interaction is about; keep the graph small and coarse; split a concept only when the split expresses something real about this user's understanding; a concept the user merely brushed past does not need a node.

**Doing nothing is a valid outcome.** Most interactions are not evidence: "yes", "keep going", "actually use postgres" tell us nothing about what the user understands. `GRAPH_UPDATE_SYSTEM` says so explicitly — if this interaction does not reveal anything, change nothing and yield — because a model handed a graph, a set of write tools and a turn will otherwise find something to write, and a graph that grows on every keystroke is worse than one that grows on the dozen turns that mattered. The yield tool is the exit either way, so a no-op costs one round trip and leaves no trace.

**Citations ground the notes.** A note that says "shaky on websocket framing" is unfalsifiable; a note that says it and points at the turn where the user said so is evidence. Every rendered transcript block carries its address — `@message:t0:3`, the thread id the tree already mints plus the index into `Thread.messages` — and `GRAPH_UPDATE_SYSTEM` requires that a claim about the user's understanding cite the interaction it came from. The address is free: the dispatch knows exactly which thread and index it is looking at.

The DSL is deliberately one token with no delimiters or link text. It survives round-tripping through a textarea, the model cannot get the syntax subtly wrong, and a stale or malformed reference degrades to literal text rather than to a broken render.

**Rendering: chips beside the field, not links inside it.** The sidebar edits `description` and `notes` in textareas, and a textarea cannot contain a link. Rather than build a rich-text editor for a prototype, each field gets a row of citation chips below it, one per reference in the *saved* text, labelled with the quote it points at (truncated). This stays inside vamp's `bindList`, keeps editing plain-text, and is arguably better than inline links: the chips are a bibliography for the claim.

**Navigation.** Clicking a chip switches to the threads tab, focuses the cited thread, and scrolls its transcript to the cited message with a brief flash. Focusing a deep thread means walking `tree.path(id)` and setting each ancestor's `activeChild`, which is what the two-pane layout reads — the same state `MARK_CLICKED` already manipulates, so no new notion of focus is introduced. A citation that does not resolve renders as inert text; nothing in the graph is validated against the tree.

The scroll is the one bit that cannot live in a reducer or a binding: it has to happen after the DOM reflects the new focus. `vamp.ts` already carries `PostRenderEventBus` and `scrollIntoView` from gatherus, unused so far. `chat.ts` creates a bus, flushes it at the end of `dispatch`, and `CITATION_CLICKED` emits `{ type: "transcript:reveal", thread, index }`; the transcript view subscribes and scrolls. That is what the bus is for, and it keeps `sync()` free of imperative DOM.

**The update is visible where it happened.** A background thread quietly writing a model of the user is exactly the thing the consent note objects to, so the transcript shows it: while the update for a turn is in flight, a small chip sits under that turn saying so, and when it settles the chip lists what it did — `created "TCP backpressure"`, `updated "websocket framing"`, `deleted "streaming"` — or says it made no changes, which is the common case and worth showing precisely because it is. The chips are the honest version of the animation the batch design had: not nodes appearing on a canvas nobody is looking at, but a running account, next to the thing that caused it, of what the system just concluded about the user.

The mechanism is the thread itself, not a side channel through the tools. `runThread` already builds a `Thread`, and a `Thread` already exposes `messages` and `onChange`; it just keeps both to itself. So `RunThreadOpts` gains `onChange?: (messages: ReadonlyArray<Message>) => void`, forwarded to the thread it constructs. The consumer sees the tool calls land — name, parsed input, result — and derives whatever it wants from them: `chat.ts` maps `put_nodes`/`put_edges`/`delete` calls onto chips, and anything else that ever wants to watch a background thread gets the same handle for free. This is strictly more general than a `log` callback threaded through `writeTools`, and it keeps the tool layer and the graph ignorant of who is watching.

A chip only reports calls that have run *and succeeded*: `input` parsed and `result.status === "ok"`. A half-streamed call shows nothing beyond the "working" state the chip is already in, and an errored call shows nothing at all — the graph did not change, so neither does the account of it. The batch tools are not transactional, so a `put_nodes` call whose result is ok may still have rejected individual entries, and the per-entry lines in the result text are the only record of which ones landed. Reading those lines with a regex would be a second, silent parser of a format nobody thinks of as one, so instead the tools emit each entry's outcome as a JSON line — `{"op":"created","kind":"node","id":"n3","title":"…"}` — which the model reads at least as well as prose and the chip parses exactly. The rejected entries stay as they are, plain sentences telling the model what to fix.

Clicking a change selects that node on the graph tab, which is the citation link run backwards and costs one message.

**Not deep links.** The obvious next thought is to make a chip a real URL — `#t3:5` — so it can be copied, opened in a new tab and walked with back/forward. It is cheap (a `hashchange` listener dispatching `CITATION_CLICKED`, no router, no server config), but it is cheap *and dead*: this app keeps everything in memory and discards it on refresh, and switching sample is a full page load, so a citation URL opened anywhere but the tab that produced it lands on an empty session. It would be a link that only works if you do not use it as a link. The full router from `~/src/gatherus/` is not in `vamp.ts` here and importing it would mean owning routing for an app whose own `context.md` says it has none. If the graph ever persists, deep linking becomes worth doing and the message it dispatches is already the right one.

**The build button moves to the sample.** A loaded sample transcript is a session that happened before this page existed: nobody clicked anything, so no live update ever ran over it, and the graph starts empty against a transcript the user is about to ask questions of. So the button survives — but as **"Build knowledge graph from this transcript"**, next to the sample picker in the header, where the thing it acts on actually is. It is not a graph-tab feature and not a whole-tree pass: it walks the *sample's* turns, which is the root thread's `messages` as loaded, and runs the same graph update per interaction, through the same queue as the live ones so a click mid-build cannot race it.

Progress is `3 / 12 interactions`, next to the button, and the button is disabled while it runs. A count is honest here in a way a spinner is not: this is a dozen sequential model calls and it takes as long as it takes. Failures are counted, not fatal.

The batch cannot double-count, because it runs over exactly the turns that were loaded, and every turn after that came from a live interaction that updated the graph itself. Re-running it is still safe — the graph is in every prompt, so a second pass updates nodes rather than minting rivals — but the button disables itself once a build has completed for the loaded sample, since the second pass buys nothing.

`window.__graph` stays: the sidebar specs still need to seed a deterministic graph without driving a build first.

Alternatives rejected: updating the graph on thread *close* or on some idle timer (there is no close, and an idle timer is a batch with extra steps); running the graph update as a tool call inside the learning thread (it would spend the user's latency and put the student model in the same context as the answer, which is exactly the entanglement the two-mode split exists to avoid); parallel knowledge graph update threads (duplicate nodes, as above).

## Interfaces

```ts
// interactions.ts
/** One user interaction, captured as it happens. The unit of evidence about
 * what this user understands. */
export type Interaction = {
  thread: ThreadId;
  /** Index into that thread's `messages`. With `thread`, this is the citable
   * address. A learning thread's ask is its own message 0, so there is no
   * special case. */
  index: MessageIdx;
  /** The thread's seed, then its blocks before the turn - which are messages
   * 0 to index-1, so their addresses are their positions. Identical across
   * interactions in the same thread up to their split point; the prompt cache
   * depends on that. */
  prefix: {
    seed: string | undefined;
    messages: ReadonlyArray<Message>;
  };
  /** The user's turn. */
  text: string;
};

/** The interaction the user just made: the turn at `index` in `thread`. */
export function interactionAt(
  tree: ThreadTree,
  thread: ThreadId,
  index: MessageIdx,
): Interaction;
```

```ts
// citation.ts
/** `@message:<threadId>:<index>` - a reference from graph prose into the
 * transcript. The index is into that thread's `messages`. */
export type Citation = { thread: ThreadId; index: MessageIdx };
export function citationText(c: Citation): string;
/** Splits prose into literal runs and citations, so a renderer can walk it
 * without a second parse. Malformed references stay literal. */
export type Span =
  | { type: "text"; text: string }
  | { type: "citation"; citation: Citation };
export function parse(text: string): ReadonlyArray<Span>;
/** The quote a chip is labelled with, or undefined when the reference does not
 * resolve against the current tree. */
export function resolve(tree: ThreadTree, c: Citation): string | undefined;
```

```ts
// prompt.ts (replacing EXTRACT_SYSTEM and renderTree)
export const GRAPH_UPDATE_SYSTEM: string;
/** Two blocks: the cacheable prefix (base prompt, seed, transcript), then the
 * graph overview, the turn under the microscope and the questions. */
export function graphUpdatePrompt(
  interaction: Interaction,
  graph: string,
): Anthropic.ContentBlockParam[];
```

```ts
// thread.ts - an index into a thread's `messages` gets a brand, since it is an
// identifier and every place that holds one (Citation, Interaction,
// selection.ts's `Point.msg`, the GraphUpdate key) currently says `number`:
export type MessageIdx = number & { readonly __brand: "MessageIdx" };

// thread.ts - `RunThreadOpts.prompt` and `ThreadOpts.seed` widen from `string`
// to `string | Anthropic.ContentBlockParam[]`, so a graph update can mark its
// stable prefix with `cache_control: { type: "ephemeral" }`.
//
// It also gains `onChange?: (messages: ReadonlyArray<Message>) => void`,
// forwarded to the Thread it builds, so a caller can watch an unattended
// thread work rather than only awaiting its result.
```

```ts
// graph-view.ts
/** A citation chip: the reference plus the quote it resolves to. */
export type Chip = { citation: Citation; quote: string };
// `Build`, `{ type: "BUILD" }` and the toolbar status line move to view.ts:
//   type Build =
//     | { type: "idle" }
//     | { type: "running"; done: number; total: number; failed: number }
//     | { type: "done"; failed: number };
// on the header, beside the sample picker.
```

`graph-view.ts` `State` gains `citations: { description: ReadonlyArray<Chip>; notes: ReadonlyArray<Chip> }` (projected in `chat.ts` from the *saved* node, not the draft) and `Msg` gains `{ type: "CITATION_CLICKED"; citation: Citation }`.

`view.ts` `State` gains `focusMessage: number | null` — the message to scroll to and flash in the focused pane, cleared on the next user action.

## Invariants

- Every user interaction produces exactly one graph update: one per submitted turn, one per opened learning thread. Nothing is counted twice, and the agent's own turns never trigger one.
- The sample build covers exactly the turns the sample was loaded with; every later turn is covered by its own live update. No turn is processed by both.
- The build shares the graph update queue, so a user interacting mid-build interleaves rather than races.- Knowledge graph update threads do not overlap. Each is handed the graph as left by the previous one, and they settle in the order the user acted.
- A graph update never blocks the user: the learning thread starts and streams regardless, and a failed graph update is invisible except in the console.
- A graph update that writes nothing is a success, not a failure. Nothing anywhere requires an interaction to produce a node.
- The chips are derived from the update thread's own transcript, so they cannot disagree with what the model actually called; a call whose result came back an error is not shown as a change.
- The chips are derived state: losing them would lose no information the graph does not already hold.
- Every interaction is a message in the thread it happened in. There is no interaction that is not addressable as `(thread, index)`, and no index that is not a real message.
- A failed graph update does not corrupt the graph; the graph is only ever changed through `writeTools`.
- `interactionAt` is pure with respect to the graph and the socket; it only reads the tree.
- Citation indices are indices into `Thread.messages`, which is append-only, so an address stays valid for the life of the page. Nothing renumbers it.
- A `MessageIdx` is only ever produced by reading a position in a thread's `messages`; nothing casts an arbitrary number into one. A parsed citation is validated against the tree before it becomes an address.
- A citation that does not resolve renders as literal text and is never a chip; clicking is impossible and nothing throws.
- Two interactions in the same thread render byte-identical cacheable prefixes up to their split point.

# Stages

## the ask becomes message 0

- Goal: a learning thread's seed holds only context, and the passage plus the ask are its first visible user turn. Nothing about graph updates yet.
- `ThreadOpts` accepts `seed` and `initialTurns` together (`turns = [seed, ...initialTurns]`, `messages` drops the seed only); `prompt.ts` splits `seedTurn` into the context seed and the ask turn; `threads.open` passes both. The origin header in the pane stops rendering the quote and action as chrome, since the transcript now shows them.
- Tests (`threads.test.ts`, `prompt.test.ts`, `packages/e2e/tests/chat.spec.ts`):
  - An opened learning thread sends two turns on its first request — context, then the ask — and its `messages` show the ask at index 0 and nothing of the seed.
  - The quote and the action label appear once in the transcript, not twice with the header.
  - A grandchild thread still inherits its parent's seed rather than re-rendering the graph overview, which is the behaviour `seedTurn`'s `seed` argument exists to preserve.

**Landed.** `seedTurn` split into `contextSeed(seed, messages, anchor, graph?)` and `askTurn(anchor, messages, action)`; `ThreadOpts` now concatenates `seed` and `initialTurns`, and `Thread.messages` still drops only the seed. Deviations:

- The ask is written in the user's voice (`Selected: "…"` then `I don't understand this. Explain what it means and why it is there.`) rather than the old third-person briefing, since it is now a visible user turn. `actionLabel` is a prefix of it, which is what the "appears once in the transcript" test asserts against.
- Both origin headers are gone, not just the focused pane's: `ThreadPaneState.action` and the `[data-thread-action]` / `[data-focus-action]` / `[data-focus-quote]` elements, plus their CSS. The e2e specs that read those now read the thread's own message 0.
- Learning-thread transcripts are one message longer, so the e2e counts moved from 1 to 2 and selections taken after descending index message 1 rather than 0.

## capturing an interaction

- Goal: `interactionAt` exists and is exercised in isolation. Nothing consumes it yet.
- Tests (`interactions.test.ts`, building trees over the `FakeSocket` the way `threads.test.ts` does):
  - A typed turn in the root thread yields an interaction whose `text` is that turn and whose `prefix` is everything before it and nothing after — including nothing from the assistant reply that is still streaming.
  - A learning thread's first interaction is its message 0 — the passage plus the ask — with a `prefix` holding only the seed. Opening a thread and reading its message 0 is how the highlight survives at all, so this is the case that would silently vanish if the split were done wrong.
  - The second interaction in a thread has the first one's prefix as a prefix of its own; this is the property the prompt cache rides on.
  - `prefix.messages` is exactly messages 0 to index-1, so rendering it with its positions as addresses round-trips back to the same blocks.

**Landed.** `interactions.ts` holds `Interaction` and `interactionAt`; `MessageIdx` is branded in `thread.ts`. Deviations:

- `interactionAt` throws when the address is missing or is not a user turn, rather than returning `undefined`: the callers to come read an address they just observed, so a miss is a bug and not a case to handle.
- No batch helper (`userInteractions`) yet - the sample build owns enumeration, so it lands with that stage.
- `selection.ts`'s `Point.msg` stays `number` for now; branding it ripples through `view.ts`'s DOM-to-`Point` resolution and buys nothing until citations exist.
- `interactions.test.ts` carries its own `FakeSocket` (a trimmed copy of `threads.test.ts`'s, plus a `streams` helper that leaves a turn mid-flight) rather than exporting one, since a shared fixture module is more machinery than two small copies.

## the graph update prompt

- Goal: `GRAPH_UPDATE_SYSTEM` and `graphUpdatePrompt` replace `EXTRACT_SYSTEM` and `renderTree`, which are deleted along with their tests.
- Tests (`prompt.test.ts`):
  - `graphUpdatePrompt` puts the user's turn, the transcript prefix and the rendered graph in the output; a learning thread's message 0 renders its quote and its ask like any other turn.
  - The graph overview lands in the volatile second block, never in the cached one; exactly one block carries `cache_control`; and two interactions in one thread produce an identical first block.
  - A root-thread interaction, whose thread has no seed, renders without an empty framing section.
  - `GRAPH_UPDATE_SYSTEM` states the scope restriction, the coarseness rule and the licence to change nothing — the clauses the whole design rests on, so their absence should fail a test rather than quietly degrade every graph.

**Landed.** `EXTRACT_SYSTEM`/`renderTree`/`walk` are gone, replaced by `GRAPH_UPDATE_SYSTEM` and `graphUpdatePrompt(interaction, graph)` returning a cached prefix block (preamble, seed, transcript prefix) and a volatile block (graph, the turn, the questions). `ThreadOpts.seed`, `Thread.seed` and `RunThreadOpts.prompt` widened to `string | Anthropic.ContentBlockParam[]`. Deviations:

- Widening `Thread.seed` means the two readers of it that want prose - `threads.open`'s parent seed and `interactionAt`'s prefix - narrow with `typeof seed === "string"`. Only a graph update's seed is blocks, and those threads have no interactions and no children.
- `chat.ts`'s `runBuild` was rewritten in place rather than deleted, since stage 3 removes the prompt it used but stage 5 owns its replacement: it now walks the root thread's user turns and runs one sequential `runThread` graph update each, with the existing `Build` state. Stages 4/5 replace it with the queue and move it to the header.
- `prompt.test.ts` builds `Interaction` literals directly rather than through a tree; `interactions.test.ts` already covers `interactionAt`.

## citations

- Goal: `citation.ts` parses and resolves the DSL, and the prompt both renders addresses and demands their use.
- `graphUpdatePrompt` labels every transcript block with `@message:tN:i`; `GRAPH_UPDATE_SYSTEM` gains: a note about this user's understanding must cite the interactions it rests on, by address, and must not assert what it cannot point at.
- Tests (`citation.test.ts`, `prompt.test.ts`):
  - `parse` splits prose containing two references into text and citation spans in order; malformed ones (`@message:t0:`, `@message::1`, `@message:t0:x`) stay text spans.
  - `citationText`/`parse` round-trip.
  - `resolve` returns the message text for a live address and `undefined` for an unknown thread or an out-of-range index.
  - `graphUpdatePrompt` renders the interaction's own address and those of its prefix blocks, and they resolve back to those blocks through `resolve`.

**Landed.** `citation.ts` holds `Citation`, `citationText`, `Span`, `parse` and
`resolve`; `graphUpdatePrompt` labels every prefix block `User (@message:tN:i):`
and the interaction itself with its own address; `GRAPH_UPDATE_SYSTEM` now
requires a claim about the user to cite the addresses it rests on. Deviations:

- `transcript()` takes an optional `thread`: only the graph update labels
  blocks. A learning thread's seed stays unaddressed, since nothing cites it.
- `resolve` catches `ThreadTree.get`'s throw for an unknown thread rather than
  the tree gaining a lookup that returns `undefined`.
- `citation.test.ts` carries its own trimmed `FakeSocket`, matching what
  `interactions.test.ts` already does.

## update the graph on every interaction

- Goal: submitting a turn or opening a learning thread updates the graph in the background, and the build button is gone.
- `chat.ts` gains `queueGraphUpdate(thread, index)`, appending to a promise chain: `runThread(socket, { system: GRAPH_UPDATE_SYSTEM, prompt: graphUpdatePrompt(interactionAt(tree, thread, index), graph.render()), tools: writeTools(graph), yieldSchema: "text" })`, syncing the view when it settles and swallowing failures. `graph.render()` is read *inside* the queued step, not when it is enqueued, so a graph update always sees the previous one's writes. `runBuild`, `Build` and the toolbar go with it.
- Tests (`packages/e2e/tests/chat.spec.ts` and `graph.spec.ts`, socket stubbed):
  - Sending a turn produces two requests — the learning/task reply and the graph update — and the reply streams without waiting for the graph update to finish. This is the claim the whole design makes to the user.
  - Clicking "I don't understand this" likewise kicks one off, on the new thread's message 0.
  - Two interactions in quick succession produce two knowledge graph update threads that do not overlap, and the second one's prompt contains the node the first one wrote. This is the serialization, and it is the one thing a naive fire-and-forget would get wrong while still looking fine.
  - A graph update whose thread errors leaves the transcript and the graph usable, and the next interaction still updates the graph.
  - The graph tab has no build button and shows the nodes the knowledge graph update threads wrote.

**Landed.** `chat.ts` holds `queueGraphUpdate(thread, index)` appending to a
`updates: Promise<void>` chain, called from `send` (with the index the turn
lands at, read before `Thread.send`) and from the `ACTION` case (index 0 of the
new thread). `runBuild`, `Build`, `{ type: "BUILD" }` and the graph toolbar are
deleted. Deviations:

- `refresh(); view.sync(state)` is now a named `sync()` in `chat.ts`, since the
  queued step and the tree's `onChange` both want it.
- Stage 6 reintroduces `Build` on the header, so nothing was left behind for it
  here; the graph tab has no toolbar at all in the meantime.
- `chat.spec.ts`'s stubs now recognise a graph update by its `put_nodes` tool
  and answer it with an immediate `yield`, keeping it out of `started`. Without
  that every existing request-count assertion would have to account for the
  update running beside it.
- The serialization is asserted in `graph.spec.ts` by having the stub record
  each update's first request and flag any that starts while another is live,
  rather than by timing.

## building from a sample transcript

- Goal: loading a sample and clicking "Build knowledge graph from this transcript" fills the graph from the turns that were already there, with visible progress.
- The button and its `N / M` counter live in the header next to the sample picker; `chat.ts` enumerates the root thread's user turns with `interactionAt` and enqueues one graph update each, onto the same chain the live updates use.
- Tests (`packages/e2e/tests/graph.spec.ts`, socket stubbed):
  - Clicking the button over a sample with three user turns issues three graph updates in sequence, the counter advances, and the nodes land on the canvas. The button is disabled while running and afterwards.
  - A graph update that errors mid-build does not stop the ones after it, and the count reflects it.
  - Sending a turn while a build is running does not produce overlapping updates — the interaction's update runs after the queued build steps. This is the seam between the two triggers and the only place they can collide.
## surfacing the update in the transcript

- Goal: a turn shows its graph update working, and then what it changed.
- `RunThreadOpts` gains `onChange?: (messages) => void`, forwarded to the underlying `Thread`. `chat.ts` holds `Map<string, GraphUpdate>` keyed by thread and index, projects the update thread's tool calls into `GraphChange`s, and the transcript view renders the chip under the message at that address — including a learning thread's message 0, which is now an ordinary message.
- Tests:
  - `graph-tools.test.ts`: a batch that creates one node and updates another comes back with one JSON line per applied entry carrying its op, id and title, while an entry rejected for a duplicate title produces no line — the chip's whole input, so a change that never happened must be impossible to report.
  - `thread.test.ts`: `runThread`'s `onChange` fires during the run and the messages it hands over carry the completed tool calls with their parsed inputs and results.
  - `packages/e2e/tests/chat.spec.ts`: sending a turn shows a working chip under it immediately, which resolves to the created node's title once the stubbed update yields; a second turn's chip does not show the first turn's changes.
  - `packages/e2e/tests/chat.spec.ts`: an update that writes nothing says so rather than leaving a spinner or vanishing.
  - `packages/e2e/tests/graph.spec.ts`: clicking a change chip opens the graph tab with that node selected.

## citation chips and navigation

- Goal: a note that cites an interaction shows a clickable chip, and clicking it lands on that message in the threads tab.
- `chat.ts` projects chips from the saved node's `description`/`notes` via `parse` + `resolve`; `CITATION_CLICKED` sets `tab = "threads"`, walks `tree.path` setting `activeChild`, sets `focus` and `focusMessage`, and `split` when the target is not the root.
- Tests (`packages/e2e/tests/graph.spec.ts`, graph seeded through `window.__graph`):
  - A node whose notes cite a message in a child thread shows one chip labelled with that message's text; clicking it switches to the threads tab with that thread focused and the cited message scrolled into view and flashed.
  - A node whose notes cite a nonexistent thread shows no chip and leaves the raw text untouched — the degradation path, which is the one that will actually happen as the model invents addresses.
  - **The integration that matters**: stub a graph update that writes a note containing the address of the interaction it was given, then click through the resulting chip. Address into the prompt, address out of the model, address back onto the transcript — the only test that would catch the two ends disagreeing about the format.
