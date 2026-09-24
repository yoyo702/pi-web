"use client";

import { useSyncExternalStore } from "react";

// Mobile breakpoint shared with app/globals.css (max-width: 640px).
const MOBILE_QUERY = "(max-width: 640px)";
const HIDE_DEVTOOLS_QUERY = "(max-width: 768px), (display-mode: standalone), (hover: none) and (pointer: coarse)";

function subscribe(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * Returns true when the viewport is at or below the mobile breakpoint.
 * SSR-safe: renders as desktop (false) on the server and first client paint,
 * then syncs to the real viewport after hydration.
 */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function subscribeDevToolsVisibility(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(HIDE_DEVTOOLS_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getDevToolsVisibilitySnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  const iosStandalone = Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
  return iosStandalone || window.matchMedia(HIDE_DEVTOOLS_QUERY).matches;
}

/**
 * Development overlays are unsuitable for phone-sized, installed-PWA, and
 * coarse-pointer layouts even when a landscape viewport exceeds 640px.
 */
export function useHideDevelopmentTools(): boolean {
  return useSyncExternalStore(subscribeDevToolsVisibility, getDevToolsVisibilitySnapshot, getServerSnapshot);
}

// Shared with the touch-keys block in app/globals.css.
const TOUCH_KEYS_QUERY = "(max-width: 640px), (hover: none) and (pointer: coarse)";

function subscribeTouchKeys(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(TOUCH_KEYS_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getTouchKeysSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(TOUCH_KEYS_QUERY).matches;
}

/**
 * True on phones and on touch-only devices wider than the mobile breakpoint
 * (landscape phones, tablets): they need on-screen terminal keys and a
 * terminal that stays above the on-screen keyboard.
 */
export function useTouchTerminalKeys(): boolean {
  return useSyncExternalStore(subscribeTouchKeys, getTouchKeysSnapshot, getServerSnapshot);
}
