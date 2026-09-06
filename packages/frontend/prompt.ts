import { type Anchor, anchorText, type ThreadId } from "./selection.ts";
import type { Message } from "./thread.ts";
import type { ThreadTree } from "./threads.ts";

export type Action =
  | { type: "explain" }
  | { type: "quiz" }
  | { type: "query"; text: string };

/** Learning mode: the agent is explaining work that already happened, to a
 * user who chose the passage they are stuck on. */
export const LEARNING_SYSTEM = [
  "You are helping a user understand engineering work that was done for them.",
  "They will show you a transcript and point at a passage they picked out.",
  "Answer about that passage specifically, in plain language, and assume the",
  "user has not followed the reasoning that produced it. Be concise, and do",
  "not restate the whole transcript back to them.",
  "",
  "You may be shown a knowledge graph: what we believe this user already",
  "understands, one line per node and edge, each with an id and a level on the",
  "scale 1 unfamiliar, 2 emerging, 3 working, 4 fluent. Pitch your answer to",
  "it: build on what they are fluent in and slow down on what they are not.",
  "The overview is titles only, so call the `get` tool with the ids of",
  "anything you are about to lean on to read its full description and the",
  "notes on this user. You cannot change the graph; do not offer to.",
].join(" ");

/** The context a learning thread is seeded with: its parent's own seed plus
 * the parent's transcript up to the anchor. `seed` is emitted verbatim -
 * wrapping or re-labelling it would nest the framing one layer deeper at
 * every level. The passage and the ask are not here: they are the thread's
 * first visible turn. */
export function contextSeed(
  seed: string | undefined,
  messages: ReadonlyArray<Message>,
  anchor: Anchor,
  graph?: string,
): string {
  const sections = [];
  // Only the topmost learning thread renders the graph: a deeper thread's
  // `seed` is its parent's, which already carries it, and repeating it would
  // show the model the same overview once per level.
  if (seed) sections.push(seed);
  else if (graph)
    sections.push(`What this user already understands:\n${graph}`);
  sections.push(transcript(visibleTo(messages, anchor)));
  return sections.join("\n\n");
}

/** The user's opening turn: the passage they highlighted and what they asked
 * of it. Visible, because it is an interaction like any other. */
export function askTurn(
  anchor: Anchor,
  messages: ReadonlyArray<Message>,
  action: Action,
): string {
  const quote = anchorText(anchor, visibleTo(messages, anchor));
  return `Selected: "${quote}"\n\n${ask(action)}`;
}

/** The parent's transcript truncated after the message the selection ends in:
 * nothing later than the passage is context for asking about it. */
function visibleTo(
  messages: ReadonlyArray<Message>,
  anchor: Anchor,
): ReadonlyArray<Message> {
  return messages.slice(0, anchor.end.msg + 1);
}

/** Extraction mode: one detached pass over the whole session, whose only
 * output is the graph it writes through its tools. Nobody reads its prose. */
export const EXTRACT_SYSTEM = [
  "You are reading a session in which an engineering agent did some work for",
  "a user, together with the follow-up threads the user opened on passages",
  "they did not understand. Your job is to maintain a knowledge graph of the",
  "domains this session touched.",
  "One node per concept - an idea a person can understand or fail to",
  "understand - never one per file, message or line of code. Add edges for the",
  "relationships that matter: what builds on what, what is an instance of",
  "what. Set the level from what the user's own questions and answers reveal,",
  "on the scale 1 unfamiliar, 2 emerging, 3 working, 4 fluent, defaulting to 1",
  "for a concept they never engaged with. The scale cannot express a",
  "misconception - a confidently held wrong belief reads as fluent - so put",
  "misconceptions, and anything else about how this user holds the idea, in",
  "`notes`.",
  "The current graph is shown below. Extend it: update the nodes that already",
  "exist rather than minting a second node for the same concept. Work in",
  "batches, and stop when the graph reflects the session. Nothing you say",
  "outside the tools is read.",
].join(" ");

/** The whole session as one prompt: every thread depth-first, each child
 * labelled with what the user asked and the passage they asked it about. The
 * questions the user asked are the evidence about what they did not
 * understand, so they have to survive into the seed. */
export function renderTree(tree: ThreadTree, graph?: string): string {
  const sections: string[] = [];
  if (graph) sections.push(`The current knowledge graph:\n${graph}`);
  walk(tree, tree.root, 0, sections);
  return sections.join("\n\n");
}

function walk(
  tree: ThreadTree,
  id: ThreadId,
  depth: number,
  out: string[],
): void {
  const node = tree.get(id);
  const origin = node.origin;
  const quote = origin
    ? anchorText(origin.anchor, tree.get(origin.anchor.thread).thread.messages)
    : "";
  const header = origin
    ? `Follow-up thread (depth ${depth}) on "${quote}" - the user said: ${actionLabel(origin.action)}`
    : "The task session:";
  out.push(`${header}\n${transcript(node.thread.messages)}`);
  for (const child of node.children) walk(tree, child, depth + 1, out);
}

function transcript(messages: ReadonlyArray<Message>): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${line(m)}`)
    .join("\n\n");
}

function line(message: Message): string {
  return message.type === "text"
    ? message.text
    : `[called tool ${message.call.name} with ${message.call.inputJson}]`;
}

/** How the thread was opened, shown at the top of its pane so the user can see
 * what they asked for. */
export function actionLabel(action: Action): string {
  switch (action.type) {
    case "explain":
      return "I don't understand this.";
    case "quiz":
      return "Quiz me on this.";
    case "query":
      return action.text;
  }
}

/** What the user is asking for, in their own voice: this is a user turn now,
 * not a briefing written about them. */
function ask(action: Action): string {
  switch (action.type) {
    case "explain":
      return "I don't understand this. Explain what it means and why it is there.";
    case "quiz":
      return "Quiz me on this. Ask one question that checks whether I understand it, and wait for my answer.";
    case "query":
      return action.text;
  }
}
