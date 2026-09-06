import {
  type Msg as GraphMsg,
  type State as GraphState,
  GraphView,
} from "./graph-view.ts";
import {
  type Msg as LearningMsg,
  LearningPane,
  type State as LearningState,
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
  type Ref,
  ref,
  sanitize,
  show,
  showKeyed,
  type View,
} from "./vamp.ts";

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
  anchor: Anchor | null;
  query: string;
  /** Which top-level tab is showing. State, not a route: a page load would
   * discard the graph. */
  tab: "threads" | "graph";
  graph: GraphState;
  /** Indices of messages the user has expanded past the collapsed height. */
  expanded: ReadonlySet<number>;
  /** The active child thread, shown on the right when nothing is selected. */
  child: ThreadPaneState | null;
};

export type Msg =
  | { type: "DRAFT_CHANGED"; draft: string }
  | { type: "SUBMIT" }
  | { type: "GO_DEEPER" }
  | { type: "GO_BACK" }
  | { type: "SELECTION_CHANGED"; anchor: Anchor | null }
  | { type: "MARK_CLICKED"; thread: ThreadId }
  | { type: "LEARNING_MSG"; msg: LearningMsg }
  | { type: "SAMPLE_CHANGED"; id: string }
  | { type: "TAB_CHANGED"; tab: "threads" | "graph" }
  | { type: "GRAPH_MSG"; msg: GraphMsg }
  | { type: "TOGGLE_EXPANDED"; index: number }
  | { type: "CHILD_MSG"; msg: ThreadPaneMsg };

const appClass = cls("app");
const transcriptClass = cls("transcript");
const messageClass = cls("message");
const roleClass = cls("role");
const composerClass = cls("composer");
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
const spacerClass = cls("spacer");
const tabsClass = cls("tabs");
const graphTabClass = cls("graph-tab");

/** A message collapses to this many lines: about a third of a screen. */
const MAX_MESSAGE_LINES = 15;
const clipClass = cls("clip");
const toggleClass = cls("toggle");
const moreClass = cls("more");

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
/* Each layer column scrolls on its own: a long transcript on the left must not
 * drag the thread on the right out of view. */
.${paneClass} {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 0 5rem;
}
/* The transcript takes the slack so the composer sits at the bottom of the
 * viewport rather than floating under the header on a short thread. */
.${paneClass} > .${transcriptClass} {
  flex: 1;
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
.${sampleClass} {
  font: inherit;
}
.${spacerClass} {
  flex: 1;
}
.${tabsClass} button[aria-pressed="true"] {
  background: rgba(0, 0, 0, 0.08);
  font-weight: 600;
}
.${graphTabClass} {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
  display: flex;
  gap: 0.5rem;
}
.${threadPaneClass} {
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 0 5rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border-left: 1px solid rgba(0, 0, 0, 0.1);
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

type MessageState = {
  message: Message;
  expanded: boolean;
  segments: ReadonlyArray<Segment>;
  active: ThreadId | null;
};

type MessageMsg = SegmentMsg | { type: "TOGGLE_EXPANDED" };

class MessageView implements View<MessageState, MessageMsg> {
  container: HTMLElement;
  private b: Binder<MessageState>;
  private clip!: HTMLElement;
  private more!: HTMLElement;
  private hiddenLines = 0;

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
    this.b.bindContainerAttr("data-role", (s) => s.message.role);
    this.clip = this.b.ref(clipRef);
    this.more = this.b.ref(moreRef);
    const toggle = () => dispatch({ type: "TOGGLE_EXPANDED" });
    this.b.ref(toggleRef).addEventListener("click", toggle);
    this.more.addEventListener("click", toggle);
    // Not bound: whether the message overflows is a fact about the rendered
    // box, so it can only be read back after the DOM has been written.
    this.b.bindContainerAttr("data-clipped", (s) =>
      s.expanded ? undefined : "true",
    );
    this.measure(initial.expanded);
  }

  sync(state: MessageState): void {
    this.b.sync(state);
    this.measure(state.expanded);
  }

  /** Reads the clipped height back out of the layout to decide whether the
   * expand affordance is worth showing, and by how many lines. The count is
   * remembered while expanded, when there is nothing left to measure. */
  private measure(expanded: boolean): void {
    // On first render the container is still detached (bindList constructs and
    // syncs before inserting), so there is no layout to read yet.
    if (!this.container.isConnected) {
      requestAnimationFrame(() => {
        if (this.container.isConnected) this.measure(expanded);
      });
      return;
    }
    const lineHeight =
      Number.parseFloat(getComputedStyle(this.clip).lineHeight) || 1;
    // scrollHeight is the full content height whether or not the box is
    // clipped, so this reads the same while expanded - which it must, since
    // an expanded message still needs its collapse affordance.
    this.hiddenLines = Math.round(
      this.clip.scrollHeight / lineHeight - MAX_MESSAGE_LINES,
    );
    const clipped = this.hiddenLines > 0;
    this.container.dataset.overflowing = clipped ? "true" : "false";
    this.more.textContent =
      clipped && !expanded ? `… ${this.hiddenLines} more lines` : "";
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

function resultText(message: Message): string {
  if (message.type !== "tool_use") return "";
  const result = message.call.result;
  if (!result) return "";
  return result.status === "ok" ? result.text : result.error;
}

export type ThreadPaneState = {
  messages: ReadonlyArray<Message>;
  inFlight: boolean;
  draft: string;
  expanded: ReadonlySet<number>;
};

export type ThreadPaneMsg =
  | { type: "DRAFT_CHANGED"; draft: string }
  | { type: "SUBMIT" }
  | { type: "TOGGLE_EXPANDED"; index: number };

/** A learning thread on the right: the passage it came from, its transcript,
 * and a composer. Read-only as far as selection goes - only the left pane
 * captures one. */
class ThreadPane implements View<ThreadPaneState, ThreadPaneMsg> {
  container: HTMLElement;
  private b: Binder<ThreadPaneState>;

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
      <ul class="${transcriptClass}" data-ref="${transcriptRef}"></ul>
      <div class="${composerClass}">
        <textarea data-ref="${inputRef}" rows="2" placeholder="Follow up…"></textarea>
        <button type="button" data-ref="${sendRef}">Reply</button>
      </div>
    `;
    this.container = container;
    this.b = new Binder(container, initial);

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
            segments: segments([], null, i, messageText(message).length),
            active: null,
          },
          {},
          (msg: MessageMsg) => {
            if (msg.type === "TOGGLE_EXPANDED")
              dispatch({ type: "TOGGLE_EXPANDED", index: i });
          },
        ),
      ),
    );
    this.b.bindValue(inputRef, (s) => s.draft);
    this.b.bindDisabled(inputRef, (s) => s.inFlight);
    this.b.bindDisabled(sendRef, (s) => s.inFlight || s.draft.trim() === "");
  }

  sync(state: ThreadPaneState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

export class AppView implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State>;
  /** The latest state, for event handlers that need it outside a binding. */
  private current: State;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: State,
  ) {
    const transcriptRef: Ref = ref("transcript");
    const inputRef: Ref = ref("input");
    const sendRef: Ref = ref("send");
    const backRef: Ref = ref("back");
    const forwardRef: Ref = ref("forward");
    const depthRef: Ref = ref("depth");
    const composerRef: Ref = ref("composer");
    const learningRef: Ref = ref("learning");
    const sampleRef: Ref = ref("sample");
    const threadsTabRef: Ref = ref("threads-tab");
    const graphTabRef: Ref = ref("graph-tab");
    const bodyRef: Ref = ref("body");
    const graphSlotRef: Ref = ref("graph-slot");

    container.className = appClass;
    container.innerHTML = sanitize`
      <div class="${navClass}">
        <select class="${sampleClass}" data-ref="${sampleRef}"></select>
        <span class="${tabsClass}">
          <button type="button" data-ref="${threadsTabRef}">Threads</button>
          <button type="button" data-ref="${graphTabRef}">Knowledge graph</button>
        </span>
        <span class="${spacerClass}"></span>
        <button type="button" data-ref="${backRef}">← Back</button>
        <span class="${depthClass}" data-ref="${depthRef}"></span>
        <button type="button" data-ref="${forwardRef}"></button>
      </div>
      <div class="${bodyClass}" data-ref="${bodyRef}">
      <div class="${paneClass}">
        <ul class="${transcriptClass}" data-ref="${transcriptRef}"></ul>
        <div class="${composerClass}" data-ref="${composerRef}">
          <textarea data-ref="${inputRef}" rows="2" placeholder="Ask something…"></textarea>
          <button type="button" data-ref="${sendRef}">Send</button>
        </div>
      </div>
        <div data-ref="${learningRef}"></div>
      </div>
      <div class="${graphTabClass}" data-ref="${graphSlotRef}"></div>
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

    this.b
      .ref(backRef)
      .addEventListener("click", () => dispatch({ type: "GO_BACK" }));
    this.b
      .ref(forwardRef)
      .addEventListener("click", () => dispatch({ type: "GO_DEEPER" }));

    // Capture on mouseup/keyup rather than `selectionchange`: the browser
    // collapses the selection as soon as the user clicks the learning pane,
    // which is exactly when we need the anchor to survive.
    const transcript = this.b.ref(transcriptRef);
    const capture = () => {
      const anchor = readAnchor(transcript, this.current.thread);
      if (anchor !== undefined) dispatch({ type: "SELECTION_CHANGED", anchor });
    };
    transcript.addEventListener("mouseup", capture);
    transcript.addEventListener("keyup", capture);

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
          },
          {},
          (msg: MessageMsg) =>
            dispatch(
              msg.type === "TOGGLE_EXPANDED"
                ? { type: "TOGGLE_EXPANDED", index: i }
                : { type: "MARK_CLICKED", thread: msg.thread },
            ),
        ),
      ),
    );
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
    // The threads pane is hidden rather than unmounted: the transcript, the
    // draft and the live selection all survive a trip to the graph tab.
    this.b.bindVisible(bodyRef, (s) => s.tab === "threads");
    // Otherwise the empty graph slot still claims its flex share of the column
    // and the transcript only gets part of the viewport.
    this.b.bindVisible(graphSlotRef, (s) => s.tab === "graph");
    this.b.bindSlot(graphSlotRef, (s) =>
      s.tab === "graph"
        ? show(GraphView, s.graph, {}, (msg: GraphMsg) =>
            dispatch({ type: "GRAPH_MSG", msg }),
          )
        : undefined,
    );
    this.b.bindContainerAttr("data-split", (s) => (s.split ? "true" : "false"));
    this.b.bindText(forwardRef, (s) => `${descendLabel(s.depth + 1)} →`);
    this.b.bindDisabled(forwardRef, (s) => s.split && !s.canDescend);
    // Not rendered at layer 0: there is nowhere above the task thread.
    this.b.bindVisible(backRef, (s) => s.split && s.tab === "threads");
    this.b.bindVisible(forwardRef, (s) => s.tab === "threads");
    this.b.bindVisible(depthRef, (s) => s.tab === "threads");
    this.b.bindText(depthRef, (s) => `Layer ${s.depth}`);
    this.b.bindSlot(learningRef, (s) => {
      if (!s.split) return undefined;
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
      };
      // bindSlot hands this straight to the child as its dispatch, so it must
      // dispatch rather than return a wrapped message.
      return show(LearningPane, learningState, {}, (msg: LearningMsg) =>
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
    this.b.cleanup();
    this.container.innerHTML = "";
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
