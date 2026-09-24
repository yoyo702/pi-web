import { existsSync, writeFileSync } from "fs";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * Pi writes a session file only once it has an assistant message, so a fork
 * made at (or before) the first user message would exist only in memory and
 * could not be opened by id. Write its header and entries now.
 */
export function writeUnflushedSession(manager: SessionManager): void {
  const sessionFile = manager.getSessionFile();
  if (!sessionFile || existsSync(sessionFile)) return;
  const header = manager.getHeader();
  if (!header) return;
  const content = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });
}
