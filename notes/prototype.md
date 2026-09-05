see ./exploration.md

ok, I think I'm ready to start sketching out a prototype that we can use to play around with this.

The context will be an agentic harness, like claude cowork. The user can type things, the agent can respond and also use tools.

We're going to add a second mode to this. The user can switch away from "task" mode to "learning" mode. This changes the UI.

I want to build a progression of prototypes, each iterating on this central motif. Each of these can be an independent url on the server we set up.

# prototype scaffolding

- rip off the agentic loop from ~/src/magenta.nvim/ (provider, native inference manager, agent) but simplify dramatically. Do not import anything in core-thread or above. Leave the tool interface but don't actually port any of the tools, no mcp, only anthropic provider, only via API key. No configuration surface.

- rip off the web service setup from ~/src/gatherus/ (cleint/server split, vite, vitest, vamp).

- everything client-side, just sdk streaming the inference request on the backend. Stream via websocket to the client. I think seeing the agent writing stream in will make the demo feel more realistic / less distracting due to latency.

- keep all data ephemeral / in memory, discarded on refresh to start. No dbs, no localstorage, etc...

# prototype 1 - user-driven review

I think a really interesting interaction is a user being able to highlight some text in the transcript, and get a tool tip of interacting with it, like being able to ask a followup question about it or just say "I don't understand this", "quiz me on this".

This can open up a second vertical split, to the right of the transcript, where the user can engage with a reflective / learning task.

# prototype 2 - the agent suggests key points to review

Prototype 1 assumes that the user has pretty solid metacognitive skills, and can apply them to effectively choose their own learning objectives. In other words, they're an autodidact.

What if the user is not so good at this? Can we leverage the agent and the UI to make them a better autodidact?

I think one experiment that would be interesting would be to have the agent suggest areas for review, instead of having the user pick it from the entire transcript.

# prototype 3 - domain map

Instead of suggesting sections from the transcript, can we have the agent create a visualization of the key moments in the task completion, and have the user interact with that in some way?
