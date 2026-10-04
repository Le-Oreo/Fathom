import { chromium } from "@playwright/test";
import { createServer } from "vite";

const all = ["dock", "screen", "apps", "library", "files", "firmware", "console", "settings"];
const views = process.argv.slice(2).length ? process.argv.slice(2) : all;
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

const server = await createServer({ server: { port: 1430, strictPort: false }, logLevel: "error" });
await server.listen();
const base = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const errors = [];
for (const [label, viewport] of Object.entries(sizes)) {
  const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on(
    "console",
    (m) => ["error", "warning"].includes(m.type()) && errors.push(`${label} console.${m.type()}: ${m.text()}`),
  );
  await page.goto(base);
  await page.evaluate(() => sessionStorage.setItem("fathom-splash", "1"));
  for (const v of views) {
    await page.goto(`${base}#${v}`);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `screens/app/${v}-${label}.png` });
  }
  await page.close();
}
await browser.close();
await server.close();
console.log(errors.length ? errors.join("\n") : "no console errors");
