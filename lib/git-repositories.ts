import fs from "fs";
import path from "path";
import { runGit } from "./git-exec";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git", "node_modules", ".next", "dist", "build", "coverage", ".turbo",
  ".cache", "vendor", "target", "__pycache__",
]);
const MAX_DISCOVERY_DEPTH = 3;
const MAX_REPOSITORIES = 50;

export interface GitRepositoryEntry {
  /** Directory passed to Git APIs. For a workspace already inside a repo this
   * remains the workspace cwd, preserving the existing allowed-root behavior. */
  path: string;
  repositoryRoot: string;
  label: string;
  relativePath: string;
}

async function resolveRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await runGit(["rev-parse", "--show-toplevel"], { cwd, timeout: 5_000 })).trim() || null;
  } catch {
    return null;
  }
}

function labelFor(workspaceCwd: string, repositoryPath: string): Pick<GitRepositoryEntry, "label" | "relativePath"> {
  const relativePath = path.relative(workspaceCwd, repositoryPath) || ".";
  return {
    label: relativePath === "." ? path.basename(repositoryPath) || repositoryPath : relativePath,
    relativePath,
  };
}

/**
 * Discover repositories belonging to a workspace. A workspace that is already
 * within a Git repository keeps the historical single-repository behavior.
 * Otherwise, scan a bounded set of descendant directories for independent
 * repositories (including linked worktrees whose `.git` marker is a file).
 */
export async function discoverGitRepositories(workspaceCwd: string): Promise<GitRepositoryEntry[]> {
  const containingRoot = await resolveRepositoryRoot(workspaceCwd);
  if (containingRoot) {
    return [{
      path: workspaceCwd,
      repositoryRoot: containingRoot,
      ...labelFor(workspaceCwd, workspaceCwd),
    }];
  }

  const repositories: GitRepositoryEntry[] = [];
  const queue: Array<{ directory: string; depth: number }> = [{ directory: workspaceCwd, depth: 0 }];

  while (queue.length > 0 && repositories.length < MAX_REPOSITORIES) {
    const { directory, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    if (depth > 0 && entries.some((entry) => entry.name === ".git" && (entry.isDirectory() || entry.isFile()))) {
      const repositoryRoot = await resolveRepositoryRoot(directory);
      if (repositoryRoot) {
        repositories.push({
          // Keep the path spelling discovered under the allowed workspace
          // (for example `/var/...` rather than Git's `/private/var/...`).
          // The canonical Git root remains available for identity/deduping.
          path: directory,
          repositoryRoot,
          ...labelFor(workspaceCwd, directory),
        });
      }
      // Treat a discovered repository as one unit. Nested repositories can be
      // opened as their own workspace if needed, without an unbounded scan.
      continue;
    }

    if (depth >= MAX_DISCOVERY_DEPTH) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.startsWith("._") || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }

  return repositories
    .filter((repository, index, all) => all.findIndex((candidate) => candidate.repositoryRoot === repository.repositoryRoot) === index)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
