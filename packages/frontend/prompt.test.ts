import type Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { parse } from "./citation.ts";
import { KnowledgeGraph, LEVELS } from "./graph.ts";
import type { Interaction } from "./interactions.ts";
import {
  actionLabel,
  askTurn,
  contextSeed,
  GRAPH_UPDATE_SYSTEM,
  graphUpdatePrompt,
  LEARNING_SYSTEM,
  threadAskTurn,
  threadSeed,
} from "./prompt.ts";
import type { Anchor, ThreadId } from "./selection.ts";
import type { Message, MessageIdx } from "./thread.ts";

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

it("keeps the whole parent transcript in a thread-level seed", () => {
  const seed = threadSeed(undefined, messages);
  expect(seed).toContain("build a parser");
  expect(seed).toContain("thanks");
});

it("renders the graph into a top-level thread seed, and only there", () => {
  const top = threadSeed(undefined, messages, "the graph");
  expect(top).toContain("the graph");
  expect(
    threadSeed(top, messages, "the graph").split("the graph"),
  ).toHaveLength(2);
});

it("asks without a quote, and differently per action", () => {
  const review = threadAskTurn({ type: "review" });
  const ideas = threadAskTurn({ type: "ideas" });
  const query = threadAskTurn({ type: "query", text: "why a parser?" });
  expect(review).not.toContain("Selected:");
  expect(ideas).not.toContain("Selected:");
  expect(new Set([review, ideas, query]).size).toBe(3);
  expect(query).toBe("why a parser?");
  expect(review).toContain(actionLabel({ type: "review" }));
  expect(ideas).toContain(actionLabel({ type: "ideas" }));
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

const interaction = (
  index: number,
  text: string,
  seed?: string,
): Interaction => ({
  thread: "root" as ThreadId,
  index: index as MessageIdx,
  prefix: { seed, messages: messages.slice(0, index) as Message[] },
  text,
});

const blockText = (block: Anthropic.ContentBlockParam | undefined): string =>
  block?.type === "text" ? block.text : "";

it("puts the prefix in the cached block and the turn, graph and questions in the volatile one", () => {
  const [cached, volatile] = graphUpdatePrompt(
    interaction(2, "thanks", "the framing"),
    "the graph",
  );
  const front = blockText(cached);
  const back = blockText(volatile);
  expect(front).toContain("the framing");
  expect(front).toContain("build a parser");
  expect(front).not.toContain("the graph");
  expect(back).toContain("the graph");
  expect(back).toContain("thanks");
  expect(back).toContain("yield");
});

it("marks exactly one block for caching, and it is identical across a thread", () => {
  const blocks = graphUpdatePrompt(interaction(2, "thanks", "seed"), "graph a");
  expect(
    blocks.filter((b) => "cache_control" in b && b.cache_control).length,
  ).toBe(1);
  expect(blocks[0]?.type === "text" && blocks[0].cache_control).toEqual({
    type: "ephemeral",
  });
});

it("renders a seedless root interaction without an empty framing section", () => {
  const [cached] = graphUpdatePrompt(
    interaction(0, "build a parser"),
    "the graph",
  );
  const front = blockText(cached);
  expect(front).not.toContain("framing");
  expect(front).not.toContain("\n\n\n");
  expect(front.trim()).toBe(front);
});

it("states the scope restriction, the coarseness rule and the licence to change nothing", () => {
  expect(GRAPH_UPDATE_SYSTEM).toContain(
    "Touch only what this interaction is about",
  );
  expect(GRAPH_UPDATE_SYSTEM).toContain("small and coarse");
  expect(GRAPH_UPDATE_SYSTEM).toContain("change nothing");
  expect(GRAPH_UPDATE_SYSTEM).toContain("`notes`");
});

it("labels the interaction and its prefix with addresses that resolve back", () => {
  const [cached, volatile] = graphUpdatePrompt(
    interaction(2, "thanks", "the framing"),
    "the graph",
  );
  expect(blockText(cached)).toContain("User (@message:root:0): build a parser");
  expect(blockText(cached)).toContain("Assistant (@message:root:1):");
  expect(blockText(volatile)).toContain("@message:root:2");
  for (const span of parse(blockText(cached) + blockText(volatile))) {
    if (span.type === "citation") expect(span.citation.thread).toBe("root");
  }
});

it("requires notes to cite the interactions they rest on", () => {
  expect(GRAPH_UPDATE_SYSTEM).toContain("@message:<thread>:<index>");
  expect(GRAPH_UPDATE_SYSTEM).toContain("cite");
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
