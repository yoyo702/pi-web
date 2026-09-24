"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";

const SIDEBAR_WIDTH_KEY = "pi-sidebar-w";
const RIGHT_PANEL_WIDTH_KEY = "pi-right-panel-w";

/**
 * Resizable sidebar and right panel widths for the app shell.
 *
 * Widths are exposed as the `--sidebar-w` / `--right-panel-w` CSS variables
 * on the layout root. `null` means "use the CSS default" (260px / 42vw) so the
 * first paint matches the default layout; localStorage rehydrates saved widths.
 */
export function usePanelResize({ onRestoreChat }: { onRestoreChat: () => void }) {
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null);
  const [rightPanelWidth, setRightPanelWidth] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const layoutRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Recover a lock left by an older build or an interrupted hot reload.
    if (document.body.style.userSelect !== "none") return;
    document.body.style.userSelect = "";
    if (document.body.style.cursor.includes("resize")) document.body.style.cursor = "";
    setIsResizing(false);
  }, []);
  useEffect(() => {
    const s = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(s) && s >= 180 && s <= 640) setSidebarWidth(s);
    const r = Number(localStorage.getItem(RIGHT_PANEL_WIDTH_KEY));
    if (Number.isFinite(r) && r >= 320) setRightPanelWidth(Math.min(r, window.innerWidth - 200));
  }, []);

  // While dragging, write the width CSS variable straight to the layout root
  // once per frame and commit React state only on release. Setting state on
  // every mousemove re-rendered the whole shell (sidebar, chat, Markdown).
  const createWidthPreview = useCallback((cssVar: string) => {
    let frame = 0;
    let pending = 0;
    return {
      set(width: number) {
        pending = width;
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          layoutRootRef.current?.style.setProperty(cssVar, `${pending}px`);
        });
      },
      cancel() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
      },
    };
  }, []);

  // Generic edge-drag: `dir` is +1 when dragging the element's right edge
  // (sidebar) and -1 when dragging its left edge (right panel).
  const beginResize = useCallback((
    dir: 1 | -1,
    getStart: () => number,
    setWidth: (w: number) => void,
    storageKey: string,
    clampMax: () => number,
    cssVar: string,
    minWidth = 180,
  ) => (event: ReactMouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = getStart();
    setIsResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    let latest = startW;
    const preview = createWidthPreview(cssVar);
    const onMove = (ev: MouseEvent) => {
      latest = Math.min(clampMax(), Math.max(minWidth, startW + dir * (ev.clientX - startX)));
      preview.set(latest);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") finish();
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", finish);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", finish);
      preview.cancel();
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidth(latest);
      setIsResizing(false);
      try { localStorage.setItem(storageKey, String(Math.round(latest))); } catch {}
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", finish);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", finish);
  }, [createWidthPreview]);

  const beginSidebarResize = beginResize(
    1,
    () => sidebarWidth ?? 260,
    setSidebarWidth,
    SIDEBAR_WIDTH_KEY,
    () => 640,
    "--sidebar-w",
  );
  const beginRightPanelResize = beginResize(
    -1,
    () => rightPanelWidth ?? Math.round(window.innerWidth * 0.42),
    setRightPanelWidth,
    RIGHT_PANEL_WIDTH_KEY,
    () => window.innerWidth - 200,
    "--right-panel-w",
  );
  // In focus mode the right panel fills the chat's old slot, so it no longer
  // has an edge to resize. Dragging its visible left divider restores chat and
  // continues as a normal right-panel resize in one gesture.
  const restoreChatFromResize = useCallback((event: ReactMouseEvent) => {
    const max = () => window.innerWidth - 200;
    const startW = Math.min(max(), Math.max(300, window.innerWidth - event.clientX));
    onRestoreChat();
    setRightPanelWidth(startW);
    beginResize(-1, () => startW, setRightPanelWidth, RIGHT_PANEL_WIDTH_KEY, max, "--right-panel-w", 300)(event);
  }, [beginResize, onRestoreChat]);

  const layoutStyle = {
    ...(sidebarWidth != null ? { ["--sidebar-w"]: `${sidebarWidth}px` } : {}),
    ...(rightPanelWidth != null ? { ["--right-panel-w"]: `${rightPanelWidth}px` } : {}),
  } as CSSProperties;

  return { layoutRootRef, layoutStyle, isResizing, beginSidebarResize, beginRightPanelResize, restoreChatFromResize };
}
