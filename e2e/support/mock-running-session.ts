import { expect, type Page } from "@playwright/test";

// Shared by e2e/reliability.spec.ts and e2e/navigation.spec.ts. Extracted so
// navigation tests that need a rendered user+assistant pair (e.g. Regenerate)
// reuse this fixture instead of forking its frame-building logic into a
// second copy.
export const session = {
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
export async function mockRunningSession(
  page: Page,
  respond?: (body: Record<string, unknown>) => { status: number; json: unknown } | null,
  sessionOverrides?: {
    tree?: unknown[];
    leafId?: string;
    page?: { hasMore: boolean; beforeEntryId: string };
    /** Whether the agent is mid-turn (true, the default) or idle. Fork and the
     * reasoning-level control are only rendered while the agent is idle. */
    busy?: boolean;
    messages?: unknown[];
    entryIds?: string[];
    /** Intercepts /context requests before the default handler below; return
     * null to fall through. Registering a *second* page.route after this
     * function returns would race the IntersectionObserver's own auto-fired
     * "load older messages" request, so overrides go through this hook instead. */
    contextRespond?: (url: URL) => { status: number; json: unknown } | null;
  },
) {
  const busy = sessionOverrides?.busy ?? true;
  const messages = sessionOverrides?.messages ?? [
    { role: "user", content: "Start the task", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "Working on it" }], stopReason: "stop", timestamp: 2 },
  ];
  const entryIds = sessionOverrides?.entryIds ?? ["user-1", "tip"];
  const agentPosts: Array<Record<string, unknown>> = [];
  await page.route(`**/api/sessions/${session.id}/state`, (route) => route.fulfill({ json: {
    running: true,
    state: { isStreaming: busy, isPromptRunning: busy, isBashRunning: false, isCompacting: false },
  } }));
  await page.route(`**/api/sessions/${session.id}?*`, (route) => route.fulfill({ json: {
    sessionId: session.id,
    filePath: session.path,
    info: session,
    leafId: sessionOverrides?.leafId ?? "tip",
    tree: sessionOverrides?.tree ?? [],
    context: {
      messages,
      entryIds,
      thinkingLevel: "medium",
      model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      ...(sessionOverrides?.page ? { page: sessionOverrides.page } : {}),
    },
  } }));
  // Backs handleLeafChange's reload of the target branch (and its rollback
  // reload of the previous branch). Branch "branch-a" gets its own content;
  // everything else falls back to the session's default messages.
  await page.route(`**/api/sessions/${session.id}/context?*`, (route) => {
    const url = new URL(route.request().url());
    const custom = sessionOverrides?.contextRespond?.(url);
    if (custom) return route.fulfill({ status: custom.status, json: custom.json });
    if (url.searchParams.get("leafId") === "branch-a") {
      return route.fulfill({ json: { context: {
        messages: [
          { role: "user", content: "Start the task", timestamp: 1 },
          { role: "assistant", content: [{ type: "text", text: "Branch A reply" }], stopReason: "stop", timestamp: 2 },
        ],
        entryIds: ["user-1", "branch-a"],
        thinkingLevel: "medium",
        model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      } } });
    }
    return route.fulfill({ json: { context: {
      messages, entryIds, thinkingLevel: "medium", model: { provider: "openai-codex", modelId: "gpt-5.6-sol" },
      ...(sessionOverrides?.page ? { page: sessionOverrides.page } : {}),
    } } });
  });
  await page.route("**/api/sessions", (route) => route.fulfill({ json: { sessions: [session], runningSessionIds: [session.id] } }));
  await page.route("**/api/cwd/validate", (route) => route.fulfill({ json: { success: true, cwd: session.cwd } }));
  await page.route(`**/api/agent/${session.id}/events`, (route) => route.fulfill({
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
    body: `data: ${JSON.stringify({ type: "connected", sessionId: session.id })}\n\n`,
  }));
  await page.route(`**/api/agent/${session.id}`, async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { running: true, state: { isStreaming: busy, isPromptRunning: busy } } });
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
