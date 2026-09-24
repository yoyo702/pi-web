"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "@rc-component/qrcode";
import { Check, Copy, ExternalLink, RefreshCw, ShieldCheck, Wifi, X } from "lucide-react";
import { copyText } from "@/lib/clipboard";
import type { AccessAddress, AccessInfo } from "@/lib/access-links";

interface PairingInfo {
  token: string;
  expiresAt: number;
}

export function MobileAccessDialog({ open = true, onClose, embedded = false }: { open?: boolean; onClose: () => void; embedded?: boolean }) {
  const [info, setInfo] = useState<AccessInfo | null>(null);
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPairing(null);
    setPairingError(null);
    try {
      const response = await fetch("/api/access", { cache: "no-store" });
      const data = await response.json() as AccessInfo & { error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to inspect network addresses");
      setInfo(data);
      setSelectedId((current) => {
        if (current && data.addresses.some((address) => address.id === current)) return current;
        return data.addresses.find((address) => address.reachable)?.id ?? data.addresses[0]?.id ?? null;
      });
      if (data.passwordRequired) {
        try {
          const pairingResponse = await fetch("/api/auth/pair", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
          });
          const pairingData = await pairingResponse.json() as Partial<PairingInfo> & { error?: string };
          if (!pairingResponse.ok || typeof pairingData.token !== "string" || typeof pairingData.expiresAt !== "number") {
            throw new Error(pairingData.error || "Unable to create a mobile sign-in link");
          }
          setPairing({ token: pairingData.token, expiresAt: pairingData.expiresAt });
        } catch (cause) {
          setPairingError(cause instanceof Error ? cause.message : "Unable to create a mobile sign-in link");
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to inspect network addresses");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!embedded && !open) return;
    void load();
  }, [embedded, load, open]);

  useEffect(() => {
    if (embedded || !open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [embedded, onClose, open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const selected = useMemo(
    () => info?.addresses.find((address) => address.id === selectedId) ?? null,
    [info, selectedId],
  );
  const pairingUrl = useMemo(() => {
    if (!selected || !pairing) return null;
    const url = new URL("/pair", selected.origin);
    url.searchParams.set("token", pairing.token);
    return url.toString();
  }, [pairing, selected]);

  if (!embedded && !open) return null;

  const copyUrl = async () => {
    if (!selected) return;
    await copyText(pairingUrl ?? selected.origin);
    setCopied(true);
  };

  const content = (
      <section style={embedded ? embeddedDialogStyle : dialogStyle}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 14px", borderBottom: "1px solid var(--border)" }}>
          <Wifi size={16} color="var(--accent)" />
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2 style={{ margin: 0, color: "var(--text)", fontSize: 14 }}>Remote access</h2>
            <p style={{ margin: "3px 0 0", color: "var(--text-dim)", fontSize: 10.5 }}>Choose an address and scan once to sign in on another device.</p>
          </div>
          <button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh addresses" title="Refresh addresses" style={iconButtonStyle}>
            <RefreshCw size={14} className={loading ? "animate-spin" : undefined} />
          </button>
          {!embedded && <button type="button" onClick={onClose} aria-label="Close remote access" title="Close" style={iconButtonStyle}>
            <X size={15} />
          </button>}
        </header>

        <div style={{ padding: 14, overflowY: "auto" }}>
          {error && <div role="alert" style={errorStyle}>{error}</div>}
          {!error && loading && !info && <div style={{ padding: 28, color: "var(--text-dim)", fontSize: 12, textAlign: "center" }}>Inspecting network addresses…</div>}
          {info && (
            <>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                <StatusPill text={info.protocol.toUpperCase()} positive={info.protocol === "https"} />
                <StatusPill text={info.passwordRequired ? "Password protected" : "No password"} positive={info.passwordRequired} />
                <span style={{ color: "var(--text-dim)", fontSize: 10, alignSelf: "center", marginLeft: 2 }}>listening on {info.listenHost}:{info.port}</span>
              </div>

              {info.addresses.length === 0 ? (
                <div style={warningStyle}>No usable LAN or Tailscale address was found. Connect this Mac to Wi-Fi/Ethernet or Tailscale, then refresh.</div>
              ) : (
                <div style={{ display: "grid", gap: 7 }}>
                  {info.addresses.map((address) => (
                    <AddressOption key={address.id} address={address} selected={address.id === selectedId} onSelect={() => setSelectedId(address.id)} />
                  ))}
                </div>
              )}

              {selected && (
                <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", alignItems: "center", gap: 18, marginTop: 16 }}>
                  <div style={{ padding: 10, borderRadius: 10, background: "#fff", lineHeight: 0, opacity: selected.reachable ? 1 : 0.62 }}>
                    <QRCodeSVG value={pairingUrl ?? selected.origin} size={196} level="M" marginSize={2} title={pairingUrl ? "Sign in to TianForge pi" : `Open ${selected.origin}`} />
                  </div>
                  <div style={{ flex: "1 1 220px", minWidth: 0, display: "grid", gap: 10 }}>
                    <div style={{ padding: "9px 10px", border: "1px solid var(--border)", borderRadius: 7, background: "var(--bg)", color: "var(--text)", font: "11px/1.45 var(--font-mono)", overflowWrap: "anywhere", userSelect: "text" }}>{selected.origin}</div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" onClick={() => void copyUrl()} style={primaryButtonStyle}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? "Copied" : pairingUrl ? "Copy sign-in link" : "Copy link"}</button>
                      <button type="button" onClick={() => window.open(selected.origin, "_blank", "noopener,noreferrer")} style={secondaryButtonStyle}><ExternalLink size={13} />Open address</button>
                    </div>
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.5 }}>
                      {selected.kind === "tailscale" ? "The phone must be connected to the same Tailscale network." : "The phone must be on the same local network as this Mac."}
                    </p>
                  </div>
                </div>
              )}

              {selected && !selected.reachable && (
                <div style={warningStyle}>
                  This server is currently bound to <code>{info.listenHost}</code>, so other devices cannot connect yet. Stop it and run <code>npm run dev:https</code>, then reopen this dialog.
                </div>
              )}
              {selected?.reachable && !info.passwordRequired && (
                <div style={warningStyle}>Network access should be password protected. Restart with <code>PI_WEB_PASSWORD</code> configured before sharing this address.</div>
              )}
              {selected?.reachable && info.passwordRequired && (
                pairingUrl
                  ? <div style={safeStyle}><ShieldCheck size={14} />Scan to sign in automatically—no password entry. This link works once and expires at {new Date(pairing!.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</div>
                  : <div style={warningStyle}>Automatic sign-in is unavailable{pairingError ? `: ${pairingError}` : ""}. Refresh after restarting the server, or enter the password on the phone.</div>
              )}
              {selected?.reachable && info.protocol === "https" && (
                <>
                  <p style={{ margin: "10px 2px 0", color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.5 }}>For a full-screen app without browser bars, use Share/Menu → Add to Home Screen on the phone, then open TianForge from its icon.</p>
                  <p style={{ margin: "7px 2px 0", color: "var(--text-dim)", fontSize: 10.5, lineHeight: 1.5 }}>If the phone reports a certificate error, install and trust the local mkcert CA on that phone.</p>
                </>
              )}
            </>
          )}
        </div>
      </section>
  );

  if (embedded) return <div aria-label="Remote access settings" style={embeddedOverlayStyle}>{content}</div>;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Remote access"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={overlayStyle}
    >
      {content}
    </div>
  );
}

function AddressOption({ address, selected, onSelect }: { address: AccessAddress; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={{
        width: "100%", minHeight: 52, display: "flex", alignItems: "center", gap: 10,
        padding: "8px 10px", border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
        borderRadius: 8, background: selected ? "var(--bg-selected)" : "var(--bg)", color: "var(--text)",
        cursor: "pointer", textAlign: "left",
      }}
    >
      <span style={{ width: 9, height: 9, borderRadius: "50%", border: `2px solid ${selected ? "var(--accent)" : "var(--text-dim)"}`, background: selected ? "var(--accent)" : "transparent", boxShadow: selected ? "inset 0 0 0 2px var(--bg-panel)" : "none", flexShrink: 0 }} />
      <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 3 }}>
        <strong style={{ fontSize: 11.5, fontWeight: 650 }}>{address.label}</strong>
        <span style={{ color: "var(--text-muted)", font: "10.5px/1.2 var(--font-mono)", overflowWrap: "anywhere" }}>{address.address}</span>
      </span>
      <span style={{ padding: "3px 6px", borderRadius: 999, background: address.reachable ? "color-mix(in srgb, #22c55e 14%, transparent)" : "var(--bg-hover)", color: address.reachable ? "#22c55e" : "var(--text-dim)", fontSize: 9.5, whiteSpace: "nowrap" }}>{address.reachable ? "Ready" : "Restart needed"}</span>
    </button>
  );
}

function StatusPill({ text, positive }: { text: string; positive: boolean }) {
  return <span style={{ padding: "3px 7px", borderRadius: 999, background: positive ? "color-mix(in srgb, var(--accent) 13%, transparent)" : "var(--bg-hover)", color: positive ? "var(--accent)" : "var(--text-muted)", fontSize: 9.5 }}>{text}</span>;
}

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 1400, display: "grid", placeItems: "center", padding: 14, background: "rgba(0,0,0,.52)" };
const dialogStyle: React.CSSProperties = { width: "min(100%, 520px)", maxHeight: "min(760px, calc(100dvh - 28px))", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--border)", borderRadius: 11, background: "var(--bg-panel)", boxShadow: "0 22px 68px rgba(0,0,0,.48)" };
const embeddedOverlayStyle: React.CSSProperties = { width: "100%", height: "100%", minHeight: 0, overflow: "hidden", background: "var(--bg-panel)" };
const embeddedDialogStyle: React.CSSProperties = { width: "100%", height: "100%", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg-panel)" };
const iconButtonStyle: React.CSSProperties = { width: 28, height: 28, display: "grid", placeItems: "center", padding: 0, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" };
const primaryButtonStyle: React.CSSProperties = { minHeight: 32, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0 11px", border: "1px solid var(--accent)", borderRadius: 6, background: "var(--accent)", color: "#fff", cursor: "pointer", font: "11px/1 inherit" };
const secondaryButtonStyle: React.CSSProperties = { ...primaryButtonStyle, borderColor: "var(--border)", background: "var(--bg-hover)", color: "var(--text)" };
const warningStyle: React.CSSProperties = { marginTop: 12, padding: "9px 10px", border: "1px solid color-mix(in srgb, #f59e0b 35%, var(--border))", borderRadius: 7, background: "color-mix(in srgb, #f59e0b 8%, transparent)", color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.55 };
const safeStyle: React.CSSProperties = { marginTop: 12, display: "flex", alignItems: "center", gap: 7, padding: "8px 10px", borderRadius: 7, background: "color-mix(in srgb, #22c55e 8%, transparent)", color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.45 };
const errorStyle: React.CSSProperties = { padding: "10px 11px", border: "1px solid color-mix(in srgb, #ef4444 35%, var(--border))", borderRadius: 7, background: "color-mix(in srgb, #ef4444 8%, transparent)", color: "#f87171", fontSize: 11.5 };
