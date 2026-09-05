/** A selection over the transcript, stored as character offsets into message
 * text rather than as a live DOM Range: the browser's Range dies the moment the
 * user clicks the learning pane, and the transcript is append-only, so offsets
 * stay valid while a message is still streaming. */
export type Point = { msg: number; offset: number };
export type Anchor = { start: Point; end: Point };

/** The portion of `anchor` falling inside message `i`, or null. */
export function clipToMessage(
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
