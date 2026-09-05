/** Declared here rather than in threads.ts because an anchor is meaningless
 * without one, and threads.ts will import this module. */
export type ThreadId = string & { readonly __brand: "ThreadId" };

/** A selection over the transcript, stored as character offsets into message
 * text rather than as a live DOM Range: the browser's Range dies the moment the
 * user clicks the learning pane, and the transcript is append-only, so offsets
 * stay valid while a message is still streaming.
 *
 * `msg` is an absolute index into the owning thread's turns, `offset` a
 * character offset into that turn's text. */
export type Point = { msg: number; offset: number };
/** `start` precedes `end` in document order; `thread` is the thread whose
 * transcript the range indexes, i.e. the parent of whatever it opens. */
export type Anchor = { thread: ThreadId; start: Point; end: Point };

/** A committed highlight: the passage, plus the thread it opens. The opened
 * thread's id cannot live on the anchor, because `anchor.thread` already names
 * the other end of the edge - the parent. */
export type Mark = { thread: ThreadId; anchor: Anchor };

/** A run of one message's text: plain, a committed mark, or the live selection
 * the user has just dragged and not yet acted on. */
export type Segment = {
  start: number;
  end: number;
  /** The thread this run opens, or null for plain text and the live range. */
  thread: ThreadId | null;
  live: boolean;
};

/** True when `live` intersects any committed mark, which makes it unusable:
 * a passage owned by two threads has no honest meaning as an edge in the tree. */
export function overlaps(marks: ReadonlyArray<Mark>, live: Anchor): boolean {
  return marks.some(
    (m) => before(m.anchor.start, live.end) && before(live.start, m.anchor.end),
  );
}

function before(a: Point, b: Point): boolean {
  return a.msg !== b.msg ? a.msg < b.msg : a.offset < b.offset;
}

/** Splits message `i` into plain, marked and live runs, left to right.
 * `marks` are pairwise disjoint; `live` may overlap them, and wins where it
 * does, so the user still sees what they dragged. */
export function segments(
  marks: ReadonlyArray<Mark>,
  live: Anchor | null,
  i: number,
  length: number,
): Segment[] {
  const liveClip = clipToMessage(live, i, length);
  const runs: Segment[] = [];
  for (const mark of marks) {
    const clip = clipToMessage(mark.anchor, i, length);
    if (!clip) continue;
    for (const part of subtract(clip, liveClip)) {
      runs.push({ ...part, thread: mark.thread, live: false });
    }
  }
  if (liveClip) runs.push({ ...liveClip, thread: null, live: true });
  runs.sort((a, b) => a.start - b.start);

  const out: Segment[] = [];
  let at = 0;
  for (const run of runs) {
    if (run.start > at) {
      out.push({ start: at, end: run.start, thread: null, live: false });
    }
    out.push(run);
    at = run.end;
  }
  if (at < length) {
    out.push({ start: at, end: length, thread: null, live: false });
  }
  return out;
}

type Run = { start: number; end: number };

function subtract(run: Run, hole: Run | null): Run[] {
  if (!hole || hole.end <= run.start || hole.start >= run.end) return [run];
  const out: Run[] = [];
  if (run.start < hole.start) out.push({ start: run.start, end: hole.start });
  if (run.end > hole.end) out.push({ start: hole.end, end: run.end });
  return out;
}

/** The portion of `anchor` falling inside message `i`, or null. */
function clipToMessage(
  anchor: Anchor | null,
  i: number,
  length: number,
): { start: number; end: number } | null {
  if (!anchor) return null;
  if (i < anchor.start.msg || i > anchor.end.msg) return null;
  const start = i === anchor.start.msg ? anchor.start.offset : 0;
  const end = i === anchor.end.msg ? anchor.end.offset : length;
  return end > start ? { start, end } : null;
}

export function anchorText(
  anchor: Anchor,
  messages: ReadonlyArray<{ text: string }>,
): string {
  const parts: string[] = [];
  for (let i = anchor.start.msg; i <= anchor.end.msg; i++) {
    const clip = clipToMessage(anchor, i, messages[i]?.text.length ?? 0);
    if (clip) parts.push(messages[i].text.slice(clip.start, clip.end));
  }
  return parts.join("\n\n");
}
