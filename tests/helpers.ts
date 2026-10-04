import type { Page } from "@playwright/test";

export interface Fathom {
  view(): string;
  path(): string;
  selected(): string[];
  files(path: string): string[];
  hasFolder(path: string): boolean;
  prefs(): Record<string, unknown>;
  setPref(id: string, value: unknown): void;
  show(view: string): void;
  toast(text: string): void;
  unplug(): void;
  /* others: more Flippers plugged in at the same moment */
  plug(others?: string[]): void;
  setNoSd(on: boolean): void;
  dropApp(name: string): void;
  showKeyboard(text: string): void;
  setOtherFirmware(on: boolean): void;
  newRelease(version: string | null): Promise<void>;
  keyboardText(): string;
  failConnects(code: string | null): void;
  buddies(): {
    id: string;
    W: number;
    H: number;
    k: number;
    css: number;
    tight: boolean;
    act: string | null;
    frame: string;
  }[];
  buddyReact(kind: string): void;
  reduceMotion(): boolean;
}
declare global {
  interface Window {
    __fathom: Fathom;
  }
}

export function watch(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") errors.push(`console.${m.type()}: ${m.text()}`);
  });
  return errors;
}

export async function open(page: Page, hash = "", { splash = false } = {}) {
  if (!splash) await page.addInitScript(() => sessionStorage.setItem("fathom-splash", "1"));
  await page.goto(`/${hash}`);
  await page.waitForFunction(() => !!window.__fathom && window.__fathom.view() !== "connect");
}

export const path = (page: Page) => page.evaluate(() => window.__fathom.path());
export const names = (page: Page, p: string) => page.evaluate((x) => window.__fathom.files(x), p);
export const view = (page: Page) => page.evaluate(() => window.__fathom.view());
