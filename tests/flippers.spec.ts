import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

test("switch to another Flipper that's plugged in, and back", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#dock");
  /* one Flipper: the pill is just a pill */
  await expect(page.locator("[data-action='pick-flipper']")).toHaveCount(0);
  await page.evaluate(() => window.__fathom.plug(["Orca"]));
  await page.click("[data-action='pick-flipper']");
  const menu = page.locator("#flipper-menu");
  await expect(menu.locator("button.on")).toContainText("Nautilus");
  await menu.locator("button:has-text('Orca')").click();
  await expect(page.locator(".toast").last()).toContainText("Connected to Orca");
  await expect(page.locator("#conn")).toContainText("Orca");
  /* both remembered now; back to the first */
  await page.click("[data-action='pick-flipper']");
  await expect(menu.locator("button.on")).toContainText("Orca");
  await menu.locator("button:has-text('Nautilus')").click();
  await expect(page.locator("#conn")).toContainText("Nautilus");
  /* Orca unplugged: remembered, with when it was last seen */
  await page.evaluate(() => window.__fathom.plug([]));
  await page.click("[data-action='pick-flipper']");
  await expect(menu.locator("[data-known]")).toContainText("Orca");
  await expect(menu.locator("[data-known]")).toContainText("Last seen");
  expect(errors).toEqual([]);
});
