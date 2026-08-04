"use client";

import { MarkdownBody } from "../../MarkdownBody";
import type { CodexConversationItem } from "@/lib/agents/codex-conversation";

export function CodexConversationView({ items, cwd }: { items: CodexConversationItem[]; cwd: string }) {
  return <>{items.map((item) => {
    if (item.kind === "message") return item.role === "user"
      ? <div key={item.id} style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}><div style={{ maxWidth: "82%", whiteSpace: "pre-wrap", padding: "10px 12px", borderRadius: 9, background: "var(--user-bg)", color: "var(--text)", fontSize: 14 }}>{item.text}</div></div>
      : <section key={item.id} style={{ marginBottom: 18, color: "var(--text)", fontSize: 14 }}><div style={labelStyle}>Codex</div><MarkdownBody cwd={cwd} isStreaming={item.streaming}>{item.text}</MarkdownBody></section>;
    if (item.kind === "reasoning") return <details key={item.id} style={cardStyle}><summary>Reasoning</summary><MarkdownBody cwd={cwd}>{item.summary || item.content}</MarkdownBody></details>;
    if (item.kind === "plan") return <section key={item.id} style={cardStyle}><div style={labelStyle}>Plan</div><MarkdownBody cwd={cwd} isStreaming={item.streaming}>{item.text}</MarkdownBody></section>;
    if (item.kind === "command") return <section key={item.id} style={cardStyle}><div style={labelStyle}>{item.done ? "✓" : "…"} Command {item.exitCode != null && `(exit ${item.exitCode})`}</div><code>{item.command}</code>{item.cwd && <div style={mutedStyle}>{item.cwd}</div>}{item.output && <pre style={outputStyle}>{item.output}</pre>}</section>;
    if (item.kind === "fileChange") return <section key={item.id} style={cardStyle}><div style={labelStyle}>{item.done ? "✓" : "…"} File changes</div>{item.files.map((file) => <code key={file} style={{ display: "block" }}>{file}</code>)}</section>;
    if (item.kind === "tool") return <section key={item.id} style={cardStyle}><div style={labelStyle}>{item.done ? "✓" : "…"} {item.title}</div>{item.output && <pre style={outputStyle}>{item.output}</pre>}</section>;
    return <section key={item.id} style={cardStyle}><div style={labelStyle}>Review</div><MarkdownBody cwd={cwd}>{item.text}</MarkdownBody></section>;
  })}</>;
}
const cardStyle: React.CSSProperties = { margin: "10px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--tool-bg)", color: "var(--text)" };
const labelStyle: React.CSSProperties = { color: "var(--text-muted)", fontSize: 12, marginBottom: 7 };
const mutedStyle: React.CSSProperties = { color: "var(--text-dim)", fontSize: 11, marginTop: 5 };
const outputStyle: React.CSSProperties = { maxHeight: 220, overflow: "auto", margin: "8px 0 0", padding: 8, background: "var(--bg)", fontSize: 11, whiteSpace: "pre-wrap" };
