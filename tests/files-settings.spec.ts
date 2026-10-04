import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { names, open, path, watch } from "./helpers";

test.describe("Files on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("folders, drawer, drag, move, select, edit and palette", async ({ page }) => {
    const errors = watch(page);
    await open(page, "#files");
    await expect.poll(() => path(page)).toBe("/ext/subghz");

    /* open a folder inside a folder with one click */
    await page.click("#file-rows tr[data-file='backups']");
    await expect.poll(() => path(page)).toBe("/ext/subghz/backups");
    await page.click("#file-rows tr[data-file='2026-08']");
    await expect.poll(() => path(page)).toBe("/ext/subghz/backups/2026-08");
    await page.click("#files-up");
    await expect.poll(() => path(page)).toBe("/ext/subghz/backups");
    await page.click("#crumbs button[data-path='/ext']");
    await expect.poll(() => path(page)).toBe("/ext");

    await page.click("#tree [data-twisty='/ext/apps']");
    await page.click("#tree [data-path='/ext/apps/Games']");
    await expect.poll(() => path(page)).toBe("/ext/apps/Games");
    expect(await names(page, "/ext/apps/Games")).toHaveLength(4);

    /* open a file: the details drawer */
    await page.click("#file-rows tr[data-file='snake_game.fap']");
    await expect(page.locator("#viewer")).toHaveAttribute("open", "");
    await expect(page.locator("#vw-name")).toHaveText("snake_game.fap");
    await page.click("[data-vw='close']");
    await expect(page.locator("#viewer")).not.toHaveAttribute("open");

    /* drag a file onto a folder with the mouse */
    await page.click("#tree [data-path='/ext/subghz']");
    await expect.poll(() => path(page)).toBe("/ext/subghz");
    let src = await page.locator("#file-rows tr[data-file='doorbell.sub']").boundingBox();
    let dst = await page.locator("#file-rows tr[data-file='backups']").boundingBox();
    if (!src || !dst) throw new Error("rows missing");
    await page.mouse.move(src.x + 60, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + 80, src.y + 10, { steps: 4 });
    await page.mouse.move(dst.x + 70, dst.y + dst.height / 2, { steps: 8 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await expect.poll(() => names(page, "/ext/subghz/backups")).toContain("doorbell.sub");
    expect(await names(page, "/ext/subghz")).not.toContain("doorbell.sub");
    expect(await path(page)).toBe("/ext/subghz");

    await page.click("#file-rows tr[data-file='ceiling_fan.sub']", { modifiers: ["Control"] });
    await page.click("#file-rows tr[data-file='gate_opener.sub']", { modifiers: ["Control"] });
    expect(await page.evaluate(() => window.__fathom.selected().length)).toBe(2);
    await expect(page.locator("#selbar")).toBeVisible();
    src = await page.locator("#file-rows tr[data-file='gate_opener.sub']").boundingBox();
    dst = await page.locator("#tree [data-path='/ext/infrared']").boundingBox();
    if (!src || !dst) throw new Error("targets missing");
    await page.mouse.move(src.x + 60, src.y + 20);
    await page.mouse.down();
    await page.mouse.move(dst.x + 40, dst.y + 15, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(() => names(page, "/ext/infrared"))
      .toEqual(expect.arrayContaining(["ceiling_fan.sub", "gate_opener.sub"]));

    /* Move to, two levels down */
    await page.click("#file-rows tr[data-file='weather_station.sub'] [data-row='move']");
    await page.click("#mv-list [data-mv='/ext/subghz/backups/2026-08']");
    await page.click("#mv-ok");
    await expect.poll(() => names(page, "/ext/subghz/backups/2026-08")).toContain("weather_station.sub");

    /* move a whole folder: everything inside goes with it */
    await page.click("#crumbs button[data-path='/ext']");
    await page.click("#file-rows tr[data-file='music_player'] [data-row='move']");
    await page.click("#mv-list [data-mv='/ext/apps']");
    await page.click("#mv-ok");
    await expect
      .poll(() => names(page, "/ext/apps/music_player/melodies"))
      .toEqual(["lullaby.fmf", "scale_practice.fmf"]);

    /* new folder, rename, delete */
    await page.click("[data-action='mkdir']");
    await page.fill("#dlg-input", "captures");
    await page.click("#dlg-ok");
    await expect.poll(() => names(page, "/ext")).toContain("captures");
    await page.click("#file-rows tr[data-file='captures'] [data-row='rename']");
    await page.fill("#dlg-input", "my_captures");
    await page.click("#dlg-ok");
    await expect.poll(() => names(page, "/ext")).toContain("my_captures");
    expect(await page.evaluate(() => window.__fathom.hasFolder("/ext/my_captures"))).toBe(true);
    await page.click("#file-rows tr[data-file='my_captures'] [data-row='delete']");
    await page.click("#dlg-ok");
    await expect.poll(() => names(page, "/ext")).not.toContain("my_captures");

    /* grid view, then hidden files */
    await page.click(".ftools [data-val='grid']");
    await expect(page.locator("#fgrid")).toBeVisible();
    await page.click("#fgrid [data-file='apps']");
    await expect.poll(() => path(page)).toBe("/ext/apps");
    await page.click(".ftools [data-val='list']");
    await page.click("#tree [data-path='/int']");
    await expect(page.locator("#file-rows [data-file]")).toHaveCount(0);
    await page.evaluate(() => window.__fathom.setPref("hidden", true));
    await expect(page.locator("#file-rows [data-file]")).toHaveCount(3);
    await page.evaluate(() => window.__fathom.setPref("hidden", false));

    /* sort by size puts the smallest file first */
    await page.click("#tree [data-path='/ext/subghz']");
    await page.click("th[data-sort='size'] .sort");
    const files = await page
      .locator("#file-rows [data-dir='0']")
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.file));
    expect(files[0] === "garage_left.sub" || files[files.length - 1] === "RAW_0042.sub").toBe(true);

    /* upload your own text file, open it, edit it */
    await page.setInputFiles("#file-input", {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Shopping: milk, eggs\n"),
    });
    await expect(page.locator("#file-rows tr[data-file='notes.txt']")).toBeVisible({ timeout: 6000 });
    await page.click("#file-rows tr[data-file='notes.txt']");
    await expect(page.locator("#vw-body")).toContainText("milk");
    await page.click("[data-vw='edit']");
    await page.fill("#vw-edit", "Shopping: milk, eggs, bread\n");
    await page.click("[data-vw='save']");
    await expect(page.locator("#vw-body")).toContainText("bread");
    await page.keyboard.press("Escape");
    await expect(page.locator("#viewer")).not.toHaveAttribute("open");

    /* the palette can jump to a deep folder */
    await page.keyboard.press("Control+k");
    await page.keyboard.type("Tools");
    await page.keyboard.press("Enter");
    await expect.poll(() => path(page)).toBe("/ext/apps/Tools");
    expect(errors).toEqual([]);
  });
});

test.describe("Settings", () => {
  test.use({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });

  test("apply, search, survive a reload, export, import and reset", async ({ page }) => {
    const errors = watch(page);
    await open(page, "#dock");
    await page.click(".nav a[data-go='settings']");
    await page.click("#row-accent [data-val='blue']");
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--orange").trim()),
    ).toBe("#2d8cff");
    await page.click("#row-density [data-val='compact']");
    expect(await page.evaluate(() => document.documentElement.dataset.density)).toBe("compact");
    await page.selectOption("#row-liveColors select", "mono");
    expect(await page.evaluate(() => document.documentElement.dataset.lcd)).toBe("mono");

    await page.fill("#set-find", "drag");
    const shown = await page
      .locator("#set-body .setting")
      .evaluateAll((rows) => rows.filter((r) => !(r as HTMLElement).hidden).map((r) => r.id));
    expect(shown).toEqual(["row-dragMove"]);
    await page.fill("#set-find", "");

    await page.click("[data-set-nav='dolphin']");
    await page.click("#row-dolphin input");
    expect(await page.evaluate(() => document.documentElement.classList.contains("no-dolphin"))).toBe(true);
    expect(
      await page.evaluate(() => getComputedStyle(document.getElementById("buddy-side") as HTMLElement).display),
    ).toBe("none");
    await page.click("#row-dolphin input");
    await page.click("#row-motion [data-val='reduced']");
    expect(await page.evaluate(() => window.__fathom.reduceMotion())).toBe(true);
    expect(await page.evaluate(() => document.documentElement.classList.contains("calm"))).toBe(true);
    await page.click("#row-motion [data-val='system']");
    await page.click("#row-toasts input");
    await page.evaluate(() => window.__fathom.toast("hello"));
    await expect(page.locator("#toasts .toast:not(.out)")).toHaveCount(0);
    await page.click("#row-toasts input");

    /* saved between visits */
    await page.reload();
    await page.waitForFunction(() => !!window.__fathom);
    expect(
      await page.evaluate(() => {
        const p = window.__fathom.prefs();
        return [p.accent, p.density, p.liveColors];
      }),
    ).toEqual(["blue", "compact", "mono"]);
    expect(["settings", "dock"]).toContain(await page.evaluate(() => window.__fathom.view()));

    /* export, import, reset */
    await page.evaluate(() => window.__fathom.show("settings"));
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("[data-action='export-settings']"),
    ]);
    const saved = JSON.parse(readFileSync((await download.path()) as string, "utf8"));
    expect(saved.accent).toBe("blue");
    await page.setInputFiles("#settings-file", {
      name: "s.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify({ accent: "green", fileView: "grid", junk: 1 })),
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const p = window.__fathom.prefs();
          return [p.accent, p.fileView, "junk" in p];
        }),
      )
      .toEqual(["green", "grid", false]);
    await page.click("[data-action='reset-settings']");
    await page.click("#dlg-ok");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const p = window.__fathom.prefs();
          return [p.accent, p.density, p.fileView];
        }),
      )
      .toEqual(["orange", "comfy", "list"]);
    expect(errors).toEqual([]);
  });
});

test.describe("Files on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("tap to open folders, press and hold to drag", async ({ page, context }) => {
    const errors = watch(page);
    await open(page, "#files");
    await page.tap("#file-rows tr[data-file='backups']");
    await expect.poll(() => path(page)).toBe("/ext/subghz/backups");
    await page.tap("#file-rows tr[data-file='2026-08']");
    await expect.poll(() => path(page)).toBe("/ext/subghz/backups/2026-08");
    await page.tap("#files-up");
    await page.tap("#files-up");
    await expect.poll(() => path(page)).toBe("/ext/subghz");

    const src = await page.locator("#file-rows tr[data-file='doorbell.sub']").boundingBox();
    const dst = await page.locator("#file-rows tr[data-file='backups']").boundingBox();
    if (!src || !dst) throw new Error("rows missing");
    const cdp = await context.newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    const sx = src.x + 80,
      sy = src.y + src.height / 2,
      tx = dst.x + 80,
      ty = dst.y + dst.height / 2;
    await touch("touchStart", sx, sy);
    await page.waitForTimeout(600);
    for (let i = 1; i <= 8; i++) {
      await touch("touchMove", sx + ((tx - sx) * i) / 8, sy + ((ty - sy) * i) / 8);
      await page.waitForTimeout(30);
    }
    await touch("touchEnd", tx, ty);
    await expect.poll(() => names(page, "/ext/subghz/backups")).toContain("doorbell.sub");
    expect(errors).toEqual([]);
  });
});
