/** What a finished Pi run reports to the activity notifications; null for a run the user aborted. */
export interface PiRunOutcome {
  event: "completed" | "failed";
  detail?: string;
}

type MessageLike = { role?: unknown; stopReason?: unknown; errorMessage?: unknown; content?: unknown };

function asMessages(value: unknown): MessageLike[] {
  return Array.isArray(value) ? value.filter((message): message is MessageLike => typeof message === "object" && message !== null) : [];
}

/** Outcome of an `agent_end` event, from its last assistant message. */
export function piRunOutcome(messages: unknown): PiRunOutcome | null {
  const last = asMessages(messages).findLast((message) => message.role === "assistant");
  if (last?.stopReason === "aborted") return null;
  if (last?.stopReason === "error") {
    return { event: "failed", detail: typeof last.errorMessage === "string" && last.errorMessage ? last.errorMessage : "The model request failed" };
  }
  return { event: "completed" };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : "")
    .join(" ");
}

/** The session name, else its first user message. */
export function piSessionTitle(sessionName: string | undefined, entries: unknown): string {
  if (sessionName?.trim()) return sessionName.trim();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const message = entry && typeof entry === "object" ? (entry as { type?: unknown; message?: MessageLike }).message : undefined;
    if ((entry as { type?: unknown })?.type !== "message" || message?.role !== "user") continue;
    const text = messageText(message.content).replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return "Pi session";
}
