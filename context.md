**edulab** is a set of throwaway prototypes exploring how a user can *learn* from an agent that is doing their work for them, rather than passively watching it. See `notes/exploration.md` for the thinking and the prototype ladder, and `notes/studies.md` for the supporting literature.

Everything here is a demo, and the scaffolding constraints are deliberate. No database, no auth, no persistence, no configuration, no router. All state is client-side and in memory, discarded on refresh. The backend holds no conversation state: it is a pipe from the websocket to the Anthropic SDK, and inference is streamed rather than awaited so the demo reads as a real agent session instead of a latency pause. The agentic loop is a heavily simplified take on `~/src/magenta.nvim` (anthropic only, api key only, no MCP); the web setup is lifted from `~/src/gatherus/`.

# Layout

- **`packages/iso/protocol.ts`** — the websocket message union (`ClientMessage`, `ServerFrame`). Imported by both sides.
- **`packages/backend/`** — Fastify server, entry `app.ts` (reads `ANTHROPIC_API_KEY` from the root `.env`, listens on 3000). `socket.ts` registers `GET /api/socket` and is a **pipe**: it forwards the client's `MessageCreateParamsStreaming` to the SDK unexamined and streams `RawMessageStreamEvent`s back. It holds no conversation state.
- **`packages/frontend/`** — entry `main.ts`, which mounts `prototypes/chat.ts` into the page. There is one prototype and no router; later ideas land as new actions inside it rather than as separate pages. The sample picker lives in the header bar next to the layer navigation, and switching sample is a full page load.
  - `prototypes/chat.ts` — owns the thread tree, the state, and the single dispatch loop.
  - `conversation.ts` — the `MessageParam[]` plus the stream accumulator. Model, max tokens, and the system prompt are module constants here. The system prompt is deliberately **task mode**, not tutoring: learning mode is what we layer on top of the transcript it produces.
  - `view.ts` — the transcript and composer. `vamp.ts` is copied verbatim from gatherus.
- **`packages/e2e/`** — Playwright specs (`.spec.ts`, so vitest's `packages/**/*.test.ts` glob ignores them).
- **`docs/transcripts/`** — synced magenta thread archives, raw material for the prototypes. Refresh with `npm run sync:transcripts`.
- **`notes/exploration.md`** — the framing. What the learning problem actually is, why the obvious moves (student modeling, agent-as-tutor) are traps, and what we are deliberately not building. **Read this before proposing a direction or adding a prototype.** The numbered prototype sketches at the end are the roadmap.
- **`plans/`** — implementation plans, annotated with what actually happened as each stage landed.

# Commands

- `npm run dev` — vite on **5173** plus the backend on **3000**. Open http://localhost:5173. `/api/` (including the websocket) is proxied.
- `npm test` — vitest, node environment. The only unit tests are over the stream accumulator.
- `npm run test:e2e` — Playwright on its own ports (5174/3100). UI specs stub the socket with `page.routeWebSocket`, so they need no API key; `smoke.spec.ts` hits the real API and is skipped without `ANTHROPIC_API_KEY`.
- `npm run sync:transcripts` — re-run `scripts/sync-transcripts.sh` to pull magenta thread archives whose `cwd` is this repo into `docs/transcripts/`. Incremental: existing threads are updated in place, so it is safe to re-run any time.
- `npm run typecheck` — `tsc --noEmit` across every package. Always run this rather than a bare `tsc`.
- `npm run lint` / `npm run lint:fix` — biome.

# Conventions

**Use the type system.** Disjoint unions over optional fields, exhaustive switches, branded ids.

**Simplicity over abstraction.** This is prototype code with a short life. Write the concrete thing; do not build a provider abstraction or a plugin system for a second case that may never arrive. `@anthropic-ai/sdk` types are used directly rather than wrapped.

**Explicit over silent.** `RawMessageStreamEvent` is an open union we forward verbatim, so unhandled variants `console.warn` rather than throwing — but "we chose to ignore this" and "we have never heard of this" must be different branches (see `conversation.ts`).

**Single dispatch per prototype.** Each `prototypes/*.ts` owns one `dispatch` loop that calls `update` then `view.sync`. Views never hold their own dispatch. See the **[vamp skill](.magenta/skills/vamp/skill.md)** before writing any view code.

**Tests sit beside the module they assert** (`conversation.test.ts` next to `conversation.ts`), not beside the transport that reaches it. Views are verified in a real browser via Playwright, not jsdom.

**`~/src/magenta.nvim`** is a reference implementation for the agentic loop (`node/core/src/providers/`) if this outgrows itself. Do not copy from it wholesale.
