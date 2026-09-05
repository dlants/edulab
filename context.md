**edulab** is a set of throwaway prototypes exploring how a user can *learn* from an agent that is doing their work for them, rather than passively watching it. See `notes/exploration.md` for the thinking and `notes/prototype.md` for the prototype ladder.

Everything here is a demo. No database, no auth, no persistence, no configuration. Refreshing the page discards all state, by design.

# Layout

- **`packages/iso/protocol.ts`** — the websocket message union (`ClientMessage`, `ServerFrame`). Imported by both sides.
- **`packages/backend/`** — Fastify server, entry `app.ts` (reads `ANTHROPIC_API_KEY` from the root `.env`, listens on 3000). `socket.ts` registers `GET /api/socket` and is a **pipe**: it forwards the client's `MessageCreateParamsStreaming` to the SDK unexamined and streams `RawMessageStreamEvent`s back. It holds no conversation state.
- **`packages/frontend/`** — entry `main.ts`, which renders the nav and mounts the active route.
  - `routes.ts` — one entry per prototype. Navigation is a plain `<a href>` full page load; there is no client router.
  - `prototypes/` — one module per prototype, each exporting `mount(container)` and owning its own state and dispatch loop.
  - `conversation.ts` — the `MessageParam[]` plus the stream accumulator. Model, max tokens, and the system prompt are module constants here. The system prompt is deliberately **task mode**, not tutoring: learning mode is what we layer on top of the transcript it produces.
  - `view.ts` — the transcript and composer. `vamp.ts` is copied verbatim from gatherus.
- **`packages/e2e/`** — Playwright specs (`.spec.ts`, so vitest's `packages/**/*.test.ts` glob ignores them).
- **`docs/transcripts/`** — synced magenta thread archives, raw material for the prototypes. Refresh with `npm run sync:transcripts`.
- **`notes/exploration.md`** — the framing. What the learning problem actually is, why the obvious moves (student modeling, agent-as-tutor) are traps, and what we are deliberately not building. **Read this before proposing a direction.**
- **`notes/prototype.md`** — the prototype ladder and the scaffolding constraints. **Read this before adding a prototype.** Each numbered prototype there maps to an entry in `routes.ts`.
- **`plans/`** — implementation plans, annotated with what actually happened as each stage landed.

# Commands

- `npm run dev` — vite on **5173** plus the backend on **3000**. Open http://localhost:5173. `/api/` (including the websocket) is proxied.
- `npm test` — vitest, node environment. The only unit tests are over the stream accumulator.
- `npm run test:e2e` — Playwright on its own ports (5174/3100). UI specs stub the socket with `page.routeWebSocket`, so they need no API key; `smoke.spec.ts` hits the real API and is skipped without `ANTHROPIC_API_KEY`.
- `npm run typecheck` — `tsc --noEmit` across every package. Always run this rather than a bare `tsc`.
- `npm run lint` / `npm run lint:fix` — biome.

# Conventions

**Use the type system.** Disjoint unions over optional fields, exhaustive switches, branded ids.

**Simplicity over abstraction.** This is prototype code with a short life. Write the concrete thing; do not build a provider abstraction or a plugin system for a second case that may never arrive. `@anthropic-ai/sdk` types are used directly rather than wrapped.

**Explicit over silent.** `RawMessageStreamEvent` is an open union we forward verbatim, so unhandled variants `console.warn` rather than throwing — but "we chose to ignore this" and "we have never heard of this" must be different branches (see `conversation.ts`).

**Single dispatch per prototype.** Each `prototypes/*.ts` owns one `dispatch` loop that calls `update` then `view.sync`. Views never hold their own dispatch. See the **[vamp skill](.magenta/skills/vamp/skill.md)** before writing any view code.

**Tests sit beside the module they assert** (`conversation.test.ts` next to `conversation.ts`), not beside the transport that reaches it. Views are verified in a real browser via Playwright, not jsdom.

**`~/src/magenta.nvim`** is a reference implementation for the agentic loop (`node/core/src/providers/`) if this outgrows itself. Do not copy from it wholesale.
