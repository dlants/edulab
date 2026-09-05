import { expect, it } from "vitest";
import { seedTurn } from "./prompt.ts";
import type { Anchor, ThreadId } from "./selection.ts";

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

it("quotes the selection verbatim", () => {
  const seed = seedTurn(undefined, messages, at(1, 9, 1, 26), {
    type: "explain",
  });
  expect(seed).toContain('The user then selected: "recursive descent"');
});

it("quotes a selection spanning two messages", () => {
  const seed = seedTurn(undefined, messages, at(0, 6, 1, 6), { type: "quiz" });
  expect(seed).toContain('selected: "a parser\n\nI used"');
});

it("truncates the transcript after the message containing the selection end", () => {
  const seed = seedTurn(undefined, messages, at(1, 0, 1, 5), {
    type: "explain",
  });
  expect(seed).toContain("build a parser");
  expect(seed).not.toContain("thanks");
});

it("distinguishes the three actions and carries a query through", () => {
  const anchor = at(1, 9, 1, 26);
  const explain = seedTurn(undefined, messages, anchor, { type: "explain" });
  const quiz = seedTurn(undefined, messages, anchor, { type: "quiz" });
  const query = seedTurn(undefined, messages, anchor, {
    type: "query",
    text: "why not a parser generator?",
  });
  expect(new Set([explain, quiz, query]).size).toBe(3);
  expect(query).toContain("why not a parser generator?");
});

it("composes flat at depth, oldest section first", () => {
  const root = seedTurn(undefined, messages, at(1, 9, 1, 26), {
    type: "explain",
  });
  const level1 = [
    {
      type: "text" as const,
      role: "assistant" as const,
      text: "It parses top-down.",
    },
  ] as const;
  const depth2 = seedTurn(root, level1, at(0, 10, 0, 18), { type: "quiz" });

  expect(depth2).toBe(
    [
      "User: build a parser",
      "",
      "Assistant: I used a recursive descent approach.",
      "",
      'The user then selected: "recursive descent"',
      "They said they don't understand this. Explain what it means and why it is there.",
      "",
      "Assistant: It parses top-down.",
      "",
      'The user then selected: "top-down"',
      "They asked to be quizzed on this. Ask one question that checks whether they understand it, and wait for their answer.",
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
  const depth3 = seedTurn(depth2, level2, at(0, 0, 0, 8), {
    type: "query",
    text: "what?",
  });
  expect(depth3.startsWith(depth2)).toBe(true);
  expect(depth3.split("build a parser")).toHaveLength(2);
  expect(depth3.split("It parses top-down")).toHaveLength(2);
});
