"use client";

import { useEffect } from "react";
import { isComposingKeyEvent } from "@/lib/keyboard";

/** Escape cancels the dialog; captured first so a dialog underneath does not also close. */
export function useDialogEscape(onCancel: () => void, disabled: boolean) {
  useEffect(() => {
    if (disabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An IME committing composed text with Escape (e.g. cancelling a
      // candidate window) must not also close the dialog underneath it.
      if (isComposingKeyEvent(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [disabled, onCancel]);
}
