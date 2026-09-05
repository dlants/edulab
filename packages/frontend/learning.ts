import type { Action } from "./prompt.ts";
import { Binder, cls, mountStyle, ref, sanitize, type View } from "./vamp.ts";

export type { Action };

export type State = {
  /** The text the user highlighted, or null when nothing is selected. */
  selection: string | null;
  /** The live selection intersects a committed mark, so no action is offered. */
  overlapping: boolean;
  query: string;
};

export type Msg =
  | { type: "ACTION"; action: Action }
  | { type: "QUERY_CHANGED"; query: string };

const paneClass = cls("learning-pane");
const emptyClass = cls("learning-empty");
const quoteClass = cls("learning-quote");
const actionsClass = cls("learning-actions");
const warnClass = cls("learning-warn");

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
`);

export class LearningPane implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: State,
  ) {
    const emptyRef = ref("empty");
    const bodyRef = ref("body");
    const quoteRef = ref("quote");
    const explainRef = ref("explain");
    const quizRef = ref("quiz");
    const queryRef = ref("query");
    const warnRef = ref("warn");

    container.className = paneClass;
    container.innerHTML = sanitize`
      <p class="${emptyClass}" data-ref="${emptyRef}">Select some text to get started.</p>
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

    const query = this.b.ref<HTMLTextAreaElement>(queryRef);
    query.addEventListener("input", () => {
      dispatch({ type: "QUERY_CHANGED", query: query.value });
    });
    query.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      e.preventDefault();
      const text = query.value.trim();
      if (text === "") return;
      dispatch({ type: "ACTION", action: { type: "query", text } });
    });

    this.b.bindVisible(emptyRef, (s) => s.selection === null && !s.overlapping);
    this.b.bindVisible(warnRef, (s) => s.overlapping);
    this.b.bindVisible(bodyRef, (s) => s.selection !== null && !s.overlapping);
    this.b.bindText(quoteRef, (s) => s.selection ?? "");
    this.b.bindValue(queryRef, (s) => s.query);
  }

  sync(state: State): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}
