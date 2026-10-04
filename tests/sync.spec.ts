import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

test("link, preview, sync, and remove only what was agreed", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#files");
  /* sync into the folder that's open (/ext/subghz) */
  await expect.poll(() => page.evaluate(() => window.__fathom.path())).toBe("/ext/subghz");
  await page.click("[data-action='link-folder']");
  const link = page.locator("#folder-sync [data-link]");
  await expect(link).toHaveCount(1);
  await expect(link).toContainText("Documents/flipper-notes");

  await link.locator("[data-action='sync-folder']").click();
  await expect(page.locator("#dlg-title")).toHaveText(/Copy 2 files to/);
  await expect(page.locator("#dlg-body")).toContainText("New: lists/shopping.txt, todo.txt");
  await expect(page.locator("#dlg-check")).not.toBeChecked();
  await page.click("#dlg-ok");
  await expect(page.locator("#transfers")).toContainText("2 copied", { timeout: 10000 });
  await expect(page.locator("#file-rows tr[data-file='todo.txt']")).toHaveCount(1);
  await expect(page.locator("#file-rows tr[data-file='doorbell.sub']")).toHaveCount(1);

  await link.locator("[data-action='sync-folder']").click();
  await expect(page.locator("#dlg-body")).toContainText("Only on the Flipper");
  await page.check("#dlg-check");
  await page.click("#dlg-ok");
  await expect(page.locator("#dlg-title")).toHaveText(/Remove \d+ files? from the Flipper\?/);
  await page.keyboard.press("Escape");
  await expect(page.locator("#file-rows tr[data-file='doorbell.sub']")).toHaveCount(1);
  expect(errors).toEqual([]);
});
