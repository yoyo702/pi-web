import type { CodexConversationItem } from "./codex-conversation";

/**
 * Builds Claude Chat items from transcript records (history pages) followed by
 * live runtime events. Both carry the same ids, so a record seen twice updates
 * one item:
 * - assistant text/thinking: `<message id>:<block index>` (stream events use
 *   the index of `content_block_*` and the id from `message_start`; records
 *   carry `piBlockIndex`, Claude's `apiBlockIndex`);
 * - tools: the tool_use id; a `tool_result` completes it;
 * - user messages: the record uuid (the browser sends its own uuid, so the
 *   optimistic message is replaced in place).
 */
export type ClaudeBlock = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean };
export type ClaudeRecord = {
  type?: string;
  subtype?: string;
  uuid?: string;
  piBlockIndex?: number;
  piSeq?: number;
  pending?: boolean;
  is_error?: boolean;
  result?: string;
  message?: { id?: string; role?: string; content?: string | ClaudeBlock[] };
  event?: { type?: string; index?: number; message?: { id?: string }; content_block?: ClaudeBlock; delta?: { type?: string; text?: string; thinking?: string } };
};

const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((part: ClaudeBlock) => part?.type === "text" && typeof part.text === "string" ? [part.text] : part?.type === "image" ? ["[Image]"] : []).join("\n");
}

function tag(text: string, name: string) {
  return text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();
}

/** A user text as shown: slash commands as typed, command output as a notice. */
function userText(text: string): { kind: "message" | "notice"; text: string } | null {
  const command = tag(text, "command-name");
  if (command) return { kind: "message", text: [command, tag(text, "command-args")].filter(Boolean).join(" ") };
  const stdout = tag(text, "local-command-stdout") ?? tag(text, "local-command-stderr");
  if (stdout !== undefined) return stdout ? { kind: "notice", text: stdout } : null;
  if (INTERRUPTED.test(text.trim())) return { kind: "notice", text: "Interrupted" };
  return text.trim() ? { kind: "message", text } : null;
}

function lines(text: unknown) { return typeof text === "string" && text ? text.replace(/\n$/, "").split("\n") : []; }
function hunk(oldText: unknown, newText: unknown) {
  const before = lines(oldText);
  const after = lines(newText);
  return [`@@ -1,${before.length} +1,${after.length} @@`, ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)];
}
/** A unified diff for Edit/MultiEdit/Write input (line numbers are not known). */
export function claudeToolDiff(name: string, input: Record<string, unknown>): string | undefined {
  const file = typeof input.file_path === "string" ? input.file_path : "file";
  const header = [`--- a/${file}`, `+++ b/${file}`];
  if (name === "Edit") return [...header, ...hunk(input.old_string, input.new_string)].join("\n");
  if (name === "MultiEdit" && Array.isArray(input.edits)) return [...header, ...input.edits.flatMap((edit: Record<string, unknown>) => hunk(edit?.old_string, edit?.new_string))].join("\n");
  if (name === "Write") return [...header, ...hunk("", input.content)].join("\n");
  return undefined;
}

function toolItem(block: ClaudeBlock, previous?: CodexConversationItem): CodexConversationItem {
  const id = block.id ?? "tool";
  const input = block.input && typeof block.input === "object" && !Array.isArray(block.input) ? block.input as Record<string, unknown> : {};
  const name = block.name ?? "tool";
  const done = previous && "done" in previous ? previous.done : false;
  if (name === "Bash") {
    const output = previous?.kind === "command" ? previous.output : undefined;
    return { id, kind: "command", command: typeof input.command === "string" ? input.command : "", output, exitCode: previous?.kind === "command" ? previous.exitCode : null, done };
  }
  const result = previous?.kind === "toolCall" ? { output: previous.output, isError: previous.isError } : {};
  return { id, kind: "toolCall", toolName: name, input, diff: claudeToolDiff(name, input), ...result, done };
}

export function claudeConversationItems(records: ClaudeRecord[]): CodexConversationItem[] {
  const items = new Map<string, CodexConversationItem>();
  let messageId = "";
  const put = (item: CodexConversationItem) => items.set(item.id, item);
  const finishStreaming = () => {
    for (const [id, item] of items) {
      if ((item.kind === "message" || item.kind === "plan") && item.streaming) items.set(id, { ...item, streaming: false });
      else if ((item.kind === "command" || item.kind === "toolCall") && !item.done) items.set(id, { ...item, done: true });
    }
  };
  for (const record of records) {
    if (record.type === "stream_event") {
      const event = record.event ?? {};
      if (event.type === "message_start") { messageId = event.message?.id ?? ""; continue; }
      const key = `${messageId}:${event.index ?? 0}`;
      if (event.type === "content_block_start") {
        const block = event.content_block ?? {};
        if (block.type === "text" && !items.has(key)) put({ id: key, kind: "message", role: "assistant", text: block.text ?? "", streaming: true });
        else if (block.type === "thinking" && !items.has(key)) put({ id: key, kind: "reasoning", summary: "", content: block.thinking ?? "" });
        else if (block.type === "tool_use" && block.id && !items.has(block.id)) put(toolItem(block));
      } else if (event.type === "content_block_delta") {
        const previous = items.get(key);
        if (event.delta?.type === "text_delta" && previous?.kind === "message" && previous.streaming) put({ ...previous, text: previous.text + (event.delta.text ?? "") });
        else if (event.delta?.type === "thinking_delta" && previous?.kind === "reasoning") put({ ...previous, content: previous.content + (event.delta.thinking ?? "") });
      }
      continue;
    }
    if (record.type === "assistant") {
      const content = Array.isArray(record.message?.content) ? record.message.content : [];
      content.forEach((block, offset) => {
        const key = `${record.message?.id ?? record.uuid}:${(record.piBlockIndex ?? 0) + offset}`;
        if (block.type === "text" && block.text?.trim()) put({ id: key, kind: "message", role: "assistant", text: block.text });
        else if (block.type === "thinking") put({ id: key, kind: "reasoning", summary: "", content: block.thinking ?? "" });
        else if (block.type === "tool_use" && block.id) put(toolItem(block, items.get(block.id)));
      });
      continue;
    }
    if (record.type === "user") {
      const content = record.message?.content;
      const uuid = record.uuid ?? `user:${record.piSeq ?? items.size}`;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result" || !block.tool_use_id) continue;
          const previous = items.get(block.tool_use_id);
          const output = textOf(block.content);
          if (previous?.kind === "command") put({ ...previous, output, exitCode: block.is_error ? 1 : 0, done: true });
          else if (previous?.kind === "toolCall") put({ ...previous, output, isError: Boolean(block.is_error), done: true });
        }
        if (content.some((block) => block.type === "tool_result")) continue;
      }
      const shown = userText(textOf(content));
      if (!shown) continue;
      if (shown.kind === "notice") put({ id: uuid, kind: "notice", text: shown.text });
      else put({ id: uuid, kind: "message", role: "user", text: shown.text, ...(record.pending ? { pending: true } : {}) });
      continue;
    }
    if (record.type === "result") {
      finishStreaming();
      if (record.is_error) put({ id: `result:${record.piSeq ?? items.size}`, kind: "notice", text: record.result || "Turn failed", tone: "error" });
      continue;
    }
    if (record.type === "pi/closed" || record.type === "pi/stopped") finishStreaming();
  }
  return [...items.values()];
}
