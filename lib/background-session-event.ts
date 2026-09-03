/**
 * The app-wide session event stream is only a background cache invalidation
 * channel. Token-level events belong on the selected session's dedicated SSE
 * connection: forwarding them globally repeatedly serializes a growing
 * message and can build an unbounded response queue for a slow browser.
 */
export interface BackgroundSessionEvent {
  type: string;
  [key: string]: unknown;
}

export const MAX_BACKGROUND_SESSION_EVENT_BYTES = 128 * 1024;

function completedMessageEvent(event: BackgroundSessionEvent): BackgroundSessionEvent {
  const projected = { type: "message_end", message: event.message };
  try {
    if (Buffer.byteLength(JSON.stringify(projected), "utf8") <= MAX_BACKGROUND_SESSION_EVENT_BYTES) {
      return projected;
    }
  } catch {
    // Circular/non-serializable extension data is recoverable by reloading.
  }
  return { type: "session_refresh" };
}

/**
 * Reduce a full Pi event to the small, bounded subset needed by unmounted
 * sessions. Returning null means the event stays on the per-session stream
 * only and is never serialized for every connected browser.
 */
export function projectBackgroundSessionEvent(
  event: BackgroundSessionEvent,
): BackgroundSessionEvent | null {
  switch (event.type) {
    case "agent_start":
    case "agent_end":
    case "prompt_done":
    case "compaction_start":
    case "auto_compaction_start":
    case "compaction_end":
    case "auto_compaction_end":
      return { type: event.type };
    case "message_end":
      return completedMessageEvent(event);
    case "tool_execution_start":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      };
    case "tool_execution_end":
      return {
        type: event.type,
        toolCallId: event.toolCallId,
      };
    default:
      return null;
  }
}
