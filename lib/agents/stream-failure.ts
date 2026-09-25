/**
 * Why a chat event stream was refused. EventSource hides the response of a
 * failed connection, so ask the same URL once with fetch and read its JSON
 * error. Returns null when the stream opens now (the failure was transient)
 * or the server can't be reached.
 */
export async function streamFailure(url: string, signal?: AbortSignal): Promise<{ message: string; code?: string } | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (response.ok) return null;
    const data = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown };
    return {
      message: typeof data.error === "string" && data.error ? data.error : `HTTP ${response.status}`,
      ...(typeof data.code === "string" ? { code: data.code } : {}),
    };
  } catch {
    return null;
  } finally {
    // An opened stream stays open until aborted.
    controller.abort();
    signal?.removeEventListener("abort", abort);
  }
}
