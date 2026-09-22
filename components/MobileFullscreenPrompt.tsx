"use client";

import { useEffect, useState } from "react";
import { Download, Share2, X } from "lucide-react";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

type PromptKind = "hidden" | "install" | "share" | "menu";

interface WebkitFullscreenDocument extends Document {
  webkitFullscreenEnabled?: boolean;
}

interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function canEnterFullscreen(): boolean {
  const root = document.documentElement as WebkitFullscreenElement;
  const fullscreenDocument = document as WebkitFullscreenDocument;
  return (document.fullscreenEnabled && typeof root.requestFullscreen === "function")
    || (fullscreenDocument.webkitFullscreenEnabled === true && typeof root.webkitRequestFullscreen === "function");
}

const DISMISSED_KEY = "tianforge-mobile-install-prompt-dismissed-v2";

function wasDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissed(): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // Storage can be unavailable in private or locked-down browser contexts.
  }
}

export function MobileFullscreenPrompt() {
  const [kind, setKind] = useState<PromptKind>("hidden");
  const [installPrompt, setInstallPrompt] = useState<InstallPromptEvent | null>(null);
  const [fullscreenAvailable, setFullscreenAvailable] = useState(false);

  useEffect(() => {
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {
        // Installation remains available through the browser menu on platforms
        // that do not require a service worker.
      });
    }

    if (isStandalone() || wasDismissed()) return;

    const mobile = window.matchMedia("(max-width: 768px)").matches
      || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!mobile) return;

    const appleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent);
    const supportsFullscreen = canEnterFullscreen();
    setFullscreenAvailable(supportsFullscreen);
    // iOS does not expose beforeinstallprompt. Always keep its Add to Home
    // Screen instructions visible even when this Safari version also supports
    // element fullscreen.
    setKind(appleMobile ? "share" : "menu");

    const onInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPromptEvent);
      // The browser is confirming that this page is installable. Prefer the
      // PWA action instead of hiding it behind the tab-fullscreen action.
      setKind("install");
    };
    const onInstalled = () => setKind("hidden");
    window.addEventListener("beforeinstallprompt", onInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    rememberDismissed();
    setKind("hidden");
  };

  const install = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    setInstallPrompt(null);
    if (choice.outcome === "accepted") setKind("hidden");
  };

  const enterFullscreen = async () => {
    const root = document.documentElement as WebkitFullscreenElement;
    try {
      if (typeof root.requestFullscreen === "function") {
        await root.requestFullscreen({ navigationUI: "hide" });
      } else if (typeof root.webkitRequestFullscreen === "function") {
        await root.webkitRequestFullscreen();
      }
      setKind("hidden");
    } catch {
      setKind(installPrompt ? "install" : /iPhone|iPad|iPod/i.test(navigator.userAgent) ? "share" : "menu");
    }
  };

  if (kind === "hidden") return null;

  const icon = kind === "share" ? <Share2 size={17} /> : <Download size={17} />;
  const instruction = kind === "share"
    ? "Tap Share, then Add to Home Screen. Open TianForge from its new icon for a full-screen view without Safari bars."
    : kind === "install"
      ? "Install TianForge on this phone to open it full screen without the browser address bar."
      : "Open the browser menu and choose Add to Home screen. Then launch TianForge from its icon.";

  return (
    <aside className="mobile-fullscreen-prompt" aria-label="Install TianForge on this phone">
      <span className="mobile-fullscreen-prompt__icon" aria-hidden="true">{icon}</span>
      <div className="mobile-fullscreen-prompt__copy">
        <strong>Install TianForge</strong>
        <span>{instruction}</span>
      </div>
      <div className="mobile-fullscreen-prompt__actions">
        {kind === "install" && (
          <button type="button" className="mobile-fullscreen-prompt__install" onClick={() => void install()}>
            Install app
          </button>
        )}
        {fullscreenAvailable && (
          <button type="button" className="mobile-fullscreen-prompt__secondary" onClick={() => void enterFullscreen()}>
            Full screen
          </button>
        )}
      </div>
      <button type="button" className="mobile-fullscreen-prompt__close" onClick={dismiss} aria-label="Dismiss install tip">
        <X size={16} />
      </button>
    </aside>
  );
}
