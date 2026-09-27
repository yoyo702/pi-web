/** Minimal shape shared by DOM KeyboardEvent and React's KeyboardEvent. */
type KeyEventLike = { isComposing?: boolean; keyCode: number } | { nativeEvent: KeyboardEvent };

/** True while an IME is composing text: the key press belongs to the
 * composition (e.g. the Enter or Escape that commits or cancels a
 * candidate), so it must not also trigger the app's own shortcut. keyCode
 * 229 covers browsers (notably Safari) that report `isComposing` false for
 * the committing key. Accepts a DOM KeyboardEvent or a React KeyboardEvent. */
export function isComposingKeyEvent(event: KeyEventLike): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  return Boolean(native.isComposing) || native.keyCode === 229;
}
