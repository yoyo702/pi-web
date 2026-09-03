"use client";

import type { AgentMessage, SessionContext, SessionTreeNode } from "./types";

export type CachedAgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string }[] }
  | null;

export interface SessionSnapshot {
  sessionId: string;
  updatedAt: number;
  data: {
    sessionId: string;
    filePath: string;
    tree: SessionTreeNode[];
    leafId: string | null;
    modified?: string;
    context: SessionContext;
  };
  messages: AgentMessage[];
  entryIds: string[];
  activeLeafId: string | null;
  streamState: {
    isStreaming: boolean;
    streamingMessage: Partial<AgentMessage> | null;
  };
  agentRunning: boolean;
  agentPhase: CachedAgentPhase;
}

const DB_NAME = "pi-web-session-cache";
const DB_VERSION = 1;
const STORE_NAME = "snapshots";
const memorySnapshots = new Map<string, SessionSnapshot>();

function cacheLimit(): number {
  if (typeof window === "undefined") return 3;
  return window.matchMedia("(max-width: 768px)").matches ? 3 : 5;
}

function cachedMessageLimit(): number {
  if (typeof window === "undefined") return 80;
  return window.matchMedia("(max-width: 768px)").matches ? 80 : 160;
}

function compactSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  const limit = cachedMessageLimit();
  if (snapshot.messages.length <= limit) return snapshot;
  const messages = snapshot.messages.slice(-limit);
  const idsAreAligned = snapshot.entryIds.length === snapshot.messages.length;
  const entryIds = idsAreAligned ? snapshot.entryIds.slice(-limit) : [];
  const previousPage = snapshot.data.context.page;
  return {
    ...snapshot,
    messages,
    entryIds,
    data: {
      ...snapshot.data,
      context: {
        ...snapshot.data.context,
        messages,
        entryIds,
        page: idsAreAligned ? {
          hasMore: true,
          beforeEntryId: entryIds[0] ?? null,
          totalMessages: Math.max(previousPage?.totalMessages ?? 0, snapshot.messages.length),
        } : {
          hasMore: false,
          beforeEntryId: null,
          totalMessages: Math.max(previousPage?.totalMessages ?? 0, snapshot.messages.length),
        },
      },
    },
  };
}

function rememberInMemory(snapshot: SessionSnapshot): void {
  snapshot = compactSnapshot(snapshot);
  memorySnapshots.delete(snapshot.sessionId);
  memorySnapshots.set(snapshot.sessionId, snapshot);
  while (memorySnapshots.size > cacheLimit()) {
    const oldest = memorySnapshots.keys().next().value as string | undefined;
    if (!oldest) break;
    memorySnapshots.delete(oldest);
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export function getMemorySessionSnapshot(sessionId: string): SessionSnapshot | null {
  const snapshot = memorySnapshots.get(sessionId) ?? null;
  if (!snapshot) return null;
  rememberInMemory(snapshot);
  return snapshot;
}

export async function getPersistedSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
  const memory = getMemorySessionSnapshot(sessionId);
  if (memory) return memory;
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(sessionId);
    request.onsuccess = () => {
      const snapshot = (request.result as SessionSnapshot | undefined) ?? null;
      if (snapshot) rememberInMemory(snapshot);
      resolve(snapshot);
    };
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

async function persistSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.put(snapshot);
    const all = store.getAll();
    all.onsuccess = () => {
      const snapshots = (all.result as SessionSnapshot[])
        .sort((a, b) => b.updatedAt - a.updatedAt);
      for (const stale of snapshots.slice(cacheLimit())) store.delete(stale.sessionId);
    };
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => {
      db.close();
      resolve();
    };
  });
}

export function saveSessionSnapshot(snapshot: SessionSnapshot, options: { persist?: boolean } = {}): void {
  snapshot = compactSnapshot(snapshot);
  rememberInMemory(snapshot);
  if (options.persist !== false) void persistSessionSnapshot(snapshot).catch(() => {});
}
