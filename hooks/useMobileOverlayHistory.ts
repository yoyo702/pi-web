"use client";

import { useCallback, useEffect, useRef } from "react";

/**
 * On mobile, give open overlays (sidebar drawer, right panel) a history entry
 * so the system back gesture closes them instead of leaving the page.
 */
export function useMobileOverlayHistory({ isMobile, ready, overlayOpen, onBack }: {
  isMobile: boolean;
  /** False until the mobile layout has settled after hydration. */
  ready: boolean;
  overlayOpen: boolean;
  /** Close every overlay after the user navigates back. */
  onBack: () => void;
}) {
  const overlayHistoryRef = useRef(false);
  const overlayHistoryReadyRef = useRef(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!isMobile) {
      overlayHistoryRef.current = false;
      overlayHistoryReadyRef.current = false;
      return;
    }
    const handlePopState = () => {
      if (!overlayHistoryRef.current) return;
      overlayHistoryRef.current = false;
      onBackRef.current();
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile || !ready) return;
    // Hydration starts with the desktop sidebar open and then closes it for
    // mobile. Do not create a disposable history entry during that transition.
    if (!overlayHistoryReadyRef.current) {
      if (!overlayOpen) overlayHistoryReadyRef.current = true;
      return;
    }
    if (overlayOpen && !overlayHistoryRef.current) {
      window.history.pushState({ ...window.history.state, piWebMobileOverlay: true }, "");
      overlayHistoryRef.current = true;
    } else if (!overlayOpen && overlayHistoryRef.current) {
      overlayHistoryRef.current = false;
      if (window.history.state?.piWebMobileOverlay) window.history.back();
    }
  }, [isMobile, ready, overlayOpen]);

  /** Push the history entry before an overlay opens from a non-React path. */
  return useCallback(() => {
    if (!isMobile || overlayHistoryRef.current) return;
    window.history.pushState({ ...window.history.state, piWebMobileOverlay: true }, "");
    overlayHistoryRef.current = true;
  }, [isMobile]);
}
