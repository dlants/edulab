import type Anthropic from "@anthropic-ai/sdk";
import {
  type Action,
  askTurn,
  contextSeed,
  LEARNING_SYSTEM,
} from "./prompt.ts";
import type { Anchor, Mark, ThreadId } from "./selection.ts";
import type { Tool, ToolName, TurnResult } from "./thread.ts";
import { type Socket, Thread } from "./thread.ts";

export type { Action };

/** `anchor.thread` is the parent, so the link upward is the highlight itself. */
export type Origin = { anchor: Anchor; action: Action };

/** What a child thread is given beyond its seed. */
export type ChildOpts = {
  tools?: Record<ToolName, Tool>;
  /** The rendered knowledge graph, injected into the seed of a top-level
   * learning thread. */
  graph?: string;
  yieldSchema?: Anthropic.Tool.InputSchema | "text";
};

export type TreeNode = {
  id: ThreadId;
  /** null only for the root task thread. */
  origin: Origin | null;
  thread: Thread;
  /** Creation order; each child's `origin.anchor` is its highlight. */
  children: ThreadId[];
  activeChild: ThreadId | null;
  draft: string;
};

/** The tree of threads. Every thread but the root was opened from a
 * passage of its parent, so a thread and the highlight over its parent are the
 * same edge seen from either end. Threads are never destroyed or reparented. */
export class ThreadTree {
  private readonly threads = new Map<ThreadId, TreeNode>();
  private nextId = 0;
  readonly root: ThreadId;
  private readonly socket: Socket;
  /** Attached to every thread the tree owns, so a stream anywhere in the
   * tree re-syncs the app. */
  private readonly onChange: () => void;

  constructor(socket: Socket, root: Thread, onChange: () => void) {
    this.socket = socket;
    this.onChange = onChange;
    this.root = this.add(null, root);
  }

  get(id: ThreadId): TreeNode {
    const node = this.threads.get(id);
    if (!node) throw new Error(`unknown thread ${id}`);
    return node;
  }

  /** Seeds a child thread from the parent's own seed plus its transcript
   * up to `anchor`, links it in, and makes it the parent's active child. The
   * caller starts it: the tree does not own the request lifecycle. */
  open(anchor: Anchor, action: Action, opts: ChildOpts = {}): ThreadId {
    const parent = this.get(anchor.thread);
    const thread = new Thread(this.socket, {
      system: LEARNING_SYSTEM,
      seed: contextSeed(
        typeof parent.thread.seed === "string" ? parent.thread.seed : undefined,
        parent.thread.messages,
        anchor,
        opts.graph,
      ),
      initialTurns: [
        {
          role: "user",
          content: askTurn(anchor, parent.thread.messages, action),
        },
      ],
      tools: opts.tools,
      yieldSchema: opts.yieldSchema,
    });
    const id = this.add({ anchor, action }, thread);
    parent.children.push(id);
    parent.activeChild = id;
    return id;
  }

  /** What a child thread settled with, once it has yielded. The parent renders
   * threads it never awaited, so the settled value has to be readable here. */
  result(id: ThreadId): TurnResult | undefined {
    return this.get(id).thread.result;
  }

  /** The highlights to draw over `id`'s transcript: one per child. */
  marks(id: ThreadId): Mark[] {
    return this.get(id).children.map((child) => {
      const origin = this.get(child).origin;
      if (!origin) throw new Error("child thread without an origin");
      return { thread: child, anchor: origin.anchor };
    });
  }

  /** root -> id, for the depth indicator. */
  path(id: ThreadId): ThreadId[] {
    const out: ThreadId[] = [];
    let at: ThreadId | undefined = id;
    while (at) {
      out.unshift(at);
      at = this.get(at).origin?.anchor.thread;
    }
    return out;
  }

  private add(origin: Origin | null, thread: Thread): ThreadId {
    const id = `t${this.nextId++}` as ThreadId;
    thread.onChange = this.onChange;
    this.threads.set(id, {
      id,
      origin,
      thread,
      children: [],
      activeChild: null,
      draft: "",
    });
    return id;
  }
}
