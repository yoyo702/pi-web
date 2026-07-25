import fs from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "./file-access";

export type GitCwdError = { error: string; status: number };

/**
 * Validate a `cwd` provided by a Git API request. Mirrors the inline checks in
 * the GET routes: absolute path, on the allow-list, exists, and is a directory.
 * Returns `null` when valid, or an `{ error, status }` describing the failure.
 */
export async function validateGitCwd(cwd: string | null | undefined): Promise<GitCwdError | null> {
  const trimmed = cwd?.trim() ?? "";
  if (!trimmed || (!trimmed.startsWith("/") && !isWindowsAbsolutePath(trimmed))) {
    return { error: "cwd must be an absolute path", status: 400 };
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(trimmed, allowedRoots)) {
    return { error: "Access denied", status: 403 };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(trimmed);
  } catch {
    return { error: "Directory not found", status: 404 };
  }
  if (!stat.isDirectory()) {
    return { error: "Not a directory", status: 400 };
  }
  if (!isExistingFilePathAllowed(trimmed, allowedRoots)) {
    return { error: "Access denied", status: 403 };
  }
  return null;
}
