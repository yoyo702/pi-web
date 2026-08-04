"use client";

import { Agentation } from "agentation";

/** Visual annotation toolbar for local development. HTTPS enables native one-click copy. */
export function AgentationDevTools() {
  if (process.env.NODE_ENV !== "development") return null;
  return <Agentation />;
}
