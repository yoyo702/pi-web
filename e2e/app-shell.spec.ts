import { expect, test } from "@playwright/test";

test("loads the Pi workspace shell without authentication on loopback", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Pi Web/);
  await expect(page.getByText("Pi", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Get Started")).toBeVisible();
});

test("renders a usable mobile shell", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "mobile project only");
  await page.goto("/");
  await expect(page.getByText("Pi", { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
