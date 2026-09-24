import { NextResponse } from "next/server";
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  paginateSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { withoutNonConversationEntries } from "@/lib/session-tree";
import { getRpcSession } from "@/lib/rpc-manager";
import { errorResponse } from "@/lib/http-error";
import { invalidateSessionFileCache, openSessionForRead } from "@/lib/session-file-cache";

// BranchNavigator still traverses recursively, so keep the response tree shallow.
const MAX_PROJECTED_TREE_DEPTH = 200;

/**
 * Project the session tree into the shallow navigation tree sent to the client.
 * Keeps roots, branch points, and leaves while contracting single-child chains
 * without recursive traversal. Contracted entry IDs are attached to the next
 * visible node so the UI can still recognize an active leaf inside the chain;
 * `hiddenEntryIds` of contracted nodes move along with them.
 */
function projectTreeForResponse<T extends { entry: { id: string }; children: T[]; compressedEntryIds?: string[]; hiddenEntryIds?: string[] }>(
  nodes: T[]
): T[] {
  const keep = new Set<T>();
  const roots = new Set(nodes);
  const seen = new Set<T>();
  const stack = [...nodes];

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);

    if (
      roots.has(node) ||
      node.children.length !== 1
    ) {
      keep.add(node);
    }

    for (const child of node.children) {
      stack.push(child);
    }
  }

  const cloneNode = (node: T, compressedEntryIds?: string[], carriedHiddenIds: string[] = []): T => {
    const hiddenEntryIds = [...carriedHiddenIds, ...(node.hiddenEntryIds ?? [])];
    return {
      ...node,
      children: [],
      ...(compressedEntryIds?.length ? { compressedEntryIds } : {}),
      ...(hiddenEntryIds.length ? { hiddenEntryIds } : {}),
    };
  };
  const projectedRoots = nodes.map((node) => cloneNode(node));
  const tasks = nodes.map((source, index) => ({
    source,
    projected: projectedRoots[index],
    depth: 1,
  }));

  const appendFlattenedKeptDescendants = (source: T, projectedParent: T) => {
    const pending = [{ node: source, compressedEntryIds: [] as string[], hiddenEntryIds: [] as string[] }];
    const flattenedSeen = new Set<T>();

    while (pending.length > 0) {
      const { node, compressedEntryIds, hiddenEntryIds } = pending.pop()!;
      if (flattenedSeen.has(node)) continue;
      flattenedSeen.add(node);

      if (keep.has(node)) {
        projectedParent.children.push(cloneNode(node, compressedEntryIds, hiddenEntryIds));
      }

      for (let i = node.children.length - 1; i >= 0; i--) {
        pending.push({
          node: node.children[i],
          compressedEntryIds: keep.has(node)
            ? []
            : [...compressedEntryIds, node.entry.id],
          hiddenEntryIds: keep.has(node)
            ? []
            : [...hiddenEntryIds, ...(node.hiddenEntryIds ?? [])],
        });
      }
    }
  };

  while (tasks.length > 0) {
    const { source, projected, depth } = tasks.pop()!;

    for (const sourceChild of source.children) {
      let child = sourceChild;

      if (depth >= MAX_PROJECTED_TREE_DEPTH) {
        appendFlattenedKeptDescendants(child, projected);
        continue;
      }

      const compressedEntryIds: string[] = [];
      const hiddenEntryIds: string[] = [];
      while (!keep.has(child) && child.children.length === 1) {
        compressedEntryIds.push(child.entry.id);
        hiddenEntryIds.push(...(child.hiddenEntryIds ?? []));
        child = child.children[0];
      }

      if (!keep.has(child)) {
        continue;
      }

      const projectedChild = cloneNode(child, compressedEntryIds, hiddenEntryIds);
      projected.children.push(projectedChild);
      tasks.push({ source: child, projected: projectedChild, depth: depth + 1 });
    }
  }

  return projectedRoots;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = openSessionForRead(filePath);
    const entries = sm.getEntries() as Array<{ id: string }> as never;
    const latestLeafId = sm.getLeafId();
    const searchParams = new URL(req.url).searchParams;
    const requestedLeafId = searchParams.get("leafId");
    const leafId = requestedLeafId && (entries as Array<{ id: string }>).some((entry) => entry.id === requestedLeafId)
      ? requestedLeafId
      : latestLeafId;
    // System prompt/tool messages and usage records are not conversation turns.
    const tree = projectTreeForResponse(withoutNonConversationEntries(sm.getTree()));
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const limit = Number.parseInt(searchParams.get("limit") ?? "", 10);
    const fullContext = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });
    const context = Number.isFinite(limit) && limit > 0
      ? paginateSessionContext(fullContext, limit)
      : fullContext;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: fullContext.messages.length,
      firstMessage: fullContext.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = fullContext.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    } : null;

    return NextResponse.json({
      sessionId: id,
      filePath,
      modified,
      info,
      leafId,
      tree,
      context,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Read only the bounded header before deleting.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;

    // Re-attach direct children (forks in the same directory) to this
    // session's parent. Only headers are read to find them; only children are
    // rewritten.
    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    const reparentFailures: string[] = [];
    let siblingFiles: string[] = [];
    try {
      siblingFiles = readdirSync(dir).filter(
        (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
      );
    } catch (error) {
      console.warn("[sessions] could not scan for forked children:", error);
    }
    for (const file of siblingFiles) {
      const childPath = join(dir, file);
      let header: ReturnType<typeof readSessionHeader>;
      try {
        header = readSessionHeader(childPath);
      } catch {
        continue; // unreadable or malformed historical file
      }
      if (!header?.parentSession || sessionPathKey(header.parentSession) !== targetPathKey) continue;
      // A running child appends to its file concurrently; rewriting it now
      // could drop entries. Leave its link dangling (shown as "forked from
      // unavailable session") rather than risk the transcript.
      if (getRpcSession(header.id)?.isRunning()) {
        reparentFailures.push(header.id);
        continue;
      }
      try {
        const content = readFileSync(childPath, "utf8");
        const newline = content.indexOf("\n");
        const rest = newline === -1 ? "" : content.slice(newline);
        const tempPath = `${childPath}.${process.pid}.${Date.now()}.tmp`;
        // Write-then-rename so a crash never leaves a truncated session file.
        writeFileSync(tempPath, JSON.stringify({ ...header, parentSession: parentSessionPath }) + rest);
        renameSync(tempPath, childPath);
      } catch (error) {
        console.warn(`[sessions] could not re-parent ${childPath}:`, error);
        reparentFailures.push(header.id);
      }
    }

    getRpcSession(id)?.destroy();
    unlinkSync(filePath);
    invalidateSessionFileCache(filePath);
    invalidateSessionPathCache(id);
    invalidateSessionListCache();
    return NextResponse.json(reparentFailures.length ? { ok: true, reparentFailures } : { ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
