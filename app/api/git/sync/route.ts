import { NextRequest, NextResponse } from "next/server";
import { syncGitRemote, type GitRemoteAction } from "@/lib/git-changes";
import { validateGitCwd } from "@/lib/git-request";
import { errorResponse } from "@/lib/http-error";

const REMOTE_ACTIONS = new Set<GitRemoteAction>(["fetch", "pull", "push", "publish"]);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({})) as {
      cwd?: string;
      action?: GitRemoteAction;
    };
    const invalid = await validateGitCwd(body.cwd);
    if (invalid) return NextResponse.json({ error: invalid.error }, { status: invalid.status });
    if (!body.action || !REMOTE_ACTIONS.has(body.action)) {
      return NextResponse.json({ error: "action must be fetch, pull, push, or publish" }, { status: 400 });
    }
    return NextResponse.json(await syncGitRemote(body.cwd as string, body.action));
  } catch (error) {
    return errorResponse(error);
  }
}
