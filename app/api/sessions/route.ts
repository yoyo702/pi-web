import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { errorResponse } from "@/lib/http-error";

export async function GET(request: Request) {
  try {
    // `?running=1` skips the full session scan for status pollers that only
    // need to know which sessions are currently running.
    if (new URL(request.url).searchParams.get("running") === "1") {
      return NextResponse.json({ runningSessionIds: getRunningRpcSessionIds() });
    }
    const sessions = await listAllSessions();
    return NextResponse.json({ sessions, runningSessionIds: getRunningRpcSessionIds() });
  } catch (error) {
    return errorResponse(error);
  }
}
