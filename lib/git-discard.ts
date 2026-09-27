import type { GitFileStatus } from "./git-types";

/** Stash message for changes discarded from the Git panel; restore them from the stash list. */
export const DISCARD_STASH_MESSAGE = "TianForge: discarded changes";

export function discardConfirmMessage(files: Pick<GitFileStatus, "status">[]): string {
  const conflicts = files.filter((file) => file.status === "conflict").length;
  const saved = files.length - conflicts;
  const head = files.length === 1
    ? (files[0].status === "untracked" ? "Discard this file?" : "Discard changes to this file?")
    : `Discard changes to ${files.length} files?`;
  const lines = [head];
  if (saved > 0) lines.push(`The changes are saved as a Git stash ("${DISCARD_STASH_MESSAGE}"), so you can restore them from the stash list.`);
  if (conflicts > 0) lines.push(`${conflicts} conflicted file${conflicts === 1 ? " is" : "s are"} reset to HEAD and cannot be restored.`);
  return lines.join("\n\n");
}
