/**
 * Since pi 0.86 the transcript stores the system prompt and tool loadout as
 * `role: "system"` messages (a full one on a session's first request, patches
 * when the prompt or tools change), and the agent emits message events for
 * them before the user's prompt. They shape model context only: the chat UI
 * must never render, count, or anchor on them (the System prompt panel reads
 * the prompt through get_state instead).
 */
export function isModelContextOnlyMessage(message: unknown): boolean {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "system";
}

const MESSAGE_EVENT_TYPES = new Set(["message_start", "message_update", "message_end"]);

export function isModelContextOnlyMessageEvent(event: { type: string; message?: unknown }): boolean {
  return MESSAGE_EVENT_TYPES.has(event.type) && isModelContextOnlyMessage(event.message);
}
