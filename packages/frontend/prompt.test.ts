import { expect, it } from "vitest";
import { KnowledgeGraph, LEVELS } from "./graph.ts";
import {
  actionLabel,
  askTurn,
  contextSeed,
  EXTRACT_SYSTEM,
  LEARNING_SYSTEM,
  renderTree,
} from "./prompt.ts";
import type { Anchor, ThreadId } from "./selection.ts";
import { type Socket, Thread } from "./thread.ts";
import { ThreadTree } from "./threads.ts";

const messages = [
  { type: "text" as const, role: "user" as const, text: "build a parser" },
  {
    type: "text" as const,
    role: "assistant" as const,
    text: "I used a recursive descent approach.",
  },
  { type: "text" as const, role: "user" as const, text: "thanks" },
] as const;

const at = (
  startMsg: number,
  start: number,
  endMsg: number,
  end: number,
): Anchor => ({
  thread: "root" as ThreadId,
  start: { msg: startMsg, offset: start },
  end: { msg: endMsg, offset: end },
});

it("quotes the selection verbatim in the ask, not in the seed", () => {
  const anchor = at(1, 9, 1, 26);
  expect(askTurn(anchor, messages, { type: "explain" })).toContain(
    'Selected: "recursive descent"',
  );
  expect(contextSeed(undefined, messages, anchor)).not.toContain("Selected:");
});

it("quotes a selection spanning two messages", () => {
  expect(askTurn(at(0, 6, 1, 6), messages, { type: "quiz" })).toContain(
    'Selected: "a parser\n\nI used"',
  );
});

it("truncates the transcript after the message containing the selection end", () => {
  const seed = contextSeed(undefined, messages, at(1, 0, 1, 5));
  expect(seed).toContain("build a parser");
  expect(seed).not.toContain("thanks");
});

it("distinguishes the three actions and carries a query through", () => {
  const anchor = at(1, 9, 1, 26);
  const explain = askTurn(anchor, messages, { type: "explain" });
  const quiz = askTurn(anchor, messages, { type: "quiz" });
  const query = askTurn(anchor, messages, {
    type: "query",
    text: "why not a parser generator?",
  });
  expect(new Set([explain, quiz, query]).size).toBe(3);
  expect(query).toContain("why not a parser generator?");
});

it("speaks the ask in the user's own voice, so the transcript reads as theirs", () => {
  const anchor = at(1, 9, 1, 26);
  expect(askTurn(anchor, messages, { type: "explain" })).toContain(
    actionLabel({ type: "explain" }),
  );
  expect(askTurn(anchor, messages, { type: "quiz" })).toContain(
    actionLabel({ type: "quiz" }),
  );
});

it("composes flat at depth, oldest section first", () => {
  const root = contextSeed(undefined, messages, at(1, 9, 1, 26));
  const level1 = [
    {
      type: "text" as const,
      role: "user" as const,
      text: 'Selected: "recursive descent"',
    },
    {
      type: "text" as const,
      role: "assistant" as const,
      text: "It parses top-down.",
    },
  ] as const;
  const depth2 = contextSeed(root, level1, at(1, 10, 1, 18));

  expect(depth2).toBe(
    [
      "User: build a parser",
      "",
      "Assistant: I used a recursive descent approach.",
      "",
      'User: Selected: "recursive descent"',
      "",
      "Assistant: It parses top-down.",
    ].join("\n"),
  );
  expect(depth2.startsWith(root)).toBe(true);
  expect(depth2.split("build a parser")).toHaveLength(2);

  const level2 = [
    {
      type: "text" as const,
      role: "assistant" as const,
      text: "Question: what is a token?",
    },
  ] as const;
  const depth3 = contextSeed(depth2, level2, at(0, 0, 0, 8));
  expect(depth3.startsWith(depth2)).toBe(true);
  expect(depth3.split("build a parser")).toHaveLength(2);
  expect(depth3.split("It parses top-down")).toHaveLength(2);
});

it("names the get tool and the scale in the learning system prompt", () => {
  expect(LEARNING_SYSTEM).toContain("`get`");
  for (const label of LEVELS) expect(LEARNING_SYSTEM).toContain(label);
});

it("renders the graph into a top-level seed, and only there", () => {
  const graph = new KnowledgeGraph();
  graph.putNode({
    title: "recursive descent",
    description: "top-down parsing",
    notes: "asked about it",
    level: 2,
  });
  const rendered = graph.render();
  const top = contextSeed(undefined, messages, at(1, 9, 1, 26), rendered);
  expect(top).toContain(rendered);
  const deeper = contextSeed(top, messages, at(1, 9, 1, 26), rendered);
  expect(deeper.split(rendered)).toHaveLength(2);
});

const silentSocket: Socket = { send() {}, addEventListener() {} };

it("renders the whole tree, keeping each child's action and anchor text", () => {
  const root = new Thread(silentSocket, { initialTurns: [] });
  const tree = new ThreadTree(silentSocket, root, () => {});
  void root.send("build a parser");
  const anchor: Anchor = {
    thread: tree.root,
    start: { msg: 0, offset: 6 },
    end: { msg: 0, offset: 14 },
  };
  tree.open(anchor, { type: "quiz" });

  const rendered = renderTree(tree, "the graph");
  expect(rendered).toContain("build a parser");
  expect(rendered).toContain("a parser");
  expect(rendered).toContain("Quiz me on this.");
  expect(rendered).toContain("the graph");
});

it("tells the extraction agent what a node is and where misconceptions go", () => {
  expect(EXTRACT_SYSTEM).toContain("One node per concept");
  expect(EXTRACT_SYSTEM).toContain("`notes`");
});
