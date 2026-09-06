import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";
import { expect, type Page, test } from "@playwright/test";

function events(chunks: string[]): Anthropic.RawMessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
    ...chunks.map(
      (text): Anthropic.RawMessageStreamEvent => ({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      }),
    ),
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" } as Anthropic.RawMessageStreamEvent,
  ];
}

/** A graph update runs on every interaction and is not what these specs are
 * about: they are recognised by their write tools, answered with an immediate
 * yield, and kept out of `started`. */
function isGraphUpdate(message: ClientMessage): boolean {
  return (message.params.tools ?? []).some((t) => t.name === "put_nodes");
}

function yieldEvents(): Anthropic.RawMessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "yield-1",
        name: "yield",
        input: {},
      },
    } as Anthropic.RawMessageStreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"result":"ok"}' },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" } as Anthropic.RawMessageStreamEvent,
  ];
}

/** Stand in for the backend: replay `chunks` one delta at a time, and expose a
 * promise that resolves once the browser has sent its `start` frame. */
async function fakeBackend(page: Page, chunks: string[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];

  await page.routeWebSocket("**/api/socket", (ws) => {
    ws.onMessage(async (raw) => {
      const message = JSON.parse(String(raw)) as ClientMessage;
      if (isGraphUpdate(message)) {
        for (const event of yieldEvents()) {
          ws.send(
            JSON.stringify({
              type: "event",
              requestId: message.requestId,
              event,
            } satisfies ServerFrame),
          );
        }
        return;
      }
      started.push(JSON.stringify(message.params.messages));
      await gate;
      const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
      for (const event of events(chunks)) {
        send({ type: "event", requestId: message.requestId, event });
      }
      send({ type: "done", requestId: message.requestId });
    });
  });

  return { release, started };
}

/** Answers the first request with prose plus a tool call, and every later one
 * with prose. The app configures no tools, so the call comes back as an error
 * result - what matters here is that the call is rendered at all. */
async function toolBackend(page: Page) {
  await page.routeWebSocket("**/api/socket", (ws) => {
    let requests = 0;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ClientMessage;
      const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
      if (isGraphUpdate(message)) {
        for (const event of yieldEvents()) {
          send({ type: "event", requestId: message.requestId, event });
        }
        return;
      }
      const first = requests++ === 0;
      const stream: Anthropic.RawMessageStreamEvent[] = first
        ? [
            ...events([REPLY]).slice(0, -1),
            {
              type: "content_block_start",
              index: 1,
              content_block: {
                type: "tool_use",
                id: "call-1",
                name: "read_file",
                input: {},
                caller: { type: "direct" },
              },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: {
                type: "input_json_delta",
                partial_json: '{"path":"a.ts"}',
              },
            },
            { type: "content_block_stop", index: 1 },
            { type: "message_stop" } as Anthropic.RawMessageStreamEvent,
          ]
        : events(["and then"]);
      for (const event of stream) {
        send({ type: "event", requestId: message.requestId, event });
      }
    });
  });
}

/** Selects characters [start, end) of message `msg` and lets the app capture
 * it, which it does on mouseup over the transcript. */
async function selectRange(
  page: Page,
  msg: number,
  start: number,
  end: number,
) {
  await page.evaluate(
    ({ msg, start, end }) => {
      const li = document.querySelectorAll("ul")[0].children[msg];
      // The text span is where the offsets the app anchors into live.
      const root = li.querySelector("[data-text]") as HTMLElement;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let at = 0;
      let from: [Node, number] | null = null;
      let to: [Node, number] | null = null;
      let node = walker.nextNode();
      while (node) {
        const len = node.textContent?.length ?? 0;
        if (!from && start <= at + len) from = [node, start - at];
        if (!to && end <= at + len) to = [node, end - at];
        at += len;
        node = walker.nextNode();
      }
      if (!from || !to) throw new Error("range out of bounds");
      const range = document.createRange();
      range.setStart(from[0], from[1]);
      range.setEnd(to[0], to[1]);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { msg, start, end },
  );
  await taskTranscript(page).dispatchEvent("mouseup");
}

/** The right pane's transcript, present only while a thread is open there. */
function threadTranscript(page: Page) {
  return page.locator("ul").nth(1);
}

/** The left pane's transcript. The right pane renders its own <ul>. */
function taskTranscript(page: Page) {
  return page.locator("ul").first();
}

const SENTENCE = "the quick brown fox jumps over the lazy dog";

/** A transcript with one user message of known text, in learning mode. */
async function transcript(page: Page, chunks: string[] = ["ok"]) {
  const backend = await fakeBackend(page, chunks);
  backend.release();
  await page.goto("/");
  await page.getByRole("textbox").fill(SENTENCE);
  await page.getByRole("textbox").press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: "Reflect" }).click();
  return backend;
}

test("streams a response into the transcript", async ({ page }) => {
  const backend = await fakeBackend(page, ["Hello", ", world"]);
  await page.goto("/");

  await page.getByRole("textbox").fill("hi");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.locator('[data-role="user"]')).toHaveText(/hi/);
  backend.release();

  await expect(page.locator('[data-role="assistant"]')).toHaveText(
    /Hello, world/,
  );
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
});

test("the composer is disabled while a turn is in flight", async ({ page }) => {
  const backend = await fakeBackend(page, ["ok"]);
  await page.goto("/");

  const input = page.getByRole("textbox");
  await input.fill("hi");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(input).toBeDisabled();
  backend.release();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("");
});

test("a second turn sends the full thread", async ({ page }) => {
  const backend = await fakeBackend(page, ["ok"]);
  backend.release();
  await page.goto("/");

  const input = page.getByRole("textbox");
  await input.fill("first");
  await input.press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);

  await input.fill("second");
  await input.press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(4);

  expect(backend.started).toHaveLength(2);
  expect(JSON.parse(backend.started[1])).toHaveLength(3);
});

test("a live selection overlapping a mark offers no actions", async ({
  page,
}) => {
  await transcript(page);
  const explain = page.getByRole("button", {
    name: "I don't understand this.",
  });

  await selectRange(page, 0, 0, 9);
  await explain.click();
  await expect(page.locator("[data-mark]")).toHaveCount(1);

  await selectRange(page, 0, 4, 15);
  await expect(
    page.getByText("Select a non-overlapping section."),
  ).toBeVisible();
  await expect(explain).toBeHidden();

  await selectRange(page, 0, 10, 19);
  await expect(explain).toBeVisible();
});

test("two marks in one message are both clickable", async ({ page }) => {
  await transcript(page);
  const explain = page.getByRole("button", {
    name: "I don't understand this.",
  });
  const opening = threadTranscript(page).locator("li").first();

  await selectRange(page, 0, 0, 9);
  await explain.click();
  await selectRange(page, 0, 16, 19);
  await page.getByRole("button", { name: "Quiz me on this." }).click();

  const marks = page.locator("[data-mark]");
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveText("the quick");
  await expect(marks.nth(1)).toHaveText("fox");

  await marks.nth(0).click();
  await expect(opening).toContainText("I don't understand this.");
  await marks.nth(1).click();
  await expect(opening).toContainText("Quiz me on this.");
});

test("an action opens a thread seeded with the selected passage", async ({
  page,
}) => {
  const backend = await transcript(page);
  const sent = backend.started.length;

  await selectRange(page, 0, 4, 19);
  await page.getByRole("button", { name: "I don't understand this." }).click();

  expect(backend.started).toHaveLength(sent + 1);
  const messages = JSON.parse(backend.started[sent]) as Array<{
    role: string;
    content: string;
  }>;
  expect(messages).toHaveLength(2);
  expect(messages[0].role).toBe("user");
  expect(messages[0].content).not.toContain("Selected:");
  expect(messages[1].content).toContain("quick brown fox");

  // The ask is the thread's own first message; the seed stays hidden.
  await expect(threadTranscript(page).locator("li")).toHaveText([
    /quick brown fox/,
    /ok/,
  ]);
  await expect(page.locator("[data-mark]")).toHaveText("quick brown fox");
});

test("a follow-up in the thread pane re-sends the seed", async ({ page }) => {
  const backend = await transcript(page);
  await selectRange(page, 0, 0, 9);
  await page.getByRole("button", { name: "Quiz me on this." }).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  const follow = page.getByPlaceholder("Follow up…");
  await follow.fill("because?");
  await follow.press("Enter");
  await expect(threadTranscript(page).locator("li")).toHaveCount(4);

  const messages = JSON.parse(
    backend.started[backend.started.length - 1],
  ) as Array<{ role: string; content: string }>;
  expect(messages).toHaveLength(4);
  expect(messages[0].content).toContain("the quick");
  expect(messages[3].content).toBe("because?");
});

test("clicking a mark reopens its thread without a new request", async ({
  page,
}) => {
  const backend = await transcript(page);
  await selectRange(page, 0, 0, 9);
  await page.getByRole("button", { name: "I don't understand this." }).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await selectRange(page, 0, 16, 19);
  await page.getByRole("button", { name: "Quiz me on this." }).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);
  const sent = backend.started.length;

  await page.locator("[data-mark]").first().click();
  await expect(threadTranscript(page).locator("li").first()).toContainText(
    "I don't understand this.",
  );
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);
  expect(backend.started).toHaveLength(sent);
});

const REPLY = "alpha beta gamma delta";

function explainButton(page: Page) {
  return page.getByRole("button", { name: "I don't understand this." });
}

function quizButton(page: Page) {
  return page.getByRole("button", { name: "Quiz me on this." });
}

function deeper(page: Page) {
  return page.getByRole("button", { name: /→/ });
}

function back(page: Page) {
  return page.getByRole("button", { name: "Back" });
}

/** A `start` frame's seed turn - the context, without the ask that follows it. */
function seedOf(backend: { started: string[] }, i: number): string {
  const messages = JSON.parse(backend.started[i]) as Array<{
    content: string;
  }>;
  expect(messages).toHaveLength(2);
  return messages[0].content;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

test("the arrows name the layer and stop at the ends", async ({ page }) => {
  const backend = await fakeBackend(page, ["ok"]);
  backend.release();
  await page.goto("/");

  await expect(back(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Reflect" })).toBeVisible();

  await page.getByRole("button", { name: "Reflect" }).click();
  await expect(deeper(page)).toBeDisabled();
  await expect(back(page)).toBeVisible();

  await back(page).click();
  await expect(back(page)).toBeHidden();
  await expect(page.getByRole("button", { name: "Reflect" })).toBeVisible();
});

test("a thread opened at depth carries both selections once", async ({
  page,
}) => {
  const backend = await transcript(page, [REPLY]);
  await selectRange(page, 0, 0, 9);
  await explainButton(page).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await deeper(page).click();
  await expect(taskTranscript(page).locator("li")).toHaveText([
    /Selected: "the quick"/,
    new RegExp(REPLY),
  ]);

  const sent = backend.started.length;
  await selectRange(page, 1, 0, 5);
  await quizButton(page).click();

  const seed = seedOf(backend, sent);
  expect(occurrences(seed, SENTENCE)).toBe(1);
  expect(seed).toContain("the quick");
  expect(seed).toContain("alpha");
  expect(seed.indexOf("the quick")).toBeLessThan(seed.indexOf("alpha"));

  // Taking the action does not move the panes: the quiz lands on the right.
  await expect(taskTranscript(page).locator("li")).toHaveText([
    /Selected: "the quick"/,
    new RegExp(REPLY),
  ]);
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await deeper(page).click();
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await expect(page.getByText("Layer 3")).toBeVisible();
});

test("a descended thread shows what it was opened from, in its transcript", async ({
  page,
}) => {
  await transcript(page, [REPLY]);
  await selectRange(page, 0, 0, 9);
  await explainButton(page).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await deeper(page).click();
  // Descending makes the learning thread the left pane: its opening ask is a
  // message like any other, so it needs no header of its own.
  await expect(taskTranscript(page).locator("li").first()).toContainText(
    'Selected: "the quick"',
  );
  await expect(taskTranscript(page).locator("li").first()).toContainText(
    "I don't understand this.",
  );
});

test("← climbs back without losing threads or highlights", async ({ page }) => {
  const backend = await transcript(page, [REPLY]);
  await selectRange(page, 0, 0, 9);
  await explainButton(page).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await deeper(page).click();
  await selectRange(page, 1, 0, 5);
  await quizButton(page).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);
  const sent = backend.started.length;

  await back(page).click();
  await expect(page.getByText("Layer 1")).toBeVisible();
  await expect(page.locator("[data-mark]")).toHaveText("the quick");
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await deeper(page).click();
  await expect(page.locator("[data-mark]")).toHaveText("alpha");
  await deeper(page).click();
  await expect(page.getByText("Layer 3")).toBeVisible();
  expect(backend.started).toHaveLength(sent);
});

test("nesting goes three deep", async ({ page }) => {
  const backend = await transcript(page, [REPLY]);
  await selectRange(page, 0, 0, 9);
  await explainButton(page).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await deeper(page).click();
  await selectRange(page, 1, 0, 5);
  await quizButton(page).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);

  await deeper(page).click();
  const sent = backend.started.length;
  await selectRange(page, 1, 6, 10);
  await explainButton(page).click();

  const seed = seedOf(backend, sent);
  expect(occurrences(seed, SENTENCE)).toBe(1);
  expect(occurrences(seed, REPLY)).toBe(2);
  expect(seed).toContain("beta");
});

test("a tool call is rendered and text above it stays selectable", async ({
  page,
}) => {
  await toolBackend(page);
  await page.goto("/");
  await page.getByRole("textbox").fill(SENTENCE);
  await page.getByRole("textbox").press("Enter");

  await expect(taskTranscript(page).locator("li")).toHaveCount(4);
  await expect(page.locator("[data-tool-name]:visible")).toHaveText(
    "read_file",
  );
  await expect(page.locator("[data-tool-input]:visible")).toHaveText(
    '{"path":"a.ts"}',
  );
  await expect(page.locator("[data-tool-result]:visible")).toHaveText(
    /unknown tool: read_file/,
  );

  await page.getByRole("button", { name: "Reflect" }).click();
  await selectRange(page, 1, 0, 5);
  await page.getByRole("button", { name: "I don't understand this." }).click();
  await expect(page.locator("[data-mark]")).toHaveText("alpha");
});

test("a new selection leaves committed marks rendered", async ({ page }) => {
  await transcript(page);
  await selectRange(page, 0, 0, 9);
  await page.getByRole("button", { name: "I don't understand this." }).click();

  await selectRange(page, 0, 20, 25);
  await expect(page.locator("[data-mark]")).toHaveCount(1);
  await expect(page.locator("[data-live]")).toHaveText("jumps");
});

function putNodesEvents(title: string): Anthropic.RawMessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: `put-${title}`,
        name: "put_nodes",
        input: {},
      },
    } as Anthropic.RawMessageStreamEvent,
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify({
          nodes: [{ title, description: "d", notes: "n", level: 2 }],
        }),
      },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" } as Anthropic.RawMessageStreamEvent,
  ];
}
/** Answers every graph update with one `put_nodes` call naming the node by its
 * ordinal, then a yield; `write: false` yields straight away, which is the
 * common case the chip still has to say something about. The first update is
 * gated, so the "working" chip is observable. */
async function chipBackend(page: Page, write = true) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let updates = 0;
  await page.routeWebSocket("**/api/socket", (ws) => {
    ws.onMessage(async (raw) => {
      const message = JSON.parse(String(raw)) as ClientMessage;
      const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
      const replay = (stream: Anthropic.RawMessageStreamEvent[]) => {
        for (const event of stream)
          send({ type: "event", requestId: message.requestId, event });
        send({ type: "done", requestId: message.requestId });
      };
      if (!isGraphUpdate(message)) {
        replay(events(["ok"]));
        return;
      }
      // The second request of an update answers the tool result we just sent.
      const answered = JSON.stringify(message.params.messages).includes(
        "tool_result",
      );
      if (!write || answered) {
        replay(yieldEvents());
        return;
      }
      const ordinal = ++updates;
      if (ordinal === 1) await gate;
      replay(putNodesEvents(`concept-${ordinal}`));
    });
  });
  return { release };
}
function updateStatus(page: Page, index: number) {
  return taskTranscript(page)
    .locator("li")
    .nth(index)
    .locator("[data-update-status]");
}
function changes(page: Page, index: number) {
  return taskTranscript(page).locator("li").nth(index).locator("[data-change]");
}
async function turn(page: Page, text: string) {
  await page.getByRole("textbox").fill(text);
  await page.getByRole("textbox").press("Enter");
}
test("a turn shows its graph update working, then what it changed", async ({
  page,
}) => {
  const backend = await chipBackend(page);
  await page.goto("/");
  await turn(page, "how does backpressure work");
  await expect(updateStatus(page, 0)).toHaveText(
    "updating the knowledge graph…",
  );
  backend.release();
  await expect(changes(page, 0)).toHaveText(['created "concept-1"']);
  await turn(page, "and framing");
  await expect(changes(page, 2)).toHaveText(['created "concept-2"']);
  // Each turn accounts for its own update and no other.
  await expect(changes(page, 0)).toHaveText(['created "concept-1"']);
});
test("the update behind a turn opens its own transcript on the right", async ({
  page,
}) => {
  const backend = await chipBackend(page);
  backend.release();
  await page.goto("/");
  await turn(page, "how does backpressure work");
  await expect(changes(page, 0)).toHaveText(['created "concept-1"']);
  await taskTranscript(page)
    .locator("li")
    .nth(0)
    .locator("[data-update-thread]")
    .click();
  const pane = page.locator("ul").nth(1);
  await expect(pane.locator("[data-tool-name]:visible")).toHaveText([
    "put_nodes",
    "yield",
  ]);
  // Review, not descent: there is nothing to reply to here.
  await expect(page.getByPlaceholder("Follow up…")).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("[data-update-pane-status]")).toHaveCount(0);
});
test("an update that writes nothing says so", async ({ page }) => {
  const backend = await chipBackend(page, false);
  backend.release();
  await page.goto("/");
  await turn(page, "sure, keep going");
  await expect(updateStatus(page, 0)).toHaveText("no knowledge graph changes");
  await expect(changes(page, 0)).toHaveCount(0);
});
