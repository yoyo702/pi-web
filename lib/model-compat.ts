/** Requirements of Opus 5.5 also apply when served under a custom provider. */
export function normalizeModelCompat<T extends {
  id: string;
  api?: string;
  reasoning?: boolean;
  compat?: object;
  thinkingLevelMap?: Record<string, string | null>;
}>(model: T, providerApi?: string): T {
  if ((model.api ?? providerApi) !== "anthropic-messages"
    || !/^claude-opus-5-5(?:-\d{8})?$/.test(model.id)) return model;
  return {
    ...model,
    reasoning: true,
    compat: { ...model.compat, forceAdaptiveThinking: true, supportsTemperature: false },
    thinkingLevelMap: {
      ...model.thinkingLevelMap,
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
    },
  };
}
