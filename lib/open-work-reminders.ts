import type { TerminalSession } from "./agents/terminal";
import type { WorkspaceStatusSnapshot } from "./workspace-status-store";

export interface OpenWorkReminder {
  key: string;
  message: string;
  /** "failed" for a failed task; "running" for work that may still change files. */
  tone: "failed" | "running";
}

function isInside(roots: string[], cwd: string): boolean {
  return roots.some((root) => {
    const base = root.replace(/[\\/]+$/, "");
    return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`);
  });
}

const PROVIDER_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * Work in the repository that may not be finished: project tasks that are
 * running or whose last run failed, and agents that are working or waiting
 * for approval. `roots` are spellings of the repository folder (Git's real
 * path and the workspace path can differ through symlinks). Only reminders;
 * they never block a commit.
 */
export function openWorkReminders(snapshot: Pick<WorkspaceStatusSnapshot, "terminals" | "codexRuntimes" | "claudeRuntimes">, roots: string[]): OpenWorkReminder[] {
  const reminders: OpenWorkReminder[] = [];
  const terminals = (snapshot.terminals ?? []).filter((terminal) => isInside(roots, terminal.cwd));

  const latestTasks = new Map<string, TerminalSession>();
  for (const terminal of terminals) {
    if (!terminal.title?.startsWith("Task: ")) continue;
    const previous = latestTasks.get(terminal.title);
    if (!previous || previous.createdAt < terminal.createdAt) latestTasks.set(terminal.title, terminal);
  }
  for (const [title, terminal] of latestTasks) {
    const name = title.slice("Task: ".length);
    if (terminal.state === "running") reminders.push({ key: `task:${terminal.id}`, message: `Task ${name} is still running`, tone: "running" });
    else if (terminal.exitCode !== null && terminal.exitCode !== 0) reminders.push({ key: `task:${terminal.id}`, message: `Task ${name} failed (exit ${terminal.exitCode})`, tone: "failed" });
  }

  for (const terminal of terminals) {
    const label = PROVIDER_LABELS[terminal.provider];
    if (!label || terminal.state !== "running") continue;
    const name = terminal.title ? `${label} terminal "${terminal.title}"` : `${label} terminal`;
    if (terminal.activity === "approval") reminders.push({ key: `terminal:${terminal.id}`, message: `${name} is waiting for approval`, tone: "running" });
    else if (terminal.activity === "working") reminders.push({ key: `terminal:${terminal.id}`, message: `${name} is still working`, tone: "running" });
  }

  const chats = [
    ...(snapshot.codexRuntimes ?? []).map((runtime) => ({ key: `codex:${runtime.threadId}`, label: "Codex chat", ...runtime })),
    ...(snapshot.claudeRuntimes ?? []).map((runtime) => ({ key: `claude:${runtime.sessionId}`, label: runtime.title ? `Claude chat "${runtime.title}"` : "Claude chat", ...runtime })),
  ];
  for (const chat of chats) {
    if (!isInside(roots, chat.cwd)) continue;
    if (chat.state === "approval") reminders.push({ key: chat.key, message: `${chat.label} is waiting for approval`, tone: "running" });
    else if (chat.state === "running") reminders.push({ key: chat.key, message: `${chat.label} is still working`, tone: "running" });
  }
  return reminders;
}
