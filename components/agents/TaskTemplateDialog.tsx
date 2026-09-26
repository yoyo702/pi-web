"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { TerminalPermissionMode } from "@/lib/agents/terminal";

/** A saved Claude/Codex terminal launch (server/task-templates.cjs). */
export interface TaskTemplate {
  id: string;
  name: string;
  provider: "codex" | "claude";
  permissionMode: TerminalPermissionMode;
  model: string | null;
  initialPrompt: string | null;
  webSearch: boolean;
  /** null: available in every workspace. */
  cwd: string | null;
  createdAt: string;
  updatedAt: string;
}
export type TaskTemplateDraft = Pick<TaskTemplate, "name" | "provider" | "permissionMode" | "model" | "initialPrompt" | "webSearch" | "cwd">;

/** Fired on `window` after a template is saved or deleted, so every list reloads. */
export const TASK_TEMPLATES_CHANGED_EVENT = "pi-web:task-templates-changed";

/** Permission choices for AI CLI terminals: [value, label, description]. */
export function permissionOptions(provider: "codex" | "claude"): [TerminalPermissionMode, string, string][] {
  return provider === "codex" ? [
    ["confirm", "Safe", "Ask before untrusted commands (on request with Codex 0.155+); workspace-write sandbox."],
    ["on-request", "Balanced", "Codex decides when to ask; workspace-write sandbox."],
    ["never", "No approval", "Never asks, but keeps workspace-write sandbox."],
    ["bypass", "Dangerous bypass", "Skips all approval and sandboxing."],
  ] : [
    ["confirm", "Keep CLI confirmations", "Claude asks in the terminal."],
    ["plan", "Plan", "Read-only until you approve Claude's plan."],
    ["accept-edits", "Accept edits", "Edits files without asking; still confirms commands."],
    ["bypass", "Dangerous bypass", "Claude skips its permission confirmations."],
  ];
}

export function permissionLabel(provider: "codex" | "claude", mode: TerminalPermissionMode): string {
  return permissionOptions(provider).find(([value]) => value === mode)?.[1] ?? mode;
}

export function TaskTemplateDialog({ cwd, template, initial, onClose, onSaved }: {
  cwd: string;
  /** Edits this template; otherwise creates one from `initial`. */
  template?: TaskTemplate;
  initial?: Partial<TaskTemplateDraft>;
  onClose: () => void;
  onSaved?: (template: TaskTemplate) => void;
}) {
  const start = template ?? initial ?? {};
  const [name, setName] = useState(start.name ?? "");
  const [provider, setProvider] = useState<"codex" | "claude">(start.provider ?? "codex");
  const [permissionMode, setPermissionMode] = useState<TerminalPermissionMode>(start.permissionMode ?? "confirm");
  const [model, setModel] = useState(start.model ?? "");
  const [initialPrompt, setInitialPrompt] = useState(start.initialPrompt ?? "");
  const [webSearch, setWebSearch] = useState(start.webSearch ?? false);
  const [scope, setScope] = useState<"workspace" | "all">(template && !template.cwd ? "all" : "workspace");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Editing a template saved for another folder keeps that folder.
  const workspace = template?.cwd ?? cwd;

  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onClose]);

  async function save() {
    setBusy(true); setError(null);
    try {
      const draft: TaskTemplateDraft = { name, provider, permissionMode, model: model.trim() || null, initialPrompt: initialPrompt.trim() || null, webSearch: provider === "codex" && webSearch, cwd: scope === "all" ? null : workspace };
      const response = await fetch(template ? `/api/task-templates/${encodeURIComponent(template.id)}` : "/api/task-templates", {
        method: template ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
      });
      const data = await response.json() as { template?: TaskTemplate; error?: string };
      if (!response.ok || !data.template) throw new Error(data.error ?? "Unable to save template");
      window.dispatchEvent(new Event(TASK_TEMPLATES_CHANGED_EVENT));
      onSaved?.(data.template);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save template");
    } finally { setBusy(false); }
  }

  const folderName = workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace;
  // Portaled so the sidebar's stacking context and resize handles stay underneath.
  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={template ? "Edit template" : "New template"} style={overlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{template ? "Edit template" : "New template"}</h2>
        <p style={mutedStyle}>Saves a Claude or Codex terminal launch that you can start again with one click.</p>
        <label style={labelStyle}>Name
          <input autoFocus value={name} maxLength={80} disabled={busy} onChange={(event) => setName(event.target.value)} placeholder="Review changes" style={inputStyle} />
        </label>
        <label style={labelStyle}>CLI
          <select value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value as "codex" | "claude"); setPermissionMode("confirm"); }} style={inputStyle}>
            <option value="codex">Codex</option><option value="claude">Claude</option>
          </select>
        </label>
        <fieldset style={fieldsetStyle}>
          <legend style={{ color: "var(--text-muted)", fontSize: 12 }}>Permissions</legend>
          {permissionOptions(provider).map(([value, label, description]) => (
            <label key={value} style={{ display: "flex", gap: 8, alignItems: "start", color: value === "bypass" ? "#fca5a5" : "var(--text)", fontSize: 13, marginTop: 8 }}>
              <input type="radio" checked={permissionMode === value} disabled={busy} onChange={() => setPermissionMode(value)} />
              <span><strong>{label}</strong><br /><small style={{ ...mutedStyle, margin: 0 }}>{description}</small></span>
            </label>
          ))}
          {permissionMode === "bypass" && <p style={{ color: "#fca5a5", fontSize: 12, margin: "10px 0 0" }}>You will be asked to confirm each time this template runs.</p>}
        </fieldset>
        <label style={labelStyle}>Model (optional)
          <input value={model} maxLength={120} disabled={busy} onChange={(event) => setModel(event.target.value)} placeholder="Use the CLI default" style={inputStyle} />
        </label>
        <label style={labelStyle}>Initial prompt (optional)
          <textarea value={initialPrompt} maxLength={8000} rows={4} disabled={busy} onChange={(event) => setInitialPrompt(event.target.value)} placeholder="Sent as the first message" style={{ ...inputStyle, resize: "vertical" }} />
        </label>
        {provider === "codex" && <label style={{ display: "flex", gap: 8, marginTop: 12, color: "var(--text-muted)", fontSize: 12 }}><input type="checkbox" checked={webSearch} disabled={busy} onChange={(event) => setWebSearch(event.target.checked)} />Enable live web search</label>}
        <label style={labelStyle}>Available in
          <select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value as "workspace" | "all")} style={inputStyle} title={workspace}>
            <option value="workspace">This workspace ({folderName})</option><option value="all">All workspaces</option>
          </select>
        </label>
        {error && <p role="alert" style={{ color: "#f87171", fontSize: 12 }}>{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" onClick={onClose} disabled={busy} style={buttonStyle}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy || !name.trim()} style={{ ...buttonStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)", opacity: busy || !name.trim() ? .6 : 1 }}>{busy ? "Saving…" : "Save template"}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 1010, display: "grid", placeItems: "center", background: "rgba(0,0,0,.55)", padding: 20 };
const dialogStyle: React.CSSProperties = { width: "min(100%, 460px)", maxHeight: "min(760px, 92vh)", overflowY: "auto", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 10, padding: 20, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgba(0,0,0,.45)" };
const mutedStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45, margin: "7px 0 14px" };
const labelStyle: React.CSSProperties = { display: "grid", gap: 6, color: "var(--text-muted)", fontSize: 12, marginTop: 12 };
const fieldsetStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 7, margin: "16px 0 4px", padding: 10 };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 9px", background: "var(--bg)", color: "var(--text)", font: "inherit" };
const buttonStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", padding: "7px 11px", cursor: "pointer", font: "inherit", fontSize: 12 };
