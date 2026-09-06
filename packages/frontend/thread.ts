import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";

const MODEL = "claude-opus-4-5";
const MAX_TOKENS = 16384;
// Task mode: the agent is here to get the user's work done. Learning mode is
// the secondary mode we layer on top of a transcript this produces, so this
// prompt must not pre-emptively tutor - the whole premise of the prototype is
// that a user watching a capable agent work becomes a passive observer.
const SYSTEM = [
  "You are a capable engineering assistant helping the user complete a task.",
  "Work the problem directly: make concrete decisions, write real code, and",
  "state your reasoning as you go rather than asking the user to supply it.",
  "Be concise. Do not quiz the user, do not pad explanations for a beginner,",
  "and do not check whether they are following - just do the work well.",
].join(" ");

// Unattended mode: nobody is reading the transcript as it streams, so a
// question to the user is a dead end. The only exit is the yield tool.
const AUTONOMOUS_SYSTEM = [
  "You are a capable engineering assistant running unattended: there is no",
  "user to answer questions, and nothing you say outside the yield tool will",
  "be read. Work the problem to completion, making whatever decisions you",
  "need without asking, and finish by calling the yield tool exactly once",
  "with your result. Do not stop for confirmation and do not ask questions.",
].join(" ");

const MAX_RESTARTS = 5;
const restartNudge = (attempt: number, max: number) =>
  `You stopped without yielding. Nobody read that message. Complete the task and call the yield tool when you are done. (auto-restart ${attempt}/${max})`;

const YIELD = "yield";
const DEFAULT_YIELD_SCHEMA: Anthropic.Tool.InputSchema = {
  type: "object",
  properties: {
    result: {
      type: "string",
      description: "The result to return to whoever spawned this thread.",
    },
  },
  required: ["result"],
};

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

export type YieldValue =
  | { type: "text"; text: string }
  | { type: "structured"; value: Record<string, unknown> };

export type TurnResult =
  | { type: "completed" }
  | { type: "yielded"; value: YieldValue }
  | { type: "error"; message: string };

export type ThreadOpts = {
  system?: string;
  /** Sent after the seed, and rendered: a learning thread's opening ask is
   * one of these, not part of the seed. */
  initialTurns?: Anthropic.MessageParam[];
  /** Content blocks rather than a string when the caller needs `cache_control`
   * on part of it - a graph update marks its stable prefix. */
  seed?: string | Anthropic.ContentBlockParam[];
  tools?: Record<ToolName, Tool>;
  /** Present => the yield tool is offered. `"text"` uses the default
   * `{ result: string }` schema and settles with a text value; a schema
   * settles with the whole input object. */
  yieldSchema?: Anthropic.Tool.InputSchema | "text";
};

/** The key of a tool in the record handed to a thread; also what the model
 * sends back as `tool_use.name`. */
export type ToolName = string & { readonly __brand: "ToolName" };

export type ToolResult =
  | { status: "ok"; text: string }
  | { status: "error"; error: string };
/** A tool the thread can run, client side. */
export type Tool = {
  spec: Anthropic.Tool;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
};

/** Keys a set of tools by name. `Record<ToolName, Tool>` is a mapped type over
 * a branded string, so an object literal cannot be written for it directly. */
export function toolset(...tools: ReadonlyArray<Tool>): Record<ToolName, Tool> {
  return Object.fromEntries(tools.map((t) => [t.spec.name, t]));
}

/** One entry of the derived transcript: a block, not a turn. A single agent
 * turn can produce prose, a tool call, and more prose, and the transcript shows
 * it that way. */
export type Message =
  | { type: "text"; role: "user" | "assistant"; text: string }
  | { type: "tool_use"; role: "assistant"; call: ToolCall };

/** A position in a thread's `messages`. Branded because it is an identifier -
 * half of the `(thread, index)` address an interaction and a citation are
 * written as - and only ever produced by reading a real position. */
export type MessageIdx = number & { readonly __brand: "MessageIdx" };

/** Anchors index into text entries only, so everything else has no text. */
export function messageText(message: Message): string {
  return message.type === "text" ? message.text : "";
}

/** A block of the assistant turn currently streaming. */
type PendingBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      inputJson: string;
      input: Record<string, unknown> | undefined;
    };

/** The subset of WebSocket the thread uses, so tests can stand in for it. */
export type Socket = {
  send(data: string): void;
  addEventListener(
    type: "message",
    listener: (e: MessageEvent<string>) => void,
  ): void;
};

export type ThreadResult<Value> =
  | { status: "ok"; result: Value }
  | { status: "error"; error: string };

export type RunThreadOpts = {
  prompt: string | Anthropic.ContentBlockParam[];
  tools?: Record<ToolName, Tool>;
  yieldSchema: Anthropic.Tool.InputSchema | "text";
  system?: string;
  /** How many times a turn that ends without a yield is nudged back to work. */
  maxRestarts?: number;
  /** Fires whenever the thread's transcript changes, so a caller can watch an
   * unattended thread work rather than only awaiting its result. */
  onChange?: (messages: ReadonlyArray<Message>) => void;
};

/** Runs a thread to completion with no user in the loop: the seed prompt goes
 * in, tools run client side, and the settled yield comes back. A turn that
 * ends without yielding is restarted rather than accepted. */
export function runThread(
  socket: Socket,
  opts: RunThreadOpts & { yieldSchema: "text" },
): Promise<ThreadResult<string>>;
export function runThread<Value extends Record<string, unknown>>(
  socket: Socket,
  opts: RunThreadOpts & { yieldSchema: Anthropic.Tool.InputSchema },
): Promise<ThreadResult<Value>>;
export async function runThread(
  socket: Socket,
  opts: RunThreadOpts,
): Promise<ThreadResult<string | Record<string, unknown>>> {
  const maxRestarts = opts.maxRestarts ?? MAX_RESTARTS;
  const thread = new Thread(socket, {
    system: opts.system ?? AUTONOMOUS_SYSTEM,
    seed: opts.prompt,
    tools: opts.tools,
    yieldSchema: opts.yieldSchema,
  });
  const onChange = opts.onChange;
  if (onChange) thread.onChange = () => onChange(thread.messages);
  let result = await thread.start();
  for (let attempt = 1; result.type === "completed"; attempt++) {
    if (attempt > maxRestarts) {
      return {
        status: "error",
        error: `thread stopped without yielding after ${maxRestarts} restarts`,
      };
    }
    result = await thread.send(restartNudge(attempt, maxRestarts));
  }
  return result.type === "yielded"
    ? {
        status: "ok",
        result:
          result.value.type === "text" ? result.value.text : result.value.value,
      }
    : { status: "error", error: result.message };
}

/** Drops trailing turns until every `tool_use` in the log is answered by a
 * `tool_result`: the API rejects a log with a dangling call, which is exactly
 * what a refresh mid-tool-call leaves behind. A trailing user turn that simply
 * never got a reply is well-formed and is kept. */
/** The transcript a committed log projects to, for callers that hold a log
 * without a live `Thread` (persistence addresses interactions by message
 * index, and the index has to mean the same thing on both sides). */
export function projectLog(
  turns: ReadonlyArray<Anthropic.MessageParam>,
): ReadonlyArray<Message> {
  return project(turns, undefined);
}

export function trimUnansweredTools(
  log: ReadonlyArray<Anthropic.MessageParam>,
): Anthropic.MessageParam[] {
  const out = [...log];
  while (out.length > 0 && !answered(out)) out.pop();
  return out;
}
function answered(log: ReadonlyArray<Anthropic.MessageParam>): boolean {
  const results = new Set<string>();
  for (const turn of log) {
    if (typeof turn.content === "string") continue;
    for (const block of turn.content)
      if (block.type === "tool_result") results.add(block.tool_use_id);
  }
  for (const turn of log) {
    if (typeof turn.content === "string") continue;
    for (const block of turn.content)
      if (block.type === "tool_use" && !results.has(block.id)) return false;
  }
  return true;
}
export class Thread {
  private readonly turns: Anthropic.MessageParam[];
  private pending:
    | {
        requestId: string;
        blocks: PendingBlock[];
        stopReason: string | null;
      }
    | undefined;
  /** Bumped whenever the log or the streaming block changes, so `messages` can
   * be recomputed lazily rather than on every delta. */
  private version = 0;
  private cache:
    | { version: number; messages: ReadonlyArray<Message> }
    | undefined;
  private settle:
    | ((content: Anthropic.ContentBlockParam[]) => void)
    | undefined;
  /** True for the whole agent turn, including while tools execute between
   * requests - the UI and the send guard care about the turn, not the request. */
  private running = false;
  /** Set when a request ends in a done/error frame, which ends the turn even
   * if tools were requested. */
  private failed = false;
  /** tool_use ids whose streamed json never parsed. The log has to carry an
   * object the API would accept, so this is the only place that knowledge
   * survives the commit. */
  private readonly unparsed = new Set<string>();
  onChange: (() => void) | undefined;

  private readonly socket: Socket;
  private readonly system: string;
  private readonly tools: Record<ToolName, Tool>;
  /** Present => the yield tool is offered and the turn can settle with data. */
  private readonly yieldSchema: Anthropic.Tool.InputSchema | "text" | undefined;
  private settled: TurnResult | undefined;
  /** Turn 0 when present: sent like any other turn, never rendered. */
  readonly seed: string | Anthropic.ContentBlockParam[] | undefined;

  constructor(socket: Socket, opts: ThreadOpts = {}) {
    this.socket = socket;
    this.system = opts.system ?? SYSTEM;
    this.tools = opts.tools ?? {};
    this.yieldSchema = opts.yieldSchema;
    this.seed = opts.seed;
    this.turns = [
      ...(opts.seed ? [{ role: "user" as const, content: opts.seed }] : []),
      ...(opts.initialTurns ?? []),
    ];
    socket.addEventListener("message", (e: MessageEvent<string>) => {
      this.handleFrame(JSON.parse(e.data) as ServerFrame);
    });
  }

  /** The derived transcript: the log flattened into blocks, plus whatever is
   * currently streaming. The log stays the wire format; nothing is ever
   * converted back out of `Message`. */
  get messages(): ReadonlyArray<Message> {
    if (this.cache?.version === this.version) return this.cache.messages;
    const messages = project(
      this.seed ? this.turns.slice(1) : this.turns,
      this.pending?.blocks,
    );
    this.cache = { version: this.version, messages };
    return messages;
  }

  /** The committed wire log minus the seed turn: what a snapshot stores and
   * what `initialTurns` restores. Turns still streaming are not in it. */
  get log(): ReadonlyArray<Anthropic.MessageParam> {
    return this.seed ? this.turns.slice(1) : this.turns;
  }
  get systemPrompt(): string {
    return this.system;
  }
  get inFlight(): boolean {
    return this.running;
  }

  /** The settled yield, once the thread has produced one. */
  get result(): TurnResult | undefined {
    return this.settled;
  }

  send(text: string): Promise<TurnResult> {
    if (this.running) return Promise.resolve({ type: "completed" });
    this.turns.push({ role: "user", content: text });
    this.version++;
    return this.run();
  }

  /** Requests a reply to the turns already present - the seeded first turn of
   * a learning thread, which the user never typed. */
  start(): Promise<TurnResult> {
    if (this.running || this.turns.length === 0)
      return Promise.resolve({ type: "completed" });
    return this.run();
  }

  /** One agent turn: request, execute whatever tools the model asked for,
   * request again, until it replies without calling any. */
  private async run(): Promise<TurnResult> {
    this.running = true;
    this.failed = false;
    try {
      for (;;) {
        const content = await this.request();
        if (this.failed) return { type: "error", message: "request ended" };
        const calls = content.filter(
          (block): block is Anthropic.ToolUseBlockParam =>
            block.type === "tool_use",
        );
        if (calls.length === 0) return { type: "completed" };
        // Every tool_use must be answered by exactly one tool_result in the
        // immediately following user turn, in request order, or the next
        // request is rejected outright.
        const results = await Promise.all(
          calls.map((call) => this.execute(call)),
        );
        this.turns.push({ role: "user", content: results });
        this.version++;
        this.onChange?.();
        // Yield is not special-cased during execution: the whole batch runs and
        // every result lands in the log, and only then does the turn stop.
        const yielded = calls.find((call) => this.isYield(call.name));
        if (yielded) {
          const result: TurnResult = {
            type: "yielded",
            value: this.yieldValue(
              (yielded.input ?? {}) as Record<string, unknown>,
            ),
          };
          this.settled = result;
          return result;
        }
      }
    } finally {
      this.running = false;
      this.onChange?.();
    }
  }

  private isYield(name: string): boolean {
    return this.yieldSchema !== undefined && name === YIELD;
  }

  private yieldValue(input: Record<string, unknown>): YieldValue {
    return this.yieldSchema === "text"
      ? { type: "text", text: String(input.result ?? "") }
      : { type: "structured", value: input };
  }

  private toolSpecs(): Anthropic.Tool[] {
    const specs = Object.values(this.tools).map((tool) => tool.spec);
    if (this.yieldSchema !== undefined) {
      specs.push({
        name: YIELD,
        description:
          "Finish this thread and return your result to whoever spawned it. Call this exactly once, when you are done; do not call it before you have finished the work.",
        input_schema:
          this.yieldSchema === "text" ? DEFAULT_YIELD_SCHEMA : this.yieldSchema,
      });
    }
    return specs;
  }

  private async execute(
    call: Anthropic.ToolUseBlockParam,
  ): Promise<Anthropic.ToolResultBlockParam> {
    const result: ToolResult = this.unparsed.has(call.id)
      ? { status: "error", error: "could not parse tool input" }
      : this.isYield(call.name)
        ? // Echoing the yielded payload back at the model only spends tokens.
          { status: "ok", text: "Yield acknowledged." }
        : await runTool(this.tools[call.name as ToolName], call);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: result.status === "ok" ? result.text : result.error,
      is_error: result.status === "error",
    };
  }

  /** Resolves with the assistant content the request committed. */
  private request(): Promise<Anthropic.ContentBlockParam[]> {
    const specs = this.toolSpecs();
    const requestId = crypto.randomUUID();
    this.pending = { requestId, blocks: [], stopReason: null };
    this.version++;
    const message: ClientMessage = {
      type: "start",
      requestId,
      params: {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: this.system,
        stream: true,
        messages: [...this.turns],
        ...(specs.length > 0 ? { tools: specs } : {}),
      },
    };
    this.socket.send(JSON.stringify(message));
    this.onChange?.();
    return new Promise<Anthropic.ContentBlockParam[]>((resolve) => {
      this.settle = resolve;
    });
  }

  handleFrame(frame: ServerFrame): void {
    const pending = this.pending;
    if (!pending || frame.requestId !== pending.requestId) return;
    switch (frame.type) {
      case "event":
        this.handleEvent(frame.event);
        break;
      case "done":
      case "error":
        this.failed = true;
        // A turn that ends without a message_stop still commits whatever text
        // arrived, so the next turn's array stays valid.
        this.commit();
        break;
    }
    this.version++;
    this.onChange?.();
  }

  private handleEvent(event: Anthropic.RawMessageStreamEvent): void {
    const pending = this.pending;
    if (!pending) return;
    // RawMessageStreamEvent is an open union we forward verbatim from the SDK,
    // so an unrecognized event warns rather than throwing - a version bump
    // should not break a stream we can otherwise render.
    switch (event.type) {
      case "content_block_start": {
        const block = startBlock(event.content_block);
        if (block) pending.blocks[event.index] = block;
        break;
      }
      case "content_block_delta":
        appendDelta(pending.blocks[event.index], event.delta);
        break;
      case "content_block_stop": {
        const block = pending.blocks[event.index];
        // The model's json only becomes readable once it is complete; a stream
        // cut short leaves `input` undefined and the partial json in place.
        if (block?.type === "tool_use")
          block.input = parseInput(block.inputJson);
        break;
      }
      case "message_delta":
        pending.stopReason = event.delta.stop_reason;
        break;
      case "message_stop":
        this.commit();
        break;
      case "message_start":
        break;
      default:
        console.warn("unhandled stream event", event);
    }
  }

  private commit(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    for (const block of pending.blocks) {
      if (block?.type === "tool_use" && block.input === undefined) {
        this.unparsed.add(block.id);
      }
    }
    const content = commitBlocks(pending.blocks);
    // MessageParam content must be non-empty, so an empty response is dropped.
    if (content.length > 0) this.turns.push({ role: "assistant", content });
    this.settle?.(content);
    this.settle = undefined;
  }
}

async function runTool(
  tool: Tool | undefined,
  call: Anthropic.ToolUseBlockParam,
): Promise<ToolResult> {
  if (!tool) return { status: "error", error: `unknown tool: ${call.name}` };
  // Validating input against input_schema is the API's job; the client only
  // checks that the streamed json parsed at all, which it did by here.
  const input = (call.input ?? {}) as Record<string, unknown>;
  try {
    return await tool.execute(input);
  } catch (error) {
    return { status: "error", error: String(error) };
  }
}

function commitBlocks(
  blocks: ReadonlyArray<PendingBlock>,
): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const block of blocks) {
    if (!block) continue;
    if (block.type === "text") {
      if (block.text.length > 0) out.push({ type: "text", text: block.text });
    } else {
      out.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      });
    }
  }
  return out;
}

/** Flattens the log into transcript entries, pairing each tool call with the
 * result that arrives in the following user turn. */
function project(
  turns: ReadonlyArray<Anthropic.MessageParam>,
  streaming: ReadonlyArray<PendingBlock> | undefined,
): ReadonlyArray<Message> {
  const results = new Map<string, ToolResult>();
  for (const turn of turns) {
    if (typeof turn.content === "string") continue;
    for (const block of turn.content) {
      if (block.type === "tool_result") {
        results.set(block.tool_use_id, toolResult(block));
      }
    }
  }

  const out: Message[] = [];
  for (const turn of turns) {
    const role = turn.role === "assistant" ? "assistant" : "user";
    if (typeof turn.content === "string") {
      out.push({ type: "text", role, text: turn.content });
      continue;
    }
    for (const block of turn.content) {
      switch (block.type) {
        case "text":
          out.push({ type: "text", role, text: block.text });
          break;
        case "tool_use":
          out.push({
            type: "tool_use",
            role: "assistant",
            call: {
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown> | undefined,
              inputJson: JSON.stringify(block.input ?? {}),
              result: results.get(block.id),
            },
          });
          break;
        default:
          // tool_result blocks are shown on the call they answer, and the
          // remaining variants are not produced by this prototype.
          break;
      }
    }
  }

  for (const block of streaming ?? []) {
    if (!block) continue;
    if (block.type === "text") {
      if (block.text.length > 0) {
        out.push({ type: "text", role: "assistant", text: block.text });
      }
    } else {
      out.push({
        type: "tool_use",
        role: "assistant",
        call: {
          id: block.id,
          name: block.name,
          input: block.input,
          inputJson: block.inputJson,
          result: undefined,
        },
      });
    }
  }
  return out;
}

function toolResult(block: Anthropic.ToolResultBlockParam): ToolResult {
  const content = block.content;
  const text =
    typeof content === "string"
      ? content
      : (content ?? [])
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
  return block.is_error
    ? { status: "error", error: text }
    : { status: "ok", text };
}

function parseInput(json: string): Record<string, unknown> | undefined {
  if (json.trim() === "") return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Thinking blocks are not requested by this prototype, so they are warned
 * about rather than silently dropped - when we add them, this is where they
 * surface. */
function startBlock(block: Anthropic.ContentBlock): PendingBlock | undefined {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        inputJson: "",
        input: undefined,
      };
    default:
      console.warn("unhandled content block", block);
      return undefined;
  }
}

function appendDelta(
  block: PendingBlock | undefined,
  delta: Anthropic.RawContentBlockDelta,
): void {
  switch (delta.type) {
    case "text_delta":
      if (block?.type === "text") block.text += delta.text;
      break;
    case "input_json_delta":
      if (block?.type === "tool_use") block.inputJson += delta.partial_json;
      break;
    default:
      console.warn("unhandled content block delta", delta);
  }
}
