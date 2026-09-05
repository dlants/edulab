import { type Anchor, anchorText } from "./selection.ts";

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
].join(" ");

/** The single synthetic user turn seeding a learning thread. `seed` is the
 * parent's own seed and is emitted verbatim - wrapping or re-labelling it
 * would nest the framing one layer deeper at every level. */
export function seedTurn(
  seed: string | undefined,
  messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
  anchor: Anchor,
  action: Action,
): string {
  const visible = messages.slice(0, anchor.end.msg + 1);
  const sections = [];
  if (seed) sections.push(seed);
  sections.push(transcript(visible));
  sections.push(
    `The user then selected: "${anchorText(anchor, visible)}"\n${question(action)}`,
  );
  return sections.join("\n\n");
}

function transcript(
  messages: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
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
