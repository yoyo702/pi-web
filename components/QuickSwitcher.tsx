"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import type { ProjectWorkspace } from "@/lib/project-workspaces";
import { filterSessionsByQuery, getSessionDisplayTitle } from "@/lib/session-list";
import { useDialogEscape } from "./agents/use-dialog-escape";
import { isComposingKeyEvent } from "@/lib/keyboard";

interface QuickSwitcherProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectWorkspace[];
  activeProjectId: string | null;
  onSelectProject: (workspace: ProjectWorkspace) => void;
  tabs: { id: string; label: string }[];
  onSelectTab: (id: string) => void;
  activeCwd: string | null;
  onSelectSession: (session: SessionInfo) => void;
}

type Entry =
  | { kind: "project"; key: string; label: string; workspace: ProjectWorkspace; current: boolean }
  | { kind: "tab"; key: string; label: string; id: string }
  | { kind: "session"; key: string; label: string; session: SessionInfo };

export function QuickSwitcher({ open, onClose, projects, activeProjectId, onSelectProject, tabs, onSelectTab, activeCwd, onSelectSession }: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useDialogEscape(onClose, !open);

  useEffect(() => {
    if (!open) { setQuery(""); setActiveIndex(0); return; }
    // Restore focus to whatever had it before the switcher opened once it closes.
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    let cancelled = false;
    fetch("/api/sessions", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : null))
      .then((data) => { if (!cancelled) setSessions(data?.sessions ?? []); })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => {
      cancelled = true;
      previouslyFocused?.focus();
    };
  }, [open]);

  // Keeps Tab/Shift+Tab cycling inside the dialog instead of escaping to the page behind it.
  const trapTabFocus = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const container = dialogRef.current;
    if (!container) return;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('input, button, [href], [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute("disabled"));
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus();
      }
    } else if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  const entries = useMemo<Entry[]>(() => {
    const needle = query.trim().toLowerCase();
    const matchedProjects = projects
      .filter((workspace) => !needle || workspace.label.toLowerCase().includes(needle) || workspace.cwd.toLowerCase().includes(needle))
      .map((workspace): Entry => ({ kind: "project", key: `project:${workspace.id}`, label: workspace.label, workspace, current: workspace.id === activeProjectId }));
    const matchedTabs = tabs
      .filter((tab) => !needle || tab.label.toLowerCase().includes(needle))
      .map((tab): Entry => ({ kind: "tab", key: `tab:${tab.id}`, label: tab.label, id: tab.id }));
    const scopedSessions = activeCwd ? sessions.filter((session) => session.cwd === activeCwd) : sessions;
    const matchedSessions = filterSessionsByQuery(scopedSessions, query)
      .slice(0, 20)
      .map((session): Entry => ({ kind: "session", key: `session:${session.id}`, label: getSessionDisplayTitle(session), session }));
    return [...matchedProjects, ...matchedTabs, ...matchedSessions];
  }, [projects, tabs, sessions, activeCwd, activeProjectId, query]);

  if (!open) return null;

  const select = (entry: Entry) => {
    onClose();
    if (entry.kind === "project") onSelectProject(entry.workspace);
    else if (entry.kind === "tab") onSelectTab(entry.id);
    else onSelectSession(entry.session);
  };

  return (
    <div role="presentation" style={{ position: "fixed", inset: 0, zIndex: 2000, background: "rgb(0 0 0 / 45%)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "12vh" }} onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={trapTabFocus}
        style={{ width: 480, maxHeight: "60vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 24px 64px rgb(0 0 0 / 45%)", overflow: "hidden" }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((i) => Math.min(i + 1, entries.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
            else if (event.key === "Enter") {
              // Mirrors ChatInput's IME guard: an Enter that commits IME
              // composition must not also select/close the switcher.
              if (isComposingKeyEvent(event)) return;
              event.preventDefault();
              const entry = entries[activeIndex];
              if (entry) select(entry);
            }
          }}
          placeholder="Jump to a project, tab, or session…"
          aria-label="Quick switcher search"
          style={{ padding: "12px 14px", border: "none", borderBottom: "1px solid var(--border)", background: "transparent", color: "var(--text)", font: "14px inherit", outline: "none" }}
        />
        <div role="listbox" aria-label="Quick switcher results" style={{ overflowY: "auto" }}>
          {entries.length === 0 && <div style={{ padding: "14px", color: "var(--text-dim)", fontSize: 12.5 }}>No matches</div>}
          {entries.map((entry, index) => (
            <button
              key={entry.key}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(entry)}
              style={{
                display: "flex", width: "100%", alignItems: "center", gap: 8,
                padding: "8px 14px", border: "none", textAlign: "left",
                background: index === activeIndex ? "var(--bg-selected)" : "transparent",
                color: "var(--text)", cursor: "pointer", font: "13px inherit",
              }}
            >
              <span style={{ fontSize: 10, textTransform: "uppercase", color: "var(--text-dim)", flexShrink: 0, width: 52 }}>{entry.kind}</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.label}</span>
              {entry.kind === "project" && entry.current && <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 10, color: "var(--text-dim)" }}>current</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
