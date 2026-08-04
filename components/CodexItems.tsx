"use client";

import { MarkdownBody } from "./MarkdownBody";

export type CodexItem =
  | { kind: "command"; command: string; cwd?: string; output?: string | null; exitCode?: number | null; done: boolean }
  | { kind: "fileChange"; files: string[]; done: boolean }
  | { kind: "tool"; name: string; output?: string | null; done: boolean }
  | { kind: "plan"; text: string };

export function CodexItemCard({ item, cwd }: { item: CodexItem; cwd: string }) {
  if (item.kind === "plan") return <section style={cardStyle}><strong>Plan</strong><MarkdownBody cwd={cwd}>{item.text}</MarkdownBody></section>;
  if (item.kind === "command") return <section style={cardStyle}><div style={titleStyle}>{item.done ? "✓" : "…"} Command {item.exitCode != null && `(exit ${item.exitCode})`}</div><code style={codeStyle}>{item.command}</code>{item.cwd && <div style={mutedStyle}>{item.cwd}</div>}{item.output && <pre style={outputStyle}>{item.output}</pre>}</section>;
  if (item.kind === "fileChange") return <section style={cardStyle}><div style={titleStyle}>{item.done ? "✓" : "…"} File changes</div>{item.files.map((file) => <code key={file} style={{ ...codeStyle, display: "block", marginTop: 4 }}>{file}</code>)}</section>;
  return <section style={cardStyle}><div style={titleStyle}>{item.done ? "✓" : "…"} {item.name}</div>{item.output && <pre style={outputStyle}>{item.output}</pre>}</section>;
}
const cardStyle: React.CSSProperties = { margin: "10px 0", padding: 10, border: "1px solid var(--border)", borderRadius: 7, background: "var(--tool-bg)", color: "var(--text)" };
const titleStyle: React.CSSProperties = { fontSize: 12, color: "var(--text-muted)", marginBottom: 7 };
const mutedStyle: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)", marginTop: 5 };
const codeStyle: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12, whiteSpace: "pre-wrap" };
const outputStyle: React.CSSProperties = { maxHeight: 220, overflow: "auto", margin: "8px 0 0", padding: 8, borderRadius: 4, background: "var(--bg)", fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "pre-wrap" };
