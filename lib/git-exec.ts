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
