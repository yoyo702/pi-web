// A model in the Claude Chat menu. `resolved` is the model ID an alias
// currently points to, as Claude lists it in its `initialize` answer.
export type ClaudeModelOption = { id: string; label: string; resolved?: string; description?: string };

// Until Claude lists its models (or when it cannot): the aliases, which
// follow Claude Code's latest version of each family. The menu also takes a
// full model ID to pin one.
export const CLAUDE_MODEL_OPTIONS: ClaudeModelOption[] = [{ id: "fable", label: "Fable" }, { id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }, { id: "haiku", label: "Haiku" }];

/** A menu entry: the name, and the model ID behind it when that differs. */
export function claudeModelMenuLabel(option: ClaudeModelOption) {
  return option.resolved && option.resolved !== option.label ? `${option.label} · ${option.resolved}` : option.label;
}

/**
 * The picked alias or ID, with the model ID it runs: the version Claude
 * reports when it belongs to that pick, else the one Claude lists for it.
 */
export function claudeModelLabel(model: string, reported: string | null, options: ClaudeModelOption[] = CLAUDE_MODEL_OPTIONS, defaultModel: string | null = null) {
  if (!model) return reported || defaultModel || "Default model";
  const option = options.find((candidate) => candidate.id === model);
  if (!option) return model;
  const base = model.replace(/\[.*\]$/, "");
  const resolved = reported && (reported.includes(base) || reported === option.resolved) ? reported : option.resolved;
  return resolved && resolved !== option.label ? `${option.label} · ${resolved}` : option.label;
}
