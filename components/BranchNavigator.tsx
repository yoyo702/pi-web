"use client";

import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import type { SessionEntry, SessionTreeNode } from "@/lib/types";

interface Props {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  /** When true, renders as a compact inline button for embedding in a top bar */
  inline?: boolean;
  /** When inline, use this ref's bounding rect to size/position the dropdown */
  containerRef?: React.RefObject<HTMLElement | null>;
  /** Controlled open state for inline mode */
  open?: boolean;
  /** Called when the button is clicked in inline mode */
  onToggle?: () => void;
  /** Whether a session is currently active (used to show appropriate empty reason) */
  hasSession?: boolean;
  /** When inline, render icon-only (no text label) to save horizontal space */
  compact?: boolean;
}

// Find the visible entry IDs on the path from root to activeLeafId.
function buildActivePath(nodes: SessionTreeNode[], targetId: string | null): Set<string> {
  if (!targetId) return new Set();
  const target = targetId;
  function search(nodes: SessionTreeNode[], path: string[]): string[] | null {
    for (const node of nodes) {
      const next = [...path, node.entry.id];
      if (node.entry.id === target || node.compressedEntryIds?.includes(target) || node.hiddenEntryIds?.includes(target)) {
        return next;
      }
      const found = search(node.children, next);
      if (found) return found;
    }
    return null;
  }
  return new Set(search(nodes, []) ?? []);
}

// Compress a visible linear chain into the first branching/leaf node.
// Server-side compressed IDs also count as skipped nodes.
function compress(node: SessionTreeNode): { node: SessionTreeNode; skipped: number } {
  let current = node;
  let skipped = current.compressedEntryIds?.length ?? 0;
  while (current.children.length === 1) {
    current = current.children[0];
    skipped += 1 + (current.compressedEntryIds?.length ?? 0);
  }
  return { node: current, skipped };
}

function getLabel(entry: SessionEntry): string {
  if (entry.type === "message" && "message" in entry) {
    const msg = entry.message as { role: string; content: unknown };
    const content = msg.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");
    }
    if (text.length > 40) text = text.slice(0, 40) + "…";
    if (text) return text;
    if (msg.role === "assistant") return "[assistant]";
  }
  return entry.type;
}

// Does the tree have any branching at all?
function hasBranch(nodes: SessionTreeNode[]): boolean {
  for (const node of nodes) {
    if (node.children.length > 1) return true;
    if (hasBranch(node.children)) return true;
  }
  return false;
}

// The ids of the rows TreeNodeView actually renders for this subtree (the
// compress()-representative id at each level, recursing into that
// representative's children — mirrors TreeNodeView's own compress() calls),
// plus a map from every id "covered" by a rendered row — its own id, and
// every chain member's compressedEntryIds/hiddenEntryIds walked over while
// compressing — back to that row's rep id. This lets an activeLeafId or a
// stale focusedId that references an id swallowed into a longer compressed
// chain (not just the chain's terminal/rep node) resolve to the row that
// actually renders it.
export function collectVisibleRows(
  nodes: SessionTreeNode[],
  acc: string[] = [],
  repOf: Map<string, string> = new Map()
): { ids: string[]; repOf: Map<string, string> } {
  for (const node of nodes) {
    let current = node;
    const covered: string[] = [];
    const addCovered = (n: SessionTreeNode) => {
      covered.push(n.entry.id);
      if (n.compressedEntryIds) covered.push(...n.compressedEntryIds);
      if (n.hiddenEntryIds) covered.push(...n.hiddenEntryIds);
    };
    addCovered(current);
    while (current.children.length === 1) {
      current = current.children[0];
      addCovered(current);
    }
    const repId = current.entry.id;
    acc.push(repId);
    for (const id of covered) repOf.set(id, repId);
    collectVisibleRows(current.children, acc, repOf);
  }
  return { ids: acc, repOf };
}

interface TreeNodeProps {
  node: SessionTreeNode;
  activePathIds: Set<string>;
  depth: number;
  isLast: boolean;
  parentLines: boolean[]; // whether ancestor at each depth has more siblings after
  onSelect: (id: string) => void;
  focusedId: string;
  onFocusRow: (id: string) => void;
}

function TreeNodeView({ node, activePathIds, depth, isLast, parentLines, onSelect, focusedId, onFocusRow }: TreeNodeProps) {
  const { node: rep, skipped } = compress(node);
  const isActive = activePathIds.has(rep.entry.id);
  const isOnPath = activePathIds.has(node.entry.id) || activePathIds.has(rep.entry.id);
  const label = getLabel(rep.entry);
  const role = rep.entry.type === "message" && "message" in rep.entry
    ? (rep.entry.message as { role: string }).role
    : null;

  return (
    <div>
      {/* This node row */}
      <div
        data-branch-row
        data-entry-id={rep.entry.id}
        role="treeitem"
        aria-selected={isActive}
        tabIndex={focusedId === rep.entry.id ? 0 : -1}
        style={{
          display: "flex",
          alignItems: "center",
          height: 24,
          cursor: "pointer",
        }}
        onClick={() => onSelect(rep.entry.id)}
        onFocus={() => onFocusRow(rep.entry.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onSelect(rep.entry.id);
          }
        }}
      >
        {/* Indent guide lines */}
        {parentLines.map((hasLine, i) => (
          <div key={i} style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
            {hasLine && (
              <div style={{
                position: "absolute",
                left: 7,
                top: 0,
                bottom: 0,
                width: 1,
                background: "var(--border)",
              }} />
            )}
          </div>
        ))}

        {/* Branch connector */}
        <div style={{ width: 16, flexShrink: 0, position: "relative", height: "100%", alignSelf: "stretch" }}>
          {/* vertical line up (to parent) */}
          <div style={{
            position: "absolute",
            left: 7,
            top: 0,
            bottom: isLast ? "50%" : 0,
            width: 1,
            background: "var(--border)",
          }} />
          {/* horizontal line to node */}
          <div style={{
            position: "absolute",
            left: 7,
            top: "50%",
            width: 9,
            height: 1,
            background: "var(--border)",
          }} />
        </div>

        {/* Node dot */}
        <div style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          flexShrink: 0,
          background: isActive ? "var(--accent)" : isOnPath ? "var(--text-muted)" : "var(--border)",
          border: isActive ? "none" : "1px solid var(--text-dim)",
          marginRight: 6,
          transition: "background 0.12s",
        }} />

        {/* Role badge */}
        {role && (
          <span style={{
            fontSize: 9,
            fontFamily: "var(--font-mono)",
            color: role === "user" ? "var(--accent)" : "var(--text-dim)",
            background: role === "user" ? "rgba(37,99,235,0.08)" : "var(--bg-hover)",
            border: `1px solid ${role === "user" ? "rgba(37,99,235,0.2)" : "var(--border)"}`,
            borderRadius: 3,
            padding: "0 4px",
            marginRight: 5,
            flexShrink: 0,
            lineHeight: "16px",
          }}>
            {role === "user" ? "U" : "A"}
          </span>
        )}

        {/* Skipped indicator */}
        {skipped > 0 && (
          <span style={{ fontSize: 10, color: "var(--text-dim)", marginRight: 5, flexShrink: 0 }}>
            +{skipped}
          </span>
        )}

        {/* Label */}
        <span style={{
          fontSize: 11,
          color: isActive ? "var(--text)" : isOnPath ? "var(--text-muted)" : "var(--text-dim)",
          fontWeight: isActive ? 500 : 400,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}>
          {label}
        </span>
      </div>

      {/* Children */}
      {rep.children.map((child, idx) => (
        <TreeNodeView
          key={child.entry.id}
          node={child}
          activePathIds={activePathIds}
          depth={depth + 1}
          isLast={idx === rep.children.length - 1}
          parentLines={[...parentLines, !isLast]}
          onSelect={onSelect}
          focusedId={focusedId}
          onFocusRow={onFocusRow}
        />
      ))}
    </div>
  );
}

export function BranchNavigator({ tree, activeLeafId, onLeafChange, inline, containerRef, open: openProp, onToggle, hasSession, compact }: Props) {
  const [openInternal, setOpenInternal] = useState(false);
  const open = openProp !== undefined ? openProp : openInternal;
  const btnRef = useRef<HTMLButtonElement>(null);
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open || !inline) return;
    const anchor = containerRef?.current ?? btnRef.current;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setDropdownPos({ top: rect.bottom, left: rect.left, width: rect.width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchor);
    return () => ro.disconnect();
  }, [open, inline, containerRef]);

  useEffect(() => {
    if (!open || !inline) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (onToggle) onToggle(); else setOpenInternal(false);
      btnRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, inline, onToggle]);

  const activePathIds = useMemo(
    () => buildActivePath(tree, activeLeafId),
    [tree, activeLeafId]
  );

  const handleSelect = useCallback((id: string) => {
    onLeafChange(id);
  }, [onLeafChange]);

  const noBranchReason = !hasSession
    ? "No active session"
    : !hasBranch(tree)
      ? "This session has no branches"
      : null;

  // Find first meaningful node (skip pure linear prefix)
  const compressed = tree.length > 0 ? compress(tree[0]) : null;
  const firstNode = compressed?.node ?? null;
  const hasContent = !noBranchReason && firstNode && firstNode.children.length > 1;

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const handleFocusRow = useCallback((id: string) => setFocusedId(id), []);

  // The rows TreeNodeView actually renders right now. As the tree grows,
  // focusedId may reference a compress()-representative id that no longer
  // renders (it got swallowed into a longer compressed chain) — validate
  // against this set each render rather than resetting focusedId whenever
  // the tree changes.
  const { ids: visibleRowIds, repOf } = useMemo(
    () => (firstNode ? collectVisibleRows(firstNode.children) : { ids: [], repOf: new Map<string, string>() }),
    [firstNode]
  );
  const effectiveFocusedId = useMemo(() => {
    if (focusedId) {
      const rep = repOf.get(focusedId);
      if (rep) return rep;
    }
    if (activeLeafId) {
      // activeLeafId may itself be an id swallowed into a longer compressed
      // chain (compress()'d away, or folded into a node's
      // compressedEntryIds/hiddenEntryIds) rather than a rendered rep id —
      // resolve it to the row that actually renders it.
      const rep = repOf.get(activeLeafId);
      if (rep) return rep;
    }
    // Extra-safety fallback if activeLeafId doesn't resolve at all (e.g. a
    // stale/detached id): use the deepest visible row still on the active
    // path, rather than jumping to the unrelated first row. visibleRowIds is
    // produced in pre-order, so the active path's ids appear in increasing
    // depth order — the last match is the deepest.
    for (let i = visibleRowIds.length - 1; i >= 0; i--) {
      if (activePathIds.has(visibleRowIds[i])) return visibleRowIds[i];
    }
    return visibleRowIds[0] ?? "";
  }, [focusedId, activeLeafId, visibleRowIds, repOf, activePathIds]);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    if (!(event.target instanceof Element)) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-branch-row]"));
    if (rows.length === 0) return;
    event.preventDefault();

    if (event.key === "Home") {
      rows[0]?.focus();
      return;
    }
    if (event.key === "End") {
      rows[rows.length - 1]?.focus();
      return;
    }

    const row = event.target.closest<HTMLElement>("[data-branch-row]");
    const index = row ? rows.indexOf(row) : -1;
    // When focus isn't currently in a row, ArrowDown starts at the first row
    // and ArrowUp wraps to the last row, rather than both landing on the first.
    const nextIndex = index === -1
      ? (event.key === "ArrowDown" ? 0 : rows.length - 1)
      : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    rows[nextIndex]?.focus();
  }, []);

  const branchIcon = (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: hasContent ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );

  const chevron = (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" style={{ marginLeft: 2, transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}>
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );


  if (inline) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "stretch" }}>
        <button
          type="button"
          ref={btnRef}
          onClick={() => onToggle ? onToggle() : setOpenInternal((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            height: "100%",
            padding: "0 12px",
            background: open ? "var(--bg-selected)" : "none",
            border: "none",
            borderTop: open ? "2px solid var(--accent)" : "2px solid transparent",
            borderRight: "1px solid var(--border)",
            cursor: "pointer",
            color: open ? "var(--text)" : "var(--text-muted)",
            fontSize: 11,
            whiteSpace: "nowrap",
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = open ? "var(--text)" : "var(--text-muted)"; }}
          title="Branches"
          aria-label="Branches"
          aria-expanded={open}
        >
          {branchIcon}
          {!compact && <span>Branches</span>}
        </button>
        {open && dropdownPos && (
          <div style={{
            position: "fixed",
            top: dropdownPos.top,
            left: dropdownPos.left,
            width: dropdownPos.width,
            background: "var(--bg-panel)",
            borderBottom: "1px solid var(--border)",
            zIndex: 500,
          }}>
            {hasContent && firstNode ? (
              <div
                role="tree"
                aria-label="Branches"
                onKeyDown={handleTreeKeyDown}
                style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}
              >
                {firstNode.children.map((child, idx) => (
                  <TreeNodeView
                    key={child.entry.id}
                    node={child}
                    activePathIds={activePathIds}
                    depth={0}
                    isLast={idx === firstNode.children.length - 1}
                    parentLines={[]}
                    onSelect={handleSelect}
                    focusedId={effectiveFocusedId}
                    onFocusRow={handleFocusRow}
                  />
                ))}
              </div>
            ) : (
              <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                {noBranchReason}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--bg)", flexShrink: 0, position: "relative" }}>
      {/* Header toggle */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpenInternal((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "5px 12px",
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--text-muted)",
          fontSize: 11,
          textAlign: "left",
        }}
      >
        {branchIcon}
        <span style={{ color: "var(--text-muted)" }}>Branches</span>
        {chevron}
      </button>

      {/* Tree panel - overlay */}
      {open && (
        <div style={{
          position: "absolute",
          top: "100%",
          left: 0,
          right: 0,
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
          zIndex: 100,
        }}>
          {hasContent && firstNode ? (
            <div
              role="tree"
              aria-label="Branches"
              onKeyDown={handleTreeKeyDown}
              style={{ padding: "4px 12px 8px 12px", maxHeight: 260, overflowY: "auto" }}
            >
              {firstNode.children.map((child, idx) => (
                <TreeNodeView
                  key={child.entry.id}
                  node={child}
                  activePathIds={activePathIds}
                  depth={0}
                  isLast={idx === firstNode.children.length - 1}
                  parentLines={[]}
                  onSelect={handleSelect}
                  focusedId={effectiveFocusedId}
                  onFocusRow={handleFocusRow}
                />
              ))}
            </div>
          ) : (
            <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
              {noBranchReason ?? "This session has no branches"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
