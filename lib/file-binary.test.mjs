import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { isBinaryFile, truncateToUtf8Boundary } = await jiti.import("./file-binary.ts");

function tempFile(t, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-binary-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sample.bin");
  fs.writeFileSync(file, bytes);
  return file;
}

test("a NUL byte anywhere in the sniffed prefix marks a file as binary", (t) => {
  assert.equal(isBinaryFile(tempFile(t, Buffer.from([0x68, 0x69, 0x00, 0x21]))), true);
});

test("plain UTF-8 text is not binary", (t) => {
  assert.equal(isBinaryFile(tempFile(t, Buffer.from("hello world\n", "utf-8"))), false);
});

test("a missing file is treated as not binary (the caller's own stat already 404s)", () => {
  assert.equal(isBinaryFile(path.join(os.tmpdir(), "definitely-does-not-exist.bin")), false);
});

test("truncateToUtf8Boundary leaves a clean ASCII cut untouched", () => {
  const buffer = Buffer.from("hello world", "utf-8");
  assert.equal(truncateToUtf8Boundary(buffer, buffer.length), buffer.length);
});

test("truncateToUtf8Boundary backs up over a 2-byte character split mid-sequence", () => {
  // "a" + U+00E9 ("é", C3 A9). Cut after the lead byte of é.
  const full = Buffer.from("aé", "utf-8");
  assert.deepEqual([...full], [0x61, 0xc3, 0xa9]);
  const cutAfterLeadByte = 2; // keeps 0x61, 0xC3 — the A9 continuation byte is missing
  assert.equal(truncateToUtf8Boundary(full, cutAfterLeadByte), 1);
});

test("truncateToUtf8Boundary backs up over a 3-byte character split at 1 or 2 bytes in", () => {
  // U+4E2D ("中", E4 B8 AD).
  const full = Buffer.from("中", "utf-8");
  assert.deepEqual([...full], [0xe4, 0xb8, 0xad]);
  assert.equal(truncateToUtf8Boundary(full, 1), 0);
  assert.equal(truncateToUtf8Boundary(full, 2), 0);
  assert.equal(truncateToUtf8Boundary(full, 3), 3);
});

test("truncateToUtf8Boundary backs up over a 4-byte character split at 1, 2 or 3 bytes in", () => {
  // U+1F600 ("😀", F0 9F 98 80).
  const full = Buffer.from("\u{1f600}", "utf-8");
  assert.deepEqual([...full], [0xf0, 0x9f, 0x98, 0x80]);
  assert.equal(truncateToUtf8Boundary(full, 1), 0);
  assert.equal(truncateToUtf8Boundary(full, 2), 0);
  assert.equal(truncateToUtf8Boundary(full, 3), 0);
  assert.equal(truncateToUtf8Boundary(full, 4), 4);
});

test("decodeUtf8Text flags invalid UTF-8 and still returns replacement-decoded text", async () => {
  const { decodeUtf8Text } = await jiti.import("./file-binary.ts");
  assert.deepEqual(decodeUtf8Text(Buffer.from("héllo 你好\n", "utf8")), { text: "héllo 你好\n", validUtf8: true });
  // "你好" in GBK: C4 E3 BA C3 — no NUL bytes, but not valid UTF-8.
  const gbk = decodeUtf8Text(Buffer.from([0x61, 0xc4, 0xe3, 0xba, 0xc3, 0x0a]));
  assert.equal(gbk.validUtf8, false);
  assert.match(gbk.text, /^a�/);
  // Latin-1 "café"
  assert.equal(decodeUtf8Text(Buffer.from([0x63, 0x61, 0x66, 0xe9])).validUtf8, false);
  assert.equal(decodeUtf8Text(Buffer.alloc(0)).validUtf8, true);
  // A UTF-8 BOM survives decoding so a save round-trips it.
  assert.equal(decodeUtf8Text(Buffer.from([0xef, 0xbb, 0xbf, 0x61])).text, "\ufeffa");
});

test("isUtf8File checks the bytes on disk", async (t) => {
  const { isUtf8File } = await jiti.import("./file-binary.ts");
  assert.equal(await isUtf8File(tempFile(t, Buffer.from("plain ascii\n"))), true);
  assert.equal(await isUtf8File(tempFile(t, Buffer.from("中文 UTF-8\n", "utf8"))), true);
  assert.equal(await isUtf8File(tempFile(t, Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))), false);
  assert.equal(await isUtf8File(tempFile(t, Buffer.alloc(0))), true);
  // A multi-byte sequence cut off at EOF is invalid.
  assert.equal(await isUtf8File(tempFile(t, Buffer.from([0x61, 0xe4, 0xb8]))), false);
});

test("isUtf8File handles multi-byte characters split across read chunks", async (t) => {
  const { isUtf8File } = await jiti.import("./file-binary.ts");
  // 3-byte characters over several 64 KiB stream chunks, so some straddle a boundary.
  const valid = Buffer.from("中".repeat(100_000), "utf8");
  assert.equal(await isUtf8File(tempFile(t, valid)), true);
  const invalid = Buffer.concat([valid, Buffer.from([0xff])]);
  assert.equal(await isUtf8File(tempFile(t, invalid)), false);
});

test("isUtf8File rejects when the file cannot be read", async () => {
  const { isUtf8File } = await jiti.import("./file-binary.ts");
  await assert.rejects(() => isUtf8File(path.join(os.tmpdir(), "pi-web-missing-" + Date.now())));
});
