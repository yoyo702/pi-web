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

export const EMPTY_CHAT_QUEUE: ChatQueue = Object.freeze({ items: [], failed: false }) as ChatQueue;

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
