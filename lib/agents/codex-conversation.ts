/** Adapts Codex app-server events into renderable agent conversation items (Claude Chat uses the same items). */
export type CodexConversationItem =
  // `turnId`: the Codex turn a user message started (forking from the message keeps the turns before it).
  | { id: string; kind: "message"; role: "user" | "assistant"; text: string; streaming?: boolean; pending?: boolean; turnId?: string }
  | { id: string; kind: "reasoning"; summary: string; content: string }
  | { id: string; kind: "command"; command: string; cwd?: string; output?: string; exitCode?: number | null; durationMs?: number | null; status?: string; done: boolean }
  | { id: string; kind: "fileChange"; files: string[]; diff?: string; done: boolean }
  | { id: string; kind: "tool"; title: string; output?: string; done: boolean }
  | { id: string; kind: "plan"; text: string; streaming?: boolean }
  | { id: string; kind: "review"; text: string; done: boolean }
  // A tool call shown with its input and result; `diff` is a unified diff of the edit.
  | { id: string; kind: "toolCall"; toolName: string; input: Record<string, unknown>; output?: string; isError?: boolean; diff?: string; done: boolean }
  | { id: string; kind: "notice"; text: string; tone?: "error" }
  // The agent's task list; each update replaces it and moves it to the latest position.
  | { id: string; kind: "todo"; explanation?: string; steps: TodoStep[] };

export type TodoStep = { text: string; status: "pending" | "inProgress" | "completed" };
type FileChange = { path?: string; kind?: { type?: string; move_path?: string | null }; diff?: string };

type AppItem = { id?: string; clientId?: string; type?: string; text?: string; command?: string; cwd?: string; aggregatedOutput?: string | null; exitCode?: number | null; durationMs?: number | null; status?: string; changes?: FileChange[]; summary?: string[]; content?: (string | { type?: string; text?: string })[] };
type AppEvent = { method?: string; params?: { item?: AppItem; itemId?: string; delta?: string; turnId?: string; text?: string; explanation?: string | null; plan?: { step?: string; status?: string }[] } };

function upsert(items: CodexConversationItem[], item: CodexConversationItem) {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  return index < 0 ? [...items, item] : items.map((candidate, candidateIndex) => candidateIndex === index ? item : candidate);
}

/** Moves the item to the end, where the latest update is. */
export function upsertLast(items: CodexConversationItem[], item: CodexConversationItem) {
  return [...items.filter((candidate) => candidate.id !== item.id), item];
}

function contentLines(text: string, prefix: string) { return text ? text.replace(/\n$/, "").split("\n").map((line) => `${prefix}${line}`) : []; }
/**
 * A unified diff for Codex file changes. Codex gives an update as hunks without
 * file headers, and an added or deleted file as its whole content.
 */
export function codexFileDiff(changes: FileChange[]): string | undefined {
  const parts = changes.flatMap((change) => {
    const path = change.path ?? "file";
    const diff = change.diff ?? "";
    if (change.kind?.type === "add") { const lines = contentLines(diff, "+"); return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines]; }
    if (change.kind?.type === "delete") { const lines = contentLines(diff, "-"); return [`--- a/${path}`, `+++ /dev/null`, `@@ -1,${lines.length} +0,0 @@`, ...lines]; }
    if (!diff) return [];
    return diff.startsWith("--- ") ? [diff.replace(/\n$/, "")] : [`--- a/${path}`, `+++ b/${change.kind?.move_path || path}`, diff.replace(/\n$/, "")];
  });
  return parts.length ? parts.join("\n") : undefined;
}

const TODO_STATUS: Record<string, TodoStep["status"]> = { pending: "pending", inProgress: "inProgress", in_progress: "inProgress", completed: "completed" };
export function todoStatus(status: unknown): TodoStep["status"] { return TODO_STATUS[String(status)] ?? "pending"; }

export function reduceCodexEvent(items: CodexConversationItem[], event: AppEvent): CodexConversationItem[] {
  const item = event.params?.item;
  if (event.method === "item/commandExecution/outputDelta" && event.params?.itemId && event.params.delta) {
    const previous = items.find((candidate) => candidate.id === event.params?.itemId);
    if (previous?.kind !== "command") return items;
    return upsert(items, { ...previous, output: `${previous.output ?? ""}${event.params.delta}` });
  }
  if (event.method === "item/reasoning/summaryTextDelta" && event.params?.itemId && event.params.delta) {
    const previous = items.find((candidate) => candidate.id === event.params?.itemId);
    const summary = previous?.kind === "reasoning" ? previous.summary + event.params.delta : event.params.delta;
    const content = previous?.kind === "reasoning" ? previous.content : "";
    return upsert(items, { id: event.params.itemId, kind: "reasoning", summary, content });
  }
  if (event.method === "item/reasoning/textDelta" && event.params?.itemId && event.params.delta) {
    const previous = items.find((candidate) => candidate.id === event.params?.itemId);
    const summary = previous?.kind === "reasoning" ? previous.summary : "";
    const content = previous?.kind === "reasoning" ? previous.content + event.params.delta : event.params.delta;
    return upsert(items, { id: event.params.itemId, kind: "reasoning", summary, content });
  }
  if (event.method === "item/agentMessage/delta" && event.params?.itemId && event.params.delta) {
    const previous = items.find((candidate) => candidate.id === event.params?.itemId);
    const text = previous?.kind === "message" ? previous.text + event.params.delta : event.params.delta;
    return upsert(items, { id: event.params.itemId, kind: "message", role: "assistant", text, streaming: true });
  }
  if (event.method === "item/plan/delta" && event.params?.itemId && event.params.delta) {
    const previous = items.find((candidate) => candidate.id === event.params?.itemId);
    const text = previous?.kind === "plan" ? previous.text + event.params.delta : event.params.delta;
    return upsert(items, { id: event.params.itemId, kind: "plan", text, streaming: true });
  }
  if (event.method === "turn/plan/updated" && event.params?.turnId) {
    const steps = (event.params.plan ?? []).map((entry) => ({ text: entry.step ?? "", status: todoStatus(entry.status) }));
    return upsertLast(items, { id: `todo:${event.params.turnId}`, kind: "todo", ...(event.params.explanation ? { explanation: event.params.explanation } : {}), steps });
  }
  if (!item?.id || (event.method !== "item/started" && event.method !== "item/completed")) return items;
  const done = event.method === "item/completed";
  if (item.type === "agentMessage") return upsert(items, { id: item.id, kind: "message", role: "assistant", text: item.text ?? "", streaming: !done });
  if (item.type === "userMessage") {
    const text = item.text ?? (item.content ?? []).flatMap((part) => typeof part === "string" ? [part] : part.type === "text" && part.text ? [part.text] : part.type === "image" || part.type === "localImage" ? ["[Image]"] : []).join("\n");
    const itemId = item.clientId || item.id;
    const turn = event.params?.turnId ? { turnId: event.params.turnId } : {};
    const clientIndex = item.clientId ? items.findIndex((candidate) => candidate.id === item.clientId) : -1;
    if (clientIndex >= 0) return items.map((candidate, index) => index === clientIndex ? { id: itemId, kind: "message", role: "user", text, ...turn } : candidate);
    const pendingIndex = items.findLastIndex((candidate) => candidate.kind === "message" && candidate.role === "user" && candidate.pending && candidate.text.trim() === text.trim());
    if (pendingIndex >= 0) return items.map((candidate, index) => index === pendingIndex ? { id: itemId, kind: "message", role: "user", text, ...turn } : candidate);
    return upsert(items, { id: itemId, kind: "message", role: "user", text, ...turn });
  }
  if (item.type === "commandExecution") return upsert(items, { id: item.id, kind: "command", command: item.command ?? "", cwd: item.cwd, output: item.aggregatedOutput ?? undefined, exitCode: item.exitCode, durationMs: item.durationMs, status: item.status, done });
  if (item.type === "fileChange") return upsert(items, { id: item.id, kind: "fileChange", files: (item.changes ?? []).map((change) => change.path ?? "Changed file"), diff: codexFileDiff(item.changes ?? []), done });
  if (item.type === "reasoning") return upsert(items, { id: item.id, kind: "reasoning", summary: (item.summary ?? []).join("\n"), content: (item.content ?? []).map((part) => typeof part === "string" ? part : part.text ?? "").join("\n") });
  if (item.type === "plan") return upsert(items, { id: item.id, kind: "plan", text: item.text ?? "", streaming: !done });
  if (["mcpToolCall", "dynamicToolCall", "webSearch"].includes(item.type ?? "")) return upsert(items, { id: item.id, kind: "tool", title: item.text ?? item.type ?? "Tool", output: item.aggregatedOutput ?? undefined, done });
  return items;
}
