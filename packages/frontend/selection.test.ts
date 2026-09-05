import { expect, it } from "vitest";
import {
  type Anchor,
  type Mark,
  overlaps,
  segments,
  type ThreadId,
} from "./selection.ts";

const thread = (n: number) => `t${n}` as ThreadId;

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

const mark = (n: number, anchor: Anchor): Mark => ({
  thread: thread(n),
  anchor,
});

const shape = (segs: ReturnType<typeof segments>) =>
  segs.map((s) => [s.start, s.end, s.thread ?? (s.live ? "live" : null)]);

it("renders one plain run when there is nothing to mark", () => {
  expect(shape(segments([], null, 0, 10))).toEqual([[0, 10, null]]);
});

it("splits around a single mark", () => {
  const segs = segments([mark(1, at(0, 2, 0, 5))], null, 0, 10);
  expect(shape(segs)).toEqual([
    [0, 2, null],
    [2, 5, thread(1)],
    [5, 10, null],
  ]);
});

it("keeps two disjoint marks in document order", () => {
  const marks = [mark(2, at(0, 6, 0, 8)), mark(1, at(0, 1, 0, 3))];
  expect(shape(segments(marks, null, 0, 10))).toEqual([
    [0, 1, null],
    [1, 3, thread(1)],
    [3, 6, null],
    [6, 8, thread(2)],
    [8, 10, null],
  ]);
});

it("covers whole intermediate messages of a multi-message mark", () => {
  const marks = [mark(1, at(0, 4, 2, 3))];
  expect(shape(segments(marks, null, 1, 10))).toEqual([[0, 10, thread(1)]]);
  expect(shape(segments(marks, null, 0, 10))).toEqual([
    [0, 4, null],
    [4, 10, thread(1)],
  ]);
  expect(shape(segments(marks, null, 2, 10))).toEqual([
    [0, 3, thread(1)],
    [3, 10, null],
  ]);
});

it("emits no trailing run for a mark ending at the message end", () => {
  expect(shape(segments([mark(1, at(0, 4, 0, 10))], null, 0, 10))).toEqual([
    [0, 4, null],
    [4, 10, thread(1)],
  ]);
});

it("lets the live selection win where it covers a mark", () => {
  const segs = segments([mark(1, at(0, 2, 0, 8))], at(0, 4, 0, 6), 0, 10);
  expect(shape(segs)).toEqual([
    [0, 2, null],
    [2, 4, thread(1)],
    [4, 6, "live"],
    [6, 8, thread(1)],
    [8, 10, null],
  ]);
});

it("treats touching ranges as disjoint", () => {
  expect(overlaps([mark(1, at(0, 0, 0, 4))], at(0, 4, 0, 8))).toBe(false);
  expect(overlaps([mark(1, at(0, 4, 0, 8))], at(0, 0, 0, 4))).toBe(false);
  expect(overlaps([mark(1, at(0, 0, 0, 4))], at(1, 0, 1, 2))).toBe(false);
});

it("treats a shared character or containment as an overlap", () => {
  expect(overlaps([mark(1, at(0, 0, 0, 5))], at(0, 4, 0, 8))).toBe(true);
  expect(overlaps([mark(1, at(0, 2, 0, 4))], at(0, 0, 0, 9))).toBe(true);
  expect(overlaps([mark(1, at(0, 0, 0, 9))], at(0, 2, 0, 4))).toBe(true);
  expect(overlaps([mark(1, at(0, 3, 1, 2))], at(1, 1, 2, 0))).toBe(true);
});
