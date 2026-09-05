import { type Anchor, anchorText } from "./selection.ts";
import type { Message } from "./thread.ts";

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

/** The single synthetic user turn seeding a learning thread. `seed` is the
 * parent's own seed and is emitted verbatim - wrapping or re-labelling it
 * would nest the framing one layer deeper at every level. */
export function seedTurn(
  seed: string | undefined,
  messages: ReadonlyArray<Message>,
  anchor: Anchor,
  action: Action,
  graph?: string,
): string {
  const visible = messages.slice(0, anchor.end.msg + 1);
  const sections = [];
  // Only the topmost learning thread renders the graph: a deeper thread's
  // `seed` is its parent's, which already carries it, and repeating it would
  // show the model the same overview once per level.
  if (seed) sections.push(seed);
  else if (graph)
    sections.push(`What this user already understands:\n${graph}`);
  sections.push(transcript(visible));
  sections.push(
    `The user then selected: "${anchorText(anchor, visible)}"\n${question(action)}`,
  );
  return sections.join("\n\n");
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

function question(action: Action): string {
  switch (action.type) {
    case "explain":
      return "They said they don't understand this. Explain what it means and why it is there.";
    case "quiz":
      return "They asked to be quizzed on this. Ask one question that checks whether they understand it, and wait for their answer.";
    case "query":
      return `They asked: ${action.text}`;
  }
}
