"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { claudeConversationItems, type ClaudeRecord } from "@/lib/agents/claude-conversation";
import type { AssistantMessage, BashExecutionMessage, ToolResultMessage } from "@/lib/types";
import { MessageView } from "../../MessageView";
import { useCoarsePointer } from "@/hooks/useIsMobile";
import { formatRunDuration } from "@/lib/run-duration";

export type ClaudeAgentProgress = { description?: string; lastTool?: string; status?: string; toolUses?: number; durationMs?: number };
export type ClaudeAgentSources = { sessionId: string | null; cwd: string; live: Map<string, ClaudeRecord[]>; progress: Map<string, ClaudeAgentProgress>; onOpenFile?: (path: string) => void };
export const ClaudeAgentContext = createContext<ClaudeAgentSources>({ sessionId: null, cwd: "", live: new Map(), progress: new Map() });

export const isAgentTool = (name: string) => name === "Agent" || name === "Task";

/**
 * A sub-agent's steps under its Agent tool call: the records Claude streamed
 * for it (`parentToolUseId`) merged with its saved transcript, loaded when
 * opened, as it uses more tools (a background agent's records are not
 * streamed) and when it finishes. Sub-agent records are one block each, so
 * they are keyed by uuid; its prompt is the tool input and is left out.
 * A background agent's tool call ends at once; its task events (`progress`)
 * tell whether it still runs.
 */
export function ClaudeAgentSteps({ toolUseId, done }: { toolUseId: string; done: boolean }) {
  const { sessionId, cwd, live, progress, onOpenFile } = useContext(ClaudeAgentContext);
  const [open, setOpen] = useState(false);
  const isCoarsePointer = useCoarsePointer();
  const [saved, setSaved] = useState<ClaudeRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRecords = live.get(toolUseId);
  const state = progress.get(toolUseId);
  const running = state ? !state.status || state.status === "running" : !done;
  const toolUses = state?.toolUses;

  useEffect(() => {
    if (!open || !sessionId) return;
    const abort = new AbortController();
    void fetch(`/api/claude/chat/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(toolUseId)}?${new URLSearchParams({ cwd })}`, { cache: "no-store", signal: abort.signal })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { records?: ClaudeRecord[]; error?: string; code?: string };
        if (response.ok) { setSaved(data.records ?? []); setError(null); }
        else if (data.code === "not_found") { setSaved([]); setError(null); }
        else setError(data.error || "Unable to load the agent's steps");
      })
      .catch(() => { if (!abort.signal.aborted) setError("Unable to load the agent's steps"); });
    return () => abort.abort();
  }, [cwd, open, running, sessionId, toolUseId, toolUses]);

  const items = useMemo(() => {
    if (!open) return [];
    const records = new Map<string, ClaudeRecord>();
    for (const record of [...saved ?? [], ...liveRecords ?? []]) {
      if (!record.uuid) continue;
      const content = record.message?.content;
      if (record.type === "user" && !(Array.isArray(content) && content.some((block) => block.type === "tool_result"))) continue;
      records.set(record.uuid, { ...record, parentToolUseId: undefined, piBlockIndex: 0, message: { ...record.message, id: record.uuid } });
    }
    return claudeConversationItems([...records.values(), ...running ? [] : [{ type: "result" }]]);
  }, [liveRecords, open, running, saved]);

  const failed = !running && state?.status !== undefined && state.status !== "completed";
  const summary = [running ? state?.lastTool ? `Running ${state.lastTool}` : "Running" : state?.status === "completed" ? "Done" : "", toolUses ? `${toolUses} tool use${toolUses === 1 ? "" : "s"}` : "", state?.durationMs ? formatRunDuration(state.durationMs) : "", failed ? state?.status : ""].filter(Boolean).join(" · ");
  return <div className="claude-agent-steps" data-state={running ? "running" : failed ? "failed" : "done"}>
    <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <span>{open ? "▾" : "▸"} Agent steps</span>{running && <span className="claude-agent-steps-pulse" aria-hidden />}{summary && <small>{summary}</small>}
    </button>
    {open && <div className="claude-agent-steps-body">
      {error && <p role="alert">{error}</p>}
      {!error && !items.length && <p>{saved === null && sessionId ? "Loading…" : "Steps are not available for this agent."}</p>}
      {items.map((item) => {
        if (item.kind === "message" && item.role === "assistant") {
          const message: AssistantMessage = { role: "assistant", content: [{ type: "text", text: item.text }], model: "", provider: "" };
          return <MessageView key={item.id} message={message} cwd={cwd} onOpenFile={onOpenFile} isCoarsePointer={isCoarsePointer} />;
        }
        if (item.kind === "command") {
          const message: BashExecutionMessage = { role: "bashExecution", command: item.command, output: item.output ?? "", exitCode: item.exitCode ?? undefined };
          return <MessageView key={item.id} message={message} cwd={cwd} onOpenFile={onOpenFile} isCoarsePointer={isCoarsePointer} />;
        }
        if (item.kind === "toolCall") {
          const message: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", toolCallId: item.id, toolName: item.toolName, input: item.input }], model: "", provider: "" };
          const result = { role: "toolResult", toolCallId: item.id, toolName: item.toolName, isError: item.isError, content: [{ type: "text", text: item.output || "(no output)" }], ...(item.diff ? { details: { diff: item.diff } } : {}) } as ToolResultMessage;
          return <div key={item.id}>
            <MessageView message={message} isStreaming={!item.done} toolResults={item.done ? new Map([[item.id, result]]) : undefined} cwd={cwd} onOpenFile={onOpenFile} isCoarsePointer={isCoarsePointer} />
            {isAgentTool(item.toolName) && <ClaudeAgentSteps toolUseId={item.id} done={item.done} />}
          </div>;
        }
        if (item.kind === "notice") return <p key={item.id}>{item.text}</p>;
        return null;
      })}
    </div>}
  </div>;
}
