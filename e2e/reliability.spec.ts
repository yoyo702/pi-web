import { expect, test, type Page } from "@playwright/test";

const session = {
  id: "reliability-session",
  path: "/tmp/pi-web-reliability/session.jsonl",
  cwd: "/tmp/pi-web-reliability",
  projectRoot: "/tmp/pi-web-reliability",
  created: "2026-09-27T00:00:00.000Z",
  modified: "2026-09-27T00:01:00.000Z",
  messageCount: 2,
  firstMessage: "Start the task",
};

/** A Pi session that is running; records every POST to /api/agent/<id>. */
async function mockRunningSession(page: Page, respond?: (body: Record<string, unknown>) => { status: number; json: unknown } | null) {
  const agentPosts: Array<Record<string, unknown>> = [];
  await page.route(`**/api/sessions/${session.id}/state`, (route) => route.fulfill({ json: {
    running: true,
    state: { isStreaming: true, isPromptRunning: true, isBashRunning: false, isCompacting: false },
  } }));
  await page.route(`**/api/sessions/${session.id}?*`, (route) => route.fulfill({ json: {
    sessionId: session.id,
    filePath: session.path,
    info: session,
    leafId: "tip",
    tree: [],
    context: {
      messages: [
        { role: "user", content: "Start the task", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Working on it" }], stopReason: "stop", timestamp: 2 },
      ],
      entryIds: ["user-1", "tip"],
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
    },
  } }));
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [session.id] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));
  await page.route(`**/api/agent/${session.id}/events`, (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: `data: ${JSON.stringify({ type: "connected", sessionId: session.id })}\n\n`,
  }));
  await page.route(`**/api/agent/${session.id}`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { running: true, state: { isStreaming: true, isPromptRunning: true } } });
    const body = route.request().postDataJSON() as Record<string, unknown>;
    agentPosts.push(body);
    const custom = respond?.(body);
    if (custom) return route.fulfill({ status: custom.status, json: custom.json });
    return route.fulfill({ json: { success: true, data: [] } });
  });
  await page.goto(`/?session=${session.id}`);
  await expect(page.getByText("Working on it", { exact: true })).toBeVisible();
  return { agentPosts };
}

test("Esc closes Settings without stopping the running agent", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the project rail Settings button is desktop-only");
  const { agentPosts } = await mockRunningSession(page);
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Status & indicators" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.waitForTimeout(300);
  expect(agentPosts.filter((body) => body.type === "abort")).toEqual([]);
});

test("a failed models.json load shows the error and never saves an empty config", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name.startsWith("mobile"), "the project rail Settings button is desktop-only");
  const puts: string[] = [];
  await page.route("**/api/models-config", (route) => {
    if (route.request().method() === "PUT") { puts.push(route.request().postData() ?? ""); return route.fulfill({ json: { success: true } }); }
    return route.fulfill({ status: 500, json: { error: "/home/u/.pi/agent/models.json is not valid JSON (Unexpected end of JSON input). Fix or remove it, then reload." } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Models" }).click();
  await expect(dialog.getByRole("alert")).toContainText("is not valid JSON");
  await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(puts).toEqual([]);
});

test("shows a sign-in prompt when the login expires and clears it after signing in", async ({ page }) => {
  let authenticated = true;
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated, passwordRequired: true } }));
  await page.goto("/");
  await expect(page.getByText("Get Started")).toBeVisible();

  authenticated = false;
  await page.evaluate(() => fetch("/api/sessions?probe=1"));
  // Next serves this route; force the 401 an expired cookie would get.
  await page.route("**/api/sessions?probe=2", (route) => route.fulfill({ status: 401, json: { error: "authentication required" } }));
  await page.evaluate(() => fetch("/api/sessions?probe=2"));
  const notice = page.getByRole("alertdialog", { name: "Signed out" });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: "Sign in" })).toHaveAttribute("target", "_blank");

  authenticated = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(notice).toBeHidden();
});

test("a 401 while still signed in does not show the sign-in prompt", async ({ page }) => {
  await page.route("**/api/auth/session", (route) => route.fulfill({ json: { authenticated: true, passwordRequired: true } }));
  await page.route("**/api/skills/updates*", (route) => route.fulfill({ status: 401, json: { error: "GitHub token rejected" } }));
  await page.goto("/");
  await page.evaluate(() => fetch("/api/skills/updates?x=1"));
  await page.waitForTimeout(300);
  await expect(page.getByRole("alertdialog", { name: "Signed out" })).toHaveCount(0);
});
