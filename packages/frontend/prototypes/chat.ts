import { Conversation } from "../conversation.ts";
import type { Action } from "../prompt.ts";
import { selectedSample } from "../samples/index.ts";
import type { Mark, ThreadId } from "../selection.ts";
import { overlaps } from "../selection.ts";
import { AppView, type Msg, type State } from "../view.ts";

function connect(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/socket`);
}

/** Prototype 1: the plain task-mode transcript. The review affordances get
 * layered on top of this one. */
export function mount(container: HTMLElement): void {
  const conversation = new Conversation(connect(), {
    initialTurns: selectedSample()?.turns,
  });
  // Stage 3 replaces this with a ThreadTree; for now a committed mark is just
  // a passage plus the action taken on it, and the "thread" it opens is a
  // placeholder id that nothing streams into yet.
  const commits: Array<Mark & { action: Action }> = [];
  const root = "root" as ThreadId;

  const state: State = {
    messages: conversation.messages,
    inFlight: false,
    draft: "",
    mode: "task",
    thread: root,
    marks: commits,
    activeMark: null,
    anchor: null,
    query: "",
    pending: null,
  };

  function update(state: State, msg: Msg): void {
    switch (msg.type) {
      case "DRAFT_CHANGED":
        state.draft = msg.draft;
        break;
      case "SUBMIT": {
        const text = state.draft.trim();
        if (text === "" || conversation.inFlight) break;
        state.draft = "";
        conversation.send(text).then(undefined, (e: unknown) => {
          console.error(e);
        });
        break;
      }
      case "MODE_TOGGLED":
        state.mode = state.mode === "task" ? "learning" : "task";
        break;
      case "SELECTION_CHANGED":
        state.anchor = msg.anchor;
        state.activeMark = null;
        state.pending = null;
        break;
      case "MARK_CLICKED": {
        const mark = commits.find((c) => c.thread === msg.thread);
        if (!mark) break;
        state.anchor = null;
        state.activeMark = mark.thread;
        state.pending = mark.action;
        break;
      }
      case "LEARNING_MSG":
        switch (msg.msg.type) {
          case "ACTION": {
            const anchor = state.anchor;
            if (!anchor || overlaps(commits, anchor)) break;
            const thread = `t${commits.length + 1}` as ThreadId;
            commits.push({ thread, anchor, action: msg.msg.action });
            state.anchor = null;
            state.activeMark = thread;
            state.pending = msg.msg.action;
            state.query = "";
            break;
          }
          case "QUERY_CHANGED":
            state.query = msg.msg.query;
            break;
        }
        break;
    }
    state.messages = conversation.messages;
    state.inFlight = conversation.inFlight;
  }

  let dispatching = false;
  function dispatch(msg: Msg): void {
    if (dispatching) throw new Error("dispatch-in-dispatch");
    dispatching = true;
    update(state, msg);
    view.sync(state);
    dispatching = false;
  }

  const view = new AppView(container, dispatch, state);

  conversation.onChange = () => {
    state.messages = conversation.messages;
    state.inFlight = conversation.inFlight;
    view.sync(state);
  };
}
