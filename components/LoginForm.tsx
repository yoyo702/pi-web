"use client";

import { FormEvent, useState } from "react";
import { ProductBrand } from "./ProductBrand";

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedPassword = String(new FormData(event.currentTarget).get("password") ?? "");
    if (!submittedPassword) {
      setError("Enter the password to continue");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: submittedPassword }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Login failed");
      const verification = await fetch("/api/auth/session", { credentials: "include", cache: "no-store" });
      const session = await verification.json() as { authenticated?: boolean };
      if (!verification.ok || !session.authenticated) {
        throw new Error("Password accepted, but this browser did not save the login cookie. Allow cookies for this site, then try again.");
      }
      window.location.replace("/");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "var(--bg)", padding: 20 }}>
      <form action="/login" method="post" onSubmit={submit} style={{ width: "min(100%, 360px)", border: "1px solid var(--border)", borderRadius: 10, padding: 24, background: "var(--bg-panel)", boxShadow: "0 14px 40px rgba(0,0,0,.18)" }}>
        <h1 style={{ margin: 0, fontSize: 18, color: "var(--text)", display: "flex", alignItems: "baseline", gap: 5 }}>Sign in to <ProductBrand size={18} /></h1>
        <p style={{ margin: "8px 0 20px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>This TianForge instance is password protected. Signing in grants access to local projects and terminal sessions.</p>
        <label style={{ display: "grid", gap: 7, fontSize: 12, color: "var(--text-muted)" }}>
          Password
          <input autoFocus name="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} onInput={(event) => setPassword(event.currentTarget.value)} disabled={busy} style={{ background: "var(--bg)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, padding: "9px 10px", font: "inherit" }} />
        </label>
        {error && <p role="alert" style={{ color: "#f87171", margin: "12px 0 0", fontSize: 12 }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ width: "100%", marginTop: 18, border: 0, borderRadius: 6, padding: "10px 12px", background: "var(--accent)", color: "white", cursor: busy ? "wait" : "pointer", opacity: busy ? .6 : 1, fontWeight: 600 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
