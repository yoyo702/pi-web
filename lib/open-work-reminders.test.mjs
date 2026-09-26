import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { openWorkReminders } = await jiti.import("./open-work-reminders.ts");

const terminal = (fields) => ({ id: fields.id, provider: "shell", cwd: "/repo", state: "exited", exitCode: 0, createdAt: "2026-09-26T10:00:00.000Z", ...fields });

test("reminds of running or failed tasks and busy agents in the repository", () => {
  const reminders = openWorkReminders({
    terminals: [
      terminal({ id: "t1", title: "Task: test", exitCode: 1, createdAt: "2026-09-26T09:00:00.000Z" }),
      terminal({ id: "t2", title: "Task: test", exitCode: 0 }),
      terminal({ id: "t3", title: "Task: lint", exitCode: 2 }),
      terminal({ id: "t4", title: "Task: dev", state: "running", exitCode: null, cwd: "/repo/app" }),
      terminal({ id: "t5", provider: "claude", state: "running", activity: "approval", title: "Fix" }),
      terminal({ id: "t6", provider: "codex", state: "running", activity: "waiting" }),
      terminal({ id: "t7", provider: "claude", state: "running", activity: "working", cwd: "/repository-two" }),
      terminal({ id: "t8", title: "Task: build", exitCode: 1, cwd: "/other" }),
    ],
    codexRuntimes: [{ threadId: "c1", cwd: "/repo", state: "running" }, { threadId: "c2", cwd: "/repo", state: "idle" }],
    claudeRuntimes: [{ sessionId: "s1", cwd: "/repo/", title: "Plan", state: "approval" }],
  }, ["/repo"]);
  assert.deepEqual(reminders.map((reminder) => `${reminder.tone}: ${reminder.message}`), [
    "failed: Task lint failed (exit 2)",
    "running: Task dev is still running",
    "running: Claude terminal \"Fix\" is waiting for approval",
    "running: Codex chat is still working",
    "running: Claude chat \"Plan\" is waiting for approval",
  ]);
});

test("returns nothing before the status stream has sent anything", () => {
  assert.deepEqual(openWorkReminders({ terminals: null, codexRuntimes: null, claudeRuntimes: null }, ["/repo"]), []);
});

test("matches work under any spelling of the repository folder", () => {
  const reminders = openWorkReminders({
    terminals: [terminal({ id: "t1", title: "Task: test", exitCode: 1, cwd: "/Users/me/link/repo" })],
    codexRuntimes: [{ threadId: "c1", cwd: "/private/real/repo/src", state: "running" }],
    claudeRuntimes: [],
  }, ["/private/real/repo", "/Users/me/link/repo"]);
  assert.deepEqual(reminders.map((reminder) => reminder.key), ["task:t1", "codex:c1"]);
});
