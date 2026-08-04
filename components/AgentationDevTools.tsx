"use client";

import { Agentation } from "agentation";

/** Visual annotation toolbar for local development. HTTPS enables native one-click copy. */
export function AgentationDevTools() {
  if (process.env.NODE_ENV !== "development" || process.env.NEXT_PUBLIC_DISABLE_AGENTATION === "1") return null;
  return <Agentation />;
}
