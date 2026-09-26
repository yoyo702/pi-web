import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

export function readModelsJson(): Record<string, unknown> {
  const path = getModelsPath();
  if (!existsSync(path)) return { providers: {} };
  const text = readFileSync(path, "utf8");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    // Never treat a broken file as empty: the settings UI would show no
    // providers and its next Save would overwrite the user's file.
    throw new Error(`${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix or remove it, then reload.`);
  }
}
