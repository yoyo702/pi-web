import { NextResponse } from "next/server";
import { resizeTerminal, TerminalRequestError } from "@/lib/agents/terminal";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { cols, rows } = await request.json() as { cols?: unknown; rows?: unknown };
    if (typeof cols !== "number" || typeof rows !== "number") throw new TerminalRequestError("invalid_size", "cols and rows are required");
    resizeTerminal((await params).id, cols, rows);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const status = error instanceof TerminalRequestError && error.code === "not_found" ? 404 : error instanceof TerminalRequestError && error.code === "not_running" ? 409 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "terminal resize rejected" }, { status });
  }
}
