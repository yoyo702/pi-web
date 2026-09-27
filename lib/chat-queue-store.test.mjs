import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { EMPTY_CHAT_QUEUE, getChatQueue, updateChatQueue, subscribeChatQueues, claimChatQueueSend, releaseChatQueueSend } = await jiti.import("./chat-queue-store.ts");

test("queues are kept per key and notify subscribers", () => {
  let calls = 0;
  const unsubscribe = subscribeChatQueues(() => { calls += 1; });
  updateChatQueue("codex:a", (queue) => ({ ...queue, items: [...queue.items, { text: "one", images: [] }] }));
  updateChatQueue("codex:a", (queue) => ({ ...queue, items: [...queue.items, { text: "two", images: [] }] }));
  assert.deepEqual(getChatQueue("codex:a").items.map((item) => item.text), ["one", "two"]);
  assert.equal(getChatQueue("codex:b"), EMPTY_CHAT_QUEUE);
  assert.equal(calls, 2);
  unsubscribe();
  updateChatQueue("codex:a", () => EMPTY_CHAT_QUEUE);
});

test("the same snapshot is returned until the queue changes", () => {
  updateChatQueue("codex:c", (queue) => ({ ...queue, items: [{ text: "x", images: [] }] }));
  assert.equal(getChatQueue("codex:c"), getChatQueue("codex:c"));
  updateChatQueue("codex:c", () => EMPTY_CHAT_QUEUE);
});

test("an emptied queue is dropped and its failed flag cleared", () => {
  updateChatQueue("codex:d", () => ({ items: [{ text: "x", images: [] }], failed: true }));
  updateChatQueue("codex:d", (queue) => ({ ...queue, items: [] }));
  assert.equal(getChatQueue("codex:d"), EMPTY_CHAT_QUEUE);
});

test("a second claim for the same key fails until released; different keys are independent", () => {
  assert.equal(claimChatQueueSend("codex:e"), true);
  assert.equal(claimChatQueueSend("codex:e"), false);
  assert.equal(claimChatQueueSend("codex:f"), true);
  releaseChatQueueSend("codex:f");
  assert.equal(claimChatQueueSend("codex:e"), false);
  releaseChatQueueSend("codex:e");
  assert.equal(claimChatQueueSend("codex:e"), true);
  releaseChatQueueSend("codex:e");
});

test("moveChatQueue moves a queue to an empty key and leaves a non-empty target alone", async () => {
  const { moveChatQueue } = await jiti.import("./chat-queue-store.ts");
  let calls = 0;
  const unsubscribe = subscribeChatQueues(() => { calls += 1; });
  updateChatQueue("codex:tab-1", () => ({ items: [{ text: "queued", images: [] }], failed: false }));
  calls = 0;
  assert.equal(moveChatQueue("codex:tab-1", "codex:thread-1"), true);
  assert.equal(getChatQueue("codex:tab-1"), EMPTY_CHAT_QUEUE);
  assert.deepEqual(getChatQueue("codex:thread-1").items.map((item) => item.text), ["queued"]);
  assert.equal(calls, 1);

  updateChatQueue("codex:tab-2", () => ({ items: [{ text: "old", images: [] }], failed: false }));
  updateChatQueue("codex:thread-2", () => ({ items: [{ text: "kept", images: [] }], failed: false }));
  assert.equal(moveChatQueue("codex:tab-2", "codex:thread-2"), false);
  assert.deepEqual(getChatQueue("codex:thread-2").items.map((item) => item.text), ["kept"]);
  assert.deepEqual(getChatQueue("codex:tab-2").items.map((item) => item.text), ["old"]);
  assert.equal(moveChatQueue("codex:empty", "codex:thread-3"), false);
  unsubscribe();
  for (const key of ["codex:thread-1", "codex:tab-2", "codex:thread-2"]) updateChatQueue(key, () => EMPTY_CHAT_QUEUE);
});

test("a send in flight during a move finishes on the new key and does not leave the old lock held", async () => {
  const { moveChatQueue, finishChatQueueSend } = await jiti.import("./chat-queue-store.ts");
  const head = { text: "first", images: [] };
  updateChatQueue("claude:tab-3", () => ({ items: [head, { text: "second", images: [] }], failed: false }));
  assert.equal(claimChatQueueSend("claude:tab-3"), true);
  assert.equal(moveChatQueue("claude:tab-3", "claude:session-3"), true);
  // The lock followed the queue.
  assert.equal(claimChatQueueSend("claude:tab-3"), true);
  releaseChatQueueSend("claude:tab-3");
  assert.equal(claimChatQueueSend("claude:session-3"), false);
  // The sender still knows only the old key.
  let lockFreeDuringUpdate = false;
  finishChatQueueSend("claude:tab-3", (queue) => {
    lockFreeDuringUpdate = claimChatQueueSend("claude:session-3");
    if (lockFreeDuringUpdate) releaseChatQueueSend("claude:session-3");
    return queue.items[0] === head ? { items: queue.items.slice(1), failed: false } : queue;
  });
  assert.equal(lockFreeDuringUpdate, true);
  assert.deepEqual(getChatQueue("claude:session-3").items.map((item) => item.text), ["second"]);
  assert.equal(claimChatQueueSend("claude:session-3"), true);
  releaseChatQueueSend("claude:session-3");
  // The old key is a plain key again (e.g. a new chat in the same tab).
  updateChatQueue("claude:tab-3", () => ({ items: [{ text: "new chat", images: [] }], failed: false }));
  assert.equal(claimChatQueueSend("claude:tab-3"), true);
  finishChatQueueSend("claude:tab-3", (queue) => ({ ...queue, failed: true }));
  assert.equal(getChatQueue("claude:tab-3").failed, true);
  assert.equal(getChatQueue("claude:session-3").failed, false);
  updateChatQueue("claude:tab-3", () => EMPTY_CHAT_QUEUE);
  updateChatQueue("claude:session-3", () => EMPTY_CHAT_QUEUE);
});

test("pauseStaleChatQueue pauses a waiting queue but not an empty, failed, or sending one", async () => {
  const { pauseStaleChatQueue } = await jiti.import("./chat-queue-store.ts");
  pauseStaleChatQueue("codex:none");
  assert.equal(getChatQueue("codex:none"), EMPTY_CHAT_QUEUE);

  updateChatQueue("codex:stale", () => ({ items: [{ text: "old", images: [] }], failed: false }));
  pauseStaleChatQueue("codex:stale");
  assert.equal(getChatQueue("codex:stale").paused, true);

  updateChatQueue("codex:failed", () => ({ items: [{ text: "x", images: [] }], failed: true }));
  const failed = getChatQueue("codex:failed");
  pauseStaleChatQueue("codex:failed");
  assert.equal(getChatQueue("codex:failed"), failed);

  updateChatQueue("codex:sending", () => ({ items: [{ text: "x", images: [] }], failed: false }));
  claimChatQueueSend("codex:sending");
  pauseStaleChatQueue("codex:sending");
  assert.equal(getChatQueue("codex:sending").paused, undefined);
  releaseChatQueueSend("codex:sending");
  for (const key of ["codex:stale", "codex:failed", "codex:sending"]) updateChatQueue(key, () => EMPTY_CHAT_QUEUE);
});
