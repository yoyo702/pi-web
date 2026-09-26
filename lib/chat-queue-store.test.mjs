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
