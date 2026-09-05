import type { Message } from "./conversation.ts";
import {
  Binder,
  cls,
  mountStyle,
  noop,
  type Ref,
  ref,
  sanitize,
  showKeyed,
  type View,
} from "./vamp.ts";

export type State = {
  messages: ReadonlyArray<Message>;
  inFlight: boolean;
  draft: string;
};

export type Msg = { type: "DRAFT_CHANGED"; draft: string } | { type: "SUBMIT" };

const appClass = cls("app");
const transcriptClass = cls("transcript");
const messageClass = cls("message");
const roleClass = cls("role");
const composerClass = cls("composer");

mountStyle(`
.${appClass} {
  font-family: system-ui, sans-serif;
  max-width: 44rem;
  margin: 0 auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
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

class MessageView implements View<Message> {
  container: HTMLElement;
  private b: Binder<Message>;

  constructor(
    container: HTMLElement,
    _dispatch: (msg: never) => void,
    initial: Message,
  ) {
    const roleRef = ref("role");
    const textRef = ref("text");
    container.className = messageClass;
    container.innerHTML = sanitize`
      <span class="${roleClass}" data-ref="${roleRef}"></span>
      <span data-ref="${textRef}"></span>
    `;
    this.container = container;
    this.b = new Binder(container, initial);
    this.b.bindText(roleRef, (m) => m.role);
    this.b.bindText(textRef, (m) => m.text);
    this.b.bindContainerAttr("data-role", (m) => m.role);
  }

  sync(state: Message): void {
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

    container.className = appClass;
    container.innerHTML = sanitize`
      <ul class="${transcriptClass}" data-ref="${transcriptRef}"></ul>
      <div class="${composerClass}">
        <textarea data-ref="${inputRef}" rows="2" placeholder="Ask something…"></textarea>
        <button type="button" data-ref="${sendRef}">Send</button>
      </div>
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

    // The transcript is append-only and never reorders, so the position of a
    // message is a stable identity.
    this.b.bindList(transcriptRef, "li", (s) =>
      s.messages.map((message, i) =>
        showKeyed(String(i), MessageView, message, {}, noop),
      ),
    );
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
