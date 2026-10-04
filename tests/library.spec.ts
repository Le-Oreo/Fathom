import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

test("star and tag saved files, filter by them, keep them through a rename and a reload", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#library");
  const rows = page.locator("#lib-list [data-sig]");
  await rows.first().click();
  const name = (await page.locator("#lib-preview .panel-head h2").textContent())!.trim();

  await page.click("[data-action='star-signal']");
  await expect(page.locator("[data-action='star-signal']")).toHaveAttribute("aria-pressed", "true");
  await page.fill("#lib-tag-add", "Front Door");
  await page.keyboard.press("Enter");
  await expect(page.locator("#lib-tags .tag")).toHaveText(["front door"]);

  /* the filters */
  const total = await rows.count();
  await page.click("#lib-marks [data-mark='starred']");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(name);
  await page.click("#lib-marks [data-mark='front door']");
  await expect(rows).toHaveCount(1);
  await page.click("#lib-marks [data-mark='']");
  await expect(rows).toHaveCount(total);

  await page.reload();
  await page.waitForFunction(() => !!window.__fathom && window.__fathom.view() === "library");
  await page.click("#lib-marks [data-mark='starred']");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(name);
  await rows.first().click();
  /* renamed in FATHOM: the star and tag go with it */
  await page.click("[data-action='rename-signal']");
  await page.fill("dialog[open] input", `renamed_${name}`);
  await page.click("#dlg-ok");
  await expect(page.locator("#lib-preview .panel-head h2")).toHaveText(`renamed_${name}`);
  await expect(page.locator("#lib-tags .tag")).toHaveText(["front door"]);
  await expect(page.locator("[data-action='star-signal']")).toHaveAttribute("aria-pressed", "true");

  expect(errors).toEqual([]);
});
