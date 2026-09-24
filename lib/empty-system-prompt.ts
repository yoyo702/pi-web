import type { InlineExtension } from "@earendil-works/pi-coding-agent";

/**
 * Sends an empty system prompt while `shouldForce()` is true (sessions with
 * every tool disabled). pi always renders a non-empty prompt even without
 * tools, and since pi-agent-core 0.87 `agent.state.systemPrompt` is a
 * read-only view of the transcript, so a `before_agent_start` override is the
 * supported way to replace it. It is evaluated for every run, so it survives
 * extension reloads and tool changes without being re-applied.
 */
export function createEmptySystemPromptExtension(shouldForce: () => boolean): InlineExtension {
  return {
    name: "tianforge-empty-system-prompt",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => (shouldForce() ? { systemPrompt: "" } : undefined));
    },
  };
}
