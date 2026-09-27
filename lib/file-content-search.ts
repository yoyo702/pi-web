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
  // CRLF files leave a trailing \r once the record's \n terminator is split off.
  const stripped = text.endsWith("\r") ? text.slice(0, -1) : text;
  return stripped.length > MAX_SNIPPET_CHARS ? `${stripped.slice(0, MAX_SNIPPET_CHARS)}…` : stripped;
}

/** Parses `git grep -z -n` output. `-z` only NUL-terminates the fields
 * *within* a match record (`path\0line\0text`); records themselves are still
 * newline-terminated, so this splits on `\n` first and then on the first two
 * `\0`s within each record (verified against Git 2.50 — see the brief). */
export function parseGitGrepOutput(output: string, limit = CONTENT_SEARCH_MAX_MATCHES): ContentMatch[] {
  const matches: ContentMatch[] = [];
  for (const record of output.split("\n")) {
    if (matches.length >= limit) break;
    if (!record) continue;
    const firstNul = record.indexOf("\0");
    if (firstNul === -1) continue;
    const secondNul = record.indexOf("\0", firstNul + 1);
    if (secondNul === -1) continue;
    const filePath = record.slice(0, firstNul);
    const lineNumber = Number.parseInt(record.slice(firstNul + 1, secondNul), 10);
    const text = record.slice(secondNul + 1);
    if (!filePath || !Number.isFinite(lineNumber)) continue;
    matches.push({ path: filePath, line: lineNumber, text: trimSnippet(text) });
  }
  return matches;
}

export type GitGrepErrorOutcome =
  | { kind: "empty" }
  | { kind: "partial"; stdout: string }
  | { kind: "fallback" };

/** Maps an `execFile("git", ["grep", ...])` failure to what the caller
 * should do with it:
 * - exit 1 with no output is a real "no matches", not a failure.
 * - exit 128 (not a Git repo) or `ENOENT` (git itself isn't on PATH) has no
 *   useful output — fall back to the walk.
 * - anything else that killed the process early — a maxBuffer trip, our own
 *   timeout, or an aborted request — still leaves whatever git had already
 *   written to stdout before being cut off. Returning that partial output
 *   instead of `null` matters: `null` sends the caller to the synchronous,
 *   `.gitignore`-blind walk fallback, which is strictly worse than a
 *   truncated-but-real git result. */
export function classifyGitGrepError(error: unknown): GitGrepErrorOutcome {
  const err = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; stdout?: unknown };
  if (err.code === 1) return { kind: "empty" };
  if (err.code === 128 || err.code === "ENOENT") return { kind: "fallback" };
  if (typeof err.stdout === "string") return { kind: "partial", stdout: err.stdout };
  return { kind: "fallback" };
}

/** Returns matches, `[]` for "no matches", or `null` when this isn't a Git
 * repo (or git failed with nothing usable to show) so the caller can fall
 * back to the walk. */
export async function searchContentWithGit(cwd: string, query: string, signal?: AbortSignal): Promise<ContentMatch[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "grep", "-I", "-z", "-n", "--untracked", "--exclude-standard", "-F", "-i", "-e", query],
      { timeout: CONTENT_SEARCH_TIMEOUT_MS, maxBuffer: CONTENT_SEARCH_MAX_BUFFER, env: { ...process.env, LC_ALL: "C" }, signal },
    );
    return parseGitGrepOutput(stdout);
  } catch (error) {
    const outcome = classifyGitGrepError(error);
    if (outcome.kind === "empty") return [];
    if (outcome.kind === "partial") return parseGitGrepOutput(outcome.stdout);
    return null;
  }
}

const IGNORED_DIR_NAMES = new Set([
  "node_modules", ".git", ".next", "dist", "build", "__pycache__",
  ".turbo", ".cache", "coverage", ".pytest_cache", ".mypy_cache",
  "target", "vendor",
]);

/** Fallback for directories that are not inside a Git repository (or when
 * git is missing): `git grep` can't run there, so this walks the tree
 * breadth-first instead. It does not honour `.gitignore` (there is none to
 * honour) and skips the usual generated/dependency folders, binary files and
 * files over 1 MB. It is bounded by file count (5,000) and match count, not
 * by time: it is synchronous and has no timeout, so the caps are what keep
 * it cheap. */
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

export async function searchFileContent(cwd: string, query: string, signal?: AbortSignal): Promise<ContentMatch[]> {
  const gitResult = await searchContentWithGit(cwd, query, signal);
  return gitResult ?? searchContentWithWalk(cwd, query);
}
