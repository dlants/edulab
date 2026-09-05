import { KnowledgeGraph } from "../graph.ts";
import { readTools } from "../graph-tools.ts";
import { actionLabel } from "../prompt.ts";
import { selectedSample, selectSample } from "../samples/index.ts";
import { anchorText, overlaps, type ThreadId } from "../selection.ts";
import { Thread } from "../thread.ts";
import { ThreadTree } from "../threads.ts";
import { AppView, type Msg, type State } from "../view.ts";

function connect(): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${window.location.host}/api/socket`);
}

/** Prototype 1: the task transcript, with learning threads hanging off the
 * passages the user picks out of it. */
export function mount(container: HTMLElement): void {
  // One socket for the whole app: every Thread adds its own
  // listener and drops frames whose requestId it does not own, so streams
  // interleave over the single connection.
  const socket = connect();
  // Scoped to the user, not to a thread: it outlives every thread in the tree
  // and is discarded only by a page load.
  const graph = new KnowledgeGraph();
  const tree = new ThreadTree(
    socket,
    new Thread(socket, { initialTurns: selectedSample()?.turns }),
    () => {
      refresh();
      view.sync(state);
    },
  );
  // The thread on the left. Moved only by the arrows.
  let focus = tree.root;

  const state: State = {
    sample: selectedSample()?.id ?? "",
    messages: [],
    inFlight: false,
    draft: "",
    split: false,
    depth: 0,
    canDescend: false,
    thread: focus,
    marks: [],
    activeMark: null,
    anchor: null,
    query: "",
    origin: null,
    child: null,
  };

  /** Re-projects the tree onto the view's state. Everything but the fields the
   * user is editing is derived, so this runs after every dispatch. */
  function refresh(): void {
    const node = tree.get(focus);
    state.thread = focus;
    state.depth = state.split ? tree.path(focus).length : 0;
    state.canDescend = node.activeChild !== null;
    state.messages = node.thread.messages;
    state.inFlight = node.thread.inFlight;
    state.draft = node.draft;
    state.marks = tree.marks(focus);
    const own = node.origin;
    state.origin = own
      ? {
          action: actionLabel(own.action),
          quote: anchorText(
            own.anchor,
            tree.get(own.anchor.thread).thread.messages,
          ),
        }
      : null;
    state.activeMark = node.activeChild;
    const activeChild = node.activeChild;
    if (!activeChild) {
      state.child = null;
      return;
    }
    const child = tree.get(activeChild);
    const origin = child.origin;
    state.child = {
      action: origin ? actionLabel(origin.action) : "",
      messages: child.thread.messages,
      inFlight: child.thread.inFlight,
      draft: child.draft,
    };
  }

  function send(id: ThreadId): void {
    const node = tree.get(id);
    const text = node.draft.trim();
    if (text === "" || node.thread.inFlight) return;
    node.draft = "";
    node.thread.send(text).then(undefined, (e: unknown) => {
      console.error(e);
    });
  }

  function update(state: State, msg: Msg): void {
    const node = tree.get(focus);
    switch (msg.type) {
      case "DRAFT_CHANGED":
        node.draft = msg.draft;
        break;
      case "SAMPLE_CHANGED":
        selectSample(msg.id === "" ? undefined : msg.id);
        break;
      case "SUBMIT":
        send(focus);
        break;
      case "GO_DEEPER": {
        if (!state.split) {
          state.split = true;
          break;
        }
        const child = node.activeChild;
        if (!child) break;
        focus = child;
        state.anchor = null;
        state.query = "";
        break;
      }
      case "GO_BACK": {
        const parent = node.origin?.anchor.thread;
        if (parent === undefined) state.split = false;
        else focus = parent;
        state.anchor = null;
        state.query = "";
        break;
      }
      case "SELECTION_CHANGED":
        state.anchor = msg.anchor;
        node.activeChild = null;
        break;
      case "MARK_CLICKED":
        state.anchor = null;
        node.activeChild = msg.thread;
        break;
      case "LEARNING_MSG":
        switch (msg.msg.type) {
          case "ACTION": {
            const anchor = state.anchor;
            if (!anchor || overlaps(state.marks, anchor)) break;
            const id = tree.open(anchor, msg.msg.action, {
              tools: readTools(graph),
              graph: graph.render(),
            });
            state.anchor = null;
            state.query = "";
            tree
              .get(id)
              .thread.start()
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
        const activeChild = node.activeChild;
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
