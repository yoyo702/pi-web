import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const macChromiumArchitecture = process.arch === "arm64" ? "arm64" : "x64";
const localMacChromium = join(homedir(), `Library/Caches/ms-playwright/chromium-1228/chrome-mac-${macChromiumArchitecture}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`);
const localLaunchOptions = process.platform === "darwin" && existsSync(localMacChromium) ? { executablePath: localMacChromium } : {};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:30142",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: localLaunchOptions,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "PI_WEB_E2E=1 PI_WEB_ALLOWED_ROOTS_FILE=/tmp/pi-web-e2e-allowed-roots.json PI_WEB_NOTIFICATIONS_FILE=/tmp/pi-web-e2e-notifications.json PI_WEB_PUSH_FILE=/tmp/pi-web-e2e-push.json PI_WEB_TASK_TEMPLATES_FILE=/tmp/pi-web-e2e-task-templates.json PI_WEB_NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_DISABLE_AGENTATION=1 node server/pi-web-server.js dev -H 127.0.0.1 -p 30142",
    url: "http://127.0.0.1:30142",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
