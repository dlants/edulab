/**
 * INVARIANT: All DOM updates must flow through the Binder (bindText, bindClass,
 * bindVisible, bindStyle, bindDisabled, bindAttr, bindContainerAttr,
 * bindChecked, bindSlot, bindList) or through child views composed via
 * show / showKeyed.
 *
 * Do NOT:
 *   - write a renderX(state) helper that sets innerHTML / appendChild /
 *     document.createElement and call it from sync();
 *   - mutate properties (.textContent, .className, .checked, .disabled, .src,
 *     href, style) directly inside a sync-time render function;
 *   - rebuild a list of children imperatively on every sync.
 *
 * Imperative renders bypass the binder, skip updates dispatched from the
 * internal loop, and destroy input focus / scroll / selection state every
 * time sync runs.
 *
 * If the binding primitive you need is missing, ADD A NEW bindX METHOD HERE
 * rather than working around it imperatively.
 *
 * Agent: before writing imperative DOM code in a view, stop and ask the user
 * for explicit confirmation.
 */

// A request is in exactly one of these states; the results/error live inside
// the variant that owns them, so "loaded but no results object" or "error with
// a null message" are not representable. `loading` keeps the previously loaded
// value (`prev`) so a view doesn't flash empty while the next value is fetched.
export type RequestStatus<T> =
  | { status: "idle" }
  | { status: "loading"; prev: T | null }
  | { status: "loaded"; data: T }
  | { status: "error"; error: string };

/** Views should implement this interface to be compatible with Bind. */
export interface View<State, _Message = never, _Ctx = unknown> {
  container: HTMLElement;
  sync(state: State): void;
  destroy(): void;
}

/** Constructor signature for Views. */
type ViewCtor<State, Message = never, Ctx = unknown> = new (
  container: HTMLElement,
  dispatch: (msg: Message) => void,
  initialState: State,
  ctx: Ctx,
) => View<State, Message, Ctx>;

/** Opaque descriptor returned by show(). Pass to bindSlot; do not inspect. */
export type SlotContent = {
  readonly __brand: "SlotContent";
};

/** Opaque descriptor returned by showKeyed(). Pass to bindList; do not inspect. */
export type KeyedSlotContent = {
  readonly __brand: "KeyedSlotContent";
};

interface SlotContentInternal {
  key?: string;
  ctor: ViewCtor<unknown, unknown, unknown>;
  state: unknown;
  ctx: unknown;
  childDispatch: (childMsg: unknown) => void;
}

interface KeyedSlotContentInternal {
  key: string;
  ctor: ViewCtor<unknown, unknown, unknown>;
  state: unknown;
  ctx: unknown;
  childDispatch: (childMsg: unknown) => void;
}

export const noop = () => {};

/**
 * Describes which view to show with which state, without actually mounting anything.
 * The slot reads this descriptor and handles the lifecycle: mount if new, sync if
 * the same view is already shown, or destroy-and-remount if the constructor changed.
 * childDispatch is the dispatch function passed to the child view. Use noop for leaf views.
 * An optional key forces a remount when it changes, even if the view class is the same.
 */
export function show<ChildState, ChildMsg, ChildCtx>(
  ViewClass: ViewCtor<ChildState, ChildMsg, ChildCtx>,
  state: ChildState,
  ctx: ChildCtx,
  childDispatch: (childMsg: ChildMsg) => void,
  key?: string,
): SlotContent {
  return {
    key,
    ctor: ViewClass,
    state,
    ctx,
    childDispatch,
  } as unknown as SlotContent;
}

/**
 * Like show, but uses a key to distinguish identity instead of the ViewClass.
 */
export function showKeyed<ChildState, ChildMsg, ChildCtx>(
  key: string,
  ViewClass: ViewCtor<ChildState, ChildMsg, ChildCtx>,
  state: ChildState,
  ctx: ChildCtx,
  childDispatch: (childMsg: ChildMsg) => void,
): KeyedSlotContent {
  return {
    key,
    ctor: ViewClass,
    state,
    ctx,
    childDispatch,
  } as unknown as KeyedSlotContent;
}

type Binding<State> = (state: State) => void;

/**
 * Manages bindings between state and DOM. Created in a view's constructor after setting innerHTML.
 * On each sync(), all registered bindings re-run with the new state.
 * On cleanup(), all child views are destroyed and bindings are cleared.
 */
export class Binder<State> {
  private bindings: Binding<State>[] = [];
  private container: HTMLElement;
  private cleanups: (() => void)[] = [];

  private state: State;

  constructor(container: HTMLElement, initialState: State) {
    this.container = container;
    this.state = initialState;
  }

  /** Query a single element by its data-ref attribute. Throws if not exactly one match. */
  ref<T extends HTMLElement = HTMLElement>(name: Ref): T {
    const els = this.container.querySelectorAll<T>(`[data-ref="${name}"]`);
    if (els.length !== 1) {
      throw new Error(`ref("${name}"): expected 1 match, found ${els.length}`);
    }
    return els[0];
  }

  sync(state: State): void {
    this.state = state;
    for (const b of this.bindings) b(state);
  }

  cleanup(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.bindings = [];
  }

  /** Bind the text of the element via textContent (for XSS protection) */
  bindText(ref: Ref, fn: (s: State) => string): void {
    const el = this.ref(ref);
    const binding = (s: State) => {
      const next = fn(s);
      const node = el.firstChild;
      // Assigning textContent always builds a fresh text node, which destroys
      // any selection anchored in the old one. Streaming only ever appends, so
      // grow the existing node in place and the user's drag survives the token.
      if (
        el.childNodes.length === 1 &&
        node instanceof Text &&
        next.startsWith(node.data)
      ) {
        if (next.length > node.data.length)
          node.appendData(next.slice(node.data.length));
        return;
      }
      if (el.textContent !== next) el.textContent = next;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  bindClass(refOrEl: Ref | HTMLElement, fn: (s: State) => string): void {
    const el = refOrEl instanceof HTMLElement ? refOrEl : this.ref(refOrEl);
    const binding = (s: State) => {
      const next = fn(s);
      if (el.className !== next) el.className = next;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** show or hide the element via display=none */
  bindVisible(ref: Ref, fn: (s: State) => boolean): void {
    const el = this.ref(ref);
    const binding = (s: State) => {
      const next = fn(s) ? "" : "none";
      if (el.style.display !== next) el.style.display = next;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** Set inline styles on the element via a record. Clears properties removed between syncs. Values containing url( are stripped for safety. */
  bindStyle(ref: Ref, fn: (s: State) => Record<string, string>): void {
    this.styleBinding(this.ref(ref), fn);
  }

  /** bindStyle over the root container element, for a child whose own position
   * is decided by its parent (see graph-view.ts). */
  bindContainerStyle(fn: (s: State) => Record<string, string>): void {
    this.styleBinding(this.container, fn);
  }

  private styleBinding(
    el: HTMLElement,
    fn: (s: State) => Record<string, string>,
  ): void {
    let prevKeys = new Set<string>();
    const binding = (s: State) => {
      const styles = fn(s);
      const nextKeys = new Set<string>();
      for (const [prop, val] of Object.entries(styles)) {
        const next = val.replace(/url\s*\(/gi, "");
        if (el.style.getPropertyValue(prop) !== next)
          el.style.setProperty(prop, next);
        nextKeys.add(prop);
      }
      for (const prop of prevKeys) {
        if (!nextKeys.has(prop)) el.style.removeProperty(prop);
      }
      prevKeys = nextKeys;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** Set the value of an input/textarea/select. Use for inputs whose value is driven by state (e.g. programmatic resets after submit, or syncing a select to the row's current role). */
  bindValue(ref: Ref, fn: (s: State) => string): void {
    const el = this.ref<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >(ref);
    const binding = (s: State) => {
      const v = fn(s);
      // Never clobber an input the user is actively editing — an unrelated
      // re-sync (e.g. an async dispatch elsewhere) would otherwise wipe out
      // an in-progress edit and blow away the caret.
      if (document.activeElement === el) return;
      if (el.value !== v) el.value = v;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  bindChecked(ref: Ref, fn: (s: State) => boolean): void {
    const el = this.ref<HTMLInputElement>(ref);
    const binding = (s: State) => {
      const next = fn(s);
      if (el.checked !== next) el.checked = next;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  bindDisabled(ref: Ref, fn: (s: State) => boolean): void {
    const el = this.ref<
      HTMLButtonElement | HTMLInputElement | HTMLSelectElement
    >(ref);
    const binding = (s: State) => {
      const next = fn(s);
      if (el.disabled !== next) el.disabled = next;
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  bindAttr(ref: Ref, attr: string, fn: (s: State) => string | undefined): void {
    const el = this.ref(ref);
    const binding = (s: State) => {
      const val = fn(s);
      if (val === undefined) el.removeAttribute(attr);
      else if (el.getAttribute(attr) !== val) el.setAttribute(attr, val);
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** Bind an attribute on the root container element (the element passed to the view's constructor). */
  bindContainerAttr(attr: string, fn: (s: State) => string | undefined): void {
    const el = this.container;
    const binding = (s: State) => {
      const val = fn(s);
      if (val === undefined) el.removeAttribute(attr);
      else if (el.getAttribute(attr) !== val) el.setAttribute(attr, val);
    };
    this.bindings.push(binding);
    binding(this.state);
  }

  /** Conditionally mount/unmount a child view. Return show() to mount, undefined to unmount. */
  bindSlot(ref: Ref, fn: (s: State) => SlotContent | undefined): void {
    const el = this.ref(ref);
    let currentCtor: SlotContentInternal["ctor"] | undefined;
    let currentKey: string | undefined;
    let currentView: View<unknown, unknown> | undefined;

    const cleanup = () => {
      if (currentView) {
        currentView.destroy();
        el.innerHTML = "";
        currentView = undefined;
        currentCtor = undefined;
        currentKey = undefined;
      }
    };

    const binding = (s: State) => {
      const result = fn(s);
      const content = result as unknown as SlotContentInternal | undefined;
      if (!content) {
        cleanup();
      } else if (content.ctor !== currentCtor || content.key !== currentKey) {
        cleanup();
        currentView = new content.ctor(
          el,
          content.childDispatch,
          content.state,
          content.ctx,
        );
        currentCtor = content.ctor;
        currentKey = content.key;
      } else {
        currentView?.sync(content.state as State);
      }
    };
    this.bindings.push(binding);
    binding(this.state);

    this.cleanups.push(cleanup);
  }

  /** Keyed list reconciliation. Maps an array of showKeyed() descriptors to child views. */
  bindList(
    ref: Ref,
    childTag: string,
    fn: (s: State) => KeyedSlotContent[],
  ): void {
    const el = this.ref(ref);
    const children = new Map<
      string,
      {
        view: View<unknown>;
        ctor: ViewCtor<unknown, unknown, unknown>;
        el: HTMLElement;
      }
    >();

    const cleanup = () => {
      for (const [, child] of children) child.view.destroy();
      children.clear();
      el.innerHTML = "";
    };

    const binding = (s: State) => {
      const items = fn(s) as unknown as KeyedSlotContentInternal[];
      const nextKeys = new Set<string>();

      for (const item of items) {
        nextKeys.add(item.key);
        let child = children.get(item.key);

        if (child && child.ctor !== item.ctor) {
          child.view.destroy();
          child.el.innerHTML = "";
          const newView = new item.ctor(
            child.el,
            item.childDispatch,
            item.state,
            item.ctx,
          );
          child.view = newView;
          child.ctor = item.ctor;
        } else if (!child) {
          const childEl = document.createElement(childTag);
          const view = new item.ctor(
            childEl,
            item.childDispatch,
            item.state,
            item.ctx,
          );
          child = { view, ctor: item.ctor, el: childEl };
          children.set(item.key, child);
        }

        child.view.sync(item.state);
      }

      for (const [key, child] of children) {
        if (!nextKeys.has(key)) {
          child.el.remove();
          child.view.destroy();
          children.delete(key);
        }
      }

      // Reorder with the minimum number of DOM moves. An element can stay put
      // iff it participates in the longest common subsequence of current-order
      // vs target-order (distinct keys ⇒ LIS of current DOM indices read in
      // target order). Everything else — including freshly-created children,
      // which have no current position — must be inserted.
      //
      // Avoiding spurious appendChild calls matters because moving an element
      // (or an ancestor of a focused input) blurs focus on the input.
      const elToDomIndex = new Map<HTMLElement, number>();
      for (let i = 0; i < el.children.length; i++) {
        elToDomIndex.set(el.children[i] as HTMLElement, i);
      }
      const targetDomIndex: number[] = items.map((item) => {
        const child = children.get(item.key);
        return child ? (elToDomIndex.get(child.el) ?? -1) : -1;
      });
      const inLis = computeLisMask(targetDomIndex);

      let anchor: Node | null = null;
      for (let i = items.length - 1; i >= 0; i--) {
        const child = children.get(items[i].key);
        if (!child) continue;
        if (inLis[i]) {
          anchor = child.el;
        } else {
          el.insertBefore(child.el, anchor);
          anchor = child.el;
        }
      }
    };
    this.bindings.push(binding);
    binding(this.state);

    this.cleanups.push(cleanup);
  }
}

/**
 * Given an array of indices, return a boolean mask marking entries that
 * participate in one longest increasing subsequence. Entries with value < 0
 * are treated as sentinels for "not currently in DOM" and are never marked.
 * O(n log n) via patience sorting with predecessor links.
 */
function computeLisMask(arr: number[]): boolean[] {
  const n = arr.length;
  const mask = new Array<boolean>(n).fill(false);
  if (n === 0) return mask;

  // tails[k] = index into arr of the smallest tail of an increasing
  // subsequence of length k+1 seen so far.
  const tails: number[] = [];
  const prev: (number | null)[] = new Array(n).fill(null);

  for (let i = 0; i < n; i++) {
    const v = arr[i];
    if (v < 0) continue;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[tails[mid]] < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }

  let k: number | null = tails.length > 0 ? tails[tails.length - 1] : null;
  while (k !== null) {
    mask[k] = true;
    k = prev[k];
  }
  return mask;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Wrapper marking a string as already-safe, hand-authored HTML that must be
 * injected verbatim (not escaped) by `sanitize`. ONLY ever construct this from
 * static, trusted constants (e.g. the inline-SVG icons in `icons.ts`) — never
 * from user data, or you reintroduce an XSS hole.
 */
export class RawHtml {
  readonly html: string;
  constructor(html: string) {
    this.html = html;
  }
}

/** Mark a trusted, static HTML string for raw (unescaped) injection. */
export function raw(html: string): RawHtml {
  return new RawHtml(html);
}

/**
 * Tagged template that HTML-escapes all interpolated values. Use for all
 * innerHTML assignments. Values wrapped in `RawHtml` (via `raw()`) pass through
 * unescaped — reserved for trusted static markup such as inline-SVG icons.
 */
export function sanitize(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  return strings.reduce(
    (out, str, i) =>
      out +
      str +
      (i < values.length
        ? values[i] instanceof RawHtml
          ? (values[i] as RawHtml).html
          : escapeHtml(String(values[i]))
        : ""),
    "",
  );
}

/**
 * A typed post-render event bus.
 *
 * Bridges the reducer phase and the DOM phase of a dispatch loop. Reducers
 * (which must never touch the DOM) `emit` events while handling a message; the
 * root loop calls `flush` after the view has synced, delivering each queued
 * event to every currently-subscribed view. Subscribed views do the imperative
 * DOM work (scroll, focus, measure) scoped to their own container/refs.
 *
 * Generic over an app-supplied event union.
 */
export class PostRenderEventBus<Event> {
  private queue: Event[] = [];
  private subscribers = new Set<(event: Event) => void>();

  /** Queue an event during a dispatch. Called from the reducer side. */
  emit(event: Event): void {
    this.queue.push(event);
  }

  /** Register a listener. Returns an unsubscribe function for use in destroy(). */
  subscribe(handler: (event: Event) => void): () => void {
    this.subscribers.add(handler);
    return () => {
      this.subscribers.delete(handler);
    };
  }

  /**
   * Deliver all queued events to the current subscribers, then clear the queue.
   * Called by the root loop after the view is synced.
   */
  flush(): void {
    if (this.queue.length === 0) return;
    const events = this.queue;
    this.queue = [];
    for (const event of events) {
      for (const handler of this.subscribers) {
        handler(event);
      }
    }
  }
}

/** Branded string type for data-ref names. Prevents accidental use of raw strings in binder methods. */
export type Ref = string & { readonly __brand: "Ref" };

let refCounter = 0;

/** Generate a unique data-ref name. Use in templates and binder methods to avoid cross-view collisions. */
export function ref(prefix: string): Ref {
  return `${prefix}_${refCounter++}` as Ref;
}

let clsCounter = 0;

/** Generate a unique CSS class name. Avoids style collisions between components. */
export function cls(prefix: string): string {
  return `${prefix}_${clsCounter++}`;
}

/**
 * Smoothly scroll an element into view. This is a layout side effect (no DOM
 * creation), so it is the one sanctioned imperative touch — drive it from a
 * post-render subscriber via a `ref`, never from a `sync`-time render.
 */
export function scrollIntoView(el: HTMLElement): void {
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Inject a raw CSS string into the page via a <style> tag. */
export function mountStyle(css: string): void {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
}
