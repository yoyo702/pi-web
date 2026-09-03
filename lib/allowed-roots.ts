// In-memory roots that should be browsable in addition to roots derived from
// persisted sessions. Stored on globalThis so Next.js hot-reload keeps them.
import fs from "fs";
import os from "os";
import path from "path";

declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piAdditionalAllowedRoots: Set<string> | undefined;
}

const allowedRootsFile = process.env.PI_WEB_ALLOWED_ROOTS_FILE
  || path.join(os.homedir(), ".pi-web", "allowed-roots.json");
const allowedRootsLockFile = `${allowedRootsFile}.lock`;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function readPersistedAllowedRoots(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(allowedRootsFile, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === "string" && path.isAbsolute(root)) : [];
  } catch {
    return [];
  }
}

function acquireAllowedRootsLock(): () => void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const descriptor = fs.openSync(allowedRootsLockFile, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      return () => {
        try { fs.closeSync(descriptor); } catch { /* already closed */ }
        try { fs.unlinkSync(allowedRootsLockFile); } catch { /* already removed */ }
      };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(allowedRootsLockFile).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(allowedRootsLockFile);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out updating allowed roots");
      Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_MS);
    }
  }
}

function persistAllowedRoot(root: string): void {
  const directory = path.dirname(allowedRootsFile);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const releaseLock = acquireAllowedRootsLock();
  try {
    const roots = new Set(readPersistedAllowedRoots());
    // /api/cwd/validate is intentionally idempotent and may run on every
    // workspace-status poll. Avoid replacing the file when nothing changed.
    if (roots.has(root)) return;
    roots.add(root);
    const temporaryFile = `${allowedRootsFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify([...roots], null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, allowedRootsFile);
    fs.chmodSync(allowedRootsFile, 0o600);
  } finally {
    releaseLock();
  }
}

export function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export function getAdditionalAllowedRoots(): Set<string> {
  if (!globalThis.__piAdditionalAllowedRoots) {
    globalThis.__piAdditionalAllowedRoots = new Set();
  }
  // Next.js route handlers may execute in separate workers. Reload persisted
  // grants so a directory selected through /api/cwd/validate is immediately
  // available to Files, Git, and Worktree routes in those workers too.
  for (const root of readPersistedAllowedRoots()) {
    globalThis.__piAdditionalAllowedRoots.add(normalizeSlashes(root));
  }
  return globalThis.__piAdditionalAllowedRoots;
}

export function allowFileRoot(root: string): void {
  if (!root) return;
  const normalizedRoot = normalizeSlashes(root);
  // Persist first. A success response backed only by this worker's memory is
  // misleading: the next Files or Git request may execute in another worker
  // and immediately return 403. Callers must see a persistence failure.
  persistAllowedRoot(normalizedRoot);
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
}
