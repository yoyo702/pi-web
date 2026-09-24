import { NextResponse } from "next/server";
import { statSync } from "fs";
import { resolveSessionPath } from "@/lib/session-reader";
import { errorResponse } from "@/lib/http-error";

/**
 * Lightweight freshness probe for a session file. Returns only the file's
 * mtime and size via a single stat() — no parse. The client polls this on tab
 * focus to decide whether a full context reload is needed, avoiding an
 * expensive re-parse + full message re-render when nothing changed on disk.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const stat = statSync(filePath);
    return NextResponse.json({
      modified: stat.mtime.toISOString(),
      size: stat.size,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
