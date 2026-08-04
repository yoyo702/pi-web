"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import type { TerminalSession } from "@/lib/agents/terminal";

export type TerminalConnectionState = "connecting" | "connected" | "reconnecting" | "offline" | "disconnected";

function terminalSocketUrl(id: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/terminals/${encodeURIComponent(id)}/stream`;
}

export function useTerminalSocket({ terminalId, terminalRef, socketRef, syncSize, onTerminalChange }: {
  terminalId: string;
  terminalRef: RefObject<Terminal | null>;
  socketRef: RefObject<WebSocket | null>;
  syncSize: () => void;
  onTerminalChange: (terminal: TerminalSession) => void;
}) {
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectRef = useRef<() => void>(() => undefined);
  const disposedRef = useRef(false);
  const [connection, setConnection] = useState<TerminalConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (disposedRef.current) return;
    clearReconnectTimer();
    if (!navigator.onLine) {
      setConnection("offline");
      setConnectionError("Network is offline. Reconnecting when connectivity returns…");
      return;
    }
    if (document.visibilityState === "hidden") {
      setConnection("disconnected");
      setConnectionError("Terminal disconnected. Reconnecting when this tab becomes visible…");
      return;
    }
    setConnection("reconnecting");
    setConnectionError("Terminal connection interrupted; retrying…");
    const delay = Math.min(15_000, 500 * 2 ** Math.min(reconnectAttemptsRef.current++, 5));
    reconnectTimerRef.current = setTimeout(() => connectRef.current(), delay);
  }, [clearReconnectTimer]);

  const connect = useCallback(() => {
    const xterm = terminalRef.current;
    if (!xterm || disposedRef.current) return;
    clearReconnectTimer();
    const previous = socketRef.current;
    if (previous) {
      previous.onopen = previous.onmessage = previous.onerror = previous.onclose = null;
      previous.close();
    }
    setConnection(reconnectAttemptsRef.current > 0 ? "reconnecting" : "connecting");
    setConnectionError(null);
    const socket = new WebSocket(terminalSocketUrl(terminalId));
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;
    socket.onopen = () => {
      if (socketRef.current !== socket) return;
      reconnectAttemptsRef.current = 0;
      setConnection("connected");
      setConnectionError(null);
      syncSize();
    };
    socket.onmessage = (event) => {
      if (socketRef.current !== socket) return;
      if (typeof event.data === "string") {
        try {
          const control = JSON.parse(event.data) as { type?: string };
          if (control.type === "terminal-snapshot-reset") { xterm.reset(); return; }
        } catch { /* Terminal text from an older server. */ }
        xterm.write(event.data);
      } else xterm.write(new Uint8Array(event.data));
    };
    socket.onerror = () => {
      if (socketRef.current === socket) setConnectionError("Terminal connection failed; retrying…");
    };
    socket.onclose = () => {
      if (socketRef.current !== socket || disposedRef.current) return;
      socketRef.current = null;
      setConnection("disconnected");
      void fetch(`/api/terminals/${encodeURIComponent(terminalId)}`, { cache: "no-store" })
        .then(async (response) => response.ok ? response.json() as Promise<{ terminal?: TerminalSession }> : null)
        .then((data) => {
          if (disposedRef.current) return;
          const latest = data?.terminal;
          if (!latest) { setConnectionError("Terminal is no longer available."); return; }
          onTerminalChange(latest);
          if (latest.state === "running") scheduleReconnect();
          else setConnectionError(null);
        })
        .catch(() => scheduleReconnect());
    };
  }, [clearReconnectTimer, onTerminalChange, scheduleReconnect, socketRef, syncSize, terminalId, terminalRef]);
  connectRef.current = connect;

  useEffect(() => {
    disposedRef.current = false;
    const resume = () => {
      if (!socketRef.current && navigator.onLine && document.visibilityState === "visible") connectRef.current();
    };
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposedRef.current = true;
      clearReconnectTimer();
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      const socket = socketRef.current;
      if (socket) {
        socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
        socket.close();
        socketRef.current = null;
      }
    };
  }, [clearReconnectTimer, socketRef, terminalId]);

  return { socketRef, connection, connectionError, connect };
}
