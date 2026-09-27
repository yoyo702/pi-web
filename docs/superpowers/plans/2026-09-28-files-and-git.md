# Files & Git follow-ups (product audit)

## Goal

Nine product-audit findings were raised against Explorer file viewing and Git
Review. Fix the ones that are still real: the file viewer can't edit/save,
binary files render as garbage text, files over 256 KB hard-error instead of
offering a truncated view, Explorer search only matches file names, Commit has
no Amend option, History has no revert, the commit-message draft is lost on
navigation, and Pull is blocked too aggressively. Ship each as an independently
shippable, tested change.

There is no separate spec document for this work — it is a product audit with
no design doc. Each task below states the exact current behavior (verified by
reading the code, not assumed from the audit note) and the exact fix.

## Architecture

Next.js 16 App Router route handlers under `app/api/**/route.ts`, a shared
`lib/*.ts` layer with the actual logic (git wrapper, file-access allow-list,
file-type helpers), and client components in `components/*.tsx`. Route
handlers are thin: they validate input, call into `lib/*.ts`, and translate
errors via `lib/http-error.ts`. Every file/Git request is authorized through
`lib/file-access.ts`'s allow-list before touching disk.

## Tech Stack

Next.js 16, React 19, TypeScript, a custom Node server. Unit tests are
`lib/*.test.mjs` run with `node --test` via `npm test`; TS modules with
non-trivial syntax are loaded through `jiti` (`createJiti(import.meta.url)`),
simpler ones via plain dynamic `import()` (see each existing test file for the
one it already uses — match it, don't introduce a third style). E2E tests are
Playwright specs under `e2e/`.

## Spec

No spec document. Source of truth is the 9-item audit list below (items 1-8
kept as tasks; item 9 dropped — see "Facts the implementer needs").

1. File viewer can't edit and save.
2. Binary files open as text and show garbage.
3. Files over 256 KB hard-error.
4. Explorer search only matches file names.
5. Backend supports commit amend but the UI has no option for it.
6. No revert/reset from History.
7. Commit message draft isn't saved across navigation.
8. Pull is blocked whenever there are any untracked/uncommitted files.
9. History may time out on very long repos.

## Global Constraints

- UI copy is English. `docs/prd/*.md` files are Chinese and must be updated in
  the same commit as any behavior change they describe.
- No new npm dependencies.
- Every task ends with these gates, all passing, before moving to the next task:
  - `npx tsc --noEmit -p .`
  - `npx eslint <every file you touched in this task>`
  - `npm test`
  - `npx playwright test e2e/files-git.spec.ts`
- New unit tests go in `lib/*.test.mjs` (or an existing one, when a task
  extends a module that already has one), run via `node --test` through
  `npm test`. Follow `lib/git-discard.test.mjs`'s pattern for anything that
  needs a real temp Git repo (`mkdtempSync` + `execFileSync("git", ...)`,
  `t.after(() => fs.rmSync(..., { recursive: true, force: true }))`).
- All new E2E tests for this plan go in one new file: `e2e/files-git.spec.ts`.
  Do not add them to existing spec files.
- Line numbers cited below are hints, not guarantees — the branch is actively
  moving. Match by the quoted code, not the number.
- **Security**: any new code path that writes to disk (Task 3's save endpoint)
  must go through the same allow-list checks every existing file route uses:
  `getAllowedFileRoots()` → `isFilePathAllowed()` → `fs.statSync` →
  `isExistingFilePathAllowed()`, plus a realpath-based re-check before the
  write (the exact pattern `getUploadDirectory` already uses in
  `app/api/files/[...path]/route.ts`, lines 86-121). No new path-traversal
  surface.

## Facts the implementer needs

**Item 9 (history pagination) is already fully implemented — it is not a task
in this plan.** Verified in both layers:

- Backend: `lib/git-changes.ts`'s `getGitLog(cwd, { limit, skip })` (lines
  411-443) already clamps `limit` to `[1, 500]`, applies `skip`, and returns
  `hasMore: records.length > limit`. `app/api/git/log/route.ts` already wires
  `limit`/`skip` query params straight through.
- Frontend: `components/GitReviewPanel.tsx`'s `HistoryView` already calls
  `load(true)` to append more commits, tracks `loadingMore`/`loadMoreError`,
  and renders a "Load more · N shown" / "Retry loading more" button (around
  line 1032) whenever `log.hasMore` is true.

Nothing to build here. If you find a real timeout complaint in the future,
it's a different bug (e.g. a single `git log` call being slow on a specific
repo), not a missing pagination feature.

**"Reset" is intentionally dropped from item 6.** The audit item said "add
revert/reset... reset only if it can be made safe... otherwise drop and say
so." A general reset endpoint is unsafe to expose from a web UI (it can
destroy commits, including ones already pushed, with much less protection
than `git revert`'s "creates a new commit" safety net). Even the narrowed
"soft reset of the last unpushed commit" variant needs reliable "is this
pushed" detection, detached-HEAD handling, and its own UI confirmation
design — that's new scope beyond a P2 audit fix. This plan implements revert
only (Task 6) and does not add reset.

**Item 8's real bug is broader than "blocks on untracked files."** Reading
`lib/git-changes.ts`'s `syncGitRemote` (lines 140-165), the current code calls
`readStatusEntries` and throws if there are **any** uncommitted changes —
modified tracked files included, not just untracked ones. The fix in Task 8
removes that manual check entirely and lets `git pull --ff-only` run and
report its own (correct, narrow) failure.

## Task 1: Detect binary files and show a placeholder

Binary files (images/audio/PDF/DOCX aside — those already have dedicated
previews via `isImagePath`/`isAudioPath`/`isDocumentPreviewPath`, confirmed in
`components/FileViewer.tsx`'s exported `FileViewer` dispatcher, lines
781-792) fall through to the plain-text path today: `fs.readFileSync(...,
"utf-8")` on arbitrary bytes, rendered as garbage. There is no binary
detection anywhere in this codebase yet.

This task also adds `mtimeMs` to every successful `type=read` response, since
Task 3 (edit/save) needs it and every branch of the handler already has
`stat` in scope — avoids a second edit to the same lines later.

**Files:**
- `lib/file-types.ts` (add a pure helper — no `fs` import, this file is
  imported by the client component `FileViewer.tsx`)
- `lib/file-binary.ts` (new — server-only, uses `fs`)
- `lib/file-binary.test.mjs` (new)
- `app/api/files/[...path]/route.ts` (modify `type === "read"`)
- `components/FileViewer.tsx` (modify `FileData`, `fetchContent`, add a binary
  placeholder render)
- `docs/prd/workspace-explorer.md`

**Steps:**

1. Add to `lib/file-types.ts` (end of file):
   ```ts
   /** Sniffs a byte prefix for a NUL byte — the same heuristic Git and most
    * editors use to call a file "binary" for preview purposes. */
   export function isBinaryBuffer(bytes: Uint8Array): boolean {
     for (let i = 0; i < bytes.length; i++) {
       if (bytes[i] === 0) return true;
     }
     return false;
   }
   ```

2. Write `lib/file-binary.ts`:
   ```ts
   import fs from "fs";
   import { isBinaryBuffer } from "./file-types";

   const BINARY_SNIFF_BYTES = 8000;

   /** Reads a small prefix of the file and checks it for a NUL byte. Never
    * throws: a file that can't be opened is treated as "not binary" so the
    * caller's own stat/read calls produce the real error. */
   export function isBinaryFile(filePath: string): boolean {
     let fd: number;
     try {
       fd = fs.openSync(filePath, "r");
     } catch {
       return false;
     }
     try {
       const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
       const bytesRead = fs.readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
       return isBinaryBuffer(buffer.subarray(0, bytesRead));
     } finally {
       fs.closeSync(fd);
     }
   }
   ```

3. Write `lib/file-binary.test.mjs`:
   ```js
   import assert from "node:assert/strict";
   import fs from "node:fs";
   import os from "node:os";
   import path from "node:path";
   import test from "node:test";
   import { createJiti } from "jiti";

   const jiti = createJiti(import.meta.url);
   const { isBinaryFile } = await jiti.import("./file-binary.ts");

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

   test("a missing file is treated as not binary (the caller's own stat already 404s)", (t) => {
     assert.equal(isBinaryFile(path.join(os.tmpdir(), "definitely-does-not-exist.bin")), false);
   });
   ```
   Run `node --test lib/file-binary.test.mjs` and confirm it's green.

4. In `app/api/files/[...path]/route.ts`, add the import:
   ```ts
   import { isBinaryFile } from "@/lib/file-binary";
   ```
   Then replace the `type === "read"` block (currently lines 487-512):
   ```ts
       if (type === "read") {
         if (!stat.isFile()) {
           return NextResponse.json({ error: "Not a file" }, { status: 400 });
         }
         const imageMime = getImageMime(filePath);
         if (imageMime) {
           if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
             return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
           }
           return streamFile(filePath, stat, imageMime, request.headers.get("range"));
         }
         const audioMime = getAudioMime(filePath);
         if (audioMime) {
           return streamFile(filePath, stat, audioMime, request.headers.get("range"));
         }
         const documentMime = getDocumentMime(filePath);
         if (documentMime) {
           return streamFile(filePath, stat, documentMime, request.headers.get("range"));
         }
         if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
           return NextResponse.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
         }
         const content = fs.readFileSync(filePath, "utf-8");
         const language = getLanguage(filePath);
         return NextResponse.json({ content, language, size: stat.size });
       }
   ```
   with:
   ```ts
       if (type === "read") {
         if (!stat.isFile()) {
           return NextResponse.json({ error: "Not a file" }, { status: 400 });
         }
         const imageMime = getImageMime(filePath);
         if (imageMime) {
           if (stat.size > IMAGE_PREVIEW_MAX_BYTES) {
             return NextResponse.json({ error: "Image too large (>10MB)" }, { status: 413 });
           }
           return streamFile(filePath, stat, imageMime, request.headers.get("range"));
         }
         const audioMime = getAudioMime(filePath);
         if (audioMime) {
           return streamFile(filePath, stat, audioMime, request.headers.get("range"));
         }
         const documentMime = getDocumentMime(filePath);
         if (documentMime) {
           return streamFile(filePath, stat, documentMime, request.headers.get("range"));
         }
         if (isBinaryFile(filePath)) {
           return NextResponse.json({ binary: true, size: stat.size, mtimeMs: stat.mtimeMs, language: getLanguage(filePath) });
         }
         if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
           return NextResponse.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
         }
         const content = fs.readFileSync(filePath, "utf-8");
         const language = getLanguage(filePath);
         return NextResponse.json({ content, language, size: stat.size, mtimeMs: stat.mtimeMs });
       }
   ```

5. In `components/FileViewer.tsx`, extend `FileData` (currently lines 38-42):
   ```ts
   interface FileData {
     content: string;
     language: string;
     size: number;
     mtimeMs: number;
     binary?: boolean;
   }
   ```
   Replace `fetchContent` (currently lines 808-824) with:
   ```ts
   const fetchContent = useCallback((filePath: string) => {
     return fetch(getFileApiUrl(filePath, "read", sourceSessionId))
       .then(async (r) => {
         const raw = await r.json() as Partial<FileData> & { error?: string };
         if (!r.ok) {
           setError(raw.error ?? `Failed to load file (${r.status})`);
           return null;
         }
         const next: FileData = {
           content: raw.content ?? "",
           language: raw.language ?? "text",
           size: raw.size ?? 0,
           mtimeMs: raw.mtimeMs ?? 0,
           binary: raw.binary,
         };
         setError(null);
         setData(next);
         return next;
       })
       .catch((e) => {
         setError(String(e));
         return null;
       });
   }, [sourceSessionId]);
   ```
   Right after `if (!data) return null;` (currently line 1015), add an early
   return for binary files, before any code reads `data.content`:
   ```tsx
   if (data.binary) {
     return (
       <div className="file-viewer-shell" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
         <div
           className="file-viewer-toolbar"
           style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 12px", borderBottom: "1px solid var(--border)", fontSize: 11, color: "var(--text-dim)", background: "var(--bg)", flexShrink: 0 }}
         >
           <span className="file-viewer-path" style={{ fontFamily: "var(--font-mono)" }} title={filePath}>
             {getRelativeFilePath(filePath, cwd)}
           </span>
           <span className="file-viewer-meta">{formatSize(data.size)}</span>
           <div className="file-viewer-controls">
             <DownloadLink filePath={filePath} sourceSessionId={sourceSessionId} />
           </div>
         </div>
         <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 13 }}>
           Binary file — preview isn't available. Use Download to save a copy.
         </div>
       </div>
     );
   }
   ```

6. Add to `docs/prd/workspace-explorer.md`'s "已实现范围" section, after the
   line "文件在中央或右侧标签中打开，并支持外部修改同步。":
   ```
   - 二进制文件不再以乱码文本展示：读取时嗅探文件头是否包含 NUL 字节，识别为二进制后显示 "Binary file" 占位提示，仍可下载。
   ```

7. Run: `npx tsc --noEmit -p .`
8. Run: `npx eslint lib/file-types.ts lib/file-binary.ts app/api/files/[...path]/route.ts components/FileViewer.tsx`
9. Run: `npm test`
10. Add the e2e test (see Task 1's block in the new `e2e/files-git.spec.ts` —
    written once, in full, at the end of Task 3's steps, since all three
    file-read tasks share one spec file). For now, run
    `npx playwright test e2e/files-git.spec.ts -g "binary"` once the test
    exists.

## Task 2: Offer a truncated read for files over 256 KB

`TEXT_PREVIEW_MAX_BYTES = 256 * 1024` (`lib/file-types.ts`) currently causes a
hard 413 with no recovery. Builds directly on Task 1's edit to the same
`type === "read"` block.

**Files:**
- `app/api/files/[...path]/route.ts` (extend `type === "read"` again)
- `components/FileViewer.tsx` (extend `FileData`, `fetchContent`, add an
  oversized-file view and a "Truncated" toolbar badge)

**Steps:**

1. In `app/api/files/[...path]/route.ts`, replace the tail of the
   `type === "read"` block — everything from the `isBinaryFile` check
   (added in Task 1) through the final `return NextResponse.json(...)`:
   ```ts
         if (isBinaryFile(filePath)) {
           return NextResponse.json({ binary: true, size: stat.size, mtimeMs: stat.mtimeMs, language: getLanguage(filePath) });
         }
         if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
           return NextResponse.json({ error: "File too large for preview (>256KB)" }, { status: 413 });
         }
         const content = fs.readFileSync(filePath, "utf-8");
         const language = getLanguage(filePath);
         return NextResponse.json({ content, language, size: stat.size, mtimeMs: stat.mtimeMs });
       }
   ```
   with:
   ```ts
         if (isBinaryFile(filePath)) {
           return NextResponse.json({ binary: true, size: stat.size, mtimeMs: stat.mtimeMs, language: getLanguage(filePath) });
         }
         const truncateRequested = request.nextUrl.searchParams.get("truncate") === "1";
         if (stat.size > TEXT_PREVIEW_MAX_BYTES && !truncateRequested) {
           return NextResponse.json({
             error: "File too large for preview (>256KB)",
             size: stat.size,
             canTruncate: true,
           }, { status: 413 });
         }
         let content: string;
         let truncated = false;
         if (stat.size > TEXT_PREVIEW_MAX_BYTES) {
           const fd = fs.openSync(filePath, "r");
           try {
             const buffer = Buffer.alloc(TEXT_PREVIEW_MAX_BYTES);
             const bytesRead = fs.readSync(fd, buffer, 0, TEXT_PREVIEW_MAX_BYTES, 0);
             content = buffer.toString("utf-8", 0, bytesRead);
           } finally {
             fs.closeSync(fd);
           }
           truncated = true;
         } else {
           content = fs.readFileSync(filePath, "utf-8");
         }
         const language = getLanguage(filePath);
         return NextResponse.json({ content, language, size: stat.size, mtimeMs: stat.mtimeMs, truncated });
       }
   ```

2. In `components/FileViewer.tsx`, extend `FileData` (from Task 1) with
   `truncated?: boolean;`:
   ```ts
   interface FileData {
     content: string;
     language: string;
     size: number;
     mtimeMs: number;
     binary?: boolean;
     truncated?: boolean;
   }
   ```
   Replace `fetchContent` (from Task 1) with a version that takes an options
   argument and tracks the oversized/canTruncate case:
   ```ts
   const fetchContent = useCallback((filePath: string, options: { truncate?: boolean } = {}) => {
     return fetch(getFileApiUrl(filePath, "read", sourceSessionId, options.truncate ? { truncate: 1 } : {}))
       .then(async (r) => {
         const raw = await r.json() as Partial<FileData> & { error?: string; canTruncate?: boolean; size?: number };
         if (!r.ok) {
           setError(raw.error ?? `Failed to load file (${r.status})`);
           setOversized(raw.canTruncate ? { size: raw.size ?? 0 } : null);
           return null;
         }
         const next: FileData = {
           content: raw.content ?? "",
           language: raw.language ?? "text",
           size: raw.size ?? 0,
           mtimeMs: raw.mtimeMs ?? 0,
           binary: raw.binary,
           truncated: raw.truncated,
         };
         setError(null);
         setOversized(null);
         setData(next);
         return next;
       })
       .catch((e) => {
         setError(String(e));
         setOversized(null);
         return null;
       });
   }, [sourceSessionId]);
   ```
   Add a new state near the other `TextFileViewer` state (next to
   `const [error, setError] = useState<string | null>(null);`):
   ```ts
   const [oversized, setOversized] = useState<{ size: number } | null>(null);
   ```
   In the initial-load effect, reset it alongside the other resets (next to
   `setError(null);`):
   ```ts
   setOversized(null);
   ```
   Add a render branch right after the existing `if (error) { ... }` block
   (currently lines 1007-1013), before `if (!data) return null;`:
   ```tsx
   if (oversized) {
     return (
       <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24, color: "var(--text-muted)", fontSize: 13, textAlign: "center" }}>
         <div>This file is {formatSize(oversized.size)}, over the 256 KB preview limit.</div>
         <button
           type="button"
           onClick={() => void fetchContent(filePath, { truncate: true })}
           style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg-panel)", color: "var(--accent)" }}
         >
           Show first 256 KB
         </button>
       </div>
     );
   }
   ```
   Add a "Truncated" badge in the toolbar, right after
   `<span className="file-viewer-meta" title={metadata}>{metadata}</span>`
   (currently line 1049):
   ```tsx
   {data.truncated && (
     <span style={{ color: "#d6a84b" }} title="Only the first 256 KB is shown. Editing is disabled for truncated files.">
       Truncated
     </span>
   )}
   ```

3. Run: `npx tsc --noEmit -p .`
4. Run: `npx eslint app/api/files/[...path]/route.ts components/FileViewer.tsx`
5. Run: `npm test`
6. Run: `npx playwright test e2e/files-git.spec.ts -g "truncat"` once the test
   exists (added at the end of Task 3).

## Task 3: Editable text files with save + conflict detection

The file viewer has no edit mode at all today — `TextFileViewer` only ever
renders `sourceView` (a read-only `SyntaxHighlighter`). This task adds an
edit/save flow with an optimistic-concurrency conflict check: refuse to save
if the file changed on disk since the client's last read, comparing the
client-supplied `mtimeMs` (Task 1) to the file's current `mtimeMs`.

**Files:**
- `app/api/files/[...path]/route.ts` (new `getWritableFilePath` helper, new
  `type=write` POST branch)
- `components/FileViewer.tsx` (edit state, textarea, toolbar Edit/Save/Cancel,
  SSE-vs-editing guard)
- `docs/prd/workspace-explorer.md`

**Steps:**

1. In `app/api/files/[...path]/route.ts`, add a helper right after
   `getUploadDirectory` (currently ends at line 121) — same symlink-escape
   pattern, but for a single existing file instead of a directory:
   ```ts
   async function getWritableFilePath(segments: string[]): Promise<
     { filePath: string } | { response: NextResponse }
   > {
     const filePath = filePathFromSegments(segments);
     const allowedRoots = await getAllowedFileRoots();
     if (!isFilePathAllowed(filePath, allowedRoots)) {
       return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
     }

     let stat: fs.Stats;
     try {
       stat = fs.statSync(filePath);
     } catch {
       return { response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
     }
     if (!stat.isFile()) {
       return { response: NextResponse.json({ error: "Not a file" }, { status: 400 }) };
     }
     if (!isExistingFilePathAllowed(filePath, allowedRoots)) {
       return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
     }

     // A file can be a symlink. Resolve both sides before writing so a
     // symlink inside an allowed root cannot redirect the write outside it.
     const realFilePath = fs.realpathSync(filePath);
     const realRoots = new Set<string>();
     for (const root of allowedRoots) {
       try {
         realRoots.add(fs.realpathSync(root));
       } catch {
         // Ignore stale session roots that no longer exist.
       }
     }
     if (!isFilePathAllowed(realFilePath, realRoots)) {
       return { response: NextResponse.json({ error: "Access denied" }, { status: 403 }) };
     }

     return { filePath: realFilePath };
   }
   ```

2. Change the top of `POST` (currently lines 128-137) so `type` is read
   before deciding whether `segments` names a directory (uploads) or a file
   (write) — today `getUploadDirectory` runs unconditionally first, which
   would misinterpret a file path as a directory for `type=write`:
   ```ts
   export async function POST(
     request: NextRequest,
     { params }: { params: Promise<{ path: string[] }> }
   ) {
     try {
       const { path: segments } = await params;
       const type = request.nextUrl.searchParams.get("type") ?? "upload";

       if (type === "write") {
         const writable = await getWritableFilePath(segments);
         if ("response" in writable) return writable.response;
         const { filePath } = writable;

         const body = await request.json().catch(() => null) as { content?: unknown; mtimeMs?: unknown } | null;
         if (!body || typeof body.content !== "string") {
           return NextResponse.json({ error: "content must be a string" }, { status: 400 });
         }
         if (isBinaryFile(filePath)) {
           return NextResponse.json({ error: "Binary files cannot be edited here" }, { status: 400 });
         }

         const currentStat = fs.statSync(filePath);
         if (typeof body.mtimeMs === "number" && body.mtimeMs !== currentStat.mtimeMs) {
           return NextResponse.json({
             error: "This file changed on disk since it was loaded. Reload it to see the latest version before saving.",
           }, { status: 409 });
         }

         fs.writeFileSync(filePath, body.content, "utf-8");
         const nextStat = fs.statSync(filePath);
         return NextResponse.json({ size: nextStat.size, mtimeMs: nextStat.mtimeMs });
       }

       const uploadDirectory = await getUploadDirectory(segments);
       if ("response" in uploadDirectory) return uploadDirectory.response;
       const { directory } = uploadDirectory;

       if (type === "upload-check") {
   ```
   The rest of the existing `POST` body (from `const body = await
   request.json().catch(() => null) as { fileNames?: unknown } | null;`
   onward) is unchanged — just now reached only for `type !== "write"`,
   with `type` already computed above instead of re-read.
   (`type` was previously declared again at
   `const type = request.nextUrl.searchParams.get("type") ?? "upload";`
   inside the old flow — delete that duplicate declaration, since `type` is
   now computed once at the top.)

3. In `components/FileViewer.tsx`, extend `getFileApiUrl`'s type union
   (currently line 197):
   ```ts
   type: "read" | "write" | "download" | "meta" | "preview" | "watch",
   ```
   Add new state next to the existing `TextFileViewer` state:
   ```ts
   const [editing, setEditing] = useState(false);
   const [draftContent, setDraftContent] = useState("");
   const [saving, setSaving] = useState(false);
   const [saveError, setSaveError] = useState<string | null>(null);
   const [externalChangeWhileEditing, setExternalChangeWhileEditing] = useState(false);
   const editingRef = useRef(false);
   editingRef.current = editing;
   ```
   In the initial-load effect, reset the new state alongside the existing
   resets:
   ```ts
   setEditing(false);
   setDraftContent("");
   setSaveError(null);
   setExternalChangeWhileEditing(false);
   ```
   Replace the SSE `"change"` handler (currently lines 871-874) so an
   in-progress edit is never silently overwritten:
   ```ts
   es.addEventListener("change", () => {
     if (editingRef.current) {
       setExternalChangeWhileEditing(true);
       return;
     }
     void fetchContent(filePath);
     void fetchGitDiff(filePath);
   });
   ```
   Add callbacks after `fetchGitDiff`'s definition:
   ```ts
   const startEditing = useCallback(() => {
     if (!data || data.binary || data.truncated) return;
     setDraftContent(data.content);
     setSaveError(null);
     setExternalChangeWhileEditing(false);
     setEditing(true);
   }, [data]);

   const cancelEditing = useCallback(() => {
     setEditing(false);
     setSaveError(null);
   }, []);

   const saveEdits = useCallback(async () => {
     if (!data) return;
     setSaving(true);
     setSaveError(null);
     try {
       const response = await fetch(getFileApiUrl(filePath, "write", sourceSessionId), {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ content: draftContent, mtimeMs: data.mtimeMs }),
       });
       const next = await response.json() as { error?: string; size?: number; mtimeMs?: number };
       if (!response.ok) {
         setSaveError(next.error ?? `Could not save (${response.status})`);
         return;
       }
       setData({ ...data, content: draftContent, size: next.size ?? draftContent.length, mtimeMs: next.mtimeMs ?? data.mtimeMs });
       setEditing(false);
     } catch (e) {
       setSaveError(String(e));
     } finally {
       setSaving(false);
     }
   }, [data, draftContent, filePath, sourceSessionId]);
   ```
   In the toolbar, inside the existing `{displayMode === "source" && (<>...
   </>)}` block (currently lines 1086-1119), add Edit/Save/Cancel right
   before the closing `</>`:
   ```tsx
   {!data.binary && !data.truncated && (
     editing ? (
       <>
         <button type="button" onClick={() => void saveEdits()} disabled={saving} title="Save changes" aria-label="Save changes" className="file-viewer-icon-button">
           {saving ? "Saving…" : "Save"}
         </button>
         <button type="button" onClick={cancelEditing} disabled={saving} title="Discard edits" aria-label="Discard edits" className="file-viewer-icon-button">
           Cancel
         </button>
       </>
     ) : (
       <button type="button" onClick={startEditing} title="Edit file" aria-label="Edit file" className="file-viewer-icon-button">
         Edit
       </button>
     )
   )}
   ```
   Add banners right after the toolbar `<div>` closes and before the content
   area `<div ref={contentRef} ...>` (currently line 1127):
   ```tsx
   {saveError && (
     <div role="alert" style={{ padding: "6px 12px", color: "#f87171", fontSize: 11.5, borderBottom: "1px solid var(--border)" }}>
       {saveError}
       {saveError.includes("changed on disk") && (
         <button
           type="button"
           onClick={() => { setSaveError(null); void fetchContent(filePath).then((d) => { if (d) setDraftContent(d.content); }); }}
           style={{ marginLeft: 8, textDecoration: "underline", background: "none", border: "none", color: "inherit", cursor: "pointer", font: "inherit" }}
         >
           Reload
         </button>
       )}
     </div>
   )}
   {externalChangeWhileEditing && (
     <div role="status" style={{ padding: "6px 12px", color: "var(--text-dim)", fontSize: 11.5, borderBottom: "1px solid var(--border)" }}>
       This file changed on disk while you were editing. Saving will be refused unless you reload first.
     </div>
   )}
   ```
   Finally, swap in a textarea for edit mode in the content-area ternary
   (currently ending `) : sourceView}` at line 1202) — add a new branch
   before the final `sourceView` fallback:
   ```tsx
   ) : editing ? (
     <textarea
       value={draftContent}
       onChange={(event) => setDraftContent(event.target.value)}
       spellCheck={false}
       aria-label={`Edit ${getRelativeFilePath(filePath, cwd)}`}
       style={{
         width: "100%",
         height: "100%",
         border: "none",
         outline: "none",
         resize: "none",
         boxSizing: "border-box",
         padding: "8px 12px",
         background: "var(--bg)",
         color: "var(--text)",
         fontFamily: "var(--font-mono)",
         fontSize: 13,
         lineHeight: 1.6,
       }}
     />
   ) : sourceView}
   ```

4. Add to `docs/prd/workspace-explorer.md`'s "已实现范围" section (after the
   binary-file bullet added in Task 1):
   ```
   - 文本文件可编辑并保存；保存前会校验文件自上次读取后是否在磁盘上被修改（对比 mtime），发生变化则拒绝保存并提示重新加载。截断显示或二进制文件不可编辑。
   ```

5. Run: `npx tsc --noEmit -p .`
6. Run: `npx eslint app/api/files/[...path]/route.ts components/FileViewer.tsx`
7. Run: `npm test`
8. Create `e2e/files-git.spec.ts` (new file — this is the one new spec file
   for the whole plan; every later task appends to it rather than creating
   another file). Start it with the imports and the three read-path tests
   for Tasks 1-3, using the real-temp-directory + `request`-fixture pattern
   already established by `e2e/app-shell.spec.ts`'s first test (no mocking,
   hits the real dev server):
   ```ts
   import { expect, test } from "@playwright/test";
   import { execFileSync } from "node:child_process";
   import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
   import { tmpdir } from "node:os";
   import { join } from "node:path";

   function encodedPathFor(...parts: string[]): string {
     return join(...parts).split("/").map(encodeURIComponent).join("/");
   }

   test("a file with a NUL byte is reported as binary instead of returning garbage text", async ({ request }, testInfo) => {
     const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-binary-${testInfo.project.name}-`));
     writeFileSync(join(workspace, "sample.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]));
     await request.post("/api/cwd/validate", { data: { cwd: workspace } });

     const response = await request.get(`/api/files/${encodedPathFor(workspace, "sample.bin")}?type=read`);
     expect(response.status()).toBe(200);
     await expect(response.json()).resolves.toMatchObject({ binary: true });
   });

   test("a file over 256KB offers a truncated preview instead of erroring", async ({ request }, testInfo) => {
     const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-truncate-${testInfo.project.name}-`));
     writeFileSync(join(workspace, "big.txt"), "a".repeat(300 * 1024));
     await request.post("/api/cwd/validate", { data: { cwd: workspace } });
     const path = encodedPathFor(workspace, "big.txt");

     const rejected = await request.get(`/api/files/${path}?type=read`);
     expect(rejected.status()).toBe(413);
     await expect(rejected.json()).resolves.toMatchObject({ canTruncate: true });

     const truncated = await request.get(`/api/files/${path}?type=read&truncate=1`);
     expect(truncated.status()).toBe(200);
     const body = await truncated.json();
     expect(body.truncated).toBe(true);
     expect(body.content.length).toBe(256 * 1024);
   });

   test("saving a file succeeds, then is refused with a conflict after an external change", async ({ request }, testInfo) => {
     const workspace = mkdtempSync(join(tmpdir(), `pi-web-e2e-save-${testInfo.project.name}-`));
     writeFileSync(join(workspace, "notes.txt"), "original\n");
     await request.post("/api/cwd/validate", { data: { cwd: workspace } });
     const path = encodedPathFor(workspace, "notes.txt");

     const initial = await request.get(`/api/files/${path}?type=read`);
     const { mtimeMs } = await initial.json();

     const saved = await request.post(`/api/files/${path}?type=write`, { data: { content: "edited\n", mtimeMs } });
     expect(saved.status()).toBe(200);
     expect(readFileSync(join(workspace, "notes.txt"), "utf-8")).toBe("edited\n");

     // Simulate an external edit landing after the client's last read.
     await new Promise((resolve) => setTimeout(resolve, 20));
     writeFileSync(join(workspace, "notes.txt"), "changed on disk by someone else\n");

     const conflicted = await request.post(`/api/files/${path}?type=write`, { data: { content: "stale edit\n", mtimeMs } });
     expect(conflicted.status()).toBe(409);
     expect(readFileSync(join(workspace, "notes.txt"), "utf-8")).toBe("changed on disk by someone else\n");
   });
   ```
9. Run: `npx playwright test e2e/files-git.spec.ts`

## Task 4: Search file contents, not just file names

`app/api/file-index/route.ts` only ever matches file **names** (`?q=`, fuzzy
filter over the cached listing). There is no content search anywhere.

**Files:**
- `lib/file-content-search.ts` (new)
- `lib/file-content-search.test.mjs` (new)
- `app/api/file-index/route.ts` (new `contentQuery` branch)
- `components/FileExplorer.tsx` (search-mode toggle, content-search state,
  results list)
- `docs/prd/workspace-explorer.md`

**Steps:**

1. Write `lib/file-content-search.ts`:
   ```ts
   import fs from "fs";
   import path from "path";
   import { execFile } from "child_process";
   import { promisify } from "util";
   import { isBinaryFile } from "./file-binary";

   const execFileAsync = promisify(execFile);

   export const CONTENT_SEARCH_MAX_MATCHES = 200;
   const CONTENT_SEARCH_TIMEOUT_MS = 10_000;
   const CONTENT_SEARCH_MAX_BUFFER = 8 * 1024 * 1024;
   const WALK_HARD_CAP_FILES = 5_000;
   const MAX_FILE_BYTES_FOR_WALK_SEARCH = 1024 * 1024;
   const MAX_SNIPPET_CHARS = 300;

   export interface ContentMatch {
     path: string;
     line: number;
     text: string;
   }

   function trimSnippet(text: string): string {
     return text.length > MAX_SNIPPET_CHARS ? `${text.slice(0, MAX_SNIPPET_CHARS)}…` : text;
   }

   /** Parses `git grep -z -n` output: repeating NUL-separated
    * `path, line, text` triples. */
   export function parseGitGrepOutput(output: string, limit = CONTENT_SEARCH_MAX_MATCHES): ContentMatch[] {
     const matches: ContentMatch[] = [];
     const records = output.split("\0");
     for (let i = 0; i + 2 < records.length && matches.length < limit; i += 3) {
       const filePath = records[i];
       const lineNumber = Number.parseInt(records[i + 1], 10);
       const text = records[i + 2];
       if (!filePath || !Number.isFinite(lineNumber)) continue;
       matches.push({ path: filePath, line: lineNumber, text: trimSnippet(text) });
     }
     return matches;
   }

   /** Returns matches, `[]` for "no matches", or `null` when this isn't a Git
    * repo (or git failed) so the caller can fall back to the walk. */
   export async function searchContentWithGit(cwd: string, query: string): Promise<ContentMatch[] | null> {
     try {
       const { stdout } = await execFileAsync(
         "git",
         ["-C", cwd, "grep", "-I", "-z", "-n", "--untracked", "--exclude-standard", "-F", "-i", "-e", query],
         { timeout: CONTENT_SEARCH_TIMEOUT_MS, maxBuffer: CONTENT_SEARCH_MAX_BUFFER, env: { ...process.env, LC_ALL: "C" } },
       );
       return parseGitGrepOutput(stdout);
     } catch (error) {
       // git grep exits 1 with empty stdout when nothing matches — a real
       // "no results", not a failure that should fall back to the walk.
       if (typeof error === "object" && error !== null && "code" in error && (error as { code?: number }).code === 1) {
         return [];
       }
       return null;
     }
   }

   const IGNORED_DIR_NAMES = new Set([
     "node_modules", ".git", ".next", "dist", "build", "__pycache__",
     ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
     "target", "vendor",
   ]);

   /** Bounded fallback for non-Git directories: BFS, skips binary and
    * oversized files, capped on both files scanned and matches returned. */
   export function searchContentWithWalk(cwd: string, query: string, limit = CONTENT_SEARCH_MAX_MATCHES): ContentMatch[] {
     const needle = query.toLowerCase();
     const matches: ContentMatch[] = [];
     let filesScanned = 0;
     const queue: string[] = [""];
     while (queue.length > 0 && matches.length < limit && filesScanned < WALK_HARD_CAP_FILES) {
       const rel = queue.shift()!;
       const abs = rel ? path.join(cwd, rel) : cwd;
       let dirents: fs.Dirent[];
       try {
         dirents = fs.readdirSync(abs, { withFileTypes: true });
       } catch {
         continue;
       }
       for (const dirent of dirents) {
         if (dirent.name.startsWith("._")) continue;
         const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
         if (dirent.isDirectory()) {
           if (!IGNORED_DIR_NAMES.has(dirent.name)) queue.push(childRel);
           continue;
         }
         if (!dirent.isFile() || matches.length >= limit || filesScanned >= WALK_HARD_CAP_FILES) continue;
         filesScanned++;
         const abs2 = path.join(cwd, childRel);
         let stat: fs.Stats;
         try {
           stat = fs.statSync(abs2);
         } catch {
           continue;
         }
         if (stat.size > MAX_FILE_BYTES_FOR_WALK_SEARCH || isBinaryFile(abs2)) continue;
         let content: string;
         try {
           content = fs.readFileSync(abs2, "utf-8");
         } catch {
           continue;
         }
         const lines = content.split("\n");
         for (let lineIndex = 0; lineIndex < lines.length && matches.length < limit; lineIndex++) {
           if (lines[lineIndex].toLowerCase().includes(needle)) {
             matches.push({ path: childRel, line: lineIndex + 1, text: trimSnippet(lines[lineIndex]) });
           }
         }
       }
     }
     return matches;
   }

   export async function searchFileContent(cwd: string, query: string): Promise<ContentMatch[]> {
     const gitResult = await searchContentWithGit(cwd, query);
     return gitResult ?? searchContentWithWalk(cwd, query);
   }
   ```

2. Write `lib/file-content-search.test.mjs`:
   ```js
   import assert from "node:assert/strict";
   import { execFileSync } from "node:child_process";
   import fs from "node:fs";
   import os from "node:os";
   import path from "node:path";
   import test from "node:test";
   import { createJiti } from "jiti";

   const jiti = createJiti(import.meta.url);
   const { parseGitGrepOutput, searchContentWithGit, searchContentWithWalk, searchFileContent } =
     await jiti.import("./file-content-search.ts");

   function git(cwd, args) {
     return execFileSync("git", args, { cwd, encoding: "utf8" });
   }

   test("parses git grep -z output into path/line/text matches", () => {
     const output = ["src/a.ts", "3", "const needle = 1;", "src/b.ts", "10", "// needle here too"].join("\0") + "\0";
     assert.deepEqual(parseGitGrepOutput(output), [
       { path: "src/a.ts", line: 3, text: "const needle = 1;" },
       { path: "src/b.ts", line: 10, text: "// needle here too" },
     ]);
   });

   test("caps parsed matches at the given limit", () => {
     const records = [];
     for (let i = 0; i < 5; i++) records.push(`file${i}.txt`, String(i + 1), `line ${i}`);
     const output = records.join("\0") + "\0";
     assert.equal(parseGitGrepOutput(output, 2).length, 2);
   });

   function makeRepo(t) {
     const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-")));
     t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
     git(repo, ["init", "-q"]);
     git(repo, ["config", "user.email", "test@example.com"]);
     git(repo, ["config", "user.name", "Test"]);
     fs.mkdirSync(path.join(repo, "src"));
     fs.writeFileSync(path.join(repo, "src", "a.ts"), "export const needle = 1;\nconst other = 2;\n");
     fs.writeFileSync(path.join(repo, "README.md"), "no match here\n");
     git(repo, ["add", "."]);
     git(repo, ["commit", "-q", "-m", "init"]);
     fs.writeFileSync(path.join(repo, "untracked.txt"), "needle in an untracked file\n");
     return repo;
   }

   test("git grep finds matches in tracked and untracked files, case-insensitively", async (t) => {
     const repo = makeRepo(t);
     const matches = await searchContentWithGit(repo, "NEEDLE");
     assert.ok(matches);
     assert.deepEqual(matches.map((m) => m.path).sort(), ["src/a.ts", "untracked.txt"]);
   });

   test("git grep returns an empty array (not null) when nothing matches", async (t) => {
     const repo = makeRepo(t);
     assert.deepEqual(await searchContentWithGit(repo, "totally-absent-needle"), []);
   });

   test("searchContentWithGit returns null outside a Git repository so the caller can fall back", async (t) => {
     const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-nogit-"));
     t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
     fs.writeFileSync(path.join(dir, "a.txt"), "needle\n");
     assert.equal(await searchContentWithGit(dir, "needle"), null);
   });

   test("the walk fallback finds matches without git and skips binary files", async (t) => {
     const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-walk-"));
     t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
     fs.writeFileSync(path.join(dir, "a.txt"), "has needle here\n");
     fs.writeFileSync(path.join(dir, "b.bin"), Buffer.from([0x00, 0x01, 0x02, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]));
     const matches = searchContentWithWalk(dir, "needle");
     assert.deepEqual(matches.map((m) => m.path), ["a.txt"]);
   });

   test("searchFileContent prefers git grep in a Git repo and falls back otherwise", async (t) => {
     const repo = makeRepo(t);
     const inRepo = await searchFileContent(repo, "needle");
     assert.ok(inRepo.some((m) => m.path === "untracked.txt"));

     const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-content-search-plain-"));
     t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
     fs.writeFileSync(path.join(plain, "a.txt"), "needle\n");
     assert.deepEqual((await searchFileContent(plain, "needle")).map((m) => m.path), ["a.txt"]);
   });
   ```
   Before wiring the route, run this file standalone
   (`node --test lib/file-content-search.test.mjs`) to confirm the `git grep
   -z` field layout assumed by `parseGitGrepOutput` actually matches your
   Git version's output — if a real repo's assertions in the last three
   tests fail on field grouping, adjust `parseGitGrepOutput` accordingly; the
   synthetic-string tests above lock in the format once confirmed.

3. In `app/api/file-index/route.ts`, add the import:
   ```ts
   import { searchFileContent } from "@/lib/file-content-search";
   ```
   Add a `contentQuery` branch in `GET`, right after the existing
   `isExistingFilePathAllowed` check and before the `getIndexCache()` call
   (name search stays as the default path; `contentQuery` takes priority
   when present since the two are mutually exclusive from the client):
   ```ts
       const contentQuery = req.nextUrl.searchParams.get("contentQuery")?.slice(0, MAX_QUERY_LENGTH) ?? "";
       if (contentQuery) {
         return NextResponse.json({ matches: await searchFileContent(cwd, contentQuery) });
       }

       const cache = getIndexCache();
   ```

4. In `components/FileExplorer.tsx`, add a type near `SearchEntry` (currently
   line 32):
   ```ts
   interface ContentSearchEntry { path: string; line: number; text: string }
   ```
   Add state next to the existing search state (currently lines 485-488):
   ```ts
   const [searchMode, setSearchMode] = useState<"name" | "content">("name");
   const [contentSearch, setContentSearch] = useState<{ loading: boolean; error: string; results: ContentSearchEntry[] }>({ loading: false, error: "", results: [] });
   ```
   Add a parallel effect next to the existing name-search effect (currently
   lines 593-610):
   ```ts
   useEffect(() => {
     if (searchMode !== "content") return;
     const trimmed = query.trim();
     if (!trimmed) { setContentSearch({ loading: false, error: "", results: [] }); return; }
     const controller = new AbortController();
     const timer = window.setTimeout(() => {
       setContentSearch((current) => ({ ...current, loading: true, error: "" }));
       void fetch(`/api/file-index?${new URLSearchParams({ cwd, contentQuery: trimmed })}`, { signal: controller.signal })
         .then(async (response) => {
           const data = await response.json() as { matches?: ContentSearchEntry[]; error?: string };
           if (!response.ok) throw new Error(data.error || `Search failed (HTTP ${response.status})`);
           setContentSearch({ loading: false, error: "", results: data.matches ?? [] });
         })
         .catch((cause) => { if (!controller.signal.aborted) setContentSearch({ loading: false, error: cause instanceof Error ? cause.message : String(cause), results: [] }); });
     }, 250);
     return () => { controller.abort(); window.clearTimeout(timer); };
   }, [cwd, query, searchMode]);
   ```
   Add mode-toggle buttons right after the search `<label>` row (currently
   ending at line 953, before the "Collapse all" button):
   ```tsx
   {query.trim() && (
     <div role="group" aria-label="Search mode" style={{ display: "flex", gap: 2 }}>
       <button type="button" onClick={() => setSearchMode("name")} aria-pressed={searchMode === "name"} style={{ ...toolbarButtonStyle, width: "auto", padding: "2px 8px", ...(searchMode === "name" ? toolbarButtonActiveStyle : {}) }}>Name</button>
       <button type="button" onClick={() => setSearchMode("content")} aria-pressed={searchMode === "content"} style={{ ...toolbarButtonStyle, width: "auto", padding: "2px 8px", ...(searchMode === "content" ? toolbarButtonActiveStyle : {}) }}>Content</button>
     </div>
   )}
   ```
   Guard the existing name-search results block (currently
   `{query.trim() && <div id="explorer-search-results" ...>}`, line 967) with
   `searchMode === "name"`:
   ```tsx
   {query.trim() && searchMode === "name" && <div id="explorer-search-results" role="listbox" aria-label="File search results" style={{ maxHeight: 220, overflowY: "auto", padding: 4, borderBottom: "1px solid var(--border)" }}>
   ```
   (closing `</div>}` unchanged). Add a sibling block for content results
   right after it:
   ```tsx
   {query.trim() && searchMode === "content" && (
     <div role="listbox" aria-label="File content search results" style={{ maxHeight: 260, overflowY: "auto", padding: 4, borderBottom: "1px solid var(--border)" }}>
       {contentSearch.loading && <div style={emptyStyle}>Searching…</div>}
       {!contentSearch.loading && contentSearch.error && <div style={{ ...emptyStyle, color: "#f87171" }}>{contentSearch.error}</div>}
       {!contentSearch.loading && !contentSearch.error && contentSearch.results.length === 0 && <div style={emptyStyle}>No matching content</div>}
       {contentSearch.results.map((match, index) => (
         <button
           key={`${match.path}:${match.line}:${index}`}
           type="button"
           role="option"
           onClick={() => { setQuery(""); onOpenFile(joinFilePath(cwd, match.path), match.path.split("/").pop() || match.path); }}
           title={`${match.path}:${match.line}`}
           style={{ ...searchResultStyle, flexDirection: "column", alignItems: "flex-start", gap: 2 }}
         >
           <span style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", minWidth: 0 }}>
             {getFileIcon(match.path, 14)}
             <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{match.path}</span>
             <span style={{ flexShrink: 0, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10 }}>:{match.line}</span>
           </span>
           <span style={{ minWidth: 0, width: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5 }}>{match.text}</span>
         </button>
       ))}
     </div>
   )}
   ```
   Scope decisions (right-sizing, not omissions): clicking a content-search
   result opens the file but does not jump to the matched line —
   `onOpenFile(filePath, fileName)` has no line parameter, and adding one
   would touch every call site. Keyboard arrow-key navigation
   (`handleSearchKeyDown`) is left wired to name-search results only; content
   results are click/Enter-in-input-only for this change.

5. Add to `docs/prd/workspace-explorer.md`'s "已实现范围" section:
   ```
   - 搜索支持按文件名或按文件内容切换：内容搜索在 Git 仓库内使用 `git grep`，非 Git 目录使用有限制、有超时的文件遍历回退；结果数量和扫描范围都有上限，点击结果会打开文件（不跳转到具体行）。
   ```

6. Run: `npx tsc --noEmit -p .`
7. Run: `npx eslint lib/file-content-search.ts app/api/file-index/route.ts components/FileExplorer.tsx`
8. Run: `npm test`
9. Append to `e2e/files-git.spec.ts`:
   ```ts
   test("content search finds matches via the file-index API in a real Git repo", async ({ request }, testInfo) => {
     const repo = mkdtempSync(join(tmpdir(), `pi-web-e2e-content-search-${testInfo.project.name}-`));
     mkdirSync(join(repo, "src"), { recursive: true });
     execFileSync("git", ["init", "-q", repo]);
     writeFileSync(join(repo, "src", "widget.ts"), "export function renderWidget() {\n  return findTheNeedleHere();\n}\n");
     execFileSync("git", ["-C", repo, "add", "."]);
     execFileSync("git", ["-C", repo, "-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init"]);
     await request.post("/api/cwd/validate", { data: { cwd: repo } });

     const search = await request.get(`/api/file-index?${new URLSearchParams({ cwd: repo, contentQuery: "findTheNeedleHere" })}`);
     expect(search.status()).toBe(200);
     await expect(search.json()).resolves.toMatchObject({
       matches: [expect.objectContaining({ path: "src/widget.ts", line: 2 })],
     });
   });
   ```
10. Run: `npx playwright test e2e/files-git.spec.ts`

## Task 5: Add an Amend option to Commit

The backend already supports it: `lib/git-changes.ts`'s `commitChanges(cwd,
message, { amend })` (lines 666-679) already runs `git commit --amend -m
<message>` when `options.amend` is true, and `app/api/git/commit/route.ts`'s
`POST` (lines 54-66) already reads `body.amend` and passes it through. Only
the UI is missing.

**Files:**
- `components/GitReviewPanel.tsx`

**Steps:**

1. Add state next to `commitMessage` (currently line 176):
   ```ts
   const [amend, setAmend] = useState(false);
   ```
2. Replace the `commit` callback (currently lines 314-321):
   ```ts
   const commit = useCallback(async () => {
     const message = commitMessage.trim();
     if (!message) return;
     if (await runWrite("/api/git/commit", { message, amend })) {
       setCommitMessage("");
       setAmend(false);
       setGenerationNotice(null);
     }
   }, [amend, commitMessage, runWrite]);
   ```
3. In the commit box render, add a checkbox row right after the
   `generationNotice` line (currently line 559) and before the existing
   staged-count / buttons row:
   ```tsx
   <label style={{ display: "flex", alignItems: "center", gap: 5, color: "var(--text-dim)", fontSize: 11 }}>
     <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} aria-label="Amend previous commit" />
     Amend previous commit
   </label>
   ```
4. In the same render, replace only the Commit button (currently lines
   573-581, inside the unchanged staged-count row):
   ```tsx
   <button
     type="button"
     onClick={() => void commit()}
     title={amend ? "Amend the previous commit with this message" : "Create a commit from all staged changes"}
     disabled={busy || generatingCommitMessage || !commitMessage.trim() || (!amend && (grouped.get("staged")?.length ?? 0) === 0)}
     style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "5px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg-panel)", color: "var(--accent)", opacity: busy || generatingCommitMessage || !commitMessage.trim() || (!amend && (grouped.get("staged")?.length ?? 0) === 0) ? 0.5 : 1 }}
   >
     {amend ? "Amend" : "Commit"}
   </button>
   ```
   Deliberately out of scope: the commit message is not prefilled from the
   current HEAD subject when Amend is checked (would need an extra fetch);
   the user types the new message themselves.

5. Add to `docs/prd/git-review.md`'s "已实现范围" section, after "提交和基础远端同步操作。":
   ```
   - 提交支持 Amend（勾选 "Amend previous commit"），用新的提交信息覆盖上一次提交；不预填历史提交信息，也不要求有暂存的改动。
   ```

6. Run: `npx tsc --noEmit -p .`
7. Run: `npx eslint components/GitReviewPanel.tsx`
8. Run: `npm test`
9. Append to `e2e/files-git.spec.ts` (mocked UI test — this task has no new
   backend logic, so the test verifies the UI wiring end to end against a
   fake repository):
   ```ts
   test("Amend recommits with a new message and no staged changes required", async ({ page }, testInfo) => {
     test.skip(testInfo.project.name.startsWith("mobile"), "desktop Git Review test");
     const repo = "/tmp/pi-web-e2e/service-a";
     const commitRequests: Array<Record<string, unknown>> = [];
     await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
       id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
       created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
     }], runningSessionIds: [] } }));
     await page.route("**/api/files/**", async (route) => route.fulfill({ json: { entries: [] } }));
     await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
     await page.route("**/api/git/repositories?*", async (route) => route.fulfill({ json: { repositories: [
       { path: repo, repositoryRoot: repo, label: "service-a", relativePath: "service-a" },
     ] } }));
     await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: true, repositoryRoot: repo, branch: "main", remotes: [], files: [] } }));
     await page.route("**/api/git/commit", async (route) => {
       commitRequests.push(route.request().postDataJSON());
       return route.fulfill({ json: { isGitRepository: true, repositoryRoot: repo, branch: "main", remotes: [], files: [] } });
     });

     await page.goto("/");
     await page.getByRole("button", { name: "Show file panel" }).click();
     await page.getByRole("button", { name: "Open Git Review" }).click();
     await page.getByRole("checkbox", { name: "Amend previous commit" }).check();
     await page.getByPlaceholder("Commit message (⌘/Ctrl+Enter)").fill("fix: correct typo from the previous commit");
     await expect(page.getByRole("button", { name: "Amend" })).toBeEnabled();
     await page.getByRole("button", { name: "Amend" }).click();
     await expect.poll(() => commitRequests).toEqual([{ cwd: repo, message: "fix: correct typo from the previous commit", amend: true }]);
   });
   ```
10. Run: `npx playwright test e2e/files-git.spec.ts -g "Amend"`

## Task 6: Add "Revert commit" to History

No revert or reset exists today. This task adds `git revert --no-edit
<hash>`, with a `git revert --abort` cleanup on failure so a conflicting
revert never leaves the repo half-reverted. Reset is not implemented — see
"Facts the implementer needs."

**Files:**
- `lib/git-changes.ts` (new `revertCommit`)
- `lib/git-revert.test.mjs` (new)
- `app/api/git/revert/route.ts` (new)
- `components/GitReviewPanel.tsx` (thread `onChanged` through `HistoryView` →
  `CommitDetailView`, add the Revert button)
- `docs/prd/git-review.md`

**Steps:**

1. In `lib/git-changes.ts`, add right after `commitChanges` (currently ends
   at line 679; `conflict` and `badRequest` are already imported at the top
   of this file):
   ```ts
   export async function revertCommit(cwd: string, hash: string): Promise<GitStatusResponse> {
     const repositoryRoot = await requireRepositoryRoot(cwd);
     if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) throw badRequest("Invalid commit hash");
     try {
       await git(repositoryRoot, ["revert", "--no-edit", hash]);
     } catch (error) {
       try {
         await git(repositoryRoot, ["revert", "--abort"]);
       } catch {
         // Nothing to abort, or the abort itself failed — the outer error below still surfaces.
       }
       const message = error instanceof Error ? error.message : String(error);
       throw conflict(`Could not revert this commit cleanly: ${message.split("\n")[0]}. Resolve conflicts manually with git, or choose a different commit.`);
     }
     return getGitStatus(cwd);
   }
   ```

2. Write `lib/git-revert.test.mjs`:
   ```js
   import assert from "node:assert/strict";
   import { execFileSync } from "node:child_process";
   import fs from "node:fs";
   import os from "node:os";
   import path from "node:path";
   import test from "node:test";
   import { createJiti } from "jiti";

   const jiti = createJiti(import.meta.url);
   const { revertCommit } = await jiti.import("./git-changes.ts");

   function git(cwd, args) {
     return execFileSync("git", args, { cwd, encoding: "utf8" });
   }

   function makeRepo(t) {
     const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-revert-")));
     t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
     git(repo, ["init", "-q", "-b", "main"]);
     git(repo, ["config", "user.email", "test@example.com"]);
     git(repo, ["config", "user.name", "Test"]);
     return repo;
   }

   test("reverts a clean commit and creates a new commit undoing it", async (t) => {
     const repo = makeRepo(t);
     fs.writeFileSync(path.join(repo, "a.txt"), "v1\n");
     git(repo, ["add", "."]);
     git(repo, ["commit", "-q", "-m", "add a.txt"]);
     fs.writeFileSync(path.join(repo, "a.txt"), "v2\n");
     git(repo, ["commit", "-q", "-am", "update a.txt"]);
     const target = git(repo, ["rev-parse", "HEAD"]).trim();

     const status = await revertCommit(repo, target);

     assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "v1\n");
     assert.equal(status.files.length, 0);
     assert.match(git(repo, ["log", "--format=%s", "-3"]), /^Revert "update a\.txt"/m);
   });

   test("rejects an invalid commit hash without running git", async (t) => {
     const repo = makeRepo(t);
     await assert.rejects(revertCommit(repo, "not-a-hash"), { status: 400 });
   });

   test("a conflicting revert is aborted cleanly and returns 409", async (t) => {
     const repo = makeRepo(t);
     fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
     git(repo, ["add", "."]);
     git(repo, ["commit", "-q", "-m", "base"]);
     fs.writeFileSync(path.join(repo, "a.txt"), "changed by commit 2\n");
     git(repo, ["commit", "-q", "-am", "change 2"]);
     const change2 = git(repo, ["rev-parse", "HEAD"]).trim();
     fs.writeFileSync(path.join(repo, "a.txt"), "changed again by commit 3, touching the same line\n");
     git(repo, ["commit", "-q", "-am", "change 3"]);

     await assert.rejects(revertCommit(repo, change2), (error) => {
       assert.equal(error.status, 409);
       assert.match(error.message, /revert/i);
       return true;
     });

     assert.equal(git(repo, ["status", "--porcelain=v1"]).trim(), "");
     assert.equal(fs.existsSync(path.join(repo, ".git", "REVERT_HEAD")), false);
   });
   ```

3. Write `app/api/git/revert/route.ts` (mirrors
   `app/api/git/discard/route.ts` exactly):
   ```ts
   import { NextRequest, NextResponse } from "next/server";
   import { validateGitCwd } from "@/lib/git-request";
   import { revertCommit } from "@/lib/git-changes";
   import { errorResponse } from "@/lib/http-error";

   export async function POST(request: NextRequest) {
     try {
       const body = await request.json().catch(() => ({})) as { cwd?: string; hash?: string };
       const invalid = await validateGitCwd(body.cwd);
       if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
       if (!body.hash || typeof body.hash !== "string") {
         return NextResponse.json({ error: "hash is required" }, { status: 400 });
       }
       return NextResponse.json(await revertCommit(body.cwd as string, body.hash));
     } catch (error) {
       return errorResponse(error);
     }
   }
   ```

4. In `components/GitReviewPanel.tsx`, thread a new `onChanged` prop from the
   tab dispatch (currently lines 460-461) through to `CommitDetailView`:
   ```tsx
   ) : tab === "history" ? (
     <HistoryView cwd={repositoryCwd!} refreshToken={refreshKey + nonce} onChanged={refresh} />
   ```
   Update `HistoryView`'s signature (currently line 908):
   ```ts
   function HistoryView({ cwd, refreshToken, onChanged }: { cwd: string; refreshToken: number; onChanged: () => void }) {
   ```
   Update where it renders `CommitDetailView` (currently line 1038):
   ```tsx
   ? <CommitDetailView cwd={cwd} hash={selectedHash} onChanged={onChanged} />
   ```
   Update `CommitDetailView`'s signature and add the revert flow (currently
   lines 1045-1096):
   ```tsx
   function CommitDetailView({ cwd, hash, onChanged }: { cwd: string; hash: string; onChanged: () => void }) {
     const split = useSplit("pi-git-commit-files-h", 160, 60, 460, "y");
     const [detail, setDetail] = useState<GitCommitDetail | null>(null);
     const [loading, setLoading] = useState(false);
     const [error, setError] = useState<string | null>(null);
     const [selectedFile, setSelectedFile] = useState<string | null>(null);
     const [reverting, setReverting] = useState(false);
     const [revertError, setRevertError] = useState<string | null>(null);

     useEffect(() => {
       setRevertError(null);
       const controller = new AbortController();
       setLoading(true);
       setError(null);
       setDetail(null);
       setSelectedFile(null);
       void fetch(`/api/git/commit?${new URLSearchParams({ cwd, hash })}`, { signal: controller.signal })
         .then(async (res) => {
           const next = await res.json() as GitCommitDetail & { error?: string };
           if (!res.ok) throw new Error(next.error ?? `Failed to load commit (${res.status})`);
           setDetail(next);
           setSelectedFile(next.files[0]?.path ?? null);
         })
         .catch((cause: unknown) => {
           if (cause instanceof DOMException && cause.name === "AbortError") return;
           setError(cause instanceof Error ? cause.message : String(cause));
         })
         .finally(() => { if (!controller.signal.aborted) setLoading(false); });
       return () => controller.abort();
     }, [cwd, hash]);

     const revert = useCallback(async () => {
       if (!window.confirm(`Revert "${detail?.subject ?? hash}"? This creates a new commit that undoes it.`)) return;
       setReverting(true);
       setRevertError(null);
       try {
         const response = await fetch("/api/git/revert", {
           method: "POST",
           headers: { "Content-Type": "application/json" },
           body: JSON.stringify({ cwd, hash }),
         });
         const next = await response.json() as { error?: string };
         if (!response.ok) throw new Error(next.error ?? `Could not revert this commit (${response.status})`);
         onChanged();
       } catch (cause) {
         setRevertError(cause instanceof Error ? cause.message : String(cause));
       } finally {
         setReverting(false);
       }
     }, [cwd, detail?.subject, hash, onChanged]);

     if (error) return <EmptyState title="Unable to load commit" detail={error} />;
     if (!detail || loading) return <EmptyState title="Loading commit…" />;

     return (
       <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
         <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
           <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
             <div style={{ fontWeight: 650, fontSize: 13 }}>{detail.subject}</div>
             <button
               type="button"
               onClick={() => void revert()}
               disabled={reverting}
               title="Create a new commit that undoes this one"
               style={{ flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, padding: "4px 10px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", background: "var(--bg-panel)", color: "var(--text-muted)", opacity: reverting ? 0.5 : 1 }}
             >
               {reverting ? "Reverting…" : "Revert commit"}
             </button>
           </div>
           {revertError && <div role="alert" style={{ marginTop: 6, color: "#f87171", fontSize: 11, overflowWrap: "anywhere" }}>{revertError}</div>}
           <div style={{ marginTop: 4, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
             {detail.shortHash} · {detail.author} · {formatDate(detail.date)}
           </div>
           {detail.refs.length > 0 && (
             <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
               {detail.refs.map((ref) => <Badge key={ref} label={ref} />)}
             </div>
           )}
           {detail.body && (
             <pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{detail.body}</pre>
           )}
           <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--text-muted)" }}>
             Files {detail.files.length}
             <span style={{ marginLeft: 8, color: STATUS_COLORS.added }}>+{detail.additions}</span>
             <span style={{ marginLeft: 6, color: STATUS_COLORS.deleted }}>-{detail.deletions}</span>
           </div>
         </div>
         <div style={{ height: split.size, overflow: "auto", borderBottom: "1px solid var(--border)", padding: "6px 4px", flexShrink: 0 }}>
           {detail.files.map((file) => (
             <CommitFileRow key={file.path} file={file} selected={file.path === selectedFile} onSelect={() => setSelectedFile(file.path)} />
           ))}
         </div>
         <div className="resize-handle resize-handle--h" onMouseDown={split.onDragStart} role="separator" aria-orientation="horizontal" title="Drag to resize" />
         <div style={{ minHeight: 0, flex: 1, overflow: "auto" }}>
           {selectedFile ? <CommitFileDiff cwd={cwd} hash={hash} path={selectedFile} /> : <EmptyState title="No file changes" />}
         </div>
       </div>
     );
   }
   ```

5. Add to `docs/prd/git-review.md`'s "已实现范围" section:
   ```
   - History 中的提交详情可执行 "Revert commit"（`git revert --no-edit`），会创建一条新的反向提交；如果无法自动反转（存在冲突）会中止 revert 并返回明确错误，不留下未完成的 revert 状态。暂不提供分支级 reset 操作。
   ```

6. Run: `npx tsc --noEmit -p .`
7. Run: `npx eslint lib/git-changes.ts app/api/git/revert/route.ts components/GitReviewPanel.tsx`
8. Run: `npm test`
9. Append to `e2e/files-git.spec.ts`:
   ```ts
   test("reverting a commit from History creates a clean revert commit", async ({ request }, testInfo) => {
     const repo = mkdtempSync(join(tmpdir(), `pi-web-e2e-revert-${testInfo.project.name}-`));
     execFileSync("git", ["init", "-q", "-b", "main", repo]);
     execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
     execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
     writeFileSync(join(repo, "a.txt"), "v1\n");
     execFileSync("git", ["-C", repo, "add", "."]);
     execFileSync("git", ["-C", repo, "commit", "-q", "-m", "add a.txt"]);
     writeFileSync(join(repo, "a.txt"), "v2\n");
     execFileSync("git", ["-C", repo, "commit", "-q", "-am", "update a.txt"]);
     const hash = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

     await request.post("/api/cwd/validate", { data: { cwd: repo } });
     const response = await request.post("/api/git/revert", { data: { cwd: repo, hash } });
     expect(response.status()).toBe(200);
     expect(readFileSync(join(repo, "a.txt"), "utf-8")).toBe("v1\n");
   });
   ```
10. Run: `npx playwright test e2e/files-git.spec.ts -g "revert"`

## Task 7: Persist the commit message draft per repository

`commitMessage` (`components/GitReviewPanel.tsx`, currently line 176) is
plain `useState("")` with no persistence — switching tabs, repositories, or
reloading loses the draft. `selectedRepositoryStorageKey` (line 41) is the
existing template for a per-workspace localStorage key; this task adds the
repository-scoped equivalent for the commit draft.

**Files:**
- `components/GitReviewPanel.tsx`

**Steps:**

1. Add a helper next to `selectedRepositoryStorageKey` (currently lines
   41-43):
   ```ts
   function commitDraftStorageKey(repositoryCwd: string): string {
     return `pi-web:git-commit-draft:${encodeURIComponent(repositoryCwd)}`;
   }
   ```
2. Add two effects next to the existing repository-selection persistence
   effect (currently lines 212-215):
   ```ts
   useEffect(() => {
     if (!repositoryCwd) { setCommitMessage(""); return; }
     let draft = "";
     try { draft = localStorage.getItem(commitDraftStorageKey(repositoryCwd)) ?? ""; } catch { /* storage can be unavailable */ }
     setCommitMessage(draft);
   }, [repositoryCwd]);

   useEffect(() => {
     if (!repositoryCwd) return;
     try {
       if (commitMessage) localStorage.setItem(commitDraftStorageKey(repositoryCwd), commitMessage);
       else localStorage.removeItem(commitDraftStorageKey(repositoryCwd));
     } catch { /* storage can be unavailable */ }
   }, [commitMessage, repositoryCwd]);
   ```
   No change needed to `commit()`: it already calls `setCommitMessage("")` on
   success (Task 5 also resets `amend`), and the persist effect above removes
   the stored draft whenever `commitMessage` becomes empty — including right
   after a successful commit.

3. Add to `docs/prd/git-review.md`'s "已实现范围" section:
   ```
   - 提交信息草稿按 Git 仓库保存在浏览器 localStorage 中，切换标签、切换仓库或刷新页面后仍保留；成功提交或 Amend 后自动清空。
   ```

4. Run: `npx tsc --noEmit -p .`
5. Run: `npx eslint components/GitReviewPanel.tsx`
6. Run: `npm test`
7. Append to `e2e/files-git.spec.ts` (needs a real page/localStorage, so this
   one uses the mocked-page pattern rather than the request fixture):
   ```ts
   test("the commit message draft is saved per repository in localStorage and restored", async ({ page }, testInfo) => {
     test.skip(testInfo.project.name.startsWith("mobile"), "desktop Git Review test");
     const repo = "/tmp/pi-web-e2e/service-a";
     const draftKey = `pi-web:git-commit-draft:${encodeURIComponent(repo)}`;
     await page.route("**/api/sessions", async (route) => route.fulfill({ json: { sessions: [{
       id: "pi-session", path: "/tmp/pi-web-e2e/session.jsonl", cwd: "/tmp/pi-web-e2e", projectRoot: "/tmp/pi-web-e2e",
       created: "2026-08-03T00:00:00.000Z", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "test",
     }], runningSessionIds: [] } }));
     await page.route("**/api/files/**", async (route) => route.fulfill({ json: { entries: [] } }));
     await page.route("**/api/cwd/validate", async (route) => route.fulfill({ json: { success: true, cwd: "/tmp/pi-web-e2e" } }));
     await page.route("**/api/git/repositories?*", async (route) => route.fulfill({ json: { repositories: [
       { path: repo, repositoryRoot: repo, label: "service-a", relativePath: "service-a" },
     ] } }));
     await page.route("**/api/git/status?*", async (route) => route.fulfill({ json: { isGitRepository: true, repositoryRoot: repo, branch: "main", remotes: [], files: [] } }));

     await page.goto("/");
     await page.getByRole("button", { name: "Show file panel" }).click();
     await page.getByRole("button", { name: "Open Git Review" }).click();
     const commitBox = page.getByPlaceholder("Commit message (⌘/Ctrl+Enter)");
     await commitBox.fill("wip: draft message survives a reload");
     await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), draftKey)).toBe("wip: draft message survives a reload");

     await page.reload();
     await page.getByRole("button", { name: "Show file panel" }).click();
     await page.getByRole("button", { name: "Open Git Review" }).click();
     await expect(page.getByPlaceholder("Commit message (⌘/Ctrl+Enter)")).toHaveValue("wip: draft message survives a reload");
   });
   ```
8. Run: `npx playwright test e2e/files-git.spec.ts -g "draft"`

## Task 8: Only block Pull when Git would actually be overwritten

`syncGitRemote`'s pull branch (`lib/git-changes.ts`, currently lines
154-159) blocks pull on **any** uncommitted change (`readStatusEntries(...).
length > 0`), not just untracked files that would be overwritten. The fix
removes that manual check and lets `git pull --ff-only` run and report its
own — correctly narrow — failure. The client also has its own,
independent block on the Pull button that must be relaxed in the same task,
or the backend fix is unreachable from the UI.

**Files:**
- `lib/git-changes.ts`
- `lib/git-sync.test.mjs` (new)
- `components/GitReviewPanel.tsx` (Pull button `disabled`/`title`)
- `docs/prd/git-review.md`

**Steps:**

1. In `lib/git-changes.ts`, replace the pull branch inside `syncGitRemote`
   (currently lines 154-159):
   ```ts
       if (action === "pull") {
         const changes = await readStatusEntries(repositoryRoot);
         if (changes.length > 0) {
           throw new Error("Pull is blocked because the worktree has uncommitted changes. Commit, stash, or discard them first.");
         }
         await git(repositoryRoot, ["pull", "--ff-only"]);
       } else {
   ```
   with:
   ```ts
       if (action === "pull") {
         try {
           await git(repositoryRoot, ["pull", "--ff-only"]);
         } catch (error) {
           throw conflict(error instanceof Error ? error.message : String(error));
         }
       } else {
   ```

2. Write `lib/git-sync.test.mjs`:
   ```js
   import assert from "node:assert/strict";
   import { execFileSync } from "node:child_process";
   import fs from "node:fs";
   import os from "node:os";
   import path from "node:path";
   import test from "node:test";
   import { createJiti } from "jiti";

   const jiti = createJiti(import.meta.url);
   const { syncGitRemote } = await jiti.import("./git-changes.ts");

   function git(cwd, args) {
     return execFileSync("git", args, { cwd, encoding: "utf8" });
   }

   function makeOriginAndClone(t) {
     const origin = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-sync-origin-")));
     git(origin, ["init", "-q", "-b", "main"]);
     git(origin, ["config", "user.email", "test@example.com"]);
     git(origin, ["config", "user.name", "Test"]);
     fs.writeFileSync(path.join(origin, "tracked.txt"), "v1\n");
     git(origin, ["add", "."]);
     git(origin, ["commit", "-q", "-m", "init"]);

     const clone = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-sync-clone-")));
     execFileSync("git", ["clone", "-q", origin, clone], { encoding: "utf8" });
     git(clone, ["config", "user.email", "test@example.com"]);
     git(clone, ["config", "user.name", "Test"]);

     t.after(() => {
       fs.rmSync(origin, { recursive: true, force: true });
       fs.rmSync(clone, { recursive: true, force: true });
     });
     return { origin, clone };
   }

   function commitToOrigin(origin, fileName, content) {
     fs.writeFileSync(path.join(origin, fileName), content);
     git(origin, ["add", fileName]);
     git(origin, ["commit", "-q", "-m", `update ${fileName}`]);
   }

   test("pull fast-forwards when the clone has no local changes", async (t) => {
     const { origin, clone } = makeOriginAndClone(t);
     commitToOrigin(origin, "tracked.txt", "v2\n");
     await syncGitRemote(clone, "pull");
     assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8"), "v2\n");
   });

   test("pull no longer blocks on unrelated uncommitted changes to tracked files", async (t) => {
     const { origin, clone } = makeOriginAndClone(t);
     commitToOrigin(origin, "other.txt", "new file\n");
     // The old code blocked ANY uncommitted change; this edits a file pull never touches.
     fs.writeFileSync(path.join(clone, "tracked.txt"), "locally edited, unrelated to the incoming change\n");
     await syncGitRemote(clone, "pull");
     assert.equal(fs.readFileSync(path.join(clone, "other.txt"), "utf8"), "new file\n");
     assert.equal(fs.readFileSync(path.join(clone, "tracked.txt"), "utf8"), "locally edited, unrelated to the incoming change\n");
   });

   test("pull is refused with a 409 when an untracked file would be overwritten", async (t) => {
     const { origin, clone } = makeOriginAndClone(t);
     commitToOrigin(origin, "incoming.txt", "from origin\n");
     fs.writeFileSync(path.join(clone, "incoming.txt"), "local untracked copy\n");
     await assert.rejects(syncGitRemote(clone, "pull"), (error) => {
       assert.equal(error.status, 409);
       assert.match(error.message, /incoming\.txt/);
       return true;
     });
     assert.equal(fs.readFileSync(path.join(clone, "incoming.txt"), "utf8"), "local untracked copy\n");
   });
   ```

3. In `components/GitReviewPanel.tsx`, replace the Pull button (currently
   lines 376-380):
   ```tsx
   <button
     type="button"
     onClick={() => void syncRemote("pull")}
     disabled={busy || !showAheadBehind}
     title={!showAheadBehind ? "Current branch has no upstream" : "Pull using fast-forward only"}
     style={{ ...syncButtonStyle, opacity: busy || !showAheadBehind ? 0.5 : 1 }}
   >↓ Pull</button>
   ```

4. Update `docs/prd/git-review.md`'s "已实现范围" section:
   ```
   - Pull 只在 Git 判断本地改动会被覆盖时才会阻止（例如未跟踪文件会被合并覆盖），并展示 Git 自身给出的错误信息；无关的未提交改动不会再阻止 Pull。
   ```

5. Run: `npx tsc --noEmit -p .`
6. Run: `npx eslint lib/git-changes.ts components/GitReviewPanel.tsx`
7. Run: `npm test`
8. Append to `e2e/files-git.spec.ts`:
   ```ts
   test("pull only blocks when Git itself would overwrite a file, not on unrelated local edits", async ({ request }, testInfo) => {
     const origin = mkdtempSync(join(tmpdir(), `pi-web-e2e-pull-origin-${testInfo.project.name}-`));
     execFileSync("git", ["init", "-q", "-b", "main", origin]);
     execFileSync("git", ["-C", origin, "config", "user.email", "test@example.com"]);
     execFileSync("git", ["-C", origin, "config", "user.name", "Test"]);
     writeFileSync(join(origin, "tracked.txt"), "v1\n");
     execFileSync("git", ["-C", origin, "add", "."]);
     execFileSync("git", ["-C", origin, "commit", "-q", "-m", "init"]);

     const clone = mkdtempSync(join(tmpdir(), `pi-web-e2e-pull-clone-${testInfo.project.name}-`));
     execFileSync("git", ["clone", "-q", origin, clone]);
     execFileSync("git", ["-C", clone, "config", "user.email", "test@example.com"]);
     execFileSync("git", ["-C", clone, "config", "user.name", "Test"]);

     writeFileSync(join(origin, "other.txt"), "from origin\n");
     execFileSync("git", ["-C", origin, "add", "other.txt"]);
     execFileSync("git", ["-C", origin, "commit", "-q", "-m", "add other.txt"]);
     // A local edit to a file pull never touches — the old code blocked pull here regardless.
     writeFileSync(join(clone, "tracked.txt"), "locally edited, unrelated\n");

     await request.post("/api/cwd/validate", { data: { cwd: clone } });
     const response = await request.post("/api/git/sync", { data: { cwd: clone, action: "pull" } });
     expect(response.status()).toBe(200);
     expect(readFileSync(join(clone, "other.txt"), "utf-8")).toBe("from origin\n");
     expect(readFileSync(join(clone, "tracked.txt"), "utf-8")).toBe("locally edited, unrelated\n");
   });
   ```
9. Run: `npx playwright test e2e/files-git.spec.ts`

## Self-Review

**Spec coverage (all 9 audit items accounted for):**

| # | Item | Disposition |
|---|------|-------------|
| 1 | Edit + save with conflict check | Task 3 |
| 2 | Binary placeholder | Task 1 |
| 3 | Truncated read over 256 KB | Task 2 |
| 4 | Content search | Task 4 |
| 5 | Amend UI | Task 5 (backend already existed) |
| 6 | Revert / reset | Task 6 (revert only; reset dropped, reasoned in "Facts the implementer needs") |
| 7 | Commit draft persistence | Task 7 |
| 8 | Pull over-blocking | Task 8 (reshaped: fixes the real "blocks on any dirty state" bug, not just "untracked files") |
| 9 | History pagination | Dropped — already fully implemented, both layers, cited with line numbers in "Facts the implementer needs" |

**Placeholder scan:** every code block above is complete, compilable TS/JS —
no `// ...`, no `TODO`, no elided bodies. Test files are runnable as written
modulo the one flagged risk below.

**Type/signature consistency across tasks:**
- `FileData` gains fields incrementally and consistently: `mtimeMs` (Task 1),
  `binary?` (Task 1), `truncated?` (Task 2) — no task redefines a field
  another task already added.
- `getFileApiUrl`'s `type` union is extended exactly once (Task 3, adding
  `"write"`); Tasks 1-2 don't touch it since they only use the existing
  `"read"` value.
- `HistoryView`/`CommitDetailView`'s new `onChanged` prop (Task 6) doesn't
  collide with `BranchView`'s existing `onChanged` — same name, same
  `() => void` shape, same call site (`refresh`), by design.
- `revertCommit` reuses `conflict`/`badRequest` already imported at the top
  of `lib/git-changes.ts` — no new import needed there.
- Task 4's `lib/file-content-search.ts` imports `isBinaryFile` from Task 1's
  `lib/file-binary.ts` — Task 4 must run after Task 1 (already ordered that
  way above).

**Known risk, flagged rather than hidden:** `parseGitGrepOutput`'s NUL-triple
grouping (Task 4) assumes a specific `git grep -z -n` field layout. The unit
test suite includes both synthetic-string tests (deterministic, always pass)
and real-repo tests (`searchContentWithGit` against an actual `git` binary).
If the real-repo assertions fail when you first run them, that means this
Git version's `-z` layout differs from what's assumed — fix the parser, not
the test's synthetic strings, and re-run.

**Cross-task file overlap:** `components/GitReviewPanel.tsx` is touched by
Tasks 5, 6, 7, and 8. Each task's diff is scoped to different lines
(commit-box buttons/state; History/CommitDetailView; two new effects near the
repository-selection effect; the Pull button) and is written as a full
replacement of the named block, so doing them in order (5 → 6 → 7 → 8, the
order they appear above) applies cleanly with no re-derivation needed.
`docs/prd/git-review.md`'s "已实现范围" section is also touched by Tasks 5,
6, 7, 8 — each adds one bullet; append, don't reorder existing bullets.
`app/api/files/[...path]/route.ts` is touched by Tasks 1, 2, 3 in that
order, each replacing the tail of the previous task's edit to the same
`type === "read"` block (or, for Task 3, adding a new branch elsewhere in the
same file) — also safe to do strictly in order.

**E2E file ownership:** `e2e/files-git.spec.ts` is created in Task 3 and
appended to by Tasks 4-8. If tasks are executed out of order, create the file
in whichever task runs first and append in the rest.

## Finish

After all 8 tasks are done, run the full gate once more from the repo root:

```
npx tsc --noEmit -p . && npx eslint . && npm test && npx playwright test e2e/files-git.spec.ts
```
