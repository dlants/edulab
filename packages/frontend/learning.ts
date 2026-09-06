import { type Action, actionLabel } from "./prompt.ts";
import type { ThreadId } from "./selection.ts";
import {
  Binder,
  cls,
  mountStyle,
  type PostRenderEventBus,
  ref,
  sanitize,
  showKeyed,
  type View,
} from "./vamp.ts";
import type { AppEvent } from "./view.ts";

export type { Action };

export type State = {
  /** The text the user highlighted, or null when nothing is selected. */
  selection: string | null;
  /** The live selection intersects a committed mark, so no action is offered. */
  overlapping: boolean;
  query: string;
  /** The passages in this thread that already own a thread, offered as a way
   * back into them when nothing is selected. */
  marks: ReadonlyArray<{ thread: ThreadId; text: string }>;
  /** Thread-level children of the focused thread, offered as a way back in:
   * they paint no highlight, so the list is the only way to reach them. */
  threads: ReadonlyArray<{ thread: ThreadId; label: string }>;
};

/** Where the live selection ended, in viewport coordinates: the popup is
 * fixed-position, so it needs no knowledge of which pane scrolled. */
export type PopupState = { at: { x: number; y: number } };

export type Msg =
  | { type: "ACTION"; action: Action }
  /** Open the reflect layer on this passage without an action, so the user can
   * type their own question into the pane's composer. */
  | { type: "ASK" }
  | { type: "QUERY_CHANGED"; query: string }
  /** One of the existing passages was picked out of the list. */
  | { type: "MARK_CLICKED"; thread: ThreadId };

const paneClass = cls("learning-pane");
const popupClass = cls("selection-popup");
const emptyClass = cls("learning-empty");
const quoteClass = cls("learning-quote");
const actionsClass = cls("learning-actions");
const warnClass = cls("learning-warn");
const markListClass = cls("learning-mark-list");

mountStyle(`
.${paneClass} {
  position: sticky;
  top: 4rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  border-left: 1px solid rgba(0, 0, 0, 0.1);
  padding-left: 1.5rem;
}
.${emptyClass} {
  opacity: 0.5;
  font-style: italic;
}
.${markListClass} {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.${markListClass} button {
  font: inherit;
  font-size: 0.85rem;
  text-align: left;
  width: 100%;
  padding: 0.35rem 0.5rem;
  border: none;
  border-left: 3px solid #f0b429;
  background: rgba(0, 0, 0, 0.03);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${markListClass} button:hover {
  background: rgba(0, 0, 0, 0.08);
}
.${warnClass} {
  font-style: italic;
  color: #a35200;
}
.${quoteClass} {
  white-space: pre-wrap;
  border-left: 3px solid #f0b429;
  padding-left: 0.75rem;
  max-height: 12rem;
  overflow-y: auto;
  font-size: 0.9rem;
}
.${actionsClass} {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.5rem;
}
.${actionsClass} button {
  font: inherit;
  text-align: left;
  padding: 0.5rem 0.75rem;
}
.${actionsClass} textarea {
  font: inherit;
  padding: 0.5rem;
  resize: vertical;
}
.${popupClass} {
  position: fixed;
  z-index: 10;
  transform: translate(-50%, 0.5rem);
  width: 16rem;
  padding: 0.5rem;
  border-radius: 0.5rem;
  border: 1px solid rgba(0, 0, 0, 0.15);
  background: #fff;
  box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.18);
}
`);

/** The same three affordances as the pane, floated next to the passage the
 * user just dragged. This is the only way into a reflection thread when the
 * pane is not on screen: at layer 0, and out of the reflect thread itself. */
export class SelectionPopup implements View<PopupState, Msg> {
  container: HTMLElement;
  /** The popup is portalled to the body rather than rendered where it is
   * mounted: it floats over a pane, and the panes are scrolling grid columns
   * that would clip it and reserve layout for it. */
  private readonly portal: HTMLElement;
  private b: Binder<PopupState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: PopupState,
  ) {
    const explainRef = ref("popup-explain");
    const quizRef = ref("popup-quiz");
    const askRef = ref("popup-ask");

    this.container = container;
    this.portal = document.createElement("div");
    this.portal.className = `${popupClass} ${actionsClass}`;
    this.portal.innerHTML = sanitize`
      <button type="button" data-ref="${explainRef}">${actionLabel({ type: "explain" })}</button>
      <button type="button" data-ref="${quizRef}">${actionLabel({ type: "quiz" })}</button>
      <button type="button" data-ref="${askRef}">Ask your own question…</button>
    `;
    document.body.append(this.portal);
    this.b = new Binder(this.portal, initialState);

    // Selecting text and then reaching for the popup collapses the browser
    // selection on mousedown, which would dismiss the popup before the click
    // lands; the anchor is already captured, so the default is not wanted.
    this.portal.addEventListener("mousedown", (e: MouseEvent) => {
      e.preventDefault();
    });
    this.b
      .ref(explainRef)
      .addEventListener("click", () =>
        dispatch({ type: "ACTION", action: { type: "explain" } }),
      );
    this.b
      .ref(quizRef)
      .addEventListener("click", () =>
        dispatch({ type: "ACTION", action: { type: "quiz" } }),
      );
    // A textarea here cannot be typed into: the popup suppresses mousedown to
    // keep the selection alive, so it can never take focus. The composer in the
    // pane can, so this hands off to it.
    this.b
      .ref(askRef)
      .addEventListener("click", () => dispatch({ type: "ASK" }));

    this.b.bindContainerStyle((s) => ({
      left: `${s.at.x}px`,
      top: `${s.at.y}px`,
    }));
  }

  sync(state: PopupState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.portal.remove();
  }
}

export type PaneCtx = { bus: PostRenderEventBus<AppEvent> };

/** One already-opened passage in the list. Its own view so the list can be
 * keyed by thread rather than rebuilt on every sync. */
class MarkItem implements View<{ text: string }, { type: "CLICK" }> {
  container: HTMLElement;
  private b: Binder<{ text: string }>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: { type: "CLICK" }) => void,
    initialState: { text: string },
  ) {
    const buttonRef = ref("mark-item");
    container.innerHTML = sanitize`<button type="button" data-ref="${buttonRef}"></button>`;
    this.container = container;
    this.b = new Binder(container, initialState);
    this.b
      .ref(buttonRef)
      .addEventListener("click", () => dispatch({ type: "CLICK" }));
    this.b.bindText(buttonRef, (s) => s.text);
  }

  sync(state: { text: string }): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

export class LearningPane implements View<State, Msg, PaneCtx> {
  container: HTMLElement;
  private b: Binder<State>;
  private readonly unsubscribe: () => void;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: State,
    ctx: PaneCtx,
  ) {
    const emptyRef = ref("empty");
    const reviewRef = ref("review");
    const ideasRef = ref("ideas");
    const threadQueryRef = ref("thread-query");
    const threadListRef = ref("thread-list");
    const bodyRef = ref("body");
    const quoteRef = ref("quote");
    const explainRef = ref("explain");
    const quizRef = ref("quiz");
    const queryRef = ref("query");
    const warnRef = ref("warn");
    const markListRef = ref("mark-list");

    container.className = paneClass;
    container.innerHTML = sanitize`
      <div class="${actionsClass}" data-ref="${emptyRef}">
        <button type="button" data-ref="${reviewRef}">${actionLabel({ type: "review" })}</button>
        <button type="button" data-ref="${ideasRef}">${actionLabel({ type: "ideas" })}</button>
        <p class="${emptyClass}">Select some text to ask a question about a specific part of this task.</p>
        <textarea data-ref="${threadQueryRef}" rows="2" placeholder="Ask a question about this task…"></textarea>
        <ul class="${markListClass}" data-ref="${threadListRef}"></ul>
        <ul class="${markListClass}" data-ref="${markListRef}"></ul>
      </div>
      <p class="${warnClass}" data-ref="${warnRef}">Select a non-overlapping section.</p>
      <div class="${actionsClass}" data-ref="${bodyRef}">
        <blockquote class="${quoteClass}" data-ref="${quoteRef}"></blockquote>
        <button type="button" data-ref="${explainRef}">I don't understand this.</button>
        <button type="button" data-ref="${quizRef}">Quiz me on this.</button>
        <textarea data-ref="${queryRef}" rows="2" placeholder="Ask your own question…"></textarea>
      </div>
    `;
    this.container = container;
    this.b = new Binder(container, initialState);

    this.b
      .ref(explainRef)
      .addEventListener("click", () =>
        dispatch({ type: "ACTION", action: { type: "explain" } }),
      );
    this.b
      .ref(quizRef)
      .addEventListener("click", () =>
        dispatch({ type: "ACTION", action: { type: "quiz" } }),
      );

    this.b
      .ref(reviewRef)
      .addEventListener("click", () =>
        dispatch({ type: "ACTION", action: { type: "review" } }),
      );
    this.b
      .ref(ideasRef)
      .addEventListener("click", () =>
        dispatch({ type: "ACTION", action: { type: "ideas" } }),
      );

    // Two boxes rather than one shared with the passage branch: they sit in a
    // different place in each branch's stack, and the scope of what is typed is
    // decided by whether there is a live selection, not by which box it was.
    const composer = (el: HTMLTextAreaElement) => {
      el.addEventListener("input", () => {
        dispatch({ type: "QUERY_CHANGED", query: el.value });
      });
      el.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key !== "Enter" || e.shiftKey) return;
        e.preventDefault();
        const text = el.value.trim();
        if (text === "") return;
        dispatch({ type: "ACTION", action: { type: "query", text } });
      });
    };
    const query = this.b.ref<HTMLTextAreaElement>(queryRef);
    composer(query);
    composer(this.b.ref<HTMLTextAreaElement>(threadQueryRef));

    // The popup hands the question over to this box: it cannot take focus
    // itself without dropping the selection, so the pane takes it here, once
    // the pane is actually on screen.
    this.unsubscribe = ctx.bus.subscribe((event) => {
      if (event.type === "learning:focus-query") query.focus();
    });

    this.b.bindVisible(emptyRef, (s) => s.selection === null && !s.overlapping);
    this.b.bindVisible(markListRef, (s) => s.marks.length > 0);
    this.b.bindVisible(threadListRef, (s) => s.threads.length > 0);
    this.b.bindList(threadListRef, "li", (s) =>
      s.threads.map((child) =>
        showKeyed(child.thread, MarkItem, { text: child.label }, {}, () =>
          dispatch({ type: "MARK_CLICKED", thread: child.thread }),
        ),
      ),
    );
    this.b.bindList(markListRef, "li", (s) =>
      s.marks.map((mark) =>
        showKeyed(mark.thread, MarkItem, { text: mark.text }, {}, () =>
          dispatch({ type: "MARK_CLICKED", thread: mark.thread }),
        ),
      ),
    );
    this.b.bindVisible(warnRef, (s) => s.overlapping);
    this.b.bindVisible(bodyRef, (s) => s.selection !== null && !s.overlapping);
    this.b.bindText(quoteRef, (s) => s.selection ?? "");
    this.b.bindValue(queryRef, (s) => s.query);
    this.b.bindValue(threadQueryRef, (s) => s.query);
  }

  sync(state: State): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.unsubscribe();
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}
