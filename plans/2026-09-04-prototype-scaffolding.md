# Objective and Context

"Write a plan to set up scaffolding for the prototype. The goal is to get to the point where you have an input box, the user can type in a message, and the agent can stream a response."

This is a demo. The target is the smallest thing that lets us see the UI and play with the interaction. No tools, no persistence, no auth, no configuration, no validation. The conversation lives in the browser; the backend exists only to hold the API key and proxy one streaming call.

We use `@anthropic-ai/sdk` types directly rather than inventing a provider abstraction. `~/src/magenta.nvim/node/core/src/providers/` is a reference to consult later if this outgrows itself, not something to copy from now. `~/src/gatherus/main/` is the source for the web scaffolding (vite, fastify, vitest, vamp).

SDK types we use as-is (`@anthropic-ai/sdk@0.115.0`, the version magenta pins):

- `Anthropic.MessageParam` - the conversation is a `MessageParam[]`.
- `Anthropic.MessageCreateParamsStreaming` - passed straight through from the client to `client.messages.stream()`.
- `Anthropic.RawMessageStreamEvent` - forwarded straight back.

Files (all new):

- `package.json`, `vite.config.ts`, `biome.json`, `tsconfig.json` - root workspace, modeled on gatherus.
- `packages/iso/protocol.ts` - the websocket message union.
- `packages/backend/app.ts` - fastify entry.
- `packages/backend/socket.ts` - `GET /api/socket`.
- `packages/frontend/conversation.ts` - the message array plus the streaming accumulator.
- `packages/frontend/{index.html,main.ts,vamp.ts,view.ts}`.

`.magenta/skills/vamp/skill.md` is already copied over from gatherus - read it before writing any view code.

# Design

The backend is a pipe with an API key. A `start` frame carries the complete `MessageCreateParamsStreaming`; the server passes it to the SDK unexamined and forwards each `RawMessageStreamEvent` back tagged with the request id, then `done`. It does not validate, parse, accumulate, or hold any conversation state. If the params are wrong the API says so and we forward the error - the client is the only thing that constructs params, and it is our own code.

Consequences worth stating, since they cut against the usual instinct:

- The whole conversation is re-uploaded every turn. Free at this scale, and it buys a server with no lifecycle.
- Refresh discards everything, which `notes/prototype.md` asks for, and which now falls out of the architecture rather than needing enforcement.
- The prototypes in `notes/prototype.md` (highlight-to-ask, agent-suggested review points, domain map) are all client-side changes - each is just another `start` with different params.

Data flow for one turn: composer -> `conversation.send(text)` -> `start` frame -> SDK -> `event` frames -> accumulator folds into the tail assistant message -> `view.sync(state)`. On `message_stop` the accumulated message is committed to the `MessageParam[]`.

Accumulation is the only real logic, and without tools it is a few lines: `content_block_start` pushes a block at `event.index`, `content_block_delta` appends `delta.text`, `message_stop` commits. The transcript the user sees and the array sent next turn come from the same accumulator, so they cannot drift.

Websocket rather than SSE because the later prototypes want a side-panel conversation running alongside the main transcript, and multiplexing by request id over one socket is simpler than a pool of fetch streams. Copy the shape from `gatherus/packages/backend/sheets/socket.ts`, stripping auth, permissions, the bus, and the heartbeat.

## Interfaces

`packages/iso/protocol.ts`:

```ts
import type Anthropic from "@anthropic-ai/sdk";

export type ClientMessage = {
  type: "start";
  requestId: string;
  params: Anthropic.MessageCreateParamsStreaming;
};

export type ServerFrame =
  | { type: "event"; requestId: string; event: Anthropic.RawMessageStreamEvent }
  | { type: "done"; requestId: string }
  | { type: "error"; requestId: string; message: string };
```

`packages/frontend/conversation.ts`:

```ts
export type Message = { role: "user" | "assistant"; text: string };

export class Conversation {
  constructor(socket: WebSocket);
  /** Committed turns plus the one currently streaming. */
  readonly messages: ReadonlyArray<Message>;
  send(text: string): Promise<void>;
}
```

One text block per message, flattened to a string - the API can emit several text blocks but for a demo transcript concatenating them is indistinguishable. `Conversation` holds the `MessageParam[]` and derives `messages`, rather than keeping two arrays in sync.

Model, system prompt, and max_tokens are module constants in `conversation.ts`.

## Invariants

- Every `start` gets exactly one terminal frame (`done` | `error`), so the client can always settle.
- A failed turn still commits whatever text arrived, so the next turn's array is valid - `MessageParam` content must be non-empty, so a failure before any text drops the assistant message.
- `send` is a no-op while a turn is in flight.
- `ANTHROPIC_API_KEY` is read on the server and never crosses the wire.

## Testing

Gatherus's `backend-testing` and `frontend-testing` skills are not worth porting: both are almost entirely about a real Postgres per worker, the `FixtureBuilder`/composites layer, org-scoped isolation, and a Playwright suite against a live server. We have no database, no auth, and no org scoping, so none of the machinery applies.

Two ideas from them do carry over, and are reflected in the stages below:

- Gatherus tests views by driving a real browser rather than jsdom, and that holds here. Playwright is cheap for us precisely because we have no fixtures: a page load *is* the isolated state, so a test is "load the page, poke at it, assert on the DOM" - closer to a storybook story than to gatherus's seeded e2e specs.
- `page.routeWebSocket("**/api/socket", ...)` (Playwright 1.48+) lets a test stand in for the backend entirely, replaying a scripted `RawMessageStreamEvent` sequence. So UI tests need no API key, no network, and are deterministic. A separate smoke spec can hit the real backend, skipped unless `ANTHROPIC_API_KEY` is set.
- The test file sits next to the module whose behavior it asserts (`conversation.test.ts` beside `conversation.ts`), not beside the transport that reaches it.

Vitest at the root for the accumulator (`npm test`); Playwright in `packages/e2e/` for the UI (`npm run test:e2e`), with `playwright.config.ts` booting `vite` and `packages/backend/app.ts` as `webServer`s.

# Stages

## end to end pipe — DONE

Notes:

- `@anthropic-ai/sdk` resolved to `0.115.5` under `^0.115.0`; typescript is `^5.9.3` rather than gatherus's `^7.0.2`.
- `biome.json` was migrated to the installed biome (2.5.12) schema, so the linter block uses `"preset": "recommended"`.
- `vite.config.ts` also sets `ws: true` on the `/api/` proxy, which the websocket needs.
- The backend has no `env.ts`; `app.ts` reads `ANTHROPIC_API_KEY` directly and refuses to boot without it.
- `main.ts` exposes a scratch `window.edulab.ask(text)` for the manual check. It is replaced in the next stage.
- Verified by driving `ws://localhost:5173/api/socket` through the vite proxy against the real API: the full `message_start` -> deltas -> `message_stop` -> `done` sequence came back.

- Goal: `npm run dev` serves a page at 5173 proxying `/api/` to fastify on 3000, and a scratch call from the browser console streams events from the real API into `console.log`.
- Work: root `package.json` with `packages/*` workspaces; `vite.config.ts` from gatherus minus the MPA/`spaFallback` bits; `biome.json`; tsconfigs; `packages/iso/protocol.ts`; `packages/backend/{app,socket}.ts`; `packages/frontend/{index.html,main.ts}` plus `vamp.ts` copied verbatim.
- Tests: none. This stage is entirely wiring against a live API, and the manual check - events land in the console - is stronger than anything a mock would tell us.

## conversation — DONE

Notes:

- `Socket` is a structural `{ send, addEventListener("message", ...) }` rather than `WebSocket`, so the vitest fakes need no cast; the real `WebSocket` satisfies it.
- `Conversation` exposes `handleFrame` (so tests can inject `done`/`error` frames), `inFlight`, and an `onChange` callback for the next stage's render loop.
- An assistant message only appears in `messages` once it has text, so an in-flight turn with no deltas yet shows no empty bubble.
- Root `test` script is now `vitest run` with a root `vitest.config.ts` (node environment, `packages/**/*.test.ts`).

- Goal: `conversation.send("count to five")` resolves with two turns in `conversation.messages`.
- Work: `conversation.ts`.
- Tests:
  - Frontend vitest over the accumulator against a scripted event array - no socket, no SDK. Feed it a recorded sequence and assert the resulting `messages`.
  - Two sequential turns produce four messages with alternating roles, which is what the API requires and the easiest thing to get wrong.

## chat UI — DONE

Notes:

- State is `{ messages, inFlight, draft }` in `main.ts`; `update` mirrors `conversation.messages`/`inFlight` after every message, and `conversation.onChange` re-syncs the view as frames arrive.
- The transcript is a `bindList` keyed by position - the array is append-only and never reorders, so position is stable identity here.
- Enter submits, shift+enter newlines; the textarea and the send button are both disabled while a turn is in flight (send is also disabled on an empty draft).
- `packages/e2e/` holds `playwright.config.ts` (fixed ports 5174/3100, overridable via `TEST_FRONTEND_PORT`/`TEST_BACKEND_PORT`) plus `tests/{chat,smoke}.spec.ts`. The backend `webServer` entry is only added when `ANTHROPIC_API_KEY` is set, matching the smoke spec's skip.
- Specs use `.spec.ts` so vitest's `packages/**/*.test.ts` glob does not pick them up. `npm run test:e2e` runs them; `typecheck` now includes the e2e package.
- The scripted stream omits `message_start`/`message_delta` - the accumulator ignores them, and the smoke spec is what guards against SDK drift.

- Goal: the deliverable - type in the box, hit enter, watch the response stream in.
- Work: `view.ts` (transcript + composer as vamp views), wired into a single dispatch loop in `main.ts`.
- Tests:
  - A Playwright spec with `routeWebSocket` replaying a scripted stream: type into the composer, submit, and assert the text appears incrementally and the transcript holds both turns. Deterministic, no API key.
  - One spec asserting the composer is disabled while a turn is in flight - the state machine, rather than the rendering.
  - A smoke spec against the real backend, skipped without `ANTHROPIC_API_KEY`, so the fake and the SDK cannot silently drift.
