import { expect, test } from "@playwright/test";
import { open, watch } from "./helpers";

const file = (name: string, kb: number) => ({ name, mimeType: "text/plain", buffer: Buffer.alloc(kb * 1024, 120) });

test("uploads queue up, can be cancelled and retried", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#files");
  await page.setInputFiles("#file-input", [file("first.txt", 4), file("second.txt", 4)]);
  const rows = page.locator("#transfers .transfer");
  /* one runs, the other waits its turn */
  await expect(page.locator("#transfers [data-transfer='queued']")).toContainText("Waiting to upload second.txt");
  const first = page.locator("#transfers [data-transfer='running']").filter({ hasText: "first.txt" });
  await expect(first).toHaveCount(1);

  /* cancel the waiting one, then the running one */
  await page.click("#transfers [data-transfer='queued'] [data-action='cancel-transfer']");
  await first.locator("[data-action='cancel-transfer']").click();
  await expect(rows.filter({ hasText: /Cancelled (first|second)\.txt/ })).toHaveCount(2);
  await expect(page.locator("#file-rows tr[data-file='first.txt']")).toHaveCount(0);

  /* retry one: it goes through */
  await page
    .locator("#transfers [data-transfer='cancelled']")
    .filter({ hasText: "second.txt" })
    .locator("[data-action='retry-transfer']")
    .click();
  await expect(rows.filter({ hasText: "Uploaded second.txt" })).toHaveCount(1, { timeout: 15000 });
  await expect(page.locator("#file-rows tr[data-file='second.txt']")).toHaveCount(1);

  await page.setInputFiles("#file-input", [file("second.txt", 4)]);
  await expect(rows.filter({ hasText: "Already there: second.txt" })).toHaveCount(1, { timeout: 15000 });
  expect(errors).toEqual([]);
});

test("downloads save files and whole folders", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#files");
  /* a file arrives as a browser download */
  const fileRow = page.locator("#file-rows tr[data-dir='0']").first();
  const name = await fileRow.getAttribute("data-file");
  await fileRow.click({ modifiers: ["Control"] });
  const download = page.waitForEvent("download");
  await page.click("[data-action='download']");
  expect((await download).suggestedFilename()).toBe(name);
  const rows = page.locator("#transfers .transfer");
  await expect(rows.filter({ hasText: `Downloaded ${name}` })).toHaveCount(1, { timeout: 15000 });

  /* a folder can be downloaded too now */
  await fileRow.click({ modifiers: ["Control"] }); /* unselect it again */
  const folder = page.locator("#file-rows tr[data-dir='1']").first();
  const folderName = await folder.getAttribute("data-file");
  await folder.click({ modifiers: ["Control"] });
  await page.click("[data-action='download']");
  await expect(rows.filter({ hasText: `Downloaded ${folderName}` })).toHaveCount(1, { timeout: 15000 });
  expect(errors).toEqual([]);
});

test("no SD card: Files says so, and Internal still works", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#files");
  await page.evaluate(() => window.__fathom.setNoSd(true));
  await page.click("#tree [data-drop='/ext']");
  await expect(page.locator("#view-files .empty").first()).toContainText("There's no SD card in the Flipper");
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.click("#tree [data-drop='/int']");
  await expect(page.locator("#view-files .empty").first()).not.toContainText("SD card");
  /* put it back: the SD card lists again */
  await page.evaluate(() => window.__fathom.setNoSd(false));
  await page.click("#tree [data-drop='/ext']");
  await expect(page.locator("#file-rows tr[data-file]").first()).toBeVisible();
  expect(errors).toEqual([]);
});
