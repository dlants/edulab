import { Conversation } from "./conversation.ts";
import { AppView, type Msg, type State } from "./view.ts";

function connect(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/socket`);
}

const conversation = new Conversation(connect());

const state: State = { messages: [], inFlight: false, draft: "" };

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

const root = document.getElementById("app") ?? document.body;
const view = new AppView(root, dispatch, state);

conversation.onChange = () => {
  state.messages = conversation.messages;
  state.inFlight = conversation.inFlight;
  view.sync(state);
};
