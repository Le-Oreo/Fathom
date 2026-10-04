import { expect, test } from "@playwright/test";
import { open, view, watch } from "./helpers";

const side = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__fathom.buddies().find((b) => b.id === "buddy-side"));

test.describe("The dolphin on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("launch, click, follow and react", async ({ page }) => {
    const errors = watch(page);
    await open(page, "", { splash: true });
    await expect(page.locator("#buddy-splash canvas")).toBeVisible();
    await expect(page.locator("#splash")).toBeHidden({ timeout: 4000 });

    const box = await page.locator("#buddy-side").boundingBox();
    if (!box) throw new Error("no sidebar dolphin");
    const b = await side(page);
    expect(b?.tight).toBe(false);
    expect(b?.W).toBeGreaterThanOrEqual(64);

    /* a click gives hearts and a trick */
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(200);
    expect((await side(page))?.act).not.toBeNull();

    /* hover: it follows the pointer */
    await page.mouse.move(box.x + 30, box.y + box.height - 30);
    await page.waitForTimeout(2500);
    await page.mouse.move(box.x + 32, box.y + box.height - 32);
    await expect.poll(async () => (await side(page))?.act, { timeout: 5000 }).toBe("follow");
    await page.mouse.move(800, 400);

    /* a reaction from the app: a screenshot makes it flip */
    await page.evaluate(() => window.__fathom.buddyReact("screenshot"));
    await expect.poll(async () => (await side(page))?.act, { timeout: 3000 }).toBe("flip");
    expect(errors).toEqual([]);
  });
});

test.describe("The dolphin in short windows", () => {
  for (const height of [768, 720]) {
    test.describe(`${height}px tall`, () => {
      test.use({ viewport: { width: 1280, height } });
      test("the sidebar dolphin still fits", async ({ page }) => {
        const errors = watch(page);
        await open(page, "#dock");
        await page.waitForTimeout(300);
        expect((await side(page))?.tight).toBe(false);
        expect(errors).toEqual([]);
      });
    });
  }
});

test.describe("The dolphin on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test("listens on the Connect page", async ({ page }) => {
    const errors = watch(page);
    await open(page);
    await page.evaluate(() => window.__fathom.unplug());
    await expect.poll(() => view(page)).toBe("connect");
    await page.waitForTimeout(300);
    const b = await page.evaluate(() => window.__fathom.buddies().find((x) => x.id === "buddy-connect"));
    expect(b?.tight).toBe(false);
    expect(b?.W).toBeGreaterThanOrEqual(64);
    expect(errors).toEqual([]);
  });
});

test.describe("The dolphin with reduced motion", () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });

  test("holds still", async ({ page }) => {
    const errors = watch(page);
    await open(page, "", { splash: true });
    await expect(page.locator("#splash")).toHaveCount(0);
    await page.evaluate(() => window.__fathom.buddyReact("screenshot"));
    await page.mouse.click(124, 560);
    await page.waitForTimeout(300);
    const b = await side(page);
    expect(b?.frame).toBe("base");
    expect(b?.act).toBeNull();
    expect(errors).toEqual([]);
  });
});
