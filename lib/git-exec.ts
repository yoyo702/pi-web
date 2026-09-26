import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Environment for every git invocation:
 * - `LC_ALL=C` pins message language; callers match on git's error text
 *   (e.g. dirty-worktree detection).
 * - `GIT_TERMINAL_PROMPT=0` makes auth failures fail fast instead of waiting
 *   for an invisible credential prompt until the request times out.
 */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
}

/**
 * Run git and return raw stdout. Errors are the original `execFile` errors
 * (with `stderr`), so callers can inspect or rewrap them.
 */
export async function runGit(
  args: string[],
  options: { cwd?: string; timeout: number; maxBuffer?: number },
): Promise<string> {
  const { stdout } = await execFileAsync("git", options.cwd ? ["-C", options.cwd, ...args] : args, {
    timeout: options.timeout,
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
    env: gitEnvironment(),
  });
  return stdout;
}

export const GIT_TIMEOUT_MS = 10_000;
/** Hooks (husky, lint-staged, LFS) and the network can legitimately take minutes. */
export const GIT_LONG_TIMEOUT_MS = 5 * 60_000;
const LONG_RUNNING_COMMANDS = new Set(["commit", "push", "fetch", "pull", "switch"]);

/** Timeout for `git <args>`; `args[0]` is the subcommand. */
export function gitCommandTimeout(args: string[]): number {
  return LONG_RUNNING_COMMANDS.has(args[0]) ? GIT_LONG_TIMEOUT_MS : GIT_TIMEOUT_MS;
}

/** A message the Git panel can show: timeouts name the command, other failures use git's stderr. */
export function gitFailureMessage(error: unknown, args: string[], timeout: number): string {
  if (typeof error === "object" && error !== null && "killed" in error && error.killed) {
    return `git ${args[0]} did not finish within ${timeout / 1000} s and was stopped`;
  }
  const detail = typeof error === "object" && error !== null && "stderr" in error
    ? String(error.stderr).trim()
    : "";
  return detail || (error instanceof Error ? error.message : String(error));
}
