import { NextResponse } from "next/server";
import { getTerminal, removeTerminal, renameTerminal, TerminalRequestError } from "@/lib/agents/terminal";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json({ terminal: getTerminal((await params).id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TerminalRequestError && error.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "terminal request failed" }, { status });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json() as { title?: unknown };
    if (typeof body.title !== "string") throw new TerminalRequestError("invalid_title", "terminal title is required");
    return NextResponse.json({ terminal: renameTerminal((await params).id, body.title) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TerminalRequestError && error.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "terminal rename failed" }, { status });
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json({ terminal: removeTerminal((await params).id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof TerminalRequestError ? error.code : null;
    const status = code === "not_found" ? 404 : code === "still_running" ? 409 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "terminal removal failed" }, { status });
  }
}
