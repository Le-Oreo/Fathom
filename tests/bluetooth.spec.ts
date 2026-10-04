import { expect, test } from "@playwright/test";
import { open, view, watch } from "./helpers";

test("connects over Bluetooth when unplugged, and the Console asks for the cable", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#dock");
  await page.evaluate(() => window.__fathom.setPref("bluetooth", true));
  await page.evaluate(() => window.__fathom.unplug());
  await expect(page.locator("#conn")).toContainText("Bluetooth", { timeout: 10000 });
  await expect(page.locator("#conn")).toContainText("Nautilus");
  await page.evaluate(() => window.__fathom.show("files"));
  await expect(page.locator("#file-rows tr[data-file='doorbell.sub']")).toBeVisible();
  await page.evaluate(() => window.__fathom.show("console"));
  await expect(page.locator("#term-problem")).toContainText("needs the USB cable");
  expect(await view(page)).toBe("console");
  expect(errors).toEqual([]);
});

test("Pair over Bluetooth turns the setting on and says how", async ({ page }) => {
  await open(page, "#dock");
  await page.evaluate(() => window.__fathom.setPref("autoConnect", false));
  await page.evaluate(() => window.__fathom.unplug());
  await expect.poll(() => view(page)).toBe("connect");
  await page.click("[data-action='bluetooth']");
  await expect(page.locator(".toast").last()).toContainText("Pair the Flipper");
  await expect(page.locator("#ble-help")).toBeVisible();
  expect(await page.evaluate(() => window.__fathom.prefs().bluetooth)).toBe(true);
});
