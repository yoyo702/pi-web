"use client";

import { useEffect, useState } from "react";
import type { TerminalLaunchMode, TerminalPermissionMode, TerminalProvider, TerminalSession } from "@/lib/agents/terminal";

export function NewAgentDialog({ cwd, provider: initialProvider, onClose, onCreated }: { cwd: string; provider: TerminalProvider; onClose: () => void; onCreated: (terminal: TerminalSession) => void }) {
  const [provider, setProvider] = useState<TerminalProvider>(initialProvider);
  const [permissionMode, setPermissionMode] = useState<TerminalPermissionMode>("confirm");
  const [launchMode, setLaunchMode] = useState<TerminalLaunchMode>("new");
  const [noAltScreen, setNoAltScreen] = useState(initialProvider === "codex");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<TerminalSession[]>([]);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/terminals?${new URLSearchParams({ cwd })}`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ terminals?: TerminalSession[] }> : null)
      .then((data) => { if (!cancelled && data?.terminals) setExisting(data.terminals); })
      .catch(() => { /* creation remains available even if listing fails */ });
    return () => { cancelled = true; };
  }, [cwd]);

  useEffect(() => {
    if (busy) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  useEffect(() => {
    setPermissionMode("confirm");
    setLaunchMode("new");
    setNoAltScreen(provider === "codex");
    setAcknowledged(false);
  }, [provider]);

  async function create() {
    if (provider !== "shell" && permissionMode === "bypass" && !acknowledged) return;
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/terminals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, cwd, ...(provider === "shell" ? {} : { permissionMode, launchMode, noAltScreen }) }),
      });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok || !data.terminal) throw new Error(data.error ?? "Unable to start terminal");
      onCreated(data.terminal);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start terminal");
    } finally { setBusy(false); }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="New terminal" style={overlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div style={dialogStyle}>
        <h2 style={{ margin: 0, fontSize: 16 }}>{provider === "shell" ? "New workspace terminal" : "New AI CLI terminal"}</h2>
        <p style={mutedStyle}>{provider === "shell" ? "Starts your default login shell in this authorized workspace." : "Starts the CLI in this authorized workspace."}</p>
        <label style={labelStyle}>Terminal
          <select value={provider} onChange={(event) => setProvider(event.target.value as TerminalProvider)} disabled={busy} style={inputStyle}>
            <option value="shell">Shell</option><option value="codex">Codex</option><option value="claude">Claude</option>
          </select>
        </label>
        <label style={labelStyle}>Workspace
          <input value={cwd} readOnly style={{ ...inputStyle, opacity: .7 }} />
        </label>
        {provider !== "shell" && <fieldset style={{ border: "1px solid var(--border)", borderRadius: 7, margin: "16px 0", padding: 10 }}>
          <legend style={{ color: "var(--text-muted)", fontSize: 12 }}>{provider === "codex" ? "Codex permissions" : "CLI permissions"}</legend>
          {(provider === "codex" ? [
            ["confirm", "Safe", "Ask before untrusted commands; workspace-write sandbox."],
            ["on-request", "Balanced", "Codex decides when to ask; workspace-write sandbox."],
            ["never", "No approval", "Never asks, but keeps workspace-write sandbox."],
            ["bypass", "Dangerous bypass", "Skips all approval and sandboxing."],
          ] : [
            ["confirm", "Keep CLI confirmations", "Claude asks in the terminal."],
            ["bypass", "Dangerous bypass", "Claude skips its permission confirmations."],
          ]).map(([value, label, description]) => (
            <label key={value} style={{ display: "flex", gap: 8, alignItems: "start", color: value === "bypass" ? "#fca5a5" : "var(--text)", fontSize: 13, marginTop: 8 }}>
              <input type="radio" checked={permissionMode === value} onChange={() => setPermissionMode(value as TerminalPermissionMode)} />
              <span><strong>{label}</strong><br /><small style={mutedStyle}>{description}</small></span>
            </label>
          ))}
          {permissionMode === "bypass" && <label style={{ display: "flex", gap: 8, marginTop: 12, color: "#fca5a5", fontSize: 12 }}><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />I understand this mode may edit files and run commands without CLI approval.</label>}
        </fieldset>}
        {provider === "codex" && (
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 7, margin: "16px 0", padding: 10 }}>
            <legend style={{ color: "var(--text-muted)", fontSize: 12 }}>Codex session</legend>
            <label style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--text)" }}><input type="radio" checked={launchMode === "new"} onChange={() => setLaunchMode("new")} />Start a new Codex session</label>
            <label style={{ display: "flex", gap: 8, fontSize: 13, color: "var(--text)", marginTop: 8 }}><input type="radio" checked={launchMode === "resume-last"} onChange={() => setLaunchMode("resume-last")} />Resume latest Codex session for this workspace</label>
            <label style={{ display: "flex", gap: 8, fontSize: 12, color: "var(--text-muted)", marginTop: 10 }}><input type="checkbox" checked={noAltScreen} onChange={(event) => setNoAltScreen(event.target.checked)} />Preserve terminal scrollback (recommended for web reconnects)</label>
          </fieldset>
        )}
        {existing.some((terminal) => terminal.provider === provider) && (
          <section style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginBottom: 14 }}>
            <strong style={{ fontSize: 12, color: "var(--text-muted)" }}>Existing terminals</strong>
            {existing.filter((terminal) => terminal.provider === provider).map((terminal) => (
              <div key={terminal.id} style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, fontSize: 12 }}>
                <span style={{ flex: 1, color: "var(--text)" }}>{terminal.title || terminal.provider} · {terminal.state}{terminal.provider === "shell" ? "" : ` · ${terminal.permissionMode}`}</span>
                <button type="button" disabled={busy || terminal.state !== "running"} onClick={() => onCreated(terminal)} style={{ ...buttonStyle, opacity: terminal.state === "running" ? 1 : .55, cursor: terminal.state === "running" ? "pointer" : "not-allowed" }} title={terminal.state === "running" ? "Attach to this running terminal" : "This terminal has ended; start a new one instead"}>
                  {terminal.state === "running" ? "Attach" : "Ended"}
                </button>
              </div>
            ))}
          </section>
        )}
        {error && <p role="alert" style={{ color: "#f87171", fontSize: 12 }}>{error}</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" onClick={onClose} disabled={busy} style={buttonStyle}>Cancel</button>
          <button type="button" onClick={() => void create()} disabled={busy || (provider !== "shell" && permissionMode === "bypass" && !acknowledged)} style={{ ...buttonStyle, background: "var(--accent)", color: "white", borderColor: "var(--accent)" }}>{busy ? "Starting…" : provider === "shell" ? "Open Terminal" : `Start ${provider}`}</button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", background: "rgba(0,0,0,.55)", padding: 20 };
const dialogStyle: React.CSSProperties = { width: "min(100%, 460px)", border: "1px solid var(--border)", borderRadius: 10, padding: 20, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgba(0,0,0,.45)" };
const mutedStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 12, lineHeight: 1.45, margin: "7px 0 14px" };
const labelStyle: React.CSSProperties = { display: "grid", gap: 6, color: "var(--text-muted)", fontSize: 12, marginTop: 12 };
const inputStyle: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid var(--border)", borderRadius: 6, padding: "8px 9px", background: "var(--bg)", color: "var(--text)", font: "inherit" };
const buttonStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", padding: "7px 11px", cursor: "pointer", font: "inherit", fontSize: 12 };
