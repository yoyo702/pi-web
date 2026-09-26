import type { ChatDraftImage } from "./draft-store";

export interface QueuedChatMessage {
  text: string;
  images: ChatDraftImage[];
}

export interface ChatQueue {
  items: QueuedChatMessage[];
  /** Sending the first item failed; the queue waits for Retry. */
  failed: boolean;
}

export const EMPTY_CHAT_QUEUE: Readonly<ChatQueue> = Object.freeze({ items: [], failed: false });

// Module memory like the draft store: queued messages outlive the chat
// component (tab and project switches) but not a page reload.
const queues = new Map<string, ChatQueue>();
const listeners = new Set<() => void>();

export function getChatQueue(key: string): ChatQueue {
  return queues.get(key) ?? EMPTY_CHAT_QUEUE;
}

export function updateChatQueue(key: string, update: (queue: ChatQueue) => ChatQueue): void {
  const next = update(getChatQueue(key));
  if (next.items.length === 0) queues.delete(key);
  else queues.set(key, next);
  for (const listener of listeners) listener();
}

export function subscribeChatQueues(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// The in-flight lock lives here, not on the ChatQueue snapshot: workspace tabs
// can stay mounted while hidden, so more than one CodexAssistantThread instance
// can share a draftKey. Keying the lock by queue key (instead of a per-component
// ref) stops both instances from sending the same head item at once. It's kept
// out of the snapshot so claiming/releasing it doesn't trigger a re-render.
const sendingKeys = new Set<string>();

/** Claims the send lock for `key`; returns false if another sender already holds it. */
export function claimChatQueueSend(key: string): boolean {
  if (sendingKeys.has(key)) return false;
  sendingKeys.add(key);
  return true;
}

export function releaseChatQueueSend(key: string): void {
  sendingKeys.delete(key);
}
