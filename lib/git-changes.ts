import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitBranch,
  GitBranchesResponse,
  GitCommitDetail,
  GitCommitFile,
  GitFileDiffResponse,
  GitFileStatus,
  GitFileStatusKind,
  GitLogResponse,
  GitStatusResponse,
  GitStashEntry,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;
const COMMIT_MESSAGE_DIFF_MAX_CHARS = 50_000;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer,
      // Fail visibly rather than opening an invisible terminal credential prompt.
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch (error) {
    const detail = typeof error === "object" && error !== null && "stderr" in error
      ? String(error.stderr).trim()
      : "";
    throw new Error(detail || (error instanceof Error ? error.message : String(error)));
  }
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string): Promise<GitPorcelainEntry[]> {
  const output = await git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  return parseGitPorcelainV1(output);
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, repositoryRoot: null, branch: null, files: [] };
  }

  const [entries, branchOutput, aheadBehind, remotesOutput] = await Promise.all([
    readStatusEntries(repositoryRoot),
    git(repositoryRoot, ["branch", "--show-current"]).catch(() => ""),
    getAheadBehind(repositoryRoot),
    git(repositoryRoot, ["remote"]).catch(() => ""),
  ]);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const filePath = path.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(cwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });

  return {
    isGitRepository: true,
    repositoryRoot,
    branch: branchOutput.trim() || null,
    files,
    upstream: aheadBehind?.upstream ?? null,
    ahead: aheadBehind?.ahead ?? null,
    behind: aheadBehind?.behind ?? null,
    remotes: remotesOutput.split(/\r?\n/).map((name) => name.trim()).filter(Boolean),
  };
}

async function getAheadBehind(
  repositoryRoot: string,
): Promise<{ upstream: string; ahead: number; behind: number } | null> {
  try {
    const upstream = (await git(repositoryRoot, [
      "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}",
    ])).trim();
    if (!upstream) return null;
    // `--left-right --count <upstream>...HEAD` prints "<behind>\t<ahead>":
    // left = commits only in upstream (behind), right = commits only in HEAD (ahead).
    const counts = (await git(repositoryRoot, [
      "rev-list", "--left-right", "--count", "@{upstream}...HEAD",
    ])).trim();
    const [behind, ahead] = counts.split(/\s+/).map((n) => Number.parseInt(n, 10) || 0);
    return { upstream, ahead, behind };
  } catch {
    return null;
  }
}

export type GitRemoteAction = "fetch" | "pull" | "push" | "publish";

async function getPublishRemote(repositoryRoot: string): Promise<string> {
  const remotes = (await git(repositoryRoot, ["remote"]))
    .split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  if (remotes.length === 0) throw new Error("No Git remote is configured for this repository");
  throw new Error("Multiple remotes are configured. Set an upstream in Git before publishing this branch.");
}

/**
 * Run a deliberately conservative remote operation for the current branch.
 * Pull refuses dirty worktrees and uses --ff-only so it can never create a
 * merge commit or start a rebase from the web UI.
 */
export async function syncGitRemote(cwd: string, action: GitRemoteAction): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) throw new Error("This folder is not a Git repository");
  const upstream = await getAheadBehind(repositoryRoot);
  if (action === "publish") {
    if (upstream?.upstream) throw new Error(`This branch already tracks ${upstream.upstream}`);
    const branch = (await git(repositoryRoot, ["branch", "--show-current"])).trim();
    if (!branch) throw new Error("Cannot publish a detached HEAD");
    const remote = await getPublishRemote(repositoryRoot);
    await git(repositoryRoot, ["push", "--set-upstream", remote, branch]);
  } else if (action === "fetch") {
    await git(repositoryRoot, ["fetch", "--prune"]);
  } else {
    if (!upstream?.upstream) throw new Error("The current branch has no upstream remote branch configured");
    if (action === "pull") {
      const changes = await readStatusEntries(repositoryRoot);
      if (changes.length > 0) {
        throw new Error("Pull is blocked because the worktree has uncommitted changes. Commit, stash, or discard them first.");
      }
      await git(repositoryRoot, ["pull", "--ff-only"]);
    } else {
      await git(repositoryRoot, ["push"]);
    }
  }
  return getGitStatus(cwd);
}

export type StagedDiffForCommitMessage = {
  diff: string;
  truncated: boolean;
};

export type GitStashAction = "save" | "apply" | "pop" | "drop";

export async function getGitStashes(cwd: string): Promise<GitStashEntry[]> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) throw new Error("This folder is not a Git repository");
  const output = await git(repositoryRoot, ["stash", "list", "--format=%gd%x00%gs%x00%ci%x00"]);
  const fields = output.split("\0");
  const stashes: GitStashEntry[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const ref = fields[i]?.trim();
    if (!ref) continue;
    const match = /^stash@\{(\d+)\}$/.exec(ref);
    if (!match) continue;
    stashes.push({
      index: Number.parseInt(match[1], 10),
      ref,
      message: fields[i + 1]?.trim() || ref,
      date: fields[i + 2]?.trim() || "",
    });
  }
  return stashes;
}

export async function changeGitStash(
  cwd: string,
  action: GitStashAction,
  options: { index?: number; message?: string } = {},
): Promise<GitStatusResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) throw new Error("This folder is not a Git repository");
  if (action === "save") {
    const changes = await readStatusEntries(repositoryRoot);
    if (changes.length === 0) throw new Error("No local changes to stash");
    const message = options.message?.trim();
    await git(repositoryRoot, ["stash", "push", "--include-untracked", ...(message ? ["--message", message] : [])]);
  } else {
    const index = options.index;
    if (!Number.isInteger(index) || (index as number) < 0) throw new Error("A valid stash index is required");
    const ref = `stash@{${index}}`;
    await git(repositoryRoot, action === "apply"
      ? ["stash", "apply", ref]
      : action === "pop"
        ? ["stash", "pop", ref]
        : ["stash", "drop", ref]);
  }
  return getGitStatus(cwd);
}

/** Returns a bounded staged patch for an explicit, user-triggered AI summary. */
export async function getStagedDiffForCommitMessage(cwd: string): Promise<StagedDiffForCommitMessage> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) throw new Error("This folder is not a Git repository");
  const diff = await git(repositoryRoot, [
    "diff", "--cached", "--no-color", "--no-ext-diff", "--unified=3",
  ], COMMIT_MESSAGE_DIFF_MAX_CHARS * 4);
  if (!diff.trim()) throw new Error("No staged changes to summarize");
  return {
    diff: diff.slice(0, COMMIT_MESSAGE_DIFF_MAX_CHARS),
    truncated: diff.length > COMMIT_MESSAGE_DIFF_MAX_CHARS,
  };
}
function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  scope: "combined" | "staged" | "unstaged",
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  const scopeArgs = scope === "staged"
    ? ["--cached"]
    : scope === "combined" ? ["HEAD"] : [];
  try {
    return await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      ...scopeArgs,
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(
  cwd: string,
  filePath: string,
  scope: "combined" | "staged" | "unstaged" | "untracked" = "combined",
): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  const resolvedFilePath = path.resolve(filePath);
  if (!repositoryRoot || !isWithinPath(repositoryRoot, resolvedFilePath)) return { supported: false };

  const relativePath = toGitPath(path.relative(repositoryRoot, resolvedFilePath));
  const entries = await readStatusEntries(repositoryRoot);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (scope === "untracked") {
    if (status !== "untracked") return { supported: false };
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolvedFilePath);
    } catch {
      return { supported: false };
    }
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };
    const currentBuffer = fs.readFileSync(resolvedFilePath);
    if (hasNullByte(currentBuffer)) return { supported: false };
    const patch = createAddedFilePatch(relativePath, currentBuffer.toString("utf8"));
    return { supported: true, status, scope, patch };
  }

  if (status === "untracked") return { supported: false };
  const trackedScope = scope === "combined" ? "combined" : scope;
  const patch = await createTrackedFilePatch(repositoryRoot, relativePath, trackedScope, entry.originalPath);
  // A valid Git diff with no hunks means this file has no changes in this scope
  // (for example, a staged-only file viewed in the unstaged group).
  if (!patch || !patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, scope, patch };
}

const GIT_LOG_MAX_BUFFER = 32 * 1024 * 1024;
const UNIT = "\x1f";
const LOG_FORMAT = ["%H", "%h", "%an", "%aI", "%P", "%D"].join(UNIT) + UNIT + "%s";

function parseRefs(decoration: string): string[] {
  return decoration
    .split(",")
    .map((ref) => ref.trim().replace(/^HEAD -> /, "").replace(/^tag: /, "tag: "))
    .filter(Boolean);
}

export async function getGitLog(
  cwd: string,
  options: { limit?: number; skip?: number } = {},
): Promise<GitLogResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) return { isGitRepository: false, commits: [], hasMore: false };

  const limit = Math.min(Math.max(options.limit ?? 60, 1), 500);
  const skip = Math.max(options.skip ?? 0, 0);
  const output = await git(repositoryRoot, [
    "log",
    "-z",
    "--topo-order",
    `--max-count=${limit + 1}`,
    `--skip=${skip}`,
    `--pretty=format:${LOG_FORMAT}`,
  ], GIT_LOG_MAX_BUFFER);

  const records = output.split("\0").filter((record) => record.length > 0);
  const commits: GitLogResponse["commits"] = records.slice(0, limit).map((record) => {
    const [hash, shortHash, author, date, parents, refs, subject] = record.split(UNIT);
    return {
      hash,
      shortHash,
      author,
      date,
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      refs: refs ? parseRefs(refs) : [],
      subject: subject ?? "",
    };
  });
  return { isGitRepository: true, commits, hasMore: records.length > limit };
}

const STATUS_LETTER_TO_KIND: Record<string, GitFileStatusKind> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "renamed",
  T: "modified",
  U: "conflict",
};

function parseNumstatZ(output: string): Array<{ path: string; oldPath?: string; additions: number | null; deletions: number | null }> {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const files: Array<{ path: string; oldPath?: string; additions: number | null; deletions: number | null }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const parts = tokens[i].split("\t");
    const additions = parts[0] === "-" ? null : Number.parseInt(parts[0], 10);
    const deletions = parts[1] === "-" ? null : Number.parseInt(parts[1], 10);
    let filePath = parts.slice(2).join("\t");
    let oldPath: string | undefined;
    if (filePath === "") {
      // Rename/copy: numstat -z emits the stat token, then old path, then new path.
      oldPath = tokens[i + 1];
      filePath = tokens[i + 2];
      i += 2;
    }
    files.push({ path: filePath, oldPath, additions, deletions });
  }
  return files;
}

function parseNameStatusZ(output: string): Map<string, string> {
  const tokens = output.split("\0").filter((token) => token.length > 0);
  const map = new Map<string, string>();
  for (let i = 0; i < tokens.length;) {
    const code = tokens[i];
    if (code.startsWith("R") || code.startsWith("C")) {
      const newPath = tokens[i + 2];
      if (newPath) map.set(newPath, code[0]);
      i += 3;
    } else {
      const filePath = tokens[i + 1];
      if (filePath) map.set(filePath, code[0]);
      i += 2;
    }
  }
  return map;
}

async function getCommitFiles(repositoryRoot: string, hash: string): Promise<GitCommitFile[]> {
  const [numstatOut, nameStatusOut] = await Promise.all([
    git(repositoryRoot, ["show", "--numstat", "-z", "--format=", hash], GIT_LOG_MAX_BUFFER),
    git(repositoryRoot, ["show", "--name-status", "-z", "--format=", hash], GIT_LOG_MAX_BUFFER),
  ]);
  const statusByPath = parseNameStatusZ(nameStatusOut);
  return parseNumstatZ(numstatOut).map((file) => {
    const letter = statusByPath.get(file.path) ?? "M";
    return {
      path: file.path,
      oldPath: file.oldPath,
      status: STATUS_LETTER_TO_KIND[letter[0]] ?? "modified",
      additions: file.additions,
      deletions: file.deletions,
    };
  });
}

export async function getGitCommitDetail(cwd: string, hash: string): Promise<GitCommitDetail | null> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot || !/^[0-9a-fA-F]{4,40}$/.test(hash)) return null;

  const metaFormat = ["%H", "%h", "%an", "%ae", "%aI", "%P", "%D", "%s"].join(UNIT) + UNIT + "%b";
  let meta: string;
  try {
    meta = await git(repositoryRoot, ["show", "-s", `--format=${metaFormat}`, hash], GIT_LOG_MAX_BUFFER);
  } catch {
    return null;
  }
  const [full, short, author, email, date, parents, refs, subject, ...bodyParts] = meta.split(UNIT);
  const body = bodyParts.join(UNIT).replace(/\n+$/, "");
  const files = await getCommitFiles(repositoryRoot, hash);
  const additions = files.reduce((sum, file) => sum + (file.additions ?? 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0);
  return {
    hash: full,
    shortHash: short,
    author,
    email,
    date,
    parents: parents ? parents.split(" ").filter(Boolean) : [],
    refs: refs ? parseRefs(refs) : [],
    subject: subject ?? "",
    body,
    files,
    additions,
    deletions,
  };
}

export async function getGitCommitFileDiff(
  cwd: string,
  hash: string,
  filePath: string,
): Promise<GitFileDiffResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot || !/^[0-9a-fA-F]{4,40}$/.test(hash)) return { supported: false };
  const relativePath = toGitPath(filePath);
  try {
    const patch = await git(repositoryRoot, [
      "show",
      "--no-color",
      "--no-ext-diff",
      "--format=",
      hash,
      "--",
      relativePath,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
    if (!patch || !patch.includes("\n@@ ")) return { supported: false };
    return { supported: true, patch };
  } catch {
    return { supported: false };
  }
}

function safeRepoRelPaths(repositoryRoot: string, paths: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.length === 0) continue;
    const abs = path.resolve(repositoryRoot, raw);
    if (!isWithinPath(repositoryRoot, abs)) continue;
    const rel = toGitPath(path.relative(repositoryRoot, abs));
    if (rel) seen.add(rel);
  }
  return [...seen];
}

async function requireRepositoryRoot(cwd: string): Promise<string> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) throw new Error("Not a Git repository");
  return repositoryRoot;
}

export async function stageFiles(cwd: string, paths: string[]): Promise<GitStatusResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  const rel = safeRepoRelPaths(repositoryRoot, paths);
  if (rel.length > 0) {
    await git(repositoryRoot, ["add", "--", ...rel]);
  }
  return getGitStatus(cwd);
}

export async function unstageFiles(cwd: string, paths: string[]): Promise<GitStatusResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  const rel = safeRepoRelPaths(repositoryRoot, paths);
  if (rel.length > 0) {
    // `restore --staged` resets the index entry back to HEAD without touching
    // the working tree; falls back to `reset` on very old Git via the catch.
    try {
      await git(repositoryRoot, ["restore", "--staged", "--", ...rel]);
    } catch {
      await git(repositoryRoot, ["reset", "-q", "HEAD", "--", ...rel]);
    }
  }
  return getGitStatus(cwd);
}

export async function discardChanges(cwd: string, paths: string[]): Promise<GitStatusResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  const rel = safeRepoRelPaths(repositoryRoot, paths);
  if (rel.length === 0) return getGitStatus(cwd);

  const entries = await readStatusEntries(repositoryRoot);
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const relPath of rel) {
    const entry = entries.find((candidate) => candidate.path === relPath);
    const kind = entry ? classifyGitStatus(entry).status : "modified";
    if (kind === "untracked") untracked.push(relPath);
    else tracked.push(relPath);
  }

  if (tracked.length > 0) {
    // Reset both the index and the working tree back to HEAD for these files.
    await git(repositoryRoot, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...tracked]);
  }
  for (const relPath of untracked) {
    try {
      fs.rmSync(path.resolve(repositoryRoot, relPath), { force: true });
    } catch {
      // Ignore files that vanished between status and discard.
    }
  }
  return getGitStatus(cwd);
}

export async function commitChanges(
  cwd: string,
  message: string,
  options: { amend?: boolean } = {},
): Promise<GitStatusResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  const trimmed = message.trim();
  if (!trimmed) throw new Error("Commit message is required");
  const args = ["commit"];
  if (options.amend) args.push("--amend");
  args.push("-m", trimmed);
  await git(repositoryRoot, args);
  return getGitStatus(cwd);
}

const BRANCH_UNIT = "\x1f";

function parseTrack(track: string | undefined): { ahead: number | null; behind: number | null } {
  if (!track) return { ahead: null, behind: null };
  const aheadMatch = /ahead (\d+)/.exec(track);
  const behindMatch = /behind (\d+)/.exec(track);
  if (!aheadMatch && !behindMatch) return { ahead: null, behind: null };
  return {
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

async function forEachRef(repositoryRoot: string, ref: string, remote: boolean): Promise<GitBranch[]> {
  const format = [
    "%(refname)",
    "%(refname:short)",
    "%(HEAD)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(contents:subject)",
    "%(committerdate:iso-strict)",
  ].join("%1f");
  const output = await git(repositoryRoot, ["for-each-ref", `--format=${format}`, ref]);
  const branches: GitBranch[] = [];
  for (const line of output.split("\n")) {
    if (!line) continue;
    const [fullName, name, head, upstream, track, subject, date] = line.split(BRANCH_UNIT);
    if (!name) continue;
    // Skip the symbolic remote HEAD (e.g. refs/remotes/origin/HEAD -> origin).
    if (remote && /\/HEAD$/.test(fullName)) continue;
    const { ahead, behind } = parseTrack(track);
    branches.push({
      name,
      current: head?.trim() === "*",
      remote,
      upstream: upstream || null,
      ahead,
      behind,
      subject: subject ?? "",
      lastCommitDate: date || null,
    });
  }
  return branches;
}

export async function getBranches(cwd: string): Promise<GitBranchesResponse> {
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return { isGitRepository: false, current: null, local: [], remotes: [] };
  }
  const [local, remotes] = await Promise.all([
    forEachRef(repositoryRoot, "refs/heads", false),
    forEachRef(repositoryRoot, "refs/remotes", true),
  ]);
  const current = local.find((branch) => branch.current)?.name ?? null;
  return { isGitRepository: true, current, local, remotes };
}

function assertValidBranchRef(name: string, label = "Branch name"): void {
  if (typeof name !== "string" || !name.trim()) throw new Error(`${label} is required`);
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) throw new Error(`Invalid ${label.toLowerCase()}`);
  if (name.includes("..") || /[\s~^:?*\[\\]/.test(name)) throw new Error(`Invalid ${label.toLowerCase()}`);
}

export async function checkoutBranch(cwd: string, name: string): Promise<GitBranchesResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  assertValidBranchRef(name);
  // `switch` DWIMs a unique remote branch into a local tracking branch.
  await git(repositoryRoot, ["switch", name]);
  return getBranches(cwd);
}

export async function createBranch(
  cwd: string,
  name: string,
  options: { startPoint?: string; checkout?: boolean } = {},
): Promise<GitBranchesResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  assertValidBranchRef(name);
  const startPoint = options.startPoint?.trim();
  if (startPoint) assertValidBranchRef(startPoint, "Start point");
  if (options.checkout === false) {
    await git(repositoryRoot, ["branch", name, ...(startPoint ? [startPoint] : [])]);
  } else {
    await git(repositoryRoot, ["switch", "-c", name, ...(startPoint ? [startPoint] : [])]);
  }
  return getBranches(cwd);
}

export async function deleteBranch(cwd: string, name: string, force = false): Promise<GitBranchesResponse> {
  const repositoryRoot = await requireRepositoryRoot(cwd);
  assertValidBranchRef(name);
  await git(repositoryRoot, ["branch", force ? "-D" : "-d", name]);
  return getBranches(cwd);
}
