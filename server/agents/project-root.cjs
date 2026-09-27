"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const { execFile } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const { dirname } = require("node:path");

const CACHE_TTL_MS = 60_000;
// Simple size bound so a long-running server with many distinct cwds (worktrees,
// closed/reopened projects) doesn't grow this cache unbounded: once at the cap,
// drop the oldest entry (Map iteration order is insertion order) before adding
// a new one, mirroring lib/worktree.ts's project-info cache plus this limit.
const CACHE_MAX_ENTRIES = 500;
const cache = global.__piWebProjectRootCache || new Map();
global.__piWebProjectRootCache = cache;

function setCached(cwd, entry) {
  if (!cache.has(cwd) && cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(cwd, entry);
}

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Resolves a cwd to its project root: the main checkout directory for a
 * linked Git worktree, or the cwd itself for a main checkout or a non-git
 * directory. Mirrors lib/worktree.ts's resolveProject() for CJS server
 * modules, which cannot require() a TypeScript/ESM module from lib/.
 * Cached for 60s per cwd, same TTL as the TS/ESM version.
 */
async function resolveProjectRoot(cwd) {
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > Date.now()) return cached.root;
  let root = cwd;
  try {
    if (existsSync(cwd)) {
      const out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"]);
      const [commonDir, gitDir, toplevel] = out.split("\n").map((line) => line.trim());
      let realCwd = cwd;
      try { realCwd = realpathSync(cwd); } catch { /* keep as-is */ }
      // toplevel === realCwd intentionally means a cwd inside a worktree
      // *subdirectory* (rather than the worktree's own top-level dir) resolves
      // to itself, not to the main checkout — only the worktree root itself
      // gets redirected via dirname(commonDir).
      if (gitDir !== commonDir && toplevel === realCwd) root = dirname(commonDir);
    }
  } catch {
    // Not a git repo, or git unavailable: cwd is its own root.
  }
  setCached(cwd, { root, expiresAt: Date.now() + CACHE_TTL_MS });
  return root;
}

/**
 * Sets `state.projectRoot` to `cwd` right away, then fire-and-forget resolves
 * the real project root and stores it on `state` when it arrives.
 */
function attachProjectRoot(state, cwd) {
  state.projectRoot = cwd;
  resolveProjectRoot(cwd).then((root) => { state.projectRoot = root; }).catch(() => {});
}

function _resetForTests() {
  cache.clear();
}

module.exports = { resolveProjectRoot, attachProjectRoot, _resetForTests };
