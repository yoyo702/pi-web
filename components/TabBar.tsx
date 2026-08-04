"use client";

import { useState } from "react";
import { getFileIcon } from "./FileIcons";
import type { TerminalLaunchMode, TerminalPermissionMode, TerminalProvider } from "@/lib/agents/terminal";

export interface Tab {
  id: string;
  label: string;
  kind: "pi" | "file" | "git" | "terminal" | "codex-chat";
  closable?: boolean;
  status?: "idle" | "running" | "approval" | "ended";
  filePath?: string;
  sourceSessionId?: string | null;
  terminalId?: string;
  terminalProvider?: TerminalProvider;
  terminalPermissionMode?: TerminalPermissionMode;
  terminalLaunchMode?: TerminalLaunchMode;
  terminalNoAltScreen?: boolean;
  terminalModel?: string | null;
  terminalWebSearch?: boolean;
  terminalChatMode?: boolean;
  cwd?: string;
  model?: string | null;
  reasoningEffort?: string;
  serviceTier?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sessionName?: string;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        background: "var(--bg-panel)",
        overflowX: "auto",
        flexShrink: 0,
        height: 36,
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            onClick={() => onSelectTab(tab.id)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: 36,
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              transition: "background 0.1s, color 0.1s",
            }}
          >
            <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
              {tab.kind === "pi" ? (
                <span style={{ color: "var(--accent)", fontSize: 11, fontWeight: 750 }}>π</span>
              ) : tab.kind === "git" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" />
                  <path d="M8 6h8M6 8v4a6 6 0 0 1-6 6M18 8v4a6 6 0 0 0 6 6" />
                </svg>
              ) : tab.kind === "terminal" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" />
                </svg>
              ) : getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                fontWeight: isActive ? 500 : 400,
              }}
              title={tab.filePath}
            >
              {tab.label}
            </span>
            {tab.status && <span title={tab.status} aria-label={tab.status} style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: tab.status === "approval" ? "#f59e0b" : tab.status === "running" ? "#22c55e" : tab.status === "ended" ? "var(--text-dim)" : "#3b82f6" }} />}
            {tab.closable !== false && <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background 0.1s, color 0.1s",
              }}
              title="Close"
              aria-label={`Close ${tab.label}`}
            >
              <svg width="11" height="11" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>}
          </div>
        );
      })}
    </div>
  );
}
