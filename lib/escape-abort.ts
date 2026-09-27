/**
 * Whether a window-level Esc should stop the running agent. Esc belongs to
 * whatever is on top: text fields (ChatInput menus), open modals (Settings,
 * dialogs), and handlers that already called preventDefault.
 */
export function shouldAbortOnEscape(input: { targetTag: string | undefined; defaultPrevented: boolean; modalOpen: boolean }): boolean {
  if (input.defaultPrevented || input.modalOpen) return false;
  return input.targetTag !== "TEXTAREA" && input.targetTag !== "INPUT";
}

/**
 * Whether a modal or menu is open on screen: an `aria-modal` dialog, a native
 * `<dialog>` opened via showModal(), or a `role="menu"` dropdown/context menu
 * (TabBar, ProjectRail, SessionSidebar, FileExplorer, AgentsPanel, etc. all
 * use this role). Workspace tabs stay mounted while hidden, so a dialog or
 * menu left open in a background tab doesn't count.
 */
export function hasVisibleModal(root: Pick<ParentNode, "querySelectorAll">): boolean {
  return Array.from(root.querySelectorAll('[aria-modal="true"], dialog[open], [role="menu"]')).some((element) => element.checkVisibility?.() ?? element.getClientRects().length > 0);
}
