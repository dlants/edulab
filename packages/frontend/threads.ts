import { Conversation, type Socket } from "./conversation.ts";
import { type Action, LEARNING_SYSTEM, seedTurn } from "./prompt.ts";
import type { Anchor, Mark, ThreadId } from "./selection.ts";

export type { Action };

/** `anchor.thread` is the parent, so the link upward is the highlight itself. */
export type Origin = { anchor: Anchor; action: Action };

export type Thread = {
  id: ThreadId;
  /** null only for the root task thread. */
  origin: Origin | null;
  conversation: Conversation;
  /** Creation order; each child's `origin.anchor` is its highlight. */
  children: ThreadId[];
  activeChild: ThreadId | null;
  draft: string;
};

/** The tree of conversations. Every thread but the root was opened from a
 * passage of its parent, so a thread and the highlight over its parent are the
 * same edge seen from either end. Threads are never destroyed or reparented. */
export class ThreadTree {
  private readonly threads = new Map<ThreadId, Thread>();
  private nextId = 0;
  readonly root: ThreadId;
  private readonly socket: Socket;
  /** Attached to every conversation the tree owns, so a stream anywhere in the
   * tree re-syncs the app. */
  private readonly onChange: () => void;

  constructor(socket: Socket, root: Conversation, onChange: () => void) {
    this.socket = socket;
    this.onChange = onChange;
    this.root = this.add(null, root);
  }

  get(id: ThreadId): Thread {
    const thread = this.threads.get(id);
    if (!thread) throw new Error(`unknown thread ${id}`);
    return thread;
  }

  /** Seeds a child conversation from the parent's own seed plus its transcript
   * up to `anchor`, links it in, and makes it the parent's active child. The
   * caller starts it: the tree does not own the request lifecycle. */
  open(anchor: Anchor, action: Action): ThreadId {
    const parent = this.get(anchor.thread);
    const conversation = new Conversation(this.socket, {
      system: LEARNING_SYSTEM,
      seed: seedTurn(
        parent.conversation.seed,
        parent.conversation.messages,
        anchor,
        action,
      ),
    });
    const id = this.add({ anchor, action }, conversation);
    parent.children.push(id);
    parent.activeChild = id;
    return id;
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

  private add(origin: Origin | null, conversation: Conversation): ThreadId {
    const id = `t${this.nextId++}` as ThreadId;
    conversation.onChange = this.onChange;
    this.threads.set(id, {
      id,
      origin,
      conversation,
      children: [],
      activeChild: null,
      draft: "",
    });
    return id;
  }
}
