import type { ThreadId } from "./selection.ts";
import { type Message, type MessageIdx, messageText } from "./thread.ts";
import type { ThreadTree } from "./threads.ts";

/** `@message:<threadId>:<index>` - a reference from graph prose into the
 * transcript. The index is into that thread's `messages`. One token, no
 * delimiters and no link text: it survives a textarea, the model cannot get
 * the syntax subtly wrong, and a stale reference degrades to literal text. */
export type Citation = { thread: ThreadId; index: MessageIdx };

export function citationText(c: Citation): string {
  return `@message:${c.thread}:${c.index}`;
}

export type Span =
  | { type: "text"; text: string }
  | { type: "citation"; citation: Citation };

const PATTERN = /@message:([A-Za-z0-9_-]+):(\d+)/g;

/** Splits prose into literal runs and citations, so a renderer can walk it
 * without a second parse. Malformed references stay literal. */
export function parse(text: string): ReadonlyArray<Span> {
  const spans: Span[] = [];
  let at = 0;
  PATTERN.lastIndex = 0;
  for (let m = PATTERN.exec(text); m; m = PATTERN.exec(text)) {
    if (m.index > at)
      spans.push({ type: "text", text: text.slice(at, m.index) });
    spans.push({
      type: "citation",
      citation: {
        thread: m[1] as ThreadId,
        index: Number(m[2]) as MessageIdx,
      },
    });
    at = m.index + m[0].length;
  }
  if (at < text.length) spans.push({ type: "text", text: text.slice(at) });
  return spans;
}

/** The quote a chip is labelled with, or undefined when the reference does not
 * resolve against the current tree. Validating here is what turns a parsed
 * reference into an address. */
export function resolve(tree: ThreadTree, c: Citation): string | undefined {
  let messages: ReadonlyArray<Message>;
  try {
    messages = tree.get(c.thread).thread.messages;
  } catch {
    return undefined;
  }
  const message = messages[c.index];
  return message ? messageText(message) : undefined;
}
