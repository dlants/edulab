# Objective and Context

The user's request, verbatim:

> I want to create a new interaction type. This is when I don't have any section of a thread selected, I click "Go deeper," and I see the view that just lists the existing interactions and says, "Select some text to continue."
> I want to add a new affordance or a new set of affordances here:
> 1. A question around "Let's review what happened in this task." The idea here would be that the agent suggests some key decisions or moments during the performance of the task that were made and are worth digging into. Here it should use the domain object graph and particularly its understanding of the user to combine that with the big beats of the task that just was completed. This is in order to give the user a suggestion or some suggestions about potential parts of the conversation that they can dig into.
> 2. A more general "Help me": "What is something that I should think about?" I think right now we are relying on the user to find things to focus on and I want to create an affordance where the user can ask the agent to suggest some things to focus on.
> I think this should basically anchor to the thread without a message, so anchor to the entirety of the parent thread. It should get the entirety of the parent thread as its context and leverage the context of the task and the knowledge graph to suggest some things. For now the output should just be text, essentially, so the agent can do some writing about some things that the user might find interesting to get into.
> It should anchor to the parent thread. Use the entire parent thread as context. Here we're getting rid of the non-overlapping anchors rule or weakening it a little bit. For interactions that are anchored to the entire thread, I want it to be possible to have multiple.
> Below those you can add:
> - "Select some text to ask a question about a specific part of this task"
> - A text box to ask a general question about the thread
> - "Give me some ideas about what I can explore or what I can learn more about"

## Entities involved

- `Anchor` (`selection.ts`) — `{ thread, start: Point, end: Point }`. A character range over one thread's transcript. `overlaps` enforces that committed marks are pairwise disjoint.
- `Mark` (`selection.ts`) — `{ thread, anchor }`, one per child thread; what `segments` paints over the transcript.
- `Origin` (`threads.ts`) — currently `{ anchor; action }`. It is *both* the link up to the parent (`origin.anchor.thread`) and the highlight the child hangs off. A thread-level child has a parent but no highlight, so this pairing has to come apart.
- `Action` (`prompt.ts`) — `explain | quiz | query`. `actionLabel` renders it in the pane header, `ask` renders it as the user's opening turn.
- `ThreadTree.open(anchor, action, opts)` — seeds a child from `contextSeed` (parent seed + transcript truncated at the anchor) plus `askTurn` (the quote and the ask) as message 0.
- `Interaction` / `interactionAt` — a user turn plus its prefix; message 0 of a child thread is an interaction like any other and drives a graph update. This stays true for thread-level children with no change.
- `LearningPane` (`learning.ts`) — the right-hand pane. With no selection it shows "Select some text to get started." plus the list of already-opened passages; with one it shows the quote and the three actions.
- Snapshot persistence (`persistence.ts`) — `ThreadSnapshot.origin` is serialized as-is, and `VERSION` is part of the localStorage key, so bumping it orphans incompatible data rather than migrating it.

## Files

- `packages/frontend/selection.ts` — anchors, marks, segment splitting, `overlaps`.
- `packages/frontend/threads.ts` — the thread tree; `open`, `marks`, `path`.
- `packages/frontend/prompt.ts` — system prompts, seeds, ask turns, action labels.
- `packages/frontend/learning.ts` — the right-hand pane and the selection popup.
- `packages/frontend/view.ts` — projects `State` into `LearningPane`'s state; owns `paneSelection`.
- `packages/frontend/prototypes/chat.ts` — the single dispatch loop; `LEARNING_MSG` handling, focus, split, graph updates.
- `packages/frontend/persistence.ts` — `ThreadSnapshot.origin`, `VERSION`.
- `packages/e2e/tests/chat.spec.ts` — the UI specs, socket stubbed with `routeWebSocket`.

# Design

A thread-level child is a thread opened from its parent with no passage. Rather than fake a whole-transcript `Anchor` — which `segments` would paint over the entire transcript and `overlaps` would then reject — `Origin` becomes a disjoint union over the two ways a thread can be opened, and the parent link moves out of the anchor:

- `marks()` only yields passage origins, so a thread-level child paints nothing and the disjointness rule is untouched. "Weakening the non-overlapping rule" falls out for free: `overlaps` is never consulted for a thread-level open, so any number of them can coexist.
- `path()` reads the parent off a helper rather than off `origin.anchor.thread`.

Context and prompting reuse the existing machinery with the truncation removed. `contextSeed` truncates the parent transcript at the anchor; a thread-level seed is the same thing over the whole transcript, and carries the graph at the top level exactly as today. The opening turn has no `Selected: "…"` block — it is only the ask. `LEARNING_SYSTEM` is generalized in one sentence to cover "the whole thread" alongside "a passage"; a second system prompt would be two things to keep in step for no gain. The read tools (`get`) are passed as today, so the agent can pull full node descriptions and this-user notes for the concepts it is about to lean on.

Two new actions (`review`, `ideas`) and the existing `query` are what the pane offers when nothing is selected. `query` is deliberately shared between the two scopes: what the user asked is one thing, and the scope of it is already carried by the origin.

Getting back into a thread-level child: it has no highlight to click, so the empty pane grows a second list beneath the passages, labelled by `actionLabel`, dispatching the same `MARK_CLICKED` message. Everything downstream of `activeChild` — the `ThreadPane` on the right, `→` descent, `←` climb — already works off the tree, not off marks, with one exception: `GO_BACK` emits `mark:reveal` for the active child, which finds no `[data-mark]` element for a thread-level child. That emit becomes conditional.

Persistence: `VERSION` 2 → 3, so a stored snapshot with the old `Origin` shape is dropped rather than restored into a type it no longer satisfies.

## Interfaces

```ts
// threads.ts
export type Origin =
  | { type: "passage"; anchor: Anchor; action: Action }
  | { type: "thread"; parent: ThreadId; action: Action };

/** The thread this one was opened from. */
export function parentOf(origin: Origin): ThreadId;

// ThreadTree
open(anchor: Anchor, action: Action, opts?: ChildOpts): ThreadId;   // unchanged signature
openThread(parent: ThreadId, action: Action, opts?: ChildOpts): ThreadId;
marks(id: ThreadId): Mark[];        // passage children only
/** The thread-level children of `id`, in creation order. */
threadChildren(id: ThreadId): ReadonlyArray<{ thread: ThreadId; action: Action }>;
```

```ts
// prompt.ts
export type Action =
  | { type: "explain" }
  | { type: "quiz" }
  | { type: "review" }
  | { type: "ideas" }
  | { type: "query"; text: string };

/** The whole parent transcript, with the graph at the top level. The
 * anchor-truncating sibling of contextSeed. */
export function threadSeed(
  seed: string | undefined,
  messages: ReadonlyArray<Message>,
  graph?: string,
): string;

/** The opening turn for a thread-level child: the ask, with no quote. */
export function threadAskTurn(action: Action): string;
```

Action copy (`actionLabel` / `ask`):

- `review` — label "Let's review what happened in this task." Ask: review what happened, name the handful of decisions and moments that actually mattered, and for each say why it is worth digging into *for this user* given what the graph says they understand.
- `ideas` — label "Give me some ideas about what I can explore." Ask: suggest a few things in this task worth exploring or learning more about, pitched at what the graph says this user does and does not understand.

Both are prose-only: no tools beyond `get`, no yield schema, so the output is text the user reads.

```ts
// learning.ts State
export type State = {
  selection: string | null;
  overlapping: boolean;
  query: string;
  marks: ReadonlyArray<{ thread: ThreadId; text: string }>;
  /** Thread-level children of the focused thread, offered as a way back in. */
  threads: ReadonlyArray<{ thread: ThreadId; label: string }>;
};
```

The empty branch of the pane, top to bottom: the two suggestion buttons (`review`, `ideas`), then "Select some text to ask a question about a specific part of this task", then a textarea for a general question about the thread, then the list of already-opened thread-level children, then the list of already-opened passages. Both lists dispatch `MARK_CLICKED`.

Message flow: the pane's existing `ACTION` message is scope-free; `chat.ts` decides. If there is a live non-overlapping anchor it opens a passage thread as today, otherwise it opens a thread-level child of `focus`. The textarea's Enter handler already dispatches `ACTION { type: "query" }`, so with no selection it lands as a thread-level query with no new message type.

## Invariants

- Passage marks over one thread stay pairwise disjoint; `overlaps` and `segments` are unchanged.
- A thread may have any number of thread-level children, and they paint nothing over the transcript.
- Every thread but the root has exactly one parent, and `path()` still terminates at the root.
- Message 0 of a thread-level child is a user interaction and queues a graph update, like every other opening turn.
- Restoring a v2 snapshot must not produce a `TreeNode` with an origin of the old shape — the version bump is what enforces it.
- The popup is passage-only: it exists because the pane is not on screen for a *selection*, and there is no selection here. It gains nothing.

# Stages

## Origin as a union — DONE

Landed as designed. `Origin` is a union, `parentOf` is exported from
`threads.ts` and used by `path()` and `GO_BACK` in `chat.ts`, `marks()` filters
to passage origins, `VERSION` is 3. The e2e persistence spec hardcoded the
storage key, so `edulab:v2:` there became `edulab:v3:`.

- Goal: `Origin` is a disjoint union, `parentOf` is the only way to walk upward, `marks()` filters to passage origins, `VERSION` is 3. Nothing new is openable yet; the app behaves exactly as before.
- Tests:
  - `threads.test.ts`: a tree with a passage child still reports it from `marks()` and `path()`.
  - `persistence.test.ts`: round-tripping a tree preserves both origin kinds (the thread-level one constructed directly, since `openThread` lands in the next stage) — in particular `marks()` after restore lists only the passage child.

## Opening a thread-level child

- Goal: `ThreadTree.openThread` exists; `threadSeed`, `threadAskTurn` and the `review` / `ideas` actions exist; `LEARNING_SYSTEM` covers whole-thread scope.
- Tests:
  - `prompt.test.ts`: `threadSeed` includes the last message of the parent transcript (where `contextSeed` truncated at the anchor), and carries the graph only when the parent has no seed of its own.
  - `prompt.test.ts`: `threadAskTurn` contains no `Selected:` block, and differs per action.
  - `threads.test.ts`: two `openThread` calls on the same parent both succeed, both appear in `threadChildren`, and neither appears in `marks()`.

## The pane and the dispatch loop

- Goal: with nothing selected, "Go deeper" shows the two suggestion buttons, the prompt to select text, the general-question box, and the two lists. Clicking one opens a thread-level child, which streams into the right pane and can be returned to from the list. `GO_BACK` no longer emits `mark:reveal` for a thread-level child.
- Tests (e2e, stubbed socket):
  - With nothing selected, clicking "Let's review what happened in this task." sends a request whose first user message contains the last message of the root transcript and no `Selected:` quote, and streams into the right pane.
  - Opening two thread-level children in a row succeeds, and both are listed in the pane when the user climbs back — i.e. the second is not rejected the way an overlapping selection is.
  - Typing into the general-question box with nothing selected opens a thread-level child whose opening turn is the typed text.
  - After `←` out of a thread-level child, the parent's transcript still shows its passage marks and no error is thrown for the missing highlight.
  - A passage selection still opens a passage thread with its quote (existing specs must keep passing unmodified).
