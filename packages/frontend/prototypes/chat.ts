import { Conversation } from "../conversation.ts";
import { selectedSample } from "../samples/index.ts";
import { anchorText, overlaps, type ThreadId } from "../selection.ts";
import { ThreadTree } from "../threads.ts";
import { AppView, type Msg, type State } from "../view.ts";

function connect(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/socket`);
}

/** Prototype 1: the task transcript, with learning threads hanging off the
 * passages the user picks out of it. */
export function mount(container: HTMLElement): void {
  // One socket for the whole app: every thread's Conversation adds its own
  // listener and drops frames whose requestId it does not own, so streams
  // interleave over the single connection.
  const socket = connect();
  const tree = new ThreadTree(
    socket,
    new Conversation(socket, { initialTurns: selectedSample()?.turns }),
    () => {
      refresh();
      view.sync(state);
    },
  );
  const focus = tree.root;

  const state: State = {
    messages: [],
    inFlight: false,
    draft: "",
    mode: "task",
    thread: focus,
    marks: [],
    activeMark: null,
    anchor: null,
    query: "",
    child: null,
  };

  /** Re-projects the tree onto the view's state. Everything but the fields the
   * user is editing is derived, so this runs after every dispatch. */
  function refresh(): void {
    const thread = tree.get(focus);
    state.messages = thread.conversation.messages;
    state.inFlight = thread.conversation.inFlight;
    state.draft = thread.draft;
    state.marks = tree.marks(focus);
    state.activeMark = thread.activeChild;
    const activeChild = thread.activeChild;
    if (!activeChild) {
      state.child = null;
      return;
    }
    const child = tree.get(activeChild);
    const origin = child.origin;
    state.child = {
      quote: origin ? anchorText(origin.anchor, state.messages) : "",
      messages: child.conversation.messages,
      inFlight: child.conversation.inFlight,
      draft: child.draft,
    };
  }

  function send(id: ThreadId): void {
    const thread = tree.get(id);
    const text = thread.draft.trim();
    if (text === "" || thread.conversation.inFlight) return;
    thread.draft = "";
    thread.conversation.send(text).then(undefined, (e: unknown) => {
      console.error(e);
    });
  }

  function update(state: State, msg: Msg): void {
    const thread = tree.get(focus);
    switch (msg.type) {
      case "DRAFT_CHANGED":
        thread.draft = msg.draft;
        break;
      case "SUBMIT":
        send(focus);
        break;
      case "MODE_TOGGLED":
        state.mode = state.mode === "task" ? "learning" : "task";
        break;
      case "SELECTION_CHANGED":
        state.anchor = msg.anchor;
        thread.activeChild = null;
        break;
      case "MARK_CLICKED":
        state.anchor = null;
        thread.activeChild = msg.thread;
        break;
      case "LEARNING_MSG":
        switch (msg.msg.type) {
          case "ACTION": {
            const anchor = state.anchor;
            if (!anchor || overlaps(state.marks, anchor)) break;
            const id = tree.open(anchor, msg.msg.action);
            state.anchor = null;
            state.query = "";
            tree
              .get(id)
              .conversation.start()
              .then(undefined, (e: unknown) => {
                console.error(e);
              });
            break;
          }
          case "QUERY_CHANGED":
            state.query = msg.msg.query;
            break;
        }
        break;
      case "CHILD_MSG": {
        const activeChild = thread.activeChild;
        if (!activeChild) break;
        switch (msg.msg.type) {
          case "DRAFT_CHANGED":
            tree.get(activeChild).draft = msg.msg.draft;
            break;
          case "SUBMIT":
            send(activeChild);
            break;
        }
        break;
      }
    }
    refresh();
  }

  let dispatching = false;
  function dispatch(msg: Msg): void {
    if (dispatching) throw new Error("dispatch-in-dispatch");
    dispatching = true;
    update(state, msg);
    view.sync(state);
    dispatching = false;
  }

  refresh();
  const view = new AppView(container, dispatch, state);
}
