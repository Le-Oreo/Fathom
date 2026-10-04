import { expect, test } from "@playwright/test";
import { open, view, watch } from "./helpers";

test("channels, release notes and a picked package", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#firmware");
  await expect(page.locator("#fw-install")).toContainText("Install 1.4.0");
  await expect(page.locator("#fw-notes li").first()).toContainText("Placeholder");

  await page.click("input[name='channel'][value='rc']");
  await expect(page.locator("#versions")).toContainText("1.5.0-rc");
  await expect(page.locator("#fw-notes b").first()).toHaveText("1.5.0-rc");
  await expect(page.locator("#fw-install")).toContainText("Install 1.5.0-rc");

  await page.click("input[name='channel'][value='custom']");
  await expect(page.locator("#fw-install")).toBeDisabled();
  await page.click("#fw-pick");
  await expect(page.locator("#versions")).toContainText("f7-update-local.tgz");
  await page.click("#fw-install");
  await expect(page.locator("#dlg-title")).toHaveText("Install f7-update-local.tgz?");
  await expect(page.locator("#dlg-body")).toContainText("Only install packages you trust");
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});

test("a pulled cable stops the install; Retry finishes it", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#firmware");
  await page.uncheck("#fw-backup");
  await page.click("#fw-install");
  await page.click("#dlg-ok");
  await expect(page.locator("#fw-cancel")).toBeVisible();
  /* out during the copy */
  await expect(page.locator("#fw-steps li").nth(3)).toHaveClass(/now/, { timeout: 10000 });
  await page.evaluate(() => window.__fathom.unplug());
  await expect(page.locator("#fw-failed")).toContainText("disconnected");
  await expect(page.locator("#fw-failed")).toContainText("Nothing that matters on the Flipper was changed");
  expect(await view(page)).toBe("firmware");
  await page.evaluate(() => window.__fathom.plug());
  await page.click("#fw-retry");
  await expect(page.locator("#fw-title")).toHaveText("Updating to 1.4.0");
  /* past the point of no return there's no Cancel */
  await expect(page.locator("#fw-steps li").nth(4)).toHaveClass(/now|done/, { timeout: 10000 });
  await expect(page.locator("#fw-cancel")).toHaveCount(0);
  await expect(page.locator("#fw-title")).toHaveText("Up to date", { timeout: 15000 });
  await expect(page.locator("#fw-done .done-card")).toContainText("Nautilus is running 1.4.0");
  expect(await view(page)).toBe("firmware");
  expect(errors).toEqual([]);
});

test("Cancel stops an install before anything is installed, even during the backup first", async ({ page }) => {
  await open(page, "#firmware");
  await page.click("#fw-install");
  await page.click("#dlg-ok");
  await expect(page.locator("#backup-job")).toBeVisible();
  await page.click("#fw-cancel");
  await expect(page.locator(".toast").last()).toContainText("Install cancelled");
  await expect(page.locator("#fw-title")).toHaveText("Ready to install");
});

test("backups: the SD card when asked, and restoring with a restart", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#dock");
  await page.click("[data-action='backup']");
  await expect(page.locator("#dlg-title")).toHaveText("Back up Nautilus?");
  await expect(page.locator("#dlg-check-row")).toContainText("SD card too");
  await page.check("#dlg-check");
  await page.click("#dlg-ok");
  await expect(page.locator(".toast").last()).toContainText("Backed up Nautilus and its SD card");

  /* Restore opens the list on the Firmware page */
  await page.click("[data-action='restore']");
  await expect.poll(() => view(page)).toBe("firmware");
  const rows = page.locator("#backups [data-backup]");
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("SD card copy updated");
  await expect(page.locator("#backups .backup-note")).toContainText("Restoring it never deletes anything");
  await rows.first().locator("[data-action='restore-backup']").click();
  await expect(page.locator("#dlg-title")).toHaveText("Restore Nautilus?");
  await page.check("#dlg-check");
  await page.click("#dlg-ok");
  await expect(page.locator("#backup-job")).toBeVisible();
  await expect(page.locator(".toast").last()).toContainText("Restored the backup", { timeout: 10000 });
  expect(await view(page)).toBe("firmware");
  expect(errors).toEqual([]);
});

test("on other firmware: says which, checks its releases, and warns before replacing it", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#firmware");
  await page.evaluate(() => window.__fathom.setOtherFirmware(true));
  await page.click("[data-action='check-updates']");
  await expect(page.locator("#other-fw")).toContainText("Nautilus is on Momentum mntm-008");
  await expect(page.locator("#other-fw")).toContainText("mntm-009 is out");
  await expect(page.locator("[data-action='copy-fork-link']")).toBeVisible();
  await expect(page.locator("#fw-install")).toContainText("Install official 1.4.0");
  await page.click(".nav a[data-go='dock']");
  await expect(page.locator("#dock-update")).toHaveCount(0);
  await expect(page.locator("#view-dock")).toContainText("mntm-009 is out");
  await page.click(".nav a[data-go='firmware']");
  await page.click("#fw-install");
  await expect(page.locator("#dlg-body")).toContainText(
    "is on Momentum now: this replaces it with the official firmware",
  );
  await page.keyboard.press("Escape");

  /* Momentum's own update, straight from its release page */
  await page.uncheck("#fw-backup");
  await page.click("[data-action='install-fork']");
  await expect(page.locator("#dlg-title")).toHaveText("Install Momentum mntm-009?");
  await expect(page.locator("#dlg-body")).not.toContainText("replaces");
  await page.click("#dlg-ok");
  await expect(page.locator("#fw-title")).toHaveText("Up to date", { timeout: 20000 });
  await expect(page.locator("#other-fw")).toContainText("Momentum mntm-009");
  await expect(page.locator("#other-fw")).toContainText("newest release");
  expect(errors).toEqual([]);
});

test("official to Momentum: pick it as a channel, and it says what it replaces", async ({ page }) => {
  const errors = watch(page);
  await open(page, "#firmware");
  await page.click("input[name='channel'][value='gh:Next-Flip/Momentum-Firmware']");
  await expect(page.locator("#fw-install")).toContainText("Install Momentum mntm-009");
  await page.click("#fw-install");
  await expect(page.locator("#dlg-body")).toContainText(
    "is on the official firmware now: this replaces it with Momentum",
  );
  await page.keyboard.press("Escape");
  expect(errors).toEqual([]);
});
