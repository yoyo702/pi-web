"use client";

import { useEffect, useRef, useState } from "react";
import { isPossibleAuthExpiry } from "@/lib/auth-expiry";

export function AuthExpiredNotice({ open }: { open: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Hooks must run unconditionally, before the `!open` early return below.
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);

  if (!open) return null;
  return <div ref={dialogRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="auth-expired-title" aria-describedby="auth-expired-detail" style={{ position: "fixed", inset: 0, zIndex: 10000, display: "grid", placeItems: "center", padding: 16, background: "rgba(0,0,0,.45)" }}>
    <div style={{ width: "min(100%, 380px)", padding: 22, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 14px 40px rgba(0,0,0,.25)" }}>
      <h2 id="auth-expired-title" style={{ margin: "0 0 8px", fontSize: 16 }}>Signed out</h2>
      <p id="auth-expired-detail" style={{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.5, color: "var(--text-muted)" }}>Your login expired, so TianForge can&apos;t reach the server. Sign in again in a new tab; this tab reconnects when you come back, and your drafts stay here.</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: "6px 14px", background: "none", border: "1px solid var(--border)", borderRadius: 6, color: "var(--text-muted)", cursor: "pointer", fontSize: 13 }}>Reload</button>
        <a href="/login" target="_blank" rel="noopener" style={{ padding: "6px 14px", borderRadius: 6, background: "var(--accent)", color: "#fff", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>Sign in</a>
      </div>
    </div>
  </div>;
}

/** Shows AuthExpiredNotice while the server says this browser is signed out. */
export function AuthExpiryGuard() {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    const originalFetch = window.fetch;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await originalFetch("/api/auth/session", { cache: "no-store" });
        const body = await response.json() as { authenticated?: boolean };
        setExpired(body.authenticated === false);
      } catch {
        // Offline or restarting: not a login problem.
      } finally {
        checking = false;
      }
    };
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isPossibleAuthExpiry(url, response.status, window.location.origin)) void check();
      return response;
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.fetch = originalFetch;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <AuthExpiredNotice open={expired} />;
}
