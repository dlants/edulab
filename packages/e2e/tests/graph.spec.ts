import type { ClientMessage, ServerFrame } from "@edulab/iso/protocol.ts";
import { expect, type Page, test } from "@playwright/test";

/** Answers every request with a one-word reply: this spec is about the graph
 * tab, and the transcript only has to exist. */
async function backend(page: Page) {
  await page.routeWebSocket("**/api/socket", (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ClientMessage;
      const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
      send({
        type: "event",
        requestId: message.requestId,
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "ok", citations: null },
        },
      });
      send({
        type: "event",
        requestId: message.requestId,
        event: { type: "content_block_stop", index: 0 },
      });
      send({ type: "done", requestId: message.requestId });
    });
  });
}

/** The sidebar cases want a known graph without an extraction run first,
 * so they seed it through the handle the prototype exposes. */
async function seed(page: Page) {
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
          putEdge(e: {
            from: string;
            to: string;
            title: string;
            description: string;
          }): unknown;
        };
      }
    ).__graph;
    graph.putNode({
      title: "closures",
      description: "a function plus its environment",
      notes: "asked about capture twice",
      level: 2,
    });
    graph.putNode({
      title: "scope",
      description: "where a binding is visible",
      notes: "",
      level: 3,
    });
    graph.putEdge({
      from: "n0",
      to: "n1",
      title: "builds on",
      description: "a closure captures a scope",
    });
  });
}

function graphTab(page: Page) {
  return page.getByRole("button", { name: "Knowledge graph" });
}

function threadsTab(page: Page) {
  return page.getByRole("button", { name: "Threads", exact: true });
}

function nodes(page: Page) {
  return page.locator("[data-node]");
}

async function open(page: Page) {
  await backend(page);
  await page.goto("/");
  await seed(page);
  await graphTab(page).click();
}

test("switching tabs leaves the transcript and the graph intact", async ({
  page,
}) => {
  await backend(page);
  await page.goto("/");
  await page.getByRole("textbox").fill("hello");
  await page.getByRole("textbox").press("Enter");
  await expect(page.locator("ul").first().locator("li")).toHaveCount(2);
  await seed(page);

  await graphTab(page).click();
  await expect(nodes(page)).toHaveCount(2);
  await expect(page.locator("[data-edge]")).toHaveCount(1);

  await threadsTab(page).click();
  await expect(page.locator("ul").first().locator("li")).toHaveCount(2);

  await graphTab(page).click();
  await expect(nodes(page)).toHaveCount(2);
});

test("clicking a node fills the sidebar and a retitle keeps its edges", async ({
  page,
}) => {
  await open(page);
  await nodes(page).filter({ hasText: "closures" }).click();

  await expect(page.locator("[data-graph-title]")).toHaveValue("closures");
  await expect(page.locator("[data-graph-description]")).toHaveValue(
    "a function plus its environment",
  );
  await expect(page.locator("[data-graph-notes]")).toHaveValue(
    "asked about capture twice",
  );
  await expect(page.locator("[data-graph-level]")).toHaveValue("2");

  await page.locator("[data-graph-title]").fill("lexical closures");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(nodes(page)).toHaveText(["lexical closures", "scope"]);
  await expect(page.locator("[data-edge]")).toHaveCount(1);
  await expect(page.locator("[data-edge-label]")).toHaveText("builds on");
});

test("a duplicate title is rejected without losing the draft", async ({
  page,
}) => {
  await open(page);
  await nodes(page).filter({ hasText: "closures" }).click();
  await page.locator("[data-graph-title]").fill("scope");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.locator("[data-graph-error]")).toHaveText(/already used/);
  await expect(page.locator("[data-graph-title]")).toHaveValue("scope");
  await expect(nodes(page)).toHaveText(["closures", "scope"]);
});

test("deleting a node takes its edges with it", async ({ page }) => {
  await open(page);
  await nodes(page).filter({ hasText: "closures" }).click();
  await page.getByRole("button", { name: "Delete" }).click();

  await expect(nodes(page)).toHaveText(["scope"]);
  await expect(page.locator("[data-edge]")).toHaveCount(0);
  await expect(page.getByText("Click a node or an edge")).toBeVisible();
});

test("an edge is selectable and editable", async ({ page }) => {
  await open(page);
  await page.locator("[data-edge-label]").click();

  await expect(page.locator("[data-graph-title]")).toHaveValue("builds on");
  await expect(page.locator("[data-graph-notes]")).toBeHidden();

  await page.locator("[data-graph-title]").fill("requires");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("[data-edge-label]")).toHaveText("requires");
});

/** Answers the extraction thread's requests with a `put_nodes` call, then a
 * `put_edges` call, then prose - the shape of a real extraction pass, so the
 * spec exercises tools -> graph -> layout -> canvas end to end. */
async function extractionBackend(page: Page) {
  await page.routeWebSocket("**/api/socket", (ws) => {
    let calls = 0;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as ClientMessage;
      const send = (frame: ServerFrame) => ws.send(JSON.stringify(frame));
      const extraction = (message.params.tools ?? []).some(
        (t) => t.name === "put_nodes",
      );
      const step = extraction ? calls++ : -1;
      const call =
        step === 0
          ? {
              name: "put_nodes",
              input: {
                nodes: [
                  {
                    title: "closures",
                    description: "a function plus its environment",
                    notes: "asked twice",
                    level: 2,
                  },
                  {
                    title: "scope",
                    description: "where a binding is visible",
                    notes: "",
                    level: 3,
                  },
                ],
              },
            }
          : step === 1
            ? {
                name: "put_edges",
                input: {
                  edges: [
                    {
                      from: "n0",
                      to: "n1",
                      title: "builds on",
                      description: "a closure captures a scope",
                    },
                  ],
                },
              }
            : null;
      if (call) {
        send({
          type: "event",
          requestId: message.requestId,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: `call-${step}`,
              name: call.name,
              input: {},
            },
          } as never,
        });
        send({
          type: "event",
          requestId: message.requestId,
          event: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(call.input),
            },
          },
        });
      } else {
        send({
          type: "event",
          requestId: message.requestId,
          event: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "ok", citations: null },
          },
        });
      }
      send({
        type: "event",
        requestId: message.requestId,
        event: { type: "content_block_stop", index: 0 },
      });
      // A `done` without a `message_stop` is a truncated turn, which the
      // thread treats as an error: a tool call has to be committed properly
      // for the loop to run it.
      send({
        type: "event",
        requestId: message.requestId,
        event: { type: "message_stop" } as never,
      });
      send({ type: "done", requestId: message.requestId });
    });
  });
}

test("building from the session fills the canvas and leaves the threads alone", async ({
  page,
}) => {
  await extractionBackend(page);
  await page.goto("/");
  await page.getByRole("textbox").fill("hello");
  await page.getByRole("textbox").press("Enter");
  await expect(page.locator("ul").first().locator("li")).toHaveCount(2);

  await graphTab(page).click();
  await page.getByRole("button", { name: "Build from this session" }).click();

  await expect(nodes(page)).toHaveText(["closures", "scope"]);
  await expect(page.locator("[data-edge-label]")).toHaveText("builds on");
  await expect(page.getByRole("button", { name: "Rebuild" })).toBeVisible();

  await threadsTab(page).click();
  await expect(page.locator("ul").first().locator("li")).toHaveCount(2);
});
