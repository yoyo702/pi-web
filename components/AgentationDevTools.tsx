"use client";

import { useEffect, useState } from "react";
import { Agentation } from "agentation";
import { useHideDevelopmentTools } from "@/hooks/useIsMobile";

/** Visual annotation toolbar for local development. HTTPS enables native one-click copy. */
export function AgentationDevTools() {
  const hideDevTools = useHideDevelopmentTools();
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  // Wait for the real client viewport before mounting. This avoids briefly
  // rendering Agentation's floating toolbar from the desktop SSR snapshot on
  // phones, and fully unmounts its portal/overlay when the layout is mobile.
  if (!hydrated || hideDevTools || process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_DISABLE_AGENTATION === "1") return null;
  return <Agentation />;
}
