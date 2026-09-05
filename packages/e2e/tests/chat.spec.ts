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
      const root = li.lastElementChild as HTMLElement;
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
async function transcript(page: Page) {
  const backend = await fakeBackend(page, ["ok"]);
  backend.release();
  await page.goto("/");
  await page.getByRole("textbox").fill(SENTENCE);
  await page.getByRole("textbox").press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: "Switch to learning mode" }).click();
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

test("a second turn sends the full conversation", async ({ page }) => {
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
  const quote = page.locator("blockquote");

  await selectRange(page, 0, 0, 9);
  await explain.click();
  await selectRange(page, 0, 16, 19);
  await page.getByRole("button", { name: "Quiz me on this." }).click();

  const marks = page.locator("[data-mark]");
  await expect(marks).toHaveCount(2);
  await expect(marks.nth(0)).toHaveText("the quick");
  await expect(marks.nth(1)).toHaveText("fox");

  await marks.nth(0).click();
  await expect(quote).toHaveText("the quick");
  await marks.nth(1).click();
  await expect(quote).toHaveText("fox");
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
  expect(messages).toHaveLength(1);
  expect(messages[0].role).toBe("user");
  expect(messages[0].content).toContain("quick brown fox");

  await expect(threadTranscript(page).locator("li")).toHaveText([/ok/]);
  await expect(page.locator("[data-mark]")).toHaveText("quick brown fox");
});

test("a follow-up in the thread pane re-sends the seed", async ({ page }) => {
  const backend = await transcript(page);
  await selectRange(page, 0, 0, 9);
  await page.getByRole("button", { name: "Quiz me on this." }).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(1);

  const follow = page.getByPlaceholder("Follow up…");
  await follow.fill("because?");
  await follow.press("Enter");
  await expect(threadTranscript(page).locator("li")).toHaveCount(3);

  const messages = JSON.parse(
    backend.started[backend.started.length - 1],
  ) as Array<{ role: string; content: string }>;
  expect(messages).toHaveLength(3);
  expect(messages[0].content).toContain("the quick");
  expect(messages[2].content).toBe("because?");
});

test("clicking a mark reopens its thread without a new request", async ({
  page,
}) => {
  const backend = await transcript(page);
  await selectRange(page, 0, 0, 9);
  await page.getByRole("button", { name: "I don't understand this." }).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(1);

  await selectRange(page, 0, 16, 19);
  await page.getByRole("button", { name: "Quiz me on this." }).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(1);
  const sent = backend.started.length;

  await page.locator("[data-mark]").first().click();
  await expect(page.locator("blockquote")).toHaveText("the quick");
  await expect(threadTranscript(page).locator("li")).toHaveCount(1);
  expect(backend.started).toHaveLength(sent);
});

test("a new selection leaves committed marks rendered", async ({ page }) => {
  await transcript(page);
  await selectRange(page, 0, 0, 9);
  await page.getByRole("button", { name: "I don't understand this." }).click();

  await selectRange(page, 0, 20, 25);
  await expect(page.locator("[data-mark]")).toHaveCount(1);
  await expect(page.locator("[data-live]")).toHaveText("jumps");
});
