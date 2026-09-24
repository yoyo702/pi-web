"use client";

import { useEffect } from "react";
import { useHideDevelopmentTools } from "@/hooks/useIsMobile";

const MOBILE_NEXT_DEVTOOLS_STYLE_ID = "tianforge-mobile-next-devtools";

/** Hide Next's development-only N indicator without suppressing error dialogs. */
export function MobileDevToolsGuard() {
  const hideDevTools = useHideDevelopmentTools();

  useEffect(() => {
    if (process.env.NODE_ENV !== "development" || !hideDevTools) return;

    const installStyle = () => {
      for (const portal of document.querySelectorAll("nextjs-portal")) {
        const root = portal.shadowRoot;
        if (!root || root.getElementById(MOBILE_NEXT_DEVTOOLS_STYLE_ID)) continue;
        const style = document.createElement("style");
        style.id = MOBILE_NEXT_DEVTOOLS_STYLE_ID;
        style.textContent = `#devtools-indicator,[data-nextjs-dev-tools-button="true"]{display:none!important;pointer-events:none!important}`;
        root.appendChild(style);
      }
    };

    installStyle();
    const observer = new MutationObserver(installStyle);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const portal of document.querySelectorAll("nextjs-portal")) {
        portal.shadowRoot?.getElementById(MOBILE_NEXT_DEVTOOLS_STYLE_ID)?.remove();
      }
    };
  }, [hideDevTools]);

  return null;
}
