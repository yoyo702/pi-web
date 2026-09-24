"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronUp, History, Maximize2, Search, Star, X } from "lucide-react";
import type { TerminalSession } from "@/lib/agents/terminal";
import { applyTerminalModifier, asBracketedPaste, getTerminalVisibleHeight, isTerminalCopyShortcut, type TerminalModifier } from "@/lib/terminal-input";
import { useTouchTerminalKeys } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import { useTerminalSocket, type TerminalConnectionState } from "@/hooks/useTerminalSocket";
import { copyText } from "@/lib/clipboard";

function terminalStatus(terminal: TerminalSession, connection: TerminalConnectionState) {
  if (terminal.state === "stopped") return { label: "Stopped", color: "var(--text-dim)" };
  if (terminal.state === "ended") {
    if (terminal.exitCode === 0) return { label: "Exited 0", color: "var(--text-dim)" };
    return { label: terminal.exitCode === null ? "Exited" : `Failed ${terminal.exitCode}`, color: "#f87171" };
  }
  if (connection === "connected") return { label: "Running", color: "#4ade80" };
  if (connection === "connecting") return { label: "Connecting…", color: "#fbbf24" };
  if (connection === "reconnecting") return { label: "Reconnecting…", color: "#fbbf24" };
  if (connection === "offline") return { label: "Offline", color: "#fbbf24" };
  return { label: "Disconnected", color: "#f87171" };
}

export function AgentTerminalPanel({ terminal: initial, splitCandidates = [], splitActive = false, activePane = false, onActivatePane, onConnectionChange, onSplit, onUnsplit, onSwapSplit, onMaximizePane, onClosePane, onRestart, onTerminalChange, onTerminalStarted, onOpenCodexChat }: { terminal: TerminalSession; splitCandidates?: TerminalSession[]; splitActive?: boolean; activePane?: boolean; onActivatePane?: () => void; onConnectionChange?: (connection: TerminalConnectionState) => void; onSplit?: (terminalId: string, direction: "horizontal" | "vertical") => void; onUnsplit?: () => void; onSwapSplit?: () => void; onMaximizePane?: () => void; onClosePane?: () => void; onRestart?: () => void; onTerminalChange?: (terminal: TerminalSession) => void; onTerminalStarted?: (terminal: TerminalSession) => void; onOpenCodexChat?: (terminal: TerminalSession) => void }) {
  const { isDark } = useTheme();
  const isDarkRef = useRef(isDark);
  isDarkRef.current = isDark;
  const touchKeys = useTouchTerminalKeys();
  const panelRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const onConnectionChangeRef = useRef(onConnectionChange);
  onConnectionChangeRef.current = onConnectionChange;
  const [terminal, setTerminal] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modifierRef = useRef<TerminalModifier | null>(null);
  const commandInputRef = useRef("");
  const moreRef = useRef<HTMLDivElement>(null);
  const [modifier, setModifier] = useState<TerminalModifier | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [commandPanel, setCommandPanel] = useState<"history" | "favorites" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<{ resultIndex: number; resultCount: number } | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(initial.title || (initial.provider === "shell" ? "Terminal" : `${initial.provider} terminal`));
  const [history, setHistory] = useState<string[]>(initial.history ?? []);
  const [favorites, setFavorites] = useState<string[]>([]);

  const favoritesKey = `pi-terminal-favorites:${initial.cwd}`;

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(favoritesKey) ?? "[]") as unknown;
      setFavorites(Array.isArray(stored) ? stored.filter((item): item is string => typeof item === "string").slice(0, 50) : []);
    } catch { setFavorites([]); }
  }, [favoritesKey]);

  useEffect(() => {
    try { localStorage.setItem(favoritesKey, JSON.stringify(favorites)); } catch { /* unavailable storage */ }
  }, [favorites, favoritesKey]);

  useEffect(() => {
    if (!moreOpen) return;
    const onPointerDown = (event: PointerEvent) => { if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false); };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") { setMoreOpen(false); terminalRef.current?.focus(); } };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("pointerdown", onPointerDown); document.removeEventListener("keydown", onKeyDown); };
  }, [moreOpen]);

  const setStickyModifier = useCallback((next: TerminalModifier | null) => {
    modifierRef.current = next;
    setModifier(next);
  }, []);

  const transformInput = useCallback((data: string) => {
    const active = modifierRef.current;
    if (!active || !data) return data;
    setStickyModifier(null);
    return applyTerminalModifier(active, data);
  }, [setStickyModifier]);

  const sendInput = useCallback((data: string) => {
    if (terminal.chatInputOwned) return;
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      setError("Terminal is not connected");
      return;
    }
    const value = transformInput(data);
    socket.send(value);
    if (value === "\r" || value === "\n") {
      const command = commandInputRef.current.trim();
      if (command) setHistory((current) => [command, ...current.filter((item) => item !== command)].slice(0, 50));
      commandInputRef.current = "";
    } else if (value === "\x7f" || value === "\b") commandInputRef.current = commandInputRef.current.slice(0, -1);
    else if (value === "\x03" || value === "\x15") commandInputRef.current = "";
    else if (!value.startsWith("\x1b") && value >= " ") commandInputRef.current = (commandInputRef.current + value).slice(-8_000);
  }, [socketRef, terminal.chatInputOwned, transformInput]);

  const updateTerminal = useCallback((next: TerminalSession) => {
    setTerminal(next);
    onTerminalChange?.(next);
  }, [onTerminalChange]);

  const syncSize = useCallback(() => {
    const xterm = terminalRef.current;
    if (!xterm || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;
    const cols = xterm.cols;
    const rows = xterm.rows;
    if (!cols || !rows) return;
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      void fetch(`/api/terminals/${encodeURIComponent(initial.id)}/resize`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cols, rows }),
      });
    }, 80);
  }, [initial.id, socketRef]);
  const { connection, connectionError, connect } = useTerminalSocket({ terminalId: initial.id, terminalRef, socketRef, syncSize, onTerminalChange: updateTerminal });
  const status = terminalStatus(terminal, connection);
  useEffect(() => { onConnectionChangeRef.current?.(connection); }, [connection]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const monoFont = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace";
    const xterm = new Terminal({
      cursorBlink: true,
      fontFamily: `'Sarasa Mono SC', 'Noto Sans Mono CJK SC', 'Source Han Mono SC', ${monoFont}`,
      fontSize: 13,
      letterSpacing: -0.5,
      rescaleOverlappingGlyphs: true,
      theme: isDarkRef.current
        ? { background: "#11151d", foreground: "#d7dee9", cursor: "#aab7c9", selectionBackground: "#30405a" }
        : { background: "#f8faff", foreground: "#1f2937", cursor: "#475569", selectionBackground: "#cfe0ff" },
      convertEol: false,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    const searchAddon = new SearchAddon();
    xterm.loadAddon(searchAddon);
    searchAddonRef.current = searchAddon;
    const searchResultDisposable = searchAddon.onDidChangeResults((result) => setSearchResult(result));
    xterm.attachCustomKeyEventHandler((event) => {
      if (isTerminalCopyShortcut(event, xterm.hasSelection())) {
        if (event.type === "keydown") void copyText(xterm.getSelection()).catch(() => setError("Unable to copy terminal selection"));
        return false;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") { setSearchOpen(true); return false; }
      return true;
    });
    xterm.open(host);
    fit.fit();
    terminalRef.current = xterm;
    const dataDisposable = xterm.onData(sendInput);
    const observer = new ResizeObserver(() => { fit.fit(); syncSize(); });
    observer.observe(host);
    let touchScrolling = false;
    let touchCancelled = false;
    let touchX = 0;
    let touchY = 0;
    let touchRemainder = 0;
    const onTouchStart = (event: TouchEvent) => {
      xterm.focus();
      const touch = event.touches[0];
      touchScrolling = false;
      touchCancelled = event.touches.length !== 1 || !touch;
      touchRemainder = 0;
      if (touch) { touchX = touch.clientX; touchY = touch.clientY; }
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touchCancelled || event.touches.length !== 1 || !touch) return;
      const deltaX = touch.clientX - touchX;
      const deltaY = touch.clientY - touchY;
      if (!touchScrolling) {
        if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 8) { touchCancelled = true; return; }
        if (Math.abs(deltaY) < 8) return;
        touchScrolling = true;
      }
      touchX = touch.clientX;
      touchY = touch.clientY;
      touchRemainder -= deltaY;
      const rowHeight = Math.max(8, host.clientHeight / Math.max(1, xterm.rows));
      const rows = Math.trunc(touchRemainder / rowHeight);
      if (rows) { xterm.scrollLines(rows); touchRemainder -= rows * rowHeight; }
      event.preventDefault();
    };
    const onTouchEnd = () => { touchScrolling = false; touchCancelled = false; touchRemainder = 0; };
    const onContextMenu = (event: MouseEvent) => {
      if (!xterm.hasSelection()) return;
      // xterm paints its selection rather than exposing a DOM Range, so the
      // browser's native Copy item has nothing to read. Right-clicking an
      // xterm selection therefore copies it directly.
      event.preventDefault();
      event.stopPropagation();
      void copyText(xterm.getSelection()).catch(() => setError("Unable to copy terminal selection"));
    };
    host.addEventListener("touchstart", onTouchStart, { passive: true });
    host.addEventListener("touchmove", onTouchMove, { passive: false });
    host.addEventListener("touchend", onTouchEnd);
    host.addEventListener("touchcancel", onTouchEnd);
    host.addEventListener("contextmenu", onContextMenu, { capture: true });
    void document.fonts?.ready.then(() => {
      if (terminalRef.current !== xterm) return;
      fit.fit();
      xterm.refresh(0, xterm.rows - 1);
      syncSize();
    });
    connect();
    return () => {
      dataDisposable.dispose();
      searchResultDisposable.dispose();
      observer.disconnect();
      host.removeEventListener("touchstart", onTouchStart);
      host.removeEventListener("touchmove", onTouchMove);
      host.removeEventListener("touchend", onTouchEnd);
      host.removeEventListener("touchcancel", onTouchEnd);
      host.removeEventListener("contextmenu", onContextMenu, { capture: true });
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
      xterm.dispose();
      terminalRef.current = null;
      if (searchAddonRef.current === searchAddon) searchAddonRef.current = null;
    };
  }, [connect, sendInput, syncSize]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport || !touchKeys) return;
    const panel = panelRef.current;
    if (!panel) return;
    let frame = 0;
    const sync = () => {
      const height = getTerminalVisibleHeight(window.innerHeight, viewport.height, viewport.offsetTop, panel.getBoundingClientRect().top);
      panel.style.height = height === null ? "" : `${height}px`;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => terminalRef.current?.scrollToBottom());
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      panel.style.height = "";
    };
  }, [touchKeys]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.theme = isDark
      ? { background: "#11151d", foreground: "#d7dee9", cursor: "#aab7c9", selectionBackground: "#30405a" }
      : { background: "#f8faff", foreground: "#1f2937", cursor: "#475569", selectionBackground: "#cfe0ff" };
  }, [isDark]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(initial.id)}`, { cache: "no-store" });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok || !data.terminal) throw new Error(data.error ?? "Terminal no longer exists");
      updateTerminal(data.terminal);
      setHistory(data.terminal.history ?? []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to refresh terminal"); }
  }, [initial.id, updateTerminal]);

  useEffect(() => { void refresh(); }, [refresh]);

  const stop = useCallback(async () => {
    setConfirmStop(false);
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminal.id)}/stop`, { method: "POST" });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok || !data.terminal) throw new Error(data.error ?? "Unable to stop terminal");
      updateTerminal(data.terminal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to stop terminal"); }
  }, [terminal.id, updateTerminal]);

  const restartCodex = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          cwd: terminal.cwd,
          permissionMode: terminal.permissionMode,
          launchMode: "new",
          noAltScreen: terminal.noAltScreen,
        }),
      });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok || !data.terminal) throw new Error(data.error ?? "Unable to restart Codex");
      onTerminalStarted?.(data.terminal);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to restart Codex"); }
  }, [onTerminalStarted, terminal.cwd, terminal.noAltScreen, terminal.permissionMode]);

  const copyOutput = useCallback(async () => {
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminal.id)}/buffer`, { cache: "no-store" });
      if (!response.ok) throw new Error("Output unavailable");
      await navigator.clipboard.writeText(await response.text());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to copy output"); }
  }, [terminal.id]);

  const rename = async () => {
    const title = titleDraft.trim();
    if (!title) return;
    try {
      const response = await fetch(`/api/terminals/${encodeURIComponent(terminal.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) });
      const data = await response.json() as { terminal?: TerminalSession; error?: string };
      if (!response.ok || !data.terminal) throw new Error(data.error || "Unable to rename terminal");
      updateTerminal(data.terminal);
      setRenaming(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to rename terminal"); }
  };

  const toggleFavorite = (command: string) => setFavorites((current) => current.includes(command)
    ? current.filter((item) => item !== command)
    : [command, ...current].slice(0, 50));

  const inputSavedCommand = (command: string) => {
    sendInput(command);
    setCommandPanel(null);
    terminalRef.current?.focus();
  };

  const findInTerminal = (previous = false) => {
    if (!searchQuery) return;
    const options = { incremental: true, caseSensitive: false };
    if (previous) searchAddonRef.current?.findPrevious(searchQuery, options);
    else searchAddonRef.current?.findNext(searchQuery, options);
  };

  return (
    <section ref={panelRef} className={`agent-terminal${activePane ? " agent-terminal--active" : ""}`} onPointerDown={onActivatePane} onFocusCapture={onActivatePane}>
      <header className="agent-terminal-header" style={{ minHeight: 36, display: "flex", alignItems: "center", gap: 10, padding: "0 10px", borderBottom: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text-muted)", fontSize: 12 }}>
        {renaming ? <form onSubmit={(event) => { event.preventDefault(); void rename(); }} style={{ display: "flex", gap: 4 }}><input autoFocus value={titleDraft} maxLength={80} onChange={(event) => setTitleDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setTitleDraft(terminal.title || "Terminal"); setRenaming(false); } }} style={{ width: 150, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text)", font: "12px inherit" }} /><button type="submit" style={buttonStyle}>Save</button></form> : <strong style={{ color: "var(--text)" }}>{terminal.title || terminal.provider}</strong>}
        <span className="agent-terminal-cwd" title={terminal.cwd} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{terminal.cwd}</span>
        {terminal.provider !== "shell" && <span className="agent-terminal-permission" title={terminal.permissionMode === "bypass" ? "CLI approval and, for Codex, sandbox are bypassed" : "The agent CLI keeps its configured approval policy"} style={{ color: terminal.permissionMode === "bypass" ? "#f87171" : "#4ade80" }}>{terminal.permissionMode.toUpperCase()}</span>}
        {terminal.chatInputOwned && <span style={{ color: "#fbbf24" }}>CHAT OWNS INPUT</span>}
        <span className="agent-terminal-status" role="status" title={connectionError || status.label} style={{ color: status.color }}>{status.label}</span>
        {splitActive && <div role="group" aria-label="Pane actions" style={{ display: "flex", alignItems: "center", gap: 1 }}><button type="button" onClick={onMaximizePane} title="Maximize this pane" aria-label="Maximize this pane" style={paneButtonStyle}><Maximize2 size={14} /></button><button type="button" onClick={onClosePane} title="Remove this pane from split" aria-label="Remove this pane from split" style={paneButtonStyle}><X size={15} /></button></div>}
        <div ref={moreRef} style={{ position: "relative" }}><button type="button" onClick={() => setMoreOpen((open) => !open)} style={buttonStyle}>More ▾</button>{moreOpen && <div className="agent-terminal-more"><button type="button" onClick={() => { setRenaming(true); setMoreOpen(false); }}>Rename</button><button type="button" onClick={() => { setSearchOpen(true); setMoreOpen(false); }}>Find output</button><button type="button" onClick={() => { void copyOutput(); setMoreOpen(false); }}>Copy output</button><button type="button" onClick={() => { setError(null); connect(); setMoreOpen(false); }}>Reconnect</button>{splitActive && <><button type="button" onClick={() => { onSwapSplit?.(); setMoreOpen(false); }}>Swap panes</button><button type="button" onClick={() => { onUnsplit?.(); setMoreOpen(false); }}>Exit split</button></>}{!splitActive && splitCandidates.map((candidate) => <div key={candidate.id} className="agent-terminal-split-option"><span>Split with {candidate.title || candidate.provider}</span><button type="button" onClick={() => { onSplit?.(candidate.id, "horizontal"); setMoreOpen(false); }}>Right</button><button type="button" onClick={() => { onSplit?.(candidate.id, "vertical"); setMoreOpen(false); }}>Down</button></div>)}{terminal.provider === "codex" && terminal.state === "running" && terminal.sourceSessionId && <button type="button" onClick={() => { onOpenCodexChat?.(terminal); setMoreOpen(false); }}>Open Web Chat</button>}</div>}</div>
        {terminal.state === "running" && <button type="button" onClick={() => setConfirmStop(true)} style={{ ...buttonStyle, color: "#fca5a5" }}>Stop</button>}
        {terminal.state !== "running" && <button type="button" onClick={() => onRestart ? onRestart() : void restartCodex()} style={{ ...buttonStyle, color: "#86efac" }}>Restart</button>}
      </header>
      {(error || connectionError) && <div role="alert" style={{ padding: "6px 10px", color: "#fca5a5", background: "#2a1014", fontSize: 12 }}>{error || connectionError}</div>}
      {searchOpen && <form className="agent-terminal-search" onSubmit={(event) => { event.preventDefault(); findInTerminal(false); }}><Search size={14} /><input autoFocus value={searchQuery} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setSearchOpen(false); terminalRef.current?.focus(); } }} onChange={(event) => { const value = event.target.value; setSearchQuery(value); if (value) searchAddonRef.current?.findNext(value, { incremental: true, caseSensitive: false }); else { searchAddonRef.current?.clearDecorations(); setSearchResult(null); } }} placeholder="Find in terminal" /><span style={{ fontSize: 11, whiteSpace: "nowrap" }}>{searchResult?.resultCount ? `${searchResult.resultIndex + 1}/${searchResult.resultCount}` : "0/0"}</span><button type="button" onClick={() => findInTerminal(true)} title="Previous match"><ChevronUp size={15} /></button><button type="submit" title="Next match"><ChevronDown size={15} /></button><button type="button" onClick={() => { setSearchOpen(false); terminalRef.current?.focus(); }} title="Close search"><X size={15} /></button></form>}
      <div className="agent-terminal-viewport"><div ref={hostRef} className="agent-terminal-xterm" onClick={() => terminalRef.current?.focus()} /></div>
      <div className="agent-terminal-mobile-dock" aria-label="Terminal shortcuts">
        {pasteOpen && <div className="agent-terminal-paste"><textarea value={pasteText} onChange={(event) => setPasteText(event.target.value)} placeholder="Paste or enter a command" autoCapitalize="none" autoCorrect="off" spellCheck={false} /><div><button type="button" onClick={() => setPasteOpen(false)}>Close</button><button type="button" disabled={!pasteText} onClick={() => { sendInput(asBracketedPaste(pasteText)); setPasteText(""); setPasteOpen(false); }}>Send</button></div></div>}
        {commandPanel && <div className="agent-terminal-command-panel"><header><strong>{commandPanel === "history" ? "Recent commands" : "Favorites"}</strong><button type="button" onClick={() => setCommandPanel(null)} aria-label="Close"><X size={16} /></button></header><div>{(commandPanel === "history" ? history : favorites).length === 0 ? <p>No commands yet</p> : (commandPanel === "history" ? history : favorites).slice(0, 20).map((command) => <div className="agent-terminal-command" key={command}><button type="button" onClick={() => inputSavedCommand(command)}>{command}</button><button type="button" className={favorites.includes(command) ? "is-favorite" : ""} onClick={() => toggleFavorite(command)} aria-label="Toggle favorite"><Star size={16} fill={favorites.includes(command) ? "currentColor" : "none"} /></button></div>)}</div></div>}
        <div className="agent-terminal-mobile-actions" onPointerDownCapture={(event) => { event.preventDefault(); terminalRef.current?.focus(); }}><button type="button" onClick={() => { setCommandPanel(commandPanel === "history" ? null : "history"); setPasteOpen(false); }}><History size={16} /></button><button type="button" onClick={() => { setCommandPanel(commandPanel === "favorites" ? null : "favorites"); setPasteOpen(false); }}><Star size={16} /></button><button type="button" onClick={() => sendInput("\r")}>Enter</button><button type="button" onClick={() => sendInput("\x1b")}>Esc</button><button type="button" onClick={() => setPasteOpen((open) => !open)}>Paste</button><button type="button" onClick={() => sendInput("\x1b[A")}><ArrowUp size={16} /></button><button type="button" onClick={() => sendInput("\x1b[D")}><ArrowLeft size={16} /></button><button type="button" onClick={() => sendInput("\x1b[B")}><ArrowDown size={16} /></button><button type="button" onClick={() => sendInput("\x1b[C")}><ArrowRight size={16} /></button><button type="button" onClick={() => sendInput("\t")}>Tab</button><button type="button" onClick={() => sendInput("\x1b[Z")} aria-label="Shift+Tab">⇧Tab</button><button type="button" onClick={() => sendInput("\x03")} aria-label="Ctrl+C">^C</button><button type="button" className={modifier === "ctrl" ? "is-active" : ""} onClick={() => setStickyModifier(modifierRef.current === "ctrl" ? null : "ctrl")}>Ctrl</button><button type="button" className={modifier === "alt" ? "is-active" : ""} onClick={() => setStickyModifier(modifierRef.current === "alt" ? null : "alt")}>Alt</button></div>
      </div>
      {confirmStop && <div role="dialog" aria-modal="true" aria-label="Stop terminal" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmStop(false); }} style={overlayStyle}>
        <section style={dialogStyle}><strong>Stop {terminal.provider} terminal</strong><p style={{ margin: "8px 0 18px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>The running process will be interrupted. Its session history will remain available.</p><div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><button type="button" onClick={() => setConfirmStop(false)} style={dialogButtonStyle}>Cancel</button><button type="button" onClick={() => void stop()} style={{ ...dialogButtonStyle, borderColor: "rgb(239 68 68 / 45%)", background: "rgb(239 68 68 / 10%)", color: "#ef4444" }}>Stop terminal</button></div></section>
      </div>}
    </section>
  );
}

const buttonStyle: React.CSSProperties = { border: 0, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, padding: "4px 5px", whiteSpace: "nowrap" };
const paneButtonStyle: React.CSSProperties = { display: "grid", width: 25, height: 25, padding: 0, placeItems: "center", border: 0, borderRadius: 5, background: "transparent", color: "var(--text-dim)", cursor: "pointer" };
const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 1000, display: "grid", placeItems: "center", padding: 20, background: "rgb(0 0 0 / 55%)" };
const dialogStyle: React.CSSProperties = { width: "min(100%, 400px)", padding: 18, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", boxShadow: "0 20px 60px rgb(0 0 0 / 45%)", fontSize: 14 };
const dialogButtonStyle: React.CSSProperties = { padding: "6px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text)", cursor: "pointer", font: "11.5px/1.3 inherit" };
