---
name: vamp
description: Vamp frontend coding pattern. Use when writing or modifying frontend views, components, state management, or routing.
---

Vamp is a coding pattern — a repeating, predictable structure for organizing frontend code that is transparent, consistent and debuggable.

# Basic Example

A complete counter page showing all the parts:

```typescript
import { Binder, cls, mountStyle, ref, show, type View } from "./vamp.js";

// Start by defining the state machine, with explicit transitions.
interface State {
  count: number;
  loading: boolean;
}

type Msg =
  | { type: "INCREMENT" }
  | { type: "DECREMENT" }
  | { type: "SAVE"; count: number }
  | { type: "SAVE_DONE" }
  | { type: "SAVE_ERROR"; error: string };

// Mutate state and use inline effects
function update(state: State, msg: Msg, dispatch: (m: Msg) => void): void {
  switch (msg.type) {
    case "INCREMENT":
      state.count++;
      break;
    case "DECREMENT":
      state.count--;
      break;
    case "SAVE":
      state.loading = true;
      // use a linter to avoid floating promises.
      // do not use void saveCount to fix the lint. Instead, make it clear that we're handling success and failure.
      saveCount(msg.count).then(
        // async operations dispatch when they're done so views update
        () => dispatch({ type: "SAVE_DONE" }),
        (e) => dispatch({ type: "SAVE_ERROR", error: String(e) }),
      );

      break;
    case "SAVE_DONE":
      state.loading = false;
      break;
    case "SAVE_ERROR":
      state.loading = false;
      break;
  }
}

async function saveCount(count: number): Promise<void> {
  const count = await fetch("/api/count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ count }),
  });
  return count;
}

// use the cls helper to define class selectors. This appends a short hash to the end of the class name to make it unique
// the counterClass variable handle allows you to find references, and prevents typos
const counterClass = cls("counter");

// mountStyle takes a css string and mounts it into the DOM as a <style> tag
mountStyle(`
.${counterClass} {
  display: flex;
  gap: 8px;
  align-items: center;
}
`);

// View is an interface defining sync and destroy. Implement this to be able to use views with Binder.
class CounterView implements View<State, Msg> {
  container: HTMLElement;
  private b: Binder<State, Msg>;

  // constructor runs on mount. The container element is created by the parent
  constructor(
    container: HTMLElement,
    dispatch: (msg: Msg) => void,
    initialState: State,
  ) {
    // ref creates a unique identifier that we can use via the data-ref attribute to bind parts of the DOM.
    // it needs to be unique so that we don't accidentally select inside a child view when creating bindings.
    // ref returns `Ref` - a branded string type. Binding methods require Ref to force you to define data-refs this way.
    // define these in the constructor, so you don't reuse them between views & remounts.
    const countRef = ref("count");
    const incRef = ref("inc");
    const decRef = ref("dec");

    this.container = container;

    // NOTE! This only runs once on mount, so any view logic derived from state here will be static and will not update.
    // For elements that need to update, use the binder (see below).
    // sanitize html-escapes interpolated values to prevent XSS.
    container.innerHTML = sanitize`
      <!-- static values (cls, ref, initialState fields) can be interpolated directly into the template -->
      <div class="${counterClass}">
        <button data-ref="${decRef}">−</button>
        <span data-ref="${countRef}">0</span>
        <button data-ref="${incRef}">+</button>
      </div>
    `;

    this.b = new Binder(container, dispatch, initialState);

    // on destroy these elements will be removed from the DOM and these callbacks will be garbage collected
    this.b
      .ref(decRef)
      .addEventListener("click", () => dispatch({ type: "DECREMENT" }));
    this.b
      .ref(incRef)
      .addEventListener("click", () => dispatch({ type: "INCREMENT" }));

    // bindText uses textContent to prevent XSS
    // the binding will be evaluated with initial state here and re-evaluated every this.b.sync() with new state
    this.b.bindText(countRef, (s: State) => String(s.count));

    // bindStyle sets inline styles via a record. Clears removed properties between syncs.
    this.b.bindStyle(countRef, (s) =>
      s.loading ? { opacity: "0.5", "pointer-events": "none" } : {},
    );
  }

  sync(state: State): void {
    // you must explicitly call this.b.sync from the view's sync
    this.b.sync(state);
  }

  destroy(): void {
    this.b.cleanup();
    this.container.innerHTML = "";
  }
}

function mountCounter(container: HTMLElement) {
  const state = { count: 0, loading: false };

  let dispatching = false;
  // the core event loop. User interacts with DOM -> dispatch a msg -> update the state -> sync the view
  function dispatch(msg: Msg): void {
    if (dispatching) throw new Error("dispatch-in-dispatch");
    dispatching = true;
    update(state, msg, dispatch);
    view.sync(state);
    dispatching = false;
  }

  const view = new CounterView(container, dispatch, state);
}
```

# Constructor renders structure, binder for dynamic state

The constructor runs **once on mount**, so you must use bindings to make views respond to state updates

```typescript
constructor(container, dispatch, initialState) {
  const r = initialState.response;
  const name = r.attendee ? displayName(r.attendee) : "(anonymous)";
  const buttons = r.attendee_id === null ? `<button>Match</button>` : "";
  // WRONG — name and buttons baked in at mount, never updated when state changes
  container.innerHTML = `<td>${name}${buttons}</td>`;
  this.b = new Binder(container, dispatch, initialState);
}
```

```typescript
constructor(container, dispatch, initialState) {
  const nameRef = ref("name");
  const matchBtnRef = ref("matchBtn");
  container.innerHTML = sanitize`
    <td>
      <span data-ref="${nameRef}"></span>
      <button data-ref="${matchBtnRef}" type="button">Match</button>
    </td>
  `;
  this.b = new Binder(container, dispatch, initialState);

  // RIGHT — bindings drive every state-derived bit
  this.b.bindText(nameRef, (s) =>
    s.response.attendee ? displayName(s.response.attendee) : "(anonymous)",
  );
  this.b.bindVisible(matchBtnRef, (s) => s.response.attendee_id === null);
}
```

# Prefer declarative DOM updates through bindings to imperative mutation

```typescript
sync(state: State): void {
  // WRONG — imperative mutation
  this.container.querySelector(".count")!.textContent = String(state.count);
  this.button.disabled = state.loading;
}
```

```typescript
// RIGHT — declare bindings once in the constructor; `sync()` uses binder
constructor() {
  this.b.bindText(countRef, (s) => String(s.count));
  this.b.bindDisabled(buttonRef, (s) => s.loading);
}

sync(state: State): void { this.b.sync(state); }
```

**Before writing any imperative DOM code in a view (`innerHTML =`, `appendChild`, `document.createElement`, property mutation in a render loop, or `${initialState.foo}` interpolation in a constructor template), stop and ask the user for explicit confirmation.**

```typescript
// WRONG — reaching for the DOM because no `bindX` exists for the property you need
this.checkboxEl.checked = state.value;
```

```typescript
// RIGHT — add the missing binding type to `vamp.ts`
this.b.bindChecked(checkboxRef, (s) => s.value);
```

# `bindSlot` — mount/unmount child views

```typescript
// The child view exports its own messages and update function:
import { type Msg as NavMsg, update as navUpdate } from "./nav.js";

// The parent wraps them into its own message type:
type Msg =
  | { type: "NAV_MSG"; msg: NavMsg }
  | { type: "OTHER_STUFF" };

// The parent's update delegates to the child's update:
function update(state: State, msg: Msg, dispatch: (m: Msg) => void): void {
  switch (msg.type) {
    case "NAV_MSG":
      navUpdate(state, msg.msg, (msg: NavMsg) => dispatch({type: "NAV_MSG", msg}));
      break;
  }
}

constructor(container: HTMLElement, dispatch: (msg: Msg) => void, initialState: State) {
  const navRef = ref("nav");
  const contentRef = ref("content");
  const pageRef = ref("page");

  container.innerHTML = sanitize`
    <div data-ref="${navRef}"></div>
    <div data-ref="${contentRef}"></div>
    <div data-ref="${pageRef}"></div>
  `;
  this.b = new Binder(container, dispatch, initialState);

  // show() returns a SlotContent, which contains the ViewClass and State that should render in the slot
  // This is a managed effect. When the ViewClass changes, we unmount the old one and mount the new one.
  // When the ViewClass is the same, we sync it to the new state.
  this.b.bindSlot(navRef, (s) => show(NavView, {
    loggedIn: s.auth.status === "logged in",
    displayName: s.displayName,
    email: s.email,
  // Optional last arg to show() is the dispatch method that's passed to the child. This can wrap child messages into
  // parent messages
  }, (navMsg) => ({ type: "NAV_MSG", msg: navMsg })));

  this.b.bindSlot(contentRef, (s) => {
    // when the bindSlot binding evaluates to undefined, the child is unmounted
    if (!s.selectedId) return undefined;
    return show(DetailView, { id: s.selectedId }, (m) => ({ type: "DETAIL_MSG", msg: m }));
  });

  // switch pattern
  this.b.bindSlot(pageRef, (s) => {
    switch (s.load.status) {
      case "loading":
        // When we return the same class constructor, we call sync on the existing instance
        // otherwise we unmount the previous view, and mount the new one
        return show(SpinnerView, {});
      case "loaded":
        return show(ListView, { items: s.load.items });
      case "error":
        return show(ErrorView, { message: s.load.message });
    }
  });
}
```

## Don't manually mount/unmount child views

```typescript
// WRONG — managing the child lifecycle by hand
sync(state: State): void {
  if (state.selectedId && !this.detail) {
    this.detail = new DetailView(this.detailContainer, dispatch, { id: state.selectedId });
  } else if (!state.selectedId && this.detail) {
    this.detail.destroy();
    this.detail = null;
  } else if (this.detail) {
    this.detail.sync({ id: state.selectedId });
  }
}

constructor() {
  // RIGHT — `bindSlot` does mount/sync/unmount automatically based on the returned `show()`:
  this.b.bindSlot(detailRef, (s) =>
    s.selectedId ? show(DetailView, { id: s.selectedId }) : undefined,
  );
}
```

## Wrapper views — pass dynamic children as `SlotContent` props

A wrapper view (modal, popover, card shell, …) renders its own chrome and mounts
caller-supplied content into a slot. The content is passed in as a `SlotContent`
**prop** (the result of `show()`), and the wrapper forwards it through its own
`bindSlot`:

```typescript
// Wrapper: chrome + a slot the caller fills. Its own Msg is usually `never` —
// the wrapped child's messages flow through the dispatch baked into the SlotContent.
class ModalView implements View<{ content: SlotContent; onClose: () => void }, never> {
  constructor(container, _dispatch, initialState) {
    // ...renders overlay/panel/close button + a data-ref="content" placeholder...
    this.b.bindSlot(contentRef, (s) => s.content);
  }
}
```

`SlotContent` is not a live view — it's an inert descriptor (which view + what
state + which dispatch) that the slot diffs (mount / sync / remount). This is the
"children as data" model.

**Build the child `show()` inside the parent's `bindSlot` callback, not in the
constructor.** Because the parent wraps the wrapper in its own `bindSlot`, the
child descriptor is recomputed from the latest state on every sync — so the child
syncs with fresh state:

```typescript
// RIGHT — child show() is created inside the parent's bindSlot callback, so it's
// rebuilt from the latest state each sync.
this.b.bindSlot(modalRef, (s) => {
  if (!s.authModalOpen) return undefined;
  return show(
    ModalView,
    {
      content: show(AuthFormView, authFormState({ email: s.email }), {}, noop),
      onClose: () => dispatch({ type: "CLOSE_AUTH" }),
    },
    {},
    noop,
  );
});
```

```typescript
// WRONG — content show() captured once in the constructor; it freezes the state
// it closed over and never reflects later updates.
const content = show(AuthFormView, authFormState({ email: this.email }), {}, noop);
this.b.bindSlot(modalRef, (s) =>
  s.authModalOpen ? show(ModalView, { content, onClose }, {}, noop) : undefined,
);
```

Prefer the `SlotContent` value over a thunk (`() => SlotContent`) or render-prop
(`(api) => SlotContent`). The value matches this idiom and gets freshness for
free from the dispatch loop. Reach for a render-prop only when the wrapper must
inject its own state/callbacks into the content (e.g. a `close` handle) and a
message back-channel would be clumsier; a thunk only pays off for expensive,
normally-hidden content you want to skip building.

## `bindList` — keyed list of child views

```typescript
constructor(container: HTMLElement, dispatch: (msg: Msg) => void, initialState: State) {
  const listRef = ref("list");

  container.innerHTML = sanitize`<ul data-ref="${listRef}"></ul>`;
  this.b = new Binder(container, dispatch, initialState);

  // "li" is the wrapper tag created for each child, and passed to ItemView as the container element
  this.b.bindList(listRef, "li", (s) =>
    s.items.map((item) =>
      // showKeyed is like show, but uses the key to distinguish element identity instead of the view class
      // keys must be unique
      showKeyed(item.id, ItemView, {
        item,
        isSelected: item.id === s.selectedId,
      // optional last argument to wire up actions for this element of the list.
      }, (msg: ItemMsg) => dispatch({type: 'ITEM_MSG', itemId: item.id, msg})),
    ),
  );

  // On each sync:
  // 1. New keys → mount new views
  // 2. Existing keys → sync with new state if the view constructor is the same (reuse by key), otherwise remount
  // 3. Removed keys → destroy and remove from DOM
  // 4. Reorder DOM to match array order
}
```

```typescript
this.b.bindList(listRef, "li", (s) =>
  // WRONG — keying by array index. Use stable identifiers!
  s.items.map((item, i) => showKeyed(String(i), ItemView, { item })),
);
```

```typescript
this.b.bindList(listRef, "li", (s) =>
  // RIGHT — key by the stable id of the item, so reorders move existing DOM nodes instead of updating them with new state
  s.items.map((item) => showKeyed(item.id, ItemView, { item })),
);
```

# Context and stores (dependency injection)

Stores hold shared state that outlives any individual view. Context (`ctx`) is the bag of dependencies — stores, API clients, anything else that has a lifecycle that is different from when a view is mounted/unmounted.

- **Created at the root, threaded down.** The app's `ctx` is built once in `main.ts` and passed as a constructor arg to the root view. Each parent picks the subset of its own ctx to hand to each child at the `show()` / `showKeyed()` call site.
- **Each view declares only the slice it uses.** A view's `Ctx` generic is an inline structural type listing the exact fields it touches. This is useful for unit testing - we only need to mock the context that the view actually uses.
- **Stores wire into the same dispatch loop as views.** A store exposes a `Msg` type and a `update(msg)` reducer. The root is responsible for passing dispatches back into the store's update function.
- **The Binder is ctx-agnostic.** If a view needs ctx for its own logic, capture it as a private field in the constructor; the Binder does not thread ctx.

```typescript
// Root: build ctx + stores once. Store dispatches re-enter the root loop.
class EventStore {
  constructor(private api: Api, private dispatch: (m: EventStoreMsg) => void) {}
  update(msg: EventStoreMsg): void {}
  loadUngrouped(orgId: OrgId): void {
    this.dispatch({ type: "LOAD_START", orgId });
    this.api(...).then((p) => this.dispatch({ type: "LOAD_OK", orgId, page: p }));
  }
}

type MainMsg =
  | { type: "NAVIGATE"; route: Route }
  | { type: "EVENT_STORE_MSG"; msg: EventStoreMsg };

type AppCtx = { eventStore: EventStore };

function createAppCtx(dispatch: (m: MainMsg) => void): AppCtx {
  return {
    eventStore: new EventStore(api, (msg) =>
      dispatch({ type: "EVENT_STORE_MSG", msg }),
    ),
  };
}

function update(state: MainState, msg: MainMsg, ctx: AppCtx): void {
  switch (msg.type) {
    case "EVENT_STORE_MSG":
      ctx.eventStore.update(msg.msg);
      break;
    // ...
  }
}

// Child view: declares the exact slice of ctx it needs.
type EventsCtx = { eventStore: EventStore };

class EventsListPage implements View<EventsState, EventsMsg, EventsCtx> {
  constructor(
    container: HTMLElement,
    dispatch: (m: EventsMsg) => void,
    initialState: EventsState,
    private ctx: EventsCtx,
  ) {
    // ...
  }
}

// Parent: passes its own (wider) ctx; structural typing narrows it for the child.
this.b.bindSlot(pageRef, (s) =>
  show(EventsListPage, eventsState(s.orgId), this.ctx, noop),
);
```

This is dependency injection in its simplest, most explicit form: dependencies travel as plain constructor arguments, the type system documents and enforces the per-view contract, and there is no hidden global state to mock or reset between tests.

## Store <-> View contract

A store method that triggers an async operation (network call, IO) can dispatch its own internal messages internally so every view subscribed via `getState()` re-renders. But the calling view also gets the same promise back and is expected to attach its own handlers.

```typescript
case "DELETE_GROUP": {
  ctx.eventGroupStore
    .deleteGroup(msg.id, state.orgId)
    // explicit error handling. Enforced by no-floating-promises lint rule
    .then(undefined, (e) =>
      dispatch({ type: "ERROR", message: String(e) }),
    );
  break;
}
```

Two things are happening here, and both matter:

1. **The store updates global state.** `deleteGroup` removes the group from its internal map and dispatches a store msg; every view reading `eventGroupStore.getState(...)` re-renders on the next sync.
2. **The view dispatches its own actions.** Only this view knows whether to surface the error in _its_ error banner, clear a local form field on success, close a modal, advance a wizard step, etc. Those are view-local concerns the store can't know about.

This pattern also pairs with the no-floating-promises lint: every store call has a visible `.then(success, failure)` at the call site, so a forgotten error branch is a lint error rather than a silently-swallowed rejection. Do not use `void store.method()` to silence the lint — handle both branches explicitly even if one is a no-op (`.then(undefined, handleErr)` is fine).

Rule of thumb: **the store owns the data; the view owns its own UI reaction to the operation.** Don't move view-local concerns (form resets, error banners, navigation) into the store, and don't drop the promise on the floor assuming the store's internal dispatches are enough.

## Read live ctx state inside binding callbacks, not in the constructor

Binding callbacks (`bindSlot`, `bindText`, `bindList`, …) run on every `sync()`. Code in the constructor body runs **once on mount**. If you read ctx/store state outside a binding callback and close over it, the value freezes at mount time and never updates — even though the store keeps changing.

```typescript
constructor(container, dispatch, initialState, private ctx: Ctx) {
  // WRONG — read once at mount, captured by the closure, never refreshed
  const prop = this.ctx.store.getProp();
  this.b.bindSlot(slotRef, (s) => show(ChildView, { s, prop }));
}
```

```typescript
constructor(container, dispatch, initialState, private ctx: Ctx) {
  // RIGHT — re-read on every sync, so store updates flow through
  this.b.bindSlot(slotRef, (s) => {
    const prop = this.ctx.store.getProp();
    return show(ChildView, { s, prop });
  });
}
```

Rule: anything that can change after mount — including derived values pulled from ctx/stores — must be computed **inside** the binding callback. The constructor is for static structure and one-time wiring only.

# Routing

The URL bar is just another input — like a button or a text field. The same unidirectional cycle applies: listen for events (popstate, link clicks), dispatch a `NAVIGATE` message, update state, sync the view. Views use plain `<a href="...">` elements for navigation, so middle-click / ctrl-click to open in a new tab work natively; a delegated click listener intercepts normal left-clicks for SPA navigation.

The router itself is split into a **controller** and a **view**, mirroring the rest of the app (state-owner vs DOM-half):

**`RouterController`** lives in the app context (`ctx.router`) and owns the canonical `route` state plus the pending address-bar write intent. It is mutated only from reducers via `update(msg)`, touches no DOM, and resolves auth redirects centrally (anonymous → `login`, signed-in → away from `login`, always as a `replace`).

It exposes an `epoch` counter, bumped on every route change, and `desired()` returning `{ path, kind }` (`kind` is `"push"` | `"replace"`). The path is derived from the route via `routeToPath`, so the view never re-derives routing rules.

**`RouterView`** is the address bar's view half. It registers the input listeners on `mount()` (popstate + delegated link clicks) and reconciles `history.*` during `sync()`, called by the root dispatch loop after the DOM renders:

```typescript
function dispatch(msg: MainMsg): void {
  // ...
  update(state, msg, ctx, dispatch);
  view.sync(state);
  routerView.sync(); // write any URL change the controller requested
  ctx.postRenderBus.flush();
}
```

`sync()` is gated on the controller's `epoch`: the view records the last epoch it reconciled and no-ops while they match, so a sync triggered by unrelated state changes (or a user editing the address bar) never re-writes the URL — only a genuine route change does. It is also idempotent against the current location (when `desired().path` already equals the address bar, e.g. a popstate the browser already applied, nothing is written), keeping back/forward clean.

Browser-driven navigation flows the other way: `RouterView` listens for `popstate` and link clicks, and dispatches `{ type: "NAVIGATE", route: currentRoute()/parseRoute(...) }`. The view emits only a `RouterMsg` (`NAVIGATE` with an optional `kind`); the root loop wraps it into the app-wide message, keeping the router decoupled from the app message type. Same-page link clicks (path+search unchanged) skip dispatch and just `pushState` for the hash.

Note: `history.pushState()` does _not_ fire a `popstate` event, so there is no double-dispatch. `popstate` only fires on back/forward navigation.

# Post-render events

Reducers must never touch the DOM, and views must never run imperative DOM work inside `sync()`. But some work — scroll, focus, measurement — _has_ to happen after the DOM reflects the new state, and it belongs in the view that owns the relevant container/refs. The **post-render event bus** bridges these two phases.

`PostRenderEventBus<Event>` (in `vamp.ts`) is a tiny framework object, generic over an app-supplied event union, with three methods:

- `emit(event)` — queue an event during a dispatch. Called from the **reducer side** (`update` / root message handlers).
- `subscribe(handler): () => void` — register a listener. Called by a **view** (usually in its constructor); returns an unsubscribe function to call in `destroy()`.
- `flush()` — deliver every queued event to the current subscribers, then clear the queue. Called by the **root loop**, once, right after the view has synced.

The bus lives on `AppCtx` (`ctx.postRenderBus`), created once at the root and threaded down like any other store. The event union is an app-level discriminated union (e.g. `PostRenderEvent` in `app-ctx.ts`); subscribers `switch` on `event.type` and ignore events they don't care about.

```typescript
// Root dispatch loop: flush after sync, so the DOM is up to date.
function dispatch(msg: MainMsg): void {
  update(state, msg, ctx, dispatch); // reducers may ctx.postRenderBus.emit(event)
  view.sync(state); // DOM now reflects the new state
  ctx.postRenderBus.flush(); // deliver queued events -> subscribers do DOM work
}
```

```typescript
// Reducer side: emit in response to an action (never touch the DOM here).
case "SEARCH_STORE_MSG":
  ctx.searchStore.update(msg.msg);
  if (msg.msg.type === "OK" && state.pageState.page === "calendar")
    ctx.postRenderBus.emit({ type: "calendar:scroll-to-first" });
  break;
```

```typescript
// View side: subscribe in the constructor, unsubscribe in destroy.
constructor(container, dispatch, initialState, private ctx: Ctx) {
  // ...
  this.unsubscribe = this.ctx.postRenderBus.subscribe((event) => {
    if (event.type === "calendar:scroll-to-first") this.scrollToFirstEvent();
  });
}

destroy(): void {
  this.unsubscribe();
  // ...
}
```

Events are delivered to _currently mounted_ subscribers only. A view that just unmounted won't receive anything; a view that mounted during the same dispatch's `sync` is already subscribed (it subscribes in its constructor), so it receives events emitted in that same dispatch.

## Invariants

- Reducers never touch the DOM; all DOM work happens in subscribers during `flush()`, after `sync()`.
- `flush()` runs exactly once per dispatch and clears the queue, so an event is delivered at most once.
- Subscriptions are torn down in `destroy()` — the bus must hold no reference to an unmounted view.
- The dispatch re-entrancy guard still holds: `emit` only queues; subscribers run during `flush`, outside `update`, and must not synchronously re-dispatch (schedule via rAF if they must).
