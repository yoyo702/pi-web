"use client";

import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { getFileIcon, FolderIcon } from "./FileIcons";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { Check, ChevronUp, Copy, Eye, EyeOff, FilePlus2, FolderPlus, Pencil, Search, Trash2, X } from "lucide-react";

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface SearchEntry { path: string; isDir: boolean }
type MutationAction = "create-file" | "create-folder" | "rename";

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  onAtMentions?: (relativePaths: string[]) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  onPathRenamed?: (oldPath: string, newPath: string, isDir: boolean) => void;
  onPathDeleted?: (path: string, isDir: boolean) => void;
  revealRequest?: { path: string; key: number } | null;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
  openFolderUploadPicker: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";
type UploadConflictStrategy = "error" | "overwrite" | "skip";

interface UploadError {
  name: string;
  error: string;
}

interface UploadResponse {
  uploaded?: string[];
  skipped?: string[];
  errors?: UploadError[];
  conflicts?: string[];
  nonReplaceable?: string[];
  error?: string;
}

interface UploadSummary {
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function fetchEntries(dirPath: string, showHidden = false): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list${showHidden ? "" : "&hideHidden=1"}`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_LABELS: Record<GitFileStatusKind, string> = {
  modified: "Modified",
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  untracked: "Untracked",
  conflict: "Conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "#d6a84b",
  added: "#4ade80",
  deleted: "#f87171",
  renamed: "#60a5fa",
  untracked: "#4ade80",
  conflict: "#f87171",
};

function uploadFiles(
  targetDirectory: string,
  files: File[],
  strategy: UploadConflictStrategy,
  onProgress: (progress: number) => void,
): Promise<{ status: number; data: UploadResponse }> {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    files.forEach((file) => formData.append("files", file, file.name));

    const xhr = new XMLHttpRequest();
    xhr.open(
      "POST",
      `/api/files/${encodeFilePathForApi(targetDirectory)}?type=upload&conflict=${strategy}`,
    );
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error("Network error while uploading files"));
    xhr.onabort = () => reject(new Error("Upload cancelled"));
    xhr.onload = () => {
      let data: UploadResponse = {};
      try {
        data = JSON.parse(xhr.responseText) as UploadResponse;
      } catch {
        if (xhr.responseText) data.error = xhr.responseText;
      }
      resolve({ status: xhr.status, data });
    };
    xhr.send(formData);
  });
}

function MentionIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{ width: 24, height: 24, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "none", borderRadius: 4, background: "none", color: "var(--text-dim)", cursor: "pointer" }}
      onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text-muted)"; event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-dim)"; event.currentTarget.style.background = "none"; }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </button>
  );
}

function HighlightedPath({ path, query }: { path: string; query: string }) {
  const trimmed = query.trim();
  if (!trimmed) return <>{path}</>;
  const index = path.toLocaleLowerCase().indexOf(trimmed.toLocaleLowerCase());
  if (index < 0) return <>{path}</>;
  return <>{path.slice(0, index)}<mark style={{ padding: 0, borderRadius: 2, background: "color-mix(in srgb, var(--accent) 22%, transparent)", color: "inherit" }}>{path.slice(index, index + trimmed.length)}</mark>{path.slice(index + trimmed.length)}</>;
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  gitStatusByPath,
  changedDirectoryPaths,
  showHidden,
  selectedPath,
  onSelect,
  onContextMenu,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string) => void;
  onAtMention?: (relativePath: string, isDir: boolean) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken: string;
  highlightedPaths: Set<string>;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  showHidden: boolean;
  selectedPath: string;
  onSelect: (node: FileNode) => void;
  onContextMenu: (node: FileNode, event: React.MouseEvent) => void;
}) {
  const open = expandedPaths.has(node.fullPath);
  const highlighted = highlightedPaths.has(node.fullPath);
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [hovered, setHovered] = useState(false);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    try {
      const entries = await fetchEntries(node.fullPath, showHidden);
      setChildren(entries);
      setLoaded(true);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath, showHidden]);

  // Re-fetch children when the tree refreshes and the directory is open.
  useEffect(() => {
    if (open && loaded) {
      loadChildren(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, showHidden]);

  useEffect(() => {
    if (open && !loaded && !loading) void loadChildren();
  }, [loadChildren, loaded, loading, open]);

  const handleClick = useCallback(() => {
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
      if (next && !loaded) loadChildren();
    } else {
      onOpenFile(node.fullPath, node.name);
    }
  }, [node.isDir, node.fullPath, node.name, loaded, open, loadChildren, onOpenFile, onToggleExpanded]);

  return (
    <div>
      <div
        data-explorer-row
        data-file-path={node.fullPath}
        data-file-dir={node.isDir ? "1" : "0"}
        role="treeitem"
        aria-selected={selectedPath === node.fullPath}
        aria-expanded={node.isDir ? open : undefined}
        tabIndex={selectedPath === node.fullPath ? 0 : -1}
        onFocus={() => onSelect(node)}
        onClick={(event) => { onSelect(node); event.currentTarget.focus(); handleClick(); }}
        onContextMenu={(event) => onContextMenu(node, event)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 8 + depth * 14,
          paddingRight: 8,
          height: 24,
          cursor: "pointer",
          background: selectedPath === node.fullPath ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
          borderRadius: 4,
          userSelect: "none",
        }}
      >
        {node.isDir && (
          <svg
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            stroke="var(--text-dim)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
            style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : "none", transition: "transform 0.1s" }}
          >
            <polyline points="3 2 7 5 3 8" />
          </svg>
        )}
        {!node.isDir && <span style={{ width: 10, flexShrink: 0 }} />}
        <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
          {node.isDir ? <FolderIcon size={14} open={open} /> : getFileIcon(node.name, 14)}
        </span>
        <span
          style={{
            fontSize: 12,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title="Newly uploaded"
            aria-label="Newly uploaded"
            style={{ width: 6, height: 6, flexShrink: 0, borderRadius: "50%", background: "#3b82f6" }}
          />
        )}
        {!hovered && !node.isDir && gitStatus && (
          <span
            title={GIT_STATUS_LABELS[gitStatus.status]}
            aria-label={GIT_STATUS_LABELS[gitStatus.status]}
            style={{
              width: 14,
              flexShrink: 0,
              color: GIT_STATUS_COLORS[gitStatus.status],
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              fontWeight: 600,
              textAlign: "center",
            }}
          >
            {gitStatus.code}
          </span>
        )}
        {!hovered && containsGitChanges && (
          <span
            title="Contains changed files"
            aria-label="Contains changed files"
            style={{
              width: 6,
              height: 6,
              flexShrink: 0,
              borderRadius: "50%",
              background: "#d6a84b",
            }}
          />
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {onAtMention && hovered && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir);
            }}
            title="Insert path into chat"
            style={{
              position: "absolute",
              right: !node.isDir ? 28 : 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 8px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
            }}
          >
            <MentionIcon />
            mention
          </button>
        )}
        {hovered && !node.isDir && (
          <a
            href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
            download
            onClick={(e) => e.stopPropagation()}
            title="Download file"
            style={{
              position: "absolute",
              right: 4,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              padding: "0 5px",
              height: 20,
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: "nowrap",
              textDecoration: "none",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </a>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              showHidden={showHidden}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 8 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  onPathRenamed,
  onPathDeleted,
  revealRequest,
}, ref) {
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{ loading: boolean; error: string; results: SearchEntry[] }>({ loading: false, error: "", results: [] });
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const searchResultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [settingsHydratedCwd, setSettingsHydratedCwd] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<FileNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{ node: FileNode | null; x: number; y: number } | null>(null);
  const [pendingMutation, setPendingMutation] = useState<{ action: MutationAction; node: FileNode | null } | null>(null);
  const [mutationName, setMutationName] = useState("");
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [deleteNode, setDeleteNode] = useState<FileNode | null>(null);
  const [fileClipboard, setFileClipboard] = useState<{ node: FileNode; mode: "copy" | "move" } | null>(null);
  const prevCwdRef = useRef<string | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const folderUploadInputRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`pi-web:explorer:${encodeURIComponent(cwd)}`) || "null") as { expanded?: unknown; showHidden?: unknown } | null;
      const expanded = Array.isArray(saved?.expanded) ? saved.expanded.filter((item): item is string => typeof item === "string").map((item) => joinFilePath(cwd, item)) : [];
      setExpandedPaths(new Set(expanded));
      setShowHidden(saved?.showHidden === true);
    } catch {
      setExpandedPaths(new Set());
      setShowHidden(false);
    }
    setSettingsHydratedCwd(cwd);
  }, [cwd]);

  useEffect(() => {
    if (settingsHydratedCwd !== cwd) return;
    try {
      localStorage.setItem(`pi-web:explorer:${encodeURIComponent(cwd)}`, JSON.stringify({
        expanded: [...expandedPaths].map((item) => getRelativeFilePath(item, cwd)).filter((item) => item !== cwd),
        showHidden,
      }));
    } catch { /* Storage can be unavailable in privacy mode. */ }
  }, [cwd, expandedPaths, settingsHydratedCwd, showHidden]);

  const relativeNodePath = useCallback((node: FileNode | null) => node ? getRelativeFilePath(node.fullPath, cwd) : "", [cwd]);

  const refreshTree = useCallback(() => setTreeRefreshKey((key) => key + 1), []);

  const revealSearchResult = useCallback((entry: SearchEntry) => {
    const parts = entry.path.split("/").filter(Boolean);
    const folders = entry.isDir ? parts : parts.slice(0, -1);
    let current = cwd;
    setExpandedPaths((expanded) => {
      const next = new Set(expanded);
      for (const folder of folders) { current = joinFilePath(current, folder); next.add(current); }
      return next;
    });
    setQuery("");
    if (!entry.isDir) onOpenFile(joinFilePath(cwd, entry.path), parts.at(-1) || entry.path);
  }, [cwd, onOpenFile]);

  useEffect(() => {
    setSearchActiveIndex((index) => Math.max(0, Math.min(index, search.results.length - 1)));
  }, [search.results.length]);

  useEffect(() => {
    if (!query.trim()) return;
    searchResultRefs.current[searchActiveIndex]?.scrollIntoView({ block: "nearest" });
  }, [query, searchActiveIndex]);

  const handleSearchKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (!query) return;
      event.preventDefault();
      setQuery("");
      return;
    }
    if (search.results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSearchActiveIndex((index) => (index + direction + search.results.length) % search.results.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      revealSearchResult(search.results[searchActiveIndex] ?? search.results[0]);
    }
  }, [query, revealSearchResult, search.results, searchActiveIndex]);

  useEffect(() => {
    if (!contextMenu && !pendingMutation && !deleteNode) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-explorer-overlay]")) return;
      setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setContextMenu(null);
      setPendingMutation(null);
      setDeleteNode(null);
      setMutationError(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [contextMenu, deleteNode, pendingMutation]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) { setSearch({ loading: false, error: "", results: [] }); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearch((current) => ({ ...current, loading: true, error: "" }));
      const searchParams = new URLSearchParams({ cwd, q: trimmed });
      if (showHidden) searchParams.set("includeIgnored", "1");
      void fetch(`/api/file-index?${searchParams}`, { signal: controller.signal })
        .then(async (response) => {
          const data = await response.json() as { matches?: SearchEntry[]; error?: string };
          if (!response.ok) throw new Error(data.error || `Search failed (HTTP ${response.status})`);
          setSearch({ loading: false, error: "", results: (data.matches ?? []).filter((entry) => showHidden || !entry.path.split("/").some((part) => part.startsWith("."))) });
        })
        .catch((cause) => { if (!controller.signal.aborted) setSearch({ loading: false, error: cause instanceof Error ? cause.message : String(cause), results: [] }); });
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [cwd, query, showHidden]);

  const startMutation = useCallback((action: MutationAction, node: FileNode | null) => {
    setContextMenu(null);
    setMutationError(null);
    setMutationName(action === "rename" ? node?.name ?? "" : "");
    setPendingMutation({ action, node });
  }, []);

  const submitMutation = useCallback(async () => {
    if (!pendingMutation || mutationBusy || !mutationName.trim()) return;
    const { action, node } = pendingMutation;
    const selectedRelative = relativeNodePath(node);
    const parent = action.startsWith("create") ? (node?.isDir ? selectedRelative : node ? getRelativeFilePath(getFileDirectory(node.fullPath), cwd) : "") : selectedRelative;
    setMutationBusy(true);
    setMutationError(null);
    try {
      const response = await fetch("/api/workspace-files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, cwd, path: parent, name: mutationName.trim() }) });
      const data = await response.json() as { path?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to update files");
      if (action === "rename" && node && data.path) {
        const nextPath = joinFilePath(cwd, data.path);
        onPathRenamed?.(node.fullPath, nextPath, node.isDir);
        if (node.isDir) setExpandedPaths((current) => new Set([...current].map((item) => item === node.fullPath || item.startsWith(`${node.fullPath}/`) ? `${nextPath}${item.slice(node.fullPath.length)}` : item)));
      }
      setPendingMutation(null);
      setSelectedNode(null);
      refreshTree();
      if (action === "create-file" && data.path) onOpenFile(joinFilePath(cwd, data.path), data.path.split("/").pop() || data.path);
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setMutationBusy(false); }
  }, [cwd, mutationBusy, mutationName, onOpenFile, onPathRenamed, pendingMutation, refreshTree, relativeNodePath]);

  const confirmDelete = useCallback(async () => {
    if (!deleteNode || mutationBusy) return;
    setMutationBusy(true);
    setMutationError(null);
    try {
      const response = await fetch("/api/workspace-files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "delete", cwd, path: relativeNodePath(deleteNode) }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to delete file");
      onPathDeleted?.(deleteNode.fullPath, deleteNode.isDir);
      if (deleteNode.isDir) setExpandedPaths((current) => new Set([...current].filter((item) => item !== deleteNode.fullPath && !item.startsWith(`${deleteNode.fullPath}/`))));
      setDeleteNode(null);
      setSelectedNode(null);
      refreshTree();
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setMutationBusy(false); }
  }, [cwd, deleteNode, mutationBusy, onPathDeleted, refreshTree, relativeNodePath]);

  const copyFullPath = useCallback(async (node: FileNode | null) => {
    const value = node?.fullPath ?? cwd;
    try { await navigator.clipboard.writeText(value); }
    catch {
      const area = document.createElement("textarea"); area.value = value; area.style.position = "fixed"; area.style.opacity = "0"; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
    }
    setContextMenu(null);
  }, [cwd]);

  const pasteInto = useCallback(async (node: FileNode | null) => {
    if (!fileClipboard || mutationBusy) return;
    const destination = node?.isDir ? relativeNodePath(node) : node ? getRelativeFilePath(getFileDirectory(node.fullPath), cwd) : "";
    setMutationBusy(true); setMutationError(null); setContextMenu(null);
    try {
      const response = await fetch("/api/workspace-files", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: fileClipboard.mode, cwd, path: relativeNodePath(fileClipboard.node), destination }) });
      const data = await response.json() as { path?: string; error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to paste item");
      if (fileClipboard.mode === "move" && data.path) onPathRenamed?.(fileClipboard.node.fullPath, joinFilePath(cwd, data.path), fileClipboard.node.isDir);
      if (fileClipboard.mode === "move") setFileClipboard(null);
      refreshTree();
    } catch (cause) { setMutationError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setMutationBusy(false); }
  }, [cwd, fileClipboard, mutationBusy, onPathRenamed, refreshTree, relativeNodePath]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (open) next.add(fullPath); else next.delete(fullPath);
      return next;
    });
  }, []);

  const applyUploadResult = useCallback((data: UploadResponse) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(cwd, name))));
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(cwd, files, strategy, setUploadProgress);
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data);
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[]) => {
    if (files.length === 0 || uploadBusy) return;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(cwd)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error");
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
    } finally {
      setUploadPhase("idle");
    }
  }, [cwd, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files);
  }, [prepareUpload]);

  const handleFolderUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length || uploadBusy) return;
    setUploadPhase("uploading"); setUploadProgress(0); setUploadError(null); setUploadSummary(null);
    const form = new FormData();
    files.forEach((file) => { form.append("files", file, file.name); form.append("paths", file.webkitRelativePath || file.name); });
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/files/${encodeFilePathForApi(cwd)}?type=upload&conflict=skip`);
    xhr.upload.onprogress = (progress) => { if (progress.lengthComputable) setUploadProgress(Math.round(progress.loaded / progress.total * 100)); };
    xhr.onerror = () => { setUploadError("Network error while uploading folder"); setUploadPhase("idle"); };
    xhr.onload = () => {
      try { const data = JSON.parse(xhr.responseText) as UploadResponse; if (xhr.status < 200 || xhr.status >= 300) throw new Error(data.error || "Folder upload failed"); applyUploadResult(data); }
      catch (cause) { setUploadError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setUploadPhase("idle"); refreshTree(); }
    };
    xhr.send(form);
  }, [applyUploadResult, cwd, refreshTree, uploadBusy]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBusy) uploadInputRef.current?.click();
    },
    openFolderUploadPicker() { if (!uploadBusy) folderUploadInputRef.current?.click(); },
  }), [uploadBusy]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBusy);
  }, [onUploadBusyChange, uploadBusy]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Workspace-specific expansion and hidden-file settings are restored by
    // the persistence effect above; reset only transient UI here.
    if (cwdChanged) {
      setHighlightedPaths(new Set());
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setQuery("");
      setSelectedNode(null);
      setContextMenu(null);
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd, showHidden)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, showHidden, treeRefreshKey]);

  useEffect(() => {
    if (!revealRequest) return;
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/+$/, "");
    const targetPath = normalizeFilePathSlashes(revealRequest.path);
    if (!targetPath.startsWith(`${normalizedCwd}/`)) return;

    const relativePath = targetPath.slice(normalizedCwd.length + 1);
    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) return;

    setQuery("");
    setExpandedPaths((current) => {
      const next = new Set(current);
      let parent = normalizedCwd;
      for (const part of parts.slice(0, -1)) {
        parent = joinFilePath(parent, part);
        next.add(parent);
      }
      return next;
    });
    setSelectedNode({
      name: parts.at(-1)!,
      fullPath: targetPath,
      isDir: false,
      size: 0,
      loaded: true,
    });

    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scrollToTarget = () => {
      if (cancelled) return;
      const row = [...(treeRef.current?.querySelectorAll<HTMLElement>("[data-explorer-row]") ?? [])]
        .find((element) => normalizeFilePathSlashes(element.dataset.filePath ?? "") === targetPath);
      if (row) {
        row.scrollIntoView({ block: "center", inline: "nearest" });
        row.focus({ preventScroll: true });
        return;
      }
      attempts += 1;
      if (attempts < 30) timer = setTimeout(scrollToTarget, 80);
    };
    timer = setTimeout(scrollToTarget, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cwd, revealRequest]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden && !uploadBusy && !mutationBusy) refreshTree();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [mutationBusy, refreshTree, uploadBusy]);

  useEffect(() => {
    if (!selectedNode && roots[0]) setSelectedNode(roots[0]);
  }, [roots, selectedNode]);

  useEffect(() => {
    let cancelled = false;
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) setGitFiles(status.isGitRepository ? status.files : []);
      })
      .catch(() => {
        if (!cancelled) setGitFiles([]);
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(cwd, name), cwd)),
    );
  }, [cwd, onAtMentions, uploadSummary]);

  return (
    <div style={{ minHeight: "100%", position: "relative" }} onContextMenu={(event) => {
      if ((event.target as Element).closest("[data-explorer-row]")) return;
      event.preventDefault();
      setSelectedNode(null);
      setContextMenu({ node: null, x: event.clientX, y: event.clientY });
    }}>
      <input ref={uploadInputRef} type="file" multiple hidden onChange={handleUploadInput} />
      <input ref={folderUploadInputRef} type="file" multiple hidden onChange={handleFolderUploadInput} {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)} />
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 6px", borderBottom: "1px solid var(--border)" }}>
        <label style={{ minWidth: 0, height: 27, flex: 1, display: "flex", alignItems: "center", gap: 5, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-dim)" }}>
          <Search size={13} aria-hidden="true" />
          <input value={query} onChange={(event) => { setQuery(event.target.value); setSearchActiveIndex(0); }} onKeyDown={handleSearchKeyDown} placeholder="Search files" aria-label="Search files" role="combobox" aria-autocomplete="list" aria-expanded={Boolean(query.trim())} aria-controls="explorer-search-results" aria-activedescendant={query.trim() && search.results[searchActiveIndex] ? `explorer-search-result-${searchActiveIndex}` : undefined} style={{ width: "100%", minWidth: 0, border: 0, outline: 0, background: "transparent", color: "var(--text)", font: "11px/1.2 inherit" }} />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear file search" title="Clear" style={toolbarButtonStyle}><X size={12} /></button>}
        </label>
        <button type="button" onClick={() => setExpandedPaths(new Set())} aria-label="Collapse all folders" title="Collapse all" style={toolbarButtonStyle}><ChevronUp size={14} /></button>
        <button type="button" onClick={() => setShowHidden((value) => !value)} aria-pressed={showHidden} aria-label={showHidden ? "Hide hidden and generated files" : "Show hidden and generated files"} title={showHidden ? "Hide hidden and generated files" : "Show hidden and generated files"} style={{ ...toolbarButtonStyle, ...(showHidden ? toolbarButtonActiveStyle : {}) }}>{showHidden ? <Eye size={14} /> : <EyeOff size={14} />}</button>
        <button type="button" onClick={() => startMutation("create-file", selectedNode)} aria-label="New file" title="New file" style={toolbarButtonStyle}><FilePlus2 size={14} /></button>
        <button type="button" onClick={() => startMutation("create-folder", selectedNode)} aria-label="New folder" title="New folder" style={toolbarButtonStyle}><FolderPlus size={14} /></button>
      </div>

      {pendingMutation && <form data-explorer-overlay onSubmit={(event) => { event.preventDefault(); void submitMutation(); }} style={editBarStyle}>
        <input autoFocus disabled={mutationBusy} value={mutationName} onChange={(event) => setMutationName(event.target.value)} placeholder={pendingMutation.action === "rename" ? "New name" : pendingMutation.action === "create-file" ? "New file name" : "New folder name"} aria-label="Explorer item name" style={editInputStyle} />
        <button type="submit" disabled={mutationBusy || !mutationName.trim()} aria-label="Save" title="Save" style={toolbarButtonStyle}><Check size={14} /></button>
        <button type="button" disabled={mutationBusy} onClick={() => { setPendingMutation(null); setMutationError(null); }} aria-label="Cancel" title="Cancel" style={toolbarButtonStyle}><X size={14} /></button>
      </form>}
      {mutationError && <div role="alert" style={{ padding: "5px 8px", color: "#f87171", fontSize: 10, overflowWrap: "anywhere" }}>{mutationError}</div>}

      {query.trim() && <div id="explorer-search-results" role="listbox" aria-label="File search results" style={{ maxHeight: 220, overflowY: "auto", padding: 4, borderBottom: "1px solid var(--border)" }}>
        {search.loading && <div style={emptyStyle}>Searching…</div>}
        {!search.loading && search.error && <div style={{ ...emptyStyle, color: "#f87171" }}>{search.error}</div>}
        {!search.loading && !search.error && search.results.length === 0 && <div style={emptyStyle}>No matching files</div>}
        {search.results.map((entry, index) => {
          const absolutePath = normalizeFilePathSlashes(joinFilePath(cwd, entry.path));
          const status = gitStatusByPath.get(absolutePath);
          const containsChanges = entry.isDir && changedDirectoryPaths.has(absolutePath);
          return <button ref={(element) => { searchResultRefs.current[index] = element; }} id={`explorer-search-result-${index}`} key={`${entry.isDir}:${entry.path}`} type="button" role="option" aria-selected={searchActiveIndex === index} onMouseEnter={() => setSearchActiveIndex(index)} onClick={() => revealSearchResult(entry)} title={entry.path} style={{ ...searchResultStyle, ...(searchActiveIndex === index ? searchResultActiveStyle : {}) }}>
            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(entry.path, 14)}
            <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><HighlightedPath path={entry.path} query={query} /></span>
            {status && <span title={GIT_STATUS_LABELS[status.status]} aria-label={GIT_STATUS_LABELS[status.status]} style={{ color: GIT_STATUS_COLORS[status.status], fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700 }}>{status.code}</span>}
            {!status && containsChanges && <span title="Contains changed files" aria-label="Contains changed files" style={{ width: 6, height: 6, borderRadius: "50%", background: "#d6a84b" }} />}
          </button>;
        })}
      </div>}
      {showUploadFeedback && (
        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? "Checking files" : `Uploading, ${uploadProgress}%`}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 10 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width 120ms ease" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ padding: 7, border: "1px solid color-mix(in srgb, #f59e0b 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, #f59e0b 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {pendingConflict.conflicts.length} file{pendingConflict.conflicts.length === 1 ? "" : "s"} already exist: {pendingConflict.conflicts.join(", ")}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 10, color: "#f59e0b", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                Cannot replace: {pendingConflict.nonReplaceable.join(", ")}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite")} style={{ height: 22, padding: "0 7px", border: "1px solid #ef4444", borderRadius: 4, background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 10 }}>
                Replace
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip")} style={{ height: 22, padding: "0 7px", border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: 10 }}>
                Skip existing
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 10 }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 11, lineHeight: 1.35, color: "#f87171" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title="Dismiss error" />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 22, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span title={`${uploadSummary.uploaded.length} uploaded`} aria-label={`${uploadSummary.uploaded.length} uploaded`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#22c55e" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{uploadSummary.uploaded.length}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span title={`${uploadSummary.skipped.length} skipped`} aria-label={`${uploadSummary.skipped.length} skipped`} style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-dim)" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{uploadSummary.skipped.length}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span title={`${uploadSummary.errors.length} failed`} aria-label={`${uploadSummary.errors.length} failed`} style={{ display: "flex", alignItems: "center", gap: 3, color: "#f87171" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{uploadSummary.errors.length}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? "Add uploaded file to chat" : "Add all uploaded files to chat"}
                  aria-label={uploadSummary.uploaded.length === 1 ? "Add uploaded file to chat" : "Add all uploaded files to chat"}
                  style={{ height: 22, padding: "0 7px", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, flexShrink: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", color: "var(--accent)", cursor: "pointer", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
                >
                  <MentionIcon />
                  mention
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title="Dismiss upload results" />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 10, color: "#f87171" }}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      <div ref={treeRef} role="tree" aria-label="Workspace files" style={{ padding: "2px 4px" }} onKeyDown={(event) => {
        if (!(event.target instanceof Element)) return;
        const row = event.target.closest<HTMLElement>("[data-explorer-row]");
        if (!row) return;
        const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-explorer-row]"));
        const index = rows.indexOf(row);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
          return;
        }
        const node = selectedNode;
        if (!node) return;
        if (event.key === "ArrowRight" && node.isDir) {
          event.preventDefault();
          if (!expandedPaths.has(node.fullPath)) handleToggleExpanded(node.fullPath, true);
          else rows[index + 1]?.focus();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          if (node.isDir && expandedPaths.has(node.fullPath)) handleToggleExpanded(node.fullPath, false);
          else {
            const parent = getFileDirectory(node.fullPath);
            rows.find((item) => item.dataset.filePath === parent)?.focus();
          }
        } else if (event.key === "Enter") {
          event.preventDefault();
          if (node.isDir) handleToggleExpanded(node.fullPath, !expandedPaths.has(node.fullPath));
          else onOpenFile(node.fullPath, node.name);
        } else if (event.key === "F2") {
          event.preventDefault();
          startMutation("rename", node);
        } else if (event.key === "Delete") {
          event.preventDefault();
          setDeleteNode(node);
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
          event.preventDefault();
          setFileClipboard({ node, mode: "copy" });
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x") {
          event.preventDefault(); setFileClipboard({ node, mode: "move" });
        } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
          event.preventDefault(); void pasteInto(node);
        }
      }}>
        {loading ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>Loading files...</div>
        ) : error ? (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "#f87171" }}>{error}</div>
        ) : (
          roots.map((node) => (
            <TreeNode
              key={node.fullPath}
              node={node}
              depth={0}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={handleToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              showHidden={showHidden}
              selectedPath={selectedNode?.fullPath ?? ""}
              onSelect={setSelectedNode}
              onContextMenu={(node, event) => {
                event.preventDefault();
                event.stopPropagation();
                setSelectedNode(node);
                setContextMenu({ node, x: event.clientX, y: event.clientY });
              }}
            />
          ))
        )}
        {!loading && !error && roots.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--text-dim)" }}>
            No files found
          </div>
        )}
      </div>

      {contextMenu && <div data-explorer-overlay role="menu" style={{ ...contextMenuStyle, left: Math.min(contextMenu.x, window.innerWidth - 205), top: Math.min(contextMenu.y, window.innerHeight - 250) }}>
        {contextMenu.node && !contextMenu.node.isDir && <button type="button" role="menuitem" onClick={() => { onOpenFile(contextMenu.node!.fullPath, contextMenu.node!.name); setContextMenu(null); }} style={menuButtonStyle}>Open file</button>}
        <button type="button" role="menuitem" onClick={() => startMutation("create-file", contextMenu.node)} style={menuButtonStyle}><FilePlus2 size={13} />New file</button>
        <button type="button" role="menuitem" onClick={() => startMutation("create-folder", contextMenu.node)} style={menuButtonStyle}><FolderPlus size={13} />New folder</button>
        {contextMenu.node && <><button type="button" role="menuitem" onClick={() => startMutation("rename", contextMenu.node)} style={menuButtonStyle}><Pencil size={13} />Rename</button><button type="button" role="menuitem" onClick={() => { setDeleteNode(contextMenu.node); setContextMenu(null); }} style={{ ...menuButtonStyle, color: "#f87171" }}><Trash2 size={13} />Delete…</button></>}
        <span style={menuDividerStyle} />
        {contextMenu.node && <><button type="button" role="menuitem" onClick={() => { setFileClipboard({ node: contextMenu.node!, mode: "copy" }); setContextMenu(null); }} style={menuButtonStyle}>Copy</button><button type="button" role="menuitem" onClick={() => { setFileClipboard({ node: contextMenu.node!, mode: "move" }); setContextMenu(null); }} style={menuButtonStyle}>Cut</button></>}
        {fileClipboard && <button type="button" role="menuitem" onClick={() => void pasteInto(contextMenu.node)} style={menuButtonStyle}>Paste {fileClipboard.node.name}</button>}
        <button type="button" role="menuitem" onClick={() => void copyFullPath(contextMenu.node)} style={menuButtonStyle}><Copy size={13} />Copy full path</button>
        {contextMenu.node && onAtMention && <button type="button" role="menuitem" onClick={() => { onAtMention(relativeNodePath(contextMenu.node), contextMenu.node!.isDir); setContextMenu(null); }} style={menuButtonStyle}><MentionIcon />Insert into chat</button>}
        {contextMenu.node && !contextMenu.node.isDir && <a href={`/api/files/${encodeFilePathForApi(contextMenu.node.fullPath)}?type=download`} download onClick={() => setContextMenu(null)} role="menuitem" style={{ ...menuButtonStyle, textDecoration: "none" }}>Download</a>}
      </div>}

      {deleteNode && <div data-explorer-overlay role="alertdialog" aria-modal="true" aria-label="Confirm deletion" style={confirmStyle}>
        <strong style={{ color: "var(--text)", fontSize: 12 }}>Delete {deleteNode.name}?</strong>
        <span style={{ color: "var(--text-dim)", fontSize: 10 }}>This cannot be undone.</span>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}><button type="button" disabled={mutationBusy} onClick={() => setDeleteNode(null)} style={secondaryButtonStyle}>Cancel</button><button type="button" disabled={mutationBusy} onClick={() => void confirmDelete()} style={dangerButtonStyle}>{mutationBusy ? "Deleting…" : "Delete"}</button></div>
      </div>}
    </div>
  );
});

const toolbarButtonStyle: React.CSSProperties = { width: 25, height: 25, flexShrink: 0, display: "grid", placeItems: "center", padding: 0, border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer" };
const toolbarButtonActiveStyle: React.CSSProperties = { background: "var(--bg-selected)", color: "var(--accent)" };
const editBarStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, padding: "5px 6px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)" };
const editInputStyle: React.CSSProperties = { minWidth: 0, height: 27, flex: 1, padding: "0 7px", border: "1px solid var(--accent)", borderRadius: 5, outline: 0, background: "var(--bg)", color: "var(--text)", font: "11px/1.2 inherit" };
const emptyStyle: React.CSSProperties = { padding: "8px", color: "var(--text-dim)", fontSize: 11 };
const searchResultStyle: React.CSSProperties = { width: "100%", height: 26, display: "flex", alignItems: "center", gap: 6, padding: "0 7px", border: 0, borderRadius: 4, background: "transparent", color: "var(--text)", cursor: "pointer", font: "11px/1.2 inherit", textAlign: "left" };
const searchResultActiveStyle: React.CSSProperties = { background: "var(--bg-selected)", color: "var(--accent)" };
const contextMenuStyle: React.CSSProperties = { position: "fixed", zIndex: 1000, width: 190, display: "grid", gap: 2, padding: 5, border: "1px solid var(--border)", borderRadius: 8, background: "var(--bg-panel)", boxShadow: "0 12px 32px rgba(0,0,0,.24)" };
const menuButtonStyle: React.CSSProperties = { minHeight: 28, display: "flex", alignItems: "center", gap: 7, padding: "0 8px", border: 0, borderRadius: 5, background: "transparent", color: "var(--text)", cursor: "pointer", font: "11px/1.2 inherit", textAlign: "left" };
const menuDividerStyle: React.CSSProperties = { height: 1, margin: "2px 3px", background: "var(--border)" };
const confirmStyle: React.CSSProperties = { position: "fixed", zIndex: 1001, left: "50%", top: "50%", width: 280, display: "grid", gap: 10, padding: 14, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", boxShadow: "0 18px 48px rgba(0,0,0,.3)", transform: "translate(-50%, -50%)" };
const secondaryButtonStyle: React.CSSProperties = { height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg)", color: "var(--text)", cursor: "pointer", font: "11px/1 inherit" };
const dangerButtonStyle: React.CSSProperties = { ...secondaryButtonStyle, borderColor: "#ef4444", background: "#ef4444", color: "white" };
