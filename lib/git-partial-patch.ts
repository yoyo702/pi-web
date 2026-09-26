/**
 * Parses a single-file unified diff from `git diff` and builds a patch that
 * contains only some of its changed lines, for line-level stage / unstage /
 * discard in Git Review. Pure: shared by the browser (line ids) and the
 * server (which rebuilds the patch from its own fresh diff).
 */

export interface PatchLine {
  kind: "context" | "added" | "removed";
  text: string;
  /** Changed lines are numbered across the whole patch; context lines have none. */
  id: number | null;
  /** Followed by "\ No newline at end of file". */
  noNewline: boolean;
  oldLineNo: number | null;
  newLineNo: number | null;
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Text after the second "@@", usually the enclosing function. */
  section: string;
  lines: PatchLine[];
}

export interface ParsedPatch {
  header: string[];
  hunks: PatchHunk[];
  changeCount: number;
}

/** "forward" applies the patch as written (stage); "reverse" is applied with `-R` (unstage, discard). */
export type PatchDirection = "forward" | "reverse";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export function parsePatch(patch: string): ParsedPatch {
  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let nextId = 0;
  const rows = patch.split("\n");
  if (rows.at(-1) === "") rows.pop();
  for (const row of rows) {
    const match = HUNK_HEADER.exec(row);
    if (match) {
      hunk = { oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]), newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]), section: match[5], lines: [] };
      hunks.push(hunk);
      oldNo = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
      newNo = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
      continue;
    }
    if (!hunk) { header.push(row); continue; }
    const marker = row[0];
    if (marker === "\\") {
      const last = hunk.lines.at(-1);
      if (last) last.noNewline = true;
    } else if (marker === "+") {
      hunk.lines.push({ kind: "added", text: row.slice(1), id: nextId++, noNewline: false, oldLineNo: null, newLineNo: newNo++ });
    } else if (marker === "-") {
      hunk.lines.push({ kind: "removed", text: row.slice(1), id: nextId++, noNewline: false, oldLineNo: oldNo++, newLineNo: null });
    } else if (marker === " " || row === "") {
      hunk.lines.push({ kind: "context", text: row.slice(1), id: null, noNewline: false, oldLineNo: oldNo++, newLineNo: newNo++ });
    } else {
      throw new Error(`Unexpected line in patch: ${row.slice(0, 40)}`);
    }
  }
  return { header, hunks, changeCount: nextId };
}

/** Ids of the changed lines in one hunk. */
export function hunkLineIds(hunk: PatchHunk): number[] {
  return hunk.lines.flatMap((line) => line.id === null ? [] : [line.id]);
}

function formatRange(start: number, count: number): string {
  return count === 1 ? String(start) : `${start},${count}`;
}

function formatLine(line: Pick<PatchLine, "kind" | "text" | "noNewline">): string {
  const marker = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
  return `${marker}${line.text}${line.noNewline ? "\n\\ No newline at end of file" : ""}`;
}

type OutputLine = Pick<PatchLine, "kind" | "text" | "noNewline">;

/**
 * A line without a final newline can stop being the last line of the side
 * `git apply` writes, e.g. when an unselected removal at the end of the file
 * becomes context before a selected addition. It then needs a newline there,
 * or git would join it with the next line. Like `git add -p`, a context line
 * is split into its unchanged read-side half and a written half with a newline.
 */
function endLinesBeforeMore(lines: OutputLine[], direction: PatchDirection): OutputLine[] {
  const written: PatchLine["kind"] = direction === "forward" ? "added" : "removed";
  const read: PatchLine["kind"] = direction === "forward" ? "removed" : "added";
  const lastWritten = lines.findLastIndex((line) => line.kind !== read);
  return lines.flatMap((line, index) => {
    if (!line.noNewline || line.kind === read || index === lastWritten) return [line];
    if (line.kind === written) return [{ ...line, noNewline: false }];
    return [{ ...line, kind: read }, { ...line, kind: written, noNewline: false }];
  });
}

/**
 * A patch with only the `selected` changed lines, or null when none are
 * selected. Unselected lines follow `git add -p` editing rules: going
 * forward, an unselected addition is dropped and an unselected removal
 * becomes context; in reverse it is the other way round, so the side that
 * `git apply` matches against is left exactly as it is.
 */
export function buildPartialPatch(parsed: ParsedPatch, selected: Iterable<number>, direction: PatchDirection): string | null {
  const ids = new Set(selected);
  const all = parsed.changeCount > 0 && Array.from({ length: parsed.changeCount }, (_, id) => id).every((id) => ids.has(id));
  const out: string[] = [];
  let oldSideEmpty = true;
  let newSideEmpty = true;
  // Lines added minus lines removed by the hunks written so far.
  let delta = 0;
  for (const hunk of parsed.hunks) {
    if (!hunk.lines.some((line) => line.id !== null && ids.has(line.id))) {
      // The hunk is left out; in reverse its unselected additions stay in the target.
      continue;
    }
    const kept: OutputLine[] = [];
    for (const line of hunk.lines) {
      if (line.id === null || ids.has(line.id)) kept.push(line);
      else if ((line.kind === "added") === (direction === "reverse")) kept.push({ ...line, kind: "context" });
    }
    const lines = endLinesBeforeMore(kept, direction);
    const oldCount = lines.filter((line) => line.kind !== "added").length;
    const newCount = lines.filter((line) => line.kind !== "removed").length;
    // The side `git apply` reads keeps its original position; the other shifts by `delta`.
    let oldStart: number;
    let newStart: number;
    if (direction === "forward") {
      const first = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart;
      oldStart = oldCount === 0 ? first - 1 : first;
      newStart = newCount === 0 ? first + delta - 1 : first + delta;
    } else {
      const first = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
      newStart = newCount === 0 ? first - 1 : first;
      oldStart = oldCount === 0 ? first - delta - 1 : first - delta;
    }
    delta += newCount - oldCount;
    if (oldCount > 0) oldSideEmpty = false;
    if (newCount > 0) newSideEmpty = false;
    out.push(`@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@${hunk.section}`, ...lines.map(formatLine));
  }
  if (out.length === 0) return null;
  const header = all ? parsed.header : partialHeader(parsed.header, oldSideEmpty, newSideEmpty);
  return `${[...header, ...out].join("\n")}\n`;
}

/**
 * Blob ids and mode changes only fit the complete change, so they are dropped. Part of a new
 * or deleted file that leaves lines on both sides no longer creates or
 * removes the file: its header names the file on both sides instead.
 */
function partialHeader(header: string[], oldSideEmpty: boolean, newSideEmpty: boolean): string[] {
  const oldName = header.find((row) => row.startsWith("--- ") && row !== "--- /dev/null");
  const newName = header.find((row) => row.startsWith("+++ ") && row !== "+++ /dev/null");
  return header.flatMap((row) => {
    // A mode change belongs to the whole file, not to some of its lines.
    if (row.startsWith("index ") || row.startsWith("old mode ") || row.startsWith("new mode ")) return [];
    if (row.startsWith("new file mode ") && !oldSideEmpty) return [];
    if (row.startsWith("deleted file mode ") && !newSideEmpty) return [];
    if (row === "--- /dev/null" && !oldSideEmpty && newName) return [newName.replace(/^\+\+\+ ("?)b\//, "--- $1a/")];
    if (row === "+++ /dev/null" && !newSideEmpty && oldName) return [oldName.replace(/^--- ("?)a\//, "+++ $1b/")];
    return [row];
  });
}

/** Content of a new file made of only the `selected` added lines. */
export function selectedAddedContent(parsed: ParsedPatch, selected: Iterable<number>): string {
  const ids = new Set(selected);
  return parsed.hunks
    .flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === "added" && line.id !== null && ids.has(line.id))
    .map((line) => line.noNewline ? line.text : `${line.text}\n`)
    .join("");
}
