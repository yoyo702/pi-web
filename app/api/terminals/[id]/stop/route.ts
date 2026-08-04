import { NextResponse } from "next/server";
import { stopTerminal, TerminalRequestError } from "@/lib/agents/terminal";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return NextResponse.json({ terminal: stopTerminal((await params).id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TerminalRequestError && error.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "terminal stop rejected" }, { status });
  }
}
