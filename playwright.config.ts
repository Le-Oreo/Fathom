import { defineConfig } from "@playwright/test";

/* UI tests run against the browser build on the mock device. */
export default defineConfig({
  testDir: "tests",
  use: { baseURL: "http://localhost:1420", viewport: { width: 1440, height: 900 } },
  webServer: { command: "npm run dev", url: "http://localhost:1420", reuseExistingServer: true },
});
