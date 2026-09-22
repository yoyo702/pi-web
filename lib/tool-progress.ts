export const MAX_ACTIVE_TOOL_COMMAND_CHARS = 2_000;
export const MAX_ACTIVE_TOOL_OUTPUT_CHARS = 6_000;

function tail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…${value.slice(value.length - maxChars + 1)}`;
}

export function readActiveToolCommand(toolName: string, args: unknown): string | undefined {
  if (toolName !== "bash" || !args || typeof args !== "object") return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim() === "") return undefined;
  return tail(command, MAX_ACTIVE_TOOL_COMMAND_CHARS);
}

export function readActiveToolOutput(partialResult: unknown): string | undefined {
  if (!partialResult || typeof partialResult !== "object") return undefined;
  const content = (partialResult as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((item): item is { type: "text"; text: string } => (
      !!item
      && typeof item === "object"
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
    ))
    .map((item) => item.text)
    .join("\n");
  return text ? tail(text, MAX_ACTIVE_TOOL_OUTPUT_CHARS) : undefined;
}
