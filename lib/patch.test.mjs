import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./patch.ts");
}

test("parses paired changes into split diff rows", async () => {
  const { parseUnifiedPatch } = await loadSubject();
  const files = parseUnifiedPatch(`--- a/demo.ts
+++ b/demo.ts
@@ -10,3 +10,3 @@
 const keep = true;
-const value = "old";
+const value = "new";
 done();
`);

  assert.equal(files?.length, 1);
  assert.equal(files?.[0].oldPath, "a/demo.ts");
  assert.equal(files?.[0].newPath, "b/demo.ts");
  assert.deepEqual(files?.[0].rows.filter((row) => row.type === "line"), [
    {
      type: "line",
      left: { lineNo: 10, text: "const keep = true;", type: "context" },
      right: { lineNo: 10, text: "const keep = true;", type: "context" },
    },
    {
      type: "line",
      left: { lineNo: 11, text: 'const value = "old";', type: "removed" },
      right: { lineNo: 11, text: 'const value = "new";', type: "added" },
    },
    {
      type: "line",
      left: { lineNo: 12, text: "done();", type: "context" },
      right: { lineNo: 12, text: "done();", type: "context" },
    },
  ]);
});

test("pads one-sided additions and removes timestamp suffixes from file paths", async () => {
  const { parseUnifiedPatch } = await loadSubject();
  const files = parseUnifiedPatch(`--- a/demo.ts\t2026-01-01
+++ b/demo.ts\t2026-01-02
@@ -1,1 +1,2 @@
 first
+second
`);

  assert.equal(files?.[0].oldPath, "a/demo.ts");
  assert.equal(files?.[0].newPath, "b/demo.ts");
  assert.deepEqual(files?.[0].rows.at(-1), {
    type: "line",
    left: { lineNo: null, text: "", type: "empty" },
    right: { lineNo: 2, text: "second", type: "added" },
  });
});

test("returns null for text without diff lines", async () => {
  const { parseUnifiedPatch } = await loadSubject();

  assert.equal(parseUnifiedPatch("not a patch"), null);
});

test("reads header-like lines inside a hunk as content, then the next file's headers", async () => {
  const { parseUnifiedPatch } = await loadSubject();
  const files = parseUnifiedPatch(`--- a/schema.sql
+++ /dev/null
@@ -1,2 +0,0 @@
--- comment
-select 1;
--- /dev/null
+++ b/notes.txt
@@ -0,0 +1 @@
+++ x
`);

  assert.deepEqual(files?.map((file) => file.newPath), ["/dev/null", "b/notes.txt"]);
  assert.deepEqual(files?.[0].rows.filter((row) => row.type === "line").map((row) => row.left.text), ["-- comment", "select 1;"]);
  assert.deepEqual(files?.[1].rows.filter((row) => row.type === "line").map((row) => row.right.text), ["++ x"]);
});
