import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { bridgeBuffer, bridgeListTerminals, bridgeSend, bridgeStop } from "./terminal-agent-bridge";

const text = (value: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: value }], details });

async function terminalForCwd(id: string, cwd: string) {
  const terminal = (await bridgeListTerminals(cwd)).find((candidate) => candidate.id === id);
  if (!terminal) throw new Error("terminal belongs to a different workspace or no longer exists");
  return terminal;
}

export const terminalTools: ToolDefinition[] = [
  {
    name: "terminal_list",
    label: "Terminal list",
    description: "List interactive Codex and Claude CLI terminals for the current workspace. Use only when the user explicitly asks to inspect or use an external CLI terminal.",
    promptGuidelines: ["Only use terminal tools when the user explicitly asks to interact with a Codex or Claude CLI terminal. Do not automatically delegate work or continuously read terminal output."],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      try {
        const terminals = await bridgeListTerminals(ctx.cwd);
        return text(terminals.length ? terminals.map((terminal) => `${terminal.id}  ${terminal.provider}  ${terminal.state}  ${terminal.permissionMode}`).join("\n") : "No Codex or Claude terminals are running in this workspace.", { terminals });
      } catch (error) { return text(`Unable to list terminals: ${error instanceof Error ? error.message : String(error)}`); }
    },
  },
  {
    name: "terminal_read",
    label: "Terminal read",
    description: "Read a bounded recent ANSI output snapshot from a specified Codex or Claude terminal in the current workspace. Use only when the user explicitly requests it.",
    parameters: Type.Object({ id: Type.String({ description: "Terminal session id" }), maxBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 32768, default: 8192, description: "Maximum recent output bytes to return" })) }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const values = params as { id: string; maxBytes?: number };
        await terminalForCwd(values.id, ctx.cwd);
        const result = await bridgeBuffer(values.id);
        const maxBytes = values.maxBytes ?? 8192;
        const data = new TextDecoder().decode(result.data.subarray(Math.max(0, result.data.length - maxBytes)));
        return text(`${result.truncated ? "[Earlier terminal output was truncated]\n" : ""}${data || "[No output yet]"}`, { state: result.state, truncated: result.truncated });
      } catch (error) { return text(`Unable to read terminal: ${error instanceof Error ? error.message : String(error)}`); }
    },
  },
  {
    name: "terminal_send",
    label: "Terminal send",
    description: "Send an explicit task or reply to a specified Codex or Claude terminal in the current workspace. Use only when the user explicitly asks Pi to send text to that terminal.",
    parameters: Type.Object({ id: Type.String({ description: "Terminal session id" }), text: Type.String({ minLength: 1, maxLength: 32768, description: "Text to send" }), appendNewline: Type.Optional(Type.Boolean({ default: true, description: "Press Enter after sending" })) }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const values = params as { id: string; text: string; appendNewline?: boolean };
        await terminalForCwd(values.id, ctx.cwd);
        await bridgeSend(values.id, values.text + (values.appendNewline === false ? "" : "\r"));
        return text("Sent text to the terminal.");
      } catch (error) { return text(`Unable to send terminal input: ${error instanceof Error ? error.message : String(error)}`); }
    },
  },
  {
    name: "terminal_stop",
    label: "Terminal stop",
    description: "Stop a specified Codex or Claude terminal in the current workspace. Use only when the user explicitly asks to stop it.",
    parameters: Type.Object({ id: Type.String({ description: "Terminal session id" }) }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        const values = params as { id: string };
        await terminalForCwd(values.id, ctx.cwd);
        const terminal = await bridgeStop(values.id);
        return text(`Stopped ${terminal.provider} terminal ${terminal.id}.`, { terminal });
      } catch (error) { return text(`Unable to stop terminal: ${error instanceof Error ? error.message : String(error)}`); }
    },
  },
];
