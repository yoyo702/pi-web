import {
  isToolCallEventType,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;
export const BASH_TIMEOUT_ENV = "TIANFORGE_BASH_TIMEOUT_SECONDS";
const MAX_BASH_TIMEOUT_SECONDS = 86_400;

/**
 * Resolve TianForge's safety timeout for model-initiated bash calls.
 *
 * Pi intentionally has no default bash timeout. A value of 0 disables this
 * host-level default, while an explicit timeout supplied by the model always
 * wins.
 */
export function resolveDefaultBashTimeoutSeconds(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return DEFAULT_BASH_TIMEOUT_SECONDS;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_BASH_TIMEOUT_SECONDS;
  if (value === 0) return null;
  return Math.min(MAX_BASH_TIMEOUT_SECONDS, Math.max(1, Math.round(value)));
}
export function applyDefaultBashTimeout(
  input: { timeout?: number },
  timeoutSeconds: number | null,
): boolean {
  if (timeoutSeconds === null || input.timeout !== undefined) return false;
  input.timeout = timeoutSeconds;
  return true;
}

export function createBashWatchdogExtension(
  rawTimeout = process.env[BASH_TIMEOUT_ENV],
): InlineExtension {
  const timeoutSeconds = resolveDefaultBashTimeoutSeconds(rawTimeout);

  return {
    name: "tianforge-bash-watchdog",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event) => {
        if (!isToolCallEventType("bash", event)) return;
        applyDefaultBashTimeout(event.input, timeoutSeconds);
      });
    },
  };
}
