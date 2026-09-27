import type { ChatDraftImage } from "./draft-store";

export interface QueuedChatMessage {
  text: string;
  images: ChatDraftImage[];
}

export interface ChatQueue {
  items: QueuedChatMessage[];
  /** Sending the first item failed; the queue waits for Retry. */
  failed: boolean;
  /**
   * The queue was already there when the chat opened with no turn running
   * (e.g. a closed session reopened), so it waits for Retry instead of
   * sending stale messages on its own.
   */
  paused?: boolean;
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
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Moves the queue under `from` to `to` when `to` has none — a new chat's key
 * changes once it gets its thread/session id. A send lock held on `from` moves
 * with it; finishChatQueueSend(from, …) then completes on `to`.
 * Returns whether anything moved.
 */
export function moveChatQueue(from: string, to: string): boolean {
  if (from === to) return false;
  const queue = queues.get(from);
  if (!queue || queues.has(to)) return false;
  queues.delete(from);
  queues.set(to, queue);
  if (sendingKeys.delete(from)) {
    sendingKeys.add(to);
    movedSends.set(from, to);
  }
  notify();
  return true;
}

/**
 * Holds a queue found when a chat opens with no turn running: the messages
 * may be stale (a closed session reopened), so it waits for Retry. Skips a
 * queue that is empty, already failed, or being sent by another mounted tab.
 */
export function pauseStaleChatQueue(key: string): void {
  const queue = getChatQueue(key);
  if (!queue.items.length || queue.failed || queue.paused || sendingKeys.has(key)) return;
  updateChatQueue(key, (current) => ({ ...current, paused: true }));
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
// Where a send claimed on one key went after moveChatQueue(); kept only until
// that send finishes.
const movedSends = new Map<string, string>();

/** Claims the send lock for `key`; returns false if another sender already holds it. */
export function claimChatQueueSend(key: string): boolean {
  if (sendingKeys.has(key)) return false;
  sendingKeys.add(key);
  return true;
}

export function releaseChatQueueSend(key: string): void {
  sendingKeys.delete(key);
}

/**
 * Ends a send claimed on `key` (following any moveChatQueue()): releases the
 * lock first, so the re-render the update triggers can claim the next item,
 * then applies `update`.
 */
export function finishChatQueueSend(key: string, update: (queue: ChatQueue) => ChatQueue): void {
  let target = key;
  for (let next = movedSends.get(target); next !== undefined; next = movedSends.get(target)) {
    movedSends.delete(target);
    target = next;
  }
  releaseChatQueueSend(target);
  updateChatQueue(target, update);
}
