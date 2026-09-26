import { completeSimple, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { badRequest, HttpError } from "./http-error";

const MODEL_TIMEOUT_MS = 30_000;

function assistantText(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

/**
 * Sends one prompt to the default model in the user's Pi settings and returns
 * its text. `purpose` finishes "Set a default … before <purpose>" in errors.
 */
export async function completeWithDefaultModel(cwd: string, input: { prompt: string; maxTokens: number; purpose: string }): Promise<{ text: string; provider: string; modelId: string }> {
  const services = await createAgentSessionServices({ cwd, agentDir: getAgentDir() });
  const provider = services.settingsManager.getDefaultProvider();
  const modelId = services.settingsManager.getDefaultModel();
  if (!provider || !modelId) throw badRequest(`Set a default provider and model in Pi settings before ${input.purpose}`);
  const model = services.modelRuntime.getModel(provider, modelId);
  if (!model) throw badRequest(`Default model is unavailable: ${provider}/${modelId}`);
  const resolved = await services.modelRuntime.getAuth(model);
  if (!resolved?.auth.apiKey) throw badRequest(`No API key configured for the default model provider: ${provider}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const message = await completeSimple(model, {
      messages: [{ role: "user", timestamp: Date.now(), content: input.prompt }],
    }, {
      apiKey: resolved.auth.apiKey,
      headers: resolved.auth.headers,
      maxTokens: input.maxTokens,
      timeoutMs: MODEL_TIMEOUT_MS,
      maxRetries: 0,
      cacheRetention: "none",
      signal: controller.signal,
    });
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new HttpError(502, message.errorMessage ?? (controller.signal.aborted ? "The model did not answer in time" : "Model returned an error"));
    }
    const text = assistantText(message);
    if (!text) throw new HttpError(502, "Model returned an empty answer");
    return { text, provider, modelId };
  } finally {
    clearTimeout(timeout);
  }
}
