import { expect, test } from "@playwright/test";

test("loads the Pi workspace shell without authentication on loopback", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Pi Web/);
  await expect(page.getByText("Pi", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Get Started")).toBeVisible();
  await expect(page.locator(".center-workspace").getByText("Pi", { exact: true })).toBeHidden();
  await expect(page.locator(".center-workspace").getByRole("button", { name: /^(Show|Hide) sidebar$/ })).toBeVisible();
  await expect(page.locator(".center-workspace").getByRole("button", { name: "Workspace activity" })).toBeVisible();
});

test("renders a usable mobile shell", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile"), "mobile project only");
  await page.goto("/");
  await expect(page.getByText("Pi", { exact: true }).first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const navigation = page.getByRole("navigation", { name: "Mobile navigation" });
  await navigation.getByRole("button", { name: "Agents" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
  await navigation.getByRole("button", { name: "Files" }).click();
  await expect(page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true");
  await navigation.getByRole("button", { name: "Agents" }).click();
  await navigation.getByRole("button", { name: "Workspace" }).click();
  await expect(navigation.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true");
});

test("switches and remembers the sidebar module", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "desktop sidebar test");
  await page.goto("/");
  const modules = page.getByRole("navigation", { name: "Sidebar modules" });
  await expect(modules.getByRole("button", { name: "Files" })).toHaveCount(0);
  await expect(modules.getByRole("button", { name: "All" })).toHaveCount(0);
  await modules.getByRole("button", { name: "Agents" }).click();
  await expect(modules.getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-sidebar-module"))).toBe("agents");
  await page.reload();
  await expect(page.getByRole("navigation", { name: "Sidebar modules" }).getByRole("button", { name: "Agents" })).toHaveAttribute("aria-pressed", "true");
});
