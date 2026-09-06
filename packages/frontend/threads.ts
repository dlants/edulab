import type Anthropic from "@anthropic-ai/sdk";
import type { ThreadSnapshot } from "./persistence.ts";
import {
  type Action,
  askTurn,
  contextSeed,
  LEARNING_SYSTEM,
  threadAskTurn,
  threadSeed,
} from "./prompt.ts";
import type { Anchor, Mark, ThreadId } from "./selection.ts";
import type { Tool, ToolName, TurnResult } from "./thread.ts";
import { type Socket, Thread } from "./thread.ts";

export type { Action };

/** The two ways a thread can be opened: off a passage of its parent, or off
 * the parent thread as a whole. Only the passage kind paints a highlight. */
export type Origin =
  | { type: "passage"; anchor: Anchor; action: Action }
  | { type: "thread"; parent: ThreadId; action: Action };

/** The thread this one was opened from. */
export function parentOf(origin: Origin): ThreadId {
  return origin.type === "passage" ? origin.anchor.thread : origin.parent;
}

/** What a child thread is given beyond its seed. */
export type ChildOpts = {
  tools?: Record<ToolName, Tool>;
  /** The rendered knowledge graph, injected into the seed of a top-level
   * learning thread. */
  graph?: string;
  yieldSchema?: Anthropic.Tool.InputSchema | "text" | "void";
};

export type TreeNode = {
  id: ThreadId;
  /** null only for the root task thread. */
  origin: Origin | null;
  thread: Thread;
  /** Creation order; a passage child's `origin.anchor` is its highlight. */
  children: ThreadId[];
  activeChild: ThreadId | null;
  draft: string;
};

/** The tree of threads. Every thread but the root was opened from its parent,
 * either off a passage of it - so a thread and the highlight over its parent
 * are the same edge seen from either end - or off the thread as a whole.
 * Threads are never destroyed or reparented. */
export class ThreadTree {
  private readonly threads = new Map<ThreadId, TreeNode>();
  private nextId = 0;
  root: ThreadId;
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
    const id = this.add({ type: "passage", anchor, action }, thread);
    parent.children.push(id);
    parent.activeChild = id;
    return id;
  }

  /** Seeds a child from the whole of `parent`'s transcript, with no passage:
   * it paints no highlight, and any number of them can hang off one parent. */
  openThread(parent: ThreadId, action: Action, opts: ChildOpts = {}): ThreadId {
    const node = this.get(parent);
    const thread = new Thread(this.socket, {
      system: LEARNING_SYSTEM,
      seed: threadSeed(
        typeof node.thread.seed === "string" ? node.thread.seed : undefined,
        node.thread.messages,
        opts.graph,
      ),
      initialTurns: [{ role: "user", content: threadAskTurn(action) }],
      tools: opts.tools,
      yieldSchema: opts.yieldSchema,
    });
    const id = this.add({ type: "thread", parent, action }, thread);
    node.children.push(id);
    node.activeChild = id;
    return id;
  }

  /** What a child thread settled with, once it has yielded. The parent renders
   * threads it never awaited, so the settled value has to be readable here. */
  result(id: ThreadId): TurnResult | undefined {
    return this.get(id).thread.result;
  }

  /** The highlights to draw over `id`'s transcript: one per passage child.
   * Thread-level children have no passage and so paint nothing. */
  marks(id: ThreadId): Mark[] {
    const out: Mark[] = [];
    for (const child of this.get(id).children) {
      const origin = this.get(child).origin;
      if (!origin) throw new Error("child thread without an origin");
      if (origin.type === "passage")
        out.push({ thread: child, anchor: origin.anchor });
    }
    return out;
  }

  /** The thread-level children of `id`, in creation order. */
  threadChildren(
    id: ThreadId,
  ): ReadonlyArray<{ thread: ThreadId; action: Action }> {
    const out: { thread: ThreadId; action: Action }[] = [];
    for (const child of this.get(id).children) {
      const origin = this.get(child).origin;
      if (!origin) throw new Error("child thread without an origin");
      if (origin.type === "thread")
        out.push({ thread: child, action: origin.action });
    }
    return out;
  }

  /** root -> id, for the depth indicator. */
  path(id: ThreadId): ThreadId[] {
    const out: ThreadId[] = [];
    let at: ThreadId | undefined = id;
    while (at) {
      out.unshift(at);
      const from: Origin | null = this.get(at).origin;
      at = from ? parentOf(from) : undefined;
    }
    return out;
  }

  /** The id counter, persisted so a restored tree cannot re-mint an id. */
  get nextThreadId(): number {
    return this.nextId;
  }

  /** Every node, in creation order. */
  nodes(): ReadonlyArray<TreeNode> {
    return [...this.threads.values()];
  }

  /** Rebuilds a tree from persisted snapshots rather than from a root thread.
   * `threadOf` mints the `Thread` for each snapshot, so the caller owns tool
   * wiring, which the snapshot deliberately does not carry. */
  static restore(
    socket: Socket,
    snapshots: ReadonlyArray<ThreadSnapshot>,
    root: ThreadId,
    nextId: number,
    onChange: () => void,
    threadOf: (snapshot: ThreadSnapshot) => Thread,
  ): ThreadTree {
    const rootSnapshot = snapshots.find((s) => s.id === root);
    if (!rootSnapshot) throw new Error(`no snapshot for root ${root}`);
    const tree = new ThreadTree(socket, threadOf(rootSnapshot), onChange);
    const rootThread = tree.get(tree.root).thread;
    tree.threads.clear();
    for (const snapshot of snapshots) {
      const thread = snapshot.id === root ? rootThread : threadOf(snapshot);
      tree.threads.set(snapshot.id, tree.node(snapshot, thread));
    }
    tree.root = root;
    tree.nextId = nextId;
    return tree;
  }

  private node(snapshot: ThreadSnapshot, thread: Thread): TreeNode {
    thread.onChange = this.onChange;
    return {
      id: snapshot.id,
      origin: snapshot.origin,
      thread,
      children: [...snapshot.children],
      activeChild: snapshot.activeChild,
      draft: snapshot.draft,
    };
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
