import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

test("About shows the version and licences; diagnostics copy", async ({ page, context }) => {
  const errors = watch(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await open(page, "#settings");
  await page.fill("#set-find", "licences");
  await expect(page.locator("#licences")).toContainText("SIL Open Font License");
  await expect(page.locator("#licences")).toContainText("Lucide icons: ISC License");
  await expect(page.locator("#set-about")).toContainText("Fathom 0.1.0");
  await page.fill("#set-find", "diagnostics");
  await page.click("[data-action='copy-diagnostics']");
  await expect(page.locator(".toast").last()).toContainText("Copied the diagnostics");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("FATHOM 0.1.0");
  expect(text).toContain("Connection: connected");
  expect(errors).toEqual([]);
});

test("the Flipper's clock is set when it connects, and on Set now", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#settings");
  await page.fill("#set-find", "clock");
  await expect(page.locator("#flipper-clock")).toContainText(
    /It was 1 min 2\d s behind, and was set from this computer/,
  );
  await page.click("[data-action='set-clock']");
  await expect(page.locator(".toast").last()).toContainText("Set the Flipper's clock");
  await expect(page.locator("#flipper-clock")).toContainText("right on time");
  expect(errors).toEqual([]);
});
