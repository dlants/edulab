import type { GraphChange, GraphId } from "./graph.ts";
import {
  type Msg as GraphMsg,
  type State as GraphState,
  GraphView,
} from "./graph-view.ts";
import {
  type Msg as LearningMsg,
  LearningPane,
  type State as LearningState,
  type PopupState,
  SelectionPopup,
} from "./learning.ts";
import { samples } from "./samples/index.ts";
import {
  type Anchor,
  anchorText,
  type Mark,
  overlaps,
  type Point,
  type Segment,
  segments,
  type ThreadId,
} from "./selection.ts";
import { type Message, messageText } from "./thread.ts";
import {
  Binder,
  cls,
  mountStyle,
  type PostRenderEventBus,
  type Ref,
  ref,
  sanitize,
  scrollIntoView,
  show,
  showKeyed,
  type View,
} from "./vamp.ts";

/** The sample-transcript batch. `done` is terminal: a second pass over the
 * same turns updates nodes rather than teaching us anything new. */
export type Build =
  | { type: "idle" }
  | {
      type: "running";
      done: number;
      total: number;
      failures: ReadonlyArray<BuildFailure>;
    }
  | { type: "done"; failures: ReadonlyArray<BuildFailure> };

/** Why one interaction's graph update did not land. Carried on the state rather
 * than left in the console at the moment it happened, so the `?` next to the
 * status can dump the whole set after the fact. */
export type BuildFailure = { address: string; error: string };

/** What the background graph update for one interaction is doing, shown under
 * the turn that triggered it: a system quietly building a model of the user is
 * exactly the thing that should be visible where it happened. */
export type GraphUpdate =
  | { type: "running"; messages: ReadonlyArray<Message> }
  | {
      type: "done";
      changes: ReadonlyArray<GraphChange>;
      messages: ReadonlyArray<Message>;
    };

/** The updates over one thread, keyed by the index of the turn that triggered
 * each. Derived: losing it loses nothing the graph does not already hold. */
export type Updates = ReadonlyMap<number, GraphUpdate>;

export type State = {
  messages: ReadonlyArray<Message>;
  /** The id of the canned transcript in play, empty for a hand-written one. */
  sample: string;
  inFlight: boolean;
  draft: string;
  /** False at layer 0 (the bare task transcript); true for the two-pane split. */
  split: boolean;
  /** How deep in the tree the left pane is: 0 at layer 0. */
  depth: number;
  /** Whether `→` can move deeper, i.e. there is something to move left. */
  canDescend: boolean;
  /** The thread whose transcript this pane shows; the live selection is over it. */
  thread: ThreadId;
  /** Committed highlights over this transcript. */
  marks: ReadonlyArray<Mark>;
  /** The mark whose thread the right pane is showing, drawn emphasized. */
  activeMark: ThreadId | null;
  /** Children opened off this thread as a whole: they paint no highlight, so
   * the pane lists them instead. */
  threads: ReadonlyArray<{ thread: ThreadId; label: string }>;
  anchor: Anchor | null;
  query: string;
  /** Which top-level tab is showing. State, not a route: a page load would
   * discard the graph. */
  tab: "threads" | "graph";
  graph: GraphState;
  /** The sample-transcript batch: one graph update per loaded user turn. */
  build: Build;
  /** Indices of messages the user has expanded past the collapsed height. */
  expanded: ReadonlySet<number>;
  /** The background graph updates over this transcript. */
  updates: Updates;
  /** The active child thread, shown on the right when nothing is selected. */
  child: ThreadPaneState | null;
  /** Where to float the selection popup, when the passage the user just
   * dragged has no actions on screen: at layer 0, and in the reflect thread. */
  popup: { x: number; y: number } | null;
  /** The transcript of a background graph update, shown on the right while the
   * user is reviewing it. It is not a learning thread: nothing hangs off it. */
  updatePane: UpdatePaneState | null;
};

export type Msg =
  | { type: "DRAFT_CHANGED"; draft: string }
  | { type: "SUBMIT" }
  | { type: "BUILD" }
  | { type: "GO_DEEPER" }
  | { type: "GO_BACK" }
  | {
      type: "SELECTION_CHANGED";
      anchor: Anchor | null;
      at: { x: number; y: number } | null;
    }
  | { type: "MARK_CLICKED"; thread: ThreadId }
  | { type: "LEARNING_MSG"; msg: LearningMsg }
  | { type: "SAMPLE_CHANGED"; id: string }
  | { type: "RESET" }
  | { type: "TAB_CHANGED"; tab: "threads" | "graph" }
  | { type: "GRAPH_MSG"; msg: GraphMsg }
  | { type: "TOGGLE_EXPANDED"; index: number }
  | { type: "CHANGE_CLICKED"; id: GraphId }
  | { type: "SHOW_UPDATE"; index: number }
  | { type: "UPDATE_MSG"; msg: UpdatePaneMsg }
  | { type: "CHILD_MSG"; msg: ThreadPaneMsg };

const appClass = cls("app");
const transcriptClass = cls("transcript");
const messageClass = cls("message");
const roleClass = cls("role");
const composerClass = cls("composer");
const scrollbackClass = cls("scrollback");
const paneClass = cls("pane");
const navClass = cls("nav");
const depthClass = cls("depth");
const markClass = cls("mark");
const textClass = cls("text");
const toolClass = cls("tool");
const toolResultClass = cls("tool-result");
const threadPaneClass = cls("thread-pane");
const bodyClass = cls("body");
const sampleClass = cls("sample");
const buildStatusClass = cls("build-status");
const buildDebugClass = cls("build-debug");
const spacerClass = cls("spacer");
const tabsClass = cls("tabs");
const menuClass = cls("menu");

/** A message collapses to this many lines: about a third of a screen. */
const MAX_MESSAGE_LINES = 15;
/** Roughly how much fits on one line of a message at the pane's widest, so the
 * clamp affordance can be decided from the text rather than from the rendered
 * box: measuring means a forced reflow per message per streamed token, and
 * being a line or two out here costs nothing. */
const CHARS_PER_LINE = 80;
const clipClass = cls("clip");
const toggleClass = cls("toggle");
const moreClass = cls("more");
const updateClass = cls("update");
const updatePaneClass = cls("update-pane");
const paneTitleClass = cls("pane-title");
const changeClass = cls("change");
const changeListClass = cls("change-list");
const flashClass = cls("flash");

mountStyle(`
.${appClass} {
  font-family: system-ui, sans-serif;
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.${bodyClass} {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  width: 100%;
  max-width: 44rem;
  margin: 0 auto;
  padding: 0 1rem;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem 2rem;
  align-items: stretch;
}
.${appClass}[data-split="true"] .${bodyClass} {
  max-width: 88rem;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
/* Each layer column is a fixed-height box: the scrollback takes the slack and
 * scrolls on its own, so the composer stays pinned to the bottom of the
 * viewport and a long transcript on the left never drags the thread on the
 * right out of view. */
.${paneClass} {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
.${scrollbackClass} {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 0;
}
.${navClass} {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  background: #fff;
}
.${navClass} button {
  font: inherit;
  padding: 0.2rem 0.6rem;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  background: #fff;
  cursor: pointer;
}
.${navClass} button:disabled {
  opacity: 0.4;
  cursor: default;
}
.${buildStatusClass} {
  font-size: 0.8rem;
  color: #666;
}
.${navClass} button.${buildDebugClass} {
  font-size: 0.7rem;
  line-height: 1;
  padding: 0.1rem 0.3rem;
  color: #666;
}
.${sampleClass} {
  font: inherit;
}
.${menuClass} {
  position: relative;
  flex: none;
}
.${menuClass} > summary {
  list-style: none;
  cursor: pointer;
  padding: 0.2rem 0.4rem;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.15);
  line-height: 1;
}
.${menuClass} > summary::-webkit-details-marker {
  display: none;
}
.${menuClass}[open] > summary {
  background: rgba(0, 0, 0, 0.08);
}
.${menuClass} > div {
  position: absolute;
  z-index: 10;
  top: calc(100% + 0.4rem);
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.5rem;
  padding: 0.6rem;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 0.5rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  white-space: nowrap;
}
.${spacerClass} {
  flex: 1;
}
.${tabsClass} {
  display: flex;
  gap: 1rem;
}
.${navClass} .${tabsClass} button {
  border: none;
  border-radius: 0;
  background: none;
  padding: 0.2rem 0;
}
.${tabsClass} button[aria-pressed="true"] {
  font-weight: 700;
  text-decoration: underline;
  text-underline-offset: 0.3em;
}
.${depthClass} {
  font-size: 0.75rem;
  opacity: 0.6;
}
.${markClass} {
  border-radius: 2px;
}
.${markClass}[data-live="true"] {
  background: #cfe3ff;
}
.${markClass}[data-mark] {
  background: #ffe8a3;
  cursor: pointer;
}
.${markClass}[data-mark][data-active="true"] {
  background: #ffcf4d;
  box-shadow: 0 0 0 1px #b8860b;
}
.${transcriptClass} {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.${messageClass} {
  line-height: 1.5;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  column-gap: 0.5rem;
}
.${messageClass} > .${roleClass} {
  grid-column: 1 / -1;
}
.${clipClass} {
  grid-column: 2;
  white-space: pre-wrap;
  overflow: hidden;
}
.${messageClass}[data-clipped="true"] .${clipClass} {
  max-height: calc(${MAX_MESSAGE_LINES} * 1.5em);
  mask-image: linear-gradient(to bottom, #000 70%, transparent 100%);
}
.${toggleClass} {
  grid-column: 1;
  grid-row: 2;
  width: 0.6rem;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.12);
  cursor: pointer;
}
.${toggleClass}:hover {
  background: rgba(0, 0, 0, 0.3);
}
.${messageClass}[data-overflowing="false"] > .${toggleClass},
.${messageClass}[data-overflowing="false"] > .${moreClass} {
  display: none;
}
.${moreClass} {
  grid-column: 2;
  font-size: 0.75rem;
  opacity: 0.6;
  cursor: pointer;
  user-select: none;
}
.${messageClass}[data-role="user"] {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
}
.${toolClass} {
  font-family: ui-monospace, monospace;
  font-size: 0.8rem;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 0.4rem;
  padding: 0.4rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  overflow-x: auto;
}
.${toolClass} pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.${toolResultClass}[data-status="error"] {
  color: #b00020;
}
.${roleClass} {
  display: block;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
.${composerClass} {
  flex: none;
  display: flex;
  gap: 0.5rem;
  padding-bottom: 1rem;
}
.${threadPaneClass} {
  min-height: 0;
  overflow: hidden;
  padding-left: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border-left: 1px solid rgba(0, 0, 0, 0.1);
}
.${updateClass} {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.75rem;
  color: #666;
  margin-top: 0.35rem;
}
@keyframes ${flashClass}-pulse {
  from { background: #ffe8a3; }
  to { background: transparent; }
}
.${flashClass} {
  animation: ${flashClass}-pulse 1.2s ease-out;
}
.${changeListClass} {
  display: contents;
}
.${updatePaneClass} {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 0 5rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border-left: 1px solid rgba(0, 0, 0, 0.1);
}
.${paneTitleClass} {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.6;
}
.${changeClass} {
  font: inherit;
  color: inherit;
  padding: 0.1rem 0.5rem;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
}
.${composerClass} textarea {
  flex: 1;
  font: inherit;
  padding: 0.5rem;
  resize: vertical;
}
`);

type SegmentState = {
  text: string;
  /** The thread this run opens; null for plain text and the live selection. */
  thread: ThreadId | null;
  live: boolean;
  active: boolean;
};

type SegmentMsg = { type: "CLICKED"; thread: ThreadId };

/** One run of a message's text: plain, a committed mark, or the live selection.
 * A span rather than a <mark> so all three share one element and bindList can
 * reconcile them without remounting. */
class SegmentView implements View<SegmentState, SegmentMsg> {
  container: HTMLElement;
  private b: Binder<SegmentState>;
  private current: SegmentState;

  constructor(
    container: HTMLElement,
    dispatch: (msg: SegmentMsg) => void,
    initial: SegmentState,
  ) {
    const textRef = ref("segment");
    container.innerHTML = sanitize`<span data-ref="${textRef}"></span>`;
    this.container = container;
    this.current = initial;
    this.b = new Binder(container, initial);
    container.addEventListener("click", () => {
      const thread = this.current.thread;
      if (thread) dispatch({ type: "CLICKED", thread });
    });
    this.b.bindClass(container, (s) => (s.thread || s.live ? markClass : ""));
    this.b.bindContainerAttr("data-mark", (s) => s.thread ?? undefined);
    this.b.bindContainerAttr("data-live", (s) => (s.live ? "true" : undefined));
    this.b.bindContainerAttr("data-active", (s) =>
      s.active ? "true" : undefined,
    );
    this.b.bindText(textRef, (s) => s.text);
  }

  sync(state: SegmentState): void {
    this.current = state;
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

type ChangeState = { change: GraphChange };
type ChangeMsg = { type: "CLICKED" };

/** One mutation a background graph update applied, as a chip: the citation link
 * run backwards, so a claim about the user is one click from the node. */
class ChangeView implements View<ChangeState, ChangeMsg> {
  container: HTMLElement;
  private b: Binder<ChangeState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: ChangeMsg) => void,
    initial: ChangeState,
  ) {
    const labelRef = ref("change-label");
    container.className = changeClass;
    container.setAttribute("type", "button");
    container.setAttribute("data-change", "");
    container.innerHTML = sanitize`<span data-ref="${labelRef}"></span>`;
    this.container = container;
    this.b = new Binder(container, initial);
    container.addEventListener("click", () => dispatch({ type: "CLICKED" }));
    this.b.bindText(labelRef, (s) => `${s.change.op} "${s.change.title}"`);
  }

  sync(state: ChangeState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

type MessageState = {
  message: Message;
  expanded: boolean;
  segments: ReadonlyArray<Segment>;
  active: ThreadId | null;
  /** The background graph update this turn triggered, if it triggered one. */
  update: GraphUpdate | null;
};

type MessageMsg =
  | SegmentMsg
  | { type: "TOGGLE_EXPANDED" }
  | { type: "CHANGE_CLICKED"; id: GraphId }
  | { type: "SHOW_UPDATE" };

/** How many lines the clamp hides, estimated from the text that the clipped
 * box holds: the prose, and the tool call rendered under it. */
function hiddenLines(message: Message): number {
  const blocks = [messageText(message), resultText(message)];
  if (message.type === "tool_use")
    blocks.push(message.call.name, message.call.inputJson);
  const lines = blocks
    .filter((block) => block !== "")
    .flatMap((block) => block.split("\n"))
    .reduce(
      (total, line) => total + Math.ceil(line.length / CHARS_PER_LINE),
      0,
    );
  return lines - MAX_MESSAGE_LINES;
}

class MessageView implements View<MessageState, MessageMsg> {
  container: HTMLElement;
  private b: Binder<MessageState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: MessageMsg) => void,
    initial: MessageState,
  ) {
    const roleRef = ref("role");
    const textRef = ref("text");
    const toolRef = ref("tool");
    const toolNameRef = ref("tool-name");
    const toolInputRef = ref("tool-input");
    const toolResultRef = ref("tool-result");
    const clipRef = ref("clip");
    const toggleRef = ref("toggle");
    const moreRef = ref("more");
    const updateRef = ref("update");
    const updateStatusRef = ref("update-status");
    const changesRef = ref("changes");
    const updateThreadRef = ref("update-thread");
    container.className = messageClass;
    // The tool block sits outside the .text span on purpose: resolvePoint only
    // anchors inside it, so a tool call is rendered but not selectable.
    container.innerHTML = sanitize`
      <span class="${roleClass}" data-ref="${roleRef}"></span>
      <button
        class="${toggleClass}"
        type="button"
        data-ref="${toggleRef}"
        aria-label="Expand or collapse this message"
      ></button>
      <div class="${clipClass}" data-ref="${clipRef}">
        <span class="${textClass}" data-text data-ref="${textRef}"></span>
        <div class="${toolClass}" data-tool data-ref="${toolRef}">
          <strong data-tool-name data-ref="${toolNameRef}"></strong>
          <pre data-tool-input data-ref="${toolInputRef}"></pre>
          <pre class="${toolResultClass}" data-tool-result data-ref="${toolResultRef}"></pre>
        </div>
      </div>
      <div class="${moreClass}" data-more data-ref="${moreRef}"></div>
      <div class="${updateClass}" data-update data-ref="${updateRef}">
        <span data-update-status data-ref="${updateStatusRef}"></span>
        <span class="${changeListClass}" data-ref="${changesRef}"></span>
        <button
          class="${changeClass}"
          type="button"
          data-update-thread
          data-ref="${updateThreadRef}"
        >transcript</button>
      </div>
    `;
    this.container = container;
    this.b = new Binder(container, initial);
    this.b.bindText(roleRef, (s) => s.message.role);
    // Keyed by start offset: the transcript is append-only, so a run keeps its
    // start while the message grows and while marks are added after it.
    this.b.bindList(textRef, "span", (s) =>
      s.segments.map((seg) =>
        showKeyed(
          String(seg.start),
          SegmentView,
          {
            text: messageText(s.message).slice(seg.start, seg.end),
            thread: seg.thread,
            live: seg.live,
            active: seg.thread !== null && seg.thread === s.active,
          },
          {},
          dispatch,
        ),
      ),
    );
    this.b.bindVisible(toolRef, (s) => s.message.type === "tool_use");
    this.b.bindText(toolNameRef, (s) =>
      s.message.type === "tool_use" ? s.message.call.name : "",
    );
    this.b.bindText(toolInputRef, (s) =>
      s.message.type === "tool_use" ? s.message.call.inputJson : "",
    );
    this.b.bindText(toolResultRef, (s) => resultText(s.message));
    this.b.bindVisible(toolResultRef, (s) => resultText(s.message) !== "");
    this.b.bindAttr(toolResultRef, "data-status", (s) =>
      s.message.type === "tool_use" ? s.message.call.result?.status : undefined,
    );
    this.b.bindVisible(updateRef, (s) => s.update !== null);
    this.b.bindText(updateStatusRef, (s) => updateStatus(s.update));
    this.b.bindList(changesRef, "button", (s) =>
      (s.update?.type === "done" ? s.update.changes : []).map((change, i) =>
        showKeyed(`${change.id}:${i}`, ChangeView, { change }, {}, () =>
          dispatch({ type: "CHANGE_CLICKED", id: change.id }),
        ),
      ),
    );
    this.b
      .ref(updateThreadRef)
      .addEventListener("click", () => dispatch({ type: "SHOW_UPDATE" }));
    this.b.bindContainerAttr("data-role", (s) => s.message.role);
    const toggle = () => dispatch({ type: "TOGGLE_EXPANDED" });
    this.b.ref(toggleRef).addEventListener("click", toggle);
    this.b.ref(moreRef).addEventListener("click", toggle);
    this.b.bindContainerAttr("data-clipped", (s) =>
      s.expanded ? undefined : "true",
    );
    this.b.bindContainerAttr("data-overflowing", (s) =>
      hiddenLines(s.message) > 0 ? "true" : "false",
    );
    this.b.bindText(moreRef, (s) => {
      const hidden = hiddenLines(s.message);
      return hidden > 0 && !s.expanded ? `… ${hidden} more lines` : "";
    });
  }

  sync(state: MessageState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

/** The newest block is expanded by default - it is the one being written, and
 * clipping it hides the work as it lands. The toggle still applies, so the user
 * can collapse it; membership in the set flips the default either way. */
function lastExpanded(
  expanded: ReadonlySet<number>,
  index: number,
  count: number,
): boolean {
  return expanded.has(index) !== (index === count - 1);
}

/** The account, next to the turn that caused it, of what the system just
 * concluded about the user. "No changes" is the common case and is worth saying
 * out loud rather than leaving a chip to vanish. */
function updateStatus(update: GraphUpdate | null): string {
  if (!update) return "";
  if (update.type === "running") return "updating the knowledge graph…";
  return update.changes.length === 0
    ? "no knowledge graph changes"
    : "knowledge graph:";
}

function resultText(message: Message): string {
  if (message.type !== "tool_use") return "";
  const result = message.call.result;
  if (!result) return "";
  return result.status === "ok" ? result.text : result.error;
}

export type ThreadPaneState = {
  messages: ReadonlyArray<Message>;
  /** The thread this pane shows: a selection over it anchors to it. */
  thread: ThreadId;
  /** Highlights over this transcript, one per thread opened from it. */
  marks: ReadonlyArray<Mark>;
  /** The live selection, when it is over this pane rather than the left one. */
  anchor: Anchor | null;
  inFlight: boolean;
  draft: string;
  expanded: ReadonlySet<number>;
};

export type ThreadPaneMsg =
  | { type: "DRAFT_CHANGED"; draft: string }
  | { type: "SUBMIT" }
  | { type: "TOGGLE_EXPANDED"; index: number }
  | { type: "CHANGE_CLICKED"; id: GraphId }
  | { type: "SHOW_UPDATE"; index: number }
  | {
      type: "SELECTION_CHANGED";
      anchor: Anchor | null;
      at: { x: number; y: number } | null;
    }
  | { type: "MARK_CLICKED"; thread: ThreadId };

/** A learning thread on the right: its transcript and a composer. It captures
 * a selection of its own, which is how the next layer down is opened without
 * first descending into this one. */
class ThreadPane implements View<ThreadPaneState, ThreadPaneMsg> {
  container: HTMLElement;
  private b: Binder<ThreadPaneState>;
  /** The latest state, for the selection handler, which runs outside a binding. */
  private current: ThreadPaneState;

  constructor(
    container: HTMLElement,
    dispatch: (msg: ThreadPaneMsg) => void,
    initial: ThreadPaneState,
  ) {
    const transcriptRef = ref("thread-transcript");
    const inputRef = ref("thread-input");
    const sendRef = ref("thread-send");

    container.className = threadPaneClass;
    container.innerHTML = sanitize`
      <div class="${scrollbackClass}">
        <ul class="${transcriptClass}" data-ref="${transcriptRef}"></ul>
      </div>
      <div class="${composerClass}">
        <textarea data-ref="${inputRef}" rows="2" placeholder="Follow up…"></textarea>
        <button type="button" data-ref="${sendRef}">Reply</button>
      </div>
    `;
    this.container = container;
    this.current = initial;
    this.b = new Binder(container, initial);

    const transcript = this.b.ref(transcriptRef);
    const capture = () => {
      const anchor = readAnchor(transcript, this.current.thread);
      if (anchor === undefined) return;
      dispatch({ type: "SELECTION_CHANGED", anchor, at: pointOfSelection() });
    };
    transcript.addEventListener("mouseup", capture);
    transcript.addEventListener("keyup", capture);

    const input = this.b.ref<HTMLTextAreaElement>(inputRef);
    input.addEventListener("input", () => {
      dispatch({ type: "DRAFT_CHANGED", draft: input.value });
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "SUBMIT" });
      }
    });
    this.b
      .ref(sendRef)
      .addEventListener("click", () => dispatch({ type: "SUBMIT" }));

    this.b.bindList(transcriptRef, "li", (s) =>
      s.messages.map((message, i) =>
        showKeyed(
          String(i),
          MessageView,
          {
            message,
            expanded: lastExpanded(s.expanded, i, s.messages.length),
            segments: segments(
              s.marks,
              s.anchor,
              i,
              messageText(message).length,
            ),
            active: null,
            // The chips report what a turn taught the graph, and are only
            // legible next to the reflect pane that explains them. This pane
            // *is* that pane: nothing hangs to its right, so it shows none.
            update: null,
          },
          {},
          (msg: MessageMsg) => {
            if (msg.type === "TOGGLE_EXPANDED")
              dispatch({ type: "TOGGLE_EXPANDED", index: i });
            else if (msg.type === "SHOW_UPDATE")
              dispatch({ type: "SHOW_UPDATE", index: i });
            else if (msg.type === "CLICKED")
              dispatch({ type: "MARK_CLICKED", thread: msg.thread });
            else if (msg.type === "CHANGE_CLICKED") dispatch(msg);
          },
        ),
      ),
    );
    this.b.bindValue(inputRef, (s) => s.draft);
    this.b.bindDisabled(inputRef, (s) => s.inFlight);
    this.b.bindDisabled(sendRef, (s) => s.inFlight || s.draft.trim() === "");
  }

  sync(state: ThreadPaneState): void {
    this.current = state;
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

export type UpdatePaneState = {
  messages: ReadonlyArray<Message>;
  running: boolean;
  expanded: ReadonlySet<number>;
};

export type UpdatePaneMsg =
  | { type: "CLOSE" }
  | { type: "TOGGLE_EXPANDED"; index: number };

/** The transcript of one background graph update, on the right. It has no
 * composer and captures no selection: this is the prompt and the model's work
 * put where they can be reviewed, not a thread the user can carry on. */
class UpdatePane implements View<UpdatePaneState, UpdatePaneMsg> {
  container: HTMLElement;
  private b: Binder<UpdatePaneState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: UpdatePaneMsg) => void,
    initial: UpdatePaneState,
  ) {
    const titleRef = ref("update-pane-title");
    const statusRef = ref("update-pane-status");
    const closeRef = ref("update-pane-close");
    const transcriptRef = ref("update-pane-transcript");

    container.className = updatePaneClass;
    container.innerHTML = sanitize`
      <div class="${paneTitleClass}" data-ref="${titleRef}">
        <span>Knowledge graph update</span>
        <span data-update-pane-status data-ref="${statusRef}"></span>
        <span class="${spacerClass}"></span>
        <button type="button" data-ref="${closeRef}">Close</button>
      </div>
      <ul class="${transcriptClass}" data-ref="${transcriptRef}"></ul>
    `;
    this.container = container;
    this.b = new Binder(container, initial);

    this.b
      .ref(closeRef)
      .addEventListener("click", () => dispatch({ type: "CLOSE" }));
    this.b.bindText(statusRef, (s) => (s.running ? "running…" : "finished"));
    this.b.bindList(transcriptRef, "li", (s) =>
      s.messages.map((message, i) =>
        showKeyed(
          String(i),
          MessageView,
          {
            message,
            expanded: lastExpanded(s.expanded, i, s.messages.length),
            segments: segments([], null, i, messageText(message).length),
            active: null,
            update: null,
          },
          {},
          (msg: MessageMsg) => {
            if (msg.type === "TOGGLE_EXPANDED")
              dispatch({ type: "TOGGLE_EXPANDED", index: i });
          },
        ),
      ),
    );
  }

  sync(state: UpdatePaneState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}
/** Work that can only happen once the DOM reflects the new state. Scrolling to
 * a cited message needs the pane to already be showing that thread, which is
 * a reducer's job, so the two phases are bridged by the bus rather than by the
 * reducer reaching into the DOM. */
export type AppEvent =
  | { type: "transcript:reveal"; index: number }
  /** Bring the highlight that opens this thread back into view, so the pane on
   * the right is always beside the passage it is about. */
  | { type: "mark:reveal"; thread: ThreadId }
  /** The popup handed a question off to the pane's composer, which only exists
   * once the pane has mounted. */
  | { type: "learning:focus-query" };

export type AppCtx = { bus: PostRenderEventBus<AppEvent> };

/** The threads tab: the transcript, its composer, and the learning pane beside
 * them. Mounted only while its tab is showing; the state it renders all lives
 * in the prototype, so a remount costs nothing but the scroll position. */
class ThreadsView implements View<State, Msg, AppCtx> {
  container: HTMLElement;
  private b: Binder<State>;
  /** The latest state, for event handlers that need it outside a binding. */
  private current: State;
  private readonly unsubscribe: () => void;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: State,
    ctx: AppCtx,
  ) {
    const transcriptRef: Ref = ref("transcript");
    const inputRef: Ref = ref("input");
    const sendRef: Ref = ref("send");
    const composerRef: Ref = ref("composer");
    const learningRef: Ref = ref("learning");

    container.className = bodyClass;
    container.innerHTML = sanitize`
      <div class="${paneClass}">
        <div class="${scrollbackClass}">
          <ul class="${transcriptClass}" data-ref="${transcriptRef}"></ul>
        </div>
        <div class="${composerClass}" data-ref="${composerRef}">
          <textarea data-ref="${inputRef}" rows="2" placeholder="Ask something…"></textarea>
          <button type="button" data-ref="${sendRef}">Send</button>
        </div>
      </div>
      <div data-ref="${learningRef}"></div>
    `;
    this.container = container;
    this.current = initialState;
    this.b = new Binder(container, initialState);
    const input = this.b.ref<HTMLTextAreaElement>(inputRef);
    input.addEventListener("input", () => {
      dispatch({ type: "DRAFT_CHANGED", draft: input.value });
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        dispatch({ type: "SUBMIT" });
      }
    });
    this.b
      .ref(sendRef)
      .addEventListener("click", () => dispatch({ type: "SUBMIT" }));
    // Capture on mouseup/keyup rather than `selectionchange`: the browser
    // collapses the selection as soon as the user clicks the learning pane,
    // which is exactly when we need the anchor to survive.
    const transcript = this.b.ref(transcriptRef);
    const capture = () => {
      const anchor = readAnchor(transcript, this.current.thread);
      if (anchor === undefined) return;
      dispatch({ type: "SELECTION_CHANGED", anchor, at: pointOfSelection() });
    };
    transcript.addEventListener("mouseup", capture);
    transcript.addEventListener("keyup", capture);

    // Scroll and flash are facts about the rendered box, so they can only run
    // once the pane is already showing the cited thread.
    this.unsubscribe = ctx.bus.subscribe((event) => {
      if (event.type === "mark:reveal") {
        const mark = transcript.querySelector(`[data-mark="${event.thread}"]`);
        if (mark instanceof HTMLElement) scrollIntoView(mark);
        return;
      }
      if (event.type !== "transcript:reveal") return;
      const li = transcript.children[event.index];
      if (!(li instanceof HTMLElement)) return;
      scrollIntoView(li);
      li.classList.remove(flashClass);
      // Restarting the animation needs a frame with the class off.
      requestAnimationFrame(() => li.classList.add(flashClass));
    });
    // The transcript is append-only and never reorders, so the position of a
    // message is a stable identity.
    this.b.bindList(transcriptRef, "li", (s) =>
      s.messages.map((message, i) =>
        showKeyed(
          String(i),
          MessageView,
          {
            message,
            expanded: lastExpanded(s.expanded, i, s.messages.length),
            segments: segments(
              s.marks,
              s.anchor,
              i,
              messageText(message).length,
            ),
            active: s.activeMark,
            // Only worth showing while the reflect pane is beside this one:
            // at layer 0 there is nowhere for a chip to lead.
            update: s.split ? (s.updates.get(i) ?? null) : null,
          },
          {},
          (msg: MessageMsg) => {
            switch (msg.type) {
              case "TOGGLE_EXPANDED":
                dispatch({ type: "TOGGLE_EXPANDED", index: i });
                break;
              case "CHANGE_CLICKED":
                dispatch(msg);
                break;
              case "SHOW_UPDATE":
                dispatch({ type: "SHOW_UPDATE", index: i });
                break;
              case "CLICKED":
                dispatch({ type: "MARK_CLICKED", thread: msg.thread });
                break;
            }
          },
        ),
      ),
    );
    this.b.bindSlot(learningRef, (s) => {
      if (!s.split) return undefined;
      // The update transcript is opened explicitly and closed explicitly, so
      // while it is open it outranks both the active child and a selection.
      if (s.updatePane) {
        return show(UpdatePane, s.updatePane, {}, (msg: UpdatePaneMsg) =>
          dispatch({ type: "UPDATE_MSG", msg }),
        );
      }
      const child = s.child;
      // A live selection and an active child compete for this pane; the newer
      // one wins, and a selection is always the newer of the two here because
      // opening or clicking a thread clears it.
      if (child && !s.anchor) {
        return show(ThreadPane, child, {}, (msg: ThreadPaneMsg) =>
          dispatch({ type: "CHILD_MSG", msg }),
        );
      }
      const learningState: LearningState = {
        selection: paneSelection(s),
        overlapping: s.anchor !== null && overlaps(s.marks, s.anchor),
        query: s.query,
        marks: s.marks.map((mark) => ({
          thread: mark.thread,
          text: anchorText(mark.anchor, s.messages),
        })),
        threads: s.threads,
      };
      // bindSlot hands this straight to the child as its dispatch, so it must
      // dispatch rather than return a wrapped message.
      return show(LearningPane, learningState, ctx, (msg: LearningMsg) =>
        dispatch({ type: "LEARNING_MSG", msg }),
      );
    });
    this.b.bindValue(inputRef, (s) => s.draft);
    this.b.bindDisabled(inputRef, (s) => s.inFlight);
    this.b.bindDisabled(sendRef, (s) => s.inFlight || s.draft.trim() === "");
  }

  sync(state: State): void {
    this.current = state;
    this.b.sync(state);
  }

  destroy(): void {
    this.unsubscribe();
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

export class AppView implements View<State, Msg, AppCtx> {
  container: HTMLElement;
  private b: Binder<State>;
  /** The latest state, for event handlers that need it outside a binding. */
  private current: State;
  private onDocumentClick: (e: MouseEvent) => void;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: State,
    ctx: AppCtx,
  ) {
    const backRef: Ref = ref("back");
    const forwardRef: Ref = ref("forward");
    const depthRef: Ref = ref("depth");
    const sampleRef: Ref = ref("sample");
    const buildRef: Ref = ref("build");
    const resetRef: Ref = ref("reset");
    const buildStatusRef: Ref = ref("build-status");
    const buildDebugRef: Ref = ref("build-debug");
    const threadsTabRef: Ref = ref("threads-tab");
    const graphTabRef: Ref = ref("graph-tab");
    const tabSlotRef: Ref = ref("tab-slot");
    const menuRef: Ref = ref("menu");
    const popupRef: Ref = ref("popup");

    container.className = appClass;
    container.innerHTML = sanitize`
      <div class="${navClass}">
        <details class="${menuClass}" data-ref="${menuRef}">
          <summary title="Settings" aria-label="Settings">⚙</summary>
          <div>
            <select class="${sampleClass}" data-ref="${sampleRef}"></select>
            <button type="button" data-build data-ref="${buildRef}">Build knowledge graph from this transcript</button>
            <button type="button" data-ref="${resetRef}">Reset</button>
          </div>
        </details>
        <span class="${buildStatusClass}">
          <span data-build-status data-ref="${buildStatusRef}"></span>
          <button type="button" class="${buildDebugClass}" title="Dump build diagnostics to the console" data-ref="${buildDebugRef}">?</button>
        </span>
        <span class="${spacerClass}"></span>
        <span class="${tabsClass}">
          <button type="button" data-ref="${threadsTabRef}">Threads</button>
          <button type="button" data-ref="${graphTabRef}">Knowledge graph</button>
        </span>
        <span class="${spacerClass}"></span>
        <button type="button" data-ref="${backRef}">← Back</button>
        <span class="${depthClass}" data-ref="${depthRef}"></span>
        <button type="button" data-ref="${forwardRef}"></button>
      </div>
      <div data-ref="${tabSlotRef}"></div>
      <div data-ref="${popupRef}"></div>
    `;
    this.container = container;
    this.current = initialState;
    this.b = new Binder(container, initialState);

    // The option list is a module constant, so it is built once rather than
    // bound; switching sample is a page navigation anyway.
    const picker = this.b.ref<HTMLSelectElement>(sampleRef);
    const own = document.createElement("option");
    own.value = "";
    own.textContent = "Write your own";
    picker.append(own);
    for (const sample of samples) {
      const option = document.createElement("option");
      option.value = sample.id;
      option.textContent = sample.label;
      picker.append(option);
    }
    picker.addEventListener("change", () => {
      dispatch({ type: "SAMPLE_CHANGED", id: picker.value });
    });

    // The menu is a plain <details>, so it only knows how to close itself when
    // its own summary is clicked. Both of the other ways out are ours.
    const menu = this.b.ref<HTMLDetailsElement>(menuRef);
    menu.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) menu.open = false;
    });
    this.onDocumentClick = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) menu.open = false;
    };
    document.addEventListener("click", this.onDocumentClick);

    this.b
      .ref(backRef)
      .addEventListener("click", () => dispatch({ type: "GO_BACK" }));
    this.b
      .ref(forwardRef)
      .addEventListener("click", () => dispatch({ type: "GO_DEEPER" }));

    this.b
      .ref(buildRef)
      .addEventListener("click", () => dispatch({ type: "BUILD" }));
    this.b.bindDisabled(buildRef, (s) => s.build.type !== "idle");
    this.b.bindText(buildStatusRef, (s) => buildStatus(s.build));
    this.b.bindVisible(buildDebugRef, (s) => buildFailures(s.build).length > 0);
    this.b.ref(buildDebugRef).addEventListener("click", () => {
      console.log("build", this.current.build);
      for (const f of buildFailures(this.current.build))
        console.log(f.address, f.error);
    });

    this.b
      .ref(resetRef)
      .addEventListener("click", () => dispatch({ type: "RESET" }));
    this.b.bindValue(sampleRef, (s) => s.sample);
    this.b
      .ref(threadsTabRef)
      .addEventListener("click", () =>
        dispatch({ type: "TAB_CHANGED", tab: "threads" }),
      );
    this.b
      .ref(graphTabRef)
      .addEventListener("click", () =>
        dispatch({ type: "TAB_CHANGED", tab: "graph" }),
      );
    this.b.bindAttr(threadsTabRef, "aria-pressed", (s) =>
      s.tab === "threads" ? "true" : "false",
    );
    this.b.bindAttr(graphTabRef, "aria-pressed", (s) =>
      s.tab === "graph" ? "true" : "false",
    );
    // Exactly one tab is mounted: an unmounted pane cannot claim flex space
    // from the one that is showing.
    this.b.bindSlot(tabSlotRef, (s) =>
      s.tab === "graph"
        ? show(GraphView, s.graph, {}, (msg: GraphMsg) =>
            dispatch({ type: "GRAPH_MSG", msg }),
          )
        : show(ThreadsView, s, ctx, dispatch),
    );
    // Mounted here rather than beside the transcript because it belongs to no
    // column: the view it mounts portals itself to the body, and this slot is
    // only what governs its lifetime.
    this.b.bindSlot(popupRef, (s) => {
      const at = s.tab === "threads" ? s.popup : null;
      if (!at) return undefined;
      const popup: PopupState = { at };
      return show(SelectionPopup, popup, {}, (msg: LearningMsg) =>
        dispatch({ type: "LEARNING_MSG", msg }),
      );
    });
    this.b.bindContainerAttr("data-split", (s) => (s.split ? "true" : "false"));
    this.b.bindText(forwardRef, (s) => `${descendLabel(s.depth + 1)} →`);
    this.b.bindDisabled(forwardRef, (s) => s.split && !s.canDescend);
    // Not rendered at layer 0: there is nowhere above the task thread.
    this.b.bindVisible(backRef, (s) => s.split && s.tab === "threads");
    this.b.bindVisible(forwardRef, (s) => s.tab === "threads");
    this.b.bindVisible(depthRef, (s) => s.tab === "threads");
    this.b.bindText(depthRef, (s) => `Layer ${s.depth}`);
  }

  sync(state: State): void {
    this.current = state;
    this.b.sync(state);
  }

  destroy(): void {
    document.removeEventListener("click", this.onDocumentClick);
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

/** A count rather than a spinner: this is one model call per turn and it takes
 * as long as it takes. */
function buildFailures(build: Build): ReadonlyArray<BuildFailure> {
  return build.type === "idle" ? [] : build.failures;
}

function buildStatus(build: Build): string {
  switch (build.type) {
    case "idle":
      return "";
    case "running":
      return `${build.done} / ${build.total} interactions`;
    case "done":
      return build.failures.length === 0
        ? "built"
        : `built, ${build.failures.length} failed`;
  }
}

/** Names the layer `→` leads to. */
function descendLabel(destination: number): string {
  switch (destination) {
    case 1:
      return "Reflect";
    case 3:
      return "We must go deeper";
    case 4:
      return "Thinkception!";
    default:
      return "Go deeper";
  }
}

/** The passage the right pane is about: the live selection, or - once one has
 * been committed - the mark whose thread is active. */
function paneSelection(s: State): string | null {
  if (s.anchor) return anchorText(s.anchor, s.messages);
  const active = s.marks.find((m) => m.thread === s.activeMark);
  return active ? anchorText(active.anchor, s.messages) : null;
}
/** Where a popup over the live selection belongs: the bottom centre of the
 * dragged range, in viewport coordinates, which is why the popup is fixed -
 * neither pane's scroll offset comes into it. Null when nothing is selected. */
function pointOfSelection(): { x: number; y: number } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.bottom };
}

/** Reads the live browser selection as an Anchor. Returns `undefined` when the
 * selection has nothing to do with the transcript, which must not clobber a
 * previously captured anchor. */
function readAnchor(
  transcript: HTMLElement,
  thread: ThreadId,
): Anchor | null | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const start = resolvePoint(
    transcript,
    range.startContainer,
    range.startOffset,
  );
  const end = resolvePoint(transcript, range.endContainer, range.endOffset);
  if (!start || !end) return undefined;
  if (start.msg === end.msg && start.offset === end.offset) return null;
  return { thread, start, end };
}

function resolvePoint(
  transcript: HTMLElement,
  node: Node,
  offset: number,
): Point | null {
  const el =
    node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
  const textEl = el?.closest(`.${textClass}`);
  if (!textEl || !transcript.contains(textEl)) return null;
  const li = textEl.closest("li");
  if (!li) return null;
  const msg = Array.prototype.indexOf.call(transcript.children, li);
  if (msg < 0) return null;

  // The message text is split across pre/mark/post spans, so a node-local
  // offset is not a message offset; measure the text preceding the point.
  const prefix = document.createRange();
  prefix.setStart(textEl, 0);
  prefix.setEnd(node, offset);
  return { msg, offset: prefix.toString().length };
}
