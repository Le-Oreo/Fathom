import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { open, watch } from "./helpers";

test("hold a key, record a GIF, save a screenshot", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#screen");
  const down = page.locator(".key[data-key='down']");
  const log = page.locator("#rpc-log");

  await page.click(".key[data-key='back']");
  await expect(page.locator("#showing")).toHaveText("the main menu");
  await down.hover();
  await page.mouse.down();
  await expect(down).toHaveClass(/\bdown\b/);
  await page.waitForTimeout(800);
  await page.mouse.up();
  await expect(down).not.toHaveClass(/\bdown\b/);
  await expect(log).toContainText("DOWN, long press");
  await expect(log).not.toContainText("DOWN, short press");

  /* a GIF of the frames that came in */
  await page.click("#rec-btn");
  await page.click(".key[data-key='ok']");
  await page.waitForTimeout(600);
  const gifDownload = page.waitForEvent("download");
  await page.click("#rec-btn");
  const gif = await gifDownload;
  expect(gif.suggestedFilename()).toMatch(/^nautilus-\d{6}\.gif$/);
  const gifBytes = await readFile(await gif.path());
  expect(gifBytes.subarray(0, 6).toString()).toBe("GIF89a");
  await expect(page.locator(".toast").last()).toContainText(".gif");

  /* a PNG at the size from Settings (4x: 512 by 256) */
  const pngDownload = page.waitForEvent("download");
  await page.click("#view-screen [data-action='screenshot']");
  const png = await (await pngDownload).path();
  const pngBytes = await readFile(png);
  expect(pngBytes.subarray(1, 4).toString()).toBe("PNG");
  expect([pngBytes.readUInt32BE(16), pngBytes.readUInt32BE(20)]).toEqual([512, 256]);
  await expect(page.locator("#shots .shot")).toHaveCount(1);
  expect(errors).toEqual([]);
});
