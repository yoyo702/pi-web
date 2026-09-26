"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { GitLineAction } from "@/lib/git-types";
import { hunkLineIds, parsePatch, type ParsedPatch, type PatchLine } from "@/lib/git-partial-patch";
import { DiffView, FILE_CODE_STYLE, FILE_LINE_NUMBER_STYLE } from "./FileViewer";

export type LineScope = "staged" | "unstaged" | "untracked";

const SCOPE_ACTIONS: Record<LineScope, Array<{ action: GitLineAction; label: string }>> = {
  unstaged: [{ action: "stage", label: "Stage" }, { action: "discard", label: "Discard" }],
  staged: [{ action: "unstage", label: "Unstage" }],
  untracked: [{ action: "stage", label: "Stage" }],
};

const ACTION_TITLES: Record<GitLineAction, string> = {
  stage: "Add these lines to the next commit",
  unstage: "Remove these lines from the next commit",
  discard: "Drop these changes from the working tree — cannot be undone",
};

function range(from: number, to: number): number[] {
  const [low, high] = from <= to ? [from, to] : [to, from];
  return Array.from({ length: high - low + 1 }, (_, index) => low + index);
}

/**
 * A Git Review diff whose hunks and changed lines can be staged, unstaged or
 * discarded on their own. Click a line's gutter to select it, Shift+click to
 * select a range, or drag across gutters. Remount it (key by fingerprint)
 * when the diff changes so an old selection is never kept.
 */
export function GitLineDiffView({ patch, scope, fileLabel, busy, onApply }: {
  patch: string;
  scope: LineScope;
  fileLabel: string;
  busy: boolean;
  onApply: (action: GitLineAction, lineIds: number[]) => void;
}) {
  const parsed = useMemo<ParsedPatch | null>(() => {
    try { return parsePatch(patch); } catch { return null; }
  }, [patch]);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchor = useRef<number | null>(null);
  // While dragging: the selection before the drag and whether lines are being added or removed.
  const drag = useRef<{ start: number; base: Set<number>; adding: boolean } | null>(null);

  useEffect(() => {
    const end = () => { drag.current = null; };
    window.addEventListener("mouseup", end);
    window.addEventListener("blur", end);
    return () => { window.removeEventListener("mouseup", end); window.removeEventListener("blur", end); };
  }, []);

  if (!parsed) return <DiffView patch={patch} />;
  const actions = SCOPE_ACTIONS[scope];

  function apply(action: GitLineAction, ids: number[]) {
    if (ids.length === 0 || busy) return;
    const count = ids.length === 1 ? "1 line" : `${ids.length} lines`;
    if (action === "discard" && !window.confirm(`Discard ${count} in ${fileLabel}? This cannot be undone.`)) return;
    onApply(action, ids);
  }

  function dragTo(id: number) {
    const current = drag.current;
    if (!current) return;
    const next = new Set(current.base);
    for (const lineId of range(current.start, id)) {
      if (current.adding) next.add(lineId); else next.delete(lineId);
    }
    setSelected(next);
  }

  function pressGutter(id: number, shift: boolean) {
    if (shift && anchor.current !== null) {
      setSelected(new Set([...selected, ...range(anchor.current, id)]));
      return;
    }
    const adding = !selected.has(id);
    anchor.current = id;
    drag.current = { start: id, base: selected, adding };
    const next = new Set(selected);
    if (adding) next.add(id); else next.delete(id);
    setSelected(next);
  }

  const selectedIds = [...selected].sort((a, b) => a - b);

  return (
    <div>
      <div role="toolbar" aria-label="Line selection" style={toolbarStyle}>
        {selectedIds.length === 0 ? (
          <span style={{ color: "var(--text-dim)" }}>Click a line&apos;s gutter to select it · Shift+click or drag to select more</span>
        ) : (
          <>
            <span style={{ color: "var(--text-muted)", fontWeight: 600 }}>{selectedIds.length === 1 ? "1 line selected" : `${selectedIds.length} lines selected`}</span>
            {actions.map(({ action, label }) => (
              <button key={action} type="button" disabled={busy} onClick={() => apply(action, selectedIds)} title={ACTION_TITLES[action]} style={{ ...toolbarButtonStyle, color: action === "discard" ? "#f87171" : "var(--accent)" }}>{label}</button>
            ))}
            <button type="button" onClick={() => setSelected(new Set())} style={toolbarButtonStyle}>Clear</button>
          </>
        )}
      </div>
      <div className="file-diff-view" style={{ width: "max-content", minWidth: "100%", ...FILE_CODE_STYLE }}>
        {parsed.hunks.map((hunk, hunkIndex) => {
          const ids = hunkLineIds(hunk);
          return (
            <div key={hunkIndex}>
              <div style={hunkHeaderStyle}>
                <span style={{ position: "sticky", left: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 10px" }}>
                  <span style={{ whiteSpace: "pre" }}>@@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@{hunk.section}</span>
                  {actions.map(({ action, label }) => (
                    <button key={action} type="button" disabled={busy} onClick={() => apply(action, ids)} title={`${ACTION_TITLES[action]} (whole hunk)`} style={{ ...hunkButtonStyle, color: action === "discard" ? "#f87171" : "var(--text-muted)" }}>{label} hunk</button>
                  ))}
                </span>
              </div>
              {hunk.lines.map((line, lineIndex) => (
                <DiffLineRow
                  key={lineIndex}
                  line={line}
                  selected={line.id !== null && selected.has(line.id)}
                  onPress={(shift) => { if (line.id !== null) pressGutter(line.id, shift); }}
                  onEnter={() => { if (line.id !== null) dragTo(line.id); }}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DiffLineRow({ line, selected, onPress, onEnter }: {
  line: PatchLine;
  selected: boolean;
  onPress: (shift: boolean) => void;
  onEnter: () => void;
}) {
  const changed = line.kind !== "context";
  const color = line.kind === "added" ? "#4ade80" : line.kind === "removed" ? "#f87171" : "transparent";
  const background = selected
    ? "rgba(96,165,250,0.22)"
    : line.kind === "added" ? "rgba(0,200,80,0.12)" : line.kind === "removed" ? "rgba(240,60,60,0.14)" : "transparent";
  return (
    <div className="file-diff-line" data-line-kind={line.kind} aria-selected={changed ? selected : undefined} style={{ display: "flex", minWidth: "100%", background, borderLeft: `3px solid ${selected ? "#60a5fa" : color}` }}>
      {changed ? (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`${selected ? "Deselect" : "Select"} ${line.kind} line ${line.kind === "added" ? line.newLineNo : line.oldLineNo}`}
          onMouseDown={(event) => { if (event.button !== 0) return; event.preventDefault(); onPress(event.shiftKey); }}
          onMouseEnter={onEnter}
          // Keyboard activation; mouse presses are handled on mousedown so dragging works.
          onClick={(event) => { if (event.detail === 0) onPress(event.shiftKey); }}
          style={gutterButtonStyle}
        >
          <span style={{ width: 12, height: 12, borderRadius: 3, border: `1px solid ${selected ? "#60a5fa" : "var(--text-dim)"}`, background: selected ? "#60a5fa" : "transparent", display: "inline-block" }} />
        </button>
      ) : <span style={{ ...gutterButtonStyle, cursor: "default" }} />}
      <span style={lineNumberStyle}>{line.oldLineNo ?? ""}</span>
      <span style={lineNumberStyle}>{line.newLineNo ?? ""}</span>
      <span style={{ minWidth: 16, padding: "0 6px", color: changed ? color : "var(--text-dim)", userSelect: "none", flexShrink: 0, fontWeight: 600 }}>
        {line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}
      </span>
      <span className="file-diff-line-content" style={{ flexShrink: 0, padding: "0 8px 0 0", whiteSpace: "pre", color: "var(--text)" }}>
        {line.text || " "}
      </span>
    </div>
  );
}

const toolbarStyle: React.CSSProperties = { position: "sticky", top: 0, zIndex: 2, display: "flex", alignItems: "center", gap: 8, minHeight: 30, padding: "4px 14px", borderBottom: "1px solid var(--border)", background: "var(--bg)", fontSize: 12 };
const toolbarButtonStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 4, padding: "2px 9px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg-panel)", color: "var(--text-muted)" };
const hunkHeaderStyle: React.CSSProperties = { padding: "3px 0", color: "var(--text-dim)", background: "var(--bg-panel)", fontSize: 11, borderTop: "1px solid var(--border)", borderBottom: "1px solid var(--border)" };
const hunkButtonStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 4, padding: "0 7px", fontSize: 11, cursor: "pointer", background: "var(--bg)", fontFamily: "inherit" };
const gutterButtonStyle: React.CSSProperties = { width: 26, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", border: "none", padding: 0, background: "var(--bg-panel)", cursor: "pointer", userSelect: "none" };
const lineNumberStyle: React.CSSProperties = { ...FILE_LINE_NUMBER_STYLE, width: 40, minWidth: 40, padding: "0 6px" };
