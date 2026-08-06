"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clock3, Eye, EyeOff } from "lucide-react";
import { RECENT_PROJECTS_STORAGE_KEY, parseRecentProjects, type RecentProject } from "@/lib/project-workspaces";

const SHOW_HIDDEN_STORAGE_KEY = "pi-web:directory-picker-show-hidden";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  error?: string;
}

async function loadDirectories(directory: string | undefined, showHidden: boolean): Promise<BrowseResponse> {
  const params = new URLSearchParams();
  if (directory) params.set("path", directory);
  if (!showHidden) params.set("hideHidden", "1");
  const query = params.size > 0 ? `?${params}` : "";
  const response = await fetch(`/api/cwd/browse${query}`);
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, busy = false, error }: Props) {
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const showHiddenRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  const navigateTo = useCallback(async (directory?: string, hiddenFilesVisible = showHiddenRef.current) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadDirectories(directory, hiddenFilesVisible);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
      setActiveIndex(0);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    let hiddenFilesVisible = false;
    try {
      hiddenFilesVisible = localStorage.getItem(SHOW_HIDDEN_STORAGE_KEY) === "true";
      setRecentProjects(parseRecentProjects(localStorage.getItem(RECENT_PROJECTS_STORAGE_KEY)));
    } catch { /* local storage may be unavailable */ }
    showHiddenRef.current = hiddenFilesVisible;
    setShowHidden(hiddenFilesVisible);
    void navigateTo(undefined, hiddenFilesVisible);
  }, [navigateTo]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-directory-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !busy;

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="directory-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Select directory"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
    >
      <div className="directory-picker-panel" style={{ width: 520, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(100dvh - 16px))", maxHeight: "calc(100dvh - 16px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>Select directory</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            title="Close"
            aria-label="Close"
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
          >
            ×
          </button>
        </div>

        <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="directory-picker-back" type="button" onClick={() => parentDirectory && void navigateTo(parentDirectory)} disabled={loading || !parentDirectory} title="Go to parent directory" aria-label="Go to parent directory" style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: parentDirectory ? "pointer" : "default", opacity: parentDirectory ? 1 : 0.45 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <label htmlFor="directory-path" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
            Directory path
          </label>
          <input
            className="directory-picker-path"
            id="directory-path"
            type="text"
            value={pathInput}
            placeholder="/path/to/project or ~/project"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPathInput(event.target.value);
              setLoadError(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" || directories.length === 0) return;
              event.preventDefault();
              setActiveIndex(0);
              listRef.current?.focus();
            }}
            style={{ minWidth: 0, flex: 1, height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <button
            className="directory-picker-action"
            type="submit"
            disabled={loading || !pathInput.trim()}
            title="Go to directory"
            style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || !pathInput.trim() ? "default" : "pointer", opacity: loading || !pathInput.trim() ? 0.6 : 1 }}
          >
            Go
          </button>
          <button
            className="directory-picker-action"
            type="button"
            aria-label={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            aria-pressed={showHidden}
            title={showHidden ? "Hide hidden folders" : "Show hidden folders"}
            disabled={loading}
            onClick={() => {
              const next = !showHidden;
              showHiddenRef.current = next;
              setShowHidden(next);
              try { localStorage.setItem(SHOW_HIDDEN_STORAGE_KEY, String(next)); } catch { /* local storage may be unavailable */ }
              void navigateTo(currentPath || undefined, next);
            }}
            style={{ width: 36, height: 36, padding: 0, display: "grid", placeItems: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: showHidden ? "var(--bg-selected)" : "var(--bg-hover)", color: showHidden ? "var(--accent)" : "var(--text-muted)", cursor: loading ? "default" : "pointer", opacity: loading ? 0.6 : 1 }}
          >
            {showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
        </form>

        <div className="directory-picker-list" ref={listRef} tabIndex={0} role="listbox" aria-label="Directories" aria-activedescendant={directories[activeIndex] ? `directory-option-${activeIndex}` : undefined} onKeyDown={(event) => {
          if (directories.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + directories.length) % directories.length);
          } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            setActiveIndex(event.key === "Home" ? 0 : directories.length - 1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            void navigateTo(directories[activeIndex]?.path);
          }
        }} style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px", outline: "none" }}>
          {recentProjects.length > 0 && <section style={{ margin: "0 0 8px", paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 8px 5px", color: "var(--text-dim)", fontSize: 10, fontWeight: 650, textTransform: "uppercase", letterSpacing: ".04em" }}><Clock3 size={11} />Recent projects</div>
            {recentProjects.slice(0, 5).map((project) => <button key={project.path} type="button" onClick={() => void navigateTo(project.path)} title={project.path} style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontSize: 11 }}><FolderIcon /><span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.label}</span><small style={{ maxWidth: "55%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{project.path}</small></button>)}
          </section>}
          {loading ? (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>Loading directories…</div>
          ) : directories.length > 0 ? (
            directories.map((entry) => (
              <button
                key={entry.path}
                id={`directory-option-${directories.indexOf(entry)}`}
                data-directory-index={directories.indexOf(entry)}
                className="directory-picker-entry"
                type="button"
                role="option"
                aria-selected={directories.indexOf(entry) === activeIndex}
                onMouseEnter={() => setActiveIndex(directories.indexOf(entry))}
                onClick={() => void navigateTo(entry.path)}
                title={entry.path}
                style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: directories.indexOf(entry) === activeIndex ? "var(--bg-selected)" : "none", color: directories.indexOf(entry) === activeIndex ? "var(--text)" : "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
              >
                <FolderIcon />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            ))
          ) : (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>No subdirectories</div>
          )}
          {(loadError || error) && <div style={{ padding: "8px", color: "#dc2626", fontSize: 11 }}>{loadError ?? error}</div>}
        </div>

        <div className="directory-picker-footer" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button className="directory-picker-action" type="button" onClick={onCancel} disabled={busy} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy ? "default" : "pointer", fontSize: 13 }}>Cancel</button>
          <button
            className="directory-picker-action"
            type="button"
            onClick={() => onSelect(currentPath)}
            disabled={!canSelect}
            title={hasUncommittedPath ? "Open this path before selecting it" : "Select current directory"}
            style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}
          >
            {busy ? "Checking…" : "Select this folder"}
          </button>
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
