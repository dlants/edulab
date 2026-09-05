import type { Message } from "./conversation.ts";
import {
  type Action,
  type Msg as LearningMsg,
  LearningPane,
  type State as LearningState,
} from "./learning.ts";
import {
  type Anchor,
  anchorText,
  clipToMessage,
  type Point,
} from "./selection.ts";
import {
  Binder,
  cls,
  mountStyle,
  noop,
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
  anchor: Anchor | null;
  query: string;
  pending: Action | null;
};

export type Msg =
  | { type: "DRAFT_CHANGED"; draft: string }
  | { type: "SUBMIT" }
  | { type: "MODE_TOGGLED" }
  | { type: "SELECTION_CHANGED"; anchor: Anchor | null }
  | { type: "LEARNING_MSG"; msg: LearningMsg };

const appClass = cls("app");
const transcriptClass = cls("transcript");
const messageClass = cls("message");
const roleClass = cls("role");
const composerClass = cls("composer");
const paneClass = cls("pane");
const toggleClass = cls("toggle");
const markClass = cls("mark");
const textClass = cls("text");

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
  background: #ffe8a3;
  border-radius: 2px;
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
.${composerClass} textarea {
  flex: 1;
  font: inherit;
  padding: 0.5rem;
  resize: vertical;
}
`);

type MessageState = {
  message: Message;
  mark: { start: number; end: number } | null;
};

class MessageView implements View<MessageState> {
  container: HTMLElement;
  private b: Binder<MessageState>;

  constructor(
    container: HTMLElement,
    _dispatch: (msg: never) => void,
    initial: MessageState,
  ) {
    const roleRef = ref("role");
    const preRef = ref("pre");
    const markRef = ref("mark");
    const postRef = ref("post");
    container.className = messageClass;
    container.innerHTML = sanitize`
      <span class="${roleClass}" data-ref="${roleRef}"></span>
      <span class="${textClass}"><span data-ref="${preRef}"></span><mark class="${markClass}" data-ref="${markRef}"></mark><span data-ref="${postRef}"></span></span>
    `;
    this.container = container;
    this.b = new Binder(container, initial);
    this.b.bindText(roleRef, (s) => s.message.role);
    this.b.bindText(preRef, (s) =>
      s.mark ? s.message.text.slice(0, s.mark.start) : s.message.text,
    );
    this.b.bindText(markRef, (s) =>
      s.mark ? s.message.text.slice(s.mark.start, s.mark.end) : "",
    );
    this.b.bindText(postRef, (s) =>
      s.mark ? s.message.text.slice(s.mark.end) : "",
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

export class AppView implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State>;

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
      const anchor = readAnchor(transcript);
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
          { message, mark: clipToMessage(s.anchor, i, message.text.length) },
          {},
          noop,
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
      const learningState: LearningState = {
        selection: s.anchor ? anchorText(s.anchor, s.messages) : null,
        query: s.query,
        pending: s.pending,
      };
      return show(LearningPane, learningState, {}, (msg: LearningMsg) => ({
        type: "LEARNING_MSG" as const,
        msg,
      }));
    });
    this.b.bindValue(inputRef, (s) => s.draft);
    this.b.bindDisabled(inputRef, (s) => s.inFlight);
    this.b.bindDisabled(sendRef, (s) => s.inFlight || s.draft.trim() === "");
  }

  sync(state: State): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

/** Reads the live browser selection as an Anchor. Returns `undefined` when the
 * selection has nothing to do with the transcript, which must not clobber a
 * previously captured anchor. */
function readAnchor(transcript: HTMLElement): Anchor | null | undefined {
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
  return { start, end };
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
