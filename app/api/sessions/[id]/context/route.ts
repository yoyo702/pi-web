import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath, buildSessionContext, paginateSessionContext } from "@/lib/session-reader";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const leafId = url.searchParams.get("leafId") ?? undefined;
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const beforeEntryId = url.searchParams.get("beforeEntryId");

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = SessionManager.open(filePath);
    const fullContext = buildSessionContext(sm.getEntries() as never, leafId, {
      deferThinking,
      deferToolResultImages,
    });
    const context = Number.isFinite(limit) && limit > 0
      ? paginateSessionContext(fullContext, limit, beforeEntryId)
      : fullContext;

    return NextResponse.json({ context });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
