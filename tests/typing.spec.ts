import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

test("types a name into the Flipper's keyboard, replacing the default", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#screen");
  await page.fill("#type-text", "Front door 2");
  await page.click("[data-action='type-it']");
  await expect(page.locator(".toast").last()).toContainText("asks you to type");

  await page.evaluate(() => window.__fathom.showKeyboard("Untitled"));
  await page.waitForTimeout(300);
  await page.click("[data-action='type-it']");
  await expect(page.locator(".toast").last()).toContainText("Typed “Front door 2”", { timeout: 30000 });
  expect(await page.evaluate(() => window.__fathom.keyboardText())).toBe("Front door 2");

  /* characters it doesn't have are refused up front */
  await page.fill("#type-text", "a.txt");
  await page.click("[data-action='type-it']");
  await expect(page.locator(".toast").last()).toContainText("no “.”");
  expect(errors).toEqual([]);
});
