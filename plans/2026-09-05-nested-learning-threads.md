# Objective and Context

"so next I want to hook up the 3 options to a new thread, per selection. Each should get a custom prompt, consisting of: the task conversation up to the selection; the selection, as a 'the user selected this text:<text quoted verbatim>'; a question about the selection 'the user said they didn't understand this... etc...'. Any selection the user interacts with should be retained, the highlight preserved. Clicking on the highlight should return the user back to that conversation. I think one interesting aspect of this would be to make these nested. So within the explanation thread for the task, the user can 'go deeper' / 'shift left'. So the learning thread becomes the task thread, and now we can interact with a section of that. So if the user asks the agent to explain something, the agent provides an explanation, but the user doesn't understand sections of the explanation, they can go in depth about the explanation, and iterate down until the user gets it..."

The prototype today has exactly one `Conversation`, one live `Anchor`, one `<mark>`, and an action menu whose buttons only record a `pending` action. This turns that into a tree of conversations.

Entities as they exist now:

- `Conversation` (`packages/frontend/conversation.ts`) — owns a `MessageParam[]`, the streaming accumulator, `messages`, `inFlight`, `send(text)`, `onChange`. `MODEL`, `MAX_TOKENS` and `SYSTEM` are module constants; `SYSTEM` is deliberately task mode.
- `Anchor` / `Point` (`packages/frontend/selection.ts`) — `{ msg, offset }` pairs indexing the *displayed* message list, plus `clipToMessage` and `anchorText`. `Anchor` gains a `thread` field here, and `clipToMessage` is superseded by `segments`.
- `AppView` (`packages/frontend/view.ts`) — the whole prototype-1 shell: the mode toggle (which this replaces with navigation arrows), transcript `bindList`, composer, `readAnchor`/`resolvePoint` selection capture, and a `bindSlot` holding `LearningPane`.
- `MessageView` (same file) — renders one message as pre/mark/post spans from a single optional mark.
- `LearningPane` (`packages/frontend/learning.ts`) — the empty prompt, the quoted selection, the three actions, and the `pending` echo.
- `mount` (`packages/frontend/prototypes/chat.ts`) — the single dispatch loop.
- `packages/e2e/tests/chat.spec.ts` — Playwright specs against a `routeWebSocket` fake backend that replays deltas and records the `params.messages` of every `start` frame. This is how the prompt-construction work gets verified end to end.

# Design

## A tree of threads

Every conversation in the UI is a `Thread`. The root thread is the task. Each other thread is created from an `(anchor, action)` pair — the anchor names the parent, so the highlight *is* the edge in the tree — and never disappears, which is what "any selection the user interacts with should be retained" means. The mark and the conversation are the same object viewed two ways.

Threads live in a `Map<ThreadId, Thread>` owned by a `ThreadTree` in `packages/frontend/threads.ts`. Not a store in the ctx sense: the prototype has one dispatch loop and one tree, so it is a plain object created in `mount` and closed over, like `Conversation` is today.

## The prompt is one synthetic user turn

The obvious construction — slice the parent's `MessageParam[]` up to the selection and append the framing turn — breaks the alternation the API requires whenever the selection lands in a user turn, and forces every thread to carry a "where does my visible transcript start" index into a shared array.

Instead a child thread's conversation is seeded with **exactly one** `MessageParam`: a user turn containing the parent transcript rendered as text, the verbatim selection, and the question. The whole conversation is re-uploaded every turn anyway (see `plans/2026-09-04-prototype-scaffolding.md`), so nothing is lost, and the seed is a pure `string`-producing function that unit tests can read.

The seed turn stays in the conversation forever — it is turn 0 and is re-sent on every turn, exactly like any other. There is never more than one: `seedTurn` collapses the whole prefix, however deep, into a single string. Hiding it is purely a display concern — `messages` is already a projection of the turns for the UI, and this drops turn 0 from it — so the pane shows the assistant's answer first, the user never reads the framing we wrote on their behalf, This is the only change to `conversation.ts` beyond making `system` a constructor option.

"The task conversation up to the selection" means a thread's visible messages truncated after the message containing the selection's *end* — the agent should not see work that happened after the passage under discussion.

Context accumulates down the tree, and it accumulates **flat** — but that falls out of the construction rather than needing machinery. A thread's hidden seed is already a flat prompt covering everything up to the point it was opened, so a child's seed is just that string, then the parent's own visible transcript, then the new selection and question, concatenated:

```
<parent's hidden seed, verbatim - already flat>

<parent's visible transcript, truncated at the selection>

The user then selected: "<selection>"
<question>
```

At the root the first part is empty and this is just transcript + selection + question. At layer 2 the first part is layer 1's seed, which itself expands to the task transcript + the first selection + the first question — so the reader sees one chronological narrowing:

```
<task transcript, truncated at the layer-0 selection>

The user then selected: "<layer-0 selection>"
<layer-0 question>

<layer-1 transcript, truncated at the layer-1 selection>

The user then selected: "<layer-1 selection>"
<layer-1 question>
```

The thing to get right is that the hidden seed is emitted **verbatim, not quoted or labelled** — the naive version wraps it in "here is the previous conversation: ..." at each level, and by depth three the task is buried inside three layers of framing. Nothing walks the path and nothing is re-rendered: each level's text was already written once, when that thread was opened.

The prompt still grows with depth, since every level is retained. Fine for a prototype: the first symptom is a long seed, not a wrong one.

## Highlights: many marks per message

`MessageView` stops taking one optional mark and takes a list. The message text is split at every mark boundary into segments; each segment is either plain or attributed to a thread, and an attributed segment is a clickable `<mark>` that dispatches `MARK_CLICKED`. Segments are rendered with `bindList` keyed by start offset.

Overlapping marks are disallowed rather than resolved. A live selection that intersects an existing mark is still captured and still highlighted, but the right pane shows "select a non-overlapping section" instead of the action menu, so the user sees why nothing can be done with it. This keeps `segments` a straight left-to-right walk over disjoint ranges, and keeps a passage owned by exactly one thread — a mark that was partly inside another would have no honest meaning as an edge in the tree anyway.

Two visual states matter: the *live* selection the user just dragged (no thread yet) and *committed* marks (a thread exists). The active thread's mark is emphasized further, so the user can see which highlight the right pane belongs to.

## Panes and navigation

The app shows two panes, and they are not symmetric. The **left** pane is the thread you are reading: `focus`, rendered as a transcript with its marks, its composer, and selection capture. The **right** pane is where you act on it, and is one of three things: the "select some text to get started" prompt, the action menu for the live selection, or `focus.activeChild`'s transcript. Only the left pane captures selections and only the right pane offers actions — going deeper into a learning thread means bringing it to the left with `→`, which is exactly what that arrow already does.

**The panes are moved by a pair of arrows, not by selections.** The mode toggle is replaced by `←` / `→` in the same fixed pill. Layer 0 is the bare task transcript in a single column; every deeper layer is the two-pane split, so the depth the user is at is `split ? path(focus).length : 0`:

- `→` at layer 0 reads **"Learning mode"** and opens the split: the task stays on the left and the right pane appears (its active child, or the "select some text to get started" prompt).
- `→` at any deeper layer reads **"Go deeper"** and moves `focus` to `focus.activeChild`, so the right pane slides left and *its* active child becomes the new right pane. Disabled when there is no active child.
- `←` is not rendered at all at layer 0. In the split it reads "Back", and moves `focus` to its parent — which puts the thread you were reading back on the right. From layer 1 it closes the split and returns to the bare task transcript.
Everything else only ever affects `activeChild`, never `focus`:

- Picking an action creates a child of `focus` and makes it the active child, so the right pane switches from the menu to the new thread and starts streaming.
- Clicking a mark in the left pane makes its thread the active child — the same right-pane switch, for a conversation that already exists.

Separating navigation from selection keeps the user's position in the tree changing only when they ask for it, and leaves no case analysis where a selection implicitly moves the panes. The mode toggle disappears with it: there is no longer a task/learning mode, just a task thread at the root of a tree.

The arrows carry a label naming the destination thread, and `path(focus)` is rendered next to them as a depth indicator, so the user can tell where they are without a separate breadcrumb widget.

## Interfaces

`packages/frontend/selection.ts` — an `Anchor` is a half-open range over the message list of one thread, and it carries that thread's id, so it identifies a passage on its own without a surrounding record. It is deliberately not a DOM `Range`: the browser collapses the live selection as soon as the user clicks the right pane, whereas offsets survive, serialize, and stay valid as a message streams in (the transcript is append-only).

```ts
/** Declared here rather than in threads.ts because an anchor is meaningless
 * without it, and threads.ts imports selection.ts. */
export type ThreadId = string & { readonly __brand: "ThreadId" };
/** `msg` is an absolute index into the thread's turns (the hidden seed is
 * index 0 when there is one); `offset` is a character offset into its text. */
export type Point = { msg: number; offset: number };
/** `start` precedes `end` in document order; equal points mean no selection. */
export type Anchor = { thread: ThreadId; start: Point; end: Point };

export type Segment = {
  start: number;
  end: number;
  /** The thread this run opens, or null for plain text. */
  thread: ThreadId | null;
};
/** True when `live` intersects any committed mark, which makes it unusable. */
export function overlaps(
  marks: ReadonlyArray<Anchor>,
  live: Anchor,
): boolean;
/** Splits message `i` of one thread into plain and marked runs. `live` is the
 * uncommitted selection, which has no thread of its own yet. `marks` are
 * pairwise disjoint; `live` may overlap them, and wins where it does. */
export function segments(
  marks: ReadonlyArray<Anchor>,
  live: Anchor | null,
  i: number,
  length: number,
): Segment[];
```

`packages/frontend/threads.ts`:

```ts
export type Action =
  | { type: "explain" }
  | { type: "quiz" }
  | { type: "query"; text: string };

/** `anchor.thread` is the parent, so the link upward is the highlight itself. */
export type Origin = { anchor: Anchor; action: Action };

export type Thread = {
  id: ThreadId;
  origin: Origin | null; // null only for the root task thread
  conversation: Conversation;
  children: ThreadId[]; // creation order; each child's origin.anchor is its highlight
  activeChild: ThreadId | null;
  draft: string;
};

export class ThreadTree {
  constructor(root: Conversation);
  readonly root: ThreadId;
  get(id: ThreadId): Thread;
  /** Seeds a child conversation from `seedTurn(...)` and links it in. */
  open(anchor: Anchor, action: Action): ThreadId;
  /** The anchors of `id`'s children, i.e. the marks to draw over it. */
  marks(id: ThreadId): Anchor[];
  path(id: ThreadId): ThreadId[]; // root -> id, for the depth indicator
}
```

The live selection is not a property of a thread: only the left pane captures one, so a single `anchor: Anchor | null` lives in the prototype's own state alongside `focus` and `split`.

`packages/frontend/prompt.ts` (pure, unit tested):

`seedTurn` reads one thread — the parent — as its seed plus its transcript, and truncates that transcript at `anchor.msg` directly, since the anchor is an absolute index.

```ts
export const LEARNING_SYSTEM: string;
/** The single seed user turn for a learning thread. */
export function seedTurn(
  /** The parent's own seed, absent at the root. Emitted verbatim. */
  seed: string | undefined,
  /** The parent's rendered turns, truncated at `anchor.msg`. */
  messages: ReadonlyArray<Message>,
  anchor: Anchor,
  action: Action,
): string;
```

`packages/frontend/conversation.ts`:

```ts
constructor(socket: Socket, opts?: {
  system?: string;
  initialTurns?: Anthropic.MessageParam[];
  /** Turn 0, sent like any other turn but never rendered. */
  seed?: string;
});
/** The seed, so a child thread can carry it forward verbatim. */
readonly seed: string | undefined;
```

## Invariants

- One `WebSocket` for the whole app, shared by every thread's `Conversation` and multiplexed by `requestId`. That needs no new code — each `Conversation` adds its own `message` listener and `handleFrame` already drops frames whose `requestId` it does not own — but it does mean `connect()` is called exactly once, in `mount`, and the socket is handed to every thread the tree creates.
- The backend needs no changes: `socket.on("message")` starts an independent `run` per `start` frame without awaiting it, and every frame it emits carries that request's id, so several streams interleave over the one connection. Previously incidental, now load-bearing — a thread can be streaming while the user opens another.
- `Point.msg` is an absolute index into a thread's turns, seed included. Hiding the seed is display-only: the pane renders from index 1 and adds 1 when it resolves a selection, and nothing downstream — `segments`, `overlaps`, `seedTurn` — knows that happened.
- A thread has at most one hidden turn: the seed, at index 0. Depth never adds more, because `seedTurn` collapses the entire prefix into that one string.
- The seed is emitted verbatim by the next `seedTurn`, which is the only reason flatness is preserved. Anything that wraps or re-labels it reintroduces nesting at every level.
- A thread is never destroyed and never reparented; `origin.anchor` is immutable once created. The highlight and the conversation therefore cannot drift.
- The transcript is append-only, so offsets stay valid while a message streams. A mark may point into a message that is still growing.
- `activeChild` is always a member of `children`, and `focus` is always a live thread id.
- Layer 0 is `split === false`, which implies `focus === root`; closing the split never changes `focus` from anything other than the root, because `←` walks up one level at a time.- `focus` changes only in response to the arrows. Opening a thread, clicking a mark, and streaming never move it.
- Selection capture is bound to the left pane only, so there is exactly one live anchor in the app and the right pane can be a plain read-only transcript.
- A live selection and an active child compete for the right pane; the newer one wins, so picking an action or clicking a mark clears the live anchor, and dragging a fresh selection replaces the visible child with the menu.
- Committed marks are pairwise disjoint, which is what lets `segments` walk them in order. The live selection is the only range allowed to overlap one, and it can never be promoted to a thread while it does.
- Dispatch stays single: reducers mutate the tree and view state, `Conversation.onChange` re-syncs, and no view holds its own dispatch.

# Stages

## Prompt construction

**Status: done** (`packages/frontend/prompt.ts`, `prompt.test.ts`, `conversation.ts`, `conversation.test.ts`).

Deviations:
- `Action` is declared in `prompt.ts` rather than `threads.ts`, since `threads.ts` does not exist yet; stage 2/3 should re-export it from there.
- `Conversation` gained `start()`, which requests a reply to the turns already present. Without it a seeded thread's first `send` would append a second consecutive user turn after the seed.
- `seedTurn` truncates `messages` at `anchor.end.msg` itself rather than trusting the caller to pass a pre-truncated list.
- Transcript rendering labels turns `User: ` / `Assistant: `, sections joined by a blank line.

- Goal: `prompt.ts` produces the seed turn for all three actions, and `Conversation` accepts a system prompt and a seed.
- Tests (`prompt.test.ts`, `conversation.test.ts`, vitest):
  - The seed turn contains the selected text verbatim, including when the selection spans two messages.
  - The rendered transcript stops after the message containing the end of the selection — a later message's text does not appear.
  - `explain`, `quiz` and a free-form query produce visibly different instructions, and the query's text is carried through.
  - **Shape of the composition at depth**: build a root seed, feed it back in as the hidden turn of a second call, and again for a third; assert the resulting string against an expected literal. Sections read oldest first, each transcript appears exactly once, and no section is wrapped in another's framing.
  - The root seed is a literal prefix of the depth-2 seed, so composing adds sections rather than rewriting them.
  - `ThreadTree.marks` and `Conversation.messages` are the only inputs; nothing walks the path to build a prompt.
  - A conversation constructed with a `seed` renders an empty transcript, and after a reply renders only the reply — while both its `start` frames carry the seed as the first element of `params.messages`.

## Multiple, clickable marks

- Goal: a message renders any number of highlights; the live selection and committed marks are visually distinct; clicking a mark dispatches.
- Tests:
  - `segments()` unit tests: no marks, one mark, two disjoint marks, a mark spanning message boundaries, a mark ending exactly at the message end, and a live selection sitting across a committed one.
  - `overlaps()` unit tests: touching-but-not-overlapping ranges are fine; a shared character is not; containment either way is not.
  - Playwright: selecting across an existing mark shows "select a non-overlapping section" and no action buttons; selecting beside it shows the menu again.
  - Playwright: with two committed marks in one message, both are visible and clicking each swaps the right pane's content.
  - Playwright: dragging a new selection over existing text leaves the old marks rendered.

## Threads on the right pane

- Goal: picking an action opens a child thread, sends the seeded prompt, streams into the right pane, and leaves a permanent highlight. Clicking that highlight reopens the thread with its history intact.
- Tests (Playwright, against the fake backend that records `start` frames):
  - Selecting a passage and clicking "I don't understand this" sends exactly one `start` frame whose `messages` is a single user turn containing the passage verbatim.
  - The reply streams into the right pane and the passage stays marked after the pane is clicked.
  - Following up in the right pane's composer sends a conversation whose first turn is still the seed.
  - Selecting a second passage opens a second thread; clicking the first mark restores the first thread's transcript, and no new `start` frame is sent.

## Nesting and the arrows

- Goal: `→` descends into the active child and `←` climbs back, and a thread opened at depth behaves exactly like one opened at the root.
- Tests (Playwright):
  - Explain from the task, press `→` so the explanation is on the left, then select part of it and click "Quiz me on this": the new `start` frame's seed has two sections — the task transcript with the first selection, then the explanation with the second — and the task text appears exactly once.
  - Taking that action does not move the panes — the quiz appears on the right; pressing `→` again puts it on the left.
  - `←` back to the root leaves the explanation on the right and both highlights intact, and pressing `→` twice returns to the quiz thread rather than starting over.
  - At layer 0 the button reads "Learning mode" and there is no `←`; one layer in, it reads "Go deeper" and `←` closes the split again.
  - `→` is disabled in the split with no active child.
  - Depth three works, i.e. nothing in the design caps the recursion.
