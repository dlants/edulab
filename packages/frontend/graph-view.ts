import type { EdgeId, GraphEdge, GraphNode, Level, NodeId } from "./graph.ts";
import { LEVELS } from "./graph.ts";
import type { Position } from "./layout.ts";
import {
  Binder,
  cls,
  mountStyle,
  ref,
  sanitize,
  showKeyed,
  type View,
} from "./vamp.ts";

/** The sidebar is a small state machine: nothing selected, or a selection
 * together with the draft being edited. There is no state in which something
 * is selected and there is no draft, so the two are one field. */
export type Sidebar =
  | { type: "closed" }
  | {
      type: "node";
      id: NodeId;
      draft: Omit<GraphNode, "id">;
      error: string | null;
    }
  | {
      type: "edge";
      id: EdgeId;
      draft: Omit<GraphEdge, "id">;
      error: string | null;
    };

export type State = {
  nodes: ReadonlyArray<GraphNode & { pos: Position }>;
  edges: ReadonlyArray<GraphEdge & { from_: Position; to_: Position }>;
  sidebar: Sidebar;
};

/** `field` is keyed off what is open, so a message for the wrong kind of
 * selection does not typecheck. */
export type Msg =
  | { type: "SELECT_NODE"; id: NodeId }
  | { type: "SELECT_EDGE"; id: EdgeId }
  | { type: "CLOSE" }
  | {
      type: "NODE_FIELD";
      field: "title" | "description" | "notes";
      value: string;
    }
  | { type: "LEVEL_CHANGED"; level: Level }
  | { type: "EDGE_FIELD"; field: "title" | "description"; value: string }
  | { type: "SAVE" }
  | { type: "DELETE" };

/** The canvas is sized in pixels rather than percentages: an edge is a rotated
 * bar, and a bar whose length is a percentage of the width but whose angle is
 * computed in square coordinates would shear on a non-square canvas. */
const WIDTH = 900;
const HEIGHT = 560;
const PAD = 60;

const px = (pos: Position) => ({
  x: PAD + pos.x * (WIDTH - 2 * PAD),
  y: PAD + pos.y * (HEIGHT - 2 * PAD),
});

const graphClass = cls("graph");
const canvasClass = cls("graph-canvas");
const nodeClass = cls("graph-node");
const edgeClass = cls("graph-edge");
const edgeBarClass = cls("graph-edge-bar");
const edgeLabelClass = cls("graph-edge-label");
const sidebarClass = cls("graph-sidebar");
const emptyClass = cls("graph-empty");
const errorClass = cls("graph-error");
const actionsClass = cls("graph-actions");

mountStyle(`
.${graphClass} {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 20rem;
  gap: 1.5rem;
  padding: 1rem;
  align-items: start;
}
.${canvasClass} {
  position: relative;
  width: ${WIDTH}px;
  height: ${HEIGHT}px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 0.5rem;
  background: #fcfcfc;
  overflow: hidden;
}
.${emptyClass} {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  font-style: italic;
}
.${nodeClass} {
  position: absolute;
  transform: translate(-50%, -50%);
  max-width: 9rem;
  padding: 0.3rem 0.6rem;
  border: 1px solid rgba(0, 0, 0, 0.25);
  border-radius: 999px;
  background: #fff;
  font-size: 0.8rem;
  text-align: center;
  cursor: pointer;
  z-index: 1;
}
.${nodeClass}[data-selected="true"] {
  box-shadow: 0 0 0 2px #f0b429;
}
.${nodeClass}[data-level="1"] { background: #f4f4f4; }
.${nodeClass}[data-level="2"] { background: #e8f0fb; }
.${nodeClass}[data-level="3"] { background: #d3e5fb; }
.${nodeClass}[data-level="4"] { background: #b8d8f8; }
.${edgeClass} {
  position: absolute;
}
.${edgeBarClass} {
  position: absolute;
  height: 2px;
  transform-origin: 0 50%;
  background: rgba(0, 0, 0, 0.3);
  cursor: pointer;
}
.${edgeLabelClass} {
  position: absolute;
  transform: translate(-50%, -50%);
  font-size: 0.7rem;
  padding: 0 0.2rem;
  background: #fcfcfc;
  cursor: pointer;
  white-space: nowrap;
}
.${edgeClass}[data-selected="true"] .${edgeBarClass} {
  background: #f0b429;
}
.${sidebarClass} {
  position: sticky;
  top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-size: 0.9rem;
}
.${sidebarClass} input,
.${sidebarClass} textarea,
.${sidebarClass} select {
  font: inherit;
  width: 100%;
  padding: 0.3rem;
  box-sizing: border-box;
}
.${actionsClass} {
  display: flex;
  gap: 0.5rem;
}
.${actionsClass} button {
  font: inherit;
}
.${errorClass} {
  color: #b00020;
}
`);

type NodeState = { node: GraphNode; pos: Position; selected: boolean };

class NodeView implements View<NodeState, { type: "CLICKED" }> {
  container: HTMLElement;
  private b: Binder<NodeState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: { type: "CLICKED" }) => void,
    initial: NodeState,
  ) {
    const titleRef = ref("node-title");
    container.className = nodeClass;
    container.innerHTML = sanitize`<span data-node-title data-ref="${titleRef}"></span>`;
    this.container = container;
    this.b = new Binder(container, initial);
    container.addEventListener("click", () => dispatch({ type: "CLICKED" }));
    this.b.bindContainerStyle((s) => {
      const at = px(s.pos);
      return { left: `${at.x}px`, top: `${at.y}px` };
    });
    this.b.bindContainerAttr("data-node", (s) => s.node.id);
    this.b.bindContainerAttr("data-level", (s) => String(s.node.level));
    this.b.bindContainerAttr("data-selected", (s) =>
      s.selected ? "true" : undefined,
    );
    this.b.bindText(titleRef, (s) => s.node.title);
  }

  sync(state: NodeState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

type EdgeState = {
  edge: GraphEdge;
  from_: Position;
  to_: Position;
  selected: boolean;
};

/** A rotated div rather than SVG: bindList builds children with
 * createElement and Binder.ref is typed to HTMLElement, so an SVG layer would
 * mean imperative DOM or widening vamp. Straight lines are all we need. */
class EdgeView implements View<EdgeState, { type: "CLICKED" }> {
  container: HTMLElement;
  private b: Binder<EdgeState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: { type: "CLICKED" }) => void,
    initial: EdgeState,
  ) {
    const barRef = ref("edge-bar");
    const labelRef = ref("edge-label");
    container.className = edgeClass;
    container.innerHTML = sanitize`
      <div class="${edgeBarClass}" data-ref="${barRef}"></div>
      <div class="${edgeLabelClass}" data-edge-label data-ref="${labelRef}"></div>
    `;
    this.container = container;
    this.b = new Binder(container, initial);
    container.addEventListener("click", () => dispatch({ type: "CLICKED" }));
    this.b.bindContainerAttr("data-edge", (s) => s.edge.id);
    this.b.bindContainerAttr("data-selected", (s) =>
      s.selected ? "true" : undefined,
    );
    this.b.bindStyle(barRef, (s) => {
      const from = px(s.from_);
      const to = px(s.to_);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      return {
        left: `${from.x}px`,
        top: `${from.y}px`,
        width: `${Math.hypot(to.x - from.x, to.y - from.y)}px`,
        transform: `rotate(${angle}rad)`,
      };
    });
    this.b.bindStyle(labelRef, (s) => {
      const from = px(s.from_);
      const to = px(s.to_);
      return {
        left: `${(from.x + to.x) / 2}px`,
        top: `${(from.y + to.y) / 2}px`,
      };
    });
    this.b.bindText(labelRef, (s) => s.edge.title);
  }

  sync(state: EdgeState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

export class GraphView implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initial: State,
  ) {
    const canvasRef = ref("graph-canvas");
    const edgesRef = ref("graph-edges");
    const emptyRef = ref("graph-empty");
    const sidebarRef = ref("graph-sidebar");
    const closedRef = ref("graph-closed");
    const openRef = ref("graph-open");
    const kindRef = ref("graph-kind");
    const titleRef = ref("graph-title");
    const descriptionRef = ref("graph-description");
    const notesRowRef = ref("graph-notes-row");
    const notesRef = ref("graph-notes");
    const levelRowRef = ref("graph-level-row");
    const levelRef = ref("graph-level");
    const errorRef = ref("graph-error");
    const saveRef = ref("graph-save");
    const deleteRef = ref("graph-delete");
    const closeRef = ref("graph-close");

    container.className = graphClass;
    container.innerHTML = sanitize`
      <div class="${canvasClass}" data-graph-canvas data-ref="${canvasRef}">
        <p class="${emptyClass}" data-ref="${emptyRef}">Nothing here yet.</p>
        <div data-ref="${edgesRef}"></div>
      </div>
      <div class="${sidebarClass}" data-ref="${sidebarRef}">
        <p data-ref="${closedRef}">Click a node or an edge to edit it.</p>
        <div data-ref="${openRef}">
          <strong data-graph-kind data-ref="${kindRef}"></strong>
          <label>Title<input data-graph-title data-ref="${titleRef}" /></label>
          <label>Description<textarea rows="3" data-graph-description data-ref="${descriptionRef}"></textarea></label>
          <label data-ref="${notesRowRef}">Notes<textarea rows="3" data-graph-notes data-ref="${notesRef}"></textarea></label>
          <label data-ref="${levelRowRef}">Understanding<select data-graph-level data-ref="${levelRef}"></select></label>
          <p class="${errorClass}" data-graph-error data-ref="${errorRef}"></p>
          <div class="${actionsClass}">
            <button type="button" data-ref="${saveRef}">Save</button>
            <button type="button" data-ref="${deleteRef}">Delete</button>
            <button type="button" data-ref="${closeRef}">Close</button>
          </div>
        </div>
      </div>
    `;
    this.container = container;
    this.b = new Binder(container, initial);

    this.b.bindList(canvasRef, "div", (s) =>
      s.nodes.map((node) =>
        showKeyed(
          node.id,
          NodeView,
          { node, pos: node.pos, selected: selectedId(s) === node.id },
          {},
          () => dispatch({ type: "SELECT_NODE", id: node.id }),
        ),
      ),
    );
    this.b.bindList(edgesRef, "div", (s) =>
      s.edges.map((edge) =>
        showKeyed(
          edge.id,
          EdgeView,
          {
            edge,
            from_: edge.from_,
            to_: edge.to_,
            selected: selectedId(s) === edge.id,
          },
          {},
          () => dispatch({ type: "SELECT_EDGE", id: edge.id }),
        ),
      ),
    );

    const level = this.b.ref<HTMLSelectElement>(levelRef);
    LEVELS.forEach((label, i) => {
      const option = document.createElement("option");
      option.value = String(i + 1);
      option.textContent = `${i + 1} ${label}`;
      level.append(option);
    });
    level.addEventListener("change", () =>
      dispatch({
        type: "LEVEL_CHANGED",
        level: Number(level.value) as Level,
      }),
    );

    const title = this.b.ref<HTMLInputElement>(titleRef);
    const description = this.b.ref<HTMLTextAreaElement>(descriptionRef);
    const notes = this.b.ref<HTMLTextAreaElement>(notesRef);
    let current = initial;
    const edit = (
      field: "title" | "description" | "notes",
      value: string,
    ): void => {
      if (current.sidebar.type === "node")
        dispatch({ type: "NODE_FIELD", field, value });
      else if (current.sidebar.type === "edge" && field !== "notes")
        dispatch({ type: "EDGE_FIELD", field, value });
    };
    title.addEventListener("input", () => edit("title", title.value));
    description.addEventListener("input", () =>
      edit("description", description.value),
    );
    notes.addEventListener("input", () => edit("notes", notes.value));
    this.syncCurrent = (s: State) => {
      current = s;
    };

    this.b
      .ref(saveRef)
      .addEventListener("click", () => dispatch({ type: "SAVE" }));
    this.b
      .ref(deleteRef)
      .addEventListener("click", () => dispatch({ type: "DELETE" }));
    this.b
      .ref(closeRef)
      .addEventListener("click", () => dispatch({ type: "CLOSE" }));

    this.b.bindVisible(emptyRef, (s) => s.nodes.length === 0);
    this.b.bindVisible(closedRef, (s) => s.sidebar.type === "closed");
    this.b.bindVisible(openRef, (s) => s.sidebar.type !== "closed");
    this.b.bindVisible(notesRowRef, (s) => s.sidebar.type === "node");
    this.b.bindVisible(levelRowRef, (s) => s.sidebar.type === "node");
    this.b.bindText(kindRef, (s) =>
      s.sidebar.type === "closed" ? "" : `${s.sidebar.type} ${s.sidebar.id}`,
    );
    this.b.bindValue(titleRef, (s) =>
      s.sidebar.type === "closed" ? "" : s.sidebar.draft.title,
    );
    this.b.bindValue(descriptionRef, (s) =>
      s.sidebar.type === "closed" ? "" : s.sidebar.draft.description,
    );
    this.b.bindValue(notesRef, (s) =>
      s.sidebar.type === "node" ? s.sidebar.draft.notes : "",
    );
    this.b.bindValue(levelRef, (s) =>
      s.sidebar.type === "node" ? String(s.sidebar.draft.level) : "1",
    );
    this.b.bindText(errorRef, (s) =>
      s.sidebar.type === "closed" ? "" : (s.sidebar.error ?? ""),
    );
    this.b.bindVisible(errorRef, (s) =>
      s.sidebar.type === "closed" ? false : s.sidebar.error !== null,
    );
  }

  private syncCurrent: (s: State) => void;

  sync(state: State): void {
    this.syncCurrent(state);
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

function selectedId(s: State): string | null {
  return s.sidebar.type === "closed" ? null : s.sidebar.id;
}
