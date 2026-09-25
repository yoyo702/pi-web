import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const notifications = require("../server/notifications.cjs");

function fakeSession(cwd) {
  let listener = () => {};
  const inner = {
    sessionId: "pi-session", sessionFile: join(cwd, "s.jsonl"), isStreaming: false, isCompacting: false, isBashRunning: false,
    sessionManager: { getCwd: () => cwd, getSessionName: () => "Release notes", getEntries: () => [] },
    subscribe(fn) { listener = fn; return () => {}; },
    dispose() {},
  };
  return { inner, emit: (event) => listener(event) };
}
const assistant = (stopReason, errorMessage) => ({ type: "agent_end", messages: [{ role: "assistant", stopReason, errorMessage }] });

test("a Pi run is recorded once it settles, from its last agent_end", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-pi-notify-"));
  const previous = process.env.PI_WEB_NOTIFICATIONS_FILE;
  process.env.PI_WEB_NOTIFICATIONS_FILE = join(cwd, "notifications.json");
  notifications._resetForTests();
  const { inner, emit } = fakeSession(cwd);
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.start();
  t.after(() => { wrapper.destroy(); process.env.PI_WEB_NOTIFICATIONS_FILE = previous; notifications._resetForTests(); rmSync(cwd, { recursive: true, force: true }); });
  const settled = async () => { emit({ type: "agent_settled" }); await new Promise((resolve) => setTimeout(resolve, 50)); };

  // A retried error is not a failure: only the final agent_end counts.
  emit(assistant("error", "429"));
  assert.equal(notifications.list().length, 0);
  emit(assistant("stop"));
  await settled();
  assert.deepEqual(notifications.list().map((item) => [item.kind, item.event, item.title, item.targetId, item.cwd]), [["pi", "completed", "Release notes", "pi-session", cwd]]);

  emit(assistant("error", "Overloaded"));
  await settled();
  assert.deepEqual([notifications.list()[0].event, notifications.list()[0].detail], ["failed", "Overloaded"]);

  // Aborted runs and settles without a run are not recorded.
  emit(assistant("aborted"));
  await settled();
  await settled();
  assert.equal(notifications.list().length, 2);
});
