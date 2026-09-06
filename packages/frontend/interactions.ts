import type { ThreadId } from "./selection.ts";
import { type Message, type MessageIdx, messageText } from "./thread.ts";
import type { ThreadTree } from "./threads.ts";

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
): Interaction {
  const node = tree.get(thread);
  const messages = node.thread.messages;
  const message = messages[index];
  if (!message) {
    throw new Error(`no message ${index} in thread ${thread}`);
  }
  if (message.role !== "user") {
    throw new Error(`message ${index} in thread ${thread} is not a user turn`);
  }
  return {
    thread,
    index,
    prefix: { seed: node.thread.seed, messages: messages.slice(0, index) },
    text: messageText(message),
  };
}
