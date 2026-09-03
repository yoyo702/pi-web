"use client";

import { normalizeToolCalls } from "./normalize";
import {
  getPersistedSessionSnapshot,
  saveSessionSnapshot,
  type SessionSnapshot,
} from "./session-snapshot-cache";
import type { AgentMessage } from "./types";

export interface BackgroundAgentEvent {
  type: string;
  [key: string]: unknown;
}

const eventQueues = new Map<string, Promise<void>>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queuedRefreshes = new Set<string>();

const LEGACY_HIGH_FREQUENCY_EVENTS = new Set([
  "message_start",
  "message_update",
  "tool_execution_update",
  "turn_start",
  "turn_end",
]);

function initialPageSize(): number {
  if (typeof window === "undefined") return 40;
  return window.matchMedia("(max-width: 768px)").matches ? 40 : 80;
}

function messageIdentity(message: AgentMessage): string {
  const candidate = message as AgentMessage & { toolCallId?: string; timestamp?: number };
  const content = "content" in message ? message.content : message;
  return JSON.stringify([
    message.role,
    candidate.toolCallId ?? "",
    candidate.timestamp ?? null,
    content,
  ]);
}

function appendCompletedMessage(snapshot: SessionSnapshot, message: AgentMessage): SessionSnapshot {
  // The active hook already inserts the user's optimistic bubble before the
  // server echoes it. Ignoring user echoes avoids duplicates while the same
  // background event stream updates the shared snapshot.
  if (message.role === "user") return snapshot;
  const normalized = normalizeToolCalls(message);
  const identity = messageIdentity(normalized);
  if (snapshot.messages.some((existing) => messageIdentity(existing) === identity)) return snapshot;
  return {
    ...snapshot,
    messages: [...snapshot.messages, normalized],
    streamState: { isStreaming: false, streamingMessage: null },
    agentRunning: true,
    agentPhase: { kind: "waiting_model" },
  };
}

export function reduceSessionSnapshotEvent(
  snapshot: SessionSnapshot,
  event: BackgroundAgentEvent,
): SessionSnapshot {
  const updatedAt = Date.now();
  switch (event.type) {
    case "agent_start":
      return {
        ...snapshot,
        updatedAt,
        agentRunning: true,
        agentPhase: { kind: "waiting_model" },
        streamState: { isStreaming: true, streamingMessage: null },
      };
    case "message_start":
    case "message_update": {
      const message = event.message as AgentMessage | undefined;
      if (!message || message.role === "user") return snapshot;
      return {
        ...snapshot,
        updatedAt,
        agentRunning: true,
        agentPhase: null,
        streamState: { isStreaming: true, streamingMessage: normalizeToolCalls(message) },
      };
    }
    case "message_end": {
      const message = event.message as AgentMessage | undefined;
      return message
        ? { ...appendCompletedMessage(snapshot, message), updatedAt }
        : snapshot;
    }
    case "tool_execution_start": {
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const name = typeof event.toolName === "string" ? event.toolName : "tool";
      const tools = snapshot.agentPhase?.kind === "running_tools"
        ? [...snapshot.agentPhase.tools]
        : [];
      if (id && !tools.some((tool) => tool.id === id)) tools.push({ id, name });
      return { ...snapshot, updatedAt, agentRunning: true, agentPhase: { kind: "running_tools", tools } };
    }
    case "tool_execution_end": {
      if (snapshot.agentPhase?.kind !== "running_tools") return snapshot;
      const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
      const tools = snapshot.agentPhase.tools.filter((tool) => tool.id !== id);
      return {
        ...snapshot,
        updatedAt,
        agentPhase: tools.length > 0 ? { kind: "running_tools", tools } : { kind: "waiting_model" },
      };
    }
    case "agent_end":
    case "prompt_done":
      return {
        ...snapshot,
        updatedAt,
        agentRunning: false,
        agentPhase: null,
        streamState: { isStreaming: false, streamingMessage: null },
      };
    default:
      return snapshot;
  }
}

function schedulePersist(sessionId: string): void {
  const previous = persistTimers.get(sessionId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    persistTimers.delete(sessionId);
    const snapshot = await getPersistedSessionSnapshot(sessionId);
    if (snapshot) saveSessionSnapshot(snapshot);
  }, 800);
  persistTimers.set(sessionId, timer);
}

async function refreshSessionSnapshot(sessionId: string, running: boolean): Promise<SessionSnapshot | null> {
  const params = new URLSearchParams({
    deferThinking: "1",
    deferMedia: "1",
    limit: String(initialPageSize()),
  });
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?${params}`);
  if (!response.ok) return null;
  const data = await response.json() as SessionSnapshot["data"];
  return {
    sessionId,
    updatedAt: Date.now(),
    data,
    messages: data.context.messages,
    entryIds: data.context.entryIds,
    activeLeafId: data.leafId,
    streamState: { isStreaming: running, streamingMessage: null },
    agentRunning: running,
    agentPhase: running ? { kind: "waiting_model" } : null,
  };
}

async function processBackgroundEvent(sessionId: string, event: BackgroundAgentEvent): Promise<void> {
  if (event.type === "session_refresh") {
    const refreshed = await refreshSessionSnapshot(sessionId, true);
    if (refreshed) saveSessionSnapshot(refreshed);
    return;
  }

  let snapshot = await getPersistedSessionSnapshot(sessionId);
  if (!snapshot) snapshot = await refreshSessionSnapshot(sessionId, event.type !== "agent_end" && event.type !== "prompt_done");
  if (!snapshot) return;

  const next = reduceSessionSnapshotEvent(snapshot, event);
  saveSessionSnapshot(next, { persist: false });

  if (event.type === "agent_end" || event.type === "prompt_done") {
    const refreshed = await refreshSessionSnapshot(sessionId, false);
    saveSessionSnapshot(refreshed ?? next);
    return;
  }
  if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
    const refreshed = await refreshSessionSnapshot(sessionId, true);
    if (refreshed) saveSessionSnapshot(refreshed, { persist: false });
  }
  schedulePersist(sessionId);
}

/**
 * Queue a server event into the browser-level session cache. The queue keeps
 * async IndexedDB hydration and rapid SSE frames ordered per session.
 */
export function applyBackgroundSessionEvent(sessionId: string, event: BackgroundAgentEvent): void {
  // Protect clients that remain connected to an older hot-reloaded server: the
  // global channel must never queue token-level events in the browser either.
  if (LEGACY_HIGH_FREQUENCY_EVENTS.has(event.type)) return;
  if (event.type === "session_refresh") {
    if (queuedRefreshes.has(sessionId)) return;
    queuedRefreshes.add(sessionId);
  }

  const previous = eventQueues.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => processBackgroundEvent(sessionId, event))
    .catch(() => {});
  eventQueues.set(sessionId, next);
  void next.finally(() => {
    if (eventQueues.get(sessionId) === next) eventQueues.delete(sessionId);
    if (event.type === "session_refresh") queuedRefreshes.delete(sessionId);
  });
}
