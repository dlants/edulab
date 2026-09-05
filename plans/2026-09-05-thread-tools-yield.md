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

- `node/core/src/agent.ts` — `runAgentLoop`: request → collect requested tools → execute → *always* append a complete set of tool results → loop. The invariant "every `tool_use` gets exactly one `tool_result`, even on abort or executor failure" (`completeToolResults`) is the part worth stealing.
- `node/core/src/providers/anthropic-inference.ts` — `tool_use` streaming: `content_block_start` opens a block carrying `inputJson: string`, `input_json_delta` appends `partial_json`, `content_block_stop` parses it.
- `node/core/src/tools/yield-to-parent.ts` — `getSpec(yieldSchema?)` swaps the tool's `input_schema` for a caller-supplied one; `execute` returns a fixed `"Yield acknowledged."` text result plus a `structuredResult` carrying the raw input. The thread, not the model, reads the structured value.
- `node/core/src/thread.ts` `yieldGate()` — yield is detected **in the tool results after the whole batch has run**, and suspends the turn.

We do **not** borrow: `NativeInferenceManager`, hooks, `SuspendReason`, retries, the `Result`/`ToolManager` machinery, subagent spawning. This stays a prototype.

# Design

`Thread` grows from "one request" to "one turn": a loop of request → tools → request, ending when the model stops without tool calls, or yields, or errors.

## Naming

- `conversation.ts` → `thread.ts`; `Conversation` → `Thread`; `conversation.test.ts` → `thread.test.ts`.
- The tree node in `threads.ts` collides, so it becomes `TreeNode`, and its `conversation` field becomes `thread`. `ThreadTree` and `ThreadId` keep their names — they were always about this concept.

## Messages and selection

Selection anchors are character offsets into `message.text`, and the transcript is append-only. Rather than turn `Message` into a block list (which would break every anchor and all of `selection.ts`), `text` stays the prose of the turn and tool activity rides alongside:

`Message = { role; text; tools: ReadonlyArray<ToolCall> }`

Tool calls are rendered under the message, are not anchorable, and `selection.ts` is untouched. This is a deliberate limitation: the user cannot highlight inside a tool call. Prototype 1 highlights prose.

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

A `MAX_TURNS` constant (say 20) bounds the loop, so a tool-calling cycle cannot spin the demo forever.

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
  result: ToolResult | undefined;
};

export type ToolResult =
  | { status: "ok"; text: string }
  | { status: "error"; error: string };

export type Message = {
  role: "user" | "assistant";
  text: string;
  tools: ReadonlyArray<ToolCall>;
};

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
  | { type: "error"; message: string }
  | { type: "exhausted" }; // hit MAX_TURNS

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
- `messages` never exposes the seed turn, and offsets into `message.text` remain stable once written — appending tool calls to a message must not shift its text.
- A thread with an in-flight request rejects `send()`, as today.
- `RawMessageStreamEvent` stays an open union: unrecognized events `console.warn`, and "ignored on purpose" stays a separate branch from "never heard of it".
- Validation of tool input is the API's job via `input_schema`; the client re-checks only that the streamed json parsed at all.

# Stages

## rename

- Goal: `Conversation` is `Thread` in `thread.ts`; `threads.ts`'s node type is `TreeNode` with a `thread` field; `chat.ts`, `view.ts`, tests and specs compile and pass unchanged in behaviour. `Message` gains `tools: []`, always empty. No new behaviour.
- Tests: the existing `thread.test.ts` (renamed) and `chat.spec.ts` pass untouched apart from identifiers. `npm run typecheck` and `npm run lint`.

## tool use in the stream accumulator

- Goal: the accumulator understands `tool_use` blocks and `stop_reason`. `Message.tools` is populated. Still no execution: a turn that requests tools stops and reports the calls.
- Tests (unit, `thread.test.ts` over `FakeSocket`):
  - A `tool_use` block streamed as `content_block_start` + two `input_json_delta`s surfaces on `messages` with the concatenated json parsed into `input`.
  - Text and a tool call in the same assistant message both land, and `message.text` contains only the text — an anchor taken before the tool block is unmoved by it.
  - A stream that ends mid-`input_json_delta` leaves `input: undefined` and the partial `inputJson` intact rather than throwing.

## the tool loop

- Goal: `send()` runs a turn to completion, executing tools and re-requesting until the model stops.
- Tests (unit): the `FakeSocket` is scripted to answer the first request with a tool call and the second with text.
  - The second request's `params.messages` ends with a user turn whose content is a `tool_result` matching the `tool_use` id — this is the integration that actually matters, so assert on the sent params, not on internal state.
  - A tool that rejects, and a tool the thread has never heard of, both still produce an `is_error` `tool_result`, and the loop continues.
  - Two tool calls in one message produce two results in one user turn, in request order.
  - `MAX_TURNS` is reached when the script always answers with a tool call: resolves `{ type: "exhausted" }` and stops sending.
  - `params.tools` carries the specs of the configured tools, and is absent when there are none.

## yield

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
