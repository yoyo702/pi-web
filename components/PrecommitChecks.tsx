"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceStatusSelector } from "@/hooks/useWorkspaceStatus";
import type { GitAiReviewResponse, GitPrecheckFinding, GitPrecheckResponse } from "@/lib/git-types";
import { openWorkReminders } from "@/lib/open-work-reminders";

const OPEN_STORAGE_KEY = "pi-web:precommit-checks-open";

const FINDING_COLORS: Record<GitPrecheckFinding["kind"], string> = {
  "conflict-marker": "#f87171",
  secret: "#f87171",
  "large-file": "#d6a84b",
  debug: "#d6a84b",
  todo: "var(--text-muted)",
};

/**
 * Optional checks above the commit box: local hints about the staged lines,
 * unfinished work in the repository, and an AI review on request. Nothing
 * here blocks a commit.
 */
export function PrecommitChecks({ cwd, repoRoot, stagedCount, statusVersion, onOpenFile }: {
  /** Repository folder the Git APIs are called with. */
  cwd: string;
  repoRoot: string;
  stagedCount: number;
  /** Changes whenever Git status was loaded again, to re-run the local checks. */
  statusVersion: unknown;
  onOpenFile: (repoRelativePath: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [precheck, setPrecheck] = useState<GitPrecheckResponse | null>(null);
  const [precheckError, setPrecheckError] = useState<string | null>(null);
  const [review, setReview] = useState<GitAiReviewResponse | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  // Bumped on a repository switch so a review that is still running is dropped.
  const reviewRequest = useRef(0);
  // A string, so unrelated status stream updates do not re-render the panel.
  const remindersJson = useWorkspaceStatusSelector((snapshot) => JSON.stringify(openWorkReminders(snapshot, [repoRoot, cwd])));
  const reminders = useMemo(() => JSON.parse(remindersJson) as ReturnType<typeof openWorkReminders>, [remindersJson]);

  useEffect(() => {
    try { setOpen(localStorage.getItem(OPEN_STORAGE_KEY) === "1"); } catch { /* storage can be unavailable */ }
  }, []);

  useEffect(() => {
    reviewRequest.current += 1;
    setReviewing(false);
    setReview(null);
    setReviewError(null);
    setPrecheck(null);
    setPrecheckError(null);
  }, [cwd]);

  useEffect(() => {
    if (stagedCount === 0) {
      setPrecheck(null);
      setPrecheckError(null);
      setReview(null);
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/git/precheck?${new URLSearchParams({ cwd })}`, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json() as GitPrecheckResponse & { error?: string };
        if (!response.ok) throw new Error(data.error ?? `Checks failed (${response.status})`);
        setPrecheck(data);
        setPrecheckError(null);
      })
      .catch((cause: unknown) => {
        if (cause instanceof DOMException && cause.name === "AbortError") return;
        setPrecheck(null);
        setPrecheckError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => controller.abort();
  }, [cwd, stagedCount, statusVersion]);

  function toggle() {
    const next = !open;
    setOpen(next);
    try { localStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0"); } catch { /* storage can be unavailable */ }
  }

  async function runReview() {
    if (reviewing) return;
    if (precheck?.findings.some((finding) => finding.kind === "secret")
      && !window.confirm("The staged lines may contain secrets. Send them to the model anyway?")) return;
    const request = ++reviewRequest.current;
    setReviewing(true);
    setReviewError(null);
    try {
      const response = await fetch("/api/git/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd }),
      });
      const data = await response.json() as GitAiReviewResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? `Review failed (${response.status})`);
      if (request === reviewRequest.current) setReview(data);
    } catch (cause) {
      if (request === reviewRequest.current) setReviewError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === reviewRequest.current) setReviewing(false);
    }
  }

  const findings = stagedCount > 0 ? precheck?.findings ?? [] : [];
  const reviewStale = Boolean(review && precheck && review.stagedFingerprint !== precheck.stagedFingerprint);
  const noteCount = findings.length + reminders.length + (review && !reviewStale ? review.issues.length : 0);

  return (
    <section aria-label="Pre-commit checks" style={{ border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg-panel)", fontSize: 11 }}>
      <button type="button" onClick={toggle} aria-expanded={open} title="Optional checks of the staged changes. They never block a commit." style={headerButtonStyle}>
        <span style={{ width: 10, color: "var(--text-dim)" }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontWeight: 650, color: "var(--text-muted)" }}>Pre-commit checks</span>
        <span style={{ marginLeft: "auto", color: noteCount > 0 ? "#d6a84b" : "var(--text-dim)" }}>
          {noteCount === 0 ? "No notes" : noteCount === 1 ? "1 note" : `${noteCount} notes`}
        </span>
      </button>
      {open && (
        <div style={{ maxHeight: 240, overflow: "auto", padding: "2px 10px 8px", display: "flex", flexDirection: "column", gap: 8 }}>
          <CheckGroup title="Staged changes">
            {stagedCount === 0 ? <Dim>Nothing staged.</Dim>
              : precheckError ? <span role="alert" style={{ color: "#f87171" }}>{precheckError}</span>
              : !precheck ? <Dim>Checking…</Dim>
              : findings.length === 0 ? <Dim>Nothing to note in the staged lines.</Dim>
              : (
                <ul style={listStyle}>
                  {findings.map((finding, index) => (
                    <li key={`${finding.path}:${finding.line ?? 0}:${index}`}>
                      <button type="button" onClick={() => onOpenFile(finding.path)} title={`Show ${finding.path}`} style={findingButtonStyle}>
                        <span style={{ color: FINDING_COLORS[finding.kind], fontWeight: 600, flexShrink: 0 }}>{finding.message}</span>
                        <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-muted)", flexShrink: 0 }}>{finding.path}{finding.line ? `:${finding.line}` : ""}</span>
                        {finding.text && <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{finding.text}</span>}
                      </button>
                    </li>
                  ))}
                  {precheck.truncated && <li><Dim>Only part of the staged changes was checked.</Dim></li>}
                </ul>
              )}
          </CheckGroup>
          <CheckGroup title="Open work">
            {reminders.length === 0 ? <Dim>No running agents or failed tasks.</Dim> : (
              <ul style={listStyle}>
                {reminders.map((reminder) => (
                  <li key={reminder.key} style={{ color: reminder.tone === "failed" ? "#f87171" : "var(--text-muted)" }}>{reminder.message}</li>
                ))}
              </ul>
            )}
          </CheckGroup>
          <CheckGroup title="AI review" action={(
            <button type="button" onClick={() => void runReview()} disabled={reviewing || stagedCount === 0} aria-busy={reviewing} title="Ask the default Pi model to summarize the staged changes and point out possible problems" style={{ ...smallButtonStyle, opacity: reviewing || stagedCount === 0 ? 0.5 : 1 }}>
              {reviewing ? "Reviewing…" : review ? "Review again" : "Review with AI"}
            </button>
          )}>
            {reviewError && <span role="alert" style={{ color: "#f87171" }}>{reviewError}</span>}
            {review ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {reviewStale && <span style={{ color: "#d6a84b" }}>Staged changes changed since this review.</span>}
                <div style={{ color: "var(--text)", whiteSpace: "pre-wrap", opacity: reviewStale ? 0.6 : 1 }}>{review.summary}</div>
                {review.issues.length > 0 ? (
                  <ul style={{ ...listStyle, opacity: reviewStale ? 0.6 : 1 }}>
                    {review.issues.map((issue, index) => (
                      <li key={index} style={{ color: "var(--text-muted)" }}>
                        {issue.path && <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)" }}>{issue.path}: </span>}
                        {issue.note}
                      </li>
                    ))}
                  </ul>
                ) : <Dim>No problems pointed out.</Dim>}
                <Dim>Reviewed by {review.provider}/{review.modelId}{review.truncated ? " from a truncated diff" : ""}. AI can be wrong.</Dim>
              </div>
            ) : !reviewError && <Dim>Not reviewed yet.</Dim>}
          </CheckGroup>
        </div>
      )}
    </section>
  );
}

function CheckGroup({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 20 }}>
        <span style={{ color: "var(--text-dim)", fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", fontSize: 10 }}>{title}</span>
        {action && <span style={{ marginLeft: "auto" }}>{action}</span>}
      </div>
      {children}
    </div>
  );
}

function Dim({ children }: { children: React.ReactNode }) {
  return <span style={{ color: "var(--text-dim)" }}>{children}</span>;
}

const headerButtonStyle: React.CSSProperties = { width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", border: "none", background: "transparent", cursor: "pointer", fontSize: 11, textAlign: "left" };
const listStyle: React.CSSProperties = { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 2 };
const findingButtonStyle: React.CSSProperties = { width: "100%", display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, padding: "1px 0", border: "none", background: "transparent", cursor: "pointer", fontSize: 11, textAlign: "left" };
const smallButtonStyle: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 4, padding: "1px 8px", fontSize: 11, fontWeight: 600, cursor: "pointer", background: "var(--bg)", color: "var(--accent)" };
