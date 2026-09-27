"use client";

import type { CSSProperties, ReactNode } from "react";
import { useDialogEscape } from "./use-dialog-escape";

export const dialogOverlayStyle: CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgb(0 0 0 / 55%)" };
export const dialogStyle: CSSProperties = { width: "min(100%, 460px)", maxHeight: "min(720px, 90vh)", overflowY: "auto", padding: 18, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgb(0 0 0 / 45%)" };
export const dialogButtonStyle: CSSProperties = { padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "11.5px/1.3 inherit" };

/** A modal yes/no question; destructive confirms are red. Esc and a click outside cancel. */
export function ConfirmDialog({ title, description, confirmLabel, destructive = false, busy = false, confirmDisabled = busy, onCancel, onConfirm, children }: { title: string; description: string; confirmLabel: string; destructive?: boolean; busy?: boolean; confirmDisabled?: boolean; onCancel: () => void; onConfirm: () => void; children?: ReactNode }) {
  useDialogEscape(onCancel, busy);
  return <div role="dialog" aria-modal="true" aria-label={title} style={dialogOverlayStyle} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section style={{ ...dialogStyle, width: "min(100%, 400px)" }}>
      <strong style={{ display: "block", fontSize: 14 }}>{title}</strong>
      <p style={{ margin: "8px 0 0", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{description}</p>
      {children}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
        <button type="button" disabled={busy} onClick={onCancel} style={dialogButtonStyle}>Cancel</button>
        <button type="button" disabled={confirmDisabled} onClick={onConfirm} style={{ ...dialogButtonStyle, borderColor: destructive ? "rgb(239 68 68 / 45%)" : "var(--accent)", background: destructive ? "rgb(239 68 68 / 10%)" : "var(--accent)", color: destructive ? "#ef4444" : "white", opacity: confirmDisabled ? .5 : 1 }}>{busy ? "Working…" : confirmLabel}</button>
      </div>
    </section>
  </div>;
}
