"use client";

import type { ReactNode } from "react";
import type { SideTab } from "@/lib/workspace/tabs";

export function SidePanel({ tab, renderTab }: { tab: SideTab | null; renderTab: (tab: SideTab) => ReactNode }) {
  // A file tab with an empty path (possible from persisted state) shows the placeholder, as before the extraction.
  if (!tab || (tab.kind === "file" && !tab.filePath)) {
    return <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>No file open</div>;
  }
  return <>{renderTab(tab)}</>;
}
