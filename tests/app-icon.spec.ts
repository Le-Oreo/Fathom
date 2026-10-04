import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

test("app icon: colours, this month's holidays, and back to the colour when the month ends", async ({ page }) => {
  const errors = watch(page);
  await page.clock.install({ time: new Date(2026, 9, 30, 12) });
  await open(page, "#settings");
  const tiles = page.locator("#row-appIcon .app-icon");
  const favicon = () => page.locator("link[rel~='icon']").getAttribute("href");

  /* October: the colours, then Halloween */
  await expect(tiles).toHaveCount(8);
  await expect(page.locator("#row-appIcon .app-icons-sep")).toHaveText("This month");
  await expect(tiles.last()).toHaveAttribute("aria-label", "Halloween");
  await expect(page.locator("#row-appIcon [aria-checked='true']")).toHaveAttribute("data-val", "classic");

  await page.click("#row-appIcon [data-val='teal']");
  await expect(page.locator("#row-appIcon [aria-checked='true']")).toHaveAttribute("data-val", "teal");
  await expect.poll(favicon).toContain("teal");

  await page.click("#row-appIcon [data-val='halloween']");
  await expect(page.locator("#row-appIcon [aria-checked='true']")).toHaveAttribute("data-val", "halloween");
  await expect.poll(favicon).toContain("halloween");
  expect(await page.evaluate(() => window.__fathom.prefs()._holidayIcon)).toBe("halloween@2026-10");

  await page.clock.fastForward("48:00:00");
  await expect(tiles.last()).toHaveAttribute("aria-label", "Thanksgiving");
  await expect(page.locator("#row-appIcon [aria-checked='true']")).toHaveAttribute("data-val", "teal");
  await expect.poll(favicon).toContain("teal");
  expect(errors).toEqual([]);
});
