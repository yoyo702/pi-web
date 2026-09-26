/**
 * Whether a window-level Esc should stop the running agent. Esc belongs to
 * whatever is on top: text fields (ChatInput menus), open modals (Settings,
 * dialogs), and handlers that already called preventDefault.
 */
export function shouldAbortOnEscape(input: { targetTag: string | undefined; defaultPrevented: boolean; modalOpen: boolean }): boolean {
  if (input.defaultPrevented || input.modalOpen) return false;
  return input.targetTag !== "TEXTAREA" && input.targetTag !== "INPUT";
}
