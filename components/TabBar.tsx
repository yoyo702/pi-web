"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { getFileIcon } from "./FileIcons";
import { ProductBrand } from "./ProductBrand";
import { ProductStatusDot } from "./ProductStatus";
import type { Tab } from "@/lib/workspace/tabs";

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onCloseTabs?: (ids: string[]) => void;
  onToggleTabLocked?: (id: string) => void;
  onRevealFile?: (filePath: string) => void;
  ariaLabel?: string;
}

interface TabContextMenu {
  tabId: string;
  x: number;
  y: number;
}

const contextMenuStyle: CSSProperties = {
  position: "fixed",
  zIndex: 1000,
  width: 190,
  padding: 5,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "var(--bg-panel)",
  boxShadow: "0 12px 32px rgb(0 0 0 / 35%)",
};

const contextMenuItemStyle: CSSProperties = {
  width: "100%",
  minHeight: 30,
  display: "flex",
  alignItems: "center",
  padding: "0 9px",
  border: 0,
  borderRadius: 5,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  font: "12px/1.2 inherit",
  textAlign: "left",
};

function isTabClosable(tab: Tab): boolean {
  return tab.closable !== false && !tab.locked;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab, onCloseTabs, onToggleTabLocked, onRevealFile, ariaLabel = "Open tabs" }: Props) {
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<TabContextMenu | null>(null);
  const [copiedFilePath, setCopiedFilePath] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLDivElement>());
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supportsTabManagement = Boolean(onCloseTabs && onToggleTabLocked);

  useEffect(() => {
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs.length]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const closeOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnKeyDown);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnKeyDown);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

  const contextTabIndex = contextMenu ? tabs.findIndex((tab) => tab.id === contextMenu.tabId) : -1;
  const contextTab = contextTabIndex >= 0 ? tabs[contextTabIndex] : null;
  const closeableIds = (candidates: Tab[]) => candidates.filter(isTabClosable).map((tab) => tab.id);
  const leftIds = contextTabIndex >= 0 ? closeableIds(tabs.slice(0, contextTabIndex)) : [];
  const rightIds = contextTabIndex >= 0 ? closeableIds(tabs.slice(contextTabIndex + 1)) : [];
  const otherIds = contextTab ? closeableIds(tabs.filter((tab) => tab.id !== contextTab.id)) : [];
  const allIds = closeableIds(tabs);

  const runMenuAction = (action: () => void) => {
    setContextMenu(null);
    action();
  };

  const copyFilePath = async (filePath: string) => {
    try {
      await navigator.clipboard.writeText(filePath);
    } catch {
      const area = document.createElement("textarea");
      area.value = filePath;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    setCopiedFilePath(filePath);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedFilePath(null), 1600);
  };

  const menuItem = (label: string, disabled: boolean, action: () => void, closeMenu = true) => (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => closeMenu ? runMenuAction(action) : action()}
      style={{ ...contextMenuItemStyle, opacity: disabled ? 0.4 : 1, cursor: disabled ? "default" : "pointer" }}
    >
      {label}
    </button>
  );

  return (
    <>
      <div
        ref={scrollRef}
        role="tablist"
        aria-label={ariaLabel}
        onWheel={(event) => {
          const element = event.currentTarget;
          if (element.scrollWidth <= element.clientWidth) return;
          const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
          if (!delta) return;
          event.preventDefault();
          element.scrollLeft += delta;
        }}
        style={{
          display: "flex",
          alignItems: "flex-end",
          background: "var(--bg-panel)",
          overflowX: "auto",
          overscrollBehaviorX: "contain",
          flexShrink: 0,
          height: 36,
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const closable = isTabClosable(tab);
          return (
            <div
              key={tab.id}
              ref={(element) => { if (element) tabRefs.current.set(tab.id, element); else tabRefs.current.delete(tab.id); }}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              aria-label={tab.label}
              data-tab-id={tab.id}
              data-locked={tab.locked ? "true" : "false"}
              onClick={() => { setContextMenu(null); onSelectTab(tab.id); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelectTab(tab.id); }
                if ((event.key === "Delete" || event.key === "Backspace") && closable) { event.preventDefault(); onCloseTab(tab.id); }
              }}
              onContextMenu={(event) => {
                if (!supportsTabManagement) return;
                event.preventDefault();
                onSelectTab(tab.id);
                setContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
              }}
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1 || !closable) return;
                event.preventDefault();
                event.stopPropagation();
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
              {tab.kind !== "pi" && <span style={{ flexShrink: 0, opacity: isActive ? 1 : 0.7, display: "flex", alignItems: "center" }}>
                {tab.kind === "git" ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" />
                    <path d="M8 6h8M6 8v4a6 6 0 0 1-6 6M18 8v4a6 6 0 0 0 6 6" />
                  </svg>
                ) : tab.kind === "terminal" ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" />
                  </svg>
                ) : tab.kind === "codex-chat" || tab.kind === "claude-chat" ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                ) : getFileIcon(tab.label, 13)}
              </span>}
              <span
                style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1, fontWeight: isActive ? 500 : 400 }}
                title={tab.kind === "file" ? tab.filePath : undefined}
              >
                {tab.kind === "pi" ? <ProductBrand size={12} mutedPi={false} style={{ fontWeight: isActive ? 650 : 550 }} /> : tab.label}
              </span>
              {tab.status && <ProductStatusDot status={tab.status} size={6} />}
              {tab.locked && (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-label="Locked" style={{ flexShrink: 0, color: "var(--text-dim)" }}>
                  <rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
              )}
              {closable && <button
                onClick={(event) => { event.stopPropagation(); onCloseTab(tab.id); }}
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
      {contextMenu && contextTab && onCloseTabs && onToggleTabLocked && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${contextTab.label} tab actions`}
          style={{
            ...contextMenuStyle,
            left: Math.max(4, Math.min(contextMenu.x, window.innerWidth - 198)),
            top: Math.max(4, Math.min(contextMenu.y, window.innerHeight - 304)),
          }}
        >
          {contextTab.kind === "file" && contextTab.filePath && onRevealFile && menuItem("Reveal in File Explorer", false, () => onRevealFile(contextTab.filePath))}
          {contextTab.kind === "file" && contextTab.filePath && menuItem(copiedFilePath === contextTab.filePath ? "File Path Copied" : "Copy File Path", false, () => { void copyFilePath(contextTab.filePath); }, false)}
          {contextTab.kind === "file" && contextTab.filePath && <div role="separator" style={{ height: 1, margin: "4px 3px", background: "var(--border)" }} />}
          {menuItem(contextTab.locked ? "Unlock Tab" : "Lock Tab", false, () => onToggleTabLocked(contextTab.id))}
          <div role="separator" style={{ height: 1, margin: "4px 3px", background: "var(--border)" }} />
          {menuItem("Close Tab", !isTabClosable(contextTab), () => onCloseTabs([contextTab.id]))}
          {menuItem("Close Tabs to the Left", leftIds.length === 0, () => onCloseTabs(leftIds))}
          {menuItem("Close Tabs to the Right", rightIds.length === 0, () => onCloseTabs(rightIds))}
          {menuItem("Close Other Tabs", otherIds.length === 0, () => onCloseTabs(otherIds))}
          {menuItem("Close All Tabs", allIds.length === 0, () => onCloseTabs(allIds))}
        </div>,
        document.body,
      )}
    </>
  );
}
