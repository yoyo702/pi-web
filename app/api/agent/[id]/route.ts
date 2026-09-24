import { NextResponse } from "next/server";
import { getOrStartRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { errorResponse } from "@/lib/http-error";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    const session = await getOrStartRpcSession(id);
    const result = await session.send(body);
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return errorResponse(error);
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return errorResponse(error);
  }
}
