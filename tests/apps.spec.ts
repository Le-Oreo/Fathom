import { expect, test } from "@playwright/test";
import { open, view, watch } from "./helpers";

test("apps open, missing ones go, installed ones can be opened and removed", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#apps");

  /* RFID: today's firmware calls it "125 kHz RFID" */
  await page.click("#app-grid .app-card:has-text('RFID 125 kHz')");
  await expect.poll(() => view(page)).toBe("screen");
  await page.evaluate(() => window.__fathom.show("apps"));

  /* a firmware without U2F: its tile goes, with a note why */
  await page.evaluate(() => window.__fathom.dropApp("U2F"));
  await page.click("#app-grid .app-card:has-text('U2F')");
  await expect(page.locator(".toast").last()).toContainText("firmware doesn't have U2F");
  await expect(page.locator("#app-grid .app-card:has-text('U2F')")).toHaveCount(0);

  /* installed apps, by name */
  const rows = page.locator("#installed-apps [data-fap]");
  await expect(rows.first()).toBeVisible();
  await expect(page.locator("#installed-apps")).toContainText("Flappy bird");
  await page.locator("#installed-apps [data-fap$='flappy_bird.fap'] [data-action='open-fap']").click();
  await expect(page.locator(".toast").last()).toContainText("flappy_bird.fap");
  const before = await rows.count();
  await page.locator("#installed-apps [data-fap$='snake_game.fap'] [data-action='remove-fap']").click();
  await page.click("#dlg-ok");
  await expect(rows).toHaveCount(before - 1);
  await expect(page.locator("#installed-apps")).not.toContainText("Snake game");
  expect(errors).toEqual([]);
});
