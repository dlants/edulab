import type Anthropic from "@anthropic-ai/sdk";
import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";
import { expect, type Page, test } from "@playwright/test";

const KEY = "edulab:v3:own";

function events(text: string): Anthropic.RawMessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" } as Anthropic.RawMessageStreamEvent,
  ];
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

function isGraphUpdate(message: ClientMessage): boolean {
  return (message.params.tools ?? []).some((t) => t.name === "put_nodes");
}

/** Answers everything, and keeps the counts a reload has to leave alone: the
 * whole point of the snapshot is that a restored interaction is not re-run. */
async function backend(page: Page) {
  const counts = { turns: 0, updates: 0 };
  await page.routeWebSocket("**/api/socket", (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ClientMessage;
      const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
      const update = isGraphUpdate(message);
      if (update) counts.updates++;
      else counts.turns++;
      for (const event of update ? yieldEvents() : events("ok")) {
        send({ type: "event", requestId: message.requestId, event });
      }
      send({ type: "done", requestId: message.requestId });
    });
  });
  return counts;
}

/** The graph the sidebar specs seed, through the same handle. */
async function seedGraph(page: Page) {
  await page.evaluate(() => {
    const graph = (
      window as unknown as {
        __graph: {
          putNode(n: {
            title: string;
            description: string;
            notes: string;
            level: number;
          }): unknown;
        };
      }
    ).__graph;
    graph.putNode({
      title: "closures",
      description: "a function plus its environment",
      notes: "",
      level: 2,
    });
  });
}

function taskTranscript(page: Page) {
  return page.locator("ul").first();
}

function threadTranscript(page: Page) {
  return page.locator("ul").nth(1);
}

function graphTab(page: Page) {
  return page.getByRole("button", { name: "Knowledge graph", exact: true });
}

/** The write is debounced off the streaming path, so a reload has to wait for
 * it to land. */
async function settled(page: Page) {
  await expect
    .poll(() => page.evaluate((key) => localStorage.getItem(key), KEY))
    .not.toBeNull();
  await page.waitForTimeout(600);
}

/** Selects characters [start, end) of message `msg`, as the app captures it. */
async function selectRange(
  page: Page,
  msg: number,
  start: number,
  end: number,
) {
  await page.evaluate(
    ({ msg, start, end }) => {
      const li = document.querySelectorAll("ul")[0].children[msg];
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

const SENTENCE = "the quick brown fox jumps over the lazy dog";

test("a reload keeps the transcript, the graph and the update chips", async ({
  page,
}) => {
  const counts = await backend(page);
  await page.goto("/");
  await page.getByRole("textbox").fill(SENTENCE);
  await page.getByRole("textbox").press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await expect(page.getByText("no knowledge graph changes")).toBeVisible();
  await seedGraph(page);
  await graphTab(page).click();
  await expect(page.locator("[data-node]")).toHaveCount(1);
  await settled(page);
  const before = { ...counts };

  await page.reload();
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await expect(taskTranscript(page).locator("li").first()).toContainText(
    SENTENCE,
  );
  await expect(page.getByText("no knowledge graph changes")).toBeVisible();
  await graphTab(page).click();
  await expect(page.locator("[data-node]")).toHaveText(["closures"]);
  // Nothing was re-sent: the restored turn already had its update.
  expect(counts).toEqual(before);
});

test("a reload keeps a learning thread behind its mark", async ({ page }) => {
  await backend(page);
  await page.goto("/");
  await page.getByRole("textbox").fill(SENTENCE);
  await page.getByRole("textbox").press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await page.getByRole("button", { name: "Reflect" }).click();
  await selectRange(page, 0, 4, 19);
  await page.getByRole("button", { name: "I don't understand this." }).click();
  await expect(threadTranscript(page).locator("li")).toHaveCount(2);
  await settled(page);

  await page.reload();
  await page.getByRole("button", { name: "Reflect" }).click();
  await expect(page.locator("[data-mark]")).toHaveText("quick brown fox");
  await page.locator("[data-mark]").click();
  await expect(threadTranscript(page).locator("li")).toHaveText([
    /quick brown fox/,
    /ok/,
  ]);
});

test("an interaction whose update never finished is re-enqueued", async ({
  page,
}) => {
  const counts = await backend(page);
  await page.goto("/");
  await page.getByRole("textbox").fill(SENTENCE);
  await page.getByRole("textbox").press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await expect(page.getByText("no knowledge graph changes")).toBeVisible();
  await settled(page);
  // What a refresh mid-update leaves behind: the turn, without its record.
  await page.evaluate((key) => {
    const snapshot = JSON.parse(localStorage.getItem(key) as string) as {
      updates: unknown[];
    };
    snapshot.updates = [];
    localStorage.setItem(key, JSON.stringify(snapshot));
  }, KEY);
  const before = counts.updates;

  await page.reload();
  await expect(page.getByText("no knowledge graph changes")).toBeVisible();
  await expect.poll(() => counts.updates).toBe(before + 1);
  expect(counts.turns).toBe(1);
});

test("a build interrupted by a refresh resumes where it stopped", async ({
  page,
}) => {
  const counts = await backend(page);
  await page.goto("/");
  const sample = await page
    .locator("select option")
    .nth(1)
    .getAttribute("value");
  await page.goto(`/?sample=${sample}`);
  const turns = await taskTranscript(page).locator("li").count();
  // Nothing is saved until something happens, so nudge one dispatch through.
  await graphTab(page).click();
  const key = `edulab:v3:${sample}`;
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), key))
    .not.toBeNull();
  await page.waitForTimeout(600);
  const total = await page.evaluate((k) => {
    const snapshot = JSON.parse(localStorage.getItem(k) as string) as {
      build: unknown;
      threads: { log: { role: string }[] }[];
    };
    const asks = snapshot.threads[0].log.filter(
      (t) => t.role === "user",
    ).length;
    snapshot.build = { type: "running", done: 0, total: asks, failures: [] };
    localStorage.setItem(k, JSON.stringify(snapshot));
    return asks;
  }, key);
  expect(total).toBeGreaterThan(1);

  await page.reload();
  await expect(page.getByText("built", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  expect(counts.updates).toBe(total);
  // The transcript is the sample's, untouched: a resume sends no user turns.
  expect(counts.turns).toBe(0);
  await expect(taskTranscript(page).locator("li")).toHaveCount(turns);
});

test("an unreadable snapshot is dropped and the app comes up bare", async ({
  page,
}) => {
  await backend(page);
  await page.addInitScript(
    ([key]) => {
      localStorage.setItem(key, "{ not json");
    },
    [KEY],
  );
  await page.goto("/");
  await expect(taskTranscript(page).locator("li")).toHaveCount(0);
  await graphTab(page).click();
  await expect(page.locator("[data-node]")).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), KEY)).not.toBe(
    "{ not json",
  );
});

test("Reset clears this sample's state for good", async ({ page }) => {
  await backend(page);
  await page.goto("/");
  await page.getByRole("textbox").fill(SENTENCE);
  await page.getByRole("textbox").press("Enter");
  await expect(taskTranscript(page).locator("li")).toHaveCount(2);
  await seedGraph(page);
  await settled(page);
  await page.locator("summary").click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(taskTranscript(page).locator("li")).toHaveCount(0);
  await graphTab(page).click();
  await expect(page.locator("[data-node]")).toHaveCount(0);
  await page.reload();
  await expect(taskTranscript(page).locator("li")).toHaveCount(0);
  await graphTab(page).click();
  await expect(page.locator("[data-node]")).toHaveCount(0);
});
