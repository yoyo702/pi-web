"use client";

import { useEffect } from "react";

import { hasVisibleModal, shouldAbortOnEscape } from "@/lib/escape-abort";

// ---------------------------------------------------------------------------
// Module-level registry — ChatWindow registers the abort handler here so that
// the global Esc listener in AppShell can call it without prop-drilling.
// ---------------------------------------------------------------------------
let globalAbortHandler: (() => void) | null = null;

/**
 * Register (or clear) the abort handler for the global Esc shortcut.
 * Call this from ChatWindow whenever agentRunning or handleAbort changes.
 */
export function registerAbortHandler(handler: (() => void) | null): void {
  globalAbortHandler = handler;
}

// ---------------------------------------------------------------------------
// Hook: global keyboard shortcuts
// ---------------------------------------------------------------------------

interface UseGlobalKeyboardShortcutsOptions {
  /** Called when Ctrl+Alt+N is pressed. Receives current cwd. */
  onNewSession?: (cwd: string) => void;
  /** The currently selected project directory (sidebar cwd). */
  activeCwd?: string | null;
}

/**
 * Register global keyboard shortcuts for the application.
 *
 * Shortcuts handled here:
 *   Esc          – stop the running agent (via module-level abort handler)
 *   Ctrl+Alt+N   – create a new session in the active project directory
 *
 * Note: Esc inside <textarea> or <input> is deliberately NOT handled here.
 * ChatInput manages its own Esc logic (closing slash / @ file menus, stopping
 * the agent when no menu is open) because it needs intimate knowledge of menu
 * state that is local to that component. Esc is also skipped while a dialog
 * or menu is open (Settings or any other `[aria-modal="true"]` dialog, a
 * native `<dialog>` opened with showModal() such as the Mermaid zoom viewer,
 * or a `role="menu"` dropdown/context menu such as the TianForge app menu),
 * so closing it doesn't also abort the agent.
 */
export function useGlobalKeyboardShortcuts(
  options: UseGlobalKeyboardShortcutsOptions,
): void {
  const { onNewSession, activeCwd } = options;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // ---- Esc: stop agent ----
      if (e.key === "Escape") {
        if (!globalAbortHandler) return;
        // Text fields handle Esc themselves (ChatInput menus / stop); an open
        // dialog or menu owns Esc to close itself — either an `aria-modal`
        // dialog (Settings, etc.), a native `<dialog>` opened via
        // showModal() (e.g. the Mermaid zoom viewer, which has no
        // aria-modal attribute), or a `role="menu"` dropdown/context menu
        // (e.g. the TianForge app menu) — counting only visible ones, not
        // dialogs or menus in hidden workspace tabs.
        // defaultPrevented is checked too, but is only a defensive fallback:
        // this listener runs in the capture phase (see addEventListener
        // below), so it fires before any bubble-phase handler elsewhere in
        // the app (e.g. a dialog's own Esc handler) has a chance to call
        // preventDefault().
        if (!shouldAbortOnEscape({
          targetTag: (e.target as HTMLElement | null)?.tagName,
          defaultPrevented: e.defaultPrevented,
          modalOpen: hasVisibleModal(document),
        })) return;

        e.preventDefault();
        globalAbortHandler();
        return;
      }

      // ---- Ctrl+Alt+N: new session ----
      if (e.key === "n" && e.ctrlKey && e.altKey) {
        if (!activeCwd || !onNewSession) return;
        e.preventDefault();
        onNewSession(activeCwd);
      }
    };

    // Capture phase: run before component-level Esc listeners (e.g. a modal
    // closing itself on Esc via a bubble-phase document listener), so the
    // aria-modal check below still sees the modal while it's open.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeCwd, onNewSession]);
}
