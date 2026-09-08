import { expect, test } from "./fixture.ts";

// Guards against the scripted stream in chat.spec.ts drifting from the SDK.
test.skip(
  !process.env.ANTHROPIC_API_KEY,
  "requires ANTHROPIC_API_KEY for the real backend",
);

test("streams a real response end to end", async ({ page }) => {
  await page.goto("/");
  const input = page.getByRole("textbox");
  await input.fill("Reply with exactly the word: pong");
  await input.press("Enter");

  await expect(page.locator('[data-role="assistant"]')).toContainText("pong", {
    timeout: 30_000,
  });
  await expect(input).toBeEnabled({ timeout: 30_000 });
});
