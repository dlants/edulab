import type Anthropic from "@anthropic-ai/sdk";
import { citationText } from "./citation.ts";
import type { Interaction } from "./interactions.ts";
import { type Anchor, anchorText, type ThreadId } from "./selection.ts";
import type { Message, MessageIdx } from "./thread.ts";

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

/** Graph update mode: one detached pass over a single user interaction, whose
 * only output is whatever it writes to the graph through its tools. */
export const GRAPH_UPDATE_SYSTEM = [
  "You maintain a knowledge graph of what one user understands. You are shown",
  "a single interaction that user just made, in the context of the thread it",
  "happened in and the graph as it stands.",
  "",
  "Ask: what domain concepts is this interaction about, are they in the graph",
  "already, what understanding does the user demonstrate here, and does",
  "anything here read as a gap or a misconception. A node is a concept - an",
  "idea a person can understand or fail to understand - never a file, a",
  "message or a line of code. Set `level` from what the interaction reveals,",
  "on the scale 1 unfamiliar, 2 emerging, 3 working, 4 fluent. The scale",
  "cannot express a misconception - a confidently held wrong belief reads as",
  "fluent - so put misconceptions, and anything else about how this user holds",
  "the idea, in `notes`.",
  "",
  "Touch only what this interaction is about; leave the rest of the graph",
  "alone. Keep the graph small and coarse: update the node that already covers",
  "a concept rather than minting a second one for it, and split a concept only",
  "when the split expresses something real about this user's understanding. A",
  "concept the user merely brushed past does not need a node.",
  "",
  "Ground every note about this user in what they actually did. Each block of",
  "the transcript is labelled with its address, `@message:<thread>:<index>`,",
  "including the interaction itself. A claim about what this user understands",
  "or misunderstands must cite the addresses it rests on, written verbatim in",
  "the note; do not assert anything you cannot point at.",
  "",
  "Most interactions reveal nothing. If this one does not, change nothing and",
  "yield: doing nothing is the expected outcome, not a failure. The yield tool",
  "takes no input, and nothing you say outside the tools is read: the graph",
  "writes are the whole output of this thread, so do not narrate or summarize",
  "them.",
].join(" ");

/** Two blocks: the cacheable prefix - the base prompt, the thread's seed and
 * the transcript before the turn, all of which every earlier interaction in
 * this thread shares - then the volatile tail, which starts with the graph
 * because the previous update just rewrote it. */
export function graphUpdatePrompt(
  interaction: Interaction,
  graph: string,
): Anthropic.ContentBlockParam[] {
  const prefix = [GRAPH_UPDATE_PREAMBLE];
  if (interaction.prefix.seed)
    prefix.push(`How this thread was framed:\n${interaction.prefix.seed}`);
  if (interaction.prefix.messages.length > 0)
    prefix.push(
      `The thread up to this interaction:\n${transcript(interaction.prefix.messages, interaction.thread)}`,
    );
  return [
    {
      type: "text",
      text: prefix.join("\n\n"),
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: [
        `The knowledge graph as it stands:\n${graph}`,
        `The interaction, at ${citationText({ thread: interaction.thread, index: interaction.index })}:\nUser: ${interaction.text}`,
        GRAPH_UPDATE_QUESTIONS,
      ].join("\n\n"),
    },
  ];
}

const GRAPH_UPDATE_PREAMBLE =
  "Below is one interaction a user made while an engineering agent worked on a task for them, and the context it happened in.";

const GRAPH_UPDATE_QUESTIONS = [
  "What domain concepts does this interaction touch, and are they in the",
  "graph? What understanding does it demonstrate, and what does it suggest",
  "the user is missing? Update the graph so it reflects that, and nothing",
  "else - then yield.",
].join(" ");

/** With `thread`, every block is labelled with its address, so the model can
 * cite it back. Indices are positions in that thread's `messages`, which is
 * append-only, so an address stays valid for the life of the page. */
function transcript(
  messages: ReadonlyArray<Message>,
  thread?: ThreadId,
): string {
  return messages
    .map((m, i) => {
      const who = m.role === "user" ? "User" : "Assistant";
      const at = thread
        ? ` (${citationText({ thread, index: i as MessageIdx })})`
        : "";
      return `${who}${at}: ${line(m)}`;
    })
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
