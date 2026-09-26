"use client";

import { useEffect } from "react";

/** Escape cancels the dialog; captured first so a dialog underneath does not also close. */
export function useDialogEscape(onCancel: () => void, disabled: boolean) {
  useEffect(() => {
    if (disabled) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [disabled, onCancel]);
}
