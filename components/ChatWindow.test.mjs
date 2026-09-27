import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { stableMessageKey } = await jiti.import("./ChatWindow.tsx");

test("keys a persisted message by its entry id", () => {
  assert.equal(stableMessageKey(0, ["user-1", "assistant-1"]), "user-1");
  assert.equal(stableMessageKey(1, ["user-1", "assistant-1"]), "assistant-1");
});

test("keys a pending (not-yet-persisted) message by its offset past the known entry ids", () => {
  const entryIds = ["user-1", "assistant-1"];
  // messages[2] and messages[3] are still in-flight for the active turn
  // (e.g. the optimistic user bubble and a message_end-appended assistant
  // reply) and have no entry id yet.
  assert.equal(stableMessageKey(2, entryIds), "pending-0");
  assert.equal(stableMessageKey(3, entryIds), "pending-1");
});

test("a pending message's key survives loadOlderMessages prepending older entries", () => {
  // Before: 2 persisted messages, then 2 pending (in-flight) ones.
  const entryIdsBefore = ["user-1", "assistant-1"];
  const pendingIdx = 3; // the second in-flight message
  const keyBefore = stableMessageKey(pendingIdx, entryIdsBefore);

  // loadOlderMessages prepends N older entries to both `messages` and
  // `entryIds` together (see hooks/useAgentSession.ts), so the same pending
  // message now sits N indices further into `messages`, and `entryIds` grew
  // by the same N at its front.
  const olderEntryIds = ["older-user", "older-assistant"];
  const entryIdsAfter = [...olderEntryIds, ...entryIdsBefore];
  const pendingIdxAfter = pendingIdx + olderEntryIds.length;
  const keyAfter = stableMessageKey(pendingIdxAfter, entryIdsAfter);

  assert.equal(keyAfter, keyBefore);
});

test("a persisted message's key is unaffected by a prepend (it just changes which entry id it resolves to, keyed by identity not position)", () => {
  // Persisted messages are keyed directly by their (stable, content-addressed)
  // entry id, so prepending older entries in front of them never changes
  // their key regardless of index shift.
  assert.equal(stableMessageKey(0, ["user-1", "assistant-1"]), "user-1");
  assert.equal(stableMessageKey(2, ["older-user", "older-assistant", "user-1", "assistant-1"]), "user-1");
});
