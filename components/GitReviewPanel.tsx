"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  GitBranch,
  GitBranchesResponse,
  GitCommitDetail,
  GitCommitFile,
  GitCommitSummary,
  GitDiffScope,
  GitFileDiffResponse,
  GitFileStatus,
  GitFileStatusKind,
  GitLogResponse,
  GitStatusResponse,
  GitStashEntry,
} from "@/lib/git-types";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import { DiffView } from "./FileViewer";

type PanelTab = "changes" | "branch" | "history";

type ChangeGroup = "staged" | "unstaged" | "untracked";

type SelectedChange = {
  file: GitFileStatus;
  scope: GitDiffScope;
};

const TABS: Array<{ key: PanelTab; label: string }> = [
  { key: "changes", label: "Changes" },
  { key: "branch", label: "Branch" },
  { key: "history", label: "History" },
];

const GROUPS: Array<{ key: ChangeGroup; label: string; scope: GitDiffScope }> = [
  { key: "staged", label: "Staged", scope: "staged" },
  { key: "unstaged", label: "Changes", scope: "unstaged" },
  { key: "untracked", label: "Untracked", scope: "untracked" },
];

const STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

const KIND_LETTER: Record<GitFileStatusKind, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflict: "U",
};

function belongsToGroup(file: GitFileStatus, group: ChangeGroup): boolean {
  if (group === "untracked") return file.indexStatus === "?" && file.worktreeStatus === "?";
  if (group === "staged") return file.indexStatus !== " " && file.indexStatus !== "?";
  return file.worktreeStatus !== " " && file.worktreeStatus !== "?";
}

function statusLetter(file: GitFileStatus, scope: GitDiffScope): string {
  if (scope === "staged") return file.indexStatus;
  if (scope === "unstaged") return file.worktreeStatus;
  return "?";
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function formatRelative(iso: string): string {
  const date = new Date(iso);
  const ms = Date.now() - date.getTime();
  if (Number.isNaN(ms)) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return date.toLocaleDateString();
}

// A draggable split: tracks one pane's size (px) with min/max clamping and
// localStorage persistence. axis "x" resizes width (col-resize), "y" height.
function useSplit(storageKey: string, defaultSize: number, min: number, max: number, axis: "x" | "y" = "x") {
  const [size, setSize] = useState(defaultSize);
  const sizeRef = useRef(defaultSize);
  sizeRef.current = size;
  useEffect(() => {
    const v = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(v) && v > 0) setSize(Math.min(max, Math.max(min, v)));
  }, [storageKey, min, max]);
  const onDragStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const origin = axis === "x" ? event.clientX : event.clientY;
    const startSize = sizeRef.current;
    let latest = startSize;
    const onMove = (ev: MouseEvent) => {
      const pos = axis === "x" ? ev.clientX : ev.clientY;
      latest = Math.min(max, Math.max(min, startSize + (pos - origin)));
      setSize(latest);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try { localStorage.setItem(storageKey, String(Math.round(latest))); } catch {}
    };
    document.body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [storageKey, min, max, axis]);
  return { size, onDragStart };
}

export function GitReviewPanel({ cwd, refreshKey = 0, onRepoChanged }: { cwd: string | null; refreshKey?: number; onRepoChanged?: () => void }) {
  const [tab, setTab] = useState<PanelTab>("changes");
  const changesSplit = useSplit("pi-git-changes-split", 240, 150, 520);
  const [nonce, setNonce] = useState(0);
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [selected, setSelected] = useState<SelectedChange | null>(null);
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [generatingCommitMessage, setGeneratingCommitMessage] = useState(false);
  const [generationNotice, setGenerationNotice] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");

  const loadStatus = useCallback(async () => {
    if (!cwd) {
      setStatus(null);
      setSelected(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/git/status?${new URLSearchParams({ cwd })}`);
      const next = await res.json() as GitStatusResponse & { error?: string };
      if (!res.ok) throw new Error(next.error ?? `Failed to load Git status (${res.status})`);
      setStatus(next);
      setSelected((current) => current && next.files.some((file) => file.filePath === current.file.filePath)
        ? current
        : null);
    } catch (cause) {
      setStatus(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { void loadStatus(); }, [loadStatus, refreshKey, nonce]);

  useEffect(() => {
    if (!cwd || !selected) {
      setDiff(null);
      return;
    }
    const controller = new AbortController();
    setLoadingDiff(true);
    setDiff(null);
    const params = new URLSearchParams({ cwd, path: selected.file.filePath, scope: selected.scope });
    void fetch(`/api/git/diff?${params}`, { signal: controller.signal })
      .then(async (res) => {
        const next = await res.json() as GitFileDiffResponse & { error?: string };
        if (!res.ok) throw new Error(next.error ?? `Failed to load diff (${res.status})`);
        setDiff(next);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setDiff({ supported: false });
      })
      .finally(() => { if (!controller.signal.aborted) setLoadingDiff(false); });
    return () => controller.abort();
  }, [cwd, selected]);

  const grouped = useMemo(() => new Map(GROUPS.map((group) => [
    group.key,
    status?.files.filter((file) => belongsToGroup(file, group.key)) ?? [],
  ])), [status]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const runWrite = useCallback(async (url: string, payload: Record<string, unknown>) => {
    if (!cwd) return false;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...payload }),
      });
      const next = await res.json() as GitStatusResponse & { error?: string };
      if (!res.ok) throw new Error(next.error ?? `Action failed (${res.status})`);
      setStatus(next);
      setSelected((current) => current && next.files.some((file) => file.filePath === current.file.filePath)
        ? current
        : null);
      onRepoChanged?.();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, [cwd, onRepoChanged]);

  const stage = useCallback((paths: string[]) => { if (paths.length) void runWrite("/api/git/stage", { paths }); }, [runWrite]);
  const unstage = useCallback((paths: string[]) => { if (paths.length) void runWrite("/api/git/unstage", { paths }); }, [runWrite]);
  const discard = useCallback((paths: string[]) => {
    if (!paths.length) return;
    const label = paths.length === 1 ? "this file" : `${paths.length} files`;
    if (window.confirm(`Discard changes to ${label}? This cannot be undone.`)) {
      void runWrite("/api/git/discard", { paths });
    }
  }, [runWrite]);
  const commit = useCallback(async () => {
    const message = commitMessage.trim();
    if (!message) return;
    if (await runWrite("/api/git/commit", { message })) {
      setCommitMessage("");
      setGenerationNotice(null);
    }
  }, [commitMessage, runWrite]);
  const generateCommitMessage = useCallback(async () => {
    if (!cwd || generatingCommitMessage) return;
    setGeneratingCommitMessage(true);
    setActionError(null);
    setGenerationNotice(null);
    try {
      const res = await fetch("/api/git/commit-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const next = await res.json() as { error?: string; message?: string; provider?: string; modelId?: string; truncated?: boolean };
      if (!res.ok || !next.message) throw new Error(next.error ?? `Could not generate a commit message (${res.status})`);
      setCommitMessage(next.message);
      setGenerationNotice(`Generated with ${next.provider}/${next.modelId}${next.truncated ? " from a truncated diff" : ""}. Review or edit it before committing.`);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setGeneratingCommitMessage(false);
    }
  }, [cwd, generatingCommitMessage]);
  const syncRemote = useCallback(async (action: "fetch" | "pull" | "push" | "publish") => {
    if (action !== "fetch" && action !== "publish" && !status?.upstream) return;
    const target = status?.upstream ?? "the default remote";
    if (action === "pull" && !window.confirm(
      `Pull ${target} into ${status?.branch ?? "the current branch"}?\n\n` +
      "Only fast-forward updates are allowed. The operation will stop rather than create a merge commit or rebase.",
    )) return;
    if (action === "push" && !window.confirm(
      `Push ${status?.branch ?? "the current branch"} to ${target}?`,
    )) return;
    if (action === "publish" && !window.confirm(
      `Publish ${status?.branch ?? "the current branch"} to the default remote and set its upstream?\n\n` +
      "This creates or updates the remote branch, but never force-pushes.",
    )) return;
    if (await runWrite("/api/git/sync", { action })) refresh();
  }, [refresh, runWrite, status]);
  if (!cwd) {
    return <EmptyState title="No workspace selected" detail="Select a project to review its Git changes." />;
  }

  const repoRoot = status?.repositoryRoot ?? cwd;
  const showAheadBehind = status?.upstream != null;
  const canPublish = Boolean(status?.branch && !status.upstream && (status.remotes?.length ?? 0) > 0);

  return (
    <div style={{ height: "100%", minWidth: 0, display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "14px 16px 0", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ fontWeight: 650, fontSize: 14 }}>Git Review</div>
          <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <button type="button" onClick={() => void syncRemote("fetch")} disabled={busy} title="Fetch remote updates and prune deleted remote branches" style={{ ...syncButtonStyle, opacity: busy ? 0.5 : 1 }}>Fetch</button>
            <button
              type="button"
              onClick={() => void syncRemote("pull")}
              disabled={busy || !showAheadBehind || (status?.files.length ?? 0) > 0}
              title={!showAheadBehind ? "Current branch has no upstream" : (status?.files.length ? "Commit, stash, or discard local changes before pulling" : "Pull using fast-forward only")}
              style={{ ...syncButtonStyle, opacity: busy || !showAheadBehind || (status?.files.length ?? 0) > 0 ? 0.5 : 1 }}
            >↓ Pull</button>
            <button
              type="button"
              onClick={() => void syncRemote(canPublish ? "publish" : "push")}
              disabled={busy || (!showAheadBehind && !canPublish)}
              title={canPublish
                ? `Publish ${status?.branch} to the default remote and set its upstream`
                : (!showAheadBehind ? "Current branch has no upstream or configured remote" : "Push current branch to its upstream")}
              style={{ ...syncButtonStyle, opacity: busy || (!showAheadBehind && !canPublish) ? 0.5 : 1 }}
            >{canPublish ? "↑ Publish" : "↑ Push"}</button>
            <button type="button" onClick={refresh} disabled={loading || busy} title={loading ? "Refreshing…" : "Refresh local Git status"} aria-label="Refresh" style={{ ...iconButtonStyle, opacity: loading || busy ? 0.5 : 1 }}>↻</button>
          </div>
        </div>
        <div title={repoRoot} style={{ marginTop: 4, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {repoRoot}
        </div>
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <Badge label={status?.branch ?? "Detached HEAD"} />
          {showAheadBehind && <Badge label={`↔ ${status?.upstream}`} title="Tracked remote branch" />}
          {showAheadBehind && <Badge label={`↑ ${status?.ahead ?? 0}`} title={`${status?.ahead ?? 0} ahead of ${status?.upstream}`} />}
          {showAheadBehind && <Badge label={`↓ ${status?.behind ?? 0}`} title={`${status?.behind ?? 0} behind ${status?.upstream}`} />}
          {GROUPS.map((group) => <Badge key={group.key} label={`${group.label} ${grouped.get(group.key)?.length ?? 0}`} />)}
          {actionError && <span role="alert" style={{ color: STATUS_COLORS.deleted, fontSize: 11, overflowWrap: "anywhere" }}>{actionError}</span>}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 4 }}>
          {TABS.map((entry) => {
            const active = tab === entry.key;
            return (
              <button
                key={entry.key}
                type="button"
                onClick={() => setTab(entry.key)}
                title={{ changes: "Review and stage working-tree changes", branch: "Create, switch, or delete branches", history: "Browse commit history and diffs" }[entry.key]}
                aria-pressed={active}
                style={{
                  border: "none",
                  background: "transparent",
                  color: active ? "var(--text)" : "var(--text-muted)",
                  fontSize: 12,
                  fontWeight: active ? 650 : 500,
                  padding: "6px 10px",
                  cursor: "pointer",
                  borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
                }}
              >
                {entry.label}
              </button>
            );
          })}
        </div>
      </header>

      {error ? (
        <EmptyState title="Unable to load Git status" detail={error} action={refresh} />
      ) : status && !status.isGitRepository ? (
        <EmptyState title="This folder is not a Git repository" detail={cwd} />
      ) : tab === "history" ? (
        <HistoryView cwd={cwd} refreshToken={refreshKey + nonce} />
      ) : tab === "branch" ? (
        <BranchView cwd={cwd} refreshToken={refreshKey + nonce} onChanged={refresh} hasUncommittedChanges={(status?.files.length ?? 0) > 0} />
      ) : !status ? (
        <EmptyState title="Loading Git changes…" />
      ) : (
        <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
          <div style={{ minHeight: 0, flex: 1, display: "flex" }}>
            <aside style={{ width: changesSplit.size, flexShrink: 0, overflow: "auto", borderRight: "1px solid var(--border)", padding: "8px 6px" }}>
              {GROUPS.map((group) => {
                const files = grouped.get(group.key) ?? [];
                if (files.length === 0) return null;
                const paths = files.map((file) => file.filePath);
                const staged = group.key === "staged";
                return (
                  <section key={group.key} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 8px" }}>
                      <span style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>
                        {group.label} <span style={{ color: "var(--text-dim)" }}>{files.length}</span>
                      </span>
                      <span style={{ display: "flex", gap: 2 }}>
                        {staged ? (
                          <button type="button" onClick={() => unstage(paths)} disabled={busy} title="Unstage every file in this group" style={writeButtonStyle}>−</button>
                        ) : (
                          <>
                            <button type="button" onClick={() => stage(paths)} disabled={busy} title="Stage every file in this group for the next commit" style={writeButtonStyle}>+</button>
                            <button type="button" onClick={() => discard(paths)} disabled={busy} title="Discard every file in this group — cannot be undone" style={writeButtonStyle}>⨯</button>
                          </>
                        )}
                      </span>
                    </div>
                    {files.map((file) => {
                      const isSelected = selected?.file.filePath === file.filePath && selected.scope === group.scope;
                      return (
                        <div key={`${group.key}:${file.filePath}`} style={{ display: "flex", alignItems: "center", borderRadius: 4, background: isSelected ? "var(--bg-selected)" : "transparent", minWidth: 0 }}>
                          <button type="button" onClick={() => setSelected({ file, scope: group.scope })} title={`View diff: ${file.filePath}`} style={{ ...fileButtonStyle, background: "transparent", flex: 1 }}>
                            <span style={{ width: 14, flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 700, color: STATUS_COLORS[file.status] }}>{statusLetter(file, group.scope)}</span>
                            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getRelativeFilePath(file.filePath, repoRoot)}</span>
                          </button>
                          <span style={{ display: "flex", gap: 2, flexShrink: 0, paddingRight: 4 }}>
                            {staged ? (
                              <button type="button" onClick={() => unstage([file.filePath])} disabled={busy} title="Remove this file from the next commit" style={writeButtonStyle}>−</button>
                            ) : (
                              <>
                                <button type="button" onClick={() => stage([file.filePath])} disabled={busy} title="Add this file to the next commit" style={writeButtonStyle}>+</button>
                                <button type="button" onClick={() => discard([file.filePath])} disabled={busy} title="Discard this file's changes — cannot be undone" style={writeButtonStyle}>⨯</button>
                              </>
                            )}
                          </span>
                        </div>
                      );
                    })}
                  </section>
                );
              })}
              {status.files.length === 0 && <div style={{ padding: 14, color: "var(--text-dim)", fontSize: 12 }}>Working tree clean</div>}
            </aside>
            <div className="resize-handle" onMouseDown={changesSplit.onDragStart} role="separator" aria-orientation="vertical" title="Drag to resize" />
            <main style={{ minWidth: 0, flex: 1, overflow: "auto" }}>
              {!selected ? (
                <EmptyState title={status.files.length ? "Select a changed file" : "No uncommitted changes"} detail={status.files.length ? "Choose a file from the change list to inspect its diff." : "Changes made by you or the agent will appear here."} />
              ) : loadingDiff ? (
                <EmptyState title="Loading diff…" />
              ) : diff?.supported && diff.patch ? (
                <div>
                  <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)" }}>
                    {getFileName(selected.file.filePath)}
                  </div>
                  <DiffView patch={diff.patch} />
                </div>
              ) : (
                <EmptyState title="Diff unavailable" detail="This file may be binary, too large, or unchanged in this review group." />
              )}
            </main>
          </div>
          <div style={{ flexShrink: 0, borderTop: "1px solid var(--border)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            <textarea
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void commit(); }}
              placeholder="Commit message (⌘/Ctrl+Enter)"
              rows={2}
              style={{ width: "100%", resize: "vertical", boxSizing: "border-box", padding: "6px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
            {generationNotice && <div style={{ color: "var(--text-dim)", fontSize: 11 }}>{generationNotice}</div>}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{grouped.get("staged")?.length ?? 0} staged</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <button
                  type="button"
                  onClick={() => void generateCommitMessage()}
                  disabled={busy || generatingCommitMessage || (grouped.get("staged")?.length ?? 0) === 0}
                  title="Use the configured default Pi model to draft a commit message from staged changes. You can edit it before committing."
                  aria-busy={generatingCommitMessage}
                  style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "5px 9px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg-panel)", color: "var(--text-muted)", opacity: busy || generatingCommitMessage || (grouped.get("staged")?.length ?? 0) === 0 ? 0.5 : 1 }}
                >
                  {generatingCommitMessage ? "Generating…" : "✨ Generate"}
                </button>
                <button
                  type="button"
                  onClick={() => void commit()}
                  title="Create a commit from all staged changes"
                  disabled={busy || generatingCommitMessage || !commitMessage.trim() || (grouped.get("staged")?.length ?? 0) === 0}
                  style={{ border: "1px solid var(--border)", borderRadius: 4, padding: "5px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "var(--bg-panel)", color: "var(--accent)", opacity: busy || generatingCommitMessage || !commitMessage.trim() || (grouped.get("staged")?.length ?? 0) === 0 ? 0.5 : 1 }}
                >
                  Commit
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BranchView({ cwd, refreshToken, onChanged, hasUncommittedChanges }: { cwd: string; refreshToken: number; onChanged: () => void; hasUncommittedChanges: boolean }) {
  const [data, setData] = useState<GitBranchesResponse | null>(null);
  const [, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showRemotes, setShowRemotes] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/git/branches?${new URLSearchParams({ cwd })}`);
      const next = await res.json() as GitBranchesResponse & { error?: string };
      if (!res.ok) throw new Error(next.error ?? `Failed to load branches (${res.status})`);
      setData(next);
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const mutate = useCallback(async (payload: Record<string, unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch("/api/git/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, ...payload }),
      });
      const next = await res.json() as GitBranchesResponse & { error?: string };
      if (!res.ok) throw new Error(next.error ?? `Action failed (${res.status})`);
      setData(next);
      onChanged();
      return true;
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, [cwd, onChanged]);

  const submitCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    if (await mutate({ action: "create", name })) {
      setNewName("");
      setCreating(false);
    }
  }, [newName, mutate]);

  const checkout = useCallback((name: string) => {
    const warning = hasUncommittedChanges
      ? "You have uncommitted changes.\n\nSwitching branches will carry them into the target branch, or fail if they conflict. Consider committing, stashing, or discarding them first.\n\n"
      : "Your working tree is clean.\n\n";
    if (!window.confirm(`${warning}Switch to "${name}"?`)) return;
    void mutate({ action: "checkout", name });
  }, [hasUncommittedChanges, mutate]);

  if (error) return <EmptyState title="Unable to load branches" detail={error} action={load} />;
  if (!data) return <EmptyState title="Loading branches…" />;
  if (!data.isGitRepository) return <EmptyState title="Not a Git repository" />;

  return (
    <div style={{ minHeight: 0, flex: 1, overflow: "auto", padding: "8px 6px" }}>
      {actionError && (
        <div style={{ margin: "0 6px 8px", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 4, color: STATUS_COLORS.deleted, fontSize: 11, overflowWrap: "anywhere" }}>{actionError}</div>
      )}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 8px 6px" }}>
        <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>
          Local <span style={{ color: "var(--text-dim)" }}>{data.local.length}</span>
        </div>
        <button type="button" onClick={() => { setCreating((value) => !value); setActionError(null); }} disabled={busy} title="Create a new local branch" style={{ ...iconButtonStyle, width: "auto", padding: "2px 8px", fontSize: 12 }}>+ New</button>
      </div>
      {creating && (
        <div style={{ display: "flex", gap: 6, padding: "0 8px 8px" }}>
          <input
            autoFocus
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submitCreate(); if (event.key === "Escape") setCreating(false); }}
            placeholder="new-branch-name"
            style={{ flex: 1, minWidth: 0, padding: "5px 8px", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <button type="button" onClick={() => void submitCreate()} disabled={busy || !newName.trim()} title="Create the branch with this name" style={{ ...iconButtonStyle, width: "auto", padding: "2px 10px", fontSize: 12, color: "var(--accent)" }}>Create</button>
        </div>
      )}
      {data.local.map((branch) => (
        <BranchRow
          key={branch.name}
          branch={branch}
          busy={busy}
          onCheckout={() => checkout(branch.name)}
          onDelete={() => {
            if (window.confirm(`Delete branch "${branch.name}"?`)) {
              void mutate({ action: "delete", name: branch.name }).then((ok) => {
                if (!ok && window.confirm(`"${branch.name}" is not fully merged. Force delete?`)) {
                  void mutate({ action: "delete", name: branch.name, force: true });
                }
              });
            }
          }}
        />
      ))}

      {data.remotes.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button type="button" onClick={() => setShowRemotes((value) => !value)} title={showRemotes ? "Hide remote branches" : "Show remote branches"} style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, border: "none", background: "transparent", cursor: "pointer", padding: "5px 8px", color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>
            <span style={{ fontSize: 10 }}>{showRemotes ? "▾" : "▸"}</span>
            Remote <span style={{ color: "var(--text-dim)" }}>{data.remotes.length}</span>
          </button>
          {showRemotes && data.remotes.map((branch) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              busy={busy}
              onCheckout={() => checkout(branch.name.replace(/^[^/]+\//, ""))}
            />
          ))}
        </div>
      )}
      <StashView cwd={cwd} refreshToken={refreshToken} onChanged={onChanged} hasUncommittedChanges={hasUncommittedChanges} />
    </div>
  );
}
function StashView({ cwd, refreshToken, onChanged, hasUncommittedChanges }: { cwd: string; refreshToken: number; onChanged: () => void; hasUncommittedChanges: boolean }) {
  const [stashes, setStashes] = useState<GitStashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/git/stash?${new URLSearchParams({ cwd })}`);
      const next = await res.json() as { stashes?: GitStashEntry[]; error?: string };
      if (!res.ok) throw new Error(next.error ?? `Failed to load stashes (${res.status})`);
      setStashes(next.stashes ?? []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);
  useEffect(() => { void load(); }, [load, refreshToken]);
  const mutate = useCallback(async (action: "save" | "apply" | "pop" | "drop", index?: number, message?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/git/stash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, action, index, message }),
      });
      const next = await res.json() as { error?: string };
      if (!res.ok) throw new Error(next.error ?? `Stash action failed (${res.status})`);
      await load();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      // A conflict can leave partial worktree changes even though Git returns an error.
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [cwd, load, onChanged]);
  const save = useCallback(() => {
    const message = window.prompt("Optional stash message (leave blank for Git's default):");
    if (message === null) return;
    void mutate("save", undefined, message);
  }, [mutate]);
  return (
    <section style={{ marginTop: 14, borderTop: "1px solid var(--border)", padding: "10px 8px 0" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em" }}>
          Stashes <span style={{ color: "var(--text-dim)" }}>{stashes.length}</span>
        </div>
        <button type="button" onClick={save} disabled={busy || !hasUncommittedChanges} title={hasUncommittedChanges ? "Save tracked, staged, and untracked changes, then clean the worktree" : "No local changes to stash"} style={{ ...iconButtonStyle, width: "auto", padding: "2px 8px", fontSize: 12, opacity: busy || !hasUncommittedChanges ? 0.5 : 1 }}>Stash changes</button>
      </div>
      {error && <div role="alert" style={{ marginTop: 6, color: STATUS_COLORS.deleted, fontSize: 11, overflowWrap: "anywhere" }}>{error}</div>}
      {loading ? <div style={{ padding: "8px 0", color: "var(--text-dim)", fontSize: 11 }}>Loading stashes…</div> : stashes.length === 0 ? (
        <div style={{ padding: "8px 0", color: "var(--text-dim)", fontSize: 11 }}>No saved stashes</div>
      ) : stashes.map((stash) => (
        <div key={stash.ref} style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 0", borderBottom: "1px solid var(--border)", minWidth: 0 }}>
          <div title={stash.message} style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{stash.ref}: {stash.message}</div>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Apply ${stash.ref}? The stash will be kept.`)) void mutate("apply", stash.index); }} title="Apply this stash to the worktree but keep the saved stash" style={stashButtonStyle}>Apply</button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Pop ${stash.ref}? This applies it and then removes the saved stash.`)) void mutate("pop", stash.index); }} title="Apply this stash and remove it if Git succeeds" style={stashButtonStyle}>Pop</button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Drop ${stash.ref}? This permanently deletes the saved stash.`)) void mutate("drop", stash.index); }} title="Permanently delete this saved stash" style={{ ...stashButtonStyle, color: STATUS_COLORS.deleted }}>Drop</button>
        </div>
      ))}
    </section>
  );
}

function BranchRow({ branch, busy, onCheckout, onDelete }: {
  branch: GitBranch;
  busy: boolean;
  onCheckout: () => void;
  onDelete?: () => void;
}) {
  const tracking = [
    branch.ahead ? `↑${branch.ahead}` : null,
    branch.behind ? `↓${branch.behind}` : null,
  ].filter(Boolean).join(" ");
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: 4, padding: "4px 8px", background: branch.current ? "var(--bg-selected)" : "transparent", minWidth: 0 }}>
      <span style={{ width: 10, flexShrink: 0, color: "var(--accent)", fontWeight: 700 }}>{branch.current ? "✔" : ""}</span>
      <button
        type="button"
        onClick={onCheckout}
        disabled={busy || branch.current}
        title={branch.current ? `Current branch: ${branch.name}` : `Switch to ${branch.name}${branch.upstream ? ` (tracks ${branch.upstream})` : ""}`}
        style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, border: "none", background: "transparent", cursor: busy || branch.current ? "default" : "pointer", padding: 0, textAlign: "left", color: "var(--text)" }}
      >
        <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, fontFamily: "var(--font-mono)" }}>{branch.name}</span>
        {branch.subject && <span style={{ maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10.5, color: "var(--text-dim)" }}>{branch.subject}</span>}
      </button>
      {tracking && <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-muted)" }}>{tracking}</span>}
      {onDelete && !branch.current && (
        <button type="button" onClick={onDelete} disabled={busy} title={`Delete local branch ${branch.name} (confirmation required)`} style={{ ...iconButtonStyle, width: 20, height: 20, fontSize: 13, flexShrink: 0 }}>⨯</button>
      )}
    </div>
  );
}

// --- Commit graph (railroad) rendering ---------------------------------------
// Lightweight lane-assignment + SVG renderer, in place of a heavy dependency
// like @gitgraph/react, so it follows the theme and the existing list.
const LANE_COLORS = ["#4ea1ff", "#4ade80", "#d6a84b", "#c678dd", "#f472b6", "#2dd4bf", "#f87171", "#a3e635"];
const laneColor = (col: number) => LANE_COLORS[((col % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length];
const GRAPH_COL_W = 14;
const GRAPH_ROW_H = 46;

interface GraphSeg { c1: number; t1: number; c2: number; t2: number; color: string }
interface GraphRow { nodeCol: number; nodeColor: string; isMerge: boolean; segs: GraphSeg[] }

function computeCommitGraph(commits: GitCommitSummary[]): { rows: GraphRow[]; width: number } {
  const lanes: (string | null)[] = []; // per column: hash the lane is heading toward
  const colors: string[] = [];
  const rows: GraphRow[] = [];
  let width = 1;
  const takeFreeCol = () => {
    const i = lanes.indexOf(null);
    if (i !== -1) return i;
    lanes.push(null);
    colors.push("");
    return lanes.length - 1;
  };
  for (const commit of commits) {
    const incoming = lanes.slice();
    const incomingColors = colors.slice();
    const matching: number[] = [];
    incoming.forEach((h, i) => { if (h === commit.hash) matching.push(i); });

    let nodeCol: number;
    if (matching.length > 0) {
      nodeCol = matching[0];
    } else {
      nodeCol = takeFreeCol();
      colors[nodeCol] = laneColor(nodeCol);
    }
    const nodeColor = colors[nodeCol] || laneColor(nodeCol);
    colors[nodeCol] = nodeColor;

    const segs: GraphSeg[] = [];
    // Lanes routing to other commits pass straight through this row.
    incoming.forEach((h, c) => {
      if (h !== null && h !== commit.hash) {
        segs.push({ c1: c, t1: 0, c2: c, t2: 1, color: incomingColors[c] || laneColor(c) });
      }
    });
    // Every lane pointing at this commit merges into the node.
    for (const c of matching) {
      segs.push({ c1: c, t1: 0, c2: nodeCol, t2: 0.5, color: incomingColors[c] || nodeColor });
      lanes[c] = null;
    }
    // Route parents downward: first parent keeps the lane, extras branch out.
    const parents = commit.parents;
    if (parents.length === 0) {
      lanes[nodeCol] = null;
    } else {
      lanes[nodeCol] = parents[0];
      colors[nodeCol] = nodeColor;
      segs.push({ c1: nodeCol, t1: 0.5, c2: nodeCol, t2: 1, color: nodeColor });
      for (let p = 1; p < parents.length; p++) {
        const c = takeFreeCol();
        lanes[c] = parents[p];
        colors[c] = laneColor(c);
        segs.push({ c1: nodeCol, t1: 0.5, c2: c, t2: 1, color: colors[c] });
      }
    }
    let rowMax = nodeCol + 1;
    for (const s of segs) rowMax = Math.max(rowMax, s.c1 + 1, s.c2 + 1);
    width = Math.max(width, rowMax);
    rows.push({ nodeCol, nodeColor, isMerge: parents.length > 1, segs });
  }
  return { rows, width };
}

function segPath(s: GraphSeg): string {
  const x1 = s.c1 * GRAPH_COL_W + GRAPH_COL_W / 2;
  const x2 = s.c2 * GRAPH_COL_W + GRAPH_COL_W / 2;
  const y1 = s.t1 * GRAPH_ROW_H;
  const y2 = s.t2 * GRAPH_ROW_H;
  if (x1 === x2) return `M${x1} ${y1}V${y2}`;
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1}C${x1} ${my},${x2} ${my},${x2} ${y2}`;
}

function HistoryView({ cwd, refreshToken }: { cwd: string; refreshToken: number }) {
  const split = useSplit("pi-git-history-split", 300, 180, 620);
  const [log, setLog] = useState<GitLogResponse | null>(null);
  const [, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/git/log?${new URLSearchParams({ cwd, limit: "80" })}`);
      const next = await res.json() as GitLogResponse & { error?: string };
      if (!res.ok) throw new Error(next.error ?? `Failed to load history (${res.status})`);
      setLog(next);
      setSelectedHash((prev) => prev && next.commits.some((commit) => commit.hash === prev)
        ? prev
        : next.commits[0]?.hash ?? null);
    } catch (cause) {
      setLog(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const graph = useMemo(() => computeCommitGraph(log?.commits ?? []), [log]);

  if (error) return <EmptyState title="Unable to load history" detail={error} action={load} />;
  if (!log) return <EmptyState title="Loading history…" />;
  if (log.commits.length === 0) return <EmptyState title="No commits yet" detail="This repository has no history." />;

  return (
    <div style={{ minHeight: 0, flex: 1, display: "flex" }}>
      <aside style={{ width: split.size, flexShrink: 0, overflow: "auto", borderRight: "1px solid var(--border)", padding: "6px 4px" }}>
        {log.commits.map((commit, index) => {
          const isSelected = commit.hash === selectedHash;
          const row = graph.rows[index];
          if (!row) return null;
          const nodeX = row.nodeCol * GRAPH_COL_W + GRAPH_COL_W / 2;
          const refs = commit.refs.filter((r) => r && r !== "HEAD");
          return (
            <button
              key={commit.hash}
              type="button"
              onClick={() => setSelectedHash(commit.hash)}
              title={`View commit: ${commit.subject}`}
              style={{
                width: "100%",
                height: GRAPH_ROW_H,
                display: "flex",
                gap: 6,
                alignItems: "stretch",
                border: "none",
                borderRadius: 4,
                padding: "0 8px 0 2px",
                cursor: "pointer",
                textAlign: "left",
                color: "var(--text)",
                background: isSelected ? "var(--bg-selected)" : "transparent",
                minWidth: 0,
              }}
            >
              <svg width={graph.width * GRAPH_COL_W} height={GRAPH_ROW_H} style={{ flexShrink: 0, display: "block" }} aria-hidden="true">
                {row.segs.map((s, i) => (
                  <path key={i} d={segPath(s)} stroke={s.color} strokeWidth={1.6} fill="none" opacity={0.9} />
                ))}
                {isSelected && <circle cx={nodeX} cy={GRAPH_ROW_H / 2} r={6} fill="none" stroke="var(--accent)" strokeWidth={1.5} />}
                <circle cx={nodeX} cy={GRAPH_ROW_H / 2} r={row.isMerge ? 4 : 3.4} fill={row.nodeColor} stroke="var(--bg-panel)" strokeWidth={1.6} />
              </svg>
              <span style={{ minWidth: 0, flex: 1, alignSelf: "center" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                  {refs.slice(0, 2).map((r) => (
                    <span key={r} style={{ flexShrink: 0, fontSize: 9.5, lineHeight: "14px", padding: "0 5px", borderRadius: 8, background: "var(--bg-hover)", color: "var(--text-muted)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 96 }}>{r.replace(/^tag: /, "⌘ ")}</span>
                  ))}
                  <span style={{ minWidth: 0, flex: 1, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{commit.subject}</span>
                </span>
                <span style={{ display: "block", marginTop: 2, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {commit.shortHash} · {commit.author} · {formatRelative(commit.date)}
                </span>
              </span>
            </button>
          );
        })}
        {log.hasMore && (
          <div style={{ padding: "8px 10px", color: "var(--text-dim)", fontSize: 11 }}>
            Showing the latest {log.commits.length} commits.
          </div>
        )}
      </aside>
      <div className="resize-handle" onMouseDown={split.onDragStart} role="separator" aria-orientation="vertical" title="Drag to resize" />
      <main style={{ minWidth: 0, flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {selectedHash
          ? <CommitDetailView cwd={cwd} hash={selectedHash} />
          : <EmptyState title="Select a commit" detail="Choose a commit to inspect its changes." />}
      </main>
    </div>
  );
}

function CommitDetailView({ cwd, hash }: { cwd: string; hash: string }) {
  const split = useSplit("pi-git-commit-files-h", 160, 60, 460, "y");
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);
    setSelectedFile(null);
    void fetch(`/api/git/commit?${new URLSearchParams({ cwd, hash })}`, { signal: controller.signal })
      .then(async (res) => {
        const next = await res.json() as GitCommitDetail & { error?: string };
        if (!res.ok) throw new Error(next.error ?? `Failed to load commit (${res.status})`);
        setDetail(next);
        setSelectedFile(next.files[0]?.path ?? null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cwd, hash]);

  if (error) return <EmptyState title="Unable to load commit" detail={error} />;
  if (!detail || loading) return <EmptyState title="Loading commit…" />;

  return (
    <div style={{ minHeight: 0, flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <div style={{ fontWeight: 650, fontSize: 13 }}>{detail.subject}</div>
        <div style={{ marginTop: 4, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
          {detail.shortHash} · {detail.author} · {formatDate(detail.date)}
        </div>
        {detail.refs.length > 0 && (
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>
            {detail.refs.map((ref) => <Badge key={ref} label={ref} />)}
          </div>
        )}
        {detail.body && (
          <pre style={{ margin: "8px 0 0", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{detail.body}</pre>
        )}
        <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--text-muted)" }}>
          Files {detail.files.length}
          <span style={{ marginLeft: 8, color: STATUS_COLORS.added }}>+{detail.additions}</span>
          <span style={{ marginLeft: 6, color: STATUS_COLORS.deleted }}>-{detail.deletions}</span>
        </div>
      </div>
      <div style={{ height: split.size, overflow: "auto", borderBottom: "1px solid var(--border)", padding: "6px 4px", flexShrink: 0 }}>
        {detail.files.map((file) => (
          <CommitFileRow
            key={file.path}
            file={file}
            selected={file.path === selectedFile}
            onSelect={() => setSelectedFile(file.path)}
          />
        ))}
      </div>
      <div className="resize-handle resize-handle--h" onMouseDown={split.onDragStart} role="separator" aria-orientation="horizontal" title="Drag to resize" />
      <div style={{ minHeight: 0, flex: 1, overflow: "auto" }}>
        {selectedFile
          ? <CommitFileDiff cwd={cwd} hash={hash} path={selectedFile} />
          : <EmptyState title="No file changes" />}
      </div>
    </div>
  );
}

function CommitFileRow({ file, selected, onSelect }: { file: GitCommitFile; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={`View commit diff: ${file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}`}
      style={{ ...fileButtonStyle, background: selected ? "var(--bg-selected)" : "transparent" }}
    >
      <span style={{ width: 14, flexShrink: 0, fontFamily: "var(--font-mono)", fontWeight: 700, color: STATUS_COLORS[file.status] }}>{KIND_LETTER[file.status]}</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{getFileName(file.path)}</span>
      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
        {file.additions != null && <span style={{ color: STATUS_COLORS.added }}>+{file.additions}</span>}
        {file.deletions != null && <span style={{ marginLeft: 4, color: STATUS_COLORS.deleted }}>-{file.deletions}</span>}
      </span>
    </button>
  );
}

function CommitFileDiff({ cwd, hash, path }: { cwd: string; hash: string; path: string }) {
  const [diff, setDiff] = useState<GitFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDiff(null);
    void fetch(`/api/git/commit?${new URLSearchParams({ cwd, hash, path })}`, { signal: controller.signal })
      .then(async (res) => {
        const next = await res.json() as GitFileDiffResponse & { error?: string };
        setDiff(res.ok ? next : { supported: false });
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setDiff({ supported: false });
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [cwd, hash, path]);

  if (loading) return <EmptyState title="Loading diff…" />;
  if (diff?.supported && diff.patch) return <DiffView patch={diff.patch} />;
  return <EmptyState title="Diff unavailable" detail="This file may be binary or too large to display." />;
}

function EmptyState({ title, detail, action }: { title: string; detail?: string; action?: () => void }) {
  return <div style={{ height: "100%", minHeight: 140, padding: 24, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7, color: "var(--text-dim)", textAlign: "center" }}>
    <div style={{ color: "var(--text-muted)", fontSize: 13 }}>{title}</div>
    {detail && <div style={{ maxWidth: 360, fontFamily: "var(--font-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{detail}</div>}
    {action && <button type="button" onClick={action} title="Try loading again" style={{ ...iconButtonStyle, width: "auto", padding: "4px 8px", marginTop: 4 }}>Retry</button>}
  </div>;
}

function Badge({ label, title }: { label: string; title?: string }) {
  return <span title={title} style={{ padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{label}</span>;
}

const iconButtonStyle: React.CSSProperties = { width: 24, height: 24, padding: 0, border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 16 };
const syncButtonStyle: React.CSSProperties = { height: 24, padding: "0 6px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" };
const fileButtonStyle: React.CSSProperties = { width: "100%", display: "flex", alignItems: "center", gap: 6, border: "none", borderRadius: 4, padding: "5px 8px", cursor: "pointer", color: "var(--text)", textAlign: "left", fontSize: 12, minWidth: 0 };
const writeButtonStyle: React.CSSProperties = { width: 20, height: 20, padding: 0, border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1, flexShrink: 0 };
const stashButtonStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 4, padding: "2px 5px", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10.5, flexShrink: 0 };
