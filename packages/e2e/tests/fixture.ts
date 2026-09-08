import { test as base } from "@playwright/test";

/** The app is password gated. Specs are not about the gate, so every page
 * arrives with an accepted password already in hand. */
export const PASSWORD = process.env.APP_PASSWORD ?? "test-password";

export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript((password: string) => {
      window.localStorage.setItem("edulab:password", password);
    }, PASSWORD);
    await use(page);
  },
});

export { expect } from "@playwright/test";
