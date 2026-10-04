import { expect, test } from "@playwright/test";

test("sidebar and top bar render", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".brand b")).toHaveText("FATHOM");
  await expect(page.locator(".nav a")).toHaveCount(8);
  await expect(page.locator(".nav a[aria-current='page']")).toContainText("Dock");
  await expect(page.locator(".topbar .conn")).toContainText("Nautilus");
  await expect(page.locator(".topbar .battery")).toContainText("86%");
});

test("number keys switch pages", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".nav a[aria-current='page']")).toContainText("Dock");
  await page.keyboard.press("5");
  await expect(page).toHaveURL(/#files$/);
  await expect(page.locator(".nav a[aria-current='page']")).toContainText("Files");
});
