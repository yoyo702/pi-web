import { NextResponse } from "next/server";
import { getTerminalBuffer, TerminalRequestError } from "@/lib/agents/terminal";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const result = getTerminalBuffer((await params).id);
    return new Response(new Uint8Array(result.data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Pi-Terminal-Truncated": result.truncated ? "1" : "0",
        "X-Pi-Terminal-State": result.state,
      },
    });
  } catch (error) {
    const status = error instanceof TerminalRequestError && error.code === "not_found" ? 404 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "terminal buffer unavailable" }, { status });
  }
}
