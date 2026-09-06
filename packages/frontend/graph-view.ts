import type { Citation } from "./citation.ts";
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

/** A reference from a saved node's prose back into the transcript, together
 * with the quote it resolves to. A textarea cannot hold a link, so the
 * references are rendered as a row of chips beneath the field instead - a
 * bibliography for the claim rather than inline markup. */
export type Chip = { citation: Citation; quote: string };

/** The chips for the *saved* text of the open selection, not for the draft:
 * a half-typed address is not a citation. */
export type Citations = {
  description: ReadonlyArray<Chip>;
  notes: ReadonlyArray<Chip>;
};

/** Pan in canvas pixels, zoom as a multiplier on the *spacing* between nodes:
 * the node itself is unscaled DOM, so text stays legible at every zoom and
 * zooming out is a way to fit more of the graph rather than to shrink it. */
export type Viewport = { zoom: number; x: number; y: number };

export const IDENTITY_VIEWPORT: Viewport = { zoom: 1, x: 0, y: 0 };
export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 3;

export type State = {
  /** `pending` while the layout simulation is being computed off the render
   * path; the canvas has no positions to draw until it lands. */
  status: "pending" | "ready";
  nodes: ReadonlyArray<GraphNode & { pos: Position }>;
  edges: ReadonlyArray<GraphEdge & { from_: Position; to_: Position }>;
  viewport: Viewport;
  sidebar: Sidebar;
  citations: Citations;
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
  | { type: "DELETE" }
  | { type: "CITATION_CLICKED"; citation: Citation }
  | { type: "PAN"; dx: number; dy: number }
  /** `at` is in canvas pixels, so the point under the cursor stays put. */
  | { type: "ZOOM"; factor: number; at: { x: number; y: number } }
  | { type: "RESET_VIEW" };

/** The canvas is sized in pixels rather than percentages: an edge is a rotated
 * bar, and a bar whose length is a percentage of the width but whose angle is
 * computed in square coordinates would shear on a non-square canvas. */
const WIDTH = 900;
const HEIGHT = 560;
const PAD = 60;

/** How far short of the target's centre an edge stops, so the arrowhead lands
 * on the rim of the pill rather than under it. Constant in screen pixels
 * because the pill does not scale with zoom. */
const BACKOFF = 52;

const px = (pos: Position, vp: Viewport) => ({
  x: vp.x + vp.zoom * (PAD + pos.x * (WIDTH - 2 * PAD)),
  y: vp.y + vp.zoom * (PAD + pos.y * (HEIGHT - 2 * PAD)),
});

const graphClass = cls("graph");
const canvasClass = cls("graph-canvas");
const nodeClass = cls("graph-node");
const edgeClass = cls("graph-edge");
const edgeBarClass = cls("graph-edge-bar");
const edgeLabelClass = cls("graph-edge-label");
const edgeHeadClass = cls("graph-edge-head");
const controlsClass = cls("graph-controls");
const sidebarClass = cls("graph-sidebar");
const emptyClass = cls("graph-empty");
const errorClass = cls("graph-error");
const actionsClass = cls("graph-actions");
const chipsClass = cls("graph-chips");
const chipClass = cls("graph-chip");

mountStyle(`
.${graphClass} {
  display: grid;
  flex: 1;
  min-height: 0;
  overflow: auto;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 1.5rem;
  padding: 1rem;
  align-items: start;
}
/* The canvas keeps its pixel size, so below the width that fits both columns
 * the sidebar drops underneath it rather than squeezing it. */
@media (max-width: ${WIDTH + 340}px) {
  .${graphClass} {
    grid-template-columns: minmax(0, 1fr);
  }
}
.${canvasClass} {
  position: relative;
  width: ${WIDTH}px;
  max-width: 100%;
  touch-action: none;
  cursor: grab;
  height: ${HEIGHT}px;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 0.5rem;
  background: #fcfcfc;
  overflow: hidden;
}
.${canvasClass}:active {
  cursor: grabbing;
}
.${controlsClass} {
  position: absolute;
  right: 0.5rem;
  bottom: 0.5rem;
  display: flex;
  gap: 0.25rem;
  z-index: 2;
}
.${controlsClass} button {
  font: inherit;
  font-size: 0.8rem;
  min-width: 1.9rem;
  padding: 0.1rem 0.4rem;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 0.3rem;
  background: rgba(255, 255, 255, 0.9);
  cursor: pointer;
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
/* Level is the one thing the canvas is meant to show at a glance, so it is
 * carried by four channels at once - fill, border colour, border style and
 * weight - rather than by four shades of the same blue. */
.${nodeClass}[data-level="1"] {
  background: #fbfbfb;
  border: 1px dashed rgba(0, 0, 0, 0.3);
  color: #6b6b6b;
}
.${nodeClass}[data-level="2"] {
  background: #fdf1d8;
  border: 1px solid #d9a441;
}
.${nodeClass}[data-level="3"] {
  background: #dbeafe;
  border: 2px solid #3b74c4;
}
.${nodeClass}[data-level="4"] {
  background: #cdeccd;
  border: 3px double #2f7d32;
  font-weight: 700;
}
.${edgeClass} {
  position: absolute;
}
.${edgeBarClass} {
  position: absolute;
  height: 2px;
  border-radius: 1px;
  transform-origin: 0 50%;
  background: rgba(0, 0, 0, 0.3);
  cursor: pointer;
}
/* A CSS triangle rather than an SVG marker: the edge is already a rotated
 * div, so the head is the same transform with a different shape. */
.${edgeHeadClass} {
  position: absolute;
  width: 0;
  height: 0;
  transform-origin: 0 50%;
  border-left: 9px solid rgba(0, 0, 0, 0.45);
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  margin-top: -5px;
  pointer-events: none;
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
.${edgeClass}[data-selected="true"] .${edgeHeadClass} {
  border-left-color: #f0b429;
}
.${sidebarClass} {
  position: sticky;
  top: 1rem;
  min-width: 18rem;
  padding: 0.75rem;
  border: 1px solid rgba(0, 0, 0, 0.12);
  border-radius: 0.5rem;
  background: #fff;
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
.${chipsClass} {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin: 0.2rem 0 0.4rem;
}
.${chipClass} {
  font: inherit;
  font-size: 0.75rem;
  text-align: left;
  max-width: 100%;
  padding: 0.1rem 0.5rem;
  border: 1px solid rgba(0, 0, 0, 0.15);
  border-radius: 999px;
  background: #fff;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`);

type NodeState = {
  node: GraphNode;
  pos: Position;
  viewport: Viewport;
  selected: boolean;
};

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
      const at = px(s.pos, s.viewport);
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
  viewport: Viewport;
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
    const headRef = ref("edge-head");
    const labelRef = ref("edge-label");
    container.className = edgeClass;
    container.innerHTML = sanitize`
      <div class="${edgeBarClass}" data-ref="${barRef}"></div>
      <div class="${edgeHeadClass}" data-edge-head data-ref="${headRef}"></div>
      <div class="${edgeLabelClass}" data-edge-label data-ref="${labelRef}"></div>
    `;
    this.container = container;
    this.b = new Binder(container, initial);
    container.addEventListener("click", () => dispatch({ type: "CLICKED" }));
    this.b.bindContainerAttr("data-edge", (s) => s.edge.id);
    this.b.bindContainerAttr("data-selected", (s) =>
      s.selected ? "true" : undefined,
    );
    /** Centre to centre, stopped short of the target so the head is visible
     * against the rim of the pill. A pair closer together than the backoff
     * collapses to a stub rather than reversing. */
    const geometry = (s: EdgeState) => {
      const from = px(s.from_, s.viewport);
      const to = px(s.to_, s.viewport);
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const span = Math.hypot(to.x - from.x, to.y - from.y);
      const length = Math.max(span - BACKOFF, span * 0.2);
      return { from, to, angle, length };
    };
    this.b.bindStyle(barRef, (s) => {
      const { from, angle, length } = geometry(s);
      return {
        left: `${from.x}px`,
        top: `${from.y}px`,
        width: `${length}px`,
        transform: `rotate(${angle}rad)`,
      };
    });
    this.b.bindStyle(headRef, (s) => {
      const { from, angle, length } = geometry(s);
      return {
        left: `${from.x + Math.cos(angle) * length}px`,
        top: `${from.y + Math.sin(angle) * length}px`,
        transform: `rotate(${angle}rad)`,
      };
    });
    this.b.bindStyle(labelRef, (s) => {
      const { from, to } = geometry(s);
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

type ChipState = { chip: Chip };
type ChipMsg = { type: "CLICKED" };

/** A citation as a chip beneath the field that cites it, labelled with the
 * quote it points at. A note that says "shaky on framing" is unfalsifiable; one
 * that points at the turn where the user said so is evidence. */
class ChipView implements View<ChipState, ChipMsg> {
  container: HTMLElement;
  private b: Binder<ChipState>;

  constructor(
    container: HTMLElement,
    dispatch: (msg: ChipMsg) => void,
    initial: ChipState,
  ) {
    const labelRef = ref("chip-label");
    container.className = chipClass;
    container.setAttribute("type", "button");
    container.setAttribute("data-citation", "");
    container.innerHTML = sanitize`<span data-ref="${labelRef}"></span>`;
    this.container = container;
    this.b = new Binder(container, initial);
    container.addEventListener("click", () => dispatch({ type: "CLICKED" }));
    this.b.bindText(labelRef, (s) => quoteLabel(s.chip.quote));
    this.b.bindAttr(labelRef, "title", (s) => s.chip.quote);
  }

  sync(state: ChipState): void {
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

/** A chip is one line in a sidebar column, so the quote is squeezed to a
 * recognisable fragment; the full text is on the tooltip. */
const QUOTE_CHARS = 40;
function quoteLabel(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim();
  return flat.length > QUOTE_CHARS ? `${flat.slice(0, QUOTE_CHARS)}…` : flat;
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
    const controlsRef = ref("graph-controls");
    const zoomInRef = ref("graph-zoom-in");
    const zoomOutRef = ref("graph-zoom-out");
    const resetRef = ref("graph-reset-view");
    const edgesRef = ref("graph-edges");
    const emptyRef = ref("graph-empty");
    const pendingRef = ref("graph-pending");
    const sidebarRef = ref("graph-sidebar");
    const closedRef = ref("graph-closed");
    const openRef = ref("graph-open");
    const kindRef = ref("graph-kind");
    const titleRef = ref("graph-title");
    const descriptionRef = ref("graph-description");
    const descriptionChipsRef = ref("graph-description-chips");
    const notesRowRef = ref("graph-notes-row");
    const notesRef = ref("graph-notes");
    const notesChipsRef = ref("graph-notes-chips");
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
        <p class="${emptyClass}" data-ref="${pendingRef}">Laying out the graph…</p>
        <div data-ref="${edgesRef}"></div>
        <div class="${controlsClass}" data-ref="${controlsRef}">
          <button type="button" data-graph-zoom-out data-ref="${zoomOutRef}">−</button>
          <button type="button" data-graph-zoom-in data-ref="${zoomInRef}">+</button>
          <button type="button" data-graph-reset-view data-ref="${resetRef}">reset</button>
        </div>
      </div>
      <div class="${sidebarClass}" data-ref="${sidebarRef}">
        <p data-ref="${closedRef}">Click a node or an edge to edit it.</p>
        <div data-ref="${openRef}">
          <strong data-graph-kind data-ref="${kindRef}"></strong>
          <label>Title<input data-graph-title data-ref="${titleRef}" /></label>
          <label>Description<textarea rows="3" data-graph-description data-ref="${descriptionRef}"></textarea></label>
          <div class="${chipsClass}" data-description-citations data-ref="${descriptionChipsRef}"></div>
          <label data-ref="${notesRowRef}">Notes<textarea rows="3" data-graph-notes data-ref="${notesRef}"></textarea></label>
          <div class="${chipsClass}" data-notes-citations data-ref="${notesChipsRef}"></div>
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
          {
            node,
            pos: node.pos,
            viewport: s.viewport,
            selected: selectedId(s) === node.id,
          },
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
            viewport: s.viewport,
            selected: selectedId(s) === edge.id,
          },
          {},
          () => dispatch({ type: "SELECT_EDGE", id: edge.id }),
        ),
      ),
    );

    const canvas = this.b.ref(canvasRef);
    const controls = this.b.ref(controlsRef);
    /** Zoom is about the cursor, so the concept under the pointer stays under
     * it; the buttons aim at the middle of the canvas instead. */
    const zoomAt = (factor: number, at: { x: number; y: number }) =>
      dispatch({ type: "ZOOM", factor, at });
    const middle = () => ({ x: canvas.clientWidth / 2, y: HEIGHT / 2 });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const box = canvas.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), {
          x: e.clientX - box.left,
          y: e.clientY - box.top,
        });
      },
      { passive: false },
    );
    this.b
      .ref(zoomInRef)
      .addEventListener("click", () => zoomAt(1.25, middle()));
    this.b
      .ref(zoomOutRef)
      .addEventListener("click", () => zoomAt(1 / 1.25, middle()));
    this.b
      .ref(resetRef)
      .addEventListener("click", () => dispatch({ type: "RESET_VIEW" }));

    // Dragging anywhere on the canvas pans, including across a node: a node is
    // opened by a click, and a click is not a drag. The pointer is captured
    // only once the drag passes the threshold, because capturing retargets the
    // click that follows onto the canvas and would eat the selection.
    const THRESHOLD = 4;
    let pointer: number | null = null;
    let captured = false;
    let last = { x: 0, y: 0 };
    let origin = { x: 0, y: 0 };
    canvas.addEventListener("pointerdown", (e) => {
      if (controls.contains(e.target as Node)) return;
      pointer = e.pointerId;
      captured = false;
      last = { x: e.clientX, y: e.clientY };
      origin = last;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (pointer !== e.pointerId) return;
      if (
        !captured &&
        Math.hypot(e.clientX - origin.x, e.clientY - origin.y) < THRESHOLD
      )
        return;
      if (!captured) {
        captured = true;
        canvas.setPointerCapture(e.pointerId);
      }
      dispatch({ type: "PAN", dx: e.clientX - last.x, dy: e.clientY - last.y });
      last = { x: e.clientX, y: e.clientY };
    });
    const endPan = (e: PointerEvent) => {
      if (pointer !== e.pointerId) return;
      pointer = null;
      if (captured) canvas.releasePointerCapture(e.pointerId);
      captured = false;
    };
    canvas.addEventListener("pointerup", endPan);
    canvas.addEventListener("pointercancel", endPan);
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

    const chips = (field: "description" | "notes") => (s: State) =>
      s.citations[field].map((chip) =>
        showKeyed(
          `${chip.citation.thread}:${chip.citation.index}`,
          ChipView,
          { chip },
          {},
          () => dispatch({ type: "CITATION_CLICKED", citation: chip.citation }),
        ),
      );
    this.b.bindList(descriptionChipsRef, "button", chips("description"));
    this.b.bindList(notesChipsRef, "button", chips("notes"));
    this.b.bindVisible(
      descriptionChipsRef,
      (s) => s.citations.description.length > 0,
    );
    this.b.bindVisible(notesChipsRef, (s) => s.citations.notes.length > 0);
    this.b.bindVisible(
      emptyRef,
      (s) => s.status === "ready" && s.nodes.length === 0,
    );
    this.b.bindVisible(pendingRef, (s) => s.status === "pending");
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

/** The viewport reducer, exported so the prototype's dispatch owns the state
 * and the view stays stateless. Zoom is clamped, and the pan is corrected so
 * that the clamped factor still keeps `at` fixed. */
export function panZoom(vp: Viewport, msg: Msg): Viewport {
  switch (msg.type) {
    case "PAN":
      return { ...vp, x: vp.x + msg.dx, y: vp.y + msg.dy };
    case "ZOOM": {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, vp.zoom * msg.factor));
      const factor = zoom / vp.zoom;
      return {
        zoom,
        x: msg.at.x - factor * (msg.at.x - vp.x),
        y: msg.at.y - factor * (msg.at.y - vp.y),
      };
    }
    case "RESET_VIEW":
      return IDENTITY_VIEWPORT;
    default:
      return vp;
  }
}

function selectedId(s: State): string | null {
  return s.sidebar.type === "closed" ? null : s.sidebar.id;
}
