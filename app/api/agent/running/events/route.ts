import { getRunningRpcSessionIds, subscribeRpcSessionEvents, subscribeRunningSessions } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

type WorkspaceStatusBus = {
  subscribe(listener: (message: { type: string }) => void): () => void;
  snapshot(kind: string): { type: string };
};

// GET /api/agent/running/events - SSE stream of running ids plus the bounded,
// completion-level events used to keep unmounted session snapshots warm, plus
// terminal and Codex runtime status snapshots from the workspace-status bus.
export async function GET(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const workspaceStatus = require("@/server/workspace-status.cjs") as WorkspaceStatusBus;

  let cleanupStream: (() => void) | null = null;
  const pendingSnapshots = new Map<string, unknown>();
  let flushPendingSnapshots: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const encode = (data: unknown, dropIfBackpressured = false) => {
        if (closed) return;
        // Background events are cache hints. If a browser stops reading, drop
        // them instead of retaining serialized frames indefinitely; reopening
        // the session reconciles from its JSONL file.
        if (dropIfBackpressured && controller.desiredSize !== null && controller.desiredSize <= 0) return;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };
      // Status snapshots (terminals, codex_runtimes) are coalesced upstream by
      // the bus, so under backpressure we keep only the latest per kind and
      // flush it once the stream drains, instead of dropping it outright.
      const sendSnapshot = (message: { type: string }) => {
        if (controller.desiredSize !== null && controller.desiredSize <= 0) {
          pendingSnapshots.set(message.type, message);
          return;
        }
        encode(message);
      };
      flushPendingSnapshots = () => {
        for (const [type, message] of pendingSnapshots) {
          pendingSnapshots.delete(type);
          encode(message);
        }
      };

      // Subscribe BEFORE taking the initial snapshot so no state change can slip
      // through the gap between snapshot and subscription.
      const unsubscribe = subscribeRunningSessions((ids) => {
        try {
          encode({ type: "running", runningSessionIds: ids });
        } catch {
          // controller already closed
        }
      });
      const unsubscribeSessionEvents = subscribeRpcSessionEvents((sessionId, event) => {
        try {
          encode({ type: "session_event", sessionId, event }, true);
        } catch {
          // controller already closed
        }
      });
      const unsubscribeStatus = workspaceStatus.subscribe((message) => {
        try {
          sendSnapshot(message);
        } catch {
          // controller already closed
        }
      });

      // Initial snapshot so the client renders the correct state immediately.
      // (A duplicate frame here is harmless: the client just sets the same set.)
      encode({ type: "running", runningSessionIds: getRunningRpcSessionIds() });
      // A failing provider skips its kind; it must not fail the whole stream
      // (and leak the subscriptions above, whose cleanup is installed below).
      for (const kind of ["terminals", "codex_runtimes"]) {
        try {
          sendSnapshot(workspaceStatus.snapshot(kind));
        } catch (error) {
          console.error(`[workspace-status] ${kind} snapshot failed:`, error);
        }
      }

      // Heartbeat to keep the connection alive through proxies/timeouts.
      const heartbeat = setInterval(() => {
        try {
          if (controller.desiredSize === null || controller.desiredSize > 0) {
            controller.enqueue(new TextEncoder().encode(":\n\n"));
          }
        } catch {
          // controller already closed
        }
      }, 30_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        unsubscribeSessionEvents();
        unsubscribeStatus();
        pendingSnapshots.clear();
        try { controller.close(); } catch { /* already closed */ }
      };
      cleanupStream = cleanup;

      req.signal?.addEventListener("abort", cleanup);
    },
    pull() {
      flushPendingSnapshots?.();
    },
    cancel() {
      cleanupStream?.();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
