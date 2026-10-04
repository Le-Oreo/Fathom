import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

test("a yellow banner when a newer FATHOM is out, until Later", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#dock");
  await expect(page.locator("#app-update")).toHaveCount(0);
  await page.evaluate(() => window.__fathom.newRelease("9.0.0"));
  await expect(page.locator("#app-update")).toContainText("FATHOM 9.0.0 is out");
  await expect(page.locator("#app-update")).toContainText("You're on 0.1.0");
  await page.click("[data-action='later-app-update']");
  await expect(page.locator("#app-update")).toHaveCount(0);
  await page.reload();
  await page.waitForFunction(() => !!window.__fathom);
  await page.evaluate(() => window.__fathom.newRelease("9.0.0"));
  await expect(page.locator("#app-update")).toHaveCount(0);
  /* a newer one still shows */
  await page.evaluate(() => window.__fathom.newRelease("9.1.0"));
  await expect(page.locator("#app-update")).toContainText("FATHOM 9.1.0 is out");
  expect(errors).toEqual([]);
});
