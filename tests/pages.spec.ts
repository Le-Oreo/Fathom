import { expect, test } from "@playwright/test";
import { open, view, watch } from "./helpers";

test.describe("Every page on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("launch, keys, palette, dialogs, firmware, console, connect", async ({ page }) => {
    test.setTimeout(60000);
    const errors = watch(page);
    await open(page, "", { splash: true });
    await expect(page.locator("#splash")).toBeVisible();
    await expect(page.locator("#splash-status")).toContainText("Connected to Nautilus", { timeout: 3000 });
    await expect(page.locator("#splash")).toBeHidden({ timeout: 4000 });
    expect(
      Number(await page.locator("#view-dock .scr").evaluate((e) => (e as HTMLElement).style.getPropertyValue("--k"))),
    ).toBeGreaterThanOrEqual(2);
    expect(
      Number(await page.locator("#device-card .scr").evaluate((e) => (e as HTMLElement).style.getPropertyValue("--k"))),
    ).toBeLessThan(2);

    /* the keys move through the Flipper's menu */
    await page.click(".nav a[data-go='screen']");
    await expect(page.locator("#showing")).toHaveText("Sub-GHz");
    await page.click(".key[data-key='back']");
    await expect(page.locator("#showing")).toHaveText("the main menu");
    await page.click(".key[data-key='down']");
    await page.click(".key[data-key='down']");
    await page.mouse.click(700, 120);
    await page.keyboard.press("Enter");
    await expect(page.locator("#showing")).toHaveText("NFC");

    await page.click("[data-action='pause']");
    await expect(page.locator("#stream-chip")).toHaveText("Paused");
    await expect(page.locator("#pause-btn")).toHaveClass(/latched/);
    await page.click("[data-action='pause']");
    await expect(page.locator("#stream-chip")).toHaveText("Live");
    await page.click("#rec-btn");
    await page.waitForTimeout(1300);
    await expect(page.locator("#rec-btn")).toContainText("0:01");
    await expect(page.locator("#rec-btn")).toContainText("Stop");
    await page.click("#rec-btn");
    await expect(page.locator("#rec-btn")).toContainText("Record GIF");
    await page.click("#view-screen [data-action='screenshot']");
    await expect(page.locator("#shots .shot")).toHaveCount(1);

    await page.click(".nav a[data-go='apps']");
    await expect(page.locator("#app-grid .app-card")).toHaveCount(9);
    await page.click(".nav a[data-go='library']");
    await page.click("#lib-list [data-sig='2']");
    await expect(page.locator("#lib-preview .panel-head h2")).toHaveText("gate_opener.sub");
    await page.fill("#lib-search", "garage");
    await expect(page.locator("#lib-list .item")).toHaveCount(1);
    await page.fill("#lib-search", "");
    await page.click("[data-action='rename-signal']");
    await expect(page.locator("#dlg")).toHaveAttribute("open", "");
    await page.keyboard.press("Escape");
    await expect(page.locator("#dlg")).not.toHaveAttribute("open");

    await page.click(".nav a[data-go='files']");
    await page.hover("#file-rows tr[data-file='doorbell.sub']");
    await expect(page.locator("#file-rows tr[data-file='doorbell.sub'] .row-tools")).toHaveCSS("opacity", "1");

    /* firmware: confirm, watch the steps, finish */
    await page.click(".nav a[data-go='firmware']");
    await page.click("#fw-install");
    await expect(page.locator("#dlg-title")).toHaveText("Install firmware 1.4.0?");
    await page.click("#dlg-ok");
    await expect(page.locator("#fw-title")).toHaveText("Updating to 1.4.0");
    await page.click(".nav a[data-go='dock']");
    await page.click(".nav a[data-go='firmware']");
    await expect(page.locator("#fw-title")).toHaveText("Up to date", { timeout: 15000 });
    await expect(page.locator("#versions")).toContainText("Up to date");
    await expect(page.locator("#fw-done .done-card")).toContainText("Nautilus is running 1.4.0");

    await page.click(".nav a[data-go='console']");
    await expect(page.locator("#term-state")).toHaveText("Attached");
    await page.click("#term-out");
    await page.keyboard.type("storage list /ext/subghz");
    await page.keyboard.press("Enter");
    await expect(page.locator("#term-out .xterm-rows")).toContainText("[F] RAW_0042.sub 12 KB");

    await page.keyboard.press("Control+k");
    await page.keyboard.type("gate");
    await page.keyboard.press("Enter");
    await expect.poll(() => view(page)).toBe("library");
    await expect(page.locator("#lib-preview .panel-head h2")).toHaveText("gate_opener.sub");

    await page.click(".nav a[data-go='settings']");
    await page.evaluate(() => window.__fathom.setPref("autoConnect", false));
    await page.evaluate(() => window.__fathom.unplug());
    await expect.poll(() => view(page)).toBe("settings");
    await page.evaluate(() => window.__fathom.show("dock"));
    await expect.poll(() => view(page)).toBe("connect");
    await expect(page.locator("#conn")).toContainText("No Flipper");
    await page.evaluate(() => window.__fathom.plug());
    await expect.poll(() => view(page)).toBe("connect");
    await page.click("[data-action='reconnect']");
    await expect.poll(() => view(page)).toBe("dock");
    await page.keyboard.press("2");
    await expect.poll(() => view(page)).toBe("screen");
    expect(errors).toEqual([]);
  });

  test("connect page: plain errors, and asking which Flipper", async ({ page }) => {
    const errors = watch(page);
    await open(page);
    const note = page.locator("#view-connect .note[role='alert']");

    await page.evaluate(() => window.__fathom.unplug());
    await expect.poll(() => view(page)).toBe("connect");
    await page.evaluate(() => window.__fathom.failConnects("port-busy"));
    await page.evaluate(() => window.__fathom.plug());
    await expect(note).toContainText("Another app is using the Flipper");
    await expect.poll(() => view(page)).toBe("connect");
    /* the other app is closed: Scan again connects */
    await page.evaluate(() => window.__fathom.failConnects(null));
    await page.click("[data-action='reconnect']");
    await expect.poll(() => view(page)).toBe("dock");

    /* a port that never answers */
    await page.evaluate(() => window.__fathom.unplug());
    await page.evaluate(() => window.__fathom.failConnects("no-answer"));
    await page.evaluate(() => window.__fathom.plug());
    await expect(note).toContainText("doesn't answer");
    await page.evaluate(() => window.__fathom.failConnects(null));

    await page.evaluate(() => window.__fathom.unplug());
    await page.evaluate(() => window.__fathom.plug(["Orca"]));
    await expect(page.locator("#h-connect")).toHaveText("Which Flipper?");
    await expect(note).toHaveCount(0);
    const picks = page.locator("[data-action='pick-port']");
    await expect(picks).toHaveText(["Nautilus", "Orca"]);
    await expect(page.locator("[data-action='reconnect']")).toHaveCount(0);
    await page.waitForTimeout(300);
    await expect.poll(() => view(page)).toBe("connect");
    await picks.filter({ hasText: "Orca" }).click();
    await expect.poll(() => view(page)).toBe("dock");
    await expect(page.locator(".toast").last()).toContainText("Connected to Orca");
    expect(errors).toEqual([]);
  });
});

/* Nothing pokes out sideways at mid and phone widths. */
const OVERFLOW = () => {
  const out: string[] = [],
    W = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > W + 1)
    out.push(`page scrolls sideways ${document.documentElement.scrollWidth}>${W}`);
  document.querySelectorAll(".view.on *").forEach((el) => {
    const r = el.getBoundingClientRect();
    const cls = (el as HTMLElement).className as unknown as string | SVGAnimatedString;
    if (r.width && r.right > W + 1 && !el.closest(".sidebar, .set-nav"))
      out.push(`${el.tagName}.${typeof cls === "string" ? cls : cls.baseVal} right=${Math.round(r.right)}`);
  });
  return out.slice(0, 4);
};
for (const [width, height, tag] of [
  [1024, 720, "mid"],
  [390, 844, "phone"],
] as const) {
  test.describe(`No overflow at ${tag} width`, () => {
    test.use({ viewport: { width, height }, deviceScaleFactor: tag === "phone" ? 2 : 1 });
    test("every page", async ({ page }) => {
      const errors = watch(page);
      await open(page);
      for (const v of ["dock", "screen", "apps", "library", "files", "firmware", "console", "settings"]) {
        await page.evaluate((x) => window.__fathom.show(x), v);
        await page.waitForTimeout(300);
        expect(await page.evaluate(OVERFLOW), v).toEqual([]);
      }
      expect(errors).toEqual([]);
    });
  });
}
