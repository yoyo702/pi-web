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

// Touch-only devices report a coarse pointer, but a tablet with a keyboard,
// trackpad, or stylus attached may not, so also count any real touch/pen
// input seen on this device, and let the user force the keys on or off.
const TOUCH_KEYS_QUERY = "(max-width: 640px), (hover: none) and (pointer: coarse)";
const TOUCH_SEEN_KEY = "pi-web:touch-input-seen";
const TOUCH_KEYS_OVERRIDE_KEY = "pi-web:terminal-touch-keys";

export type TouchKeysOverride = "on" | "off" | null;

const touchKeyListeners = new Set<() => void>();
let touchWatchInstalled = false;

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* private mode: the choice lasts for this page only */ }
}

function notifyTouchKeys(): void {
  for (const listener of touchKeyListeners) listener();
}

function installTouchWatch(): void {
  if (touchWatchInstalled || readStorage(TOUCH_SEEN_KEY) === "1") return;
  touchWatchInstalled = true;
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
    writeStorage(TOUCH_SEEN_KEY, "1");
    window.removeEventListener("pointerdown", onPointerDown, true);
    notifyTouchKeys();
  };
  window.addEventListener("pointerdown", onPointerDown, true);
}

function subscribeTouchKeys(cb: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  installTouchWatch();
  const mql = window.matchMedia(TOUCH_KEYS_QUERY);
  touchKeyListeners.add(cb);
  mql.addEventListener("change", cb);
  return () => {
    touchKeyListeners.delete(cb);
    mql.removeEventListener("change", cb);
  };
}

function getTouchKeysOverride(): TouchKeysOverride {
  if (typeof window === "undefined") return null;
  const value = readStorage(TOUCH_KEYS_OVERRIDE_KEY);
  return value === "on" || value === "off" ? value : null;
}

function getTouchKeysSnapshot(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  const override = getTouchKeysOverride();
  if (override) return override === "on";
  return window.matchMedia(TOUCH_KEYS_QUERY).matches || readStorage(TOUCH_SEEN_KEY) === "1";
}

/** Force the terminal touch keys on or off on this device; null returns to automatic. */
export function setTouchKeysOverride(value: TouchKeysOverride): void {
  writeStorage(TOUCH_KEYS_OVERRIDE_KEY, value);
  notifyTouchKeys();
}

/**
 * True when the terminal should show on-screen keys (Esc, arrows, modifiers)
 * and stay above the on-screen keyboard: phones, touch-only devices wider than
 * the mobile breakpoint, any device where touch input has been seen, or when
 * the user turned them on.
 */
export function useTouchTerminalKeys(): boolean {
  return useSyncExternalStore(subscribeTouchKeys, getTouchKeysSnapshot, getServerSnapshot);
}
