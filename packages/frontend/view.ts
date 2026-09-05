import type { Message } from "./conversation.ts";
import {
  type Msg as LearningMsg,
  LearningPane,
  type State as LearningState,
} from "./learning.ts";
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

export type Mode = "task" | "learning";

export type State = {
  messages: ReadonlyArray<Message>;
  inFlight: boolean;
  draft: string;
  mode: Mode;
  /** The thread whose transcript this pane shows; the live selection is over it. */
  thread: ThreadId;
  /** Committed highlights over this transcript. */
  marks: ReadonlyArray<Mark>;
  /** The mark whose thread the right pane is showing, drawn emphasized. */
  activeMark: ThreadId | null;
  anchor: Anchor | null;
  query: string;
  /** The active child thread, shown on the right when nothing is selected. */
  child: ThreadPaneState | null;
};

export type Msg =
  | { type: "DRAFT_CHANGED"; draft: string }
  | { type: "SUBMIT" }
  | { type: "MODE_TOGGLED" }
  | { type: "SELECTION_CHANGED"; anchor: Anchor | null }
  | { type: "MARK_CLICKED"; thread: ThreadId }
  | { type: "LEARNING_MSG"; msg: LearningMsg }
  | { type: "CHILD_MSG"; msg: ThreadPaneMsg };

const appClass = cls("app");
const transcriptClass = cls("transcript");
const messageClass = cls("message");
const roleClass = cls("role");
const composerClass = cls("composer");
const paneClass = cls("pane");
const toggleClass = cls("toggle");
const markClass = cls("mark");
const textClass = cls("text");
const threadPaneClass = cls("thread-pane");
const threadQuoteClass = cls("thread-quote");

mountStyle(`
.${appClass} {
  font-family: system-ui, sans-serif;
  max-width: 44rem;
  margin: 0 auto;
  padding: 1rem;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 1rem 2rem;
  align-items: start;
}
.${appClass}[data-mode="learning"] {
  max-width: 88rem;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.${paneClass} {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  min-width: 0;
}
.${toggleClass} {
  position: fixed;
  top: 4.5rem;
  right: 1rem;
  z-index: 10;
  font: inherit;
  padding: 0.4rem 0.8rem;
  border-radius: 999px;
  border: 1px solid rgba(0, 0, 0, 0.2);
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.15);
  cursor: pointer;
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
  white-space: pre-wrap;
  line-height: 1.5;
}
.${messageClass}[data-role="user"] {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 0.5rem;
  padding: 0.5rem 0.75rem;
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
  position: sticky;
  top: 4rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border-left: 1px solid rgba(0, 0, 0, 0.1);
  padding-left: 1.5rem;
}
.${threadQuoteClass} {
  white-space: pre-wrap;
  border-left: 3px solid #f0b429;
  margin: 0;
  padding-left: 0.75rem;
  max-height: 8rem;
  overflow-y: auto;
  font-size: 0.9rem;
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
  segments: ReadonlyArray<Segment>;
  active: ThreadId | null;
};

class MessageView implements View<MessageState, SegmentMsg> {
  container: HTMLElement;
  private b: Binder<MessageState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: SegmentMsg) => void,
    initial: MessageState,
  ) {
    const roleRef = ref("role");
    const textRef = ref("text");
    container.className = messageClass;
    container.innerHTML = sanitize`
      <span class="${roleClass}" data-ref="${roleRef}"></span>
      <span class="${textClass}" data-ref="${textRef}"></span>
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
            text: s.message.text.slice(seg.start, seg.end),
            thread: seg.thread,
            live: seg.live,
            active: seg.thread !== null && seg.thread === s.active,
          },
          {},
          dispatch,
        ),
      ),
    );
    this.b.bindContainerAttr("data-role", (s) => s.message.role);
  }

  sync(state: MessageState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

export type ThreadPaneState = {
  /** The passage this thread was opened from. */
  quote: string;
  messages: ReadonlyArray<Message>;
  inFlight: boolean;
  draft: string;
};

export type ThreadPaneMsg =
  | { type: "DRAFT_CHANGED"; draft: string }
  | { type: "SUBMIT" };

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
    const quoteRef = ref("quote");
    const transcriptRef = ref("thread-transcript");
    const inputRef = ref("thread-input");
    const sendRef = ref("thread-send");

    container.className = threadPaneClass;
    container.innerHTML = sanitize`
      <blockquote class="${threadQuoteClass}" data-ref="${quoteRef}"></blockquote>
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

    this.b.bindText(quoteRef, (s) => s.quote);
    this.b.bindList(transcriptRef, "li", (s) =>
      s.messages.map((message, i) =>
        showKeyed(
          String(i),
          MessageView,
          {
            message,
            segments: segments([], null, i, message.text.length),
            active: null,
          },
          {},
          () => {},
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
    const toggleRef: Ref = ref("toggle");
    const composerRef: Ref = ref("composer");
    const learningRef: Ref = ref("learning");

    container.className = appClass;
    container.innerHTML = sanitize`
      <button type="button" class="${toggleClass}" data-ref="${toggleRef}"></button>
      <div class="${paneClass}">
        <ul class="${transcriptClass}" data-ref="${transcriptRef}"></ul>
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
    this.b
      .ref(toggleRef)
      .addEventListener("click", () => dispatch({ type: "MODE_TOGGLED" }));

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
            segments: segments(s.marks, s.anchor, i, message.text.length),
            active: s.activeMark,
          },
          {},
          (msg: SegmentMsg) =>
            dispatch({ type: "MARK_CLICKED", thread: msg.thread }),
        ),
      ),
    );
    this.b.bindContainerAttr("data-mode", (s) => s.mode);
    this.b.bindText(toggleRef, (s) =>
      s.mode === "task" ? "Switch to learning mode" : "Back to task mode",
    );
    this.b.bindVisible(composerRef, (s) => s.mode === "task");
    this.b.bindSlot(learningRef, (s) => {
      if (s.mode !== "learning") return undefined;
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
