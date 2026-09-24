import { getOrStartRpcSession, type AgentSessionWrapper } from "@/lib/rpc-manager";
import { HttpError } from "@/lib/http-error";

export const dynamic = "force-dynamic";

// Pi can emit dozens of message_update events per second, and each event
// contains the whole accumulated assistant message. Sending every one creates
// quadratic serialization churn as a response grows. ~13 fps is visually
// smooth while keeping CPU and heap allocation bounded.
const MESSAGE_UPDATE_INTERVAL_MS = 75;

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let session: AgentSessionWrapper;
  try {
    session = await getOrStartRpcSession(id);
  } catch (error) {
    if (error instanceof HttpError) return new Response(error.message, { status: error.status });
    return new Response(`Failed to start agent: ${error}`, { status: 500 });
  }

  let flushPendingUpdate: (() => void) | null = null;
  let cleanupStream: (() => void) | null = null;
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let pendingUpdate: unknown = null;
      let updateTimer: ReturnType<typeof setTimeout> | null = null;
      let lastUpdateAt = 0;

      const encode = (data: unknown) => {
        if (closed) return;
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(new TextEncoder().encode(text));
      };

      const clearUpdateTimer = () => {
        if (!updateTimer) return;
        clearTimeout(updateTimer);
        updateTimer = null;
      };

      const flushUpdate = () => {
        clearUpdateTimer();
        if (!pendingUpdate || closed) return;
        // Keep exactly one latest update while the response consumer is
        // backpressured. ReadableStream.pull() flushes it once demand returns.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
        const event = pendingUpdate;
        pendingUpdate = null;
        lastUpdateAt = Date.now();
        encode(event);
      };
      flushPendingUpdate = flushUpdate;

      const queueMessageUpdate = (event: unknown) => {
        pendingUpdate = event;
        if (updateTimer || (controller.desiredSize !== null && controller.desiredSize <= 0)) return;
        const delay = Math.max(0, MESSAGE_UPDATE_INTERVAL_MS - (Date.now() - lastUpdateAt));
        updateTimer = setTimeout(flushUpdate, delay);
      };

      // Send initial connected event
      encode({ type: "connected", sessionId: id });

      const unsubscribe = session.onEvent((event) => {
        if (event.type === "message_update") {
          queueMessageUpdate(event);
          return;
        }
        // A later state transition supersedes the pending visual progress.
        // Discarding it also prevents an old update from being flushed after a
        // tool/message completion when a backpressured connection recovers.
        pendingUpdate = null;
        clearUpdateTimer();
        encode(event);
      });

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          if (controller.desiredSize === null || controller.desiredSize > 0) {
            controller.enqueue(new TextEncoder().encode(":\n\n"));
          }
        } catch {
          // controller already closed
        }
      }, 30_000);

      // Cleanup when client disconnects
      let stopDestroyWatch = () => {};
      const cleanup = () => {
        if (closed) return;
        closed = true;
        pendingUpdate = null;
        clearUpdateTimer();
        flushPendingUpdate = null;
        clearInterval(heartbeat);
        unsubscribe();
        stopDestroyWatch();
        try { controller.close(); } catch { /* already closed */ }
      };
      cleanupStream = cleanup;

      // When the server releases this session (idle timeout, delete), tell the
      // client and end the stream so it does not pin the dead session.
      stopDestroyWatch = session.onDestroy(() => {
        pendingUpdate = null;
        encode({ type: "session_closed", sessionId: id });
        cleanup();
      });

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
    },
    pull() {
      flushPendingUpdate?.();
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
