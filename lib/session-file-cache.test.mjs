import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { invalidateSessionFileCache, openSessionForRead, readSessionFileEntries } = await jiti.import("./session-file-cache.ts");

const header = { type: "session", version: 3, id: "01a086c3-1cae-7477-b0a6-46d3c2fc0fe5", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/workspace" };
let lastId = null;
let counter = 0;
function message(role, text) {
  const id = `e${String(counter += 1).padStart(7, "0")}`;
  const entry = { type: "message", id, parentId: lastId, timestamp: "2026-01-01T00:00:00.000Z", message: { role, content: [{ type: "text", text }], timestamp: 0 } };
  lastId = id;
  return `${JSON.stringify(entry)}\n`;
}

function withSessionFile(content, callback) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-session-cache-"));
  const file = join(directory, "session.jsonl");
  writeFileSync(file, content);
  lastId = null;
  try {
    return callback(file);
  } finally {
    invalidateSessionFileCache();
    rmSync(directory, { recursive: true, force: true });
  }
}

const sdkEntries = (file) => SessionManager.open(file).getEntries();
const cachedEntries = (file) => openSessionForRead(file).getEntries();

test("matches the SDK loader across read-chunk boundaries and multibyte text", () => {
  lastId = null;
  let content = `${JSON.stringify(header)}\n`;
  for (let index = 0; index < 400; index += 1) content += message(index % 2 ? "assistant" : "user", `界 ${index} ${"x".repeat(4000)}`);
  content += "not json\n\n";
  withSessionFile(content, (file) => {
    assert.deepEqual(cachedEntries(file), sdkEntries(file));
    assert.equal(openSessionForRead(file).getLeafId(), SessionManager.open(file).getLeafId());
  });
});

test("parses only appended lines and reuses earlier entries", () => {
  withSessionFile(`${JSON.stringify(header)}\n`, (file) => {
    appendFileSync(file, message("user", "first"));
    const before = readSessionFileEntries(file);
    const firstEntry = before[1];
    appendFileSync(file, message("assistant", "second"));
    const after = readSessionFileEntries(file);
    assert.equal(after.length, 3);
    assert.equal(after[1], firstEntry, "earlier entries are reused, not re-parsed");
    assert.deepEqual(cachedEntries(file), sdkEntries(file));
  });
});

test("re-parses the whole file when it was rewritten", () => {
  withSessionFile(`${JSON.stringify(header)}\n`, (file) => {
    appendFileSync(file, message("user", "original"));
    const before = readSessionFileEntries(file);
    lastId = null;
    writeFileSync(file, `${JSON.stringify(header)}\n${message("user", "replaced")}${message("assistant", "and longer")}`);
    const after = readSessionFileEntries(file);
    assert.notEqual(after[1], before[1]);
    assert.equal(after[1].message.content[0].text, "replaced");
    assert.deepEqual(cachedEntries(file), sdkEntries(file));

    writeFileSync(file, `${JSON.stringify(header)}\n`);
    assert.equal(readSessionFileEntries(file).length, 1, "a shrunk file is re-read");
  });
});

test("includes a parseable unterminated last line without caching it", () => {
  withSessionFile(`${JSON.stringify(header)}\n`, (file) => {
    const line = message("user", "no newline yet");
    appendFileSync(file, line.trimEnd());
    assert.equal(readSessionFileEntries(file).length, 2);
    appendFileSync(file, `\n${message("assistant", "next")}`);
    const entries = readSessionFileEntries(file);
    assert.deepEqual(entries.map((entry) => entry.type), ["session", "message", "message"]);

    appendFileSync(file, '{"type":"message","id":"partial');
    assert.equal(readSessionFileEntries(file).length, 3, "a half-written line is skipped");
  });
});

test("returns null for files that are not pi sessions", () => {
  withSessionFile(`${JSON.stringify({ type: "message", id: "x" })}\n`, (file) => {
    assert.equal(readSessionFileEntries(file), null);
  });
});

test("hands older format versions to the SDK loader", () => {
  withSessionFile(`${JSON.stringify({ ...header, version: 2 })}\n`, (file) => {
    assert.equal(readSessionFileEntries(file), null);
  });
});

test("opens a session whose file does not exist yet without creating it", () => {
  withSessionFile("", (file) => {
    const missing = `${file}.missing.jsonl`;
    assert.deepEqual(openSessionForRead(missing).getEntries(), []);
    assert.equal(existsSync(missing), false);
  });
});

test("parses lines longer than one read chunk", () => {
  withSessionFile(`${JSON.stringify(header)}\n`, (file) => {
    appendFileSync(file, message("assistant", "界".repeat(1024 * 1024)));
    appendFileSync(file, message("user", "after"));
    assert.deepEqual(cachedEntries(file), sdkEntries(file));
  });
});
