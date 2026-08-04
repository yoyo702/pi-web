import { NextResponse } from "next/server";
import { sendTerminalInput, TerminalRequestError } from "@/lib/agents/terminal";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { data } = await request.json() as { data?: unknown };
    if (typeof data !== "string") throw new TerminalRequestError("invalid_input", "data must be a string");
    sendTerminalInput((await params).id, data);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const status = error instanceof TerminalRequestError && error.code === "not_found" ? 404 : error instanceof TerminalRequestError && error.code === "not_running" ? 409 : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "terminal input rejected" }, { status });
  }
}
