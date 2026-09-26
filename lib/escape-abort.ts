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
 * Whether a modal is open on screen: an `aria-modal` dialog or a native
 * `<dialog>` opened via showModal(). Workspace tabs stay mounted while hidden,
 * so a dialog left open in a background tab doesn't count.
 */
export function hasVisibleModal(root: Pick<ParentNode, "querySelectorAll">): boolean {
  return Array.from(root.querySelectorAll('[aria-modal="true"], dialog[open]')).some((element) => element.checkVisibility?.() ?? element.getClientRects().length > 0);
}
