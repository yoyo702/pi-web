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

function readPersistedAllowedRoots(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(allowedRootsFile, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((root): root is string => typeof root === "string" && path.isAbsolute(root)) : [];
  } catch {
    return [];
  }
}

function persistAllowedRoot(root: string): void {
  try {
    const roots = new Set(readPersistedAllowedRoots());
    roots.add(root);
    const directory = path.dirname(allowedRootsFile);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryFile = `${allowedRootsFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryFile, `${JSON.stringify([...roots], null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporaryFile, allowedRootsFile);
    fs.chmodSync(allowedRootsFile, 0o600);
  } catch {
    // The in-memory grant still works when the settings directory is read-only.
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
  getAdditionalAllowedRoots().add(normalizedRoot);
  globalThis.__piAllowedRootsCache?.roots.add(normalizedRoot);
  persistAllowedRoot(normalizedRoot);
}
