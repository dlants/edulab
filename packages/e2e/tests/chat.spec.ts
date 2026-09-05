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
  await expect(page.locator("li")).toHaveCount(2);
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
  await expect(page.locator("li")).toHaveCount(2);

  await input.fill("second");
  await input.press("Enter");
  await expect(page.locator("li")).toHaveCount(4);

  expect(backend.started).toHaveLength(2);
  expect(JSON.parse(backend.started[1])).toHaveLength(3);
});
