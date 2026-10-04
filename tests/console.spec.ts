import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

const rows = (page: import("@playwright/test").Page) => page.locator("#term-out .xterm-rows");

test("type, recall, save, leave and come back", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#console");
  await expect(page.locator("#term-state")).toHaveText("Attached");
  await expect(page.locator("#rpc-log")).toContainText("stop_session");

  await page.click("#term-out");
  await page.keyboard.type("info devcie");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Backspace");
  await page.keyboard.type("vice");
  await page.keyboard.press("Enter");
  await expect(rows(page)).toContainText(/hardware_name[\s\S]*>: info device[\s\S]*hardware_name\s+:\s+Nautilus/);

  /* Up brings the last command back; Enter runs it again */
  await page.click("[data-cmd='date']");
  await page.click("#term-out");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(rows(page)).toContainText(/info device[\s\S]*date[\s\S]*info device/);

  await page.keyboard.type("free");
  await page.click("[data-action='save-command']");
  await expect(page.locator("[data-cmd='free'][data-saved]")).toHaveCount(0);
  await page.click("#term-out");
  await page.keyboard.press("Control+c");
  await page.keyboard.type("vibro 1");
  await page.click("[data-action='save-command']");
  await expect(page.locator("[data-cmd='vibro 1'][data-saved]")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("[data-cmd='vibro 1'][data-saved]")).toHaveCount(1);
  await page.click("[aria-label='Remove vibro 1']");
  await expect(page.locator("[data-cmd='vibro 1'][data-saved]")).toHaveCount(0);

  /* leaving hands the Flipper back: Files works again */
  await expect(page.locator("#term-state")).toHaveText("Attached");
  await page.click(".nav a[data-go='files']");
  await expect(page.locator("#rpc-log")).toContainText("start_rpc_session");
  await expect(page.locator("#file-rows tr[data-file='doorbell.sub']")).toBeVisible();
  await expect(page.locator("#view-files .console-banner")).toHaveCount(0);
  expect(errors).toEqual([]);
});
