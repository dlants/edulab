# Objective and Context

> I think we need a bit more functionality for our conversation primitive:
>
> - tool use
> - the ability to spawn a thread with a yield tool / schema, so we can spawn a thread that returns us structured data
>
> all are available in magenta. Let's:
>
> - rename Conversation to Thread
> - borrow the agent loop (streaming, tool execution)
> - borrow the yield tool concept (a thread can be spawned with a yield tool which means we can spawn a thread that terminates with structured data). See how yield interacts with tool calling.

## What exists today

`packages/frontend/conversation.ts` holds `Conversation`: an `Anthropic.MessageParam[]`, a single in-flight request keyed by `requestId`, and a stream accumulator over `RawMessageStreamEvent` that only understands `text` blocks. `send()`/`start()` issue exactly **one** request and resolve when it commits. Its public surface is `messages: ReadonlyArray<Message>` (`{ role, text }`), `inFlight`, `seed`, `onChange`.

Consumers:

- `packages/frontend/threads.ts` — `ThreadTree`, whose node type is *also* called `Thread` (`{ id, origin, conversation, children, activeChild, draft }`). Constructs child `Conversation`s in `open()`.
- `packages/frontend/prototypes/chat.ts` — owns the single `WebSocket`, projects the tree onto `State`, calls `.send()`, `.start()`, `.messages`, `.inFlight`.
- `packages/frontend/view.ts` — renders `Message`.
- `packages/frontend/selection.ts` — `Anchor`/`Point` index **into `message.text`** by character offset. This is the constraint that shapes the `Message` change below.
- `packages/frontend/conversation.test.ts` — `FakeSocket`, 7 unit tests over the accumulator.
- `packages/e2e/tests/chat.spec.ts` — `fakeBackend()` via `page.routeWebSocket`, replays scripted `ServerFrame`s.

`packages/backend/socket.ts` is a pipe: it forwards `message.params` to `client.messages.stream` unexamined, so `tools` and `tool_choice` already reach the API with **no backend change**. `packages/iso/protocol.ts` likewise needs no change.

## What we borrow from magenta

**While implementing, open the magenta sources and rip them off liberally.** The files below are the reference implementation for every piece of this plan; they are on disk at `~/src/magenta.nvim` and are meant to be read and copied from, not paraphrased from memory. Do not reinvent the stream accumulator, the tool-result completion rule, or the yield handshake — they are subtle, already debugged, and the shapes below are lifted from them. Simplify aggressively (drop the `Result` type, the hooks, the providers abstraction), but start from magenta's code rather than from a blank file, and when something here is ambiguous the magenta implementation is the tiebreaker.

- `node/core/src/agent.ts` — `runAgentLoop`: request → collect requested tools → execute → *always* append a complete set of tool results → loop. The invariant "every `tool_use` gets exactly one `tool_result`, even on abort or executor failure" (`completeToolResults`) is the part worth stealing.
- `node/core/src/providers/anthropic-inference.ts` — `tool_use` streaming: `content_block_start` opens a block carrying `inputJson: string`, `input_json_delta` appends `partial_json`, `content_block_stop` parses it.
- `node/core/src/tools/yield-to-parent.ts` — `getSpec(yieldSchema?)` swaps the tool's `input_schema` for a caller-supplied one; `execute` returns a fixed `"Yield acknowledged."` text result plus a `structuredResult` carrying the raw input. The thread, not the model, reads the structured value.
- `node/core/src/thread.ts` `yieldGate()` — yield is detected **in the tool results after the whole batch has run**, and suspends the turn.

We do **not** borrow: `NativeInferenceManager`, hooks, `SuspendReason`, retries, the `Result`/`ToolManager` machinery, subagent spawning. This stays a prototype.

# Design

A thread is still a sequence of user turns. What changes is the **agent turn**: one `send()` no longer means one request, it means a loop of request → tool execution → request, which ends when the model responds without calling a tool, or yields, or errors.

## Naming

- `conversation.ts` → `thread.ts`; `Conversation` → `Thread`; `conversation.test.ts` → `thread.test.ts`.
- The tree node in `threads.ts` collides, so it becomes `TreeNode`, and its `conversation` field becomes `thread`. `ThreadTree` and `ThreadId` keep their names — they were always about this concept.

## The log and the derived transcript

Following magenta's `NativeInferenceManager`: **the `Anthropic.MessageParam[]` is the log**, and everything the UI renders is derived from it one-directionally. The log is the wire format — nothing is written into it that the API would not accept, and nothing is converted back out of the display type. `messages` is a memoized projection recomputed whenever the log or the streaming block changes.

The projection flattens the log into a sequence of blocks, in log order:

- `text` blocks from either role become a `text` entry.
- `tool_use` blocks become a `tool_use` entry, paired with the `tool_result` carrying the same id — which lives in the *following* user turn in the log but belongs with the call in the transcript. This pairing is the whole reason for a derived view: the log's shape is dictated by the API, the transcript's by what the user should see.
- The seed turn is dropped, as today.
- The in-flight streaming block is appended last, so a partial response and a partial tool input both render.

Selection anchors index `{ msg, offset }` into this derived sequence, so a `text` entry has stable offsets exactly as today. `tool_use` entries are not anchorable for now (`anchorText` skips them, `segments` is only asked about text entries); making them anchorable is a later question. What matters is that the derived sequence is *the* thing selection indexes, so widening it later is a change to the projection, not to the log.

A consequence to hold on to: a single assistant turn in the log can produce several transcript entries (prose, a tool call, more prose). That is what an agent turn now looks like, and the transcript should show it that way rather than gluing the prose back together.

## The loop

`Thread.send(text)` (and `start()`) now run the whole turn:

1. Append the user turn (or the tool-result turn) and issue a request.
2. Accumulate blocks. `text` blocks concatenate as today; `tool_use` blocks accumulate `inputJson`.
3. On `message_delta`, record `stop_reason` (currently ignored — this is the signal the loop turns on).
4. On stop, commit the assistant turn from the accumulated blocks.
5. If there are no `tool_use` blocks, the turn is over.
6. Otherwise execute every requested tool **in parallel**, then append **one** user turn holding a `tool_result` for **every** `tool_use` id, in request order. A tool that is unknown, whose input fails to parse, or that throws yields `is_error: true` with the reason. This is `completeToolResults`: the array must stay valid for the next request.
7. If any executed tool was `yield`, stop here rather than issuing another request, and settle the thread with its input.
8. A `done`/`error` frame with a half-written assistant turn commits what arrived and ends the turn, as today.

## Yield vs. ordinary tools

Following magenta: yield is not special-cased during execution. It runs in the batch like any other tool, its `tool_result` is written like any other, and only *after* the batch is complete does the loop notice a yield among the results and stop. Consequences worth stating:

- Tools called alongside a yield still run, and their results still land in the log. The transcript is honest about what happened.
- If the model emits two yields, the first in request order wins.
- The message array is left well-formed, so a settled thread could still be resumed by a later prototype.
- Yield's own `tool_result` is the fixed string `"Yield acknowledged."` — echoing the yielded payload back at the model only spends tokens.

## Result

`send()`/`start()` resolve with a `TurnResult` rather than `void`. `Thread.result` also holds the settled value, since the tree renders threads it did not itself await.

A thread constructed with a `yieldSchema` has the yield tool appended to its tool list and `tool_choice: { type: "any" }` is **not** set — the model must be free to write prose and call other tools first. The prompt does the work, as in magenta's tool description.

## Interfaces

```ts
// packages/frontend/thread.ts

export type ToolCall = {
  id: string;
  name: string;
  /** Parsed from the streamed json; undefined while still streaming or if it
   * never parsed. */
  input: Record<string, unknown> | undefined;
  /** Raw accumulated json, so a partial call is still renderable. */
  inputJson: string;
  /** Derived from the paired tool_result block in the next user turn; absent
   * while the tool is still running. */
  result: ToolResult | undefined;
};

export type ToolResult =
  | { status: "ok"; text: string }
  | { status: "error"; error: string };

/** One entry of the derived transcript. `Message` is kept as the name the view
 * and selection already use, but it is now a block, not a turn. */
export type Message =
  | { type: "text"; role: "user" | "assistant"; text: string }
  | { type: "tool_use"; role: "assistant"; call: ToolCall };

/** A tool the thread can run, client side. */
export type Tool = {
  spec: Anthropic.Tool;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
};

export type YieldValue =
  | { type: "text"; text: string }
  | { type: "structured"; value: Record<string, unknown> };

export type TurnResult =
  | { type: "completed" }
  | { type: "yielded"; value: YieldValue }
  | { type: "error"; message: string };

export type ThreadOpts = {
  system?: string;
  initialTurns?: Anthropic.MessageParam[];
  seed?: string;
  tools?: Record<string, Tool>;
  /** Present => the yield tool is offered, with this as its input_schema. */
  yieldSchema?: Anthropic.Tool.InputSchema;
};

export class Thread {
  constructor(socket: Socket, opts?: ThreadOpts);
  readonly seed: string | undefined;
  get messages(): ReadonlyArray<Message>;
  get inFlight(): boolean;
  /** The settled yield, once the thread has produced one. */
  get result(): TurnResult | undefined;
  onChange: (() => void) | undefined;
  send(text: string): Promise<TurnResult>;
  start(): Promise<TurnResult>;
  handleFrame(frame: ServerFrame): void;
}
```

`yield` tool spec, built in `thread.ts`:

```ts
const YIELD = "yield";
const DEFAULT_YIELD_SCHEMA = {
  type: "object",
  properties: { result: { type: "string", description: "..." } },
  required: ["result"],
};
```

`YieldValue` is `{ type: "text" }` when no `yieldSchema` was supplied (read `input.result`), `{ type: "structured" }` otherwise (the whole input object).

## Invariants

- Every `tool_use` block in an assistant turn is answered by exactly one `tool_result` block in the immediately following user turn, in the same order — even when a tool throws, is unknown, has unparseable input, or the turn ends at a yield.
- Frames whose `requestId` the thread does not own are ignored, so many threads still multiplex over one socket.
- The log holds only what the API accepts; `Message` is derived from it and never converted back, so no wire-only field ever needs to appear on the display type.
- `messages` never exposes the seed turn, and the index and offsets of an already-committed text entry never change as the log grows — anchors are only valid because of this.
- A thread with an in-flight request rejects `send()`, as today.
- `RawMessageStreamEvent` stays an open union: unrecognized events `console.warn`, and "ignored on purpose" stays a separate branch from "never heard of it".
- Validation of tool input is the API's job via `input_schema`; the client re-checks only that the streamed json parsed at all.

# Stages

## rename

**Done.** `conversation.ts`/`conversation.test.ts` moved to `thread.ts`/`thread.test.ts`, `Conversation` is `Thread`, and the tree node is `TreeNode` with a `thread` field. `chat.ts` renames its `thread` locals to `node` so `node.thread` reads clearly. Behaviour and shapes unchanged; typecheck, vitest and biome are green.

- Goal: `Conversation` is `Thread` in `thread.ts`; `threads.ts`'s node type is `TreeNode` with a `thread` field; `chat.ts`, `view.ts`, tests and specs compile and pass unchanged in behaviour. Pure rename, no shape change — `Message` is still `{ role, text }`.
- Tests: the existing `thread.test.ts` (renamed) and `chat.spec.ts` pass untouched apart from identifiers. `npm run typecheck` and `npm run lint`.

## tool use in the stream accumulator

**Done.** `messages` is now a memoized projection (`project()` in `thread.ts`, invalidated by a `version` counter) over the log; `Message` is the `text` / `tool_use` union and `messageText()` is the accessor `view.ts`, `selection.ts` and `prompt.ts` use. The accumulator holds typed `PendingBlock`s, appends `input_json_delta` into `inputJson`, parses at `content_block_stop`, and records `stop_reason` on `message_delta` (unused until the next stage).

Deviations:

- A committed assistant turn is now always a `ContentBlockParam[]` rather than a bare string, since a turn can mix text and tool calls. `chat.spec.ts` and the e2e suite are unaffected; one unit test's expectation on the sent params changed shape.
- A tool call whose json never parsed commits as `input: {}` — the log must stay something the API would accept. `input: undefined` and the raw partial `inputJson` are therefore only observable while the block is still streaming, which is what the test asserts.
- `prompt.ts` renders a `tool_use` entry into the seed as `[called tool <name> with <json>]` rather than dropping it, so a learning thread seeded past a tool call still sees that it happened.
- Tool calls are not rendered yet: `MessageView` gets an empty text body for them. That is the "rendering and the tree" stage.

- Goal: `messages` becomes a derived projection over the log rather than a per-turn map; the accumulator understands `tool_use` blocks and `stop_reason`. Still no execution: a turn that requests tools stops and reports the calls.
- Tests (unit, `thread.test.ts` over `FakeSocket`):
  - A `tool_use` block streamed as `content_block_start` + two `input_json_delta`s surfaces on `messages` with the concatenated json parsed into `input`.
  - Text and a tool call in the same assistant turn project to two entries in log order, and an anchor into the text entry is unaffected by the tool entry that follows it.
  - A `tool_result` in the following user turn is paired onto its call rather than rendered as a user message of its own.
  - A stream that ends mid-`input_json_delta` leaves `input: undefined` and the partial `inputJson` intact rather than throwing.

## the tool loop

**Done.** `send()`/`start()` delegate to `run()`, which loops request → execute
all requested tools in parallel → append one `tool_result` per `tool_use` in
request order → request again, until an assistant turn contains no tool calls.
`inFlight` now tracks the whole turn (a `running` flag) rather than the single
request, so the composer stays disabled while tools execute. `request()`
resolves with the committed `ContentBlockParam[]`, which is what the loop
branches on.

Deviations:

- `send()` still resolves `void`; `TurnResult` arrives with yield in the next
  stage, where it has something to carry.
- A `done`/`error` frame sets a `failed` flag that ends the turn even when tool
  calls were committed — otherwise a truncated stream would trigger a request
  the model never asked for.
- Because a committed `tool_use` must carry an object the API would accept,
  unparseable json commits as `{}`; the ids whose json never parsed are kept in
  a `unparsed` set so `execute` can still answer them with `is_error`.
- Two stage-2 tests now drive a second request, since an unconfigured tool is
  answered with an unknown-tool error and the loop asks again.

- Goal: `send()` runs a turn to completion, executing tools and re-requesting until the model stops.
- Tests (unit): the `FakeSocket` is scripted to answer the first request with a tool call and the second with text.
  - The second request's `params.messages` ends with a user turn whose content is a `tool_result` matching the `tool_use` id — this is the integration that actually matters, so assert on the sent params, not on internal state.
  - A tool that rejects, and a tool the thread has never heard of, both still produce an `is_error` `tool_result`, and the loop continues.
  - Two tool calls in one message produce two results in one user turn, in request order.
  - `params.tools` carries the specs of the configured tools, and is absent when there are none.

## yield

**Done.** `send()`/`start()` resolve with a `TurnResult`; a thread constructed
with `yieldSchema` offers a `yield` tool and settles the turn with the yielded
value, recorded on `Thread.result`. Yield runs in the batch like any other tool
(its result is the fixed `"Yield acknowledged."`), and the loop stops only after
the whole batch's results are in the log.

Deviations:

- `yieldSchema` is `Anthropic.Tool.InputSchema | "text"` rather than an optional
  schema. The plan said both "the default `{ result: string }` schema when no
  schema is given" and "without a `yieldSchema` the tool is not offered at all",
  which cannot both hold for a single optional field. `"text"` selects the
  default schema and a `{ type: "text" }` yield value; absent means no yield
  tool, so a model that calls `yield` anyway gets an unknown-tool error.
- A turn ended by a `done`/`error` frame resolves `{ type: "error" }`; that
  result is not stored on `Thread.result`, which only holds a settled yield.
- `chat.ts` ignores the new return value, so nothing else changed this stage.

- Goal: a thread constructed with `yieldSchema` offers the yield tool and settles with structured data.
- Tests (unit):
  - A thread with a `yieldSchema` sends that schema as the yield tool's `input_schema`; without one, the default `{ result: string }` schema.
  - A yield call resolves the turn as `{ type: "yielded", value: { type: "structured", value: <input> } }`, and **no further request is sent**.
  - A yield alongside an ordinary tool call: both execute, both results are written into the message array, and the turn still stops at the yield.
  - Without a `yieldSchema`, the yield tool is not offered at all, and a model that somehow calls `yield` gets an unknown-tool error result like any other.

## rendering and the tree

- Goal: tool calls are visible in the transcript, and `ThreadTree.open()` can pass tools and a yield schema to a child.
- Tests:
  - `chat.spec.ts`: the scripted backend emits a tool call; the transcript shows the tool name, and highlighting the prose above it still opens a learning thread at the right offsets.
  - A learning thread opened with a yield schema settles and its structured value is available to the parent — exercised through the tree, not through `Thread` alone, since that wiring is where this can go wrong.
